'use strict';

// The reproducer's scan for slips of the tone's phase
// (e2e/audio-capture/firefox-capture-click.js), on made-up tones: it has to
// find a frame of silence that a click threshold can miss, and nothing else.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { slipsIn } = require('../e2e/audio-capture/firefox-capture-click');

const RATE = 48000;
const HZ = 352;

// Eight seconds of the tone at `hz`, `slip` samples late from frame `at`
// on, with frames of silence as asked.
function tone({ hz = HZ, at = null, slip = 0, silent = [] } = {}) {
  const samples = new Float32Array(RATE * 8);
  for (let n = 0; n < samples.length; n++) {
    const t = at !== null && n >= at ? n - slip : n;
    samples[n] = 0.25 * Math.cos((2 * Math.PI * hz * t) / RATE);
  }
  for (const [from, frames] of silent) samples.fill(0, from, from + frames);
  return samples;
}

describe('the reproducer finds slips of the phase', () => {
  test('finds none in a steady tone', () => {
    assert.deepEqual(slipsIn(tone(), RATE, HZ), []);
  });

  test("finds Firefox's frame of silence at 1x and at 0.8x, and a dropped sample", () => {
    assert.deepEqual(slipsIn(tone({ at: 3 * RATE, slip: 1, silent: [[3 * RATE, 1]] }), RATE, HZ), [{ ms: 2990, samples: 1 }]);
    assert.deepEqual(slipsIn(tone({ at: 3 * RATE, slip: 1.25 }), RATE, HZ), [{ ms: 2990, samples: 1.25 }]);
    assert.deepEqual(slipsIn(tone({ at: 5 * RATE, slip: -1 }), RATE, HZ), [{ ms: 5000, samples: -1 }]);
  });

  test('leaves out a gap in the sound, and still finds a slip after it', () => {
    assert.deepEqual(slipsIn(tone({ at: 4 * RATE, slip: 1, silent: [[RATE, RATE / 5]] }), RATE, HZ), [{ ms: 3990, samples: 1 }]);
    // A gap after which the tone goes on in step isn't a slip, wherever its
    // edges fall in a window.
    for (const frames of [0.015 * RATE, 0.025 * RATE, RATE / 10]) {
      assert.deepEqual(slipsIn(tone({ silent: [[RATE + 100, frames]] }), RATE, HZ), [], `a gap of ${frames} frames`);
    }
  });

  test('keeps two slips apart when a gap comes between them', () => {
    // +1.25 at 960 ms and -1.25 at 1240 ms, with 200 ms of silence from
    // 1000 ms between them.
    const samples = new Float32Array(RATE * 4);
    for (let n = 0; n < samples.length; n++) {
      const late = (n >= 0.96 * RATE ? 1.25 : 0) - (n >= 1.24 * RATE ? 1.25 : 0);
      samples[n] = 0.25 * Math.cos((2 * Math.PI * HZ * (n - late)) / RATE);
    }
    samples.fill(0, RATE, 1.2 * RATE);
    assert.deepEqual(
      slipsIn(samples, RATE, HZ).map(({ samples: moved }) => moved),
      [1.25, -1.25]
    );
  });

  test('measures a slip in samples when the tone is off the expected frequency', () => {
    assert.deepEqual(slipsIn(tone({ hz: HZ + 10, at: 3 * RATE, slip: 1.25 }), RATE, HZ), [{ ms: 2990, samples: 1.25 }]);
  });

  test('reports a move from a quarter of a sample, not below', () => {
    assert.deepEqual(slipsIn(tone({ at: 2 * RATE, slip: 0.3 }), RATE, HZ), [{ ms: 1990, samples: 0.3 }]);
    assert.deepEqual(slipsIn(tone({ at: 2 * RATE, slip: 0.1 }), RATE, HZ), []);
  });
});
