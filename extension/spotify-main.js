(() => {
  if (window.__slowedReverbSpotifyMain) return;
  window.__slowedReverbSpotifyMain = true;

  const CHANNEL = 'SLOWED_REVERB_SPOTIFY';
  const BRIDGE_CHECK_EVENT = `${CHANNEL}_CHECK`;
  const BRIDGE_CHECK_MS = 250;
  // Copies of SlowedReverbSettings.DEFAULTS and BOUNDS (settings.js). This script
  // stays self-contained because its registration outlives extension updates;
  // tests/settings.test.js keeps the copies equal.
  const NEUTRAL_SETTINGS = Object.freeze({
    speed: 1,
    reverb: 0,
    echo: 0,
    pan: 0,
    width: 100,
    keepPitch: false,
    saturation: 0,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0
  });
  const SETTING_BOUNDS = Object.freeze({
    speed: Object.freeze([0.5, 1.5]),
    reverb: Object.freeze([0, 100]),
    echo: Object.freeze([0, 100]),
    pan: Object.freeze([-100, 100]),
    width: Object.freeze([0, 200]),
    saturation: Object.freeze([0, 100]),
    eqLow: Object.freeze([-12, 12]),
    eqMid: Object.freeze([-12, 12]),
    eqHigh: Object.freeze([-12, 12])
  });

  const mediaElements = new Set();
  const startedMedia = new WeakSet();
  const pipelines = new WeakMap();
  let settings = { ...NEUTRAL_SETTINGS };
  let enabled = false;
  let processingUnavailable = false;
  let impulseResponse = null;
  let saturationCurve = null;
  let bridgeCheckTimer = null;

  function normalizeSettings(candidate) {
    const normalized = { ...NEUTRAL_SETTINGS };
    if (!candidate || typeof candidate !== 'object') return normalized;

    for (const [key, [minimum, maximum]] of Object.entries(SETTING_BOUNDS)) {
      const value = candidate[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        normalized[key] = Math.min(maximum, Math.max(minimum, value));
      }
    }
    normalized.keepPitch = candidate.keepPitch === true;
    return normalized;
  }

  // How long a setting takes to move to a new value. Jumping straight to it
  // makes an audible click; this is too short to hear as a fade.
  const SMOOTHING_SECONDS = 0.025;
  // Changes start this far ahead. Firefox's audio clock, as a page reads it,
  // runs behind the sound being made, so a change starting "now" would start
  // in the past and jump to partway through.
  const SCHEDULE_AHEAD_SECONDS = 0.02;

  // The player itself clicks when it changes how it plays: Firefox for any
  // change of speed or pitch mode, 5 to 20 ms after it; Chromium only for a
  // change of pitch mode, about 50 ms after it (measured on both). So the
  // output fades out first, the player changes once it is silent, and the
  // output stays silent until the click has passed.
  const FIREFOX = window.navigator.userAgent.includes('Firefox');
  const DIP_FADE_SECONDS = 0.01;
  // After the fade-out has finished, with a margin for page timers.
  const PLAYER_CHANGE_DELAY_MS = 40;
  const PLAYER_CLICK_SECONDS = 0.08;
  // Firefox also goes silent for about 165 ms, then clicks, when a player is
  // first routed into the graph.
  const CAPTURE_SILENCE_SECONDS = FIREFOX ? 0.25 : 0;

  // Starts from where the setting is now, so a change that arrives mid-move
  // (a slider being dragged) carries on without a jump.
  function smoothTo(context, param, value) {
    const start = context.currentTime + SCHEDULE_AHEAD_SECONDS;
    param.cancelScheduledValues(start);
    param.setValueAtTime(param.value, start);
    param.linearRampToValueAtTime(value, start + SMOOTHING_SECONDS);
  }

  function createGain(context, value = 1) {
    const node = context.createGain();
    node.gain.value = value;
    return node;
  }

  function createFilter(context, type, frequency, q) {
    const node = context.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    if (q !== undefined) node.Q.value = q;
    node.gain.value = 0;
    return node;
  }

  function createImpulseResponse(context) {
    const length = Math.floor(context.sampleRate * 2);
    const buffer = context.createBuffer(2, length, context.sampleRate);

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let index = 0; index < length; index++) {
        samples[index] =
          (Math.random() * 2 - 1) * Math.pow(1 - index / length, 2.5);
      }
    }

    return buffer;
  }

  function createSaturationCurve(drive = 4, sampleCount = 1024) {
    const curve = new Float32Array(sampleCount);
    const normalize = Math.tanh(drive);

    for (let index = 0; index < sampleCount; index++) {
      const sample = (index * 2) / (sampleCount - 1) - 1;
      curve[index] = Math.tanh(drive * sample) / normalize;
    }

    return curve;
  }

  function connectStereoWidth(context, input, widthGain) {
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    const mid = context.createGain();
    const side = context.createGain();
    const sideInverted = createGain(context, -1);
    const left = context.createGain();
    const right = context.createGain();

    input.connect(splitter);
    splitter.connect(createGain(context, 0.5), 0).connect(mid);
    splitter.connect(createGain(context, 0.5), 1).connect(mid);
    splitter.connect(createGain(context, 0.5), 0).connect(side);
    splitter.connect(createGain(context, -0.5), 1).connect(side);
    side.connect(widthGain);
    mid.connect(left);
    widthGain.connect(left);
    mid.connect(right);
    widthGain.connect(sideInverted).connect(right);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    return merger;
  }

  // Crossfades between the unchanged path and the effect. While the output
  // has to stay silent (a player change on its way, or a player just routed
  // in), both fade out, and the crossfade happens when the silence ends.
  function setPipelineEnabled(pipeline, active) {
    const { context, silentUntil } = pipeline;
    const now = context.currentTime;
    const outputs = [
      [pipeline.bypass.gain, active ? 0 : 1],
      [pipeline.processed.gain, active ? 1 : 0]
    ];

    for (const [param, value] of outputs) {
      if (silentUntil <= now) {
        smoothTo(context, param, value);
        continue;
      }
      const start = now + SCHEDULE_AHEAD_SECONDS;
      const silentFrom = start + DIP_FADE_SECONDS;
      param.cancelScheduledValues(start);
      param.setValueAtTime(param.value, start);
      param.linearRampToValueAtTime(0, silentFrom);
      if (silentUntil === Infinity) continue;
      param.setValueAtTime(0, Math.max(silentUntil, silentFrom));
      param.linearRampToValueAtTime(value, Math.max(silentUntil, silentFrom) + SMOOTHING_SECONDS);
    }
  }

  function playbackClicks(media, speed, keepPitch) {
    if (media.preservesPitch !== keepPitch) return true;
    return FIREFOX && Math.abs(media.playbackRate - speed) > 0.001;
  }

  function setPlayback(media, speed, keepPitch) {
    try {
      if (Math.abs(media.playbackRate - speed) > 0.001) media.playbackRate = speed;
      media.preservesPitch = keepPitch;
      media.mozPreservesPitch = keepPitch;
      media.webkitPreservesPitch = keepPitch;
    } catch {}
  }

  // Drops a player change still waiting for the output to fade out.
  function cancelPendingPlayback(pipeline) {
    pipeline.pendingPlayback = null;
    if (pipeline.silentUntil === Infinity) pipeline.silentUntil = pipeline.captureEnds;
  }

  // Sets the crossfade and the player's speed and pitch mode. A change that
  // makes the player click waits until the output has faded out.
  function changePlayback(media, pipeline, active, speed, keepPitch) {
    cancelPendingPlayback(pipeline);

    if (!playbackClicks(media, speed, keepPitch)) {
      setPipelineEnabled(pipeline, active);
      setPlayback(media, speed, keepPitch);
      return;
    }

    pipeline.silentUntil = Infinity;
    setPipelineEnabled(pipeline, active);
    const change = () => {
      if (pipeline.pendingPlayback !== change) return;
      pipeline.pendingPlayback = null;
      // Timed from the change itself, in case this ran late, and scheduled
      // first, since changing the player can run this file's code again.
      pipeline.silentUntil = Math.max(
        pipeline.captureEnds,
        pipeline.context.currentTime + PLAYER_CLICK_SECONDS
      );
      setPipelineEnabled(pipeline, active);
      setPlayback(media, speed, keepPitch);
    };
    pipeline.pendingPlayback = change;
    window.setTimeout(change, PLAYER_CHANGE_DELAY_MS);
  }

  function createPipeline(media) {
    if (processingUnavailable) return null;

    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContext();
      const source = context.createMediaElementSource(media);
      const stereoInput = context.createGain();
      stereoInput.channelCount = 2;
      stereoInput.channelCountMode = 'explicit';
      stereoInput.channelInterpretation = 'speakers';

      const eqLow = createFilter(context, 'lowshelf', 200);
      const eqMid = createFilter(context, 'peaking', 1000, 1);
      const eqHigh = createFilter(context, 'highshelf', 4000);
      const convolver = context.createConvolver();
      impulseResponse ??= createImpulseResponse(context);
      convolver.buffer = impulseResponse;

      const delay = context.createDelay(1);
      delay.delayTime.value = 0.35;
      const saturator = context.createWaveShaper();
      saturationCurve ??= createSaturationCurve();
      saturator.curve = saturationCurve;
      saturator.oversample = '4x';

      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 3;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;

      const pan = context.createStereoPanner();
      const dry = createGain(context, 1);
      const wet = createGain(context, 0);
      const echo = createGain(context, 0);
      const saturation = createGain(context, 0);
      const width = createGain(context, 1);
      const mixed = createGain(context, 1);
      // Both start silent; the first crossfade brings in the sound.
      const bypass = createGain(context, 0);
      const processed = createGain(context, 0);

      source.connect(stereoInput);
      source.connect(bypass).connect(context.destination);
      stereoInput.connect(eqLow);
      eqLow.connect(eqMid);
      eqMid.connect(eqHigh);
      eqHigh.connect(dry).connect(mixed);
      eqHigh.connect(convolver).connect(wet).connect(mixed);
      eqHigh.connect(delay);
      delay.connect(createGain(context, 0.35)).connect(delay);
      delay.connect(echo).connect(mixed);
      eqHigh.connect(saturator).connect(saturation).connect(mixed);
      connectStereoWidth(context, mixed, width)
        .connect(pan)
        .connect(limiter)
        .connect(processed)
        .connect(context.destination);

      const pipeline = {
        context,
        eqLow,
        eqMid,
        eqHigh,
        dry,
        wet,
        echo,
        saturation,
        width,
        pan,
        bypass,
        processed,
        captureEnds: context.currentTime + CAPTURE_SILENCE_SECONDS,
        silentUntil: context.currentTime + CAPTURE_SILENCE_SECONDS,
        pendingPlayback: null
      };
      pipelines.set(media, pipeline);
      return pipeline;
    } catch (error) {
      processingUnavailable = true;
      console.warn('Slowed & Reverb: Spotify audio effects are unavailable', error);
      notifyStatus();
      return null;
    }
  }

  function resumePipeline(pipeline) {
    if (pipeline?.context.state === 'suspended') pipeline.context.resume().catch(() => {});
  }

  function applySettings(media) {
    const existingPipeline = pipelines.get(media);
    const started = startedMedia.has(media);

    // Restored state arrives during page startup. Firefox must finish Spotify's
    // encrypted-media initialization before this extension touches the element.
    if (!started && !existingPipeline) return;

    const active = enabled && started;
    const { speed, keepPitch } = active ? settings : NEUTRAL_SETTINGS;

    // The graph comes first, so a change of speed can wait for its output to
    // fade out. Without a graph only the speed can change.
    const activePipeline = active ? (existingPipeline ?? createPipeline(media)) : existingPipeline;
    if (!activePipeline) {
      setPlayback(media, speed, keepPitch);
      return;
    }

    changePlayback(media, activePipeline, active, speed, keepPitch);
    if (!active) return;
    resumePipeline(activePipeline);

    const { context } = activePipeline;
    smoothTo(context, activePipeline.eqLow.gain, settings.eqLow);
    smoothTo(context, activePipeline.eqMid.gain, settings.eqMid);
    smoothTo(context, activePipeline.eqHigh.gain, settings.eqHigh);
    const reverbMix = settings.reverb / 100;
    smoothTo(context, activePipeline.wet.gain, reverbMix * 0.7);
    smoothTo(context, activePipeline.dry.gain, 1 - reverbMix * 0.3);
    smoothTo(context, activePipeline.echo.gain, (settings.echo / 100) * 0.5);
    smoothTo(context, activePipeline.saturation.gain, (settings.saturation / 100) * 0.6);
    smoothTo(context, activePipeline.width.gain, settings.width / 100);
    smoothTo(context, activePipeline.pan.pan, settings.pan / 100);
  }

  function notifyStatus() {
    const processingActive =
      enabled &&
      [...mediaElements].some((media) => startedMedia.has(media) && pipelines.has(media));
    window.postMessage(
      {
        channel: CHANNEL,
        type: 'STATUS',
        playerDetected: mediaElements.size > 0,
        effectsUnavailable: processingUnavailable,
        processingActive
      },
      '*'
    );
  }

  function registerMedia(media) {
    if (!(media instanceof HTMLMediaElement) || mediaElements.has(media)) return;
    mediaElements.add(media);
    media.addEventListener('play', () => {
      applySettings(media);
      resumePipeline(pipelines.get(media));
    });
    media.addEventListener('playing', () => {
      startedMedia.add(media);
      applySettings(media);
      resumePipeline(pipelines.get(media));
      notifyStatus();
    });
    media.addEventListener('ratechange', () => applySettings(media));
    media.addEventListener('loadedmetadata', () => applySettings(media));
    notifyStatus();
  }

  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    registerMedia(this);
    return originalPlay.apply(this, args);
  };

  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (srcDescriptor?.get && srcDescriptor.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: srcDescriptor.configurable,
      enumerable: srcDescriptor.enumerable,
      get: srcDescriptor.get,
      set(value) {
        registerMedia(this);
        return srcDescriptor.set.call(this, value);
      }
    });
  }

  const originalCreateElement = document.createElement;
  document.createElement = function (tagName, ...args) {
    const element = originalCreateElement.call(this, tagName, ...args);
    if (typeof tagName === 'string' && ['audio', 'video'].includes(tagName.toLowerCase())) {
      registerMedia(element);
    }
    return element;
  };

  const OriginalAudio = window.Audio;
  if (OriginalAudio) {
    window.Audio = new Proxy(OriginalAudio, {
      apply(target, thisArg, args) {
        const media = Reflect.apply(target, thisArg, args);
        registerMedia(media);
        return media;
      },
      construct(target, args, newTarget) {
        const media = Reflect.construct(target, args, newTarget);
        registerMedia(media);
        return media;
      }
    });
  }

  function applyToAll(nextSettings, nextEnabled) {
    settings = normalizeSettings(nextSettings);
    enabled = nextEnabled === true;
    for (const media of mediaElements) applySettings(media);
    notifyStatus();
  }

  // The extension's bridge cancels this event while the extension is running.
  // When the extension is turned off, removed or updated, Firefox removes the
  // bridge and Chromium leaves it running without access to the extension,
  // and this engine stays in the page either way. Dispatching an event is
  // synchronous, so a slow or throttled tab cannot miss an answer.
  function bridgeAnswers() {
    return !document.dispatchEvent(new Event(BRIDGE_CHECK_EVENT, { cancelable: true }));
  }

  function watchBridge() {
    if (bridgeCheckTimer !== null) return;
    bridgeCheckTimer = window.setInterval(() => {
      if (bridgeAnswers()) return;

      window.clearInterval(bridgeCheckTimer);
      bridgeCheckTimer = null;
      applyToAll(NEUTRAL_SETTINGS, false);
    }, BRIDGE_CHECK_MS);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;

    if (event.data.type === 'BRIDGE_READY') {
      // Also a bridge that Firefox injects again when the extension comes back.
      watchBridge();
      window.postMessage({ channel: CHANNEL, type: 'READY', bridgeCheck: true }, '*');
      notifyStatus();
    } else if (event.data.type === 'APPLY') {
      watchBridge();
      applyToAll(event.data.settings, event.data.enabled);
    }
  });

  document.addEventListener('click', () => {
    for (const media of mediaElements) resumePipeline(pipelines.get(media));
  });

  for (const media of document.querySelectorAll('audio, video')) registerMedia(media);
  window.postMessage({ channel: CHANNEL, type: 'READY', bridgeCheck: true }, '*');
  notifyStatus();
})();
