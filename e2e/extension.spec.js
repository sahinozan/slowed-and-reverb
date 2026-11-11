'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { prepareTestExtension } = require('./extension-copy');
const { builtExtensionDir, expect, launchWithExtension, test } = require('./fixtures');
const { BASIC_CONTROLS, FRAME_CONTROLS, measurePopup } = require('./popup-geometry');

async function fixtureTab(serviceWorker, fixtureUrl) {
  return serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (!tab?.id || tab.windowId === undefined) throw new Error(`Fixture tab not found: ${url}`);
    return { id: tab.id, windowId: tab.windowId };
  }, fixtureUrl);
}

async function openPopupPage(extension, tabId) {
  const popup = await extension.context.newPage();
  await extension.serviceWorker.evaluate(
    (targetTabId) => chrome.tabs.update(targetTabId, { active: true }),
    tabId
  );
  await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  return popup;
}

test('loads the real popup page and applies audio settings to the active tab', async ({
  extension
}, testInfo) => {
  const page = await extension.context.newPage();
  await page.goto(extension.fixtureUrl);
  await expect(page.locator('#player')).toHaveJSProperty('readyState', 4);
  await page.bringToFront();

  const tab = await fixtureTab(extension.serviceWorker, extension.fixtureUrl);
  const popup = await openPopupPage(extension, tab.id);

  await expect(popup.getByRole('heading', { name: 'Slowed & Reverb' })).toBeVisible();
  await expect(popup.getByText('On', { exact: true })).toBeVisible();
  await expect(popup.locator('#speed-slider')).toHaveValue('0.8');
  await expect(popup.locator('#reverb-slider')).toHaveValue('40');
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.8);

  // The page's own size, not the window's, which the fixture fixes at 340 × 600:
  // the installed popup fits without scrolling and shows every control.
  const layout = await measurePopup(popup, [...FRAME_CONTROLS, ...BASIC_CONTROLS]);
  expect(layout.problems, JSON.stringify(layout.size)).toEqual([]);

  await popup.getByRole('button', { name: 'Themes' }).click();
  await popup.getByRole('button', { name: 'Midnight' }).click();
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await popup.keyboard.press('Escape');
  await expect(popup.locator('#theme-panel')).toBeHidden();

  // Take the shot as people see the popup: after the theme has faded in, and
  // cropped to the page, since a real popup window is sized to its content.
  const box = await popup.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
    const { x, y, width, height } = document.body.getBoundingClientRect();
    return { x, y, width, height };
  });
  const screenshotPath = testInfo.outputPath(`popup-${process.platform}.png`);
  await popup.screenshot({ path: screenshotPath, clip: box });
  await testInfo.attach(`popup-${process.platform}.png`, {
    path: screenshotPath,
    contentType: 'image/png'
  });

  // Reset Defaults puts the song back to normal but leaves the effect on.
  await popup.getByRole('button', { name: 'Reset Defaults' }).click();
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 1);
  await expect(popup.getByLabel('Toggle audio effects')).toBeChecked();
  await expect(popup.locator('#current-preset-label')).toHaveText('Current Preset: Default');
  await popup.locator('#speed-slider').fill('0.8');
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.8);

  // The − and + buttons and the field set the speed in steps of 0.01, by the
  // names a screen reader gives them, and the player follows.
  await popup.getByRole('button', { name: 'Faster by 0.01x' }).click();
  await expect(popup.locator('#speed-slider')).toHaveValue('0.81');
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.81);
  await popup.getByRole('spinbutton', { name: 'Exact speed' }).fill('0.83');
  await popup.keyboard.press('Enter');
  await expect(popup.locator('#speed-slider')).toHaveValue('0.83');
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.83);

  await popup.locator('.header-power .switch-slider').click();
  await expect(popup.getByLabel('Toggle audio effects')).not.toBeChecked();
  await expect(popup.getByText('Off', { exact: true })).toBeVisible();
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 1);

  const stored = await extension.serviceWorker.evaluate(() => chrome.storage.local.get());
  // The last settings: Reset Defaults, then the speed moved back to 0.8 and
  // on to 0.83.
  expect(stored.speed).toBe(0.83);
  expect(stored.reverb).toBe(0);
  expect(stored.uiTheme).toBe('midnight');
});

test('drops the loading warning when the player finishes loading', async ({ extension }) => {
  const url = `${extension.fixtureUrl}?loading`;
  const page = await extension.context.newPage();
  await page.goto(url);
  await expect(page.locator('#player')).toHaveJSProperty('readyState', 4);
  // Unload the player so the effect has to wait for it, as on a page that
  // is still loading when the popup opens.
  await page.evaluate(() => {
    const player = document.getElementById('player');
    window.fixtureSource = player.src;
    player.removeAttribute('src');
    player.load();
  });
  await expect(page.locator('#player')).toHaveJSProperty('readyState', 0);
  await page.bringToFront();

  const tab = await fixtureTab(extension.serviceWorker, url);
  const popup = await openPopupPage(extension, tab.id);
  const banner = popup.locator('#blocked-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('once the song loads');

  await page.evaluate(() => {
    document.getElementById('player').src = window.fixtureSource;
  });
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.8);
  await expect(banner).toBeHidden();
  await expect(popup.getByText('On', { exact: true })).toBeVisible();
});

test('opens with the switch on when the effect was on, before the tab answers', async ({
  extension
}) => {
  // Popups left open by earlier tests share the remembered state, so close
  // them, and use a page of its own rather than one an earlier test turned off.
  for (const open of extension.context.pages()) {
    if (open.url().startsWith(`chrome-extension://${extension.extensionId}/`)) await open.close();
  }
  const url = `${extension.fixtureUrl}?switch`;
  const page = await extension.context.newPage();
  await page.goto(url);
  await expect(page.locator('#player')).toHaveJSProperty('readyState', 4);
  await page.bringToFront();
  const tab = await fixtureTab(extension.serviceWorker, url);

  // The popup remembers how it looked once the tab has answered, which is
  // when the preset bar shows.
  const first = await openPopupPage(extension, tab.id);
  await expect(first.locator('#current-preset-label')).toHaveText('Current Preset: Slowed + Reverb');
  await first.close();

  // Read the switch once popup.js has run its first, synchronous part. The
  // tab's answer takes a few round trips to the page, so it comes later.
  const popup = await extension.context.newPage();
  await popup.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      window.switchAtStart = document.getElementById('power-toggle').checked;
    });
  });
  await extension.serviceWorker.evaluate(
    (targetTabId) => chrome.tabs.update(targetTabId, { active: true }),
    tab.id
  );
  await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);

  expect(await popup.evaluate(() => window.switchAtStart)).toBe(true);
  await expect(popup.getByText('On', { exact: true })).toBeVisible();
});

// Opens the popup on a page of its own, with its speed set to 0.80x, makes
// two speed steps and closes the popup with the second still unsent.
//
// The popup sends one change at a time and keeps the next until the answer
// to the one before has come. So the first step (0.81) is sent on to the tab
// as usual, but its answer is kept from the popup for good, which leaves the
// second (0.82) waiting in it with no way out but the popup's closing. Every
// change the popup hands to the browser is counted, to check that 0.82 was
// not among them when the popup closed. `beforeClose` runs in the popup
// first.
async function stepTwiceAndClosePopup(extension, name, beforeClose = () => {}) {
  for (const open of extension.context.pages()) {
    if (open.url().startsWith(`chrome-extension://${extension.extensionId}/`)) await open.close();
  }
  const url = `${extension.fixtureUrl}?${name}`;
  const page = await extension.context.newPage();
  await page.goto(url);
  await expect(page.locator('#player')).toHaveJSProperty('readyState', 4);
  await page.bringToFront();
  const tab = await fixtureTab(extension.serviceWorker, url);

  const popup = await openPopupPage(extension, tab.id);
  // The player gets 0.80x from the change the popup sends when it opens on
  // a new tab, so that one has left the popup before the count begins.
  await expect(popup.getByRole('spinbutton', { name: 'Exact speed' })).toHaveValue('0.80');
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.8);
  await popup.evaluate(() => {
    // The same object popup.js calls.
    const { runtime } = typeof browser !== 'undefined' ? browser : chrome;
    const send = runtime.sendMessage.bind(runtime);
    window.speedsSent = [];
    runtime.sendMessage = (message, ...rest) => {
      const answer = send(message, ...rest);
      if (message?.type !== 'APPLY_TO_TAB') return answer;
      window.speedsSent.push(message.settings.speed);
      // The first one's answer never comes.
      return window.speedsSent.length === 1 ? new Promise(() => {}) : answer;
    };
  });
  const speedsSent = () => popup.evaluate(() => window.speedsSent);

  const faster = popup.getByRole('button', { name: 'Faster by 0.01x' });
  await faster.click();
  await expect.poll(speedsSent).toEqual([0.81]);
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.81);

  await faster.click();
  await expect(popup.locator('#speed-slider')).toHaveValue('0.82');
  await popup.evaluate(beforeClose);
  // Asked last, after a round trip to the popup in which a change that could
  // leave would have left.
  expect(await speedsSent()).toEqual([0.81]);
  await popup.close();

  return { page, tab };
}

test('sends a speed step made just before the popup closes', async ({ extension }) => {
  const { page } = await stepTwiceAndClosePopup(extension, 'close');
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.82);
});

test('control: without the send on closing, that step never reaches the tab', async ({
  extension
}) => {
  // Shows that it is the popup's handler for closing that delivers the step
  // in the test above: with the handler taken away the step was never handed
  // to the browser, by the count, so the tab stays on the step before it.
  const { page, tab } = await stepTwiceAndClosePopup(extension, 'close-control', () => {
    if (typeof window.sendOnClose !== 'function') throw new Error('popup.js has no sendOnClose');
    window.removeEventListener('pagehide', window.sendOnClose);
  });

  // What the extension's script in the tab holds, asked after the popup has
  // closed, and what the player has.
  const state = await extension.serviceWorker.evaluate(
    (tabId) => chrome.tabs.sendMessage(tabId, { type: 'GET_STATE' }),
    tab.id
  );
  expect(state.settings.speed).toBe(0.81);
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.81);
});

// A keyboard shortcut works while the popup is open, and the popup went on
// showing the tab as it was before it (issue #181). No key pressed in a test
// reaches the browser's shortcuts, so the browser's report of one is made
// here, in the background script, with the method Chromium's own bindings
// use. From there on everything is the extension's: its handler changes the
// tab and tells the popup, which asks the tab again.
test('shows in the open popup what a shortcut did', async ({ extension }) => {
  const url = `${extension.fixtureUrl}?shortcut`;
  const page = await extension.context.newPage();
  await page.goto(url);
  await expect(page.locator('#player')).toHaveJSProperty('readyState', 4);
  await page.bringToFront();
  const tab = await fixtureTab(extension.serviceWorker, url);
  const shortcut = (command) => extension.serviceWorker.evaluate((name) => {
    if (typeof chrome.commands.onCommand.dispatch !== 'function') {
      throw new Error("This Chromium's shortcut event can't be reported from a test");
    }
    chrome.commands.onCommand.dispatch(name);
  }, command);

  const popup = await openPopupPage(extension, tab.id);
  const speed = popup.getByRole('spinbutton', { name: 'Exact speed' });
  await expect(speed).toHaveValue('0.80');
  await expect(popup.locator('#power-toggle')).toBeChecked();
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.8);

  await shortcut('toggle-effect');
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 1);
  await expect(popup.locator('#power-toggle')).not.toBeChecked();
  await expect(popup.locator('#power-status')).toHaveText('Off');
  await expect(popup.locator('#current-preset-bar')).toBeHidden();

  await shortcut('toggle-nightcore');
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 1.2);
  await expect(popup.locator('#power-toggle')).toBeChecked();
  await expect(speed).toHaveValue('1.20');
  await expect(popup.locator('#current-preset-label')).toHaveText('Current Preset: Nightcore');

  // The next change in the popup is made on top of the shortcut's.
  await popup.getByRole('button', { name: 'Faster by 0.01x' }).click();
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 1.21);
  await expect(popup.locator('#reverb-slider')).toHaveValue('0');
});

test("answers Spotify's turn-on with the effect running on a playing song", async ({
  extension
}) => {
  const url = `${extension.fixtureUrl}?spotify-toggle`;
  const page = await extension.context.newPage();
  await page.goto(url);
  await expect(page.locator('#player')).toHaveJSProperty('readyState', 4);
  const tab = await fixtureTab(extension.serviceWorker, url);
  const settings = {
    speed: 0.8, reverb: 40, echo: 0, pan: 0, width: 100,
    keepPitch: false, saturation: 0, eqLow: 0, eqMid: 0, eqHigh: 0
  };
  const update = (enabled) =>
    extension.serviceWorker.evaluate(
      ({ tabId, enabled, settings }) =>
        chrome.tabs.sendMessage(tabId, { type: 'UPDATE_AUDIO', enabled, settings }),
      { tabId: tab.id, enabled, settings }
    );

  // On Spotify the engine loads with the page, before the song starts.
  await extension.serviceWorker.evaluate(async (tabId) => {
    const target = { tabId };
    await chrome.scripting.executeScript({ target, files: ['spotify-main.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target, files: ['spotify-bridge.js'] });
  }, tab.id);
  await update(false);
  await playLooped(page);
  await expect(page.locator('#player')).toHaveJSProperty('paused', false);

  const on = await update(true);
  expect(on).toMatchObject({ success: true, processingActive: true, pending: false });
  const off = await update(false);
  expect(off).toMatchObject({ success: true, enabled: false, pending: false });
  const again = await update(true);
  expect(again).toMatchObject({ success: true, processingActive: true, pending: false });
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.8);
});

async function playLooped(page) {
  await page.evaluate(async () => {
    const player = document.getElementById('player');
    player.loop = true;
    player.muted = true;
    await player.play();
  });
}

function patchFile(dir, file, pattern, replacement) {
  const filePath = path.join(dir, file);
  const source = fs.readFileSync(filePath, 'utf8');
  expect(source, `${file} no longer matches the update test's patch`).toMatch(pattern);
  fs.writeFileSync(filePath, source.replace(pattern, replacement));
}

// An update leaves the previous version's engine in an open YouTube tab. When
// the popup opens, the new version's engine stops at its guard and the new
// content.js finds the old engine, which works the way its version did, so
// the popup asks for a reload. A store's rollback is an update too: it puts
// earlier code out again with only the manifest's version raised, and after
// the reload that code has to work. These tests update the extension, so
// each starts a browser of its own.
for (const [update, rollback] of [
  ['an update', false],
  ['a store rollback', true]
]) {
  test(`asks for a reload when ${update} leaves the old YouTube engine in the page`, async ({
    fixtureUrl
  }) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-update-'));
    const [older, newer] = ['older', 'newer'].map((name) => {
      fs.mkdirSync(path.join(tempRoot, name));
      return prepareTestExtension(path.join(tempRoot, name), builtExtensionDir, 'chromium');
    });
    // Each script says which version its code is.
    for (const file of ['content.js', 'spotify-bridge.js', 'spotify-main.js', 'youtube-main.js']) {
      patchFile(older, file, /const VERSION = '[^']*';/, "const VERSION = '0.0.1';");
    }
    patchFile(older, 'manifest.json', /"version": "[^"]*"/, '"version": "0.0.1"');
    if (rollback) patchFile(newer, 'manifest.json', /"version": "[^"]*"/, '"version": "99.0.0"');
    // The browser loads the extension from here; the update replaces its files.
    const installed = path.join(tempRoot, 'installed');
    fs.cpSync(older, installed, { recursive: true });
    const extension = await launchWithExtension(tempRoot, installed);

    try {
      const url = `${fixtureUrl}?youtube-update`;
      const page = await extension.context.newPage();
      await page.goto(url);
      await expect(page.locator('#player')).toHaveJSProperty('readyState', 4);
      const tab = await fixtureTab(extension.serviceWorker, url);
      const before = await openPopupPage(extension, tab.id);
      await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.8);
      await before.close();

      // A developer's reload from chrome://extensions, after the files changed.
      // Chromium turns off a reloaded command-line extension unless developer
      // mode is on.
      const extensionsPage = await extension.context.newPage();
      await extensionsPage.goto('chrome://extensions');
      await extensionsPage.evaluate(() =>
        chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })
      );
      fs.rmSync(installed, { recursive: true });
      fs.cpSync(newer, installed, { recursive: true });
      const updatedWorker = extension.context.waitForEvent('serviceworker');
      await extensionsPage.evaluate(
        (id) => chrome.developerPrivate.reload(id, { failQuietly: true }),
        extension.extensionId
      );
      const updated = { ...extension, serviceWorker: await updatedWorker };
      await extensionsPage.close();
      expect(await updated.serviceWorker.evaluate(() => chrome.runtime.getManifest().version)).not.toBe(
        '0.0.1'
      );
      // The old engine turns itself off once its content.js is gone.
      await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 1);

      const popup = await openPopupPage(updated, tab.id);
      await expect(popup.locator('#reload-panel')).toBeVisible();
      await expect(popup.locator('#reload-text')).toHaveText(
        'Reload the page to finish updating the extension.'
      );
      await expect(popup.locator('#reload-btn')).toHaveText('Reload page');
      await expect(popup.getByLabel('Toggle audio effects')).toBeDisabled();
      await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 1);
      const layout = await measurePopup(popup, [...FRAME_CONTROLS, ...BASIC_CONTROLS, '#reload-btn']);
      expect(layout.problems, JSON.stringify(layout.size)).toEqual([]);

      // The reloaded page has this version's engine.
      await popup.locator('#reload-btn').click();
      await expect(popup.locator('#reload-panel')).toBeHidden();
      await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.8);
      await expect(popup.getByText('On', { exact: true })).toBeVisible();
    } finally {
      await extension.context.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

// This test turns the extension off and on again, which replaces its service
// worker, so it stays last in the file.
test('puts the audio back when the extension is turned off in the browser', async ({
  extension
}) => {
  const settings = {
    speed: 0.8,
    reverb: 40,
    echo: 0,
    pan: 0,
    width: 100,
    keepPitch: false,
    saturation: 0,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0
  };
  const youtubeUrl = `${extension.fixtureUrl}?youtube`;
  const spotifyUrl = `${extension.fixtureUrl}?spotify`;

  const youtube = await extension.context.newPage();
  await youtube.goto(youtubeUrl);
  await expect(youtube.locator('#player')).toHaveJSProperty('readyState', 4);
  await playLooped(youtube);
  const youtubeTab = await fixtureTab(extension.serviceWorker, youtubeUrl);
  await extension.serviceWorker.evaluate(
    async ({ tabId, settings }) => {
      const target = { tabId };
      await chrome.scripting.executeScript({ target, files: ['youtube-main.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target, files: ['settings.js', 'content.js'] });
      await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_AUDIO', enabled: true, settings });
    },
    { tabId: youtubeTab.id, settings }
  );
  await expect(youtube.locator('#player')).toHaveJSProperty('playbackRate', 0.8);

  // Spotify's scripts run on the same audio fixture, the engine in the page's world.
  const spotify = await extension.context.newPage();
  await spotify.goto(spotifyUrl);
  await expect(spotify.locator('#player')).toHaveJSProperty('readyState', 4);
  await playLooped(spotify);
  const spotifyTab = await fixtureTab(extension.serviceWorker, spotifyUrl);
  await extension.serviceWorker.evaluate(
    async ({ tabId, settings }) => {
      const target = { tabId };
      await chrome.scripting.executeScript({ target, files: ['spotify-main.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target, files: ['spotify-bridge.js'] });
      await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_AUDIO', enabled: true, settings });
    },
    { tabId: spotifyTab.id, settings }
  );
  await expect(spotify.locator('#player')).toHaveJSProperty('playbackRate', 0.8);

  const extensionsPage = await extension.context.newPage();
  await extensionsPage.goto('chrome://extensions');
  const setEnabled = (enabled) =>
    extensionsPage.evaluate(
      ({ id, enabled }) => new Promise((resolve) => chrome.management.setEnabled(id, enabled, resolve)),
      { id: extension.extensionId, enabled }
    );

  try {
    await setEnabled(false);
    await expect(youtube.locator('#player')).toHaveJSProperty('playbackRate', 1, { timeout: 1000 });
    await expect(spotify.locator('#player')).toHaveJSProperty('playbackRate', 1, { timeout: 1000 });
  } finally {
    await setEnabled(true);
  }
});
