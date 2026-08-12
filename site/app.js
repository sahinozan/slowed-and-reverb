'use strict';

// The hero field is a readout, not decoration: bar spacing and weight are
// driven by the speed control the same way the extension retimes playback.
// Slower rate means fewer, heavier bars. Without this script the CSS leaves an
// evenly spaced field, which is exactly the 1.00x state.

(function () {
  const field = document.getElementById('field');
  const slider = document.getElementById('speed');
  const readout = document.getElementById('readout');
  if (!field || !slider || !readout) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BASE_STEP = 26;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let revealed = reduceMotion;

  const barWidth = (rate) => Math.max(3, 3 + (1.5 - rate) * 9);

  function draw(rate) {
    const width = field.clientWidth;
    const height = field.clientHeight;
    if (!width || !height) return;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    // Same ramp as the extension icon, so the field and the mark share one ink.
    const defs = document.createElementNS(SVG_NS, 'defs');
    const ramp = document.createElementNS(SVG_NS, 'linearGradient');
    ramp.setAttribute('id', 'field-ramp');
    ramp.setAttribute('gradientUnits', 'userSpaceOnUse');
    ramp.setAttribute('x1', '0');
    ramp.setAttribute('x2', String(width));
    for (const [offset, colour] of [['0', '#ff9ab8'], ['0.5', '#e8597f'], ['1', '#b32a58']]) {
      const stop = document.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', offset);
      stop.setAttribute('stop-color', colour);
      ramp.append(stop);
    }
    defs.append(ramp);
    svg.append(defs);

    const w = barWidth(rate);
    const step = BASE_STEP / rate;
    let index = 0;
    for (let x = 0; x < width; x += step) {
      const bar = document.createElementNS(SVG_NS, 'rect');
      bar.setAttribute('x', x.toFixed(2));
      bar.setAttribute('y', '0');
      bar.setAttribute('width', Math.min(w, width - x).toFixed(2));
      bar.setAttribute('height', height);
      bar.setAttribute('fill', 'url(#field-ramp)');
      if (!revealed) {
        bar.style.transformOrigin = 'center';
        bar.style.animation = `rise 420ms cubic-bezier(.2,.7,.3,1) ${index * 24}ms both`;
      }
      svg.append(bar);
      index += 1;
    }

    field.replaceChildren(svg);
    field.classList.add('is-live');
    revealed = true;
  }

  function update() {
    const rate = Number(slider.value);
    const semitones = 12 * Math.log2(rate);
    const sign = semitones > 0.05 ? '+' : semitones < -0.05 ? '−' : '';
    readout.innerHTML =
      `${rate.toFixed(2)}x <span class="dim">/ ${sign}${Math.abs(semitones).toFixed(1)} st</span>`;
    draw(rate);
  }

  slider.addEventListener('input', update);

  // The field is measured in real pixels, so it is redrawn when its box changes.
  if ('ResizeObserver' in window) {
    let width = 0;
    new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      draw(Number(slider.value));
    }).observe(field);
  } else {
    window.addEventListener('resize', () => draw(Number(slider.value)));
  }

  update();
}());
