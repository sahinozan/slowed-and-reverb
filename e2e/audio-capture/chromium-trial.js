'use strict';

// The audio capture trial in Playwright's Chromium (README.md in this
// folder). Run it with npm run test:audio-trial:chromium; it isn't part of
// npm test or npm run test:e2e.
//
// The full trial runs without Playwright's default --mute-audio. A second,
// shorter run keeps Playwright's defaults (which add --mute-audio to headless
// Chromium) and compares the recorded levels with the first.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('@playwright/test');

const { defineTrial, installAudioTrialObserver, root } = require('./harness');

function writeLaunchFailure(artifacts, launchMs, error) {
  fs.writeFileSync(
    path.join(artifacts, 'launch-failure.json'),
    `${JSON.stringify({ launchMs, message: String(error?.stack ?? error).slice(0, 8_000) }, null, 2)}\n`
  );
}

function chromiumBrowser({ muteAudio }) {
  const profiles = [];
  let context = null;
  let artifacts = null;
  let launchMs = null;

  async function launch(extensionDir) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-audio-chromium-'));
    profiles.push(profile);
    const started = Date.now();
    try {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: true,
        ignoreDefaultArgs: muteAudio ? [] : ['--mute-audio'],
        args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
      });
      if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
    } catch (error) {
      writeLaunchFailure(artifacts, Date.now() - started, error);
      throw error;
    }
    launchMs = Date.now() - started;
  }

  return {
    label: muteAudio ? 'chromium-mute-audio' : 'chromium',
    target: 'chromium',
    async start({ extensionDir, artifacts: folder }) {
      artifacts = folder;
      await launch(extensionDir);
      // The command line the browser actually got, flags included.
      const page = await context.newPage();
      await page.goto('chrome://version');
      const commandLine = (await page.locator('#command_line').textContent()).trim();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      await page.close();
      const playwright = JSON.parse(
        fs.readFileSync(path.join(root, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')
      ).version;
      return {
        playwright,
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
    async useExtension(extensionDir) {
      await context.close();
      await launch(extensionDir);
    },
    async stop() {
      await context?.close();
      for (const profile of profiles) fs.rmSync(profile, { recursive: true, force: true });
    }
  };
}

const unmuted = defineTrial(chromiumBrowser({ muteAudio: false }));
defineTrial(chromiumBrowser({ muteAudio: true }), {
  full: false,
  compareWith: { label: 'chromium', results: unmuted }
});
