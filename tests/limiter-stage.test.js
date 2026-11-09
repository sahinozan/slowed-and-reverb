'use strict';

// The limiter stage: the block between the "Limiter stage" comments in
// extension/youtube-main.js, extension/spotify-main.js and
// site/demo-audio.js. It is the limiter with, in Firefox, a filter each side
// of it that cancels the filters Firefox's compressor still has. These tests
// run the block with a stand-in for the browser; what it does to sound is
// checked in real browsers by e2e/ui/limiter.spec.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { FakeAudioContext, FakeAudioNode, createContentHarness } = require('./helpers/content-harness');
const { LIMITER_STAGE_FILES, limiterStage, loadLimiterStage } = require('../e2e/limiter-stage');
const { root } = require('./helpers/load-script');

const FIREFOX = 'Mozilla/5.0 (Macintosh; rv:159.0) Gecko/20100101 Firefox/159.0';
const CHROMIUM = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

// Stands for OfflineAudioContext: what it renders is the tone it was given,
// at `gain` times its level. `problem` makes it fail where a browser could.
function offlineContext({ gain = 1, problem = null } = {}) {
  const made = [];
  class FakeOfflineAudioContext {
    constructor(channels, frames, sampleRate) {
      if (problem === 'constructor') throw new Error('no offline rendering');
      Object.assign(this, { channels, frames, sampleRate, compressors: [], destination: new FakeAudioNode('destination') });
      made.push(this);
    }

    createBuffer(channels, length) {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }

    createBufferSource() {
      this.source = new FakeAudioNode('buffer-source');
      this.source.start = () => {};
      return this.source;
    }

    createDynamicsCompressor() {
      const node = new FakeAudioNode('compressor');
      this.compressors.push(node);
      return node;
    }

    async startRendering() {
      if (problem === 'rendering') throw new Error('rendering failed');
      const tone = this.source.buffer.getChannelData(0);
      this.tone = Float32Array.from(tone);
      const rendered = tone.map((sample) => sample * gain);
      return { getChannelData: () => rendered };
    }
  }
  return { FakeOfflineAudioContext, made };
}

const stageOf = (file) => limiterStage(fs.readFileSync(path.join(root, file), 'utf8'), file);
const settingsOf = (node) => ['threshold', 'knee', 'ratio', 'attack', 'release'].map((key) => node[key].value);
const targets = (node) => node.connections.map(({ target }) => target);

// A filter's response at one frequency, as [real, imaginary].
function response({ feedforward, feedback }, frequency, sampleRate) {
  const turn = (-2 * Math.PI * frequency) / sampleRate;
  const sum = (list) =>
    list.reduce(([re, im], value, index) => [re + value * Math.cos(turn * index), im + value * Math.sin(turn * index)], [0, 0]);
  const [nr, ni] = sum(feedforward);
  const [dr, di] = sum(feedback);
  const size = dr * dr + di * di;
  return [(nr * dr + ni * di) / size, (ni * dr - nr * di) / size];
}

const decibels = ([re, im]) => 20 * Math.log10(Math.hypot(re, im));

describe('limiter stage', () => {
  test('is the same text in both engines and the website demo', () => {
    const [first, ...others] = LIMITER_STAGE_FILES.map(stageOf);
    for (const [index, stage] of others.entries()) {
      assert.equal(stage, first, `${LIMITER_STAGE_FILES[index + 1]} differs from ${LIMITER_STAGE_FILES[0]}`);
    }
  });

  test('is the only place a compressor or its filters are made', () => {
    for (const file of LIMITER_STAGE_FILES) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      const rest = source.replace(stageOf(file), '');
      assert.ok(!/createDynamicsCompressor|createIIRFilter/.test(rest), `${file} makes one outside its limiter stage`);
      assert.equal(source.split('connectLimiter(').length - 1, 2, `${file} connects the limiter once`);
    }
  });

  test('leaves the limiter as it was outside Firefox, and checks nothing', async () => {
    const { FakeOfflineAudioContext, made } = offlineContext();
    const stage = loadLimiterStage(stageOf(LIMITER_STAGE_FILES[0]), { userAgent: CHROMIUM, OfflineAudioContext: FakeOfflineAudioContext });
    await stage.limiterFilters.known;
    assert.equal(stage.limiterFilters.present, false);
    assert.equal(made.length, 0);

    const context = new FakeAudioContext();
    const input = new FakeAudioNode('gain', context);
    const output = stage.connectLimiter(context, input);

    assert.equal(output, context.compressors[0]);
    assert.deepEqual(targets(input), [output]);
    assert.deepEqual(settingsOf(output), [-3, 3, 20, 0.003, 0.25]);
    assert.equal(context.iirFilters.length, 0);
  });

  test('in Firefox, puts the cut before the limiter and the boost after it', async () => {
    // Firefox 159 turned the check's tone down by 6.25 dB.
    const { FakeOfflineAudioContext, made } = offlineContext({ gain: 10 ** (-6.25 / 20) });
    const stage = loadLimiterStage(stageOf(LIMITER_STAGE_FILES[0]), { userAgent: FIREFOX, OfflineAudioContext: FakeOfflineAudioContext });
    assert.equal(stage.limiterFilters.present, true, 'taken to have the filters until the check answers');
    await stage.limiterFilters.known;
    assert.equal(stage.limiterFilters.present, true);

    // The check: half a second of a 12 kHz tone at half scale, through a
    // compressor with the limiter's settings.
    assert.equal(made.length, 1);
    const [check] = made;
    assert.deepEqual([check.channels, check.frames, check.sampleRate], [1, 24000, 48000]);
    assert.deepEqual([...check.tone.slice(0, 8)], [0, 0.5, 0, -0.5, 0, 0.5, 0, -0.5]);
    assert.deepEqual(settingsOf(check.compressors[0]), [-3, 3, 20, 0.003, 0.25]);
    assert.deepEqual(targets(check.source), [check.compressors[0]]);
    assert.deepEqual(targets(check.compressors[0]), [check.destination]);

    const context = new FakeAudioContext();
    context.sampleRate = 48000;
    const input = new FakeAudioNode('gain', context);
    const output = stage.connectLimiter(context, input);
    const [cut, boost] = context.iirFilters;
    const [limiter] = context.compressors;

    assert.deepEqual(targets(input), [cut]);
    assert.deepEqual(targets(cut), [limiter]);
    assert.deepEqual(targets(limiter), [boost]);
    assert.equal(output, boost);
    assert.deepEqual(settingsOf(limiter), [-3, 3, 20, 0.003, 0.25]);
    assert.deepEqual([cut.feedforward, cut.feedback], Object.values(stage.limiterFilter(48000, false)));
    assert.deepEqual([boost.feedforward, boost.feedback], Object.values(stage.limiterFilter(48000, true)));
  });

  test('in a Firefox whose compressor leaves treble alone, leaves the limiter as it was', async () => {
    // A compressor that follows the standard: the tone comes out 1.2 dB louder.
    const { FakeOfflineAudioContext } = offlineContext({ gain: 10 ** (1.2 / 20) });
    const stage = loadLimiterStage(stageOf(LIMITER_STAGE_FILES[0]), { userAgent: FIREFOX, OfflineAudioContext: FakeOfflineAudioContext });
    await stage.limiterFilters.known;
    assert.equal(stage.limiterFilters.present, false);

    const context = new FakeAudioContext();
    const input = new FakeAudioNode('gain', context);
    assert.equal(stage.connectLimiter(context, input), context.compressors[0]);
    assert.equal(context.iirFilters.length, 0);
  });

  test('keeps taking Firefox to have the filters when the check cannot run', async () => {
    const cases = [
      ['no offline rendering at all', undefined],
      ['a context that cannot be made', offlineContext({ problem: 'constructor' }).FakeOfflineAudioContext],
      ['a rendering that fails', offlineContext({ problem: 'rendering' }).FakeOfflineAudioContext]
    ];
    for (const [name, OfflineAudioContext] of cases) {
      const stage = loadLimiterStage(stageOf(LIMITER_STAGE_FILES[0]), { userAgent: FIREFOX, OfflineAudioContext });
      await stage.limiterFilters.known;
      assert.equal(stage.limiterFilters.present, true, name);
    }
  });

  test('the cut undoes the boost exactly, and both leave the bass alone', () => {
    for (const sampleRate of [24000, 44100, 48000, 96000]) {
      const stage = loadLimiterStage(stageOf(LIMITER_STAGE_FILES[0]), { userAgent: CHROMIUM });
      const boost = stage.limiterFilter(sampleRate, true);
      const cut = stage.limiterFilter(sampleRate, false);
      assert.equal(boost.feedforward.length, 5);
      assert.equal(boost.feedback.length, 5);
      assert.equal(boost.feedback[0], 1);
      assert.equal(cut.feedback[0], 1);
      for (const frequency of [0, 100, 1000, 4000, 10000, sampleRate / 2 - 1]) {
        const [br, bi] = response(boost, frequency, sampleRate);
        const [cr, ci] = response(cut, frequency, sampleRate);
        const together = Math.hypot(br * cr - bi * ci - 1, br * ci + bi * cr);
        assert.ok(together < 1e-12, `${sampleRate} Hz, ${frequency} Hz: boost then cut is off by ${together}`);
      }
      assert.ok(Math.abs(decibels(response(boost, 0, sampleRate))) < 1e-9, `${sampleRate} Hz: 0 Hz is left alone`);
    }
  });

  // Firefox's own numbers (setEmphasisStageParameters): stages of 4.4 dB an
  // octave apart, the highest at 15 kHz. The real browser decides whether
  // they are right (e2e/ui/limiter.spec.js); this notices a change to them.
  test("the boost is Firefox's", () => {
    const stage = loadLimiterStage(stageOf(LIMITER_STAGE_FILES[0]), { userAgent: CHROMIUM });
    const expected = {
      44100: { 1000: 1.365, 4000: 7.058, 10000: 11.845, 15000: 13.454 },
      48000: { 1000: 1.366, 4000: 7.065, 10000: 11.893, 15000: 13.572 }
    };
    for (const [sampleRate, levels] of Object.entries(expected)) {
      const boost = stage.limiterFilter(Number(sampleRate), true);
      for (const [frequency, level] of Object.entries(levels)) {
        const actual = decibels(response(boost, Number(frequency), Number(sampleRate)));
        assert.ok(Math.abs(actual - level) < 0.001, `${sampleRate} Hz, ${frequency} Hz: ${actual.toFixed(4)} dB, expected ${level}`);
      }
    }
  });

  test("YouTube's engine routes the effect through it", async (t) => {
    for (const [userAgent, filters] of [[undefined, 0], [FIREFOX, 2]]) {
      const harness = await createContentHarness({ userAgent });
      t.after(() => harness.dom.window.close());
      await harness.dispatch({ type: 'UPDATE_AUDIO', settings: { speed: 0.8, reverb: 40 }, enabled: true });
      const context = harness.getContext();
      const [limiter] = context.compressors;
      const [cut, boost] = context.iirFilters;
      const processed = context.gains.filter((node) => targets(node).includes(context.destination))[1];

      assert.equal(context.compressors.length, 1);
      assert.equal(context.iirFilters.length, filters);
      assert.deepEqual(targets(context.panners[0]), [filters ? cut : limiter]);
      if (filters) {
        assert.deepEqual(targets(cut), [limiter]);
        assert.deepEqual(targets(limiter), [boost]);
        assert.deepEqual(targets(boost), [processed]);
      } else {
        assert.deepEqual(targets(limiter), [processed]);
      }
    }
  });
});
