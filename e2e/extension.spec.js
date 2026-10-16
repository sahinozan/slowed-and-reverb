'use strict';

const { expect, test } = require('./fixtures');

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

  await popup.locator('.header-power .switch-slider').click();
  await expect(popup.getByLabel('Toggle audio effects')).not.toBeChecked();
  await expect(popup.getByText('Off', { exact: true })).toBeVisible();
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 1);

  const stored = await extension.serviceWorker.evaluate(() => chrome.storage.local.get());
  expect(stored.speed).toBe(0.8);
  expect(stored.reverb).toBe(40);
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
  await expect(banner).toContainText('still loading');

  await page.evaluate(() => {
    document.getElementById('player').src = window.fixtureSource;
  });
  await expect(page.locator('#player')).toHaveJSProperty('playbackRate', 0.8);
  await expect(banner).toBeHidden();
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
