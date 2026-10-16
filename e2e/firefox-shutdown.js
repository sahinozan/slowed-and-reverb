'use strict';

// Runs the Firefox build in the installed Firefox, through WebDriver BiDi, and
// checks that the audio goes back to normal when the extension goes away.
// Playwright's Firefox cannot load extensions, so this uses puppeteer-core.
// Set FIREFOX_BIN to use a Firefox other than the usual install.
//
// BiDi cannot turn an extension off, only remove it. Firefox shuts the
// extension's content scripts down the same way for both, so removing it
// stands in for turning it off in about:addons.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, test } = require('node:test');
const puppeteer = require('puppeteer-core');

const { prepareTestExtension, startFixtureServer } = require('./extension-copy');

const root = path.join(__dirname, '..');
const builtExtensionDir = path.join(root, 'dist', 'firefox');
const EXTENSION_ID = 'slowed-reverb@sahinozan';
const CHANNEL = 'SLOWED_REVERB_E2E';
const SETTINGS = {
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

function firefoxPath() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  if (process.platform === 'darwin') return '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (process.platform === 'win32') return 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
  return '/usr/bin/firefox';
}

// A test page cannot reach the extension's own pages over BiDi, so the copy
// gets a content script that passes requests from the fixture page on to the
// background script, which turns the effect on the same way the popup does.
function addTestDriver(extensionDir) {
  fs.writeFileSync(
    path.join(extensionDir, 'e2e-driver.js'),
    `window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.channel !== '${CHANNEL}' || event.data.type !== 'DRIVE') return;
  browser.runtime
    .sendMessage({ type: 'E2E_DRIVE', site: event.data.site, settings: event.data.settings })
    .then(
      (result) => ({ result }),
      (error) => ({ error: String(error) })
    )
    .then((reply) => window.postMessage({ channel: '${CHANNEL}', type: 'RESULT', reply: JSON.stringify(reply) }, '*'));
});
`
  );
  fs.writeFileSync(
    path.join(extensionDir, 'e2e-background.js'),
    `browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'E2E_DRIVE') return;
  const target = { tabId: sender.tab.id };
  if (message.site === 'youtube') {
    return queueTabApply(sender.tab.id, sender.tab.url, message.settings, true);
  }
  return browser.scripting
    .executeScript({ target, files: ['spotify-main.js'], world: 'MAIN' })
    .then(() => browser.scripting.executeScript({ target, files: ['spotify-bridge.js'] }))
    .then(() => browser.tabs.sendMessage(sender.tab.id, { type: 'UPDATE_AUDIO', enabled: true, settings: message.settings }));
});
`
  );

  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.background.scripts.push('e2e-background.js');
  manifest.content_scripts = [
    { matches: ['http://127.0.0.1/*'], js: ['e2e-driver.js'], run_at: 'document_start' }
  ];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

let browser;
let server;
let tempRoot;
let extensionDir;

before(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-firefox-'));
  extensionDir = prepareTestExtension(tempRoot, builtExtensionDir, 'firefox');
  addTestDriver(extensionDir);
  server = await startFixtureServer();
  browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: firefoxPath(),
    headless: true,
    extraPrefsFirefox: { 'media.autoplay.default': 0 }
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function waitFor(check, timeout, message) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function openPlayingFixture(name) {
  const page = await browser.newPage();
  await page.goto(`${server.url}?${name}`);
  await page.waitForFunction(() => document.getElementById('player').readyState === 4);
  await page.evaluate(async () => {
    const player = document.getElementById('player');
    player.loop = true;
    player.muted = true;
    await player.play();
  });
  return page;
}

// Turns the effect on in the page's tab through the test driver.
async function turnOn(page, site) {
  await waitFor(
    () => page.evaluate(() => document.readyState === 'complete'),
    5_000,
    'page did not finish loading'
  );
  const reply = await page.evaluate(
    (channel, site, settings) =>
      new Promise((resolve) => {
        window.addEventListener('message', function listener(event) {
          if (event.data?.channel !== channel || event.data.type !== 'RESULT') return;
          window.removeEventListener('message', listener);
          resolve(JSON.parse(event.data.reply));
        });
        window.postMessage({ channel, type: 'DRIVE', site, settings }, '*');
      }),
    CHANNEL,
    site,
    SETTINGS
  );
  assert.equal(reply.error, undefined, `${site}: ${reply.error}`);
  // Spotify's engine waits for playback to start before it changes anything.
  await page.evaluate(async () => {
    const player = document.getElementById('player');
    player.pause();
    await player.play();
  });
}

function playbackRate(page) {
  return page.evaluate(() => document.getElementById('player').playbackRate);
}

async function expectPlaybackRate(page, site, rate, timeout) {
  await waitFor(
    async () => (await playbackRate(page)) === rate,
    timeout,
    `${site}: playbackRate stayed at ${rate === 1 ? 'the slowed speed' : 'normal speed'}`
  );
}

async function installAndTurnOn(pages) {
  const id = await browser.installExtension(extensionDir);
  assert.equal(id, EXTENSION_ID);
  for (const [site, page] of Object.entries(pages)) {
    await turnOn(page, site);
    await expectPlaybackRate(page, site, SETTINGS.speed, 5_000);
  }
}

// Checks every page, so a failure names each site that kept the effect.
async function expectNormalSpeed(pages) {
  const results = await Promise.allSettled(
    Object.entries(pages).map(([site, page]) => expectPlaybackRate(page, site, 1, 2_000))
  );
  const failures = results.filter(({ status }) => status === 'rejected');
  assert.deepEqual(failures.map(({ reason }) => reason.message), []);
}

test('puts the audio back when the extension is turned off in Firefox', async () => {
  const pages = {
    youtube: await openPlayingFixture('youtube'),
    spotify: await openPlayingFixture('spotify')
  };

  await installAndTurnOn(pages);
  await browser.uninstallExtension(EXTENSION_ID);
  await expectNormalSpeed(pages);

  // Turning it back on without reloading picks up the same pages again.
  await installAndTurnOn(pages);
  await browser.uninstallExtension(EXTENSION_ID);
  await expectNormalSpeed(pages);
});
