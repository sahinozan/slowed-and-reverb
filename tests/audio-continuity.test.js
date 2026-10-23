'use strict';

// Checks the audio regression suite's continuity measurements
// (e2e/audio-capture/metrics.js) against computed signals: that planted
// clicks, dropouts and gaps are found, that the engines' own fades and
// steady tones are not, that a late message is kept apart from missing
// frames, and that restoration means the exact unchanged sound. Also checks
// that each historical defect the suite puts back
// (e2e/audio-capture/history.js) still matches today's code exactly once and
// is judged engine by engine, how the recorder counts frame numbers (run
// through the real recorder-worklet.js), and the deadlines of the suite's
// page steps (e2e/audio-capture/actions.js). No browser or sound device is
// involved.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const vm = require('node:vm');

const { pageStep, runPageStep, withDeadline } = require('../e2e/audio-capture/actions');
const { RECORDER_PROBLEMS } = require('../e2e/audio-capture/harness');
const { HISTORY, controlVerdict } = require('../e2e/audio-capture/history');
const {
  CLICK_THRESHOLD,
  analyzeSpan,
  dryRestoration,
  findClicks,
  fitTone,
  markProblems,
  silentRuns,
  spanHealth
} = require('../e2e/audio-capture/metrics');
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
      assert.ok(entry.sites.length && entry.sites.every((site) => ['youtube', 'spotify'].includes(site)), entry.id);
      assert.equal(new Set(entry.sites).size, entry.sites.length, entry.id);
    }
    // Checks that only Spotify has, and updates, which check one site each.
    for (const entry of HISTORY.filter(({ check }) => check.includes('speed') || check === 'an update')) {
      assert.equal(entry.sites.length, 1, entry.id);
    }
    for (const entry of HISTORY.filter(({ check }) => check.includes('speed'))) assert.deepEqual(entry.sites, ['spotify'], entry.id);
  });

  test('are caught only if every engine they were put back into fails as listed, each on its own', () => {
    const entry = HISTORY.find(({ id }) => id === '3fbb1c3');
    assert.deepEqual(entry.sites, ['youtube', 'spotify']);
    const caught = { code: 'click', message: 'click of 0.44 at 9120 ms (channel 0), during overlapping changes' };
    const invalid = ['context-gap', 'setup'];
    assert.deepEqual(controlVerdict(entry, [{ site: 'youtube', problems: [caught] }, { site: 'spotify', problems: [caught] }], invalid), []);
    // The review's case: the defect put back into YouTube's engine only.
    // YouTube clicks five times, which pooled together would have passed.
    const onlyYouTube = controlVerdict(entry, [{ site: 'youtube', problems: [caught, caught, caught, caught, caught] }, { site: 'spotify', problems: [] }], invalid);
    assert.equal(onlyYouTube.length, 1);
    assert.match(onlyYouTube[0], /^spotify: should fail with click/);
    // An engine that failed as a measurement isn't caught, whatever else it heard.
    const broken = controlVerdict(entry, [{ site: 'youtube', problems: [caught] }, { site: 'spotify', problems: [caught, { code: 'context-gap', message: '1 skipped' }] }], invalid);
    assert.deepEqual(broken.map((failure) => failure.split(':')[0]), ['spotify']);
    // An engine that wasn't checked at all.
    assert.match(controlVerdict(entry, [{ site: 'youtube', problems: [caught] }], invalid)[0], /^ran on youtube, wanted youtube, spotify/);
    // Both engines turned off in the browser, one still playing the effect.
    const shutdown = HISTORY.find(({ id }) => id === '134e1c0');
    const notRestored = { code: 'not-restored', message: 'turn the extension off: the unchanged sound never came back' };
    assert.deepEqual(controlVerdict(shutdown, [{ site: 'youtube', problems: [notRestored] }, { site: 'spotify', problems: [notRestored] }], invalid), []);
    assert.match(controlVerdict(shutdown, [{ site: 'youtube', problems: [] }, { site: 'spotify', problems: [notRestored] }], invalid)[0], /^youtube: should fail with not-restored/);
    // Every expected problem, not just one of them.
    const clicks = HISTORY.find(({ id }) => id === '02ef174');
    const during = (action) => ({ code: 'click', message: `click of 0.5 at 1 ms (channel 0), during ${action}` });
    const all = [during('overlapping changes'), during('turn off'), during('turn on')];
    assert.deepEqual(controlVerdict(clicks, [{ site: 'youtube', problems: all }, { site: 'spotify', problems: all }], invalid), []);
    assert.equal(controlVerdict(clicks, [{ site: 'youtube', problems: all }, { site: 'spotify', problems: all.slice(0, 2) }], invalid).length, 1);
  });
});

// Runs recorder-worklet.js in a context of its own, as the audio thread
// would, with `currentFrame` set before each block.
function loadRecorder({ batchFrames = 512, poolSize = 4 } = {}) {
  const sandbox = { sampleRate: RATE, currentFrame: 0, Float32Array, registered: null, messages: [] };
  sandbox.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage: (message) => sandbox.messages.push(message), onmessage: null };
    }
  };
  sandbox.registerProcessor = (name, processor) => {
    sandbox.registered = processor;
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'e2e', 'audio-capture', 'recorder-worklet.js'), 'utf8'), sandbox);
  const node = new sandbox.registered({ processorOptions: { batchFrames, poolSize } });
  return { sandbox, node };
}

describe('audio recorder frame numbers', () => {
  function recorder() {
    const { sandbox, node } = loadRecorder();
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
    assert.equal(counters.frameLabelFaults, 0);
  });

  test("a block with the previous block's number is a stale label, not a gap", () => {
    const { play, batches } = recorder();
    // As Chromium does around a change of connections: 512 is reported for
    // the block that is really 640, then the numbers catch up.
    const counters = play([0, 128, 256, 384, 512, 512, 768, 896, 1024, 1152]);
    assert.equal(counters.contextFrameGaps, 0);
    assert.equal(counters.skippedContextFrames, 0);
    assert.equal(counters.staleFrameLabels, 1);
    assert.equal(counters.staleRuns, 1);
    assert.equal(counters.frameLabelFaults, 0);
    assert.equal(counters.staleRunOpen, false);
    // The raw numbers and where it caught up are kept.
    assert.deepEqual(
      { ...counters.staleLog[0] },
      { recorderFrame: 640, contextFrame: 512, expected: 640, blocks: 1, frames: 128, recovered: true, recoveredRecorderFrame: 768, recoveredContextFrame: 768 }
    );
    // Each batch's context frame stays in step with the recorder's count.
    for (const batch of batches()) assert.equal(batch.contextFrame, batch.startFrame);
  });

  test('two stale labels in a row that then catch up, as Chromium has shown, are one stale run', () => {
    const { play, batches } = recorder();
    const counters = play([0, 128, 256, 384, 384, 384, 768, 896, 1024]);
    assert.equal(counters.staleFrameLabels, 2);
    assert.equal(counters.staleRuns, 1);
    assert.equal(counters.frameLabelFaults, 0);
    assert.equal(counters.staleLog[0].blocks, 2);
    assert.equal(counters.staleLog[0].recovered, true);
    for (const batch of batches()) assert.equal(batch.contextFrame, batch.startFrame);
  });

  test('a run of stale labels still open is reported as open', () => {
    const counters = recorder().play([0, 128, 256, 256]);
    assert.equal(counters.staleRunOpen, true);
    assert.equal(counters.staleLog[0].recovered, null);
  });

  test('three stale labels in a row are a fault, not a stale run', () => {
    const counters = recorder().play([0, 128, 256, 256, 256, 256, 768]);
    assert.equal(counters.staleFrameLabels, 2);
    assert.equal(counters.frameLabelFaults, 1);
    assert.equal(counters.faultLog[0].kind, 'stale for too long');
    assert.equal(counters.staleLog[0].recovered, false);
  });

  test('a counter that goes back, or stops, is a fault on every block', () => {
    // Back 512 ms (24576 frames at 48 kHz), then counting on from there.
    const reset = recorder().play([...blocks(24_576, 4), ...blocks(0, 6)]);
    assert.equal(reset.staleFrameLabels, 0);
    assert.equal(reset.frameLabelFaults, 6);
    assert.equal(reset.faultLog[0].kind, 'went back');
    // Stopped at 0.
    const frozen = recorder().play([...blocks(0, 4), 0, 0, 0, 0, 0]);
    assert.equal(frozen.staleFrameLabels, 0);
    assert.equal(frozen.frameLabelFaults, 5);
    // Back by two blocks at once, without repeating the number before.
    const back = recorder().play([0, 128, 256, 384, 128, 640]);
    assert.equal(back.staleFrameLabels, 0);
    assert.equal(back.frameLabelFaults, 1);
  });

  test("a stale run that doesn't catch up exactly is a fault", () => {
    const ahead = recorder().play([0, 128, 256, 256, 640]);
    assert.equal(ahead.contextFrameGaps, 1);
    assert.equal(ahead.frameLabelFaults, 1);
    assert.equal(ahead.staleLog[0].recovered, false);
    const behind = recorder().play([0, 128, 256, 256, 128, 640]);
    assert.equal(behind.frameLabelFaults, 1);
    assert.equal(behind.staleLog[0].recovered, false);
  });

  test('a jump forward is a gap', () => {
    const counters = recorder().play([0, 128, 256, 640, 768]);
    assert.equal(counters.contextFrameGaps, 1);
    assert.equal(counters.skippedContextFrames, 256);
    assert.equal(counters.staleFrameLabels, 0);
    assert.equal(counters.frameLabelFaults, 0);
  });
});

describe('audio recorder frame numbers and the sound across them', () => {
  // Plays two tones through the real worklet, in 2048-frame batches, as the
  // page receives them. `label(frame)` is the currentFrame given for the
  // block that is really `frame`, and `source(frame, i)` the frame of the
  // tone played as its sample i, so a block can be repeated or left out.
  // Returns the observer's snapshots by the frame they end at, and the
  // recorded samples.
  const TOTAL = 98_304;
  const FROM = 8_192;
  const FAULT = 24_576;
  function record({ label = (frame) => frame, source = (frame, i) => frame + i, tones = [440, 660], resetPageClock = false } = {}) {
    const { sandbox, node } = loadRecorder({ batchFrames: 2048, poolSize: 64 });
    const channels = [new Float32Array(TOTAL), new Float32Array(TOTAL)];
    const snapshots = new Map();
    let offset = null;
    let offsetChanges = 0;
    for (let frame = 0; frame < TOTAL; frame += 128) {
      sandbox.currentFrame = label(frame);
      const input = tones.map((hz) => Float32Array.from({ length: 128 }, (_, i) => 0.25 * Math.sin((2 * Math.PI * hz * source(frame, i)) / RATE)));
      node.process([input], [[new Float32Array(128), new Float32Array(128)]]);
      const last = sandbox.messages[sandbox.messages.length - 1];
      if (last.type !== 'batch' || last.startFrame + last.frames !== frame + 128) continue;
      const next = last.startFrame + last.frames;
      const nextOffset = last.contextFrame - last.startFrame;
      if (offset !== null && nextOffset !== offset) offsetChanges++;
      offset = nextOffset;
      const samples = new Float32Array(last.buffer);
      for (let channel = 0; channel < 2; channel++) channels[channel].set(samples.subarray(channel * 2048, channel * 2048 + last.frames), last.startFrame);
      const pageFrame = resetPageClock && next > FAULT ? next - FAULT : next;
      snapshots.set(next, {
        wallMs: (next / RATE) * 1000,
        errors: [],
        context: { state: 'running', sampleRate: RATE, currentTime: pageFrame / RATE },
        recorder: {
          ready: true,
          error: null,
          workletSampleRate: RATE,
          nextFrame: next,
          lostFrames: 0,
          offsetChanges,
          frameOffset: offset,
          lastBatch: { contextFrame: last.contextFrame, frames: last.frames },
          ...node.counters()
        }
      });
    }
    // A mark the page takes at `frame` of the real clock, as
    // capture-observer.js maps it, with what the page had received then.
    const markAt = (frame, labelText) => {
      const received = Math.floor(frame / 2048) * 2048;
      const snapshotThen = snapshots.get(received);
      const contextFrame = resetPageClock && frame > FAULT ? frame - FAULT : frame;
      return { label: labelText, contextFrame, recorderFrame: contextFrame - snapshotThen.recorder.frameOffset, nextFrame: received };
    };
    const health = (settledAt = TOTAL) =>
      spanHealth(snapshots.get(FROM), snapshots.get(TOTAL), channels.map((samples) => samples.subarray(FROM)), FROM, snapshots.get(settledAt));
    return { snapshots, channels, health, markAt };
  }
  const codes = (problems) => [...new Set(problems.map((problem) => problem.code))];
  const staleOnce = (frame) => (frame === FAULT ? frame - 128 : frame);
  const staleTwice = (frame) => (frame === FAULT || frame === FAULT + 128 ? FAULT - 128 : frame);

  test('stale labels with unbroken sound are valid data, and marks still map to the frames played', () => {
    for (const label of [staleOnce, staleTwice]) {
      const recording = record({ label });
      assert.deepEqual(recording.health(), []);
      const end = recording.snapshots.get(TOTAL).recorder;
      assert.equal(end.offsetChanges, 0);
      assert.equal(end.staleRuns, 1);
      // An action marked after the stale run maps to the frame then played.
      const mark = recording.markAt(FAULT + 4096, 'after');
      assert.equal(mark.recorderFrame, FAULT + 4096);
      assert.deepEqual(markProblems([recording.markAt(FAULT - 4096, 'before'), mark]), []);
    }
  });

  test("a counter that goes back or stops fails as the recorder's fault, not as sound", () => {
    const back = record({ label: (frame) => (frame >= FAULT ? frame - FAULT : frame) });
    assert.deepEqual(codes(back.health()), ['frame-label-fault']);
    const frozen = record({ label: (frame) => (frame >= FAULT ? 0 : frame) });
    assert.deepEqual(codes(frozen.health()), ['frame-label-fault']);
    // The page's clock going back with it: the recorder still fails it, and
    // a mark taken then falls before the frames already recorded.
    const both = record({ label: (frame) => (frame >= FAULT ? frame - FAULT : frame), resetPageClock: true });
    assert.deepEqual(codes(both.health()), ['frame-label-fault']);
    assert.deepEqual(codes(markProblems([both.markAt(FAULT - 4096, 'before'), both.markAt(FAULT + 4096, 'after')])), ['mark-out-of-step']);
    for (const code of ['frame-label-fault', 'stale-label-discontinuity', 'stale-label-repeat', 'stale-label-unverified']) {
      assert.ok(RECORDER_PROBLEMS.includes(code), code);
    }
  });

  test('a stale label over a repeated or missing block of sound fails as a measurement, not a click', () => {
    // The block played again, under the previous block's number.
    const repeated = record({ label: staleOnce, source: (frame, i) => (frame === FAULT ? frame - 128 + i : frame + i) });
    assert.deepEqual(codes(repeated.health()), ['stale-label-discontinuity']);
    // The tone skips a block, under a stale number.
    const missing = record({ label: staleOnce, source: (frame, i) => (frame >= FAULT ? frame + 128 + i : frame + i) });
    assert.deepEqual(codes(missing.health()), ['stale-label-discontinuity']);
    // A tone that repeats every 128 frames (375 Hz at 48 kHz) doesn't click
    // when a block is played again, but the block's samples repeat the one
    // before, so it can't be told apart either.
    const seamless = record({ label: staleOnce, source: (frame, i) => (frame === FAULT ? frame - 128 + i : frame + i), tones: [375, 750] });
    assert.deepEqual(codes(seamless.health()), ['stale-label-repeat']);
  });

  test("a stale run the recorder hasn't seen catch up is unverified until a later snapshot shows it did", () => {
    // The run is in the span's last block.
    const late = record({ label: (frame) => (frame === TOTAL - 2048 - 128 ? frame - 128 : frame) });
    const spanEnd = TOTAL - 2048;
    const health = (settledAt) =>
      spanHealth(late.snapshots.get(FROM), late.snapshots.get(spanEnd), late.channels.map((samples) => samples.subarray(FROM, spanEnd)), FROM, late.snapshots.get(settledAt));
    assert.deepEqual(codes(health(spanEnd)), ['stale-label-unverified']);
    // Caught up, but too close to the span's end to check the sound across it.
    assert.deepEqual(codes(health(TOTAL)), ['stale-label-unverified']);
    const earlier = record({ label: (frame) => (frame === TOTAL - 4096 ? frame - 128 : frame) });
    assert.deepEqual(earlier.health(), []);
  });

  test('marks out of order, or before what was recorded, are out of step', () => {
    const mark = (label, recorderFrame, nextFrame) => ({ label, recorderFrame, nextFrame });
    assert.deepEqual(markProblems([mark('a', 4096, 4096), mark('b', 6000, 4096), mark('c', 6100, 6144)]), []);
    // Firefox's clock, read by a page, a block behind what was received.
    assert.deepEqual(markProblems([mark('a', 3968, 4096)]), []);
    assert.deepEqual(codes(markProblems([mark('a', 1000, 8192)])), ['mark-out-of-step']);
    assert.deepEqual(codes(markProblems([mark('a', 9000, 8192), mark('b', 8500, 8192)])), ['mark-out-of-step']);
  });
});

describe('audio regression restoration', () => {
  // A span 2 s long in which the extension is turned off at 0.3 s. Before,
  // the effect: 352 and 528 Hz on the left, nothing on the right. `left` and
  // `right` give each channel's sound after it.
  const OFF = 0.3;
  const DRY = [{ hz: 440, amplitude: 0.25 }, { hz: 660, amplitude: 0.25 }];
  function afterOff({ left, right }) {
    const wet = sum(sine(352, 0.29, 2), sine(528, 0.29, 2));
    const out = [new Float32Array(2 * RATE), new Float32Array(2 * RATE)];
    for (let i = 0; i < out[0].length; i++) {
      const time = i / RATE;
      out[0][i] = time < OFF ? wet[i] : left(time, i);
      out[1][i] = time < OFF ? 0 : right(time, i);
    }
    return out;
  }
  const tone = (hz, amplitude) => (time) => amplitude * Math.sin(2 * Math.PI * hz * time);
  // Rises in a straight line from 0 at `from` to 1 at `to` (seconds after
  // the action).
  const ramp = (from, to) => (time) => Math.min(1, Math.max(0, (time - OFF - from) / (to - from)));
  const action = { label: 'turn the extension off', startFrame: OFF * RATE, endFrame: OFF * RATE + 480, allow: { restores: true, windowMs: 1500, silenceMs: 250 } };
  const segment = { label: 'off', fromFrame: (OFF + 1) * RATE, toFrame: (OFF + 1.6) * RATE, expect: dryExpectFor(440, 660) };
  function dryExpectFor(leftHz, rightHz) {
    return {
      channels: [
        { tones: [{ hz: leftHz, min: 0.24, max: 0.26 }, { hz: rightHz, min: 0, max: 0.005 }] },
        { tones: [{ hz: rightHz, min: 0.24, max: 0.26 }, { hz: leftHz, min: 0, max: 0.005 }] }
      ]
    };
  }
  function measure(sound) {
    const [left, right] = afterOff(sound);
    const analysis = analyzeSpan({ sampleRate: RATE, fromFrame: 0, left, right, actions: [action], segments: [segment] });
    const restoration = dryRestoration({ left, right, sampleRate: RATE, fromFrame: 0, startFrame: action.startFrame, toFrame: segment.toFrame, dry: DRY });
    return { analysis, restoration };
  }

  test('a fit of the expected tone gives its level, and what else is there', () => {
    const fit = fitTone(sine(440, 0.25, 0.01, RATE, 1.1), RATE, 440);
    assert.ok(Math.abs(fit.amplitude - 0.25) < 1e-6, JSON.stringify(fit));
    assert.ok(fit.residualRms < 1e-6, JSON.stringify(fit));
    const mixed = fitTone(sum(sine(440, 0.25, 0.01), sine(528, 0.05, 0.01)), RATE, 440);
    assert.ok(mixed.residualRms > 0.02, JSON.stringify(mixed));
  });

  test('the unchanged sound faded in on time is restored', () => {
    const fadeIn = ramp(0.2, 0.225);
    const { analysis, restoration } = measure({
      left: (time) => tone(440, 0.25)(time) * fadeIn(time),
      right: (time) => tone(660, 0.25)(time) * fadeIn(time)
    });
    assert.deepEqual(analysis.problems, []);
    assert.ok(restoration.restoredAfterMs >= 220 && restoration.restoredAfterMs <= 240, JSON.stringify(restoration));
    assert.ok(restoration.afterRestored.every((channel) => channel.maxResidualRms < 1e-4), JSON.stringify(restoration));
  });

  test('a partial level that only reaches the exact one late is restored late, though it sounds from the start', () => {
    // The review's case: the right tone at 60% of its level until 1.1 s
    // after the action, then up to its level over 25 ms. The steady stretch
    // after it, and the clicks and gaps, pass.
    const level = (time) => {
      const after = time - OFF;
      if (after < 0.025) return 0.15 * (after / 0.025);
      if (after < 1.1) return 0.15;
      return Math.min(0.25, 0.15 + (0.1 * (after - 1.1)) / 0.025);
    };
    const { analysis, restoration } = measure({ left: tone(440, 0.25), right: (time) => level(time) * Math.sin(2 * Math.PI * 660 * time) });
    assert.deepEqual(analysis.problems, []);
    assert.ok(restoration.energyOnsetMs < 50, JSON.stringify(restoration));
    assert.ok(restoration.restoredAfterMs > 1000, JSON.stringify(restoration));
  });

  test('the wrong tone, the wrong channel or the effect still mixed in is never restored', () => {
    const wrongTone = measure({ left: tone(440, 0.25), right: tone(528, 0.25) }).restoration;
    assert.equal(wrongTone.restoredAfterMs, null);
    const swapped = measure({ left: tone(660, 0.25), right: tone(440, 0.25) }).restoration;
    assert.equal(swapped.restoredAfterMs, null);
    const leftover = measure({ left: (time) => tone(440, 0.25)(time) + tone(352, 0.02)(time), right: tone(660, 0.25) }).restoration;
    assert.equal(leftover.restoredAfterMs, null);
    const oneChannel = measure({ left: tone(440, 0.25), right: () => 0 }).restoration;
    assert.equal(oneChannel.restoredAfterMs, null);
  });

  test('the exact sound coming back after the limit is late', () => {
    const fadeIn = ramp(1.2, 1.225);
    const { restoration } = measure({
      left: (time) => tone(440, 0.25)(time) * fadeIn(time),
      right: (time) => tone(660, 0.25)(time) * fadeIn(time)
    });
    assert.ok(restoration.restoredAfterMs >= 1220 && restoration.restoredAfterMs <= 1240, JSON.stringify(restoration));
  });
});

describe('audio regression page steps', () => {
  // Runs actions.js's pageStep as the browser would: from its source, in a
  // context of its own with a stand-in page.
  function inPage({ play = () => Promise.resolve(), fires = [] } = {}) {
    const player = new EventTarget();
    const listening = new Map();
    const add = player.addEventListener.bind(player);
    const remove = player.removeEventListener.bind(player);
    player.addEventListener = (type, listener, options) => {
      listening.set(type, (listening.get(type) ?? 0) + 1);
      add(type, listener, options);
    };
    player.removeEventListener = (type, listener) => {
      listening.set(type, (listening.get(type) ?? 0) - 1);
      remove(type, listener);
    };
    player.play = () => {
      const played = play();
      for (const type of fires) setTimeout(() => player.dispatchEvent(new Event(type)), 5);
      return played;
    };
    player.parentNode = { append() {} };
    player.remove = () => {};
    const timers = new Set();
    const sandbox = {
      document: { getElementById: () => player },
      setTimeout: (callback, ms) => {
        const id = setTimeout(() => {
          timers.delete(id);
          callback();
        }, ms);
        timers.add(id);
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
        clearTimeout(id);
      }
    };
    const step = vm.runInNewContext(`(${pageStep.toString()})`, sandbox);
    return { step, player, listening, timers };
  }

  test('a step that is done clears its timers and listeners', async () => {
    const page = inPage({ fires: ['playing'] });
    assert.equal(await page.step({ step: 'nextSong', timeoutMs: 1000, src: '/b.wav' }), 'playing');
    assert.equal(page.player.playbackRate, 1);
    assert.equal(page.player.src, '/b.wav');
    assert.equal(page.listening.get('playing'), 0);
    assert.equal(page.timers.size, 0);
    assert.equal(await inPage().step({ step: 'putBack', timeoutMs: 1000, rate: 1.25, waitMs: 5 }), 'playing');
  });

  test("a play() that never settles, or a 'playing' that never comes, fails in the page and cleans up", async () => {
    const never = inPage({ play: () => new Promise(() => {}) });
    await assert.rejects(never.step({ step: 'play', timeoutMs: 50 }), /"play" wasn't done within 50 ms/);
    assert.equal(never.timers.size, 0);
    const silent = inPage();
    await assert.rejects(silent.step({ step: 'nextSong', timeoutMs: 50, src: '/b.wav' }), /"nextSong" wasn't done within 50 ms/);
    assert.equal(silent.listening.get('playing'), 0);
    assert.equal(silent.timers.size, 0);
  });

  test("a page that doesn't answer fails on the Node side", async () => {
    const page = { evaluate: () => new Promise(() => {}) };
    const started = Date.now();
    await assert.rejects(runPageStep(page, 'nextSong', {}, { timeoutMs: 30, backstopMs: 20 }), (error) => error.code === 'timeout');
    assert.ok(Date.now() - started < 1000);
    assert.equal(await withDeadline(Promise.resolve('done'), 1000, 'unused'), 'done');
  });
});
