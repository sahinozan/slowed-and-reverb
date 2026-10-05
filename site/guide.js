'use strict';

// The guide's popup follows the reader: each section names the tab it
// describes, and the popup switches to it as that section scrolls into view.
// The loop and the readout follow whatever the popup applies.

(function () {
  const frame = document.getElementById('popup');
  const play = document.getElementById('play');
  const readout = document.getElementById('readout');
  const playError = document.getElementById('play-error');
  const panel = document.querySelector('.guide-panel');
  const TAB_BUTTONS = { basic: 'effect-tab-basic', advanced: 'effect-tab-advanced', custom: 'tab-custom' };
  const PLAY_ERRORS = {
    blocked: 'Your browser blocked the sound. Press play again.',
    failed: 'The demo song couldn\'t play in this browser.'
  };

  const popup = SRPopupEmbed(frame, {
    onSettings: (settings, enabled) => {
      SRDemo.apply(settings, enabled);
      const rate = enabled ? settings.speed : 1;
      readout.textContent = `${rate.toFixed(2)}× speed`;
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

  // In one column the popup sits above the text and scrolls away. It is only
  // switched while some of it is on screen, so a change the reader cannot see
  // never resizes the page above them.
  let panelInView = true;
  new IntersectionObserver(([entry]) => { panelInView = entry.isIntersecting; }).observe(panel);

  let current = null;
  function showTab(tab) {
    if (tab === current || !panelInView) return;
    current = tab;
    // My Presets is a tab of the upper strip; the effect tabs live below it.
    if (tab === 'custom') {
      popup.click(TAB_BUTTONS.custom);
    } else {
      popup.click('tab-presets');
      popup.click(TAB_BUTTONS[tab]);
    }
  }

  const sections = [...document.querySelectorAll('.guide-text section[data-tab]')];
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (visible) showTab(visible.target.dataset.tab);
  }, { rootMargin: '-35% 0px -55% 0px', threshold: 0 });
  for (const section of sections) observer.observe(section);
}());
