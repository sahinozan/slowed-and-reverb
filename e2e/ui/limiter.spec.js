'use strict';

// What the limiter does to sound, in Chromium and in Firefox's engine, with
// nothing played: every sound here is rendered offline, so the test needs no
// sound device and makes no sound.
//
// Firefox's compressor still boosts the treble before it decides how far to
// turn the sound down, so the engines' limiter turned loud, bright music
// down in Firefox and not in Chromium: a steady 10 kHz tone under the
// threshold came out 4.7 dB quieter, and each hi-hat pulled the bass down
// with it. The limiter stage (the block between the "Limiter stage" comments
// in both engines and the website's demo) cancels those filters where the
// compressor has them. The audio suite can't hear this: its song is two
// quiet low tones.
//
// Each test takes the stage from one file as it is written there and
// checks, at both common sample rates:
// - the stage leaves alone what is under the limiter's threshold, whatever
//   its pitch: tones from 100 Hz to 18 kHz, white noise, and a bass note
//   while bursts of treble play. The numbers are fixed, so the two browsers
//   have to agree;
// - the same checks hear the defect when it is put back. In a browser whose
//   compressor has the filters, that is the compressor on its own; in one
//   without, the compressor with Firefox's filters put around it, which
//   then has to do what Firefox 159 was measured to do;
// - the stage's own check of the browser found what this test finds, and a
//   compressor without the filters is left exactly as it was.
//
// A second test for each file connects a limiter before the stage's check
// of the browser has answered, as an engine can in its first milliseconds.
// It is given the filters then, and if the answer is no they have to come
// out again, or peaks would get past the limiter and clip.
//
// A third is for the equalizer. A loud song is already close to the
// limiter's threshold, so a band turned up crossed it, and the limiter
// turned the whole song down at each loud note of that band: with Bass up,
// the music went muffled at every kick drum. The stage turns the sound down
// by three quarters of the largest boost before the limiter
// (limiterHeadroom), which is about what a boost adds to a song's peaks.
// The test plays a kick drum just under full scale with a quiet steady tone
// over it, through the equalizer and the stage, and checks that with Bass
// turned up the kick takes the tone down by about 1 dB at most, where it
// takes 0.5 dB with the equalizer flat; that it takes it down by 4 to 9 dB
// without the turn-down; and that no setting of the equalizer brings any
// pitch nearer the limiter than the quarter of the largest boost the
// turn-down leaves. The audio suite can't hear this either: its tones stay
// far under the threshold.

const fs = require('node:fs');
const path = require('node:path');
const { expect, test } = require('@playwright/test');

const { LIMITER_STAGE_FILES, limiterStage, limiterStageBody } = require('../limiter-stage');

const root = path.join(__dirname, '..', '..');

// The compressor's make-up gain with the limiter's settings: what it adds to
// any sound it doesn't turn down.
const MAKE_UP_DB = 1.2;
// How far a level may be from where it should be. Both browsers measured
// within 0.01 dB.
const TOLERANCE_DB = 0.05;
// What Firefox 159.0.1's compressor did with the limiter's settings to this
// test's own sounds, at each sample rate: the 10 kHz tone, the white noise,
// and how far a burst of treble turned the bass down.
const FIREFOX_159 = {
  44100: { toneDb: -3.41, noiseDb: -7.88, bassDropDb: 1.37 },
  48000: { toneDb: -3.47, noiseDb: -8.29, bassDropDb: 2.03 }
};

// The engines' equalizer: a low shelf, a peak and a high shelf.
const EQUALIZER = [
  { type: 'lowshelf', frequency: 200 },
  { type: 'peaking', frequency: 1000, q: 1 },
  { type: 'highshelf', frequency: 4000 }
];
// Bass settings the kick drum is played at, in dB. The first is the
// equalizer flat, which the others are compared with.
const BASS_BOOSTS = [0, 3, 6, 8, 12];
// What each of the equalizer's three settings is given, in every
// combination, to find the loudest any pitch gets.
const EQUALIZER_STEPS = [-12, -5, 0, 0.5, 6, 12];

// Runs in the page. Renders each test sound through the stage, through the
// compressor on its own, and through the compressor with Firefox's filters
// put around it, and returns how each changed the sound's level.
async function measureLimiter({ body, sampleRate }) {
  const stage = new Function('window', body)(window);
  await stage.limiterFilters.known;

  const seconds = 2;
  const frames = seconds * sampleRate;
  const amplitude = (level) => 10 ** (level / 20);
  const decibels = (ratio) => Math.round(2000 * Math.log10(ratio)) / 100;
  const power = (samples, from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    return sum / (to - from);
  };

  // A small seeded generator, so both browsers get the same noise.
  function random(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function tone(frequency, level) {
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) samples[i] = amplitude(level) * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    return samples;
  }

  function whiteNoise(level) {
    const next = random(99);
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) samples[i] = (next() * 2 - 1) * amplitude(level);
    return samples;
  }

  // A steady 80 Hz bass note peaking at -8 dB, with a short burst of treble
  // (noise above about 6 kHz, like a hi-hat, peaking near -14 dB) every half
  // second from 0.5 s on. Neither reaches the limiter's threshold.
  function bassAndBursts() {
    const next = random(31337);
    const samples = new Float32Array(frames);
    let previous = 0;
    let difference = 0;
    for (let i = 0; i < frames; i++) {
      const sinceBurst = (i % (sampleRate / 2)) / sampleRate;
      const noise = next() * 2 - 1;
      // The difference of a difference: a steep high-pass.
      const first = noise - previous;
      const steep = first - difference;
      previous = noise;
      difference = first;
      const burst = i >= sampleRate / 2 && sinceBurst < 0.08 ? Math.exp(-sinceBurst / 0.02) : 0;
      samples[i] = amplitude(-8) * Math.sin((2 * Math.PI * 80 * i) / sampleRate) + amplitude(-14) * 0.25 * steep * burst;
    }
    return samples;
  }

  // The level of the 80 Hz note in a stretch of samples.
  function bassLevel(samples, from, to) {
    let re = 0;
    let im = 0;
    for (let i = from; i < to; i++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (to - from));
      re += samples[i] * window * Math.cos((2 * Math.PI * 80 * i) / sampleRate);
      im += samples[i] * window * Math.sin((2 * Math.PI * 80 * i) / sampleRate);
    }
    return (4 * Math.hypot(re, im)) / (to - from);
  }

  async function render(samples, graph) {
    const context = new OfflineAudioContext(2, frames, sampleRate);
    const buffer = context.createBuffer(2, frames, sampleRate);
    buffer.copyToChannel(samples, 0);
    buffer.copyToChannel(samples, 1);
    const source = context.createBufferSource();
    source.buffer = buffer;
    graph(context, source).connect(context.destination);
    source.start();
    return (await context.startRendering()).getChannelData(0);
  }

  const filter = (context, boost) => {
    const { feedforward, feedback } = stage.limiterFilter(sampleRate, boost);
    return context.createIIRFilter(feedforward, feedback);
  };
  const graphs = {
    stage: (context, source) => stage.connectLimiter(context, source),
    compressorAlone: (context, source) => source.connect(stage.createLimiter(context)),
    compressorWithFirefoxFilters: (context, source) =>
      source.connect(filter(context, true)).connect(stage.createLimiter(context)).connect(filter(context, false))
  };

  // The second half, once the compressor's opening dip has passed.
  const steadyGain = (out, input) => decibels(Math.sqrt(power(out, frames / 2, frames) / power(input, frames / 2, frames)));
  const frequencies = [100, 997, 4000, 6000, 10000, 15000, 18000];
  const results = {};
  for (const [name, graph] of Object.entries(graphs)) {
    const tones = [];
    for (const hz of frequencies) {
      const input = tone(hz, -9);
      tones.push({ hz, gainDb: steadyGain(await render(input, graph), input) });
    }
    const noise = whiteNoise(-6);
    const noiseGainDb = steadyGain(await render(noise, graph), noise);

    // The bass note's level every 25 ms around the bursts at 1.0 and 1.5 s,
    // from 50 ms before each: its lowest against its level before the burst.
    const mixed = await render(bassAndBursts(), graph);
    const block = Math.round(sampleRate / 40);
    let before = 0;
    let lowest = Infinity;
    for (const burstAt of [sampleRate, 1.5 * sampleRate]) {
      before += bassLevel(mixed, burstAt - 2 * block, burstAt - block) / 2;
      for (let offset = -1; offset < 12; offset++) {
        lowest = Math.min(lowest, bassLevel(mixed, burstAt + offset * block, burstAt + (offset + 1) * block));
      }
    }
    results[name] = { tones, noiseGainDb, bassDropDb: decibels(before / lowest) };
  }

  const probe = new OfflineAudioContext(2, 128, sampleRate);
  return {
    ...results,
    stageFoundFilters: stage.limiterFilters.present,
    stageIsTheCompressorAlone: stage.connectLimiter(probe, probe.createGain()) instanceof DynamicsCompressorNode
  };
}

// Runs in the page. Connects one limiter straight away, before the stage's
// check of the browser can have answered, and one after the answer, and
// renders a full-scale 10 kHz tone (well over the threshold) through each.
// `claimsFirefox` gives the stage a window that says it is Firefox, so a
// browser without the filters is asked too, and answers no.
async function measureEarlyLimiter({ body, claimsFirefox }) {
  const page = claimsFirefox
    ? { navigator: { userAgent: 'Mozilla/5.0 (Macintosh; rv:159.0) Gecko/20100101 Firefox/159.0' }, OfflineAudioContext }
    : window;
  const stage = new Function('window', body)(page);

  const sampleRate = 48000;
  const frames = sampleRate;
  const tone = new Float32Array(frames);
  for (let i = 0; i < frames; i++) tone[i] = Math.sin((2 * Math.PI * 10000 * i) / sampleRate);
  const connect = () => {
    const context = new OfflineAudioContext(2, frames, sampleRate);
    const buffer = context.createBuffer(2, frames, sampleRate);
    buffer.copyToChannel(tone, 0);
    buffer.copyToChannel(tone, 1);
    const source = context.createBufferSource();
    source.buffer = buffer;
    stage.connectLimiter(context, source).connect(context.destination);
    source.start();
    return context;
  };

  const early = connect();
  const waitedForAnswer = stage.limiterFilters.undo !== null;
  await stage.limiterFilters.known;
  const late = connect();

  const earlySound = (await early.startRendering()).getChannelData(0);
  const lateSound = (await late.startRendering()).getChannelData(0);
  let largestDifference = 0;
  let earlyPeak = 0;
  let latePeak = 0;
  for (let i = 0; i < frames; i++) {
    largestDifference = Math.max(largestDifference, Math.abs(earlySound[i] - lateSound[i]));
    earlyPeak = Math.max(earlyPeak, Math.abs(earlySound[i]));
    latePeak = Math.max(latePeak, Math.abs(lateSound[i]));
  }
  return { waitedForAnswer, filtersFound: stage.limiterFilters.present, largestDifference, earlyPeak, latePeak };
}

// Runs in the page. Plays a loud kick drum under a quiet steady tone through
// the equalizer and the stage, at each Bass setting, with the stage's
// turn-down and without it, and returns how far the kicks took the tone
// down. Also returns the loudest any pitch reaches the limiter over every
// combination of the equalizer's settings, against how it came and less the
// part of the largest boost the turn-down leaves.
async function measureEqualizerBoost({ body, sampleRate, equalizer, boosts, steps }) {
  const stage = new Function('window', body)(window);
  await stage.limiterFilters.known;

  const seconds = 2;
  const frames = seconds * sampleRate;
  const decibels = (ratio) => Math.round(2000 * Math.log10(ratio)) / 100;
  const TONE_HZ = 3000;
  const TONE_LEVEL = 0.03;
  const MAKE_UP = 10 ** (1.2 / 20);

  // A kick drum twice a second, from 0 s: a sine falling from 150 to 45 Hz
  // that peaks at 0.85 of full scale and dies away in a quarter of a second.
  // With the tone, the sound peaks at -1.1 dB, like a finished song.
  const samples = new Float32Array(frames);
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const sinceKick = (i % (sampleRate / 2)) / sampleRate;
    if (sinceKick === 0) phase = 0;
    phase += (2 * Math.PI * (45 + 105 * Math.exp(-sinceKick / 0.03))) / sampleRate;
    const kick = 0.85 * Math.sin(phase) * Math.exp(-sinceKick / 0.12) * Math.min(1, sinceKick / 0.002);
    samples[i] = kick + TONE_LEVEL * Math.sin((2 * Math.PI * TONE_HZ * i) / sampleRate);
  }

  function filters(context, settings) {
    return equalizer.map(({ type, frequency, q }, index) => {
      const node = context.createBiquadFilter();
      node.type = type;
      node.frequency.value = frequency;
      if (q !== undefined) node.Q.value = q;
      node.gain.value = settings[index];
      return node;
    });
  }

  // What the equalizer does to the level of each of `pitches`.
  function response(context, settings, pitches) {
    const total = new Float32Array(pitches.length).fill(1);
    for (const node of filters(context, settings)) {
      const magnitude = new Float32Array(pitches.length);
      node.getFrequencyResponse(pitches, magnitude, new Float32Array(pitches.length));
      for (let i = 0; i < pitches.length; i++) total[i] *= magnitude[i];
    }
    return total;
  }

  // The level of the tone in a stretch of samples.
  function toneLevel(sound, from, to) {
    let re = 0;
    let im = 0;
    for (let i = from; i < to; i++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (to - from));
      re += sound[i] * window * Math.cos((2 * Math.PI * TONE_HZ * i) / sampleRate);
      im += sound[i] * window * Math.sin((2 * Math.PI * TONE_HZ * i) / sampleRate);
    }
    return (4 * Math.hypot(re, im)) / (to - from);
  }

  // How far the kicks at 1.0 and 1.5 s take the tone down: its lowest level
  // in any 25 ms from 1 s on, against the level it has when the limiter
  // leaves it alone.
  async function toneDrop(bass, headroom) {
    const settings = [bass, 0, 0];
    const context = new OfflineAudioContext(2, frames, sampleRate);
    const buffer = context.createBuffer(2, frames, sampleRate);
    buffer.copyToChannel(samples, 0);
    buffer.copyToChannel(samples, 1);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const mixed = context.createGain();
    mixed.gain.value = headroom;
    filters(context, settings).reduce((from, node) => from.connect(node), source).connect(mixed);
    stage.connectLimiter(context, mixed).connect(context.destination);
    source.start();
    const sound = (await context.startRendering()).getChannelData(0);

    const [atTone] = response(context, settings, new Float32Array([TONE_HZ]));
    const untouched = TONE_LEVEL * atTone * headroom * MAKE_UP;
    const block = Math.round(sampleRate / 40);
    let lowest = Infinity;
    for (let from = sampleRate; from + block <= frames; from += block) {
      lowest = Math.min(lowest, toneLevel(sound, from, from + block));
    }
    return decibels(untouched / lowest);
  }

  const kicks = [];
  for (const bass of boosts) {
    kicks.push({
      bass,
      toneDropDb: await toneDrop(bass, stage.limiterHeadroom({ eqLow: bass, eqMid: 0, eqHigh: 0 })),
      toneDropWithoutTurnDownDb: await toneDrop(bass, 1)
    });
  }

  // 20 Hz to 20 kHz, 24 pitches to the octave.
  const pitches = Float32Array.from({ length: 240 }, (_, i) => 20 * 2 ** (i / 24)).filter((hz) => hz < sampleRate / 2);
  const probe = new OfflineAudioContext(2, 128, sampleRate);
  let loudest = { db: -Infinity };
  for (const eqLow of steps) {
    for (const eqMid of steps) {
      for (const eqHigh of steps) {
        const headroom = stage.limiterHeadroom({ eqLow, eqMid, eqHigh });
        // The part of the largest boost the turn-down leaves.
        const left = (1 - stage.EQUALIZER_TURN_DOWN) * Math.max(0, eqLow, eqMid, eqHigh);
        const levels = response(probe, [eqLow, eqMid, eqHigh], pitches);
        for (let i = 0; i < pitches.length; i++) {
          const db = Math.round(100 * (20 * Math.log10(levels[i] * headroom) - left)) / 100;
          if (db > loudest.db) loudest = { db, hz: Math.round(pitches[i]), settings: [eqLow, eqMid, eqHigh] };
        }
      }
    }
  }
  return { kicks, loudest };
}

const toneAt = (measured, hz) => measured.tones.find((tone) => tone.hz === hz).gainDb;

for (const file of LIMITER_STAGE_FILES) {
  test(`the limiter in ${file} leaves treble under its threshold alone`, async ({ page }, testInfo) => {
    const body = limiterStageBody(limiterStage(fs.readFileSync(path.join(root, file), 'utf8'), file));
    await page.goto('about:blank');

    for (const sampleRate of [44100, 48000]) {
      const measured = await page.evaluate(measureLimiter, { body, sampleRate });
      await testInfo.attach(`limiter-${sampleRate}.json`, { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
      const at = `at ${sampleRate} Hz`;

      // The stage: nothing under the threshold is turned down.
      for (const { hz, gainDb } of measured.stage.tones) {
        expect(Math.abs(gainDb - MAKE_UP_DB), `a ${hz} Hz tone ${at} came out at ${gainDb} dB`).toBeLessThan(TOLERANCE_DB);
      }
      expect(Math.abs(measured.stage.noiseGainDb - MAKE_UP_DB), `white noise ${at} came out at ${measured.stage.noiseGainDb} dB`).toBeLessThan(TOLERANCE_DB);
      expect(measured.stage.bassDropDb, `a burst of treble ${at} turned the bass down`).toBeLessThan(TOLERANCE_DB);

      // The defect put back: these checks have to hear it.
      const browserHasFilters = toneAt(measured.compressorAlone, 10000) < 0;
      const defect = browserHasFilters ? measured.compressorAlone : measured.compressorWithFirefoxFilters;
      expect(toneAt(defect, 100), `the defect ${at} leaves bass alone`).toBeCloseTo(MAKE_UP_DB, 1);
      expect(toneAt(defect, 10000), `the defect ${at} turns a 10 kHz tone down`).toBeLessThan(MAKE_UP_DB - 3);
      expect(defect.noiseGainDb, `the defect ${at} turns white noise down`).toBeLessThan(MAKE_UP_DB - 5);
      expect(defect.bassDropDb, `the defect ${at} lets a burst of treble turn the bass down`).toBeGreaterThan(1);

      // The stage's check of the browser found what this test found, and a
      // compressor without the filters is left as it was.
      expect(measured.stageFoundFilters, `the stage's check ${at}`).toBe(browserHasFilters);
      expect(measured.stageIsTheCompressorAlone, `the stage ${at} is the compressor alone`).toBe(!browserHasFilters);
      // Chromium's compressor has had no such filters since 2014, so there
      // the stage adds nothing.
      if (testInfo.project.name === 'chromium') expect(browserHasFilters, `Chromium's compressor ${at} has the filters`).toBe(false);

      if (browserHasFilters) continue;
      // Without the filters the compressor already leaves treble alone, and
      // with Firefox's filters around it, it does what Firefox 159 did. So
      // the filters the stage cancels are Firefox's.
      expect(Math.abs(toneAt(measured.compressorAlone, 10000) - MAKE_UP_DB), `the compressor alone ${at}`).toBeLessThan(TOLERANCE_DB);
      expect(Math.abs(toneAt(defect, 10000) - FIREFOX_159[sampleRate].toneDb), `a 10 kHz tone ${at} came out at ${toneAt(defect, 10000)} dB`).toBeLessThan(0.1);
      expect(Math.abs(defect.noiseGainDb - FIREFOX_159[sampleRate].noiseDb), `white noise ${at} came out at ${defect.noiseGainDb} dB`).toBeLessThan(0.1);
      expect(Math.abs(defect.bassDropDb - FIREFOX_159[sampleRate].bassDropDb), `the bass ${at} dropped by ${defect.bassDropDb} dB`).toBeLessThan(0.1);
    }
  });

  test(`a limiter in ${file} connected before the browser has answered limits as one connected after`, async ({ page }, testInfo) => {
    const body = limiterStageBody(limiterStage(fs.readFileSync(path.join(root, file), 'utf8'), file));
    await page.goto('about:blank');

    // Firefox is asked as it is. Chromium is asked only when the page says
    // it is Firefox, and then it answers that it has no filters.
    const measured = await page.evaluate(measureEarlyLimiter, { body, claimsFirefox: testInfo.project.name !== 'firefox' });
    await testInfo.attach('early-limiter.json', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });

    expect(measured.waitedForAnswer, 'the first limiter was connected before the answer').toBe(true);
    if (testInfo.project.name === 'chromium') expect(measured.filtersFound, "Chromium's compressor has the filters").toBe(false);
    // The same sound from both, to a rounding error: with the filters left
    // around a compressor that has none, this tone peaked at 1.148 and not
    // at 0.916.
    expect(measured.largestDifference, `peaks of ${measured.earlyPeak} and ${measured.latePeak}`).toBeLessThan(1e-6);
    expect(measured.latePeak, 'the tone is limited').toBeLessThan(1);
  });

  test(`an equalizer boost doesn't set off the limiter in ${file}`, async ({ page }, testInfo) => {
    const body = limiterStageBody(limiterStage(fs.readFileSync(path.join(root, file), 'utf8'), file));
    await page.goto('about:blank');

    for (const sampleRate of [44100, 48000]) {
      const measured = await page.evaluate(measureEqualizerBoost, {
        body, sampleRate, equalizer: EQUALIZER, boosts: BASS_BOOSTS, steps: EQUALIZER_STEPS
      });
      await testInfo.attach(`equalizer-${sampleRate}.json`, { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
      const at = `at ${sampleRate} Hz`;
      const [flat, ...boosted] = measured.kicks;

      // The song's own kicks reach the limiter a little, with the equalizer
      // flat too (0.5 dB). Bass turned up adds little to that: both
      // browsers measured 0.5, 0.6, 0.7 and 1.1 dB.
      expect(flat.toneDropDb, `with the equalizer flat ${at}, the kick took the tone down`).toBeLessThan(0.6);
      for (const { bass, toneDropDb } of boosted) {
        expect(toneDropDb, `with Bass at +${bass} dB ${at}, the kick took the tone down by ${toneDropDb} dB, and by ${flat.toneDropDb} dB flat`)
          .toBeLessThan(bass > 8 ? 1.25 : 0.9);
      }

      // The defect put back: without the turn-down, the more Bass, the
      // further each kick takes the tone down.
      const without = Object.fromEntries(measured.kicks.map((kick) => [kick.bass, kick.toneDropWithoutTurnDownDb]));
      expect(Math.abs(without[0] - flat.toneDropDb), `the turn-down ${at} changes nothing with the equalizer flat`).toBeLessThan(TOLERANCE_DB);
      // Both browsers measured 2.4, 4.4, 6.0 and 9.3 dB.
      expect(without[3], `the defect ${at} with Bass at +3 dB`).toBeGreaterThan(2);
      expect(without[6], `the defect ${at} with Bass at +6 dB`).toBeGreaterThan(4);
      expect(without[8], `the defect ${at} with Bass at +8 dB`).toBeGreaterThan(5.5);
      expect(without[12], `the defect ${at} with Bass at +12 dB`).toBeGreaterThan(8.5);

      // Whatever the equalizer is set to, no pitch reaches the limiter
      // louder than it came by more than the quarter of the largest boost
      // the turn-down leaves, but for 0.07 dB where three full boosts meet.
      const { db, hz, settings } = measured.loudest;
      expect(db, `${hz} Hz ${at} with the equalizer at ${settings.join('/')} dB`).toBeLessThan(0.1);
    }
  });
}
