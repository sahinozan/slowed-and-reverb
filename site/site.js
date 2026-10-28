'use strict';

// Shared by every page. Carries the popup's theme from page to page within a
// visit, and redraws the favicon in the theme's colors.

(function () {
  const root = document.documentElement;
  const icon = document.querySelector('link[rel="icon"]');
  const defaultIcon = icon.href;
  const BARS = [[8, 40, 48], [32, 24, 80], [56, 4, 120], [80, 24, 80], [104, 40, 48]];

  // The five bars of assets/icon.svg, filled with the theme's logo colors.
  function paintIcon() {
    // Glow and Terminal share the logo colors of assets/icon.svg.
    if (!root.dataset.theme || root.dataset.theme === 'glow' || root.dataset.theme === 'pink') {
      icon.href = defaultIcon;
      return;
    }
    const style = window.getComputedStyle(root);
    const [light, middle, dark] = ['--logo-light', '--logo-middle', '--logo-dark']
      .map((name) => style.getPropertyValue(name).trim());
    const bars = BARS
      .map(([x, y, h]) => `<rect x="${x}" y="${y}" width="16" height="${h}" rx="8" fill="url(#g)"/>`)
      .join('');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs>' +
      '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="8" y1="64" x2="120" y2="64">' +
      `<stop offset="0" stop-color="${light}"/><stop offset="0.5" stop-color="${middle}"/>` +
      `<stop offset="1" stop-color="${dark}"/></linearGradient></defs>${bars}</svg>`;
    icon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  try {
    const theme = sessionStorage.getItem('sr-demo-theme');
    if (theme) root.dataset.theme = theme;
  } catch { /* storage may be unavailable */ }
  paintIcon();
  new window.MutationObserver(paintIcon).observe(root, { attributeFilter: ['data-theme'] });

  // The demo panel, a frame of this page from this site, reports the theme
  // picked in it, for the next page of the visit. Nothing else is listened
  // to, and only a theme this site has is kept.
  const THEMES = ['glow', 'pink', 'midnight', 'paper', 'frost'];
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    if (![...document.querySelectorAll('iframe')].some((frame) => frame.contentWindow === event.source)) return;
    const message = event.data;
    if (!message || message.source !== 'sr-popup' || message.type !== 'theme' || !THEMES.includes(message.theme)) return;
    try { sessionStorage.setItem('sr-demo-theme', message.theme); } catch { /* ignore */ }
  });
}());
