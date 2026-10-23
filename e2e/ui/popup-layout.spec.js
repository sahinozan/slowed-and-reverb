'use strict';

// The production popup (extension/popup.html, popup.css, popup.js) rendered
// as a page in Chromium and in Firefox's engine, Gecko, with a stub extension
// API (installPopupBrowserMock in scripts/popup-preview.js) that puts it in
// each state that changes its layout. Each test first checks that the popup
// shows the state, then that it fits: 340px wide, no scrolling, and every
// control it needs on screen and not covered (e2e/popup-geometry.js).
//
// This is the popup's page, not the browser's popup window: Firefox's panel
// corners and the browser's own permission dialogs aren't drawn here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { expect, test } = require('@playwright/test');

const { DEFAULT_SETTINGS, installPopupBrowserMock, startServer } = require('../../scripts/popup-preview');
const { BASIC_CONTROLS, FRAME_CONTROLS, measurePopup } = require('../popup-geometry');

const root = path.join(__dirname, '..', '..');
const SLOWED = Object.freeze({ ...DEFAULT_SETTINGS, speed: 0.8, reverb: 40 });
const YOUTUBE = 'https://www.youtube.com/watch?v=layout-test';
const YOUTUBE_MUSIC = 'https://music.youtube.com/watch?v=layout-test';
const SPOTIFY = 'https://open.spotify.com/track/layout-test';

// Saved presets with the longest names the popup allows (24 characters) and
// settings of their own, so applying one names it in the preset bar.
function savedPresets(count) {
  return Array.from({ length: count }, (_, index) => ({
    ...DEFAULT_SETTINGS,
    id: `layout-${index}`,
    name: `Late night drive WWWW ${String(index + 1).padStart(2, '0')}`.slice(0, 24),
    speed: 0.55 + index * 0.05,
    reverb: 50
  }));
}

const row = (n, part) => `.custom-preset-item:nth-child(${n}) .${part}`;
const rowControls = (n) => [row(n, 'custom-preset-btn'), row(n, 'edit-preset-btn'), row(n, 'delete-preset-btn')];
const ADVANCED_CONTROLS = [
  '#tab-presets', '#tab-custom', '[data-preset="slowed"]', '[data-preset="nightcore"]',
  '#effect-tab-basic', '#effect-tab-advanced', '#keep-pitch-toggle + .switch-slider',
  '#echo-slider', '#pan-slider', '#width-slider', '#saturation-slider'
];
const CUSTOM_CONTROLS = ['#tab-presets', '#tab-custom', '#preset-name-input', '#save-preset-btn'];
const RATE_PROMPT_CONTROLS = ['#rate-prompt-link', '#rate-prompt-dismiss'];
// The reminder shows on the fifth day the popup is opened with the effect on.
const FIFTH_DAY = { ratingPrompt: { days: 4, lastDay: '2000-01-01', done: false } };

const clickTab = (id) => async (page) => page.locator(id).click();

async function expectBanner(page, text) {
  await expect(page.locator('#blocked-banner')).toBeVisible();
  await expect(page.locator('#blocked-banner-text')).toHaveText(text);
}

async function expectPanel(page, panel, { text, button, status }) {
  await expect(page.locator(panel)).toBeVisible();
  if (text) await expect(page.locator(`${panel} p`)).toHaveText(text);
  else await expect(page.locator(`${panel} p`)).toBeHidden();
  await expect(page.locator(`${panel} .action-btn`)).toHaveText(button);
  if (status) await expect(page.locator(`${panel} .site-permission-status`)).toHaveText(status);
  await expect(page.locator('#blocked-banner')).toBeHidden();
}

async function expectPresetsList(page, count) {
  await expect(page.locator('#panel-custom')).toBeVisible();
  await expect(page.locator('.custom-preset-item')).toHaveCount(count);
}

// Scrolls the saved presets list with the mouse wheel, as a person would, and
// waits until it stops moving.
async function scrollPresetsList(page) {
  await page.locator('#custom-presets-list').hover();
  await page.mouse.wheel(0, 2000);
  await page.evaluate(async () => {
    const list = document.getElementById('custom-presets-list');
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let last = -1;
    for (let still = 0, frames = 0; still < 3 && frames < 120; frames++) {
      await frame();
      still = list.scrollTop === last ? still + 1 : 0;
      last = list.scrollTop;
    }
  });
}

// Each state: the stub's options, what to do once the popup has opened, what
// shows that the popup is in that state, and the controls it must show.
// States tagged @firefox-build exist only in the Firefox build and run only in
// Gecko (see playwright.ui.config.js).
const STATES = [
  {
    title: 'the effect on, Basic tab',
    mock: { settings: SLOWED },
    shows: async (page) => {
      await expect(page.locator('#power-toggle')).toBeChecked();
      await expect(page.locator('#current-preset-label')).toHaveText('Current Preset: Slowed + Reverb');
    },
    controls: BASIC_CONTROLS
  },
  {
    title: 'the effect off',
    mock: { settings: SLOWED, tab: { enabled: false } },
    shows: async (page) => {
      await expect(page.locator('#power-toggle')).not.toBeChecked();
      await expect(page.locator('#power-status')).toHaveText('Off');
      await expect(page.locator('#current-preset-bar')).toBeHidden();
    },
    controls: BASIC_CONTROLS
  },
  {
    title: 'the theme picker open',
    mock: { settings: SLOWED },
    open: clickTab('#theme-picker-btn'),
    shows: async (page) => {
      await expect(page.locator('#theme-panel')).toBeVisible();
      await expect(page.locator('.theme-option')).toHaveCount(5);
    },
    // The picker covers the tabs below it, as it should.
    controls: ['glow', 'pink', 'midnight', 'paper', 'frost'].map((id) => `.theme-option[data-theme="${id}"]`)
  },
  {
    title: 'the rating reminder on the Basic tab',
    mock: { theme: 'frost', settings: SLOWED, storage: FIFTH_DAY },
    shows: async (page) => {
      await expect(page.locator('#rate-prompt')).toBeVisible();
      await expect(page.locator('#effect-panel-basic')).toBeVisible();
    },
    controls: [...BASIC_CONTROLS, ...RATE_PROMPT_CONTROLS]
  },
  {
    title: 'the Advanced tab with the pitch warning and the rating reminder',
    mock: {
      theme: 'midnight',
      settings: { ...SLOWED, keepPitch: true, echo: 20, pan: -15, width: 130, saturation: 20 },
      storage: FIFTH_DAY
    },
    open: clickTab('#effect-tab-advanced'),
    shows: async (page) => {
      await expect(page.locator('#effect-panel-advanced')).toBeVisible();
      await expect(page.locator('#pitch-warning-banner')).toBeVisible();
      await expect(page.locator('#advanced-badge')).toBeVisible();
      await expect(page.locator('#rate-prompt')).toBeVisible();
    },
    controls: [...ADVANCED_CONTROLS, ...RATE_PROMPT_CONTROLS]
  },
  {
    title: 'a long list of saved presets, scrolled to its end',
    mock: { settings: SLOWED, customPresets: savedPresets(8) },
    open: clickTab('#tab-custom'),
    shows: async (page) => {
      await expectPresetsList(page, 8);
      // The list scrolls on its own, inside a popup that doesn't.
      await expect(page.locator('#custom-presets-list')).toHaveClass(/has-scrollbar/);
      await scrollPresetsList(page);
    },
    controls: [...CUSTOM_CONTROLS, ...rowControls(8)],
    // Applying the last preset works where the list was scrolled to.
    then: async (page) => {
      await page.locator(row(8, 'custom-preset-btn')).click();
      await expect(page.locator('#current-preset-label')).toHaveText(`Current Preset: ${savedPresets(8)[7].name}`);
    }
  },
  {
    title: 'editing a saved preset',
    mock: { theme: 'paper', settings: SLOWED, customPresets: savedPresets(3) },
    open: async (page) => {
      await page.locator('#tab-custom').click();
      await page.locator(row(1, 'edit-preset-btn')).click();
    },
    shows: async (page) => {
      await expect(page.locator('.custom-preset-name-input')).toBeVisible();
      await expect(page.locator('#current-preset-label')).toHaveText(`Editing: ${savedPresets(1)[0].name}`);
    },
    controls: [...CUSTOM_CONTROLS, '.custom-preset-name-input', '.confirm-preset-btn', '.revert-preset-btn']
  },
  {
    title: 'waiting for the song to load',
    mock: { settings: SLOWED, tab: { pending: true, playerDetected: true } },
    shows: (page) => expectBanner(page, 'The effects start once the song loads.'),
    controls: BASIC_CONTROLS
  },
  {
    title: 'waiting for a song on the Advanced tab with the pitch warning',
    mock: { settings: { ...SLOWED, keepPitch: true }, tab: { pending: true, playerDetected: false } },
    open: clickTab('#effect-tab-advanced'),
    shows: async (page) => {
      await expectBanner(page, 'Play a song to start the effects.');
      await expect(page.locator('#pitch-warning-banner')).toBeVisible();
    },
    controls: ADVANCED_CONTROLS
  },
  {
    // The state 46512dc fixed: a notice and the saved presets together.
    title: 'waiting for a song on My Presets',
    mock: { settings: SLOWED, customPresets: savedPresets(4), tab: { pending: true, playerDetected: false } },
    open: clickTab('#tab-custom'),
    shows: async (page) => {
      await expectBanner(page, 'Play a song to start the effects.');
      await expectPresetsList(page, 4);
      await scrollPresetsList(page);
    },
    controls: [...CUSTOM_CONTROLS, ...rowControls(4)]
  },
  {
    title: 'only speed working on Spotify',
    mock: { url: SPOTIFY, settings: SLOWED, tab: { effectsUnavailable: true } },
    shows: (page) => expectBanner(page, 'Only speed works on Spotify here.'),
    controls: BASIC_CONTROLS
  },
  {
    title: 'a live stream',
    mock: { settings: SLOWED, tab: { live: true } },
    shows: async (page) => {
      await expect(page.locator('#speed-value')).toHaveText('(unavailable while live)');
      await expect(page.locator('#speed-slider')).toBeDisabled();
    },
    controls: BASIC_CONTROLS
  },
  {
    title: 'protected audio',
    mock: { theme: 'paper', settings: SLOWED, tab: { blocked: true, blockReason: 'drm' } },
    shows: async (page) => {
      await expectBanner(page, "This site protects its audio, so the effects can't change it.");
      await expect(page.locator('#power-toggle')).toBeDisabled();
    },
    controls: BASIC_CONTROLS
  },
  {
    title: 'a site it doesn’t work on',
    mock: { theme: 'frost', url: 'https://example.com/', settings: SLOWED },
    shows: (page) => expectBanner(page, "This site isn't supported. It works on YouTube, YouTube Music and Spotify."),
    controls: BASIC_CONTROLS
  },
  {
    title: 'a page it can’t reach',
    mock: { theme: 'midnight', settings: SLOWED, injects: false },
    shows: (page) => expectPanel(page, '#reload-panel', {
      text: "The effects can't start on this page. Reloading it usually fixes this.",
      button: 'Reload page'
    }),
    controls: [...BASIC_CONTROLS, '#reload-btn']
  },
  {
    // The other state 46512dc fixed: a status line under a panel's button.
    title: 'a reload that failed',
    mock: { settings: SLOWED, injects: false, reload: 'error' },
    open: clickTab('#reload-btn'),
    shows: (page) => expectPanel(page, '#reload-panel', {
      button: 'Reload page',
      status: "That didn't work. Reload the page yourself and try again."
    }),
    controls: [...BASIC_CONTROLS, '#reload-btn']
  },
  {
    title: 'an update waiting for a reload',
    mock: { settings: SLOWED, tab: { blocked: true, blockReason: 'outdated' } },
    shows: (page) => expectPanel(page, '#reload-panel', {
      text: 'Reload the page to finish updating the extension.',
      button: 'Reload page'
    }),
    controls: [...BASIC_CONTROLS, '#reload-btn']
  },
  {
    title: 'an update waiting for Spotify to reload',
    mock: { url: SPOTIFY, settings: SLOWED, tab: { blocked: true, blockReason: 'outdated' } },
    shows: (page) => expectPanel(page, '#reload-panel', {
      text: 'Reload Spotify to finish updating the extension.',
      button: 'Reload Spotify'
    }),
    controls: [...BASIC_CONTROLS, '#reload-btn']
  },
  {
    title: 'asking for Spotify',
    mock: { theme: 'pink', url: SPOTIFY, settings: SLOWED, siteAccess: false },
    shows: (page) => expectPanel(page, '#spotify-permission-panel', {
      text: 'Your browser asks once before the extension can work on Spotify.',
      button: 'Allow on Spotify'
    }),
    controls: [...BASIC_CONTROLS, '#spotify-permission-btn']
  },
  {
    title: 'asking for Spotify after the request failed',
    mock: { url: SPOTIFY, settings: SLOWED, siteAccess: false, permissionRequest: 'error' },
    open: clickTab('#spotify-permission-btn'),
    shows: (page) => expectPanel(page, '#spotify-permission-panel', {
      button: 'Allow on Spotify',
      status: "That didn't work. You can also allow Spotify in your browser's extension settings."
    }),
    controls: [...BASIC_CONTROLS, '#spotify-permission-btn']
  },
  {
    title: 'Spotify allowed, waiting for a reload',
    mock: { url: SPOTIFY, settings: SLOWED, answers: false },
    shows: (page) => expectPanel(page, '#spotify-permission-panel', {
      text: "Allowed. Reload Spotify once and it's ready.",
      button: 'Reload Spotify'
    }),
    controls: [...BASIC_CONTROLS, '#spotify-permission-btn']
  },
  {
    title: 'asking for YouTube @firefox-build',
    mock: { url: YOUTUBE, settings: SLOWED, siteAccess: false },
    shows: (page) => expectPanel(page, '#youtube-permission-panel', {
      text: 'Firefox asks once so the effects keep working after you reload the page.',
      button: 'Allow on YouTube'
    }),
    controls: [...BASIC_CONTROLS, '#youtube-permission-btn']
  },
  {
    title: 'asking for YouTube Music after the request failed @firefox-build',
    mock: { url: YOUTUBE_MUSIC, settings: SLOWED, siteAccess: false, permissionRequest: 'error' },
    open: clickTab('#youtube-permission-btn'),
    shows: (page) => expectPanel(page, '#youtube-permission-panel', {
      button: 'Allow on YouTube Music',
      status: "That didn't work. You can also allow YouTube Music in your browser's extension settings."
    }),
    controls: [...BASIC_CONTROLS, '#youtube-permission-btn']
  }
];

// The popup's files, from extension/ unless a control replaces them.
let server;

test.beforeAll(async () => {
  server = await startServer();
});

test.afterAll(async () => {
  await server?.close();
});

// Opens the popup page with the stub API. The window is wider and taller than
// any popup, so the page lays out at its natural size.
async function openPopup(browser, browserName, baseUrl, mock) {
  const context = await browser.newContext({ viewport: { width: 800, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(installPopupBrowserMock, {
    theme: 'glow',
    url: YOUTUBE,
    firefox: browserName === 'firefox',
    ...mock
  });
  await page.goto(`${baseUrl}/popup.html`);
  return { context, page, errors };
}

// Puts the popup in the state and checks that it shows it; a failure here is
// the test's setup or the popup's behavior, not its layout.
async function showState(page, state) {
  await test.step('shows the state', async () => {
    await page.waitForFunction(() => !document.body.classList.contains('booting'));
    if (state.open) await state.open(page);
    await state.shows(page);
  });
}

async function layoutOf(page, controls, testInfo, { frame = true } = {}) {
  return test.step('measures the layout', async () => {
    const result = await measurePopup(page, [...(frame ? FRAME_CONTROLS : []), ...controls]);
    await testInfo.attach('layout.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json'
    });
    return result;
  });
}

test.describe('popup layout', () => {
  for (const state of STATES) {
    test(`fits ${state.title}`, async ({ browser, browserName }, testInfo) => {
      const { context, page, errors } = await openPopup(browser, browserName, server.baseUrl, state.mock);
      try {
        await showState(page, state);
        const { problems, size } = await layoutOf(page, state.controls, testInfo);
        expect(problems, `layout ${JSON.stringify(size)}`).toEqual([]);
        if (state.then) await test.step('the controls still work', () => state.then(page));
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('fits with the theme picker open in every theme', async ({ browser, browserName }, testInfo) => {
    const { context, page, errors } = await openPopup(browser, browserName, server.baseUrl, { settings: SLOWED });
    try {
      await page.waitForFunction(() => !document.body.classList.contains('booting'));
      await page.locator('#theme-picker-btn').click();
      await expect(page.locator('#theme-panel')).toBeVisible();
      const options = await page.locator('.theme-option').evaluateAll((buttons) => buttons.map((b) => b.dataset.theme));
      expect(options).toEqual(['glow', 'pink', 'midnight', 'paper', 'frost']);

      for (const theme of options) {
        await page.locator(`.theme-option[data-theme="${theme}"]`).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator(`.theme-option[data-theme="${theme}"]`)).toHaveClass(/active/);
        const { problems, size } = await layoutOf(
          page,
          options.map((id) => `.theme-option[data-theme="${id}"]`),
          testInfo
        );
        expect(problems, `${theme}: ${JSON.stringify(size)}`).toEqual([]);
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('#theme-panel')).toBeHidden();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  // The page must run its engine's branch of popup.css, or Gecko renders the
  // same CSS as Chromium and this suite tests one engine twice.
  test("uses its own engine's part of popup.css", async ({ browser, browserName }) => {
    const { context, page } = await openPopup(browser, browserName, server.baseUrl, {
      settings: SLOWED, customPresets: savedPresets(8)
    });
    try {
      await page.locator('#tab-custom').click();
      await expect(page.locator('#custom-presets-list')).toHaveClass(/has-scrollbar/);
      const styles = await page.evaluate(() => ({
        gecko: CSS.supports('-moz-appearance', 'none'),
        corners: getComputedStyle(document.querySelector('.container')).borderTopLeftRadius,
        listHeight: getComputedStyle(document.getElementById('custom-presets-list')).maxHeight
      }));
      expect(styles).toEqual(
        browserName === 'firefox'
          ? { gecko: true, corners: '20px', listHeight: '78px' }
          : { gecko: false, corners: '0px', listHeight: '92px' }
      );
    } finally {
      await context.close();
    }
  });
});

// The layout check has to fail where the popup did. Each control changes a
// copy of today's popup and expects the check to find the problem. Three put
// back what c3ab8b5 and 46512dc took out, adapted to today's files (the
// original commits' files are checked by the opt-in history test below);
// the other two are made up, since nothing has yet gone wrong that way. A
// control whose patch no longer applies fails as setup, not as layout.
function patched(file, replacements) {
  let source = fs.readFileSync(path.join(root, 'extension', file), 'utf8');
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(source)) {
      throw new Error(`Control setup: extension/${file} no longer matches ${pattern}; update the control`);
    }
    source = source.replace(pattern, replacement);
  }
  return source;
}

// Serves the popup with some of its files replaced.
async function serveWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-popup-control-'));
  const routes = new Map();
  for (const [file, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), source);
    routes.set(`/${file}`, path.join(dir, file));
  }
  const controlServer = await startServer(routes);
  return {
    baseUrl: controlServer.baseUrl,
    close: async () => {
      await controlServer.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const stateNamed = (title) => {
  const state = STATES.find((candidate) => candidate.title === title);
  if (!state) throw new Error(`Control setup: no state "${title}"`);
  return state;
};

// Shows the state with the given files, and returns the kinds of problem found.
// `shows` checks for the control's version of the state.
async function problemsWith(browser, browserName, baseUrl, state, shows, testInfo) {
  const { context, page } = await openPopup(browser, browserName, baseUrl, state.mock);
  try {
    await showState(page, { ...state, shows: shows ?? state.shows });
    const { problems, size } = await layoutOf(page, state.controls, testInfo);
    testInfo.annotations.push({ type: 'layout', description: JSON.stringify({ size, problems }) });
    return problems.map((problem) => problem.kind);
  } finally {
    await context.close();
  }
}

// The panels' titles, which 46512dc removed with their style.
const PANEL_TITLE_STYLE = [
  /(\.site-permission-panel p,)/,
  '.site-permission-title {\n  color: var(--fg);\n  font-size: 12px;\n  font-weight: 700;\n}\n\n$1'
];

const CONTROLS = [
  {
    // c3ab8b5 cut the reload panel's explanation from four lines to two,
    // when it made the content 605px tall against the 592px the popup shows.
    // Its text has since moved from popup.html to popup.js.
    title: "c3ab8b5's four-line reload explanation, with its title",
    files: () => ({
      'popup.html': patched('popup.html', [[
        /(<section id="reload-panel" class="site-permission-panel" hidden>\n)/,
        '$1        <div class="site-permission-title">Reload this page?</div>\n'
      ]]),
      'popup.css': patched('popup.css', [PANEL_TITLE_STYLE]),
      'popup.js': patched('popup.js', [[
        /unsupported: "The effects can't start on this page\. Reloading it usually fixes this\.",/,
        "unsupported: \"The extension can't reach the player on this page. This can happen after the extension is turned off and on again or updated. Reloading the page usually fixes it.\","
      ]])
    }),
    state: 'a page it can’t reach',
    shows: async (page) => {
      await expect(page.locator('#reload-panel .site-permission-title')).toHaveText('Reload this page?');
      await expect(page.locator('#reload-text')).toHaveText(/This can happen after the extension is turned off/);
    },
    finds: 'scrolls'
  },
  {
    // 46512dc capped the saved presets list while a notice shows.
    title: "46512dc's uncapped presets list under a notice",
    files: () => ({
      'popup.css': patched('popup.css', [[
        /\.scroll-area:has\(\.blocked-banner:not\(\[hidden\]\)\) \.custom-presets-list \{\n {2}max-height: 44px;\n\}/,
        ''
      ]])
    }),
    state: 'waiting for a song on My Presets',
    finds: 'scrolls'
  },
  {
    // 46512dc let a panel's status line take the place of its description,
    // and shortened the description and dropped its title, which together
    // had made the panel too tall once the status line showed.
    title: "46512dc's Spotify panel with its title, longer description and status line",
    files: () => ({
      'popup.html': patched('popup.html', [[
        /(<section id="spotify-permission-panel" class="site-permission-panel" hidden>\n)/,
        '$1        <div class="site-permission-title">Use it on Spotify?</div>\n'
      ]]),
      'popup.css': patched('popup.css', [PANEL_TITLE_STYLE, [
        /\.site-permission-panel:has\(\.site-permission-status:not\(:empty\)\) p \{\n {2}display: none;\n\}/,
        ''
      ]]),
      'popup.js': patched('popup.js', [[
        /'Your browser asks once before the extension can work on Spotify\.';/,
        `"To work on Spotify, the extension has to load before Spotify's player does, so your browser asks you once.";`
      ]])
    }),
    state: 'asking for Spotify after the request failed',
    shows: async (page) => {
      await expect(page.locator('#spotify-permission-panel .site-permission-title')).toHaveText('Use it on Spotify?');
      await expect(page.locator('#spotify-permission-text')).toHaveText(/has to load before Spotify's player does/);
      await expect(page.locator('#spotify-permission-status')).toHaveText(/That didn't work/);
    },
    finds: 'scrolls'
  },
  {
    // Nothing has yet made the popup too wide, so this one is made up: the
    // theme picker reaching past the panel's right edge.
    title: 'a theme picker wider than the panel (made up)',
    files: () => ({
      'popup.css': patched('popup.css', [[
        /(\.theme-panel \{\n {2}position: absolute;\n {2}top: 100%;\n {2}left: 0;\n) {2}right: 0;/,
        '$1  right: -60px;'
      ]])
    }),
    state: 'the theme picker open',
    finds: 'overflow-x'
  },
  {
    // Made up too: the saved presets list must scroll on its own; clipped
    // instead, its last presets can't be reached with the mouse wheel.
    title: 'a presets list that clips instead of scrolling (made up)',
    files: () => ({
      'popup.css': patched('popup.css', [[
        /(\.custom-presets-list \{[^}]*?)overflow-y: auto;/,
        '$1overflow-y: hidden;'
      ]])
    }),
    state: 'a long list of saved presets, scrolled to its end',
    finds: 'cut-off'
  }
];

test.describe('popup layout controls', () => {
  for (const control of CONTROLS) {
    test(`finds the problem with ${control.title}`, async ({ browser, browserName }, testInfo) => {
      const state = stateNamed(control.state);
      const controlServer = await serveWith(control.files());
      try {
        const found = await problemsWith(browser, browserName, controlServer.baseUrl, state, control.shows, testInfo);
        expect(found).toContain(control.finds);
      } finally {
        await controlServer.close();
      }
    });
  }
});

// The original files from before each fix, read from Git, for a check with
// the repository's history (CI checks out only the commit under test):
//
//   SLOWED_REVERB_POPUP_HISTORY=1 npm run test:ui -- --grep history
// `ready` is what shows the old popup has reached the state, and `engines`
// where it scrolled: before 46512dc a failed reload fit in Chromium, by 1px,
// but not in Firefox.
const HISTORY = [
  { commit: 'c3ab8b5', states: [['a page it can’t reach', '#reload-panel:not([hidden])']] },
  {
    commit: '46512dc',
    states: [
      ['waiting for a song on My Presets', '#blocked-banner:not([hidden])'],
      ['a reload that failed', '#reload-status:not(:empty)', ['firefox']],
      ['asking for Spotify after the request failed', '#spotify-permission-status:not(:empty)']
    ]
  }
];

if (process.env.SLOWED_REVERB_POPUP_HISTORY === '1') {
  test.describe('popup layout history', () => {
    for (const { commit, states } of HISTORY) {
      for (const [title, ready, engines = ['chromium', 'firefox']] of states) {
        test(`finds the problem ${commit} fixed, with ${commit}~1's popup: ${title}`, async ({ browser, browserName }, testInfo) => {
          test.skip(!engines.includes(browserName), `${commit}~1 fit this state in ${browserName}`);
          const files = Object.fromEntries(['popup.html', 'popup.css', 'popup.js', 'settings.js'].map((file) => [
            file,
            execFileSync('git', ['show', `${commit}~1:extension/${file}`], { cwd: root, encoding: 'utf8' })
          ]));
          const state = stateNamed(title);
          const historyServer = await serveWith(files);
          try {
            // The old popup words some states differently, so only its layout is checked.
            const { context, page } = await openPopup(browser, browserName, historyServer.baseUrl, state.mock);
            try {
              await page.waitForFunction(() => !document.body.classList.contains('booting'));
              if (state.open) await state.open(page);
              await expect(page.locator(ready)).toBeVisible();
              const { problems, size } = await layoutOf(page, [], testInfo, { frame: false });
              testInfo.annotations.push({ type: 'layout', description: JSON.stringify({ size, problems }) });
              expect(problems.map((problem) => problem.kind)).toContain('scrolls');
            } finally {
              await context.close();
            }
          } finally {
            await historyServer.close();
          }
        });
      }
    }
  });
}
