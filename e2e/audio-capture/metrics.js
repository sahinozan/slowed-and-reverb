'use strict';

// Measurements of recorded audio for the audio capture trial (README.md in
// this folder), and the checks that decide whether a capture is healthy.
// This file knows nothing about the extension's settings or graphs, and
// tests/audio-metrics.test.js checks it against computed signals.

// Below this RMS (-40 dBFS) a channel counts as carrying no signal. The
// trial's tones play at 0.25 (RMS 0.177, -15 dBFS).
const SIGNAL_FLOOR_RMS = 0.01;
// A 5 ms stretch quieter than this (-80 dBFS) counts as silent.
const SILENT_RMS = 1e-4;
// How far the context clock, the recorded frames and the player may run
// from the wall clock over a window. Wide on purpose: this catches a stopped
// or runaway clock, not small drift.
const CLOCK_RATE_RANGE = [0.5, 1.5];
const MEDIA_RATE_TOLERANCE = 0.15;
const ANALYSIS_SECONDS = 0.5;

function decodeChannels(read) {
  return read.channels.map((text) => {
    const bytes = Buffer.from(text, 'base64');
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return new Float32Array(copy.buffer);
  });
}

const hannWindows = new Map();
function hann(length) {
  let window = hannWindows.get(length);
  if (!window) {
    window = new Float64Array(length);
    for (let i = 0; i < length; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    hannWindows.set(length, window);
  }
  return window;
}

// The amplitude of the sine at `hz` in `samples` (Goertzel, Hann window).
// A sine of amplitude A at exactly `hz` reads close to A.
function toneAmplitude(samples, sampleRate, hz) {
  const length = samples.length;
  if (length < 2) return 0;
  const window = hann(length);
  const coefficient = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let previous = 0;
  let beforePrevious = 0;
  let windowSum = 0;
  for (let i = 0; i < length; i++) {
    const current = samples[i] * window[i] + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
    windowSum += window[i];
  }
  const power = previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious;
  return (2 * Math.sqrt(Math.max(0, power))) / windowSum;
}

function analysisSlice(samples, sampleRate) {
  return samples.subarray(0, Math.min(samples.length, Math.round(ANALYSIS_SECONDS * sampleRate)));
}

function scan(samples, sampleRate, low, high, step) {
  let best = { hz: low, amplitude: -1 };
  for (let hz = low; hz <= high; hz += step) {
    const amplitude = toneAmplitude(samples, sampleRate, hz);
    if (amplitude > best.amplitude) best = { hz, amplitude };
  }
  return best;
}

// The strongest tone within `tolerance` (a fraction) of `hz`.
function toneNear(samples, sampleRate, hz, tolerance = 0.03) {
  const slice = analysisSlice(samples, sampleRate);
  const coarse = scan(slice, sampleRate, hz * (1 - tolerance), hz * (1 + tolerance), 0.5);
  const fine = scan(slice, sampleRate, coarse.hz - 0.5, coarse.hz + 0.5, 0.05);
  return { hz: round(fine.hz, 2), amplitude: round(fine.amplitude, 5) };
}

// The strongest tone between minHz and maxHz.
function dominantTone(samples, sampleRate, minHz = 40, maxHz = 4000) {
  const slice = analysisSlice(samples, sampleRate);
  const coarse = scan(slice, sampleRate, minHz, maxHz, 2);
  const fine = scan(slice, sampleRate, coarse.hz - 2, coarse.hz + 2, 0.05);
  return { hz: round(fine.hz, 2), amplitude: round(fine.amplitude, 5) };
}

function channelStats(samples) {
  let sumSquares = 0;
  let sum = 0;
  let peak = 0;
  let nonFinite = 0;
  let clipped = 0;
  let finite = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      nonFinite++;
      continue;
    }
    finite++;
    sum += sample;
    sumSquares += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    if (magnitude >= 1) clipped++;
  }
  return {
    rms: round(finite ? Math.sqrt(sumSquares / finite) : 0, 6),
    peak: round(peak, 6),
    mean: round(finite ? sum / finite : 0, 6),
    nonFinite,
    clipped
  };
}

// The longest run of 5 ms stretches in which both channels are silent.
function maxSilentRunMs(left, right, sampleRate) {
  const step = Math.max(1, Math.round(sampleRate * 0.005));
  let run = 0;
  let longest = 0;
  for (let start = 0; start + step <= left.length; start += step) {
    let sumSquares = 0;
    for (let i = start; i < start + step; i++) sumSquares += Math.max(left[i] ** 2, right[i] ** 2) || 0;
    if (Math.sqrt(sumSquares / step) < SILENT_RMS) {
      run += step;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return round((longest / sampleRate) * 1000, 1);
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function difference(after, before, key) {
  return (after?.[key] ?? 0) - (before?.[key] ?? 0);
}

// Turns two snapshots of the page and the samples recorded between them
// into numbers. `tones` lists, per channel, the frequencies to measure.
function measureWindow(before, after, read, { tones = [[], []] } = {}) {
  const channels = read ? decodeChannels(read) : [new Float32Array(0), new Float32Array(0)];
  const sampleRate = after.context?.sampleRate ?? read?.sampleRate ?? 0;
  const wallSeconds = (after.wallMs - before.wallMs) / 1000;
  const frames = channels[0].length;
  const contextAdvance = (after.context?.currentTime ?? 0) - (before.context?.currentTime ?? 0);
  const recorderBefore = before.recorder ?? {};
  const recorderAfter = after.recorder ?? {};
  const batchEnd = (recorder) =>
    recorder.lastBatch ? recorder.lastBatch.contextFrame + recorder.lastBatch.frames : null;
  const spanEnd = batchEnd(recorderAfter);
  const spanStart = batchEnd(recorderBefore);
  const mediaAdvance = (after.media?.clock ?? 0) - (before.media?.clock ?? 0);

  return {
    wallSeconds: round(wallSeconds, 4),
    sampleRate,
    workletSampleRate: recorderAfter.workletSampleRate ?? null,
    states: [before.context?.state ?? null, after.context?.state ?? null],
    contextAdvance: round(contextAdvance, 5),
    contextRate: round(wallSeconds > 0 ? contextAdvance / wallSeconds : 0, 4),
    frames,
    recordedSeconds: round(sampleRate ? frames / sampleRate : 0, 5),
    recordedRate: round(wallSeconds > 0 && sampleRate ? frames / sampleRate / wallSeconds : 0, 4),
    // Context frames between the last batches of the two snapshots; with
    // nothing dropped this equals `frames`.
    contextFramesSpanned: spanEnd !== null && spanStart !== null ? spanEnd - spanStart : null,
    firstContextFrame: recorderAfter.firstContextFrame ?? null,
    recorderReady: Boolean(recorderAfter.ready),
    recorderError: recorderAfter.error ?? null,
    lostFrames: difference(recorderAfter, recorderBefore, 'lostFrames'),
    overflowFrames: difference(recorderAfter, recorderBefore, 'overflowFrames'),
    contextFrameGaps: difference(recorderAfter, recorderBefore, 'contextFrameGaps'),
    emptyInputBlocks: difference(recorderAfter, recorderBefore, 'emptyInputBlocks'),
    nonStereoBlocks: difference(recorderAfter, recorderBefore, 'nonStereoBlocks'),
    blockSizes: recorderAfter.blockSizes ?? [],
    // How late the page heard about recorded audio: message timing only,
    // not a gap in the audio.
    maxMessageGapMs: round(recorderAfter.maxArrivalGapMs ?? 0, 1),
    errors: after.errors ?? [],
    contextCount: after.contextCount ?? 0,
    destination: after.context?.destination ?? null,
    media: after.media
      ? {
          advance: round(mediaAdvance, 4),
          rate: round(wallSeconds > 0 ? mediaAdvance / wallSeconds : 0, 4),
          paused: after.media.paused,
          ended: after.media.ended,
          muted: after.media.muted,
          volume: after.media.volume,
          playbackRate: after.media.playbackRate
        }
      : null,
    maxSilentRunMs: frames ? maxSilentRunMs(channels[0], channels[1], sampleRate) : null,
    channels: channels.map((samples, index) => ({
      ...channelStats(samples),
      dominant: frames ? dominantTone(samples, sampleRate) : null,
      tones: (tones[index] ?? []).map((hz) => ({ expectedHz: hz, ...toneNear(samples, sampleRate, hz) }))
    }))
  };
}

// Every reason a measured window isn't a healthy capture. `expect.media`
// ({ rate }) asks for a playing, unmuted player at that rate; each entry of
// `expect.channels` can ask for tones ({ hz, min, max }) or near-silence
// ({ maxRms }).
function captureProblems(m, expect = {}) {
  const problems = [];
  const fail = (code, message) => problems.push({ code, message });

  if (m.errors.length) fail('observer-error', m.errors.join('; '));
  if (m.contextCount === 0 || m.sampleRate === 0) fail('no-context', 'no audio context was observed');
  if (m.recorderError) fail('recorder-error', m.recorderError);
  if (!m.recorderReady) fail('recorder-not-ready', 'the recorder never started');
  if (m.states.some((state) => state !== 'running')) fail('not-running', `context states ${m.states.join(' -> ')}`);
  if (m.wallSeconds < 0.25) fail('window-too-short', `window of ${m.wallSeconds} s`);
  if (m.workletSampleRate !== m.sampleRate) {
    fail('sample-rate-mismatch', `recorder at ${m.workletSampleRate} Hz, context at ${m.sampleRate} Hz`);
  }
  const [low, high] = CLOCK_RATE_RANGE;
  if (!(m.contextRate >= low && m.contextRate <= high)) {
    fail('clock-stalled', `context clock advanced ${m.contextAdvance} s in ${m.wallSeconds} s`);
  }
  if (m.frames === 0) fail('no-frames', 'no frames were recorded');
  else if (!(m.recordedRate >= low && m.recordedRate <= high)) {
    fail('frames-stalled', `${m.frames} frames (${m.recordedSeconds} s) in ${m.wallSeconds} s`);
  }
  if (m.lostFrames !== 0 || m.overflowFrames !== 0) {
    fail('frames-lost', `${m.lostFrames} frames lost, ${m.overflowFrames} dropped by the recorder`);
  }
  if (m.contextFrameGaps !== 0) fail('context-gap', `${m.contextFrameGaps} skipped render blocks`);
  if (m.contextFramesSpanned !== null && m.contextFramesSpanned !== m.frames) {
    fail('frame-mismatch', `${m.frames} frames recorded over ${m.contextFramesSpanned} context frames`);
  }
  if (m.nonStereoBlocks !== 0) fail('not-stereo', `${m.nonStereoBlocks} blocks without two channels`);
  if (m.emptyInputBlocks !== 0) fail('no-input', `${m.emptyInputBlocks} blocks with nothing connected`);
  const nonFinite = m.channels.reduce((sum, channel) => sum + channel.nonFinite, 0);
  if (nonFinite) fail('non-finite', `${nonFinite} samples are not finite`);
  if (!m.channels.some((channel) => channel.rms >= SIGNAL_FLOOR_RMS)) {
    fail('no-signal', `channel RMS ${m.channels.map((channel) => channel.rms).join(', ')}`);
  }

  (expect.channels ?? []).forEach((wanted, index) => {
    const channel = m.channels[index];
    if (!wanted || !channel) return;
    for (const tone of wanted.tones ?? []) {
      const found = channel.tones.find((measured) => measured.expectedHz === tone.hz);
      const amplitude = found?.amplitude ?? 0;
      if (!(amplitude >= tone.min && amplitude <= (tone.max ?? Infinity))) {
        fail(
          'tone-missing',
          `channel ${index}: ${tone.hz} Hz at ${amplitude} (wanted ${tone.min} to ${tone.max ?? 'any'}), ` +
            `strongest ${channel.dominant?.hz} Hz at ${channel.dominant?.amplitude}`
        );
      }
    }
    if (wanted.maxRms !== undefined && !(channel.rms <= wanted.maxRms)) {
      fail('channel-not-silent', `channel ${index}: RMS ${channel.rms} (wanted at most ${wanted.maxRms})`);
    }
  });

  if (expect.media) {
    const media = m.media;
    if (!media) fail('no-media', 'no player on the page');
    else {
      if (media.paused || media.ended) fail('media-stopped', `paused ${media.paused}, ended ${media.ended}`);
      if (media.muted || !(media.volume > 0)) fail('media-muted', `muted ${media.muted}, volume ${media.volume}`);
      if (Math.abs(media.rate - expect.media.rate) > expect.media.rate * MEDIA_RATE_TOLERANCE) {
        fail('media-rate', `player advanced ${media.advance} s in ${m.wallSeconds} s (wanted rate ${expect.media.rate})`);
      }
    }
  }
  return problems;
}

// The problems that still leave a window's levels meaningful: silence, with
// or without anything connected, is a level like any other. Anything else
// (a failed clock or recorder, lost frames, samples that aren't numbers...)
// means the window's levels can't be trusted.
const LEVEL_PROBLEMS = ['no-signal', 'no-input'];

// Compares tone levels between two runs. `reference` and `compared` are
// { label, results }, with results[key] a list of measured windows, and
// `picks` lists [key, channel, hz]. A window that isn't valid data, on
// either side, makes the comparison invalid instead of a difference in
// level; `invalid` then says why and `rows` is null. A level more than
// `toleranceDb` apart, or missing on one side (silence), counts as affected.
function compareLevels(reference, compared, picks, toleranceDb = 1) {
  const invalid = [];
  for (const { label, results } of [reference, compared]) {
    for (const key of new Set(picks.map(([key]) => key))) {
      const list = results?.[key];
      if (!list?.length) {
        invalid.push(`${label} ${key}: no measurements`);
        continue;
      }
      list.forEach((m, index) => {
        const problems = captureProblems(m).filter((problem) => !LEVEL_PROBLEMS.includes(problem.code));
        if (problems.length) {
          invalid.push(`${label} ${key} window ${index + 1}: ${problems.map(({ code, message }) => `${code}: ${message}`).join('; ')}`);
        }
      });
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const level = ({ label, results }, key, channel, hz) => {
    const values = results[key].map((m) => m.channels[channel]?.tones.find((tone) => tone.expectedHz === hz)?.amplitude);
    if (values.every((value) => Number.isFinite(value) && value >= 0)) return median(values);
    invalid.push(`${label} ${key}: ${hz} Hz on channel ${channel} wasn't measured`);
    return null;
  };
  const rows = invalid.length
    ? null
    : picks.map(([key, channel, hz]) => {
        const before = level(reference, key, channel, hz);
        const after = level(compared, key, channel, hz);
        return {
          capture: key,
          channel,
          hz,
          [reference.label]: before,
          [compared.label]: after,
          differenceDb: before > 0 && after > 0 ? round(20 * Math.log10(after / before), 2) : null
        };
      });
  if (invalid.length) return { invalid, rows: null, affected: null };
  return {
    invalid,
    rows,
    affected: rows.some((row) => row.differenceDb === null || Math.abs(row.differenceDb) > toleranceDb)
  };
}

function assertHealthyCapture(m, expect) {
  const problems = captureProblems(m, expect);
  if (problems.length) {
    const error = new Error(`unhealthy capture: ${problems.map(({ code, message }) => `${code}: ${message}`).join('; ')}`);
    error.problems = problems;
    throw error;
  }
}

module.exports = {
  LEVEL_PROBLEMS,
  SIGNAL_FLOOR_RMS,
  assertHealthyCapture,
  captureProblems,
  channelStats,
  compareLevels,
  decodeChannels,
  dominantTone,
  maxSilentRunMs,
  measureWindow,
  toneAmplitude,
  toneNear
};
