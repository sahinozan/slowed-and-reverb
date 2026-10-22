'use strict';

// The audio capture trial in the installed Firefox, through puppeteer-core
// and WebDriver BiDi (README.md in this folder). Run it with npm run
// test:audio-trial:firefox; it isn't part of npm test or npm run
// test:firefox. Set FIREFOX_BIN to use a Firefox other than the usual install.
//
// Firefox runs with puppeteer's own preferences only: no autoplay or audio
// preferences are set, so the player starts from the Start click alone.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const { defineTrial, installAudioTrialObserver, root } = require('./harness');

function firefoxPath() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  if (process.platform === 'darwin') return '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (process.platform === 'win32') return 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
  return '/usr/bin/firefox';
}

function firefoxBrowser() {
  let browser = null;
  let extensionId = null;

  return {
    label: 'firefox',
    target: 'firefox',
    async start({ extensionDir, artifacts }) {
      const started = Date.now();
      try {
        browser = await puppeteer.launch({ browser: 'firefox', executablePath: firefoxPath(), headless: true });
      } catch (error) {
        fs.writeFileSync(
          path.join(artifacts, 'launch-failure.json'),
          `${JSON.stringify({ launchMs: Date.now() - started, message: String(error?.stack ?? error).slice(0, 8_000) }, null, 2)}\n`
        );
        throw error;
      }
      const launchMs = Date.now() - started;
      extensionId = await browser.installExtension(extensionDir);
      const puppeteerVersion = JSON.parse(
        fs.readFileSync(path.join(root, 'node_modules', 'puppeteer-core', 'package.json'), 'utf8')
      ).version;
      return {
        puppeteer: puppeteerVersion,
        executable: firefoxPath(),
        version: await browser.version(),
        userAgent: await browser.userAgent(),
        headless: true,
        preferences: "puppeteer-core's defaults only",
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
      await browser.uninstallExtension(extensionId);
      extensionId = await browser.installExtension(extensionDir);
    },
    async stop() {
      await browser?.close();
    }
  };
}

defineTrial(firefoxBrowser());
