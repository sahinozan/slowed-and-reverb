'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
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
