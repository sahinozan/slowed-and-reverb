'use strict';

// The site's demo signal chain. It mirrors extension/content.js so what you
// hear is what the extension does: an <audio> element carries speed and pitch
// (playbackRate and preservesPitch, exactly as on YouTube), then the same EQ,
// reverb, echo, saturation, width, pan and limiter with the same numbers. The
// loop is a short excerpt of a Creative Commons song served from this site.

window.SRDemo = (function () {
  const BPM = 80;
  const NEUTRAL = Object.freeze({
    speed: 1, reverb: 0, echo: 0, pan: 0, width: 100,
    keepPitch: false, saturation: 0, eqLow: 0, eqMid: 0, eqHigh: 0
  });

  // Copied from extension/content.js.
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

  let context = null;
  let media = null;
  let pipeline = null;
  let loopUrl = null;
  let loading = false;
  let error = null;
  let wanted = { settings: { ...NEUTRAL }, enabled: false };
  const listeners = new Set();

  function snapshot() {
    return {
      playing: Boolean(media && !media.paused),
      loading,
      error,
      settings: wanted.settings,
      enabled: wanted.enabled
    };
  }
  function emit() { for (const fn of listeners) fn(snapshot()); }

  /* ---- Loop ------------------------------------------------------------ */

  // 24 seconds (8 bars at 80 bpm) of "Start Again" by Alex Beroza featuring
  // Snowflake & Subliminal, CC BY 3.0, https://ccmixter.org/files/AlexBeroza/31670.
  // Cut from 2:29.46 to 2:53.46, level reduced, with the first 20 ms crossfaded
  // into what follows the cut so the seam is silent. See audio/CREDITS.txt.
  const LOOP_SRC = new URL('audio/start-again-loop.mp3', document.currentScript.src).href;

  // Decoded and rewritten as WAV because an <audio> element loops a WAV
  // without a gap, which it does not promise for MP3.
  async function loadLoop() {
    const response = await fetch(LOOP_SRC);
    if (!response.ok) throw new Error(`Demo loop: HTTP ${response.status}`);
    const decoder = new OfflineAudioContext(2, 1, 44100);
    return decoder.decodeAudioData(await response.arrayBuffer());
  }

  function wavBlob(buffer) {
    const channels = buffer.numberOfChannels;
    const frames = buffer.length;
    const bytes = 44 + frames * channels * 2;
    const view = new DataView(new ArrayBuffer(bytes));
    const ascii = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF'); view.setUint32(4, bytes - 8, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, frames * channels * 2, true);
    const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i]));
        view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
        offset += 2;
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  /* ---- Signal chain (mirrors createPipeline in content.js) ------------- */

  function createGain(value = 1) {
    const node = context.createGain();
    node.gain.value = value;
    return node;
  }

  function createFilter(type, frequency, q) {
    const node = context.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    if (q !== undefined) node.Q.value = q;
    node.gain.value = 0;
    return node;
  }

  function createImpulseResponse(duration, decay) {
    const length = Math.floor(context.sampleRate * duration);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = impulse.getChannelData(c);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
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

  function connectStereoWidth(input, widthGain) {
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    const mid = context.createGain();
    const side = context.createGain();
    const sideInverted = createGain(-1);
    const left = context.createGain();
    const right = context.createGain();

    input.connect(splitter);
    splitter.connect(createGain(0.5), 0).connect(mid);
    splitter.connect(createGain(0.5), 1).connect(mid);
    splitter.connect(createGain(0.5), 0).connect(side);
    splitter.connect(createGain(-0.5), 1).connect(side);
    side.connect(widthGain);
    mid.connect(left);
    widthGain.connect(left);
    mid.connect(right);
    widthGain.connect(sideInverted).connect(right);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    return merger;
  }

  function buildPipeline() {
    context = new AudioContext();
    media = new Audio(loopUrl);
    media.loop = true;
    media.addEventListener('play', emit);
    media.addEventListener('pause', emit);

    const source = context.createMediaElementSource(media);
    const stereoInput = context.createGain();
    stereoInput.channelCount = 2;
    stereoInput.channelCountMode = 'explicit';
    stereoInput.channelInterpretation = 'speakers';

    const eqLow = createFilter('lowshelf', EQ_LOW_FREQUENCY);
    const eqMid = createFilter('peaking', EQ_MID_FREQUENCY, EQ_MID_Q);
    const eqHigh = createFilter('highshelf', EQ_HIGH_FREQUENCY);

    const convolver = context.createConvolver();
    convolver.buffer = createImpulseResponse(REVERB_DURATION, REVERB_DECAY);

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
    const dry = createGain(1);
    const wet = createGain(0);
    const echo = createGain(0);
    const saturation = createGain(0);
    const width = createGain(1);
    const mixed = createGain(1);
    const bypass = createGain(0);
    const processed = createGain(1);

    source.connect(stereoInput);
    source.connect(bypass).connect(context.destination);
    stereoInput.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(dry).connect(mixed);
    eqHigh.connect(convolver).connect(wet).connect(mixed);
    eqHigh.connect(delay);
    delay.connect(createGain(ECHO_FEEDBACK)).connect(delay);
    delay.connect(echo).connect(mixed);
    eqHigh.connect(saturator).connect(saturation).connect(mixed);
    connectStereoWidth(mixed, width)
      .connect(pan)
      .connect(limiter)
      .connect(processed)
      .connect(context.destination);

    pipeline = { eqLow, eqMid, eqHigh, dry, wet, echo, saturation, width, pan, bypass, processed };
  }

  // Mirrors applySettings in content.js.
  function applyNow() {
    if (!pipeline) return;
    const { settings, enabled } = wanted;
    const s = enabled ? settings : NEUTRAL;

    media.playbackRate = s.speed;
    media.preservesPitch = s.keepPitch;
    pipeline.bypass.gain.value = enabled ? 0 : 1;
    pipeline.processed.gain.value = enabled ? 1 : 0;
    if (!enabled) return;

    pipeline.eqLow.gain.value = s.eqLow;
    pipeline.eqMid.gain.value = s.eqMid;
    pipeline.eqHigh.gain.value = s.eqHigh;
    const reverbMix = s.reverb / 100;
    pipeline.wet.gain.value = reverbMix * REVERB_WET_SCALE;
    pipeline.dry.gain.value = 1 - reverbMix * REVERB_DRY_DUCK;
    pipeline.echo.gain.value = (s.echo / 100) * ECHO_WET_SCALE;
    pipeline.saturation.gain.value = (s.saturation / 100) * SATURATION_WET_SCALE;
    pipeline.width.gain.value = s.width / 100;
    pipeline.pan.pan.value = s.pan / 100;
  }

  /* ---- Public --------------------------------------------------------- */

  function apply(settings, enabled) {
    wanted = { settings: { ...NEUTRAL, ...settings }, enabled: Boolean(enabled) };
    applyNow();
    emit();
  }

  // Never rejects. A failure is reported in the state instead: 'blocked' when
  // the browser refused to start playback (an autoplay rule, for example),
  // 'failed' for anything else.
  async function play() {
    if (loading) return;
    loading = true;
    error = null;
    emit();
    try {
      if (!loopUrl) loopUrl = URL.createObjectURL(wavBlob(await loadLoop()));
      if (!pipeline) buildPipeline();
      await context.resume();
      applyNow();
      await media.play();
    } catch (reason) {
      if (media) media.pause();
      error = reason && reason.name === 'NotAllowedError' ? 'blocked' : 'failed';
    } finally {
      loading = false;
      emit();
    }
  }

  function pause() {
    if (media) media.pause();
    emit();
  }

  return {
    BPM,
    apply,
    play,
    pause,
    toggle: () => (media && !media.paused ? pause() : play()),
    subscribe(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },
    get state() { return snapshot(); }
  };
}());
