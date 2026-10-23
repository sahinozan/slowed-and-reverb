'use strict';

// The popup's layout and the website, rendered as pages in Chromium and in
// Firefox's engine, Gecko. Chromium is Playwright's own build, as for
// npm run test:e2e; Firefox is the installed one, as for npm run test:firefox,
// driven over WebDriver BiDi (Playwright's "moz-firefox" channel). Set
// FIREFOX_BIN to use a Firefox other than the usual install. Nothing here
// loads the extension: e2e/extension.spec.js does that, under
// playwright.config.js. See README.md.

const { defineConfig, devices } = require('@playwright/test');

function firefoxPath() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  if (process.platform === 'darwin') return '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (process.platform === 'win32') return 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
  return '/usr/bin/firefox';
}

module.exports = defineConfig({
  testDir: './e2e/ui',
  testMatch: '*.spec.js',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report/ui' }]]
    : [['line']],
  outputDir: 'test-results/ui',
  timeout: 30_000,
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      // Tests of what only the Firefox build shows run in Gecko alone.
      grepInvert: /@firefox-build/,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        launchOptions: {
          // The website's demo plays, silently. No name outside this machine
          // resolves, so nothing can connect out even past the tests' own
          // request blocking (e2e/ui/site.spec.js).
          args: ['--mute-audio', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']
        }
      }
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        channel: 'moz-firefox',
        launchOptions: {
          executablePath: firefoxPath(),
          firefoxUserPrefs: {
            'media.volume_scale': '0.0',
            'network.dns.disablePrefetch': true,
            'network.http.speculative-parallel-limit': 0,
            'network.prefetch-next': false
          }
        }
      }
    }
  ]
});
