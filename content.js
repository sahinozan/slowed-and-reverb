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

  const DRM_HOSTS = new Set([
    'open.spotify.com',
    'music.apple.com',
    'www.netflix.com',
    'www.primevideo.com',
    'primevideo.com',
    'play.max.com',
    'www.max.com',
    'www.disneyplus.com',
    'www.hulu.com',
    'listen.tidal.com',
    'music.amazon.com',
    'www.deezer.com',
    'www.pandora.com',
    'www.audible.com',
    'www.paramountplus.com',
    'www.peacocktv.com',
    'tv.apple.com',
    'www.crunchyroll.com'
  ]);

  const UNREACHABLE_HOSTS = new Set([
    'soundcloud.com',
    'www.soundcloud.com',
    'm.soundcloud.com'
  ]);

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
  const HAVE_CURRENT_DATA = 2;
  const MEDIA_SETTLE_MS = 100;

  const isDrmHost = DRM_HOSTS.has(location.hostname);
  const isUnreachableHost = UNREACHABLE_HOSTS.has(location.hostname);
  const isTwitchClip =
    location.hostname === 'www.twitch.tv' && /^\/[^/]+\/clip\//.test(location.pathname);

  let audioContext = null;
  const pipelines = new WeakMap();

  let currentSettings = { ...NEUTRAL_SETTINGS };
  let effectEnabled = false;
  let drmDetected = false;
  let liveStreamDetected = false;

  function blockReason() {
    if (drmDetected || isDrmHost) return 'drm';
    if (isTwitchClip) return 'broken';
    if (isUnreachableHost) return 'unreachable';
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

  function createPipeline(media) {
    if (media.mediaKeys) {
      drmDetected = true;
      return null;
    }

    // Attaching Web Audio permanently silences Twitch's tainted cross-origin clips.
    if (isTwitchClip) return null;

    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    const context = audioContext;

    try {
      if (!media.crossOrigin) media.crossOrigin = 'anonymous';

      const source = context.createMediaElementSource(media);

      const eqLow = createFilter(context, 'lowshelf', EQ_LOW_FREQUENCY);
      const eqMid = createFilter(context, 'peaking', EQ_MID_FREQUENCY, EQ_MID_Q);
      const eqHigh = createFilter(context, 'highshelf', EQ_HIGH_FREQUENCY);

      const convolver = context.createConvolver();
      convolver.buffer = createImpulseResponse(context, REVERB_DURATION, REVERB_DECAY);

      const delay = context.createDelay(1.0);
      delay.delayTime.value = ECHO_DELAY_SECONDS;

      const saturator = context.createWaveShaper();
      saturator.curve = createSaturationCurve(SATURATION_DRIVE);
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

      source.connect(eqLow);
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
        .connect(context.destination);

      const pipeline = { eqLow, eqMid, eqHigh, dry, wet, echo, saturation, width, pan };
      pipelines.set(media, pipeline);

      // Reused media elements often reset playbackRate when a new track starts.
      media.addEventListener('play', () => applySettings(media));

      return pipeline;
    } catch (error) {
      if (error.name === 'InvalidStateError' || error.name === 'NotSupportedError') {
        drmDetected = true;
      }
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

    const pipeline = pipelines.get(media) ?? createPipeline(media);
    if (!pipeline) return;

    const settings = effectEnabled ? currentSettings : NEUTRAL_SETTINGS;
    const live = isLiveMedia(media);
    liveStreamDetected = liveStreamDetected || live;

    if (!live) {
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
    drmDetected = false;
    liveStreamDetected = false;

    for (const media of document.querySelectorAll('video, audio')) {
      if (pipelines.has(media) || media.readyState >= HAVE_CURRENT_DATA) {
        applySettings(media);
      } else {
        media.addEventListener('loadedmetadata', () => applySettings(media), { once: true });
      }
    }
  }

  function containsMedia(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') return true;
    return node.querySelector?.('video, audio') !== null;
  }

  const observer = new MutationObserver((mutations) => {
    const added = mutations.some((mutation) =>
      Array.prototype.some.call(mutation.addedNodes, containsMedia)
    );
    if (added) setTimeout(processMediaElements, MEDIA_SETTLE_MS);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  function notifyStateChanged() {
    api.runtime
      .sendMessage({
        type: 'CONTENT_STATE_CHANGED',
        enabled: effectEnabled,
        settings: currentSettings,
        url: location.href
      })
      .catch(() => {});
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_AUDIO') {
      currentSettings = message.settings;
      effectEnabled = Boolean(message.enabled);
      processMediaElements();
      sendResponse({ success: true });
    } else if (message.type === 'GET_STATE') {
      const reason = blockReason();
      sendResponse({
        enabled: effectEnabled,
        settings: currentSettings,
        blocked: reason !== null,
        blockReason: reason,
        live: liveStreamDetected
      });
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
    .sendMessage({ type: 'GET_TAB_STATE', url: location.href })
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

  document.addEventListener(
    'click',
    () => {
      // Browsers may require a page gesture before a suspended AudioContext can resume.
      if (audioContext?.state === 'suspended') audioContext.resume();
    },
    { once: true }
  );
})();
