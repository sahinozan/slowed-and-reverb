'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { prepareTestExtension } = require('./extension-copy');
const { builtExtensionDir, expect, launchWithExtension, test } = require('./fixtures');

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

  const dimensions = await popup.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth
  }));
  expect(dimensions.innerWidth).toBe(340);
  expect(dimensions.documentWidth).toBe(340);
  expect(dimensions.innerHeight).toBeLessThanOrEqual(600);

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

  await popup.locator('.header-power .switch-slider').click();
  await expect(popup.getByLabel('Toggle audio effects')).not.toBeChecked();
  await expect(popup.getByText('Off', { exact: true })).toBeVisible();
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 1);

  const stored = await extension.serviceWorker.evaluate(() => chrome.storage.local.get());
  // The last settings: Reset Defaults, then the speed moved back to 0.8.
  expect(stored.speed).toBe(0.8);
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
