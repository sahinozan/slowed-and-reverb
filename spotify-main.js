(() => {
  if (window.__slowedReverbSpotifyMain) return;
  window.__slowedReverbSpotifyMain = true;

  const CHANNEL = 'SLOWED_REVERB_SPOTIFY';
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

  function setPipelineEnabled(pipeline, active) {
    pipeline.bypass.gain.value = active ? 0 : 1;
    pipeline.processed.gain.value = active ? 1 : 0;
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
      const bypass = createGain(context, 1);
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
        processed
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
    const activeSettings = active ? settings : NEUTRAL_SETTINGS;

    try {
      if (Math.abs(media.playbackRate - activeSettings.speed) > 0.001) {
        media.playbackRate = activeSettings.speed;
      }
      media.preservesPitch = activeSettings.keepPitch;
      media.mozPreservesPitch = activeSettings.keepPitch;
      media.webkitPreservesPitch = activeSettings.keepPitch;
    } catch {}

    // Setting playbackRate may synchronously emit ratechange and create the
    // pipeline through a nested call, so read the map again afterward.
    let activePipeline = pipelines.get(media);
    if (!active) {
      if (activePipeline) setPipelineEnabled(activePipeline, false);
      return;
    }

    activePipeline ??= createPipeline(media);
    if (!activePipeline) return;
    setPipelineEnabled(activePipeline, true);
    resumePipeline(activePipeline);

    activePipeline.eqLow.gain.value = settings.eqLow;
    activePipeline.eqMid.gain.value = settings.eqMid;
    activePipeline.eqHigh.gain.value = settings.eqHigh;
    const reverbMix = settings.reverb / 100;
    activePipeline.wet.gain.value = reverbMix * 0.7;
    activePipeline.dry.gain.value = 1 - reverbMix * 0.3;
    activePipeline.echo.gain.value = (settings.echo / 100) * 0.5;
    activePipeline.saturation.gain.value = (settings.saturation / 100) * 0.6;
    activePipeline.width.gain.value = settings.width / 100;
    activePipeline.pan.pan.value = settings.pan / 100;
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

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;

    if (event.data.type === 'BRIDGE_READY') {
      window.postMessage({ channel: CHANNEL, type: 'READY' }, '*');
      notifyStatus();
    } else if (event.data.type === 'APPLY') {
      settings = normalizeSettings(event.data.settings);
      enabled = Boolean(event.data.enabled);
      for (const media of mediaElements) applySettings(media);
      notifyStatus();
    }
  });

  document.addEventListener('click', () => {
    for (const media of mediaElements) resumePipeline(pipelines.get(media));
  });

  for (const media of document.querySelectorAll('audio, video')) registerMedia(media);
  window.postMessage({ channel: CHANNEL, type: 'READY' }, '*');
  notifyStatus();
})();
