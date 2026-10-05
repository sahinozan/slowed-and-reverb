'use strict';

// Builds the Chrome Web Store and Firefox Add-ons images, and the website's
// social preview, in the same visual language as the site.
//
// Sizing
//   The Chrome Web Store shows screenshots at 593x371, 46% of their 1280x800
//   size, and the promo tile at about 306x195. Everything here is sized for
//   that: headlines around 60px, the popup 470px wide or more, and at least
//   48px clear on every edge, so captions and the popup stay readable.
//
// Visual system
//   Type      Fraunces 600 (site/assets/fonts), Avenir Next for body text, and
//             Menlo inside the popup and on the cassette label.
//   Color     The site's Terminal tokens: black, white, and the pink accent.
//   Popup     The production popup, rendered at 3x by popup-preview.js.
//   Cassette  Read from site/index.html, so the store art and the site share
//             one drawing.
//
// Every slide puts a blurred page capture under a plain drawn toolbar, with the
// extension's icon ringed and the popup opening below it, so a new user sees
// where to click. Captions are one plain heading and one line under it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('@playwright/test');
const { DEFAULT_SETTINGS, POPUP_W, renderPopup, startServer } = require('./popup-preview');

const root = path.join(__dirname, '..');
const shotDir = path.join(root, 'store-assets', 'screenshots');
const chromeDir = path.join(root, 'store-assets', 'chrome');
const ogCard = path.join(root, 'site', 'assets', 'og-card.png');
const popupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-store-popups-'));

const SUPERSAMPLE = 2;
const SLIDE_W = 1280;
const SLIDE_H = 800;
const MARGIN = 56;
const HEADLINE = 60;
const SUBLINE = 26;

// Full-screen browser captures. cropTop removes the capturing browser's own
// toolbar (and the macOS menu bar); cropSide trims the window border.
const CAPTURES = Object.freeze({
  youtube: {
    file: 'store-assets/originals/2026-10-05/youtube.png',
    cropTop: 16, cropSide: 16, url: 'youtube.com'
  },
  youtubeMusic: {
    file: 'store-assets/originals/2026-10-05/youtube-music.png',
    cropTop: 16, cropSide: 16, url: 'music.youtube.com'
  },
  youtubePlaylist: {
    file: 'store-assets/originals/2026-10-05/youtube-playlist.png',
    cropTop: 16, cropSide: 16, url: 'youtube.com'
  },
  spotify: {
    file: 'store-assets/originals/2026-10-05/spotify.png',
    cropTop: 16, cropSide: 16, url: 'open.spotify.com'
  }
});

const COLOR = Object.freeze({
  accent: 'hsl(343 66% 63%)',
  light: '#ff9ab8',
  middle: '#e8597f',
  dark: '#b32a58',
  label: 'hsl(343 66% 11%)',
  body: '#dcdce2'
});
// Promo images fill their area with a saturated deep pink, so their edges read
// on the store's light gray and dark cards alike.
const PROMO_BG = 'radial-gradient(120% 120% at 30% 20%, #5a1530 0%, #34091a 55%, #1d0510 100%)';

const POPUP_VARIANTS = Object.freeze({
  slowed: { theme: 'pink', settings: { ...DEFAULT_SETTINGS, speed: 0.8, reverb: 40 } },
  advanced: {
    theme: 'pink', panel: 'advanced',
    settings: {
      ...DEFAULT_SETTINGS, speed: 0.85, reverb: 35, echo: 20, pan: -15,
      width: 130, saturation: 20, eqLow: 4, eqMid: -1, eqHigh: 2
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
        id: 'store-late-night', name: 'Late night', speed: 0.85, reverb: 45, echo: 0,
        pan: 0, width: 125, keepPitch: false, saturation: 20, eqLow: 2, eqMid: 0, eqHigh: 3
      },
      {
        id: 'store-car-speakers', name: 'Car speakers', speed: 0.9, reverb: 25, echo: 10,
        pan: 0, width: 115, keepPitch: false, saturation: 15, eqLow: 5, eqMid: -1, eqHigh: 1
      }
    ]
  },
  nightcore: { theme: 'pink', settings: { ...DEFAULT_SETTINGS, speed: 1.2 } },
  midnight: {
    theme: 'midnight',
    settings: { ...DEFAULT_SETTINGS, speed: 0.85, reverb: 35, eqLow: 3, eqMid: -2, eqHigh: 4 }
  },
  paper: { theme: 'paper', settings: { ...DEFAULT_SETTINGS, speed: 1.2 } },
  frost: { theme: 'frost', settings: { ...DEFAULT_SETTINGS, speed: 0.9, reverb: 25, eqHigh: 3 } },
  // Just the header and the opt-in box, enlarged so its text reads at store size.
  spotifyAskTop: {
    theme: 'pink', url: 'https://open.spotify.com/', siteAccess: false, cropBelow: '#spotify-permission-panel',
    settings: { ...DEFAULT_SETTINGS, speed: 0.8, reverb: 40 }
  },
});

// Natural popup height per variant, measured at capture time. The popup is
// content-sized, so a fixed clip would either crop controls or leave dead space.
const popupHeights = new Map();

function pngWidth(file) {
  return fs.readFileSync(file).readUInt32BE(16);
}

function assertCaptures() {
  const missing = Object.values(CAPTURES).filter(({ file }) => !fs.existsSync(path.join(root, file)));
  if (missing.length === 0) return;
  throw new Error(`Missing captures:\n${missing.map(({ file }) => `- ${file}`).join('\n')}`);
}

// The cassette drawing from the home page, as plain SVG markup.
function cassetteMarkup() {
  const html = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
  const svg = html.match(/<figure class="cassette"[^>]*>\s*(<svg[\s\S]*?<\/svg>)\s*<\/figure>/);
  if (!svg) throw new Error('site/index.html no longer has the cassette figure');
  return svg[1];
}

// The site's cassette styles, resolved to the Terminal theme.
const CASSETTE_CSS = `
  .cassette svg { width:100%; height:auto; display:block; }
  .shell { fill: color-mix(in srgb, #fff 12%, #000); }
  .shell-line, .window-line { stroke: hsl(343 66% 63% / .35); }
  .label { fill: ${COLOR.label}; }
  .stripe-a { fill: ${COLOR.light}; } .stripe-b { fill: ${COLOR.middle}; } .stripe-c { fill: ${COLOR.dark}; }
  .typed { font-family: Menlo, monospace; fill: #fff; }
  .typed.title { font-size: 30px; font-weight: 700; }
  .typed.sub { font-size: 17px; fill: ${COLOR.light}; }
  .label-rule { stroke: color-mix(in srgb, ${COLOR.light} 45%, transparent); }
  .window, .hub-hole, .teeth, .holes { fill: #000; }
  .tape, .tape-line { fill: color-mix(in srgb, ${COLOR.dark} 45%, #000); stroke: color-mix(in srgb, ${COLOR.dark} 45%, #000); }
  .hub { fill: ${COLOR.accent}; }
  .plate { fill: color-mix(in srgb, #fff 6%, #000); }
  .screws { fill: color-mix(in srgb, #fff 12%, #000); stroke: hsl(343 66% 63% / .35); }`;

// The label with only the name, set large enough to read at tile size.
function nameOnlyCassette() {
  return cassetteMarkup()
    .replace(/<text class="typed sub"[^>]*>[^<]*<\/text>\s*/g, '')
    .replace(/<text class="typed title" x="76" y="88">/, '<text class="typed title" x="76" y="104" style="font-size:52px">')
    .replace('y1="104" x2="644" y2="104"', 'y1="128" x2="644" y2="128"');
}

function mark(size) {
  const bars = '<rect x="8" y="40" width="16" height="48" rx="8"/><rect x="32" y="24" width="16" height="80" rx="8"/>'
    + '<rect x="56" y="4" width="16" height="120" rx="8"/><rect x="80" y="24" width="16" height="80" rx="8"/>'
    + '<rect x="104" y="40" width="16" height="48" rx="8"/>';
  return `<svg width="${size}" height="${size}" viewBox="0 0 128 128" aria-hidden="true"><defs>
    <linearGradient id="mf${size}" gradientUnits="userSpaceOnUse" x1="8" y1="64" x2="120" y2="64">
      <stop offset="0" stop-color="${COLOR.light}"/><stop offset=".5" stop-color="${COLOR.middle}"/><stop offset="1" stop-color="${COLOR.dark}"/></linearGradient>
    <linearGradient id="ms${size}" gradientUnits="userSpaceOnUse" x1="64" y1="4" x2="64" y2="124">
      <stop offset="0" stop-color="#fff" stop-opacity=".34"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>
    </defs><g fill="url(#mf${size})">${bars}</g><g fill="url(#ms${size})">${bars}</g></svg>`;
}

// The screenshots' palette: a deep cherry that the blurred pages fade into, and
// a toolbar tinted to match, so the extension's ringed icon is the one accent.
const G = Object.freeze({
  fade: '30,6,17', ink: '#fff', body: '#ecd9e0',
  bar: 'rgba(26,6,15,.94)', barLine: 'rgba(255,255,255,.07)',
  url: 'rgba(255,255,255,.07)', urlInk: 'rgba(255,238,244,.74)', glyph: 'rgba(255,238,244,.58)',
  dot: 'rgba(255,238,244,.2)',
  lift: '0 28px 70px rgba(10,0,4,.7), 0 0 0 1px rgba(255,255,255,.08)', frame: 'rgba(255,255,255,.12)'
});

const page = (width, height, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Fraunces; src: url(/font/fraunces.woff2) format("woff2"); font-weight: 600; }
  html, body { margin:0; width:${width}px; height:${height}px; overflow:hidden; background:#160410; color:${G.ink};
    font-family:"Avenir Next", Avenir, "Segoe UI", sans-serif; -webkit-font-smoothing:antialiased; }
  .display { font-family:Fraunces, Georgia, serif; font-weight:600; letter-spacing:-.01em;
    font-variation-settings:"SOFT" 60, "WONK" 1, "opsz" 72; }
  .headline { font-size:${HEADLINE}px; line-height:1.06; text-wrap:balance; }
  .subline { font-size:${SUBLINE}px; line-height:1.38; color:${G.body}; margin-top:18px; text-wrap:pretty; }
  .lift { box-shadow:${G.lift}; }
  ${CASSETTE_CSS}
</style></head><body>${body}</body></html>`;

function popup(name, width) {
  const height = Math.round(popupHeights.get(name) * width / POPUP_W);
  return `<img src="/popups/${name}.png" style="display:block;width:${width}px;height:${height}px" alt="">`;
}

// A plain toolbar: window controls, navigation, the address, the extensions
// menu, and the extension's icon with a ring around it.
function toolbar(url, height) {
  const dots = Array.from({ length: 3 },
    () => `<span style="width:13px;height:13px;border-radius:50%;background:${G.dot}"></span>`).join('');
  const icon = (paths, opacity = 1) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="${G.glyph}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      style="opacity:${opacity}" aria-hidden="true">${paths}</svg>`;
  return `
    <div style="position:absolute;inset:0 0 auto 0;height:${height}px;display:flex;align-items:center;gap:22px;
                padding:0 22px;box-sizing:border-box;background:${G.bar};border-bottom:1px solid ${G.barLine}">
      <div style="display:flex;gap:9px">${dots}</div>
      <div style="display:flex;align-items:center;gap:16px">
        ${icon('<path d="M19 12H5M11 6l-6 6 6 6"/>')}
        ${icon('<path d="M5 12h14M13 6l6 6-6 6"/>', 0.45)}
        ${icon('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>')}
      </div>
      <div style="flex:1;height:40px;border-radius:20px;background:${G.url};display:flex;align-items:center;
                  padding:0 18px;font-size:19px;color:${G.urlInk}">${url}</div>
      ${icon('<path d="M10 4h4v3a2 2 0 1 0 0 0h5v5h-2a2 2 0 1 0 0 4h2v4h-5v-2a2 2 0 1 0-4 0v2H5v-5h2a2 2 0 1 0 0-4H5V7h5z"/>')}
      <div style="width:46px;height:46px;border-radius:50%;display:grid;place-items:center;
                  background:hsl(343 66% 63% / .25);box-shadow:0 0 0 3px ${COLOR.accent}">${mark(26)}</div>
    </div>`;
}

// --- slides: the popup on a supported site ---------------------------------
function siteSlide({ capture, popupName, heading, subline, headingSize = HEADLINE, enlarged = false, maxPopup = 470 }) {
  const bar = 64;
  const source = CAPTURES[capture];
  const fullWidth = pngWidth(path.join(root, source.file));
  const scale = SLIDE_W / (fullWidth - 2 * source.cropSide);
  const top = Math.round(source.cropTop * scale);
  // As wide as maxPopup allows, unless that would cross the bottom margin.
  const popupWidth = enlarged
    ? 640
    : Math.min(maxPopup, Math.floor((SLIDE_H - bar - 10 - 48) * POPUP_W / popupHeights.get(popupName)));
  // An enlarged crop fades out at its cut edge instead of ending in a hard line.
  const cut = enlarged ? '-webkit-mask-image:linear-gradient(180deg,#000 82%,transparent);' : '';
  // The page is only context: blurred and dimmed, it says "a music page" by its
  // colors without detail that competes with the popup at store size.
  const backdrop = `
    <div style="position:absolute;left:0;right:0;top:${bar}px;bottom:0;overflow:hidden">
      <img src="/capture/${capture}.png" alt=""
           style="position:absolute;left:${-Math.round(source.cropSide * scale)}px;top:${-top}px;
                  width:${Math.round(fullWidth * scale)}px;filter:blur(18px) brightness(.62) saturate(1.2);
                  transform:scale(1.06);transform-origin:50% 30%">
    </div>
    <!-- Darkest at the bottom, where the caption sits; the top keeps the page's color. -->
    <div style="position:absolute;left:0;right:0;top:${bar}px;bottom:0;background:linear-gradient(180deg,
         rgba(${G.fade},.15) 0%, rgba(${G.fade},.45) 45%, rgba(${G.fade},.9) 100%)"></div>`;
  return page(SLIDE_W, SLIDE_H, `${backdrop}
    ${toolbar(source.url, bar)}
    <div class="${enlarged ? '' : 'lift'}" style="position:absolute;right:30px;top:${bar + 10}px;${cut}">${popup(popupName, popupWidth)}</div>
    <!-- The caption stops 24px short of the popup, whatever its width. -->
    <div style="position:absolute;left:${MARGIN}px;bottom:72px;width:${SLIDE_W - 30 - popupWidth - MARGIN - 24}px">
      <div class="display headline" style="font-size:${headingSize}px">${heading}</div>
      <div class="subline">${subline}</div>
    </div>`);
}

// --- close-ups: the popup alone over the page's colors ---------------------
// No toolbar: these slides are about the popup, not the site. The page is blurred
// further and kept brighter, so it reads as color rather than as a dark page.
function closeupSlide({ capture, popupName, heading, subline, maxPopup = 600, extra = '' }) {
  const source = CAPTURES[capture];
  const fullWidth = pngWidth(path.join(root, source.file));
  const scale = (SLIDE_W * 1.1) / (fullWidth - 2 * source.cropSide);
  const popupWidth = Math.min(maxPopup, Math.floor((SLIDE_H - 80) * POPUP_W / popupHeights.get(popupName)));
  const popupTop = Math.round((SLIDE_H - popupHeights.get(popupName) * popupWidth / POPUP_W) / 2);
  return page(SLIDE_W, SLIDE_H, `
    <div style="position:absolute;inset:0;overflow:hidden">
      <img src="/capture/${capture}.png" alt=""
           style="position:absolute;left:${-Math.round(SLIDE_W * 0.05 + source.cropSide * scale)}px;
                  top:${-Math.round(source.cropTop * scale + SLIDE_H * 0.05)}px;width:${Math.round(fullWidth * scale)}px;
                  filter:blur(34px) brightness(.9) saturate(1.35)">
    </div>
    <div style="position:absolute;inset:0;background:linear-gradient(90deg,
         rgba(${G.fade},.78) 0%, rgba(${G.fade},.55) 48%, rgba(${G.fade},.3) 100%)"></div>
    <div class="lift" style="position:absolute;right:${MARGIN}px;top:${popupTop}px">${popup(popupName, popupWidth)}</div>
    <div style="position:absolute;left:${MARGIN}px;top:50%;transform:translateY(-50%);
                width:${SLIDE_W - popupWidth - 2 * MARGIN - 48}px">
      <div class="display headline">${heading}</div>
      <div class="subline">${subline}</div>
      ${extra}
    </div>`);
}

const themeRow = () => `
  <div style="font-size:22px;color:${G.body};margin:40px 0 14px">Choose from four color themes</div>
  <div style="display:flex;gap:18px">${['midnight', 'paper', 'frost']
    .map((name) => `<div style="box-shadow:0 0 0 1px ${G.frame}, 0 14px 30px rgba(0,0,0,.35)">${popup(name, 216)}</div>`).join('')}</div>`;

// --- promo images ----------------------------------------------------------
function promoTile() {
  return page(440, 280, `
    <div style="position:absolute;inset:0;background:${PROMO_BG}"></div>
    <div class="cassette" style="position:absolute;left:30px;top:15px;width:380px;
         filter:drop-shadow(0 14px 22px rgba(0,0,0,.45))">${nameOnlyCassette()}</div>`);
}

// Shared by the Chrome marquee and the website's social preview.
function banner(width, height) {
  const tape = Math.round(Math.min(height * 0.96, width * 0.42));
  const name = Math.round(Math.min(height * 0.11, width * 0.044));
  return page(width, height, `
    <div style="position:absolute;inset:0;background:${PROMO_BG}"></div>
    <div class="cassette" style="position:absolute;left:${Math.round(width * 0.055)}px;top:50%;transform:translateY(-50%);
         width:${tape}px;filter:drop-shadow(0 26px 44px rgba(0,0,0,.5))">${cassetteMarkup()}</div>
    <div style="position:absolute;left:${Math.round(width * 0.055) + tape + 64}px;right:${MARGIN}px;top:50%;transform:translateY(-50%)">
      <div class="display" style="display:flex;align-items:center;gap:18px;font-size:${name}px;line-height:1;white-space:nowrap">
        ${mark(Math.round(name * 0.97))}<span>Slowed &amp; Reverb</span></div>
      <div style="font-size:${Math.round(height * 0.046)}px;line-height:1.4;color:${COLOR.body};margin-top:26px">
        Slow down the song you’re playing on YouTube, YouTube Music or Spotify and add reverb.</div>
      <div style="font-size:${Math.round(height * 0.039)}px;color:${COLOR.light};margin-top:22px">Free for Chrome and Firefox</div>
    </div>`);
}

// Renders at SUPERSAMPLE, then downsamples, so thin lines and small type stay crisp.
async function renderScaled(browser, baseUrl, target, html, width, height) {
  const big = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: SUPERSAMPLE });
  await big.goto(`${baseUrl}/blank`).catch(() => {});
  await big.setContent(html.replaceAll('src="/', `src="${baseUrl}/`).replaceAll('url(/', `url(${baseUrl}/`),
    { waitUntil: 'networkidle' });
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

async function main() {
  assertCaptures();
  fs.mkdirSync(shotDir, { recursive: true });
  fs.mkdirSync(chromeDir, { recursive: true });

  const routes = new Map([['/font/fraunces.woff2', path.join(root, 'site', 'assets', 'fonts', 'fraunces.woff2')]]);
  for (const [name, { file }] of Object.entries(CAPTURES)) routes.set(`/capture/${name}.png`, path.join(root, file));
  for (const name of Object.keys(POPUP_VARIANTS)) routes.set(`/popups/${name}.png`, path.join(popupDir, `${name}.png`));

  const server = await startServer(routes);
  const browser = await chromium.launch({ headless: true });
  const render = (target, html, width, height) => renderScaled(browser, server.baseUrl, target, html, width, height);

  try {
    for (const [name, variant] of Object.entries(POPUP_VARIANTS)) {
      popupHeights.set(name, await renderPopup(browser, server.baseUrl, variant, {
        file: path.join(popupDir, `${name}.png`)
      }));
    }

    const slides = [
      ['01-youtube.png', siteSlide({
        capture: 'youtube', popupName: 'slowed',
        heading: 'Slow down songs on YouTube and YouTube Music', headingSize: 54,
        subline: 'Click the extension\u2019s icon and Slowed + Reverb turns on. Adjust the speed and reverb from there.'
      })],
      ['02-spotify.png', siteSlide({
        capture: 'spotify',
        popupName: 'spotifyAskTop', enlarged: true,
        heading: 'It also works on Spotify in your browser',
        subline: 'The first time, click Allow on Spotify. The page reloads once and it\u2019s ready.'
      })],
      ['03-advanced.png', closeupSlide({
        capture: 'youtubeMusic', popupName: 'advanced', maxPopup: 560,
        heading: 'Every control is free to use',
        subline: 'Echo, stereo width, pan and saturation are on the Advanced tab. There\u2019s no paid version.'
      })],
      ['04-presets.png', closeupSlide({
        capture: 'youtubePlaylist', popupName: 'custom',
        heading: 'Save your favorite settings',
        subline: 'Keep them under My Presets and switch back with one click.',
        extra: themeRow()
      })],
      ['05-privacy.png', closeupSlide({
        capture: 'spotify', popupName: 'nightcore',
        heading: 'Everything happens in your browser',
        subline: 'It doesn\u2019t collect anything about you or what you listen to. No account needed, and the code is public on GitHub.'
      })]
    ];
    for (const [file, html] of slides) await render(path.join(shotDir, file), html, SLIDE_W, SLIDE_H);

    await render(path.join(chromeDir, 'promotional-tile-440x280.png'), promoTile(), 440, 280);
    await render(path.join(chromeDir, 'marquee-1400x560.png'), banner(1400, 560), 1400, 560);
    await render(ogCard, banner(1200, 630), 1200, 630);
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
