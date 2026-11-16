'use strict';

// The suite's reading of the tones' phase (phaseSlips in
// e2e/audio-capture/metrics.js), on made-up recordings like the one the
// suite makes when the effect turns on while a song plays: the song's two
// tones at 0.8x in the left channel, nothing in the right.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { phaseSlips } = require('../e2e/audio-capture/metrics');
const { LATE_FRAME_MS, PHASE_SCAN_FROM_MS } = require('../e2e/audio-capture/regression');

const RATE = 48000;
const TONES = [352, 528];
// The window the suite itself uses, and where its scan starts.
const LATE_FRAME = { samples: 1.25, fromMs: LATE_FRAME_MS[0], toMs: LATE_FRAME_MS[1] };
const scan = (recorded, lateFrame = LATE_FRAME) => phaseSlips({ ...recorded, lateFrame, scanFromMs: PHASE_SCAN_FROM_MS });

// Six seconds, each tone `by` samples late from each of `slips`' frames on
// (only the tone `hz`, if a slip names one), each starting at `phases`.
// With `silentMs`, the recording starts as the suite's does: that long in
// silence, as the Firefox engines keep it (250 ms, or more with a late
// timer), then the sound coming in over 25 ms.
function recording(slips = [], phases = [0, 0], { silentMs = 0 } = {}) {
  const left = new Float32Array(RATE * 6);
  for (let n = 0; n < left.length; n++) {
    const sinceSilence = (n / RATE) * 1000 - silentMs;
    const gain = silentMs === 0 ? 1 : Math.max(0, Math.min(1, sinceSilence / 25));
    left[n] = gain * TONES.reduce((sum, hz, index) => {
      let t = n;
      for (const slip of slips) if (n >= slip.at && (slip.hz === undefined || slip.hz === hz)) t -= slip.by;
      return sum + 0.287 * Math.cos((2 * Math.PI * hz * t) / RATE + phases[index]);
    }, 0);
  }
  return { left, right: new Float32Array(left.length), sampleRate: RATE, tones: [TONES, []] };
}
const at = (ms) => Math.round((ms / 1000) * RATE);

describe("the suite's phase scan", () => {
  test('finds nothing in a steady song', () => {
    assert.deepEqual(scan(recording()), []);
    assert.deepEqual(scan(recording([], [0.86, 1.29], { silentMs: 250 })), []);
  });

  test("takes one slip of a frame of the song, 2 to 4 s in, as Firefox's late frame", () => {
    const [event, ...rest] = scan(recording([{ at: at(3000), by: 1.25 }]));
    assert.deepEqual(rest, []);
    assert.equal(event.lateFrame, true);
    assert.deepEqual(event.slips.map((slip) => slip.hz).sort(), [352, 528]);
    assert.ok(event.fromMs <= 3000 && 3000 <= event.toMs, `${event.fromMs} to ${event.toMs}`);
  });

  test('places the frame about where it was, wherever it falls between windows', () => {
    // Within the 5 ms the suite allows a click either side of the place.
    for (const phases of [[0, 0], [0.86, 1.29], [18.92, 28.38], [2, 5]]) {
      for (let ms = 3000; ms < 3020; ms += 1.7) {
        const [event] = scan(recording([{ at: at(ms), by: 1.25 }], phases));
        assert.ok(event.lateFrame, `${phases} ${ms}`);
        assert.ok(event.fromMs - 5 <= ms && ms <= event.toMs + 5, `${phases} ${ms}: placed ${event.fromMs} to ${event.toMs}`);
        assert.ok(event.toMs - event.fromMs <= 30, `${phases} ${ms}: placed ${event.fromMs} to ${event.toMs}`);
      }
    }
  });

  test('takes a slip of one tone only for something else', () => {
    // Firefox's frame delays the whole song, so both tones.
    for (const hz of TONES) {
      const events = scan(recording([{ at: at(3000), by: 1.25, hz }]));
      assert.ok(events.length > 0 && events.every((event) => !event.lateFrame), `${hz}: ${JSON.stringify(events)}`);
    }
  });

  test('fails two frames close together', () => {
    // Found as one slip, they still move the song by two frames in all, so
    // it isn't the late frame; found as two, the second isn't. Either way
    // some slip is left to fail the check.
    for (const phases of [[0, 0], [0.86, 1.29]]) {
      for (const apart of [60, 70, 80, 90, 100, 150, 300]) {
        const events = scan(recording([{ at: at(3000), by: 1.25 }, { at: at(3000 + apart), by: 1.25 }], phases));
        const shown = JSON.stringify(events.map(({ fromMs, toMs, net, lateFrame }) => ({ fromMs, toMs, net, lateFrame })));
        assert.ok(events.some((event) => !event.lateFrame), `${phases} ${apart} ms: ${shown}`);
        if (apart <= 100) assert.ok(events.every((event) => !event.lateFrame), `${phases} ${apart} ms: ${shown}`);
      }
    }
  });

  // The earliest this Mac has had it, through AirPods that were slow to
  // start: on November 7, 2026 in Firefox 159.0.1, at 1.13 s on Spotify and
  // 1.38 s on YouTube, and on November 13 in Firefox 160.0, at 0.79 s on
  // Spotify.
  test('takes the frame as early as it has come', () => {
    for (const ms of [787, 1130, 1380]) {
      const [event, ...rest] = scan(recording([{ at: at(ms), by: 1.25 }], [0, 0], { silentMs: 250 }));
      assert.equal(event.lateFrame, true, `${ms}`);
      assert.deepEqual(rest, []);
    }
  });

  // The frame's place depends on how long the output took to start, so it
  // is taken from as early as the scan can: five windows of the tones after
  // the engine's silence and fade.
  test("takes the frame from 0.4 s in, after the engine's own start", () => {
    for (const phases of [[0, 0], [0.86, 1.29], [2, 5]]) {
      for (const ms of [400, 425, 450, 500, 600]) {
        const [event, ...rest] = scan(recording([{ at: at(ms), by: 1.25 }], phases, { silentMs: 250 }));
        assert.equal(event?.lateFrame, true, `${phases} ${ms}`);
        assert.deepEqual(rest, [], `${phases} ${ms}`);
        assert.ok(event.fromMs - 5 <= ms && ms <= event.toMs + 5, `${phases} ${ms}: placed ${event.fromMs} to ${event.toMs}`);
      }
    }
  });

  // Earlier than that, or with a timer of the engine's late, it has too
  // little of the tones before the frame to measure the whole move, and
  // takes nothing as the frame: the check then fails on the slip, if the
  // scan finds it, or on its click.
  test('takes no frame it has too little before to measure', () => {
    for (const phases of [[0, 0], [0.86, 1.29], [2, 5]]) {
      for (const ms of [300, 320, 340, 360]) {
        const events = scan(recording([{ at: at(ms), by: 1.25 }], phases, { silentMs: 250 }));
        assert.ok(events.every((event) => !event.lateFrame), `${phases} ${ms}: ${JSON.stringify(events)}`);
      }
      const events = scan(recording([{ at: at(380), by: 1.25 }], phases, { silentMs: 310 }));
      assert.ok(events.every((event) => !event.lateFrame), `${phases}: ${JSON.stringify(events)}`);
    }
  });

  test('scans from half a second in unless told otherwise', () => {
    const recorded = recording([{ at: at(450), by: 1.25 }], [0, 0], { silentMs: 250 });
    assert.deepEqual(phaseSlips({ ...recorded, lateFrame: LATE_FRAME }), []);
    assert.equal(scan(recorded)[0].lateFrame, true);
  });

  test('takes nothing else as the late frame', () => {
    const late = (slips, lateFrame = LATE_FRAME) => scan(recording(slips), lateFrame).map((event) => event.lateFrame);
    // Chromium, which has no such frame.
    assert.deepEqual(late([{ at: at(3000), by: 1.25 }], null), [false]);
    // Outside the window it is given, the other way, and two frames.
    assert.deepEqual(late([{ at: at(600), by: 1.25 }], { ...LATE_FRAME, fromMs: 1000 }), [false]);
    assert.deepEqual(late([{ at: at(5200), by: 1.25 }]), [false]);
    assert.deepEqual(late([{ at: at(3000), by: -1.25 }]), [false]);
    assert.deepEqual(late([{ at: at(3000), by: 2.5 }]), [false]);
    // A second frame after the first.
    assert.deepEqual(late([{ at: at(2500), by: 1.25 }, { at: at(3500), by: 1.25 }]), [true, false]);
  });
});
