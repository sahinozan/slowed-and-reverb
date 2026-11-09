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
}
