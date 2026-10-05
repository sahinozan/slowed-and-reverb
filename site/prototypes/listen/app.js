'use strict';

// The demo is the extension's own signal chain, run on a loop synthesised in
// the page. Constants are copied from extension/content.js so what you hear is
// what the extension does: playbackRate for speed (pitch follows), a generated
// impulse response for reverb, the same EQ shelves and the same limiter.

(function () {
  const BPM = 92;
  const EQ = { low: 200, mid: 1000, midQ: 1, high: 4000 };
  const REVERB_DURATION = 2.0;
  const REVERB_DECAY = 2.5;
  const REVERB_WET_SCALE = 0.7;
  const REVERB_DRY_DUCK = 0.3;
  const LIMITER = { threshold: -3, knee: 3, ratio: 20, attack: 0.003, release: 0.25 };

  const speed = document.getElementById('speed');
  const reverb = document.getElementById('reverb');
  const play = document.getElementById('play');
  const playLabel = document.getElementById('play-label');
  const rateOut = document.getElementById('rate');
  const stOut = document.getElementById('semitones');
  const bpmOut = document.getElementById('bpm');
  const reverbOut = document.getElementById('reverb-out');
  const ruler = document.getElementById('ruler');

  let ctx = null;
  let input = null;
  let dry = null;
  let wet = null;
  let source = null;
  let loop = null;
  let busy = false;

  /* ---- Readout ---------------------------------------------------------- */

  function readout() {
    const rate = Number(speed.value);
    const st = 12 * Math.log2(rate);
    const sign = st > 0.05 ? '+' : st < -0.05 ? '−' : '';
    rateOut.textContent = `${rate.toFixed(2)}×`;
    stOut.textContent = `${sign}${Math.abs(st).toFixed(1)} semitones`;
    bpmOut.textContent = `${Math.round(BPM * rate)} bpm`;
    reverbOut.textContent = `${reverb.value}%`;
  }

  function drawRuler() {
    const w = ruler.clientWidth;
    const h = 72;
    if (!w) return;
    const ns = 'http://www.w3.org/2000/svg';
    ruler.setAttribute('viewBox', `0 0 ${w} ${h}`);
    ruler.replaceChildren();

    const base = document.createElementNS(ns, 'line');
    base.setAttribute('class', 'base');
    base.setAttribute('x1', 0); base.setAttribute('x2', w);
    base.setAttribute('y1', h - 0.5); base.setAttribute('y2', h - 0.5);
    ruler.append(base);

    // Thumb is 4px wide, so its centre travels from 2 to w-2.
    const x = (i) => 2 + (i / 20) * (w - 4);
    for (let i = 0; i <= 20; i++) {
      const major = i % 5 === 0;
      const mid = i % 2 === 0;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', x(i)); line.setAttribute('x2', x(i));
      line.setAttribute('y1', h); line.setAttribute('y2', h - (major ? 40 : mid ? 22 : 12));
      if (major) line.setAttribute('class', 'major');
      ruler.append(line);
      if (major) {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', x(i)); t.setAttribute('y', 14);
        t.setAttribute('text-anchor', i === 0 ? 'start' : i === 20 ? 'end' : 'middle');
        t.textContent = `${(0.5 + i * 0.05).toFixed(2)}×`;
        ruler.append(t);
      }
    }
  }

  /* ---- Loop ------------------------------------------------------------- */

  function noiseBuffer(off, seconds) {
    const buf = off.createBuffer(1, Math.ceil(off.sampleRate * seconds), off.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function renderLoop(sampleRate) {
    const beat = 60 / BPM;
    const bars = 4;
    const seconds = bars * 4 * beat;
    const off = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

    const master = off.createGain();
    master.gain.value = 0.9;
    const tone = off.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2600;
    master.connect(tone).connect(off.destination);

    const noise = noiseBuffer(off, 0.2);

    // Am7, Fmaj7, Cmaj7, G6: one chord per bar.
    const chords = [[57, 60, 64, 67], [53, 57, 60, 64], [60, 64, 67, 71], [55, 59, 62, 64]];

    chords.forEach((chord, bar) => {
      const t0 = bar * 4 * beat;
      const t1 = t0 + 4 * beat;

      // Pad: two detuned triangles per note, slow swell.
      for (const m of chord) {
        for (const detune of [-7, 7]) {
          const o = off.createOscillator();
          o.type = 'triangle';
          o.frequency.value = hz(m);
          o.detune.value = detune;
          const g = off.createGain();
          g.gain.setValueAtTime(0, t0);
          g.gain.linearRampToValueAtTime(0.05, t0 + 0.7);
          g.gain.setValueAtTime(0.05, t1 - 0.6);
          g.gain.linearRampToValueAtTime(0, t1);
          o.connect(g).connect(master);
          o.start(t0);
          o.stop(t1 + 0.05);
        }
      }

      // Bass on 1 and 3.
      for (const b of [0, 2]) {
        const t = t0 + b * beat;
        const o = off.createOscillator();
        o.type = 'sine';
        o.frequency.value = hz(chord[0] - 24);
        const g = off.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.4, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + beat * 1.9);
        o.connect(g).connect(master);
        o.start(t);
        o.stop(t + beat * 2);
      }

      for (let b = 0; b < 4; b++) {
        const t = t0 + b * beat;
        // Kick on 1 and 3, with a softer one on the "and" of 2.
        if (b === 0 || b === 2) kick(off, master, t, 1);
        if (b === 1) kick(off, master, t + beat / 2, 0.5);
        // Hats on the offbeats.
        hat(off, master, noise, t + beat / 2);
      }
    });

    return off.startRendering();
  }

  function kick(off, out, t, level) {
    const o = off.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = off.createGain();
    g.gain.setValueAtTime(0.9 * level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.4);
  }

  function hat(off, out, noise, t) {
    const s = off.createBufferSource();
    s.buffer = noise;
    const f = off.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = off.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    s.connect(f).connect(g).connect(out);
    s.start(t);
    s.stop(t + 0.08);
  }

  /* ---- Signal chain (mirrors extension/content.js) ---------------------- */

  function createImpulseResponse(context, duration, decay) {
    const length = Math.floor(context.sampleRate * duration);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = impulse.getChannelData(c);
      for (let i = 0; i < length; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  function buildChain() {
    ctx = new AudioContext();
    input = ctx.createGain();

    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf'; eqLow.frequency.value = EQ.low;
    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking'; eqMid.frequency.value = EQ.mid; eqMid.Q.value = EQ.midQ;
    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf'; eqHigh.frequency.value = EQ.high;

    const convolver = ctx.createConvolver();
    convolver.buffer = createImpulseResponse(ctx, REVERB_DURATION, REVERB_DECAY);

    dry = ctx.createGain();
    wet = ctx.createGain();
    const mixed = ctx.createGain();

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;

    input.connect(eqLow).connect(eqMid).connect(eqHigh);
    eqHigh.connect(dry).connect(mixed);
    eqHigh.connect(convolver).connect(wet).connect(mixed);
    mixed.connect(limiter).connect(ctx.destination);
  }

  function apply() {
    if (!ctx) return;
    const now = ctx.currentTime;
    const r = Number(reverb.value) / 100;
    wet.gain.setTargetAtTime(r * REVERB_WET_SCALE, now, 0.05);
    dry.gain.setTargetAtTime(1 - r * REVERB_DRY_DUCK, now, 0.05);
    if (source) source.playbackRate.setTargetAtTime(Number(speed.value), now, 0.08);
  }

  async function start() {
    if (busy) return;
    busy = true;
    play.disabled = true;
    playLabel.textContent = 'Loading';
    try {
      if (!ctx) buildChain();
      await ctx.resume();
      loop ??= await renderLoop(ctx.sampleRate);
      source = ctx.createBufferSource();
      source.buffer = loop;
      source.loop = true;
      source.playbackRate.value = Number(speed.value);
      source.connect(input);
      apply();
      source.start();
      play.setAttribute('aria-pressed', 'true');
      playLabel.textContent = 'Pause';
    } catch (error) {
      playLabel.textContent = 'Audio unavailable';
      console.warn('Demo could not start', error);
    } finally {
      play.disabled = false;
      busy = false;
    }
  }

  function stop() {
    if (source) {
      source.stop();
      source.disconnect();
      source = null;
    }
    play.setAttribute('aria-pressed', 'false');
    playLabel.textContent = 'Play the loop';
  }

  play.addEventListener('click', () => (source ? stop() : start()));
  speed.addEventListener('input', () => { readout(); apply(); });
  reverb.addEventListener('input', () => { readout(); apply(); });
  new ResizeObserver(drawRuler).observe(ruler);

  readout();
  drawRuler();
}());
