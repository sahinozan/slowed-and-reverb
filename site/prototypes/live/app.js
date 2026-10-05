'use strict';

// Wires the page to the embedded popup and the demo chain. The popup is the
// only control surface: whatever it applies, the loop plays, the readout
// shows, and the headline stretches to match.

(function () {
  const frame = document.getElementById('popup');
  const play = document.getElementById('play');
  const playLabel = document.getElementById('play-label');
  const readout = document.getElementById('readout');
  const title = document.getElementById('title');

  function show(settings, enabled) {
    const rate = enabled ? settings.speed : 1;
    const st = 12 * Math.log2(rate);
    const sign = st > 0.05 ? '+' : st < -0.05 ? '−' : '';
    readout.innerHTML =
      `${rate.toFixed(2)}× <span>${sign}${Math.abs(st).toFixed(1)} semitones</span>` +
      `<span>${Math.round(SRDemo.BPM * rate)} bpm</span>`;
    // Slower playback, wider letters: 1.00x is the face's normal width.
    title.style.setProperty('--stretch', `${Math.min(150, Math.max(62, 100 / rate))}%`);
  }

  SRPopupEmbed(frame, {
    onSettings: (settings, enabled) => {
      SRDemo.apply(settings, enabled);
      show(settings, enabled);
    }
  });

  SRDemo.subscribe((state) => {
    play.setAttribute('aria-pressed', String(state.playing));
    play.disabled = state.loading;
    playLabel.textContent = state.loading ? 'Loading' : state.playing ? 'Pause' : 'Play the loop';
  });

  play.addEventListener('click', () => SRDemo.toggle());
}());
