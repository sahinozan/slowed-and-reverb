'use strict';

// The reels are the readout. They turn at a rate proportional to the speed
// slider, the same relationship the extension applies to playback.

(function () {
  const speed = document.getElementById('speed');
  const out = document.getElementById('speed-out');
  const label = document.getElementById('label-speed');
  const left = document.getElementById('reel-left');
  const right = document.getElementById('reel-right');
  if (!speed || !left || !right) return;

  const DEGREES_PER_SECOND = 110;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let angle = 0;
  let last = null;

  function readout() {
    const rate = Number(speed.value);
    const st = 12 * Math.log2(rate);
    const sign = st > 0.05 ? '+' : st < -0.05 ? '−' : '';
    out.textContent = `${rate.toFixed(2)}×`;
    label.textContent = `speed ${rate.toFixed(2)}× · ${sign}${Math.abs(st).toFixed(1)} st`;
  }

  function frame(now) {
    if (last !== null) {
      angle = (angle + (now - last) / 1000 * DEGREES_PER_SECOND * Number(speed.value)) % 360;
      left.setAttribute('transform', `rotate(${angle.toFixed(2)} 250 214)`);
      right.setAttribute('transform', `rotate(${angle.toFixed(2)} 470 214)`);
    }
    last = now;
    requestAnimationFrame(frame);
  }

  speed.addEventListener('input', readout);
  readout();
  if (!reduceMotion) requestAnimationFrame(frame);
}());
