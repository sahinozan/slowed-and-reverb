'use strict';

// Renders the production popup for site/, at the resolution the page needs.
//
// The site shows the real interface rather than store screenshots: those exist
// because Chrome and Firefox require them, and at page size the popup inside
// them is unreadable. Each capture here is the shipping popup.html, popup.css,
// and popup.js driven by the shared stub in popup-preview.js.
//
// Panels people are meant to read render at 3x; the theme row is a colour
// comparison at thumbnail size, so 2x is enough for it.

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { DEFAULT_SETTINGS, POPUP_W, renderPopup, startServer } = require('./popup-preview');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'site', 'assets');

const VARIANTS = Object.freeze({
  'popup-basic': {
    scale: 3,
    theme: 'pink',
    settings: { ...DEFAULT_SETTINGS, speed: 0.8, reverb: 40 }
  },
  'popup-advanced': {
    scale: 3,
    theme: 'pink',
    panel: 'advanced',
    settings: {
      ...DEFAULT_SETTINGS, speed: 0.85, reverb: 35, echo: 20,
      pan: -25, width: 130, saturation: 25
    }
  },
  'popup-presets': {
    scale: 3,
    theme: 'pink',
    panel: 'custom',
    settings: {
      ...DEFAULT_SETTINGS, speed: 0.85, reverb: 45, width: 125,
      saturation: 20, eqLow: 2, eqHigh: 3
    },
    customPresets: [
      {
        id: 'site-dreamy-wide', name: 'Dreamy Wide', speed: 0.85, reverb: 45, echo: 0,
        pan: 0, width: 125, keepPitch: false, saturation: 20, eqLow: 2, eqMid: 0, eqHigh: 3
      },
      {
        id: 'site-night-drive', name: 'Night Drive', speed: 0.95, reverb: 25, echo: 10,
        pan: 0, width: 115, keepPitch: false, saturation: 15, eqLow: 3, eqMid: -1, eqHigh: 2
      }
    ]
  },
  'popup-theme-terminal': {
    scale: 2,
    theme: 'pink',
    settings: { ...DEFAULT_SETTINGS, speed: 0.8, reverb: 40 }
  },
  'popup-theme-midnight': {
    scale: 2,
    theme: 'midnight',
    settings: { ...DEFAULT_SETTINGS, speed: 0.85, reverb: 35, eqLow: 3, eqMid: -2, eqHigh: 4 }
  },
  'popup-theme-paper': {
    scale: 2,
    theme: 'paper',
    settings: { ...DEFAULT_SETTINGS, speed: 1.2 }
  },
  'popup-theme-frost': {
    scale: 2,
    theme: 'frost',
    settings: { ...DEFAULT_SETTINGS, speed: 0.9, reverb: 25, eqHigh: 3 }
  }
});

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });

  try {
    for (const [name, variant] of Object.entries(VARIANTS)) {
      const file = path.join(outDir, `${name}.png`);
      const height = await renderPopup(browser, server.baseUrl, variant, {
        file, scale: variant.scale
      });
      // Printed so the width and height attributes in site/index.html can be
      // corrected when a panel changes size.
      console.log(
        `${name}.png  ${POPUP_W * variant.scale}x${height * variant.scale}`,
        `(${(fs.statSync(file).size / 1024).toFixed(0)} KB)`
      );
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
