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
// page steps and the pacing of its overlapping changes
// (e2e/audio-capture/actions.js). No browser or sound device is involved.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const vm = require('node:vm');

const {
  ACTION_LIMIT_MS,
  PAGE_BACKSTOP_MS,
  pageStep,
  pageSweep,
  runPageStep,
  runSweep,
  sweepLimitMs,
  withDeadline
} = require('../e2e/audio-capture/actions');
const { RECORDER_PROBLEMS } = require('../e2e/audio-capture/harness');
const { HISTORY, controlVerdict } = require('../e2e/audio-capture/history');
const {
  CLICK_THRESHOLD,
  analyzeSpan,
  dryRestoration,
  findClicks,
  fitTone,
  markProblems,
  outsidePauses,
  silentRuns,
  soundWallMs,
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
function loadRecorder({ batchFrames = 512, poolSize = 4, rate = RATE } = {}) {
  const sandbox = { sampleRate: rate, currentFrame: 0, Float32Array, registered: null, messages: [] };
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

// The recorder's native clock (its contextClock parameter) for the block
// that is really context frame `frame`, as the browser computes it: the
// context's time in seconds since the clock began, in float32. `origin` is
// where the ramp's value was 0, which Chromium can move a few blocks
// (recorder-worklet.js), and `length` the values given.
function nativeClock(frame, { origin = 0, length = 128, rate = RATE } = {}) {
  return { contextClock: Float32Array.from({ length }, (_, i) => (frame - origin + i) / rate) };
}

describe('the audio recorder\'s native clock', () => {
  // Blocks of 128 silent frames: [currentFrame, the block's real context
  // frame or its clock parameters].
  function sequence(blocks, { batchFrames = 512 } = {}) {
    const { sandbox, node } = loadRecorder({ batchFrames, poolSize: 8 });
    for (const [raw, clock] of blocks) {
      sandbox.currentFrame = raw;
      const input = [new Float32Array(128), new Float32Array(128)];
      node.process([input], [[new Float32Array(128), new Float32Array(128)]], typeof clock === 'number' ? nativeClock(clock, { origin: -64 }) : clock);
    }
    return { counters: node.counters(), batches: sandbox.messages.filter(({ type }) => type === 'batch') };
  }

  test("a first block numbered behind, as Chromium's start can give, is relabelled without losing a sample", () => {
    // Chromium's measured case: the first block says 512, the second 896,
    // and the native clock advanced one block between them.
    const { counters, batches } = sequence([[512, 768], [896, 896], [1024, 1024], [1152, 1152]]);
    assert.equal(counters.contextFrameGaps, 0);
    assert.equal(counters.frameLabelFaults, 0);
    assert.equal(counters.firstContextFrame, 768);
    assert.deepEqual({ ...counters.initialFrameLabel }, { raw: 512, corrected: 768, frames: 128 });
    assert.equal(batches[0].startFrame, 0);
    assert.equal(batches[0].frames, 512);
    assert.equal(batches[0].contextFrame, 768);
    // So a mark at context frame 1280 maps to recorded frame 512, the one
    // played then.
    assert.equal(1280 - (batches[0].contextFrame - batches[0].startFrame), 512);
    // Behind by four blocks, as on the hosted runner.
    const hosted = sequence([[2048, 2560], [2688, 2688], [2816, 2816]]).counters;
    assert.equal(hosted.contextFrameGaps, 0);
    assert.equal(hosted.firstContextFrame, 2560);
  });

  test('a first block in step is left as it is, whatever the clock\'s own value', () => {
    for (const origin of [0, 64, 256, -256]) {
      const blocks = [0, 128, 256, 384].map((frame) => [frame + 256, nativeClock(frame + 256, { origin })]);
      const { counters } = sequence(blocks);
      assert.equal(counters.frameLabelFaults, 0, `origin ${origin}`);
      assert.equal(counters.firstContextFrame, 256);
      assert.equal(counters.initialFrameLabel, null);
    }
  });

  test('frames really skipped, even right after the first block, stay a gap', () => {
    // The native clock skipped as the label did: a gap, not a stale label.
    const skipped = sequence([[256, 256], [896, 896], [1024, 1024]]).counters;
    assert.equal(skipped.contextFrameGaps, 1);
    assert.equal(skipped.frameLabelFaults, 0);
    assert.equal(skipped.initialFrameLabel, null);
    // A first block behind and frames skipped after it: not relabelled, and
    // the label and the clock disagree on how many, so a fault as well.
    const both = sequence([[512, 768], [1408, 1408], [1536, 1536]]).counters;
    assert.equal(both.contextFrameGaps, 1);
    assert.equal(both.frameLabelFaults, 1);
    assert.equal(both.initialFrameLabel, null);
    // Later on, too.
    const later = sequence([[0, 0], [128, 128], [512, 512], [640, 640]]).counters;
    assert.equal(later.contextFrameGaps, 1);
    assert.equal(later.skippedContextFrames, 256);
    assert.equal(later.frameLabelFaults, 0);
  });

  test('only the first block is relabelled: a later label ahead of the native clock is a fault', () => {
    const later = sequence([[0, 0], [128, 128], [512, 256], [640, 384]]).counters;
    assert.equal(later.contextFrameGaps, 1);
    assert.equal(later.frameLabelFaults, 1);
    assert.equal(later.faultLog[0].kind, 'label skipped frames the native clock did not');
    assert.equal(later.initialFrameLabel, null);
    // Nor a first block whose batch was already sent.
    const sent = sequence([[512, 768], [896, 896], [1024, 1024]], { batchFrames: 128 }).counters;
    assert.equal(sent.initialFrameLabel, null);
    assert.equal(sent.contextFrameGaps, 1);
    assert.equal(sent.frameLabelFaults, 1);
  });

  test('blocks rendered without the recorder while its numbers stay in step are a fault', () => {
    const hidden = sequence([[0, 0], [128, 128], [256, 512], [384, 640]]).counters;
    assert.equal(hidden.contextFrameGaps, 0);
    assert.equal(hidden.frameLabelFaults, 1);
    assert.equal(hidden.faultLog[0].kind, 'native clock skipped frames the label did not');
    assert.equal(hidden.faultLog[0].nativeStep, 384);
    // A stale label is checked the same way: one block on, by the clock.
    const stale = sequence([[0, 0], [128, 128], [128, 256], [384, 384]]).counters;
    assert.equal(stale.staleFrameLabels, 1);
    assert.equal(stale.frameLabelFaults, 0);
    const staleOverSkip = sequence([[0, 0], [128, 128], [128, 384], [384, 512]]).counters;
    assert.ok(staleOverSkip.frameLabelFaults >= 1);
  });

  test('a native clock that is missing, stopped, not a number or out of step fails every such block', () => {
    const stopped = nativeClock(0);
    stopped.contextClock.fill(stopped.contextClock[0]);
    const jumping = nativeClock(0);
    jumping.contextClock[64] += 1;
    const backwards = nativeClock(0);
    backwards.contextClock[64] = backwards.contextClock[62];
    for (const clock of [undefined, {}, { contextClock: new Float32Array([0]) }, { contextClock: new Float32Array(128).fill(-1) },
      { contextClock: new Float32Array(128).fill(NaN) }, stopped, jumping, backwards]) {
      const { counters } = sequence([[0, clock], [128, clock], [256, clock]]);
      assert.equal(counters.frameLabelFaults, 3);
      assert.equal(counters.faultLog[0].kind, 'native clock unreadable');
    }
    // And without its clock, a first block behind isn't relabelled.
    const unread = sequence([[512, undefined], [896, 896], [1024, 1024]]).counters;
    assert.equal(unread.initialFrameLabel, null);
    assert.equal(unread.contextFrameGaps, 1);
  });

  test("Chromium's x86 ramp, added up in float32 four samples at a time, still reads after ten minutes", () => {
    // ProcessLinearRamp in audio_param_handler.cc: each block starts from
    // its own time, then each of four lanes adds 4 / sampleRate 32 times.
    const x86 = (frame) => {
      const values = new Float32Array(128);
      const lanes = [0, 1, 2, 3].map((lane) => Math.fround(Math.fround(frame / RATE) + Math.fround(lane / RATE)));
      const step = Math.fround(4 / RATE);
      for (let i = 0; i < 128; i += 4) {
        for (let lane = 0; lane < 4; lane++) {
          values[i + lane] = lanes[lane];
          lanes[lane] = Math.fround(lanes[lane] + step);
        }
      }
      return { contextClock: values };
    };
    const at = 600 * RATE;
    const { counters } = sequence([0, 128, 256, 384].map((frame) => [at + frame, x86(at + frame)]));
    assert.equal(counters.frameLabelFaults, 0);
    const hidden = sequence([0, 128, 384, 512].map((frame, index) => [at + [0, 128, 256, 384][index], x86(at + frame)])).counters;
    assert.equal(hidden.frameLabelFaults, 1);
  });

  test('float32 keeps the clock within half a block after an hour', () => {
    const hour = 3600 * RATE;
    const { counters } = sequence([0, 128, 256, 384].map((frame) => [hour + frame, nativeClock(hour + frame)]));
    assert.equal(counters.frameLabelFaults, 0);
    const skipped = sequence([0, 128, 512, 640].map((frame) => [hour + frame, nativeClock(hour + frame)])).counters;
    assert.equal(skipped.contextFrameGaps, 1);
    assert.equal(skipped.frameLabelFaults, 0);
  });
});

describe("the audio recorder's block length", () => {
  // Renders blocks of `sizes` frames one after the other from context frame
  // `from`, as the browser would, and calls the real worklet for each block
  // not in `skip` (its index in `sizes`): a skipped block is a callback the
  // recorder never got, not changed samples. Each block's native clock and
  // its samples come from the frame it really is (the left channel counts
  // frames, one step of 2^-20 each), never from the label it is given:
  // `labels` maps a block's index to another currentFrame, and the rest
  // carry their real one.
  function render({ sizes, skip = [], labels = {}, from = 512, rate = RATE, batchFrames = 4096 }) {
    const { sandbox, node } = loadRecorder({ batchFrames, poolSize: 8, rate });
    let frame = from;
    sizes.forEach((frames, index) => {
      const real = frame;
      frame += frames;
      if (skip.includes(index)) return;
      sandbox.currentFrame = labels[index] ?? real;
      const input = [Float32Array.from({ length: frames }, (_, i) => (real + i + 1) / 2 ** 20), new Float32Array(frames)];
      node.process([input], [[new Float32Array(frames), new Float32Array(frames)]], nativeClock(real, { length: frames, rate }));
    });
    // Flushes what is left into a batch, as a full one would be.
    if (node.fill) node.flush();
    const batches = sandbox.messages.filter(({ type }) => type === 'batch');
    // The recorded left channel, as the frame numbers the samples carry.
    const played = batches.flatMap((batch) =>
      Array.from(new Float32Array(batch.buffer).subarray(0, batch.frames), (value) => Math.round(value * 2 ** 20) - 1)
    );
    return { counters: node.counters(), batches, played };
  }
  const sum = (sizes) => sizes.reduce((total, frames) => total + frames, 0);

  for (const rate of [44_100, 48_000]) {
    test(`a block left out after a block of another length is a fault, never a relabelled first block (${rate} Hz)`, () => {
      // The review's cases: 128 frames left out after a first block of 512,
      // and 64 after 256. Within half a block of 512 (or of 256), the native
      // clock moving 640 (or 320) frames looks like one block, so the
      // recorder used to relabel the first block 128 (or 64) frames on and
      // count no gap at all.
      for (const sizes of [[512, 128, 128, 128, 128], [256, 64, 512, 128]]) {
        const { counters, played } = render({ sizes, skip: [1], rate });
        assert.equal(counters.initialFrameLabel, null, `${sizes}`);
        assert.equal(counters.firstContextFrame, 512, `${sizes}`);
        assert.ok(counters.frameLabelFaults >= 1, `${sizes}`);
        assert.equal(counters.faultLog[0].kind, 'block length changed', `${sizes}`);
        assert.deepEqual({ frames: counters.faultLog[0].frames, blockFrames: counters.faultLog[0].blockFrames }, { frames: sizes[2], blockFrames: sizes[0] });
        // The samples really are missing.
        assert.equal(played[sizes[0]] - played[sizes[0] - 1], 1 + sizes[1], `${sizes}`);
      }
      // Lengths that change with nothing left out fail the same way: the
      // recorder can't tell them apart.
      for (const sizes of [[512, 128, 128, 128], [256, 64, 512, 128], [64, 256, 128, 64]]) {
        for (const labels of [{}, { 0: 0 }]) {
          const { counters } = render({ sizes, labels, rate });
          // Every block but a first one of 128 frames or more.
          assert.equal(counters.frameLabelFaults, sizes[0] < 128 ? sizes.length : sizes.length - 1, `${sizes}`);
          assert.equal(counters.initialFrameLabel, null, `${sizes}`);
        }
      }
      // And so does every later block of another length, after a first
      // block relabelled while the lengths were still the same.
      const changed = render({ sizes: [128, 128, 256, 256, 128], labels: { 0: 0 }, rate }).counters;
      assert.deepEqual({ ...changed.initialFrameLabel }, { raw: 0, corrected: 512, frames: 128 });
      assert.equal(changed.frameLabelFaults, 2);
      assert.deepEqual(Array.from(changed.faultLog, ({ kind }) => kind), ['block length changed', 'block length changed']);
      assert.deepEqual([...changed.blockSizes], [128, 256]);
    });

    test(`a block left out right after the first, at one length, is a gap of exactly that block (${rate} Hz)`, () => {
      for (const frames of [128, 256, 512]) {
        const sizes = Array(6).fill(frames);
        const { counters, played } = render({ sizes, skip: [1], rate });
        assert.equal(counters.contextFrameGaps, 1, `${frames}`);
        assert.equal(counters.skippedContextFrames, frames, `${frames}`);
        assert.equal(counters.frameLabelFaults, 0, `${frames}`);
        assert.equal(counters.initialFrameLabel, null, `${frames}`);
        assert.equal(counters.firstContextFrame, 512, `${frames}`);
        assert.equal(played[frames] - played[frames - 1], 1 + frames, `${frames}`);
        // Two left out, and one later on.
        const two = render({ sizes, skip: [1, 2], rate }).counters;
        assert.deepEqual([two.contextFrameGaps, two.skippedContextFrames, two.frameLabelFaults], [1, 2 * frames, 0], `${frames}`);
        const later = render({ sizes, skip: [3], rate }).counters;
        assert.deepEqual([later.contextFrameGaps, later.skippedContextFrames, later.frameLabelFaults], [1, frames, 0], `${frames}`);
        // Left out while the label stays in step: a fault, not a gap.
        const hidden = render({ sizes, skip: [3], labels: Object.fromEntries([4, 5].map((index) => [index, 512 + (index - 1) * frames])), rate }).counters;
        assert.equal(hidden.contextFrameGaps, 0, `${frames}`);
        assert.equal(hidden.faultLog[0].kind, 'native clock skipped frames the label did not', `${frames}`);
      }
    });

    test(`a first block numbered behind is relabelled at any one length of 128 frames or more (${rate} Hz)`, () => {
      for (const frames of [128, 256, 512]) {
        const sizes = Array(6).fill(frames);
        // Numbered a block, and four blocks, behind.
        for (const behind of [1, 4]) {
          const { counters, batches, played } = render({ sizes, labels: { 0: 512 - behind * frames }, rate });
          assert.equal(counters.frameLabelFaults, 0, `${frames} ${behind}`);
          assert.equal(counters.contextFrameGaps, 0, `${frames} ${behind}`);
          assert.equal(counters.firstContextFrame, 512, `${frames} ${behind}`);
          assert.deepEqual({ ...counters.initialFrameLabel }, { raw: 512 - behind * frames, corrected: 512, frames });
          // Every sample is there, and a mark at a context frame maps to
          // the sample played then.
          assert.equal(played.length, sum(sizes));
          assert.ok(played.every((value, index) => value === 512 + index));
          const offset = batches[0].contextFrame - batches[0].startFrame;
          assert.equal(played[1000 + 512 - offset - 512], 1000 + 512 - offset);
          assert.equal(offset, 512);
        }
        // Behind, then a block left out: no relabel, and a fault.
        const both = render({ sizes, skip: [1], labels: { 0: 512 - frames }, rate }).counters;
        assert.equal(both.initialFrameLabel, null, `${frames}`);
        assert.equal(both.contextFrameGaps, 1, `${frames}`);
        assert.ok(both.frameLabelFaults >= 1, `${frames}`);
      }
    });
  }

  test('blocks shorter than 128 frames fail every block, at one length too', () => {
    for (const frames of [64, 32]) {
      const { counters } = render({ sizes: Array(4).fill(frames) });
      assert.equal(counters.frameLabelFaults, 4, `${frames}`);
      assert.equal(counters.faultLog[0].kind, 'block too short');
      // Not even a first block behind is relabelled.
      const behind = render({ sizes: Array(4).fill(frames), labels: { 0: 512 - frames } }).counters;
      assert.equal(behind.initialFrameLabel, null);
      assert.ok(behind.frameLabelFaults >= 4);
    }
  });

  test('a length kept for an hour, or after ten minutes of float32, still tells one block from two', () => {
    for (const from of [600 * RATE, 3600 * RATE]) {
      for (const frames of [128, 512]) {
        const sizes = Array(5).fill(frames);
        assert.equal(render({ sizes, from }).counters.frameLabelFaults, 0, `${from} ${frames}`);
        const skipped = render({ sizes, from, skip: [2] }).counters;
        assert.deepEqual([skipped.contextFrameGaps, skipped.skippedContextFrames, skipped.frameLabelFaults], [1, frames, 0]);
      }
    }
  });
});

describe('audio recorder frame numbers', () => {
  function recorder() {
    const { sandbox, node } = loadRecorder();
    let value = 0;
    let next = null;
    const play = (frames) => {
      for (const frame of frames) {
        sandbox.currentFrame = frame;
        const block = [new Float32Array(128).fill(value), new Float32Array(128).fill(value)];
        value += 1;
        // The browser's native clock keeps advancing one block at a time
        // when a label is stale or goes back; a label that jumps ahead is
        // taken as frames really skipped.
        const real = Math.max(frame, next ?? frame);
        node.process([block], [[new Float32Array(128), new Float32Array(128)]], nativeClock(real));
        next = real + 128;
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
      node.process([input], [[new Float32Array(128), new Float32Array(128)]], nativeClock(frame));
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

  test('a span from the recording start counts the stale runs before its first frame', () => {
    // A recording delay (capture-observer.js) starts the recording with
    // silence, which a span from the recording start leaves out; a stale
    // run there is counted, and its sound isn't checked.
    const recording = record({ label: staleOnce });
    const from = FAULT + 4096;
    const later = recording.snapshots.get(from + 8192);
    const health = (fromFrame) =>
      spanHealth(later, recording.snapshots.get(TOTAL), recording.channels.map((samples) => samples.subarray(fromFrame)), fromFrame);
    assert.deepEqual(health(from), []);
    assert.deepEqual(health(FROM), []);
    // The same run left out of the log fails the count.
    const end = recording.snapshots.get(TOTAL);
    const unlogged = { ...end, recorder: { ...end.recorder, staleLog: [] } };
    const problems = spanHealth(later, unlogged, recording.channels.map((samples) => samples.subarray(from)), from, unlogged);
    assert.deepEqual(codes(problems), ['stale-label-unverified']);
  });

  test('a span said to start with the recording counts the runs between the first snapshot and its first frame', () => {
    // As when the effect turns on during a song: the first snapshot comes
    // with the recorder's first batch, and the span starts later, where the
    // delay's silence ends; a stale run comes between the two.
    const recording = record({ label: staleOnce });
    const from = FAULT + 4096;
    const first = recording.snapshots.get(FROM);
    const read = recording.channels.map((samples) => samples.subarray(from));
    const end = recording.snapshots.get(TOTAL);
    assert.ok(first.recorder.nextFrame < FAULT && FAULT < from);
    assert.deepEqual(spanHealth(first, end, read, from, end, { fromRecordingStart: true }), []);
    // Taken as an ordinary span, the run is the span's and isn't logged in it.
    assert.deepEqual(codes(spanHealth(first, end, read, from, end)), ['stale-label-unverified']);
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

  test('the sound recorded at a frame is placed at the wall time it was made', () => {
    // A snapshot at wall time 5000 ms with the context at 2 s; the recording
    // runs 0.25 s behind the context (frameOffset -12000 at 48 kHz), so
    // recorded frame 48000 was made at context time 0.75 s, 1.25 s earlier.
    const snapshot = { wallMs: 5000, context: { currentTime: 2, sampleRate: RATE }, recorder: { frameOffset: -12_000 } };
    assert.equal(soundWallMs(snapshot, 48_000), 3750);
    assert.equal(soundWallMs({ ...snapshot, recorder: { frameOffset: 0 } }, 48_000), 4000);
  });

  test("a pause from outside counts from the span's sound, with room for a late clock or event", () => {
    // The span's sound was made from 1002.7 ms by a page clock 128 frames
    // behind; a pause at 1001 ms touched it.
    const at = (atMs, type = 'pause') => ({ type, atMs });
    const counted = (events, options = {}) => outsidePauses({ events, startMs: 1002.6667, sampleRate: RATE, ...options }).map((event) => event.atMs);
    assert.deepEqual(counted([at(1001), at(1101, 'play')]), [1001]);
    // A batch early is the most a clock may lag before marks are out of step.
    assert.deepEqual(counted([at(1002.6667 - 2048 / 48 - 1), at(1002.6667 - 2048 / 48 + 1)]), [1002.6667 - 2048 / 48 + 1]);
    // An event heard long after the sound it stopped still counts.
    assert.deepEqual(counted([at(2275), at(60_000)]), [2275, 60_000]);
    // The check's own action, from its first mark to 100 ms after its last.
    const actions = [{ label: 'a pause' }];
    const marks = [{ label: 'a pause: before', wallMs: 1500 }, { label: 'a pause: after', wallMs: 1520 }];
    assert.deepEqual(counted([at(1510), at(1619), at(1621)], { actions, marks }), [1621]);
  });

  test('marks out of order, or before what was recorded, are out of step', () => {
    const mark = (label, recorderFrame, nextFrame) => ({ label, recorderFrame, nextFrame });
    assert.deepEqual(markProblems([mark('a', 4096, 4096), mark('b', 6000, 4096), mark('c', 6100, 6144)]), []);
    // Firefox's clock, read by a page, a block behind what was received.
    assert.deepEqual(markProblems([mark('a', 3968, 4096)]), []);
    assert.deepEqual(codes(markProblems([mark('a', 1000, 8192)])), ['mark-out-of-step']);
    assert.deepEqual(codes(markProblems([mark('a', 9000, 8192), mark('b', 8500, 8192)])), ['mark-out-of-step']);
    // With a recording delay, the sound made at a mark is recorded that much
    // later, so a mark falls that much further on.
    assert.deepEqual(markProblems([mark('a', 4096 + 12_000, 4096)], 12_000), []);
    assert.deepEqual(markProblems([mark('a', 3968 + 12_000, 4096)], 12_000), []);
    assert.deepEqual(codes(markProblems([mark('a', 4096 + 9000, 4096)], 12_000)), ['mark-out-of-step']);
    assert.deepEqual(markProblems([mark('a', 4096 + 9000, 4096)]), []);
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
    const player = new globalThis.EventTarget();
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
      for (const type of fires) setTimeout(() => player.dispatchEvent(new globalThis.Event(type)), 5);
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

describe('audio regression overlapping changes', () => {
  const STEP_MS = 30;
  const DRIVER = 'TEST_DRIVER';
  const PANS = [100, -100, 100, -100, 100, -100, 100, -100];
  const ENGINE_CHANNELS = ['SLOWED_REVERB_YOUTUBE', 'SLOWED_REVERB_SPOTIFY'];

  // Runs actions.js's pageSweep as the browser would: from its source, in a
  // context of its own, with a stand-in for the extension. Each request the
  // driver gets reaches the engine `delivery(index)` ms later (null: never)
  // and is answered `answer(index)` ms after that (null: never) with
  // `reply(index)`. `afterArrival(index)` runs 1 ms after a request reaches
  // the engine.
  //
  // By default the page runs on a clock of its own, so every time is exact:
  // a timer for `ms` goes off `timerMs(ms)` later, and `stall(ms)` moves the
  // clock on with nothing else running, as a busy page or Node does. With
  // `realTimers`, the page uses Node's own timers and performance.now().
  function inPage({
    delivery = () => 5,
    answer = () => 5,
    reply = () => ({ result: { success: true } }),
    afterArrival = () => {},
    timerMs = (ms) => ms,
    realTimers = false
  } = {}) {
    let now = 1000;
    let nextId = 0;
    const due = new Map();
    const schedule = realTimers
      ? (ms, callback) => setTimeout(callback, ms)
      : (ms, callback) => {
          const id = ++nextId;
          due.set(id, { at: now + Math.max(0, ms), id, callback });
          return id;
        };
    const unschedule = realTimers ? (id) => clearTimeout(id) : (id) => due.delete(id);
    const clock = realTimers ? globalThis.performance : { now: () => now };
    const stall = (ms) => {
      if (realTimers) {
        const started = Date.now();
        while (Date.now() - started < ms) {
          // Everything in this thread stops.
        }
      } else {
        now += ms;
      }
    };

    const window = new globalThis.EventTarget();
    let listening = 0;
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = (type, listener) => {
      listening++;
      add(type, listener);
    };
    window.removeEventListener = (type, listener) => {
      listening--;
      remove(type, listener);
    };
    const dispatch = (data) => {
      const event = new globalThis.Event('message');
      Object.assign(event, { data, source: window });
      window.dispatchEvent(event);
    };
    const posted = [];
    window.postMessage = (data) =>
      schedule(0, () => {
        dispatch(data);
        if (data.channel !== DRIVER || data.type !== 'APPLY') return;
        const index = posted.length;
        posted.push({ atMs: clock.now(), pan: data.settings.pan });
        const delay = delivery(index);
        if (delay !== null) {
          schedule(delay, () => {
            dispatch({ channel: 'SLOWED_REVERB_YOUTUBE', type: 'APPLY', settings: data.settings, enabled: data.enabled });
            schedule(1, () => afterArrival(index, stall));
          });
        }
        const wait = answer(index);
        if (wait !== null) {
          schedule((delay ?? 0) + wait, () => dispatch({ channel: DRIVER, type: 'RESULT', id: data.id, reply: JSON.stringify(reply(index)) }));
        }
      });

    const timers = new Set();
    const sandbox = {
      window,
      performance: clock,
      setTimeout: (callback, ms) => {
        const id = schedule(timerMs(ms), () => {
          timers.delete(id);
          callback();
        });
        timers.add(id);
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
        unschedule(id);
      }
    };
    const sweep = vm.runInNewContext(`(${pageSweep.toString()})`, sandbox);

    // Runs the sweep, and on the page's own clock everything due, in order.
    async function evaluate(options) {
      let done = false;
      const result = sweep(options).finally(() => {
        done = true;
      });
      if (!realTimers) {
        for (let events = 0; ; events++) {
          await new Promise((resolve) => setImmediate(resolve));
          if (done) break;
          assert.ok(events < 10_000, 'the sweep never finished');
          const next = [...due.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
          assert.ok(next, 'the sweep waits for nothing that is due');
          due.delete(next.id);
          now = Math.max(now, next.at);
          next.callback();
        }
      }
      return result;
    }
    const run = (options = {}) =>
      evaluate({
        channel: DRIVER,
        engineChannels: ENGINE_CHANNELS,
        requests: PANS.map((pan) => ({ settings: { speed: 0.8, pan }, enabled: true })),
        stepMs: STEP_MS,
        receiptMs: 1000,
        replyMs: 1000,
        ...options
      });
    return { run, posted, timers, now: () => clock.now(), listening: () => listening, page: { evaluate: (fn, arg) => evaluate(arg) } };
  }

  const arrivalGaps = (result) => Array.from(result.requests.slice(1), (request, index) => request.receiptMs - result.requests[index].receiptMs);

  // Each request is sent only after the one before reached the engine, and
  // not before STEP_MS after that, less the lower median time to get there.
  // The sweep returns its times rounded to 0.1 ms, so the bound worked out
  // from them can be off by 0.05 (the arrival) + 0.1 (a time to get there)
  // and the time sent by 0.05: 0.2 ms in all. Timers themselves get no
  // allowance.
  function assertPaced(result) {
    for (const [index, request] of result.requests.entries()) {
      if (index === 0) continue;
      const before = result.requests[index - 1];
      const usual = result.requests.slice(0, index).map((entry) => entry.receiptMs - entry.sentMs).sort((a, b) => a - b);
      const median = usual[Math.floor((usual.length - 1) / 2)];
      const notBefore = before.receiptMs + Math.max(0, STEP_MS - median);
      assert.ok(request.sentMs >= notBefore - 0.2 - 1e-9, `request ${index + 1} was sent ${(notBefore - request.sentMs).toFixed(2)} ms too soon: ${JSON.stringify(result.requests)}`);
    }
  }

  function assertCleanedUp(page) {
    assert.equal(page.listening(), 0);
    assert.equal(page.timers.size, 0);
  }

  test('requests reach the engine a step apart, sent one at a time, and the sweep cleans up', async () => {
    const page = inPage();
    const result = await page.run();
    assert.equal(result.stopped, null);
    assert.deepEqual(Array.from(result.requests, (request) => request.pan), PANS);
    assert.ok(result.requests.every((request) => request.reply?.result?.success === true && request.replyMs !== null));
    assertPaced(result);
    assert.deepEqual(arrivalGaps(result), [30, 30, 30, 30, 30, 30, 30]);
    assertCleanedUp(page);
  });

  test('a request that reaches the engine late delays the ones after it instead of bunching them', async () => {
    // The third takes 150 ms instead of 5. The fourth goes 25 ms after it
    // arrives, since one late arrival doesn't move the lower median.
    const result = await inPage({ delivery: (index) => (index === 2 ? 150 : 5) }).run();
    assert.equal(result.stopped, null);
    assertPaced(result);
    assert.deepEqual(arrivalGaps(result), [30, 175, 30, 30, 30, 30, 30]);
  });

  test('a page or Node side that stops for 150 ms during the sweep delays the requests after it instead of bunching them', async () => {
    // The stop starts 1 ms after the second request arrives, as in the
    // browser probe: the third is overdue when it ends and goes at once,
    // and the rest follow a step apart.
    const page = inPage({ afterArrival: (index, stall) => index === 1 && stall(150) });
    const result = await page.run();
    assert.equal(result.stopped, null);
    assertPaced(result);
    assert.deepEqual(arrivalGaps(result), [30, 156, 30, 30, 30, 30, 30]);
    assertCleanedUp(page);
  });

  test('timers that go off 1.5 ms early still send no request before its time', async () => {
    // Each goes off 1.5 ms early but after at least half its time, so the
    // sweep waits out the rest with shorter timers.
    const page = inPage({ timerMs: (ms) => Math.max(ms - 1.5, ms / 2) });
    const result = await page.run();
    assert.equal(result.stopped, null);
    assert.equal(result.requests.length, PANS.length);
    assertPaced(result);
    for (const gap of arrivalGaps(result)) assert.ok(gap >= 30 && gap <= 31, `arrivals ${gap} ms apart`);
    assertCleanedUp(page);
  });

  test('timers that keep going off at once stop the sweep after 5, and it cleans up', async () => {
    // Only the pacing's timers, which are never longer than a step; the
    // deadlines for arrivals and replies keep their time.
    const page = inPage({ timerMs: (ms) => (ms <= STEP_MS ? 0 : ms) });
    const result = await page.run();
    assert.match(result.stopped, /the page's timers went off early 5 times in a row before request 2 of 8, so no more were sent/);
    assert.equal(result.requests.length, 1);
    assert.equal(page.posted.length, 1);
    assert.ok(result.requests[0].reply?.result?.success);
    assertCleanedUp(page);
  });

  test('a request that never reaches the engine stops the sweep there, at its deadline, and it cleans up', async () => {
    const page = inPage({ delivery: (index) => (index === 3 ? null : 5) });
    const result = await page.run({ receiptMs: 100, replyMs: 100 });
    assert.match(result.stopped, /request 4 of 8 didn't reach the engine within 100 ms, so no more were sent/);
    assert.equal(result.requests.length, 4);
    assert.equal(page.posted.length, 4);
    assert.equal(result.requests[3].receiptMs, null);
    assert.equal(page.now(), result.requests[3].sentMs + 100);
    assertCleanedUp(page);
  });

  test('a reply that never comes, or an error, fails on the Node side as the single requests do', async () => {
    const silent = inPage({ answer: (index) => (index === 5 ? null : 5) });
    const result = await silent.run({ replyMs: 100 });
    assert.equal(result.stopped, null);
    assert.equal(result.requests[5].reply, null);
    assert.equal(silent.now(), result.requests[7].sentMs + 100);
    assertCleanedUp(silent);
    const options = { channel: DRIVER, engineChannels: ENGINE_CHANNELS, requests: PANS.map((pan) => ({ settings: { pan }, enabled: true })), stepMs: STEP_MS };
    await assert.rejects(
      runSweep(inPage({ answer: (index) => (index === 5 ? null : 5) }).page, { ...options, replyMs: 100 }),
      /no reply from the extension's test driver within 100 ms of the sweep's last request \(request 6\)/
    );
    await assert.rejects(
      runSweep(inPage({ reply: (index) => (index === 2 ? { error: 'refused' } : { result: {} }) }).page, options),
      /applying settings failed: refused \(request 3 of the sweep\)/
    );
  });

  test("with Node's own timers, which can go off early, no request is sent before its time", async () => {
    // Node's timers count whole milliseconds, so one can go off up to about
    // a millisecond early by performance.now(), or more when the event loop
    // is busy. This is how the check failed on a hosted runner before the
    // sweep checked the time again after each timer.
    const page = inPage({
      realTimers: true,
      delivery: (index) => (index === 2 ? 150 : 5),
      afterArrival: (index, stall) => index === 4 && stall(150)
    });
    const result = await page.run();
    assert.equal(result.stopped, null);
    assert.equal(result.requests.length, PANS.length);
    assertPaced(result);
    assertCleanedUp(page);
  });

  test("a page that doesn't answer fails on the Node side, within the action's own limit", async () => {
    assert.ok(sweepLimitMs(PANS.length, { stepMs: STEP_MS }) + PAGE_BACKSTOP_MS < ACTION_LIMIT_MS);
    const page = { evaluate: () => new Promise(() => {}) };
    const started = Date.now();
    await assert.rejects(
      runSweep(page, { channel: DRIVER, engineChannels: [], requests: [{ settings: {}, enabled: true }], stepMs: 10, receiptMs: 10, replyMs: 10, backstopMs: 10 }),
      (error) => error.code === 'timeout' && /didn't finish the sweep/.test(error.message)
    );
    assert.ok(Date.now() - started < 1000);
  });
});

describe("the reverb's tail in the suite's steady stretches", () => {
  const { dryExpect, effectExpect, ringingTones, withoutRinging } = require('../e2e/audio-capture/regression');
  const { ENGINE_SETTINGS } = require('../e2e/audio-capture/harness');

  test('only a tone heard before and gone now is left to the tail, and only with reverb on', () => {
    // The changes of the transitions check, in order.
    const reverb = { ...ENGINE_SETTINGS, reverb: 40 };
    const middle = { ...reverb, pan: 0 };
    const slower = { ...middle, speed: 0.9 };
    const swept = { ...slower, pan: -100 };
    const kept = { ...swept, keepPitch: true };
    const following = { ...kept, keepPitch: false };
    const steps = [
      [effectExpect(ENGINE_SETTINGS), reverb, []],
      [effectExpect(reverb), middle, []],
      [effectExpect(middle), slower, []],
      [effectExpect(slower), swept, []],
      // The pitch the player had before rings at 396 Hz, then at 440 Hz.
      [effectExpect(swept), kept, [396]],
      [effectExpect(kept), following, [440]],
      // Turning the effect back on: the song itself, 440 Hz, rings.
      [dryExpect(), following, [440]]
    ];
    for (const [previous, settings, ringing] of steps) {
      assert.deepEqual(ringingTones(previous, effectExpect(settings), settings), ringing, JSON.stringify(settings));
    }
    // Without reverb nothing rings, so the stretch is checked at once.
    assert.deepEqual(ringingTones(effectExpect({ ...swept, reverb: 0 }), effectExpect({ ...kept, reverb: 0 }), { ...kept, reverb: 0 }), []);
  });

  test('the stretch before the tail ends still checks every other tone', () => {
    const settings = { ...ENGINE_SETTINGS, reverb: 40, speed: 0.9, keepPitch: true };
    const expect = effectExpect(settings);
    const early = withoutRinging(expect, [396]);
    // 396 Hz is still measured, with no limit.
    assert.deepEqual(early.channels[0].tones.slice(0, 2), expect.channels[0].tones.slice(0, 2));
    assert.deepEqual(early.channels[0].tones[2], { hz: 396, min: 0, ringing: true });
    // A loud 396 Hz passes the stretch before the tail ends and is kept with
    // it; a missing 660 Hz still fails there. The full expectation fails it.
    const left = sum(sine(440, 0.27), sine(396, 0.1));
    const span = (segmentExpect) =>
      analyzeSpan({ sampleRate: RATE, fromFrame: 0, left, right: new Float32Array(left.length), segments: [{ label: 'keep the pitch', fromFrame: 0, toFrame: left.length, expect: segmentExpect }] });
    const ringingSpan = span(early);
    assert.deepEqual(ringingSpan.problems.map(({ message }) => message.replace(/ at .*/, '')), ['keep the pitch: channel 0: 660 Hz']);
    assert.ok(Math.abs(ringingSpan.segments[0].channels[0].tones.find(({ expectedHz }) => expectedHz === 396).amplitude - 0.1) < 1e-3);
    assert.equal(span(expect).problems.length, 2);
    assert.match(span(expect).problems[1].message, /396 Hz at 0.0999\d* \(wanted 0 to 0.02\)/);
    assert.deepEqual(early.channels[1], expect.channels[1]);
    assert.deepEqual(early.media, expect.media);
    // The full expectation, 396 Hz under 0.02 included, is left as it was
    // for the stretch after the tail.
    assert.deepEqual(expect.channels[0].tones.map(({ hz, max }) => [hz, max]), [[440, 0.5], [660, 0.5], [396, 0.02]]);
  });
});
