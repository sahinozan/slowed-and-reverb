(() => {
  // Popup, shortcuts, and navigation recovery may all inject into the same document.
  if (window.__slowedReverbInjected) return;
  window.__slowedReverbInjected = true;

  const api = typeof browser !== 'undefined' ? browser : chrome;

  const NEUTRAL_SETTINGS = Object.freeze({
    speed: 1.0,
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

  const HAVE_METADATA = 1;
  const MEDIA_SETTLE_MS = 100;
  const MAX_ACTIVE_PIPELINES = 32;

  const isSupportedHost =
    location.hostname === 'www.youtube.com' || location.hostname === 'music.youtube.com';

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

  function blockReason() {
    if (!isSupportedHost) return 'unsupportedSite';
    if (drmDetected) return 'drm';
    if (processingUnavailable) return 'unsupported';
    return null;
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

  function setPipelineEnabled(pipeline, enabled) {
    pipeline.bypass.gain.value = enabled ? 0 : 1;
    pipeline.processed.gain.value = enabled ? 1 : 0;
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
    if (!isSupportedHost) return null;

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
      const bypass = createGain(context, 0);
      const processed = createGain(context, 1);

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
      location.hostname.endsWith('youtube.com') &&
      document.querySelector('.ytp-live-badge-is-livehead') !== null
    );
  }

  function applySettings(media) {
    if (!media) return;

    let pipeline = pipelines.get(media);

    if (!effectEnabled) {
      media.playbackRate = NEUTRAL_SETTINGS.speed;
      media.preservesPitch = NEUTRAL_SETTINGS.keepPitch;
      media.mozPreservesPitch = NEUTRAL_SETTINGS.keepPitch;
      media.webkitPreservesPitch = NEUTRAL_SETTINGS.keepPitch;

      if (pipeline && connectPipeline(media, pipeline)) setPipelineEnabled(pipeline, false);
      return;
    }

    pipeline ??= createPipeline(media);
    if (!pipeline) return;
    if (!connectPipeline(media, pipeline)) return;
    setPipelineEnabled(pipeline, true);

    const settings = currentSettings;
    const live = isLiveMedia(media);
    liveStreamDetected = liveStreamDetected || live;

    if (live) {
      media.playbackRate = NEUTRAL_SETTINGS.speed;
      media.preservesPitch = NEUTRAL_SETTINGS.keepPitch;
      media.mozPreservesPitch = NEUTRAL_SETTINGS.keepPitch;
      media.webkitPreservesPitch = NEUTRAL_SETTINGS.keepPitch;
    } else {
      media.playbackRate = settings.speed;
      media.preservesPitch = settings.keepPitch;
      media.mozPreservesPitch = settings.keepPitch;
      media.webkitPreservesPitch = settings.keepPitch;
    }

    pipeline.eqLow.gain.value = settings.eqLow;
    pipeline.eqMid.gain.value = settings.eqMid;
    pipeline.eqHigh.gain.value = settings.eqHigh;

    const reverbMix = settings.reverb / 100;
    pipeline.wet.gain.value = reverbMix * REVERB_WET_SCALE;
    pipeline.dry.gain.value = 1 - reverbMix * REVERB_DRY_DUCK;

    pipeline.echo.gain.value = (settings.echo / 100) * ECHO_WET_SCALE;
    pipeline.saturation.gain.value = (settings.saturation / 100) * SATURATION_WET_SCALE;
    pipeline.width.gain.value = settings.width / 100;
    pipeline.pan.pan.value = settings.pan / 100;
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
              notifyStateChanged();
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
      if (effectEnabled) notifyStateChanged();
    }, MEDIA_SETTLE_MS);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  function notifyStateChanged() {
    api.runtime
      .sendMessage({
        type: 'CONTENT_STATE_CHANGED',
        enabled: effectEnabled,
        settings: currentSettings,
        origin: location.origin,
        playerDetected,
        processingActive
      })
      .catch(() => {});
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_AUDIO') {
      currentSettings = message.settings;
      effectEnabled = Boolean(message.enabled);
      processMediaElements();
      const reason = blockReason();
      if (reason) effectEnabled = false;
      sendResponse({
        success: reason === null,
        blocked: reason !== null,
        blockReason: reason,
        playerDetected,
        processingActive,
        pending: reason === null && effectEnabled && !processingActive
      });
    } else if (message.type === 'GET_STATE') {
      const reason = blockReason();
      sendResponse({
        enabled: effectEnabled,
        settings: currentSettings,
        blocked: reason !== null,
        blockReason: reason,
        live: liveStreamDetected,
        playerDetected,
        processingActive,
        pending: reason === null && effectEnabled && !processingActive
      });
    } else if (message.type === 'YOUTUBE_PERMISSION_REVOKED') {
      effectEnabled = false;
      processMediaElements();
      sendResponse({ success: true, enabled: false });
    }
    return true;
  });

  function startProcessingMedia() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', processMediaElements, { once: true });
    } else {
      processMediaElements();
    }
  }

  api.runtime
    .sendMessage({ type: 'GET_TAB_STATE', url: location.origin })
    .catch(() => null)
    .then((remembered) => {
      const restored = Boolean(remembered?.enabled);
      if (restored) {
        currentSettings = remembered.settings;
        effectEnabled = true;
      }

      startProcessingMedia();

      // Reporting "off" here would overwrite the remembered state for the next reload.
      if (restored) notifyStateChanged();
    });

  // YouTube changes routes without replacing the document or reinjecting this script.
  document.addEventListener('yt-navigate-finish', () => {
    processMediaElements();
    notifyStateChanged();
  });

  // Browsers may require a later page gesture before a suspended AudioContext can resume.
  document.addEventListener('click', resumeAudioContext);
})();
