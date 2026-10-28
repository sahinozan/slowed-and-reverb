'use strict';

// The browsers the audio capture trial and the audio regression suite run
// in (README.md in this folder): Playwright's Chromium, and the installed
// Firefox through puppeteer-core and WebDriver BiDi. Each one launches with
// a disposable extension copy, opens observed pages and, for the regression
// suite, turns the extension off and on, updates it or removes it the way
// the browser itself does.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { installAudioTrialObserver } = require('./capture-observer');

const root = path.join(__dirname, '..', '..');

function packageVersion(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
}

function writeLaunchFailure(artifacts, launchMs, error) {
  fs.writeFileSync(
    path.join(artifacts, 'launch-failure.json'),
    `${JSON.stringify({ launchMs, message: String(error?.stack ?? error).slice(0, 8_000) }, null, 2)}\n`
  );
}

// Playwright's Chromium, headless. `muteAudio` keeps Playwright's default
// --mute-audio, which the trial compares against.
//
// The extension loads from a folder of the browser's own, so an update can
// replace its files and reload it as a developer does from
// chrome://extensions. Chromium doesn't put an extension's content scripts
// back into open tabs when it is turned on again or updated, so
// reinjectDriver adds the test driver to a page itself; nothing else is
// injected for the extension.
function chromiumBrowser({ muteAudio = false, label } = {}) {
  const { chromium } = require('@playwright/test');
  const folders = [];
  let context = null;
  let artifacts = null;
  let launchMs = null;
  let installed = null;
  let extensionId = null;
  let extensionsPage = null;

  async function launch(extensionDir) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-audio-chromium-'));
    folders.push(folder);
    installed = path.join(folder, 'installed');
    fs.cpSync(extensionDir, installed, { recursive: true });
    const started = Date.now();
    try {
      context = await chromium.launchPersistentContext(path.join(folder, 'profile'), {
        channel: 'chromium',
        headless: true,
        ignoreDefaultArgs: muteAudio ? [] : ['--mute-audio'],
        args: [`--disable-extensions-except=${installed}`, `--load-extension=${installed}`]
      });
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      extensionId = worker.url().split('/')[2];
    } catch (error) {
      if (artifacts) writeLaunchFailure(artifacts, Date.now() - started, error);
      throw error;
    }
    launchMs = Date.now() - started;
    extensionsPage = null;
  }

  function worker() {
    const found = context.serviceWorkers().find((candidate) => candidate.url().startsWith(`chrome-extension://${extensionId}/`));
    if (!found) throw new Error("the extension's service worker isn't running");
    return found;
  }

  // chrome://extensions, where the browser's own switches live.
  async function management() {
    if (!extensionsPage || extensionsPage.isClosed()) {
      extensionsPage = await context.newPage();
      await extensionsPage.goto('chrome://extensions');
    }
    return extensionsPage;
  }

  async function setEnabled(enabled) {
    const page = await management();
    const started = enabled ? context.waitForEvent('serviceworker', { timeout: 10_000 }) : null;
    await page.evaluate(
      ({ id, enabled }) => new Promise((resolve) => chrome.management.setEnabled(id, enabled, resolve)),
      { id: extensionId, enabled }
    );
    if (started) await started;
  }

  return {
    label: label ?? (muteAudio ? 'chromium-mute-audio' : 'chromium'),
    target: 'chromium',
    canRemove: true,
    async start({ extensionDir, artifacts: folder }) {
      artifacts = folder;
      await launch(extensionDir);
      // The command line the browser actually got, flags included.
      const page = await context.newPage();
      await page.goto('chrome://version');
      const commandLine = (await page.locator('#command_line').textContent()).trim();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      await page.close();
      return {
        playwright: packageVersion('@playwright/test'),
        executable: chromium.executablePath(),
        userAgent,
        headless: true,
        muteAudioRequested: muteAudio,
        muteAudioInCommandLine: /(^|\s)--mute-audio(\s|$)/.test(commandLine),
        commandLine,
        launchMs
      };
    },
    async newPage(url, observerOptions) {
      const page = await context.newPage();
      await page.addInitScript(installAudioTrialObserver, observerOptions);
      await page.goto(url);
      await page.bringToFront();
      return page;
    },
    // A fresh browser with another extension copy.
    async useExtension(extensionDir) {
      await context.close();
      await launch(extensionDir);
    },
    disable: () => setEnabled(false),
    enable: () => setEnabled(true),
    // A developer's update: new files in the extension's folder, then a
    // reload from chrome://extensions. Chromium turns off a reloaded
    // command-line extension unless developer mode is on.
    async update(extensionDir) {
      const page = await management();
      await page.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
      fs.rmSync(installed, { recursive: true });
      fs.cpSync(extensionDir, installed, { recursive: true });
      const started = context.waitForEvent('serviceworker', { timeout: 10_000 });
      await page.evaluate((id) => chrome.developerPrivate.reload(id, { failQuietly: true }), extensionId);
      await started;
    },
    // Chromium asks before chrome.management.uninstall or the extensions
    // page removes an extension, and a test can't answer that dialog, so the
    // extension removes itself without one. Chromium uninstalls it the same
    // way. Its service worker ends during the call, so the call's own error
    // is expected; the extensions page then has to show it gone.
    async remove() {
      const id = extensionId;
      await worker()
        .evaluate(() => chrome.management.uninstallSelf({ showConfirmDialog: false }))
        .catch(() => {});
      const page = await management();
      const deadline = Date.now() + 5000;
      while (await page.evaluate((id) => new Promise((resolve) => chrome.management.get(id, () => resolve(!chrome.runtime.lastError))), id)) {
        if (Date.now() > deadline) throw new Error('the extension was still installed 5 s after removing itself');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      extensionId = null;
    },
    async reinjectDriver(page) {
      const url = page.url();
      await worker().evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        if (!tab) throw new Error(`no tab for ${url}`);
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['audio-trial-driver.js'] });
      }, url);
    },
    async stop() {
      await context?.close();
      for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
    }
  };
}

function firefoxPath() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  if (process.platform === 'darwin') return '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (process.platform === 'win32') return 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
  return '/usr/bin/firefox';
}

const FIREFOX_EXTENSION_ID = 'slowed-reverb@sahinozan';

// The installed Firefox, headless, with puppeteer's own preferences only: no
// autoplay or audio preferences are set. It starts through
// e2e/firefox-launch.js, which reports how the start went (in the log and in
// firefox-launch.txt with the evidence) without changing how Firefox is
// started. `addonManager` also lets the test use Firefox's add-on manager,
// as the about:addons switch does (--remote-allow-system-access, as in
// e2e/firefox-shutdown.js).
// Firefox puts an extension's declared content scripts back into open tabs
// when it is turned on again, so reinjectDriver has nothing to do.
function firefoxBrowser({ addonManager = false } = {}) {
  const puppeteer = require('puppeteer-core');
  let browser = null;
  let extensionId = null;

  async function setEnabled(enabled) {
    const tree = await browser.connection.send('browsingContext.getTree', { 'moz:scope': 'chrome' });
    const { result } = await browser.connection.send('script.evaluate', {
      expression: `(async () => {
        const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        const addon = await AddonManager.getAddonByID('${FIREFOX_EXTENSION_ID}');
        await addon.${enabled ? 'enable' : 'disable'}();
      })()`,
      target: { context: tree.result.contexts[0].context },
      awaitPromise: true
    });
    if (result.type !== 'success') throw new Error(`the add-on manager failed: ${JSON.stringify(result.exceptionDetails)}`);
  }

  return {
    label: 'firefox',
    target: 'firefox',
    canRemove: true,
    async start({ extensionDir, artifacts }) {
      const options = { browser: 'firefox', executablePath: firefoxPath(), headless: true };
      if (addonManager) {
        options.args = ['--remote-allow-system-access'];
        // Firefox 159 removed the switch and takes only this; earlier
        // versions take either.
        options.env = { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' };
      }
      const { launchFirefox } = require('../firefox-launch');
      const log = (report) => {
        console.error(report);
        fs.appendFileSync(path.join(artifacts, 'firefox-launch.txt'), `${report}\n`);
      };
      const started = Date.now();
      try {
        browser = await launchFirefox((launchOptions) => puppeteer.launch(launchOptions), options, { log });
      } catch (error) {
        writeLaunchFailure(artifacts, Date.now() - started, error);
        throw error;
      }
      const launchMs = Date.now() - started;
      extensionId = await browser.installExtension(extensionDir);
      return {
        puppeteer: packageVersion('puppeteer-core'),
        executable: firefoxPath(),
        version: await browser.version(),
        userAgent: await browser.userAgent(),
        headless: true,
        preferences: "puppeteer-core's defaults only",
        addonManager,
        launchMs
      };
    },
    async newPage(url, observerOptions) {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(installAudioTrialObserver, observerOptions);
      await page.goto(url);
      return page;
    },
    async useExtension(extensionDir) {
      if (extensionId) await browser.uninstallExtension(extensionId);
      extensionId = await browser.installExtension(extensionDir);
    },
    disable: () => setEnabled(false),
    enable: () => setEnabled(true),
    // Another temporary install with the same ID, which Firefox treats as
    // an update of the installed one.
    async update(extensionDir) {
      extensionId = await browser.installExtension(extensionDir);
    },
    async remove() {
      await browser.uninstallExtension(extensionId);
      extensionId = null;
    },
    async reinjectDriver() {},
    async stop() {
      await browser?.close();
    }
  };
}

module.exports = { chromiumBrowser, firefoxBrowser };
