// YouTube's audio engine. It runs in the page's own world, injected before
// content.js, which passes it the extension's settings. Firefox removes
// content.js outright when the extension is turned off, removed or updated, but
// the page keeps the audio nodes; from here they can still be turned off.
(() => {
  // The extension may inject this again, and after it is turned off and on
  // the engine already in the page keeps the players it captured.
  if (window.__slowedReverbYouTubeMain) return;
  window.__slowedReverbYouTubeMain = true;

  const CHANNEL = 'SLOWED_REVERB_YOUTUBE';
  const BRIDGE_CHECK_EVENT = `${CHANNEL}_CHECK`;
  const BRIDGE_CHECK_MS = 250;
  // The version this code was released as, which content.js compares with
  // its own. This engine stays in an open tab when the extension is updated,
  // and the new version's copy of this file then stops at the check above,
  // leaving the new content.js to talk to this one. tests/settings.test.js
  // keeps this equal to content.js's and the manifest's version.
  const VERSION = '1.1.1';

  // Copies of SlowedReverbSettings.DEFAULTS and BOUNDS (settings.js), which
  // the page's world does not load; tests/settings.test.js keeps them equal.
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

  const EQ_LOW_FREQUENCY = 200;
  const EQ_MID_FREQUENCY = 1000;
  const EQ_MID_Q = 1;
  const EQ_HIGH_FREQUENCY = 4000;

  const REVERB_DURATION = 2.0;
  const REVERB_DECAY = 2.5;
  const REVERB_WET_SCALE = 0.7;
  const REVERB_DRY_DUCK = 0.3;

  const ECHO_DELAY_SECONDS = 0.35;
  const ECHO_FEEDBACK = 0.35;
  const ECHO_WET_SCALE = 0.5;

  const SATURATION_DRIVE = 4;
  const SATURATION_WET_SCALE = 0.6;

  const LIMITER = { threshold: -3, knee: 3, ratio: 20, attack: 0.003, release: 0.25 };

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

  const HAVE_METADATA = 1;
  const MEDIA_SETTLE_MS = 100;
  const MAX_ACTIVE_PIPELINES = 32;

  let audioContext = null;
  let impulseResponse = null;
  let saturationCurve = null;
  const pipelines = new WeakMap();
  const activePipelines = new Map();
  const pendingMetadata = new WeakSet();
  let mediaProcessTimer = null;

  let currentSettings = { ...NEUTRAL_SETTINGS };
  let effectEnabled = false;
  let drmDetected = false;
  let liveStreamDetected = false;
  let processingUnavailable = false;
  let playerDetected = false;
  let processingActive = false;
  // Without the extension, captured media keeps playing through the unchanged
  // path and the page sets its own speed and pitch.
  let bridgeConnected = false;
  let bridgeCheckTimer = null;
  let started = false;
  // Which change from content.js the engine's state reflects.
  let revision = null;

  function blockReason() {
    if (drmDetected) return 'drm';
    if (processingUnavailable) return 'unsupported';
    return null;
  }

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

  function createImpulseResponse(context, duration, decay) {
    const length = Math.floor(context.sampleRate * duration);
    const impulse = context.createBuffer(2, length, context.sampleRate);

    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
      const samples = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        samples[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }

    return impulse;
  }

  function createSaturationCurve(drive, sampleCount = 1024) {
    const curve = new Float32Array(sampleCount);
    const normalize = Math.tanh(drive);

    for (let i = 0; i < sampleCount; i++) {
      const x = (i * 2) / (sampleCount - 1) - 1;
      curve[i] = Math.tanh(drive * x) / normalize;
    }

    return curve;
  }

  function resumeAudioContext() {
    if (audioContext?.state !== 'suspended') return;
    audioContext.resume().catch(() => {});
  }

  // The path each setting is scheduled to take, as the points it reaches:
  // in a straight line from the point before (ramp), or by jumping. Firefox
  // has no cancelAndHoldAtTime, so a new change works out from this where
  // the setting will be when it starts, and carries on from exactly there.
  const paths = new WeakMap();

  function pathValue(path, time) {
    let previous = path[0];
    for (const point of path.slice(1)) {
      if (point.time > time) {
        if (!point.ramp || point.time <= previous.time) return previous.value;
        const progress = (time - previous.time) / (point.time - previous.time);
        return previous.value + (point.value - previous.value) * progress;
      }
      previous = point;
    }
    return previous.value;
  }

  // Replaces a setting's path from `start` on with `points`, keeping the old
  // path up to `start`, so a change that overlaps an earlier one never jumps.
  function schedulePath(context, param, start, points) {
    const path = paths.get(param) ?? [{ time: 0, value: param.value, ramp: false }];
    const value = pathValue(path, start);
    param.cancelScheduledValues(start);
    param.linearRampToValueAtTime(value, start);
    for (const point of points) {
      if (point.ramp) param.linearRampToValueAtTime(point.value, point.time);
      else param.setValueAtTime(point.value, point.time);
    }
    // From before `start`, only the points from the last one already played on.
    const kept = path.filter((point) => point.time < start);
    const played = kept.findLastIndex((point) => point.time <= context.currentTime);
    paths.set(param, [...kept.slice(Math.max(played, 0)), { time: start, value, ramp: true }, ...points]);
  }

  function smoothTo(param, value) {
    const start = audioContext.currentTime + SCHEDULE_AHEAD_SECONDS;
    schedulePath(audioContext, param, start, [
      { time: start + SMOOTHING_SECONDS, value, ramp: true }
    ]);
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

  function connectStereoWidth(context, input, widthGain) {
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    const mid = context.createGain();
    const side = context.createGain();
    const sideInverted = createGain(context, -1);
    const left = context.createGain();
    const right = context.createGain();

    // Mid/side matrix: mid=(L+R)/2, side=(L-R)/2, then scale and recombine.
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
  function setPipelineEnabled(pipeline, enabled) {
    const now = audioContext.currentTime;
    const silentUntil = pipeline.pendingPlayback ? Infinity : pipeline.quietUntil;
    const outputs = [
      [pipeline.bypass.gain, enabled ? 0 : 1],
      [pipeline.processed.gain, enabled ? 1 : 0]
    ];

    for (const [param, value] of outputs) {
      if (silentUntil <= now) {
        smoothTo(param, value);
        continue;
      }
      const start = now + SCHEDULE_AHEAD_SECONDS;
      const silentFrom = start + DIP_FADE_SECONDS;
      const points = [{ time: silentFrom, value: 0, ramp: true }];
      if (silentUntil !== Infinity) {
        const silentTo = Math.max(silentUntil, silentFrom);
        points.push(
          { time: silentTo, value: 0, ramp: false },
          { time: silentTo + SMOOTHING_SECONDS, value, ramp: true }
        );
      }
      schedulePath(audioContext, param, start, points);
    }
  }

  function playbackClicks(media, speed, keepPitch) {
    if (media.preservesPitch !== keepPitch) return true;
    return FIREFOX && Math.abs(media.playbackRate - speed) > 0.001;
  }

  function setPlayback(media, speed, keepPitch) {
    media.playbackRate = speed;
    media.preservesPitch = keepPitch;
    media.mozPreservesPitch = keepPitch;
    media.webkitPreservesPitch = keepPitch;
  }

  // Drops a player change still waiting for the output to fade out. Any
  // silence still needed for an earlier change stays.
  function cancelPendingPlayback(pipeline) {
    pipeline.pendingPlayback = null;
  }

  // Sets the crossfade and the player's speed and pitch mode. A change that
  // makes the player click waits until the output has faded out.
  function changePlayback(media, pipeline, enabled, speed, keepPitch) {
    cancelPendingPlayback(pipeline);

    if (!playbackClicks(media, speed, keepPitch)) {
      setPipelineEnabled(pipeline, enabled);
      setPlayback(media, speed, keepPitch);
      return;
    }

    const change = () => {
      if (pipeline.pendingPlayback !== change) return;
      pipeline.pendingPlayback = null;
      // Timed from the change itself, in case this ran late, and scheduled
      // first, since changing the player can run this file's code again.
      pipeline.quietUntil = Math.max(
        pipeline.quietUntil,
        audioContext.currentTime + PLAYER_CLICK_SECONDS
      );
      setPipelineEnabled(pipeline, enabled);
      setPlayback(media, speed, keepPitch);
    };
    // While a change is waiting, the output stays silent.
    pipeline.pendingPlayback = change;
    setPipelineEnabled(pipeline, enabled);
    window.setTimeout(change, PLAYER_CHANGE_DELAY_MS);
  }

  function connectPipeline(media, pipeline) {
    if (pipeline.connected) return true;
    if (activePipelines.size >= MAX_ACTIVE_PIPELINES) return false;

    pipeline.source.connect(pipeline.stereoInput);
    pipeline.source.connect(pipeline.bypass);
    pipeline.bypass.connect(audioContext.destination);
    pipeline.processed.connect(audioContext.destination);
    media.addEventListener('play', pipeline.playListener);
    pipeline.connected = true;
    activePipelines.set(media, pipeline);
    return true;
  }

  function disconnectPipeline(media, pipeline) {
    if (!pipeline.connected) return;

    pipeline.source.disconnect();
    pipeline.bypass.disconnect();
    pipeline.processed.disconnect();
    media.removeEventListener('play', pipeline.playListener);
    pipeline.connected = false;
    activePipelines.delete(media);
  }

  function cleanRemovedPipelines() {
    for (const [media, pipeline] of activePipelines) {
      if (!media.isConnected) disconnectPipeline(media, pipeline);
    }
  }

  function createPipeline(media) {
    if (media.mediaKeys) {
      drmDetected = true;
      return null;
    }

    if (activePipelines.size >= MAX_ACTIVE_PIPELINES) return null;

    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    resumeAudioContext();

    const context = audioContext;

    try {
      const source = context.createMediaElementSource(media);
      const stereoInput = context.createGain();
      stereoInput.channelCount = 2;
      stereoInput.channelCountMode = 'explicit';
      stereoInput.channelInterpretation = 'speakers';

      const eqLow = createFilter(context, 'lowshelf', EQ_LOW_FREQUENCY);
      const eqMid = createFilter(context, 'peaking', EQ_MID_FREQUENCY, EQ_MID_Q);
      const eqHigh = createFilter(context, 'highshelf', EQ_HIGH_FREQUENCY);

      const convolver = context.createConvolver();
      impulseResponse ??= createImpulseResponse(context, REVERB_DURATION, REVERB_DECAY);
      convolver.buffer = impulseResponse;

      const delay = context.createDelay(1.0);
      delay.delayTime.value = ECHO_DELAY_SECONDS;

      const saturator = context.createWaveShaper();
      saturationCurve ??= createSaturationCurve(SATURATION_DRIVE);
      saturator.curve = saturationCurve;
      saturator.oversample = '4x';

      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = LIMITER.threshold;
      limiter.knee.value = LIMITER.knee;
      limiter.ratio.value = LIMITER.ratio;
      limiter.attack.value = LIMITER.attack;
      limiter.release.value = LIMITER.release;

      const pan = context.createStereoPanner();
      pan.pan.value = 0;

      const dry = createGain(context, 1);
      const wet = createGain(context, 0);
      const echo = createGain(context, 0);
      const saturation = createGain(context, 0);
      const width = createGain(context, 1);
      const mixed = createGain(context, 1);
      // Both start silent; the first crossfade brings in the effect.
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
      delay.connect(createGain(context, ECHO_FEEDBACK)).connect(delay);
      delay.connect(echo).connect(mixed);

      eqHigh.connect(saturator).connect(saturation).connect(mixed);

      connectStereoWidth(context, mixed, width)
        .connect(pan)
        .connect(limiter)
        .connect(processed)
        .connect(context.destination);

      const pipeline = {
        source,
        stereoInput,
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
        // Silent until then: the player's click from a change, or Firefox's
        // gap when a player is first routed in, has passed by this time.
        quietUntil: context.currentTime + CAPTURE_SILENCE_SECONDS,
        pendingPlayback: null,
        connected: true,
        playListener: null
      };
      pipeline.playListener = () => {
        resumeAudioContext();
        applySettings(media);
      };
      pipelines.set(media, pipeline);
      activePipelines.set(media, pipeline);

      // Reused media elements often reset playbackRate when a new track starts.
      media.addEventListener('play', pipeline.playListener);

      return pipeline;
    } catch (error) {
      processingUnavailable = true;
      console.warn('Slowed & Reverb: failed to create audio pipeline', error);
      return null;
    }
  }

  function isLiveMedia(media) {
    if (media.readyState >= HAVE_METADATA && !Number.isFinite(media.duration)) return true;
    // YouTube DVR streams report a finite duration; this class marks the live head.
    return (
      (location.hostname === 'www.youtube.com' || location.hostname === 'music.youtube.com') &&
      document.querySelector('.ytp-live-badge-is-livehead') !== null
    );
  }

  function applySettings(media) {
    if (!media) return;

    let pipeline = pipelines.get(media);

    if (!bridgeConnected) {
      if (pipeline && connectPipeline(media, pipeline)) {
        cancelPendingPlayback(pipeline);
        setPipelineEnabled(pipeline, false);
      }
      return;
    }

    if (!effectEnabled) {
      const { speed, keepPitch } = NEUTRAL_SETTINGS;
      if (pipeline && connectPipeline(media, pipeline)) {
        changePlayback(media, pipeline, false, speed, keepPitch);
      } else {
        setPlayback(media, speed, keepPitch);
      }
      return;
    }

    pipeline ??= createPipeline(media);
    if (!pipeline) return;
    if (!connectPipeline(media, pipeline)) return;

    const settings = currentSettings;
    const live = isLiveMedia(media);
    liveStreamDetected = liveStreamDetected || live;

    const playback = live ? NEUTRAL_SETTINGS : settings;
    changePlayback(media, pipeline, true, playback.speed, playback.keepPitch);

    smoothTo(pipeline.eqLow.gain, settings.eqLow);
    smoothTo(pipeline.eqMid.gain, settings.eqMid);
    smoothTo(pipeline.eqHigh.gain, settings.eqHigh);

    const reverbMix = settings.reverb / 100;
    smoothTo(pipeline.wet.gain, reverbMix * REVERB_WET_SCALE);
    smoothTo(pipeline.dry.gain, 1 - reverbMix * REVERB_DRY_DUCK);

    smoothTo(pipeline.echo.gain, (settings.echo / 100) * ECHO_WET_SCALE);
    smoothTo(pipeline.saturation.gain, (settings.saturation / 100) * SATURATION_WET_SCALE);
    smoothTo(pipeline.width.gain, settings.width / 100);
    smoothTo(pipeline.pan.pan, settings.pan / 100);
  }

  function processMediaElements() {
    cleanRemovedPipelines();
    drmDetected = false;
    liveStreamDetected = false;
    processingUnavailable = false;
    const mediaElements = [...document.querySelectorAll('video, audio')];
    playerDetected = mediaElements.length > 0;

    for (const media of mediaElements) {
      // A replacement player may already have fired loadedmetadata by the time
      // YouTube attaches it to the document. Attach as soon as metadata exists
      // so we do not wait forever for an event that has already happened.
      if (!effectEnabled || pipelines.has(media) || media.readyState >= HAVE_METADATA) {
        applySettings(media);
      } else if (!pendingMetadata.has(media)) {
        pendingMetadata.add(media);
        media.addEventListener(
          'loadedmetadata',
          () => {
            pendingMetadata.delete(media);
            if (media.isConnected) {
              applySettings(media);
              if (blockReason()) effectEnabled = false;
              processingActive = effectEnabled && activePipelines.size > 0;
              postState(null, true);
            }
          },
          { once: true }
        );
      }
    }

    if (activePipelines.size > 0) {
      drmDetected = false;
      processingUnavailable = false;
    }
    if (blockReason()) effectEnabled = false;
    processingActive = effectEnabled && activePipelines.size > 0;
  }

  function containsMedia(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') return true;
    return node.querySelector?.('video, audio') !== null;
  }

  const observer = new MutationObserver((mutations) => {
    const mediaChanged = mutations.some(
      (mutation) =>
        Array.prototype.some.call(mutation.addedNodes, containsMedia) ||
        Array.prototype.some.call(mutation.removedNodes, containsMedia)
    );
    if (!mediaChanged) return;

    window.clearTimeout(mediaProcessTimer);
    mediaProcessTimer = window.setTimeout(() => {
      processMediaElements();
      if (effectEnabled) postState(null, true);
    }, MEDIA_SETTLE_MS);
  });

  // Sends the engine's state to content.js: as the answer to a request, or,
  // with notify set, for content.js to pass on to the extension.
  function postState(requestId, notify = false) {
    window.postMessage(
      {
        channel: CHANNEL,
        type: 'STATE',
        version: VERSION,
        requestId,
        notify,
        revision,
        enabled: effectEnabled,
        blockReason: blockReason(),
        live: liveStreamDetected,
        playerDetected,
        processingActive
      },
      '*'
    );
  }

  // Starts watching the page once the extension first talks to the engine.
  function start() {
    if (started) return;
    started = true;

    observer.observe(document.documentElement, { childList: true, subtree: true });

    // YouTube changes routes without replacing the document.
    document.addEventListener('yt-navigate-finish', () => {
      processMediaElements();
      postState(null, true);
    });

    // Browsers may require a later page gesture before a suspended AudioContext can resume.
    document.addEventListener('click', resumeAudioContext);
  }

  // content.js cancels this event while the extension is running. When the
  // extension is turned off, removed or updated, Firefox removes content.js
  // and Chromium leaves it running without access to the extension, so
  // nothing cancels it. Dispatching an event is synchronous, so a slow or
  // throttled tab cannot miss an answer.
  function bridgeAnswers() {
    return !document.dispatchEvent(new Event(BRIDGE_CHECK_EVENT, { cancelable: true }));
  }

  function connectBridge() {
    bridgeConnected = true;
    start();
    if (bridgeCheckTimer !== null) return;

    bridgeCheckTimer = window.setInterval(() => {
      if (bridgeAnswers()) return;

      window.clearInterval(bridgeCheckTimer);
      bridgeCheckTimer = null;
      if (effectEnabled) {
        effectEnabled = false;
        processMediaElements();
      }
      bridgeConnected = false;
    }, BRIDGE_CHECK_MS);
  }

  function process(requestId, waitForPage) {
    const run = () => {
      processMediaElements();
      postState(requestId);
    };
    if (waitForPage && document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    const { type, requestId = null } = event.data;

    if (type === 'BRIDGE_READY') {
      // Also a new content.js when the extension comes back on in Firefox.
      connectBridge();
    } else if (type === 'APPLY') {
      connectBridge();
      revision = event.data.revision ?? null;
      currentSettings = normalizeSettings(event.data.settings);
      effectEnabled = event.data.enabled === true;
      // State restored after a reload waits for the page's players.
      process(requestId, event.data.restoring === true);
    } else if (type === 'GET_STATE') {
      postState(requestId);
    }
  });
})();
