'use strict';

// Checks the audio regression suite's continuity measurements
// (e2e/audio-capture/metrics.js) against computed signals: that planted
// clicks, dropouts and gaps are found, that the engines' own fades and
// steady tones are not, and that a late message is kept apart from missing
// frames. Also checks that each historical defect the suite puts back
// (e2e/audio-capture/history.js) still matches today's code exactly once,
// and how the recorder counts frame numbers. No browser or sound device is
// involved.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const vm = require('node:vm');

const { HISTORY } = require('../e2e/audio-capture/history');
const { CLICK_THRESHOLD, analyzeSpan, findClicks, silentRuns, spanHealth } = require('../e2e/audio-capture/metrics');
const { root } = require('./helpers/load-script');

const RATE = 48_000;

function sine(hz, amplitude, seconds = 1, rate = RATE, phase = 0) {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate + phase);
  return samples;
}

function sum(...signals) {
  const out = new Float32Array(signals[0].length);
  for (const signal of signals) for (let i = 0; i < out.length; i++) out[i] += signal[i];
  return out;
}

// Multiplies `samples` by a gain that moves in straight lines through
// `points` ([seconds, gain], ...), as the engines' fades do.
function withGain(samples, points, rate = RATE) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const time = i / rate;
    let gain = points[points.length - 1][1];
    for (let p = 1; p < points.length; p++) {
      const [t0, g0] = points[p - 1];
      const [t1, g1] = points[p];
      if (time < t1) {
        gain = time < t0 ? g0 : g0 + ((g1 - g0) * (time - t0)) / (t1 - t0);
        break;
      }
    }
    out[i] = samples[i] * gain;
  }
  return out;
}

const silence = (seconds = 1) => new Float32Array(Math.round(seconds * RATE));

describe('audio regression clicks and gaps', () => {
  test('steady tones and the fades the engines make are not clicks', () => {
    // The loudest steady signal the suite records: two tones summed on one
    // channel through the compressor, at both sample rates in use.
    for (const rate of [44_100, 48_000]) {
      const loud = sum(sine(528, 0.29, 1, rate), sine(990, 0.29, 1, rate));
      assert.deepEqual(findClicks(loud, loud, rate), [], `${rate} Hz`);
    }
    // A 10 ms fade out from 20 ms ahead, 90 ms of silence and a 25 ms fade
    // back in: a change of the player hidden as the engines hide it.
    const dipped = withGain(sine(352, 0.29), [[0.3, 1], [0.31, 0], [0.4, 0], [0.425, 1]]);
    assert.deepEqual(findClicks(dipped, dipped, RATE), []);
    // A 25 ms crossfade between two different paths.
    const crossfade = sum(
      withGain(sine(440, 0.25), [[0.5, 1], [0.525, 0]]),
      withGain(sine(352, 0.29), [[0.5, 0], [0.525, 1]])
    );
    assert.deepEqual(findClicks(crossfade, silence(), RATE), []);
  });

  test('finds a step, a gain set straight away and a two-sample dropout', () => {
    const tone = sine(352, 0.29);
    const step = tone.slice();
    for (let i = 24_000; i < step.length; i++) step[i] += 0.03;
    const stepped = findClicks(step, silence(), RATE);
    assert.equal(stepped.length, 1, JSON.stringify(stepped));
    assert.ok(stepped[0].frame >= 24_000 && stepped[0].frame <= 24_003, JSON.stringify(stepped));

    // A gain that jumps from 1 to 0.5 instead of fading, at a peak of the wave.
    const peak = Math.round(RATE / 352 / 4) + 24_000;
    const jump = withGain(tone, [[peak / RATE, 1], [peak / RATE + 1e-9, 0.5]]);
    const found = findClicks(jump, silence(), RATE);
    assert.equal(found.length, 1);
    assert.ok(Math.abs(found[0].frame - peak) <= 3, JSON.stringify(found));
    assert.ok(found[0].peak > 0.2, JSON.stringify(found));

    // As recorded in Firefox: both channels fall to 30% for two samples,
    // here near the 440 Hz wave's peak.
    const left = sine(440, 0.25);
    const right = sine(660, 0.25);
    for (const channel of [left, right]) {
      channel[30_027] *= 0.3;
      channel[30_028] *= 0.3;
    }
    const dropout = findClicks(left, right, RATE);
    assert.equal(dropout.length, 1, JSON.stringify(dropout));
    assert.ok(dropout[0].frame >= 30_027 && dropout[0].frame <= 30_031);
  });

  test("doesn't hear a step smaller than the threshold", () => {
    // The threshold's limit, kept in view: a step of 0.01 (-40 dBFS) passes.
    const tone = sine(352, 0.29);
    for (let i = 24_000; i < tone.length; i++) tone[i] += 0.01;
    assert.deepEqual(findClicks(tone, silence(), RATE), []);
    assert.equal(CLICK_THRESHOLD, 0.05);
  });

  test('finds silent stretches in 5 ms blocks', () => {
    const left = sine(440, 0.25);
    left.fill(0, 24_000, 24_000 + 960);
    const right = left.slice();
    const runs = silentRuns(left, right, RATE);
    assert.equal(runs.length, 1);
    assert.ok(runs[0].frames >= 720 && runs[0].frames <= 960, JSON.stringify(runs));
    // One channel still playing is not silence.
    assert.deepEqual(silentRuns(left, sine(660, 0.25), RATE), []);
  });
});

describe('audio regression spans', () => {
  const span = (left, right, extra = {}) => analyzeSpan({ sampleRate: RATE, fromFrame: 1000, left, right, ...extra });
  const codes = (result) => result.problems.map((problem) => problem.code);
  // An action from 0.5 s to 0.52 s in the recording (frames from 1000).
  const action = (allow = {}) => ({ label: 'change', startFrame: 1000 + 24_000, endFrame: 1000 + 24_960, allow: { windowMs: 300, ...allow } });

  test("a dip during an action that may make one is allowed, a longer or stray one isn't", () => {
    const dipped = withGain(sine(352, 0.29), [[0.53, 1], [0.54, 0], [0.63, 0], [0.655, 1]]);
    assert.deepEqual(codes(span(dipped, silence(), { actions: [action({ silenceMs: 150 })] })), []);
    assert.deepEqual(codes(span(dipped, silence(), { actions: [action({ silenceMs: 50 })] })), ['gap']);
    assert.deepEqual(codes(span(dipped, silence(), { actions: [action()] })), ['gap']);
    // The same dip with no action near it.
    const stray = withGain(sine(352, 0.29), [[0.83, 1], [0.84, 0], [0.93, 0], [0.955, 1]]);
    const result = span(stray, silence(), { actions: [action({ silenceMs: 150 })] });
    assert.deepEqual(codes(result), ['gap']);
    assert.match(result.problems[0].message, /outside any action/);
  });

  test('a click fails unless its action may click, as a page stopping a tone does', () => {
    const tone = sine(352, 0.29);
    tone.fill(0, 24_500);
    assert.deepEqual(codes(span(tone, silence(), { actions: [action({ silenceMs: Infinity })] })), ['click']);
    const allowed = span(tone, silence(), { actions: [action({ silenceMs: Infinity, clicks: true })] });
    assert.deepEqual(codes(allowed), []);
    assert.equal(allowed.clicks[0].allowed, true);
    assert.ok(allowed.quietPeak < 0.002, String(allowed.quietPeak));
  });

  test('an action needs recording before it, or a recording that starts before its sound', () => {
    const tone = sine(352, 0.29);
    const early = { label: 'early', startFrame: 1000 + 2400, endFrame: 1000 + 2400, allow: {} };
    assert.deepEqual(codes(span(tone, silence(), { actions: [early] })), ['not-covered']);
    const outside = { label: 'later', startFrame: 1000 + 60_000, endFrame: 1000 + 60_000, allow: {} };
    assert.deepEqual(codes(span(tone, silence(), { actions: [outside] })), ['not-covered']);

    const onset = { label: 'turn on', startFrame: 1000, endFrame: 1000 + 4800, allow: { fromRecordingStart: true, silenceMs: 300 } };
    // Silent for 200 ms, then a 25 ms fade in, as Firefox's engines start.
    const quietStart = withGain(sine(352, 0.29), [[0.2, 0], [0.225, 1]]);
    assert.deepEqual(codes(span(quietStart, silence(), { actions: [onset] })), []);
    assert.deepEqual(codes(span(sine(352, 0.29), silence(), { actions: [onset] })), ['onset-not-observed']);
  });

  test('steady stretches are checked for their tones and levels', () => {
    const segment = (expect) => ({ label: 'steady', fromFrame: 1000 + 4800, toFrame: 1000 + 28_800, expect });
    const tones = { channels: [{ tones: [{ hz: 352, min: 0.2, max: 0.3 }] }, { maxRms: 0.001 }] };
    assert.deepEqual(codes(span(sine(352, 0.25), silence(), { segments: [segment(tones)] })), []);
    assert.deepEqual(codes(span(sine(440, 0.25), silence(), { segments: [segment(tones)] })), ['tone-missing']);
    const tail = { channels: [{ minRms: 0.005 }] };
    assert.ok(codes(span(silence(), silence(), { segments: [segment(tail)] })).includes('channel-silent'));
    const tooShort = { label: 'short', fromFrame: 1000 + 4800, toFrame: 1000 + 6000, expect: tones };
    assert.deepEqual(codes(span(sine(352, 0.25), silence(), { segments: [tooShort] })), ['not-covered']);
  });
});

describe('audio regression span health', () => {
  // Snapshots of the observer one second apart, as capture-observer.js
  // reports them.
  function snapshots({ frames = RATE, from = 4096, start = {}, end = {}, arrivalGapMs = 43 } = {}) {
    const recorder = (nextFrame, counters) => ({
      ready: true,
      error: null,
      workletSampleRate: RATE,
      nextFrame,
      lostFrames: 0,
      overflowFrames: 0,
      contextFrameGaps: 0,
      offsetChanges: 0,
      nonStereoBlocks: 0,
      maxArrivalGapMs: arrivalGapMs,
      lastBatch: { contextFrame: nextFrame - 2048, frames: 2048 },
      ...counters
    });
    const context = (currentTime) => ({ state: 'running', currentTime, sampleRate: RATE });
    return {
      before: { wallMs: 1000, errors: [], context: context(1), recorder: recorder(from, start) },
      after: { wallMs: 2000, errors: [], context: context(2), recorder: recorder(from + frames, end) }
    };
  }
  const channels = (frames) => [sine(352, 0.25, frames / RATE), silence(frames / RATE)];
  const healthCodes = ({ before, after }, read, fromFrame = before.recorder.nextFrame) =>
    spanHealth(before, after, read, fromFrame).map((problem) => problem.code);

  test('a late message is not missing audio', () => {
    // The page heard about the frames 400 ms late, but every frame is there.
    assert.deepEqual(healthCodes(snapshots({ arrivalGapMs: 400 }), channels(RATE)), []);
  });

  test('missing frames fail, whatever the sound', () => {
    assert.deepEqual(healthCodes(snapshots({ end: { lostFrames: 2048 } }), channels(RATE)), ['frames-lost']);
    assert.deepEqual(healthCodes(snapshots({ end: { contextFrameGaps: 1 } }), channels(RATE)), ['context-gap']);
    assert.deepEqual(healthCodes(snapshots({ end: { offsetChanges: 1 } }), channels(RATE)), ['context-gap']);
    assert.deepEqual(healthCodes(snapshots(), channels(RATE - 128)), ['frame-mismatch']);
    const bad = channels(RATE);
    bad[0][10] = NaN;
    assert.deepEqual(healthCodes(snapshots(), bad), ['non-finite']);
  });

  test('frames lost before a span count only when the span starts with the recording', () => {
    const parts = snapshots({ start: { contextFrameGaps: 1 }, end: { contextFrameGaps: 1 } });
    assert.deepEqual(healthCodes(parts, channels(RATE)), []);
    assert.deepEqual(healthCodes(parts, channels(RATE + 4096), 0), ['context-gap']);
  });

  test('a suspended context fails', () => {
    const parts = snapshots();
    parts.after.context.state = 'suspended';
    parts.after.context.currentTime = 1;
    assert.deepEqual(healthCodes(parts, channels(RATE)), ['not-running', 'clock-stalled']);
  });
});

describe('audio regression historical controls', () => {
  test('each defect put back still matches the code it changes exactly once', () => {
    for (const entry of HISTORY) {
      for (const { file, find, replace } of entry.mutations) {
        const source = fs.readFileSync(path.join(root, 'extension', file), 'utf8');
        assert.equal(source.split(find).length - 1, 1, `${entry.id}: ${file} should contain its pattern once`);
        assert.notEqual(find, replace, entry.id);
      }
    }
  });

  test('cover the defects the project fixed, each with a check the suite runs', () => {
    const commits = new Set(HISTORY.map((entry) => entry.commit));
    for (const commit of ['02ef174', '3fbb1c3', '74032cc', '9cde26c', '134e1c0', '9a900c4', '1127987', '4565b80', '0cad7f4']) {
      assert.ok(commits.has(commit), commit);
    }
    const suite = fs.readFileSync(path.join(root, 'e2e', 'audio-capture', 'regression.js'), 'utf8');
    for (const entry of HISTORY) {
      assert.ok(['exact', 'narrow', 'surrogate'].includes(entry.kind), entry.id);
      assert.ok(entry.browsers.length && entry.browsers.every((name) => ['chromium', 'firefox'].includes(name)), entry.id);
      const keys = [`'${entry.check}':`, `"${entry.check}":`, `${entry.check}:`];
      assert.ok(keys.some((key) => suite.includes(key)), `${entry.id}: no check "${entry.check}"`);
      assert.ok(entry.expect.length && entry.expect.every(({ code, during }) => code && during), entry.id);
    }
  });
});

describe('audio recorder frame numbers', () => {
  // Runs recorder-worklet.js in a context of its own, as the audio thread
  // would, with `currentFrame` set before each block.
  function recorder() {
    const sandbox = { sampleRate: RATE, currentFrame: 0, Float32Array, registered: null };
    sandbox.AudioWorkletProcessor = class {
      constructor() {
        this.port = { postMessage: (message) => sandbox.messages.push(message), onmessage: null };
      }
    };
    sandbox.registerProcessor = (name, processor) => {
      sandbox.registered = processor;
    };
    sandbox.messages = [];
    vm.runInNewContext(fs.readFileSync(path.join(root, 'e2e', 'audio-capture', 'recorder-worklet.js'), 'utf8'), sandbox);
    const node = new sandbox.registered({ processorOptions: { batchFrames: 512, poolSize: 4 } });
    let value = 0;
    const play = (frames) => {
      for (const frame of frames) {
        sandbox.currentFrame = frame;
        const block = [new Float32Array(128).fill(value), new Float32Array(128).fill(value)];
        value += 1;
        node.process([block], [[new Float32Array(128), new Float32Array(128)]]);
      }
      return node.counters();
    };
    const batches = () => sandbox.messages.filter((message) => message.type === 'batch');
    return { play, batches };
  }
  const blocks = (from, count) => Array.from({ length: count }, (_, index) => from + index * 128);

  test('blocks in step have no gaps', () => {
    const counters = recorder().play(blocks(0, 8));
    assert.equal(counters.contextFrameGaps, 0);
    assert.equal(counters.staleFrameLabels, 0);
  });

  test("a block with the previous block's number is a stale label, not a gap", () => {
    const { play, batches } = recorder();
    // As Chromium does around a change of connections: 512 is reported for
    // the block that is really 640, then the numbers catch up.
    const counters = play([0, 128, 256, 384, 512, 512, 768, 896, 1024, 1152]);
    assert.equal(counters.contextFrameGaps, 0);
    assert.equal(counters.skippedContextFrames, 0);
    assert.equal(counters.staleFrameLabels, 1);
    // Each batch's context frame stays in step with the recorder's count.
    for (const batch of batches()) assert.equal(batch.contextFrame, batch.startFrame);
  });

  test('a jump forward is a gap', () => {
    const counters = recorder().play([0, 128, 256, 640, 768]);
    assert.equal(counters.contextFrameGaps, 1);
    assert.equal(counters.skippedContextFrames, 256);
    assert.equal(counters.staleFrameLabels, 0);
  });
});
