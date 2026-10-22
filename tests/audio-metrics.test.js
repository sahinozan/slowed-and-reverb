'use strict';

// Checks the audio capture trial's measurements (e2e/audio-capture/metrics.js)
// against computed signals, and that its health checks reject bad windows.
// No browser or sound device is involved.

const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  captureProblems,
  channelStats,
  dominantTone,
  maxSilentRunMs,
  measureWindow,
  toneNear
} = require('../e2e/audio-capture/metrics');
const { root } = require('./helpers/load-script');

const RATE = 48_000;

function sine(hz, amplitude, seconds = 1, rate = RATE) {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return samples;
}

function encode(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
}

// Two page snapshots one second apart, as the trial's observer reports
// them, with the recorded samples in between.
function window({ left, right, contextAdvance = 1, state = 'running', lostFrames = 0, overflowFrames = 0, spanned, media } = {}) {
  const frames = left.length;
  const recorder = (nextFrame, lost, overflow, contextFrame) => ({
    ready: true,
    error: null,
    workletSampleRate: RATE,
    firstContextFrame: 0,
    nextFrame,
    lostFrames: lost,
    overflowFrames: overflow,
    contextFrameGaps: 0,
    emptyInputBlocks: 0,
    nonStereoBlocks: 0,
    blockSizes: [128],
    maxArrivalGapMs: 43,
    lastBatch: { startFrame: nextFrame - 2048, frames: 2048, contextFrame: contextFrame - 2048 }
  });
  const context = (currentTime) => ({ state, currentTime, sampleRate: RATE, destination: null });
  const player = (clock) =>
    media === null ? null : { clock, paused: false, ended: false, muted: false, volume: 1, playbackRate: 1, ...media };
  const before = {
    wallMs: 1000,
    contextCount: 1,
    errors: [],
    context: context(5),
    recorder: recorder(4096, 0, 0, 4096),
    media: player(2)
  };
  const after = {
    wallMs: 2000,
    contextCount: 1,
    errors: [],
    context: context(5 + contextAdvance),
    recorder: recorder(4096 + frames, lostFrames, overflowFrames, 4096 + (spanned ?? frames)),
    media: player(2 + (media?.advance ?? 1))
  };
  const read = { from: 4096, to: 4096 + frames, sampleRate: RATE, channels: [encode(left), encode(right)] };
  return { before, after, read };
}

function problemCodes(parts, expect, tones) {
  return captureProblems(measureWindow(parts.before, parts.after, parts.read, { tones }), expect).map(
    (problem) => problem.code
  );
}

const STEREO = {
  channels: [
    { tones: [{ hz: 440, min: 0.2, max: 0.3 }, { hz: 660, min: 0, max: 0.005 }] },
    { tones: [{ hz: 660, min: 0.2, max: 0.3 }] }
  ]
};
const STEREO_TONES = [[440, 660], [660]];

describe('audio capture trial measurements', () => {
  test('reads the level and frequency of a known tone', () => {
    const tone = sine(352, 0.25);
    const near = toneNear(tone, RATE, 352);
    assert.ok(Math.abs(near.hz - 352) < 0.2, JSON.stringify(near));
    assert.ok(Math.abs(near.amplitude - 0.25) < 0.0025, JSON.stringify(near));
    assert.ok(toneNear(tone, RATE, 528).amplitude < 0.001);

    const mixed = sine(528, 0.1).map((value, i) => value + tone[i]);
    assert.ok(Math.abs(dominantTone(mixed, RATE).hz - 352) < 0.2);
  });

  test('counts non-finite and clipped samples and finds silent stretches', () => {
    const samples = sine(440, 0.5, 0.1);
    assert.ok(Math.abs(channelStats(samples).rms - 0.5 / Math.SQRT2) < 0.001);
    samples[10] = NaN;
    samples[11] = Infinity;
    samples[12] = 1.5;
    const stats = channelStats(samples);
    assert.equal(stats.nonFinite, 2);
    assert.equal(stats.clipped, 1);

    const left = sine(440, 0.25);
    left.fill(0, RATE / 4, RATE / 4 + RATE / 10);
    const silentRun = maxSilentRunMs(left, new Float32Array(left.length), RATE);
    assert.ok(silentRun >= 90 && silentRun <= 100, String(silentRun));
  });

  test('a healthy stereo window has no problems', () => {
    const parts = window({ left: sine(440, 0.25), right: sine(660, 0.25), media: {} });
    assert.deepEqual(problemCodes(parts, { ...STEREO, media: { rate: 1 } }, STEREO_TONES), []);
  });

  test('silence, swapped channels and a muted player are not healthy', () => {
    const silent = window({ left: new Float32Array(RATE), right: new Float32Array(RATE) });
    assert.ok(problemCodes(silent, {}).includes('no-signal'));

    const swapped = window({ left: sine(660, 0.25), right: sine(440, 0.25) });
    assert.ok(problemCodes(swapped, STEREO, STEREO_TONES).includes('tone-missing'));

    const muted = window({ left: sine(440, 0.25), right: sine(660, 0.25), media: { muted: true } });
    assert.deepEqual(problemCodes(muted, { media: { rate: 1 } }), ['media-muted']);
  });

  test('a stopped clock, lost frames or bad samples fail, whatever the signal', () => {
    const tones = { left: sine(440, 0.25), right: sine(660, 0.25) };
    assert.ok(problemCodes(window({ ...tones, contextAdvance: 0, state: 'suspended' })).includes('clock-stalled'));
    assert.ok(problemCodes(window({ ...tones, state: 'suspended' })).includes('not-running'));
    assert.ok(problemCodes(window({ ...tones, overflowFrames: 2048 })).includes('frames-lost'));
    assert.ok(problemCodes(window({ ...tones, spanned: RATE + 2048 })).includes('frame-mismatch'));

    const left = sine(440, 0.25);
    left[100] = NaN;
    assert.ok(problemCodes(window({ left, right: tones.right })).includes('non-finite'));

    const short = window({ left: sine(440, 0.25, 0.25), right: sine(660, 0.25, 0.25) });
    assert.ok(problemCodes(short).includes('frames-stalled'));
  });

  test('a player at the wrong speed fails', () => {
    const parts = window({ left: sine(352, 0.25), right: sine(528, 0.25), media: { advance: 1 } });
    assert.ok(problemCodes(parts, { media: { rate: 0.8 } }).includes('media-rate'));
  });
});

describe('audio capture trial files', () => {
  // The trial needs a sound device and runs only through its own scripts.
  test('stay out of npm test and the Playwright smoke tests', () => {
    const files = fs.readdirSync(path.join(root, 'e2e', 'audio-capture'));
    const playwrightDefault = /\.(spec|test)\.[cm]?[jt]sx?$/;
    const nodeTestDefault = /(^test(-.+)?\.[cm]?js$)|([.\-_]test\.[cm]?js$)/;
    assert.ok(files.includes('chromium-trial.js'));
    for (const file of files) {
      assert.doesNotMatch(file, playwrightDefault, file);
      assert.doesNotMatch(file, nodeTestDefault, file);
    }
    const config = fs.readFileSync(path.join(root, 'playwright.config.js'), 'utf8');
    assert.doesNotMatch(config, /testMatch|audio-capture/);
  });
});
