'use strict';

// The cassette, the fader and the popup are one instrument. The fader pushes
// its value into the popup's own speed slider, so the popup stays the single
// source of truth; whatever the popup applies drives the loop, the reels and
// the headline.

(function () {
  const frame = document.getElementById('popup');
  const play = document.getElementById('play');
  const speed = document.getElementById('speed');
  const speedOut = document.getElementById('speed-out');
  const label = document.getElementById('label-speed');
  const playError = document.getElementById('play-error');
  const reels = [
    [document.getElementById('reel-left'), 250],
    [document.getElementById('reel-right'), 470]
  ];

  const DEGREES_PER_SECOND = 110;
  const PLAY_ERRORS = {
    blocked: 'Your browser blocked the sound. Press play again.',
    failed: 'The demo song couldn\'t play in this browser.'
  };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let rate = 0.8;
  let angle = 0;
  let last = null;

  function show(settings, enabled) {
    rate = enabled ? settings.speed : 1;
    speedOut.textContent = `${rate.toFixed(2)}×`;
    if (Math.abs(Number(speed.value) - rate) > 0.001) speed.value = String(rate);
    speed.setAttribute('aria-valuetext', `${rate.toFixed(2)}×`);
    label.textContent = `speed ${rate.toFixed(2)}×`;
  }

  function frameTick(now) {
    const playing = SRDemo.state.playing;
    if (last !== null && playing) {
      angle = (angle + ((now - last) / 1000) * DEGREES_PER_SECOND * rate) % 360;
      for (const [reel, cx] of reels) reel.setAttribute('transform', `rotate(${angle.toFixed(2)} ${cx} 214)`);
    }
    last = now;
    requestAnimationFrame(frameTick);
  }

  const popup = SRPopupEmbed(frame, {
    onSettings: (settings, enabled) => {
      SRDemo.apply(settings, enabled);
      show(settings, enabled);
    }
  });

  speed.addEventListener('input', () => {
    // Prefer the popup's slider so its UI, presets and readout stay in step.
    if (!popup.setControl('speed-slider', speed.value)) {
      SRDemo.apply({ ...SRDemo.state.settings, speed: Number(speed.value) }, true);
      show(SRDemo.state.settings, true);
    }
  });

  SRDemo.subscribe((state) => {
    play.setAttribute('aria-pressed', String(state.playing));
    play.disabled = state.loading;
    play.setAttribute('aria-label', state.playing ? 'Pause the demo song' : 'Play the demo song');
    playError.textContent = PLAY_ERRORS[state.error] || '';
    playError.hidden = !state.error;
  });
  play.addEventListener('click', () => SRDemo.toggle());

  show({ speed: 0.8 }, true);
  if (!reduceMotion) requestAnimationFrame(frameTick);
}());
