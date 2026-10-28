'use strict';

// The suite's reading of the tones' phase (phaseSlips in
// e2e/audio-capture/metrics.js), on made-up recordings like the one the
// suite makes when the effect turns on while a song plays: the song's two
// tones at 0.8x in the left channel, nothing in the right.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { phaseSlips } = require('../e2e/audio-capture/metrics');

const RATE = 48000;
const TONES = [352, 528];
const LATE_FRAME = { samples: 1.25, fromMs: 1500, toMs: 5000 };

// Six seconds, each tone `slip` samples late from each of `slips`' frames on.
function recording(slips = []) {
  const left = new Float32Array(RATE * 6);
  for (let n = 0; n < left.length; n++) {
    let t = n;
    for (const { at, by } of slips) if (n >= at) t -= by;
    left[n] = TONES.reduce((sum, hz) => sum + 0.287 * Math.cos((2 * Math.PI * hz * t) / RATE), 0);
  }
  return { left, right: new Float32Array(left.length), sampleRate: RATE, tones: [TONES, []] };
}
const at = (ms) => Math.round((ms / 1000) * RATE);

describe("the suite's phase scan", () => {
  test('finds nothing in a steady song', () => {
    assert.deepEqual(phaseSlips({ ...recording(), lateFrame: LATE_FRAME }), []);
  });

  test("takes one slip of a frame of the song, 2 to 4 s in, as Firefox's late frame", () => {
    const [event, ...rest] = phaseSlips({ ...recording([{ at: at(3000), by: 1.25 }]), lateFrame: LATE_FRAME });
    assert.deepEqual(rest, []);
    assert.equal(event.lateFrame, true);
    assert.deepEqual(event.slips.map((slip) => slip.hz).sort(), [352, 528]);
    assert.ok(event.fromMs <= 3000 && 3000 <= event.toMs, `${event.fromMs} to ${event.toMs}`);
  });

  test('places the frame where it was, wherever it falls between windows', () => {
    for (let ms = 3000; ms < 3020; ms += 1.7) {
      const [event] = phaseSlips({ ...recording([{ at: at(ms), by: 1.25 }]), lateFrame: LATE_FRAME });
      assert.ok(event.lateFrame, `${ms}`);
      assert.ok(event.fromMs <= ms && ms <= event.toMs, `${ms}: placed ${event.fromMs} to ${event.toMs}`);
      assert.ok(event.toMs - event.fromMs <= 30, `${ms}: placed ${event.fromMs} to ${event.toMs}`);
    }
  });

  test('takes nothing else as the late frame', () => {
    const late = (slips, lateFrame = LATE_FRAME) => phaseSlips({ ...recording(slips), lateFrame }).map((event) => event.lateFrame);
    // Chromium, which has no such frame.
    assert.deepEqual(late([{ at: at(3000), by: 1.25 }], null), [false]);
    // Too early, the other way, and two frames.
    assert.deepEqual(late([{ at: at(1000), by: 1.25 }]), [false]);
    assert.deepEqual(late([{ at: at(3000), by: -1.25 }]), [false]);
    assert.deepEqual(late([{ at: at(3000), by: 2.5 }]), [false]);
    // A second frame after the first.
    assert.deepEqual(late([{ at: at(2500), by: 1.25 }, { at: at(3500), by: 1.25 }]), [true, false]);
  });
});
