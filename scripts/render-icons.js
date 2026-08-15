'use strict';

// Regenerates every icon artefact from the single geometry definition below:
// the two source SVGs, the six store PNGs, and the inline mark in the popup
// header. Run `npm run icons` after changing anything in this file.

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const root = path.join(__dirname, '..');
const extensionDir = path.join(root, 'extension');
const assetsDir = path.join(extensionDir, 'assets');
const popupFile = path.join(extensionDir, 'popup.html');

// Five symmetric bars on a 128 grid. Bar edges stay on multiples of 8 so the
// 8:1 reduction to 16 px lands on whole pixels and the sides render crisp.
const BAR_WIDTH = 16;
const BAR_GAP = 8;
const BAR_HEIGHTS = [48, 80, 120, 80, 48];
const FIRST_BAR_X = 8;
const CENTRE_Y = 64;

const RAMPS = {
  on: [['0', '#ff9ab8'], ['0.5', '#e8597f'], ['1', '#b32a58']],
  off: [['0', '#9aa3b8'], ['1', '#5f677e']]
};
// Top-down sheen, identical in both states so they read as one object.
const SHEEN = [['0', '#ffffff', '0.34'], ['0.55', '#ffffff', '0']];

const PNG_SIZES = [16, 48, 128];
const LOGO_START = '<!-- icon:start -->';
const LOGO_END = '<!-- icon:end -->';

function bars(fill, indent, className) {
  const classAttr = className ? ` class="${className}"` : '';
  return BAR_HEIGHTS.map((height, index) => {
    const x = FIRST_BAR_X + index * (BAR_WIDTH + BAR_GAP);
    const y = CENTRE_Y - height / 2;
    return `${indent}<rect${classAttr} x="${x}" y="${y}" width="${BAR_WIDTH}" height="${height}" rx="${BAR_WIDTH / 2}" fill="${fill}"/>`;
  }).join('\n');
}

function markup(prefix, state, indent = '  ') {
  const gradientId = prefix;
  const sheenId = `${prefix}-sheen`;
  const stops = RAMPS[state]
    .map(([offset, color]) => `${indent}    <stop offset="${offset}" stop-color="${color}"/>`)
    .join('\n');
  const sheenStops = SHEEN
    .map(([offset, color, opacity]) =>
      `${indent}    <stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`)
    .join('\n');

  return [
    `${indent}<defs>`,
    `${indent}  <linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="8" y1="64" x2="120" y2="64">`,
    stops,
    `${indent}  </linearGradient>`,
    `${indent}  <linearGradient id="${sheenId}" gradientUnits="userSpaceOnUse" x1="64" y1="4" x2="64" y2="124">`,
    sheenStops,
    `${indent}  </linearGradient>`,
    `${indent}</defs>`,
    bars(`url(#${gradientId})`, indent),
    bars(`url(#${sheenId})`, indent)
  ].join('\n');
}

function svg(prefix, state) {
  return `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
${markup(prefix, state)}
</svg>
`;
}

// Theme colors live beside the other theme tokens in popup.css. The generated
// stops use stable classes so one gradient follows those CSS variables without
// duplicating a color table here.
function popupMarkup(indent) {
  const sheenStops = SHEEN
    .map(([offset, color, opacity]) =>
      `${indent}    <stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`)
    .join('\n');

  return [
    `${indent}<defs>`,
    `${indent}  <linearGradient id="sr-logo" gradientUnits="userSpaceOnUse" x1="8" y1="64" x2="120" y2="64">`,
    `${indent}    <stop class="sr-logo-stop-light" offset="0"/>`,
    `${indent}    <stop class="sr-logo-stop-middle" offset="0.5"/>`,
    `${indent}    <stop class="sr-logo-stop-dark" offset="1"/>`,
    `${indent}  </linearGradient>`,
    `${indent}  <linearGradient id="sr-logo-sheen" gradientUnits="userSpaceOnUse" x1="64" y1="4" x2="64" y2="124">`,
    sheenStops,
    `${indent}  </linearGradient>`,
    `${indent}</defs>`,
    bars('url(#sr-logo)', indent, 'sr-bar'),
    bars('url(#sr-logo-sheen)', indent, 'sr-sheen')
  ].join('\n');
}

function popupBlock(indent) {
  return [
    LOGO_START,
    `${indent}<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">`,
    popupMarkup(`${indent}  `),
    `${indent}</svg>`,
    `${indent}${LOGO_END}`
  ].join('\n');
}

// The popup mark is inline rather than an <img> so it inherits no network or
// CSP concerns; keep its gradient ids distinct from anything else on the page.
function updatePopup(indent) {
  const source = fs.readFileSync(popupFile, 'utf8');
  const start = source.indexOf(LOGO_START);
  const end = source.indexOf(LOGO_END);
  if (start === -1 || end === -1) {
    throw new Error(`popup.html is missing the ${LOGO_START} / ${LOGO_END} markers`);
  }

  const block = popupBlock(indent);

  const updated = source.slice(0, start) + block + source.slice(end + LOGO_END.length);
  fs.writeFileSync(popupFile, updated);
  return updated !== source;
}

async function main() {
  const sources = { '': svg('sr-on', 'on'), '-off': svg('sr-off', 'off') };

  fs.writeFileSync(path.join(assetsDir, 'icon.svg'), sources['']);
  fs.writeFileSync(path.join(assetsDir, 'icon-off.svg'), sources['-off']);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const [suffix, source] of Object.entries(sources)) {
      for (const size of PNG_SIZES) {
        await page.setViewportSize({ width: size, height: size });
        await page.setContent(
          '<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>' +
          source.replace('width="128" height="128"', `width="${size}" height="${size}"`)
        );
        await page.screenshot({
          path: path.join(assetsDir, `icon${size}${suffix}.png`),
          omitBackground: true
        });
      }
    }
  } finally {
    await browser.close();
  }

  const changed = updatePopup('          ');
  console.log(`Wrote 2 SVGs and ${PNG_SIZES.length * 2} PNGs to extension/assets/`);
  console.log(changed ? 'Updated the popup header mark' : 'Popup header mark already current');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { popupBlock };
