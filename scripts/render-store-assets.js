'use strict';

// Builds every Chrome Web Store image from the production popup.
//
// Visual system
//   Type      Futura (display) + Menlo, the extension's own UI face.
//   Colour    Theme tokens read straight from extension/popup.css. Nothing invented.
//   Edges     Square. Chromium popups have no rounded chrome, so nothing here
//             adds any. Solid blocks instead of glows and translucent borders.
//   Motif     Bar spacing produced by integrating a playback-rate ramp, so the
//             pattern is a readout of what the extension does.
//
// Slides 1-3 show the popup over an untouched page capture, anchored top-right
// where a Chrome action popup actually opens. Slides 4-5 are poster layouts.
// Promo art is screen-print: two flat inks, halftone, offset registration.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('@playwright/test');
const { DEFAULT_SETTINGS, POPUP_W, renderPopup, startServer } = require('./popup-preview');

const root = path.join(__dirname, '..');
const sourceDir = path.join(root, 'store-assets', 'source-captures');
const shotDir = path.join(root, 'store-assets', 'screenshots');
const chromeDir = path.join(root, 'store-assets', 'chrome');
const popupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-store-popups-'));

const SLIDE_W = 1280;
const SLIDE_H = 800;
const SUPERSAMPLE = 2;

// extension/popup.css theme tokens.
const INK = '#12060d';
const OXBLOOD = '#2f0a14';
const HOT = '#e8597f';
const ROSE = '#ff9ab8';
const DEEP = '#b32a58';
const BONE = '#fff0f4';

const sources = Object.freeze({
  youtube: path.join(sourceDir, 'youtube.png'),
  youtubeMusic: path.join(sourceDir, 'youtube-music.png'),
  spotify: path.join(sourceDir, 'spotify.png')
});

const POPUP_VARIANTS = Object.freeze({
  terminal: { theme: 'pink', settings: { ...DEFAULT_SETTINGS, speed: 0.8, reverb: 40 } },
  midnight: {
    theme: 'midnight',
    settings: { ...DEFAULT_SETTINGS, speed: 0.85, reverb: 35, eqLow: 3, eqMid: -2, eqHigh: 4 }
  },
  paper: { theme: 'paper', settings: { ...DEFAULT_SETTINGS, speed: 1.2 } },
  frost: { theme: 'frost', settings: { ...DEFAULT_SETTINGS, speed: 0.9, reverb: 25, eqHigh: 3 } },
  advanced: {
    theme: 'pink', panel: 'advanced',
    settings: {
      ...DEFAULT_SETTINGS, speed: 1.1, reverb: 35, echo: 20,
      pan: -25, width: 130, keepPitch: false, saturation: 25
    }
  },
  custom: {
    theme: 'pink', panel: 'custom',
    settings: {
      ...DEFAULT_SETTINGS, speed: 0.85, reverb: 45, width: 125,
      saturation: 20, eqLow: 2, eqHigh: 3
    },
    customPresets: [
      {
        id: 'store-dreamy-wide', name: 'Dreamy Wide', speed: 0.85, reverb: 45, echo: 0,
        pan: 0, width: 125, keepPitch: false, saturation: 20, eqLow: 2, eqMid: 0, eqHigh: 3
      },
      {
        id: 'store-night-drive', name: 'Night Drive', speed: 0.95, reverb: 25, echo: 10,
        pan: 0, width: 115, keepPitch: false, saturation: 15, eqLow: 3, eqMid: -1, eqHigh: 2
      }
    ]
  }
});

// Natural popup height per variant, measured at capture time. The popup is
// content-sized, so a fixed clip would either crop live controls or leave a
// band of dead background under them.
const popupSizes = new Map();
const popupHeightAt = (name, width) => Math.round(popupSizes.get(name) * (width / POPUP_W));

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function assertSourceCaptures() {
  const missing = Object.values(sources).filter((file) => !fs.existsSync(file));
  if (missing.length === 0) return;
  throw new Error(
    `Missing source captures:\n${missing.map((f) => `- ${path.relative(root, f)}`).join('\n')}`
  );
}

function storeRoutes() {
  const routes = new Map([
    ['/raw/youtube.png', sources.youtube],
    ['/raw/youtube-music.png', sources.youtubeMusic],
    ['/raw/spotify.png', sources.spotify]
  ]);
  for (const name of Object.keys(POPUP_VARIANTS)) {
    routes.set(`/popups/${name}.png`, path.join(popupDir, `${name}.png`));
  }
  return routes;
}

// --- signature geometry ----------------------------------------------------
// Bar positions from integrating a rate ramp: even at 1.00x, progressively
// wider as the rate falls. Used at poster scale on slides 4-5 and as a small
// strip inside the caption blocks on slides 1-3.
function rateBars({ width, from = 1.0, to = 0.42, step = 17 }) {
  const bars = [];
  let x = 0;
  while (x < width) {
    const rate = from + (to - from) * (x / width);
    bars.push({ x, rate });
    x += step / rate;
  }
  return bars;
}

const rateField = ({ width, height, fill, step, weight = 16, opacity = 1 }) => `
  <svg width="${width}" height="${height}" style="position:absolute;inset:0;opacity:${opacity}">
    ${rateBars({ width, step }).map(({ x, rate }) => {
    const w = 4 + (1 - rate) * weight;
    return `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}" fill="${fill}"/>`;
  }).join('')}
  </svg>`;

// The same motif at caption scale, tying slides 1-3 to the poster slides.
const rateStrip = (width, height, fill) => `
  <svg width="${width}" height="${height}" style="display:block">
    ${rateBars({ width, step: 9 }).map(({ x, rate }) => {
    const w = 2 + (1 - rate) * 6;
    return `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}" fill="${fill}"/>`;
  }).join('')}
  </svg>`;

// --- brand mark ------------------------------------------------------------
// Geometry and colour ramp are copied from scripts/render-icons.js, the single
// source of truth for the icon: five bars on a 128 grid, 16 wide and 8 apart,
// heights 48/80/120/80/48, ends fully rounded. Natural bounds are 112 x 120,
// so the mark is slightly TALLER than wide. Reproducing it here rather than
// approximating with div rules keeps the store art identical to the shipped
// icon, gradient and sheen included.
const ICON = Object.freeze({
  barWidth: 16,
  gap: 8,
  heights: [48, 80, 120, 80, 48],
  x0: 8,
  centreY: 64,
  boundsWidth: 112,
  boundsHeight: 120,
  ramp: [['0', ROSE], ['0.5', HOT], ['1', DEEP]],
  sheen: [['0', '0.34'], ['0.55', '0']]
});

let markSequence = 0;

// `height` is the height of the tallest (centre) bar, matching the 120 unit.
function brandMark(height) {
  const id = `sr-mark-${++markSequence}`;
  const scale = height / ICON.boundsHeight;
  const bars = (fill) => ICON.heights.map((barHeight, index) => {
    const x = ICON.x0 + index * (ICON.barWidth + ICON.gap);
    return `<rect x="${x}" y="${ICON.centreY - barHeight / 2}" width="${ICON.barWidth}"
      height="${barHeight}" rx="${ICON.barWidth / 2}" fill="${fill}"/>`;
  }).join('');

  return `<svg width="${(ICON.boundsWidth * scale).toFixed(2)}"
    height="${(ICON.boundsHeight * scale).toFixed(2)}"
    viewBox="${ICON.x0} 4 ${ICON.boundsWidth} ${ICON.boundsHeight}"
    style="display:block;flex:none">
    <defs>
      <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="8" y1="64" x2="120" y2="64">
        ${ICON.ramp.map(([offset, colour]) => `<stop offset="${offset}" stop-color="${colour}"/>`).join('')}
      </linearGradient>
      <linearGradient id="${id}-sheen" gradientUnits="userSpaceOnUse" x1="64" y1="4" x2="64" y2="124">
        ${ICON.sheen.map(([offset, opacity]) => `<stop offset="${offset}" stop-color="#ffffff" stop-opacity="${opacity}"/>`).join('')}
      </linearGradient>
    </defs>
    ${bars(`url(#${id})`)}${bars(`url(#${id}-sheen)`)}
  </svg>`;
}

const brandLockup = (textColour = BONE) => `
  <div style="display:flex;align-items:center;gap:13px">
    ${brandMark(30)}
    <span class="display" style="font-size:19px;color:${textColour};letter-spacing:.4px">Slowed &amp; Reverb</span>
  </div>`;

const page = (w, h, body, css = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; margin: 0; overflow: hidden; }
  body { -webkit-font-smoothing: antialiased; }
  .mono { font-family: Menlo, monospace; }
  .display { font-family: Futura, "Century Gothic", sans-serif; font-weight: 700; }
  ${css}</style></head><body>${body}</body></html>`;

// --- slides 1-3: popup over a real page ------------------------------------
function siteSlide({ baseUrl, background, popup, eyebrow, heading, credit = '' }) {
  const w = 400;
  const h = popupHeightAt(popup, w);
  return page(SLIDE_W, SLIDE_H, `
    <img src="${baseUrl}/raw/${background}.png"
         style="position:absolute;inset:0;width:${SLIDE_W}px;height:${SLIDE_H}px;object-fit:cover">
    <div style="position:absolute;inset:0;
                background:linear-gradient(90deg,rgba(18,6,13,.42),rgba(18,6,13,.05) 44%,rgba(18,6,13,.55))"></div>
    <!-- Anchored top-right, where a Chrome action popup actually opens. -->
    <div style="position:absolute;right:52px;top:26px;width:${w}px;height:${h}px;
                box-shadow:0 26px 64px rgba(0,0,0,.62)">
      <img src="${baseUrl}/popups/${popup}.png" style="display:block;width:${w}px;height:${h}px">
    </div>
    <!-- Solid block rather than text floating on the page: matches the popup's
         own square, flat-fill language and stays legible over any frame. -->
    <div style="position:absolute;left:0;bottom:62px;background:${INK};padding:20px 44px 24px 54px">
      <div style="opacity:.85;margin-bottom:14px">${rateStrip(210, 11, HOT)}</div>
      <div class="mono" style="font-size:14px;letter-spacing:3.2px;color:${ROSE};text-transform:uppercase">${escapeHtml(eyebrow)}</div>
      <div class="display" style="margin-top:11px;font-size:54px;line-height:1;color:${BONE}">${escapeHtml(heading)}</div>
      ${credit ? `<div class="mono" style="margin-top:16px;font-size:10.5px;
        color:rgba(255,240,244,.52)">${escapeHtml(credit)}</div>` : ''}
    </div>`);
}

// --- slides 4-5: poster layouts --------------------------------------------
const centeredTop = (headerBottom, blockHeight) => Math.round(
  headerBottom + Math.max(0, SLIDE_H - headerBottom - blockHeight) / 2
);

function posterGround() {
  return `
    <div style="position:absolute;inset:0;background:${OXBLOOD}"></div>
    ${rateField({ width: SLIDE_W, height: SLIDE_H, fill: HOT, step: 17, weight: 16, opacity: 0.20 })}`;
}

function controlsSlide(baseUrl) {
  const cardWidth = 288;
  const items = [
    ['terminal', 'Presets and EQ', 'Start from Slowed + Reverb or Nightcore.'],
    ['advanced', 'Advanced controls', 'Pitch, echo, pan, width and saturation.'],
    ['custom', 'Your own presets', 'Save a combination and reuse it later.']
  ];
  const band = Math.max(...items.map(([k]) => popupHeightAt(k, cardWidth)));
  // Reserve the full two-line caption height so it cannot run off the frame.
  const top = centeredTop(196, band + 26 + 84);

  return page(SLIDE_W, SLIDE_H, `
    ${posterGround()}
    <header style="position:absolute;left:64px;right:64px;top:46px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        ${brandLockup()}
        <div class="mono" style="font-size:12px;letter-spacing:3px;color:${ROSE};text-transform:uppercase">Controls</div>
      </div>
      <div class="display" style="margin-top:26px;font-size:46px;line-height:1;color:${BONE}">
        Start quickly. Fine-tune when you want.
      </div>
    </header>
    <main style="position:absolute;left:64px;right:64px;top:${top}px;
                 display:flex;justify-content:space-between;align-items:flex-start">
      ${items.map(([k, title]) => `
        <div style="width:${cardWidth}px;height:${popupHeightAt(k, cardWidth)}px;overflow:hidden;
                    box-shadow:12px 12px 0 rgba(18,6,13,.55)">
          <img src="${baseUrl}/popups/${k}.png" alt="${escapeHtml(title)}"
               style="display:block;width:${cardWidth}px;height:${popupHeightAt(k, cardWidth)}px">
        </div>`).join('')}
    </main>
    <div style="position:absolute;left:64px;right:64px;top:${top + band + 26}px;
                display:flex;justify-content:space-between">
      ${items.map(([, title, body]) => `
        <div style="width:${cardWidth}px">
          <div class="display" style="font-size:20px;color:${BONE}">${escapeHtml(title)}</div>
          <div class="mono" style="margin-top:8px;font-size:15px;line-height:1.5;color:${ROSE}">${escapeHtml(body)}</div>
        </div>`).join('')}
    </div>`);
}

function themesSlide(baseUrl) {
  const cardWidth = 269;
  const themes = [
    ['terminal', 'Terminal', '#e8597f'],
    ['midnight', 'Midnight', '#82d9ad'],
    ['paper', 'Paper', '#7d56d2'],
    ['frost', 'Frost', '#25a8e4']
  ];
  const band = Math.max(...themes.map(([k]) => popupHeightAt(k, cardWidth)));
  const top = centeredTop(196, band + 24 + 22);

  return page(SLIDE_W, SLIDE_H, `
    ${posterGround()}
    <header style="position:absolute;left:68px;right:68px;top:46px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        ${brandLockup()}
        <div class="mono" style="font-size:12px;letter-spacing:3px;color:${ROSE};text-transform:uppercase">Themes</div>
      </div>
      <div class="display" style="margin-top:26px;font-size:46px;line-height:1;color:${BONE}">
        Four themes. Same controls.
      </div>
    </header>
    <main style="position:absolute;left:68px;right:68px;top:${top}px;
                 display:flex;justify-content:space-between;align-items:flex-start">
      ${themes.map(([k, name]) => `
        <div style="width:${cardWidth}px;height:${popupHeightAt(k, cardWidth)}px;overflow:hidden;
                    box-shadow:10px 10px 0 rgba(18,6,13,.55)">
          <img src="${baseUrl}/popups/${k}.png" alt="${escapeHtml(name)} theme"
               style="display:block;width:${cardWidth}px;height:${popupHeightAt(k, cardWidth)}px">
        </div>`).join('')}
    </main>
    <div style="position:absolute;left:68px;right:68px;top:${top + band + 24}px;
                display:flex;justify-content:space-between">
      ${themes.map(([, name, colour]) => `
        <div class="mono" style="width:${cardWidth}px;display:flex;align-items:center;justify-content:center;
             gap:9px;font-size:15px;color:${BONE}">
          <span style="width:9px;height:9px;border-radius:50%;background:${colour}"></span>${escapeHtml(name)}
        </div>`).join('')}
    </div>`);
}

// --- promo art -------------------------------------------------------------
// Same ground, motif and type as slides 4-5, so the promo art and the
// screenshots read as one product rather than two brands.
function promoTile() {
  return page(440, 280, `
    <div style="position:absolute;inset:0;background:${OXBLOOD}"></div>
    <!-- Field opacity chosen against the half-size render: above ~0.35 the bars
         and the mark's own bars read at the same value and the tile turns muddy
         in search results. -->
    ${rateField({ width: 440, height: 280, fill: HOT, step: 12, weight: 11, opacity: 0.30 })}
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
      ${brandMark(176)}
    </div>`);
}

function promoMarquee() {
  return page(1400, 560, `
    <div style="position:absolute;inset:0;background:${OXBLOOD}"></div>
    ${rateField({ width: 1400, height: 560, fill: HOT, step: 25, weight: 20, opacity: 0.34 })}
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:52px">
      ${brandMark(196)}
      <div class="display" style="font-size:96px;line-height:1;color:${BONE};letter-spacing:-.5px">
        Slowed &amp; Reverb
      </div>
    </div>`);
}

// --- render ----------------------------------------------------------------
// Renders at SUPERSAMPLE then downsamples in-browser, so headline type matches
// the 3x popup captures instead of being a soft 1x rasterisation.
async function renderScaled(browser, target, html, width, height) {
  const big = await browser.newPage({
    viewport: { width, height }, deviceScaleFactor: SUPERSAMPLE
  });
  await big.setContent(html, { waitUntil: 'networkidle' });
  await big.evaluate(() => document.fonts.ready);
  const buffer = await big.screenshot();
  await big.close();

  const shrink = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await shrink.setContent(`<!doctype html><html><head><style>
      html, body { margin:0; width:${width}px; height:${height}px; overflow:hidden; }
      img { display:block; width:${width}px; height:${height}px; }
    </style></head><body><img src="data:image/png;base64,${buffer.toString('base64')}"></body></html>`,
  { waitUntil: 'load' });
  await shrink.evaluate(() => {
    const image = document.querySelector('img');
    return image.complete ? null : image.decode();
  });
  await shrink.screenshot({ path: target });
  await shrink.close();
}

const renderSlide = (browser, file, html) =>
  renderScaled(browser, path.join(shotDir, file), html, SLIDE_W, SLIDE_H);

async function main() {
  assertSourceCaptures();
  fs.mkdirSync(shotDir, { recursive: true });
  fs.mkdirSync(chromeDir, { recursive: true });
  const server = await startServer(storeRoutes());
  const browser = await chromium.launch({ headless: true });

  try {
    for (const [name, variant] of Object.entries(POPUP_VARIANTS)) {
      const height = await renderPopup(browser, server.baseUrl, variant, {
        file: path.join(popupDir, `${name}.png`)
      });
      popupSizes.set(name, height);
    }
    const baseUrl = server.baseUrl;

    await renderSlide(browser, '01-youtube.png', siteSlide({
      baseUrl,
      background: 'youtube',
      popup: 'terminal',
      eyebrow: 'Compatible with YouTube™',
      heading: 'Slow it down.',
      credit: 'Big Buck Bunny © Blender Foundation · CC BY 3.0'
    }));
    await renderSlide(browser, '02-youtube-music.png', siteSlide({
      baseUrl,
      background: 'youtube-music',
      popup: 'midnight',
      eyebrow: 'Compatible with YouTube Music™',
      heading: 'Shape the tone.'
    }));
    await renderSlide(browser, '03-spotify.png', siteSlide({
      baseUrl,
      background: 'spotify',
      popup: 'terminal',
      eyebrow: 'Compatible with the Spotify web player',
      heading: 'Opt in when you need it.'
    }));
    await renderSlide(browser, '04-controls.png', controlsSlide(baseUrl));
    await renderSlide(browser, '05-themes.png', themesSlide(baseUrl));

    // Small tile carries the mark alone: the store already prints the name
    // beside it, and Google asks for no text at this size.
    await renderScaled(browser, path.join(chromeDir, 'promotional-tile-440x280.png'),
      promoTile(), 440, 280);
    await renderScaled(browser, path.join(chromeDir, 'marquee-1400x560.png'),
      promoMarquee(), 1400, 560);
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(popupDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fs.rmSync(popupDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
