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

  const screenshotPath = testInfo.outputPath(`popup-${process.platform}.png`);
  await popup.screenshot({ path: screenshotPath });
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
