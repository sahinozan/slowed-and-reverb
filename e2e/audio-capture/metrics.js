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
    frameLabelFaults: difference(recorderAfter, recorderBefore, 'frameLabelFaults'),
    staleFrameLabels: difference(recorderAfter, recorderBefore, 'staleFrameLabels'),
    // The recorder's frame numbers across the window (frameLabelProblems).
    frameLabels: read ? frameLabelProblems(before, after, channels, read.from) : [],
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

// The problems with measured channels (measureWindow's or measureChannels'
// `channels`) against `expect.channels`: tones ({ hz, min, max }), a
// highest level ({ maxRms }, near-silence) or a lowest one ({ minRms }) per
// channel.
function signalProblems(channels, expect = {}) {
  const problems = [];
  const fail = (code, message) => problems.push({ code, message });
  (expect.channels ?? []).forEach((wanted, index) => {
    const channel = channels[index];
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
    if (wanted.minRms !== undefined && !(channel.rms >= wanted.minRms)) {
      fail('channel-silent', `channel ${index}: RMS ${channel.rms} (wanted at least ${wanted.minRms})`);
    }
  });

  return problems;
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
  problems.push(...(m.frameLabels ?? []));
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

  problems.push(...signalProblems(m.channels, expect));

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

// Continuity across a recorded span (the audio regression suite, README.md
// in this folder).
//
// A click is a sample whose third difference, in either channel, is above
// CLICK_THRESHOLD. The third difference of a sine of amplitude A at f Hz is
// at most A * (2 * sin(pi * f / sampleRate)) ** 3, under 0.002 for every
// tone the suite plays (up to 990 Hz at 0.6, at 44.1 kHz). A step of size d
// in the waveform gives 2 * d, so 0.05 is a step of 0.025 (-32 dBFS). Where
// nothing was wrong, the largest measured was 0.017 (Chromium's own small
// glitch as a player changes speed); the defects the suite's controls put
// back clicked at 0.33 and more at the changes their controls check
// (README.md in this folder).
const CLICK_THRESHOLD = 0.05;
// Clicks closer together than this are one click.
const CLICK_MERGE_MS = 5;
// A silent stretch is a run of 5 ms blocks below SILENT_RMS in both channels.
const SILENCE_BLOCK_MS = 5;

function thirdDifference(samples, i) {
  return samples[i] - 3 * samples[i - 1] + 3 * samples[i - 2] - samples[i - 3];
}

// The clicks in a stereo recording, as { frame, peak, channel }, `frame`
// counted from the first sample.
function findClicks(left, right, sampleRate, threshold = CLICK_THRESHOLD) {
  const merge = Math.round((CLICK_MERGE_MS / 1000) * sampleRate);
  const clicks = [];
  for (let i = 3; i < left.length; i++) {
    let peak = 0;
    let channel = 0;
    for (const [index, samples] of [left, right].entries()) {
      const value = Math.abs(thirdDifference(samples, i));
      if (value > peak) {
        peak = value;
        channel = index;
      }
    }
    if (!(peak > threshold)) continue;
    const last = clicks[clicks.length - 1];
    if (last && i - last.lastFrame <= merge) {
      last.lastFrame = i;
      if (peak > last.peak) Object.assign(last, { peak, channel });
    } else {
      clicks.push({ frame: i, lastFrame: i, peak, channel });
    }
  }
  return clicks.map(({ frame, lastFrame, peak, channel }) => ({ frame, frames: lastFrame - frame + 1, peak: round(peak, 4), channel }));
}

// Runs of silent 5 ms blocks, as { frame, frames }.
function silentRuns(left, right, sampleRate) {
  const step = Math.max(1, Math.round((sampleRate * SILENCE_BLOCK_MS) / 1000));
  const runs = [];
  let current = null;
  for (let start = 0; start + step <= left.length; start += step) {
    let sumSquares = 0;
    for (let i = start; i < start + step; i++) sumSquares += Math.max(left[i] ** 2, right[i] ** 2) || 0;
    if (Math.sqrt(sumSquares / step) < SILENT_RMS) {
      if (current) current.frames += step;
      else runs.push((current = { frame: start, frames: step }));
    } else {
      current = null;
    }
  }
  return runs;
}

// RMS of each channel per `stepMs`, rounded, for the evidence.
function envelope(left, right, sampleRate, stepMs = 10) {
  const step = Math.max(1, Math.round((sampleRate * stepMs) / 1000));
  const out = [];
  for (let start = 0; start + step <= left.length; start += step) {
    out.push([left, right].map((samples) => round(channelStats(samples.subarray(start, start + step)).rms, 4)));
  }
  return out;
}

// measureWindow's per-channel numbers for a stretch of samples.
function measureChannels(left, right, sampleRate, tones = [[], []]) {
  return [left, right].map((samples, index) => ({
    ...channelStats(samples),
    dominant: samples.length ? dominantTone(samples, sampleRate) : null,
    tones: (tones[index] ?? []).map((hz) => ({ expectedHz: hz, ...toneNear(samples, sampleRate, hz) }))
  }));
}

function toneLists(expect) {
  return [0, 1].map((index) => (expect?.channels?.[index]?.tones ?? []).map((tone) => tone.hz));
}

// Whether the recorder's frame numbers can be trusted across recorded
// samples (`channels`, from recorder frame `fromFrame` to the `after`
// snapshot's next frame; from the recording's start, counting what came
// before `before`, when `fromFrame` is before it). Any frame number out of
// step that isn't a stale label (recorder-worklet.js) fails, as
// `frame-label-fault`. A stale label is taken as the frame expected only
// where the sound shows no sign of a repeated or missing block: across each
// stale run, from its first sample to 3 after it, no third difference may be
// above CLICK_THRESHOLD in either channel (`stale-label-discontinuity`;
// Chromium's own measured 0.000048, a block planted repeated or missing 0.19
// to 0.52), and the run's samples may not repeat the block before them
// (`stale-label-repeat`). Either means the recording, not the sound, can't
// be told apart, so both are measurement failures. A run the recorder
// hasn't seen catch up, or that can't be checked, is `stale-label-unverified`.
// `settled` is a later snapshot, taken so a run near the end has caught up.
// `fromRecordingStart` says the span starts with the recording, so what
// happened before `before` counts too; by default, a span whose first frame
// was recorded before `before` does. With a recording delay
// (capture-observer.js), a span that starts at the context's first frame
// can begin after `before`, past the delay's silence, so it is said.
function frameLabelProblems(before, after, channels, fromFrame, settled = after, { fromRecordingStart: told } = {}) {
  const problems = [];
  const fail = (code, message) => problems.push({ code, message });
  const start = before.recorder ?? {};
  const recorder = after.recorder ?? {};
  const later = settled?.recorder ?? recorder;
  const fromRecordingStart = told ?? fromFrame < (start.nextFrame ?? 0);
  const since = (key) => (recorder[key] ?? 0) - (fromRecordingStart ? 0 : start[key] ?? 0);
  const faults = since('frameLabelFaults');
  if (faults) {
    fail('frame-label-fault', `${faults} blocks with a frame number out of step, not a stale label (first logged: ${JSON.stringify((recorder.faultLog ?? []).slice(0, 3))})`);
  }
  const runs = since('staleRuns');
  if (!runs) return problems;
  const endFrame = recorder.nextFrame ?? 0;
  const logged = (later.staleLog ?? []).filter((run) => run.recorderFrame >= fromFrame && run.recorderFrame < endFrame);
  // A span that starts with the recording counts the runs before its first
  // frame too. Those can only be in the silence a recording delay starts
  // with (capture-observer.js), which has no sound to check, and a run
  // there that didn't catch up is a fault already.
  const earlier = fromRecordingStart ? (later.staleLog ?? []).filter((run) => run.recorderFrame < fromFrame).length : 0;
  if (logged.length + earlier !== runs) fail('stale-label-unverified', `${runs} stale runs in the span, but ${logged.length + earlier} still logged`);
  const [left, right] = channels;
  for (const run of logged) {
    const at = `stale run of ${run.blocks} at recorder frame ${run.recorderFrame} (raw ${run.contextFrame}, expected ${run.expected})`;
    if (run.recovered === false) {
      fail('frame-label-fault', `${at} didn't catch up (next raw ${run.recoveredContextFrame})`);
      continue;
    }
    if (run.recovered !== true) {
      fail('stale-label-unverified', `${at} hadn't caught up when the span was read`);
      continue;
    }
    const index = run.recorderFrame - fromFrame;
    const end = index + run.frames;
    if (index < 3 || end + 3 > left.length) {
      fail('stale-label-unverified', `${at} is too close to the span's edge to check its sound`);
      continue;
    }
    let peak = 0;
    for (let i = index; i < end + 3; i++) {
      peak = Math.max(peak, Math.abs(thirdDifference(left, i)), Math.abs(thirdDifference(right, i)));
    }
    run.peak = round(peak, 6);
    if (!(peak <= CLICK_THRESHOLD)) {
      fail('stale-label-discontinuity', `${at}: third difference ${round(peak, 4)} across it, so it may be a repeated or missing block`);
      continue;
    }
    if (index >= run.frames) {
      const same = (samples) => samples.subarray(index, end).every((value, i) => value === samples[index - run.frames + i]);
      const sounding = (samples) => samples.subarray(index, end).some((value) => value !== 0);
      if (same(left) && same(right) && (sounding(left) || sounding(right))) {
        fail('stale-label-repeat', `${at}: its samples repeat the block before it`);
      }
    }
  }
  return problems;
}

// How far before the last frame the page had received a mark may fall.
// A mark reads the context's clock; the recorded frames reach the page
// after they are played, so a mark falls after them, and in every recorded
// span so far no more than 128 frames before (Firefox's clock, read by a
// page, can run a little behind). One batch is allowed.
const MARK_SLACK_FRAMES = 2048;

// Whether marks (capture-observer.js's mark()) map to the recording as they
// should: each falls no earlier than MARK_SLACK_FRAMES before the frames the
// page already had, and no mark before the one taken ahead of it. Otherwise
// the context's clock and the recorder disagree about where an action
// happened (`mark-out-of-step`), a measurement failure. With a recording
// delay of `delayFrames` (capture-observer.js), the sound made at a mark is
// recorded that many frames later, so a mark falls that much further on.
function markProblems(marks, delayFrames = 0) {
  const problems = [];
  let previous = null;
  for (const mark of marks) {
    if (mark.recorderFrame === null || mark.recorderFrame === undefined) continue;
    const due = mark.nextFrame + delayFrames;
    if (mark.recorderFrame < due - MARK_SLACK_FRAMES) {
      problems.push({
        code: 'mark-out-of-step',
        message: `${mark.label}: at recorder frame ${mark.recorderFrame}, ${due - mark.recorderFrame} frames before the ${mark.nextFrame} already recorded` + (delayFrames ? ` and the ${delayFrames}-frame delay` : '')
      });
    }
    if (previous && mark.recorderFrame < previous.recorderFrame) {
      problems.push({ code: 'mark-out-of-step', message: `${mark.label}: at recorder frame ${mark.recorderFrame}, before "${previous.label}" at ${previous.recorderFrame}` });
    }
    previous = mark;
  }
  return problems;
}

// The wall-clock time (performance.now() in the page) at which the sound
// recorded at `recorderFrame` was made, from a snapshot: its context time
// and wall time, read together, and the recorder's mapping (frameOffset).
function soundWallMs(snapshot, recorderFrame) {
  const { context, recorder, wallMs } = snapshot;
  const madeAt = (recorderFrame + recorder.frameOffset) / context.sampleRate;
  return wallMs - (context.currentTime - madeAt) * 1000;
}

// The player's pauses that interrupted a span from outside the check: every
// pause from when the span's recorded sound began (`startMs`, soundWallMs)
// on, except those during one of the check's own `actions` (from its first
// mark to 100 ms after its last). The start is taken MARK_SLACK_FRAMES
// early, as far as a page's clock may run behind the sound before marks are
// out of step, and nothing bounds the end: a pause whose event came late is
// taken as in the span. So a pause near either end can make a recording
// invalid that it didn't touch, but none that touched it is missed.
function outsidePauses({ events, startMs, sampleRate, actions = [], marks = [] }) {
  const from = startMs - (MARK_SLACK_FRAMES / sampleRate) * 1000;
  const byAction = (atMs) =>
    actions.some((action) => {
      const before = marks.find((mark) => mark.label === `${action.label}: before`);
      const done = marks.find((mark) => mark.label === `${action.label}: after`);
      return before && done ? atMs >= before.wallMs && atMs <= done.wallMs + 100 : false;
    });
  return events.filter((event) => event.type === 'pause' && event.atMs >= from && !byAction(event.atMs));
}

// Whether a span of recorded samples is valid data: what captureProblems
// checks of a window's clock and recorder, between the page snapshots
// `before` and `after`, plus that the frames recorded before `before` from
// `fromFrame` on (a span that starts with the recording) lost nothing
// either, that the context frame each batch began at stayed in step with
// the recorder's own count (offsetChanges), and that its frame numbers can
// be trusted (frameLabelProblems, with `settled`). `channels` are the
// decoded samples from `fromFrame` to the after snapshot's next frame.
// `fromRecordingStart` is as for frameLabelProblems.
function spanHealth(before, after, channels, fromFrame, settled = after, { fromRecordingStart: told } = {}) {
  const fromRecordingStart = told ?? fromFrame < (before.recorder?.nextFrame ?? 0);
  const problems = [];
  const fail = (code, message) => problems.push({ code, message });
  const recorder = after.recorder ?? {};
  const start = before.recorder ?? {};
  if (after.errors?.length) fail('observer-error', after.errors.join('; '));
  if (!after.context) fail('no-context', 'no audio context was observed');
  if (recorder.error) fail('recorder-error', recorder.error);
  if (!recorder.ready) fail('recorder-not-ready', 'the recorder never started');
  const states = [before.context?.state, after.context?.state];
  if (states.some((state) => state !== 'running')) fail('not-running', `context states ${states.join(' -> ')}`);
  const sampleRate = after.context?.sampleRate ?? 0;
  if (recorder.workletSampleRate !== sampleRate) {
    fail('sample-rate-mismatch', `recorder at ${recorder.workletSampleRate} Hz, context at ${sampleRate} Hz`);
  }
  const wallSeconds = (after.wallMs - before.wallMs) / 1000;
  const [low, high] = CLOCK_RATE_RANGE;
  const contextRate = wallSeconds > 0 ? ((after.context?.currentTime ?? 0) - (before.context?.currentTime ?? 0)) / wallSeconds : 0;
  if (!(contextRate >= low && contextRate <= high)) fail('clock-stalled', `context clock ran at ${round(contextRate, 3)} times the wall clock`);
  const frames = (recorder.nextFrame ?? 0) - (start.nextFrame ?? 0);
  const recordedRate = wallSeconds > 0 && sampleRate ? frames / sampleRate / wallSeconds : 0;
  if (!(recordedRate >= low && recordedRate <= high)) fail('frames-stalled', `${frames} frames in ${round(wallSeconds, 3)} s`);
  const counted = ['lostFrames', 'overflowFrames', 'contextFrameGaps', 'offsetChanges', 'nonStereoBlocks'];
  for (const key of counted) {
    const during = difference(recorder, start, key);
    const earlier = fromRecordingStart ? start[key] ?? 0 : 0;
    if (during !== 0 || earlier !== 0) {
      const code = { lostFrames: 'frames-lost', overflowFrames: 'frames-lost', contextFrameGaps: 'context-gap', offsetChanges: 'context-gap', nonStereoBlocks: 'not-stereo' }[key];
      fail(code, `${key}: ${during} during the span${earlier ? `, ${earlier} before it` : ''}`);
    }
  }
  const batchEnd = (r) => (r.lastBatch ? r.lastBatch.contextFrame + r.lastBatch.frames : null);
  if (batchEnd(recorder) !== null && batchEnd(start) !== null && batchEnd(recorder) - batchEnd(start) !== frames) {
    fail('frame-mismatch', `${frames} frames recorded over ${batchEnd(recorder) - batchEnd(start)} context frames`);
  }
  const expected = (recorder.nextFrame ?? 0) - fromFrame;
  if (channels[0].length !== expected || channels[1].length !== expected) {
    fail('frame-mismatch', `read ${channels[0].length} frames, wanted ${expected}`);
  }
  const nonFinite = channels.reduce((sum, samples) => sum + channelStats(samples).nonFinite, 0);
  if (nonFinite) fail('non-finite', `${nonFinite} samples are not finite`);
  else if (channels[0].length === expected && channels[1].length === expected) problems.push(...frameLabelProblems(before, after, channels, fromFrame, settled, { fromRecordingStart }));
  return problems;
}

// Checks a recorded span against what its actions may do. Frames are the
// recorder's own; `fromFrame` is the first sample's.
//
// `actions` are what the test did, in order: { label, startFrame, endFrame,
// allow }. startFrame is a mark taken just before the action: nothing the
// action causes can be heard earlier. endFrame is a mark taken once it was
// done. A click or silent stretch counts as the action's if it starts
// between startFrame and `allow.windowMs` after endFrame. The action may
// then cause silence of up to `allow.silenceMs` (a fade the engine makes on
// purpose, or the player stopping) and, only with `allow.clicks`, clicks
// (the page stopping a tone mid-wave, as a seek does). Anything else is a
// problem, `click` or `gap`. `allow.fromRecordingStart` marks an action
// that began before the recorder could (an audio context the action
// itself creates): its sound must start after the recording does
// (`onset-not-observed` otherwise), so nothing of it went unheard.
//
// Every other action needs `preRollMs` recorded before it, so the recorder
// was running and every frame was there before the transition began.
//
// `segments` are steady stretches between actions: { label, fromFrame,
// toFrame, expect }, checked like a window (signalProblems).
function analyzeSpan({ sampleRate, fromFrame, left, right, actions = [], segments = [], preRollMs = 100, clickThreshold = CLICK_THRESHOLD }) {
  const problems = [];
  const fail = (code, message) => problems.push({ code, message });
  const toMs = (frames) => round((frames / sampleRate) * 1000, 1);
  const toFrame = (index) => fromFrame + index;
  const length = left.length;
  const endFrame = fromFrame + length;

  for (const action of actions) {
    const inside = (frame) => frame >= fromFrame && frame <= endFrame;
    if (!inside(action.startFrame) || !inside(action.endFrame)) {
      fail('not-covered', `${action.label}: frames ${action.startFrame} to ${action.endFrame} aren't all in the recording (${fromFrame} to ${endFrame})`);
    } else if (!action.allow?.fromRecordingStart && action.startFrame - fromFrame < (preRollMs / 1000) * sampleRate) {
      fail('not-covered', `${action.label}: only ${toMs(action.startFrame - fromFrame)} ms recorded before it (wanted ${preRollMs})`);
    }
    if (action.allow?.fromRecordingStart) {
      const block = Math.round((sampleRate * SILENCE_BLOCK_MS) / 1000);
      const first = channelStats(left.subarray(0, block)).rms + channelStats(right.subarray(0, block)).rms;
      if (!(first < SILENT_RMS)) {
        fail('onset-not-observed', `${action.label}: the recording begins with sound (RMS ${round(first, 5)}), so its start wasn't recorded`);
      }
    }
  }

  const owner = (frame) =>
    actions.find((action) => {
      const windowFrames = ((action.allow?.windowMs ?? 300) / 1000) * sampleRate;
      const start = action.allow?.fromRecordingStart ? fromFrame : action.startFrame;
      return frame >= start && frame <= action.endFrame + windowFrames;
    }) ?? null;

  const clicks = findClicks(left, right, sampleRate, clickThreshold).map((click) => {
    const frame = toFrame(click.frame);
    const action = owner(frame);
    const allowed = Boolean(action?.allow?.clicks);
    if (!allowed) {
      fail('click', `click of ${click.peak} at ${toMs(frame - fromFrame)} ms (channel ${click.channel})${action ? `, during ${action.label}` : ''}`);
    }
    return { ...click, frame, atMs: toMs(frame - fromFrame), action: action?.label ?? null, allowed };
  });

  // The largest third difference where no action may click, to show how far
  // below CLICK_THRESHOLD the sound stayed.
  const clickFree = (index) => !owner(toFrame(index))?.allow?.clicks;
  let quietPeak = 0;
  for (let i = 3; i < length; i++) {
    const value = Math.max(Math.abs(thirdDifference(left, i)), Math.abs(thirdDifference(right, i)));
    if (value > quietPeak && clickFree(i)) quietPeak = value;
  }

  const silences = silentRuns(left, right, sampleRate).map((run) => {
    const frame = toFrame(run.frame);
    const durationMs = toMs(run.frames);
    const action = owner(frame);
    const allowedMs = action?.allow?.silenceMs ?? 0;
    const allowed = durationMs <= allowedMs;
    if (!allowed) {
      fail('gap', `${durationMs} ms of silence at ${toMs(frame - fromFrame)} ms` + (action ? `, during ${action.label} (allowed ${allowedMs} ms)` : ', outside any action'));
    }
    return { frame, atMs: toMs(frame - fromFrame), durationMs, action: action?.label ?? null, allowedMs, allowed };
  });

  const measured = segments.map((segment) => {
    const from = Math.max(0, segment.fromFrame - fromFrame);
    const to = Math.min(length, segment.toFrame - fromFrame);
    if (!(to - from >= 0.2 * sampleRate)) {
      fail('not-covered', `${segment.label}: only ${toMs(Math.max(0, to - from))} ms of steady sound recorded`);
      return { label: segment.label, fromMs: toMs(from), toMs: toMs(to), channels: null, problems: [] };
    }
    const channels = measureChannels(left.subarray(from, to), right.subarray(from, to), sampleRate, toneLists(segment.expect));
    const found = signalProblems(channels, segment.expect);
    for (const problem of found) fail(problem.code, `${segment.label}: ${problem.message}`);
    return { label: segment.label, fromMs: toMs(from), toMs: toMs(to), channels, problems: found };
  });

  return { sampleRate, fromFrame, frames: length, clickThreshold, quietPeak: round(quietPeak, 5), clicks, silences, segments: measured, problems };
}

// The sine at `hz` that best fits `samples` (least squares, its phase
// free): its amplitude, and the RMS of what is left once it is taken away.
// Exact for a steady tone at `hz`, over any length.
function fitTone(samples, sampleRate, hz) {
  const step = (2 * Math.PI * hz) / sampleRate;
  let ss = 0;
  let cc = 0;
  let sc = 0;
  let ys = 0;
  let yc = 0;
  let yy = 0;
  for (let i = 0; i < samples.length; i++) {
    const sin = Math.sin(step * i);
    const cos = Math.cos(step * i);
    const y = samples[i];
    ss += sin * sin;
    cc += cos * cos;
    sc += sin * cos;
    ys += y * sin;
    yc += y * cos;
    yy += y * y;
  }
  const determinant = ss * cc - sc * sc;
  if (!(samples.length > 2 && determinant > 0)) return { amplitude: 0, residualRms: Math.sqrt(yy / Math.max(1, samples.length)) };
  const a = (ys * cc - yc * sc) / determinant;
  const b = (yc * ss - ys * sc) / determinant;
  const residual = Math.max(0, yy - (a * ys + b * yc));
  return { amplitude: Math.sqrt(a * a + b * b), residualRms: Math.sqrt(residual / samples.length) };
}

// The unchanged sound, block by block: each channel's own tone within
// DRY_LEVEL_TOLERANCE of its level (0.24 to 0.26 for the song's 0.25, as a
// steady stretch of the song itself is checked), with less than
// DRY_RESIDUAL_RMS (-46 dBFS, 3% of the tone) of anything else.
const DRY_LEVEL_TOLERANCE = 0.01;
const DRY_RESIDUAL_RMS = 0.005;
const DRY_BLOCK_MS = 10;

// When the unchanged sound came back after an action that should restore
// it: the first DRY_BLOCK_MS block, counted from the action's first mark
// (`startFrame`), from which every block up to `toFrame` has, in both
// channels, the song's own tone (`dry`: [{ hz, amplitude }] per channel) at
// its exact level and nothing else. Partial or late restoration, the wrong
// tone or the wrong channel never count. `energyOnsetMs` is when the right
// channel first carried sound for good (RMS 0.1 or more in every block),
// kept only to show how much later the exact sound was back; it isn't
// restoration. Frames are the recorder's, `fromFrame` the first sample's.
function dryRestoration({ left, right, sampleRate, fromFrame, startFrame, toFrame, dry }) {
  const step = Math.round((sampleRate * DRY_BLOCK_MS) / 1000);
  const start = startFrame - fromFrame;
  const end = Math.min(left.length, toFrame - fromFrame);
  const toMs = (index) => Math.round(((index - start) / sampleRate) * 1000);
  let restored = null;
  let energy = null;
  let lastMiss = null;
  const after = dry.map(() => ({ minAmplitude: Infinity, maxAmplitude: 0, maxResidualRms: 0 }));
  for (let block = start; block + step <= end; block += step) {
    const fits = [left, right].map((samples, channel) => fitTone(samples.subarray(block, block + step), sampleRate, dry[channel].hz));
    const ok = fits.every(
      (fit, channel) =>
        Math.abs(fit.amplitude - dry[channel].amplitude) <= DRY_LEVEL_TOLERANCE && fit.residualRms < DRY_RESIDUAL_RMS
    );
    if (!ok) {
      restored = null;
      lastMiss = { atMs: toMs(block), channels: fits.map((fit) => ({ amplitude: round(fit.amplitude, 4), residualRms: round(fit.residualRms, 4) })) };
      for (const summary of after) Object.assign(summary, { minAmplitude: Infinity, maxAmplitude: 0, maxResidualRms: 0 });
    } else {
      if (restored === null) restored = block;
      fits.forEach((fit, channel) => {
        const summary = after[channel];
        summary.minAmplitude = Math.min(summary.minAmplitude, fit.amplitude);
        summary.maxAmplitude = Math.max(summary.maxAmplitude, fit.amplitude);
        summary.maxResidualRms = Math.max(summary.maxResidualRms, fit.residualRms);
      });
    }
    const rms = channelStats(right.subarray(block, block + step)).rms;
    if (!(rms >= 0.1)) energy = null;
    else if (energy === null) energy = block;
  }
  return {
    restoredAfterMs: restored === null ? null : toMs(restored),
    energyOnsetMs: energy === null ? null : toMs(energy),
    checkedToMs: toMs(end),
    lastMiss,
    afterRestored:
      restored === null
        ? null
        : after.map((summary) => ({
            minAmplitude: round(summary.minAmplitude, 4),
            maxAmplitude: round(summary.maxAmplitude, 4),
            maxResidualRms: round(summary.maxResidualRms, 5)
          }))
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
  CLICK_THRESHOLD,
  DRY_LEVEL_TOLERANCE,
  DRY_RESIDUAL_RMS,
  LEVEL_PROBLEMS,
  MARK_SLACK_FRAMES,
  SIGNAL_FLOOR_RMS,
  analyzeSpan,
  assertHealthyCapture,
  captureProblems,
  channelStats,
  compareLevels,
  decodeChannels,
  dominantTone,
  dryRestoration,
  envelope,
  findClicks,
  fitTone,
  frameLabelProblems,
  markProblems,
  maxSilentRunMs,
  measureChannels,
  measureWindow,
  signalProblems,
  silentRuns,
  outsidePauses,
  soundWallMs,
  spanHealth,
  toneAmplitude,
  toneNear
};
