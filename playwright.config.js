'use strict';

const { defineConfig } = require('@playwright/test');

// The installed Chromium extension (e2e/fixtures.js launches it). Only this
// file: e2e/ui/ has its own config, playwright.ui.config.js, and the audio
// suites run under node --test.
module.exports = defineConfig({
  testDir: './e2e',
  testMatch: 'extension.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['line']],
  outputDir: 'test-results',
  timeout: 30_000,
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
});
