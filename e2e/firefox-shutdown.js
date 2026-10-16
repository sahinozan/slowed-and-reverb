'use strict';

// Runs the Firefox build in the installed Firefox, through WebDriver BiDi, and
// checks that the audio goes back to normal when the extension is turned off
// or removed. Playwright's Firefox cannot load extensions, so this uses
// puppeteer-core. Set FIREFOX_BIN to use a Firefox other than the usual install.

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
    .sendMessage({ type: 'E2E_DRIVE', site: event.data.site, state: event.data.state, settings: event.data.settings })
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
  // Spotify's scripts registered for the page, as Firefox injects them.
  if (message.site === 'spotify-registered') {
    return browser.tabs.sendMessage(sender.tab.id, message.state
      ? { type: 'GET_STATE' }
      : { type: 'UPDATE_AUDIO', enabled: true, settings: message.settings });
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
    // Lets the test use Firefox's add-on manager, as the about:addons switch does.
    args: ['--remote-allow-system-access'],
    extraPrefsFirefox: { 'media.autoplay.default': 0 }
  });
});

// BiDi can install and remove an extension but not turn it off, so this asks
// Firefox's add-on manager directly, from the browser window's own scope.
async function setExtensionEnabled(enabled) {
  const tree = await browser.connection.send('browsingContext.getTree', { 'moz:scope': 'chrome' });
  const { result } = await browser.connection.send('script.evaluate', {
    expression: `(async () => {
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      const addon = await AddonManager.getAddonByID('${EXTENSION_ID}');
      await addon.${enabled ? 'enable' : 'disable'}();
    })()`,
    target: { context: tree.result.contexts[0].context },
    awaitPromise: true
  });
  assert.equal(result.type, 'success', JSON.stringify(result.exceptionDetails));
}

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

// The audio engines run in the page's world, so the page can watch them build
// their graphs: which players they capture and the gain of every node that
// plays straight to the speakers (the effect's output and the unchanged path).
function recordAudioGraph() {
  const sources = new Map();
  const outputs = new Set();
  const { connect } = AudioNode.prototype;
  AudioNode.prototype.connect = function (target, ...rest) {
    if (target instanceof AudioDestinationNode && this instanceof GainNode) outputs.add(this);
    return connect.call(this, target, ...rest);
  };
  const { createMediaElementSource } = AudioContext.prototype;
  AudioContext.prototype.createMediaElementSource = function (media) {
    sources.set(media, (sources.get(media) ?? 0) + 1);
    return createMediaElementSource.call(this, media);
  };
  // The engines fade gains to new values on the audio clock, which never
  // starts on a machine without a sound device (as on CI), so the test reads
  // the value each gain is heading to rather than where it is now.
  const targets = new WeakMap();
  const { linearRampToValueAtTime } = AudioParam.prototype;
  AudioParam.prototype.linearRampToValueAtTime = function (value, endTime) {
    targets.set(this, value);
    return linearRampToValueAtTime.call(this, value, endTime);
  };
  const valueProperty = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
  Object.defineProperty(AudioParam.prototype, 'value', {
    ...valueProperty,
    set(value) {
      targets.set(this, value);
      valueProperty.set.call(this, value);
    }
  });
  window.audioGraph = () => ({
    captures: sources.get(document.getElementById('player')) ?? 0,
    outputGains: [...outputs].map((node) => targets.get(node.gain) ?? node.gain.value)
  });
}

async function startPlaying(page) {
  await page.waitForFunction(() => document.getElementById('player').readyState === 4);
  await page.evaluate(async () => {
    const player = document.getElementById('player');
    player.loop = true;
    player.muted = true;
    await player.play();
  });
}

async function openPlayingFixture(name) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(recordAudioGraph);
  await page.goto(`${server.url}?${name}`);
  await startPlaying(page);
  return page;
}

// Asks the extension, through the test driver, to turn the effect on in the
// page's tab, or with `state` for the tab's state.
async function drive(page, site, state = false) {
  await waitFor(
    () => page.evaluate(() => document.readyState === 'complete'),
    5_000,
    'page did not finish loading'
  );
  return page.evaluate(
    (channel, site, state, settings) =>
      new Promise((resolve) => {
        window.addEventListener('message', function listener(event) {
          if (event.data?.channel !== channel || event.data.type !== 'RESULT') return;
          window.removeEventListener('message', listener);
          resolve(JSON.parse(event.data.reply));
        });
        window.postMessage({ channel, type: 'DRIVE', site, state, settings }, '*');
      }),
    CHANNEL,
    site,
    state,
    SETTINGS
  );
}

// Turns the effect on in the page's tab through the test driver.
async function turnOn(page, site) {
  const reply = await drive(page, site);
  assert.equal(reply.error, undefined, `${site}: ${reply.error}`);
  assert.notEqual(reply.result?.success, false, `${site}: ${JSON.stringify(reply.result)}`);
  // Spotify's engine waits for playback to start before it changes anything.
  await page.evaluate(async () => {
    const player = document.getElementById('player');
    player.pause();
    await player.play();
  });
}

function playback(page) {
  return page.evaluate(() => ({
    rate: document.getElementById('player').playbackRate,
    ...window.audioGraph()
  }));
}

// The player plays at the expected speed, through exactly one graph, with only
// the effect's output (on) or only the unchanged path (off) audible.
async function expectPlayback(page, site, on, timeout) {
  const expected = { rate: on ? SETTINGS.speed : 1, captures: 1, outputGains: on ? [0, 1] : [1, 0] };
  let actual;
  try {
    await waitFor(
      async () => {
        actual = await playback(page);
        return JSON.stringify(actual) === JSON.stringify(expected);
      },
      timeout,
      ''
    );
  } catch {
    throw new Error(
      `${site} with the effect ${on ? 'on' : 'off'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

async function turnOnEverywhere(pages) {
  for (const [site, page] of Object.entries(pages)) {
    await turnOn(page, site);
    await expectPlayback(page, site, true, 5_000);
  }
}

// Checks every page, so a failure names each site that kept the effect.
async function expectEffectOff(pages) {
  const results = await Promise.allSettled(
    Object.entries(pages).map(([site, page]) => expectPlayback(page, site, false, 2_000))
  );
  const failures = results.filter(({ status }) => status === 'rejected');
  assert.deepEqual(failures.map(({ reason }) => reason.message), []);
}

// Spotify sets its player back to normal speed every few seconds, and to 0
// while it seeks. Firefox clicks at any change of speed, and the engine hides
// a change of its own with a silent gap, which was heard as a skip each time.
test('keeps the effect speed through Spotify resetting the player in Firefox', async () => {
  const page = await openPlayingFixture('spotify');
  assert.equal(await browser.installExtension(extensionDir), EXTENSION_ID);
  await turnOn(page, 'spotify');
  await expectPlayback(page, 'spotify', true, 5_000);

  await page.evaluate(() => {
    const player = document.getElementById('player');
    window.speedLog = { rateChanges: 0, silences: 0 };
    player.addEventListener('ratechange', () => window.speedLog.rateChanges++);
    // The engine holds its output at 0 only to hide a change of the player.
    const { setValueAtTime } = AudioParam.prototype;
    AudioParam.prototype.setValueAtTime = function (value, time) {
      if (value === 0) window.speedLog.silences++;
      return setValueAtTime.call(this, value, time);
    };
  });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = () =>
    page.evaluate(() => ({ rate: document.getElementById('player').playbackRate, ...window.speedLog }));

  for (let reset = 0; reset < 3; reset++) {
    await page.evaluate(() => { document.getElementById('player').playbackRate = 1; });
    await pause(300);
  }
  assert.deepEqual(await read(), { rate: SETTINGS.speed, rateChanges: 0, silences: 0 });

  // A seek holds the player at 0, which goes through, and then asks for normal
  // speed, which brings back the effect's. These two are real changes, so the
  // engine looks at its settings again. Without a sound device (as on CI) the
  // audio clock never starts, so that looks like silence there; only the
  // speeds are checked here.
  await page.evaluate(() => { document.getElementById('player').playbackRate = 0; });
  await pause(300);
  assert.equal((await read()).rate, 0);
  await page.evaluate(() => { document.getElementById('player').playbackRate = 1; });
  await pause(300);
  const afterSeek = await read();
  assert.equal(afterSeek.rate, SETTINGS.speed);
  assert.equal(afterSeek.rateChanges, 2);

  await browser.uninstallExtension(EXTENSION_ID);
  await page.close();
});

test('puts the audio back when the extension is turned off or removed in Firefox', async () => {
  const pages = {
    youtube: await openPlayingFixture('youtube'),
    spotify: await openPlayingFixture('spotify')
  };

  assert.equal(await browser.installExtension(extensionDir), EXTENSION_ID);
  await turnOnEverywhere(pages);
  await setExtensionEnabled(false);
  await expectEffectOff(pages);

  // Turning it back on without reloading picks up the same pages again.
  await setExtensionEnabled(true);
  await turnOnEverywhere(pages);
  await browser.uninstallExtension(EXTENSION_ID);
  await expectEffectOff(pages);
  for (const page of Object.values(pages)) await page.close();
});

function patchFile(dir, file, pattern, replacement) {
  const filePath = path.join(dir, file);
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, pattern, `${file} no longer matches the update test's patch`);
  fs.writeFileSync(filePath, source.replace(pattern, replacement));
}

// An earlier version and this build. For Spotify, both register Spotify's
// scripts for the local fixture, as for Spotify.
function prepareUpdate(site) {
  const updateRoot = fs.mkdtempSync(path.join(tempRoot, `${site}-update-`));
  return ['older', 'newer'].map((name) => {
    const versionRoot = path.join(updateRoot, name);
    fs.mkdirSync(versionRoot);
    const dir = prepareTestExtension(versionRoot, builtExtensionDir, 'firefox');
    addTestDriver(dir);
    if (site === 'spotify') {
      patchFile(dir, 'background.js', /'https:\/\/open\.spotify\.com\/\*'/, "'http://127.0.0.1/*'");
    }
    if (name === 'older') {
      for (const engine of ['spotify-main.js', 'youtube-main.js']) {
        patchFile(dir, engine, /const VERSION = '[^']*';/, "const VERSION = '0.0.1';");
      }
      patchFile(dir, 'manifest.json', /"version": "[^"]*"/, '"version": "0.0.1"');
    }
    return dir;
  });
}

// An update leaves the previous version's engine in an open Spotify tab.
// Firefox doesn't put the new version's scripts next to it then, so it turns
// itself off, but it does when the extension is turned off and on again
// without reloading the page. That engine plays the way the old version did
// (1.1.0's skipped), so it has to stay off until the page is reloaded.
test('asks for a Spotify reload when an update leaves the old engine in the page', async () => {
  const [older, newer] = prepareUpdate('spotify');
  assert.equal(await browser.installExtension(older), EXTENSION_ID);
  const page = await openPlayingFixture('update');
  await turnOn(page, 'spotify-registered');
  await expectPlayback(page, 'spotify', true, 5_000);

  assert.equal(await browser.installExtension(newer), EXTENSION_ID);
  await expectPlayback(page, 'spotify', false, 2_000);
  await setExtensionEnabled(false);
  await setExtensionEnabled(true);

  let state;
  await waitFor(
    async () => {
      state = (await drive(page, 'spotify-registered', true)).result;
      return state !== undefined;
    },
    5_000,
    'the new bridge never reached the page'
  );
  assert.deepEqual(state, { enabled: false, blocked: true, blockReason: 'outdated' });
  assert.deepEqual((await drive(page, 'spotify-registered')).result, {
    success: false,
    blocked: true,
    blockReason: 'outdated'
  });
  await expectPlayback(page, 'spotify', false, 2_000);

  // A reload brings in this version's engine.
  await page.reload();
  await startPlaying(page);
  await turnOn(page, 'spotify-registered');
  await expectPlayback(page, 'spotify', true, 5_000);

  await browser.uninstallExtension(EXTENSION_ID);
  await page.close();
});

// On YouTube this needs no turning off and on: when the popup opens, the
// extension puts the new version's scripts into the page, and the new
// engine stops at its guard, leaving the new content.js with the old engine.
test('asks for a YouTube reload when an update leaves the old engine in the page', async () => {
  const [older, newer] = prepareUpdate('youtube');
  assert.equal(await browser.installExtension(older), EXTENSION_ID);
  const page = await openPlayingFixture('youtube-update');
  await turnOn(page, 'youtube');
  await expectPlayback(page, 'youtube', true, 5_000);

  assert.equal(await browser.installExtension(newer), EXTENSION_ID);
  await expectPlayback(page, 'youtube', false, 2_000);

  // The same injection as when the popup opens, then turning the effect on.
  let reply;
  await waitFor(
    async () => {
      reply = (await drive(page, 'youtube')).result;
      return reply !== undefined;
    },
    5_000,
    'the new version never reached the page'
  );
  assert.deepEqual(reply, { success: false, blocked: true, blockReason: 'outdated' });
  await expectPlayback(page, 'youtube', false, 2_000);

  // A reload brings in this version's engine.
  await page.reload();
  await startPlaying(page);
  await turnOn(page, 'youtube');
  await expectPlayback(page, 'youtube', true, 5_000);

  await browser.uninstallExtension(EXTENSION_ID);
  await page.close();
});
