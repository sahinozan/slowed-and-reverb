'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, test: base } = require('@playwright/test');

const { prepareTestExtension, startFixtureServer } = require('./extension-copy');

const root = path.join(__dirname, '..');
const builtExtensionDir = process.env.SLOWED_REVERB_E2E_EXTENSION_DIR
  ? path.resolve(process.env.SLOWED_REVERB_E2E_EXTENSION_DIR)
  : path.join(root, 'dist', 'chromium');

const test = base.extend({
  fixtureUrl: [
    async ({}, use) => {
      const server = await startFixtureServer();
      await use(server.url);
      await server.close();
    },
    { scope: 'worker' }
  ],
  extension: [
    async ({ fixtureUrl }, use) => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-e2e-'));
      const extensionDir = prepareTestExtension(tempRoot, builtExtensionDir, 'chromium');
      let context;

      try {
        context = await chromium.launchPersistentContext(path.join(tempRoot, 'profile'), {
          channel: 'chromium',
          headless: true,
          viewport: { width: 340, height: 600 },
          args: [
            `--disable-extensions-except=${extensionDir}`,
            `--load-extension=${extensionDir}`
          ]
        });

        let [serviceWorker] = context.serviceWorkers();
        if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
        const extensionId = serviceWorker.url().split('/')[2];

        await use({ context, extensionId, fixtureUrl, serviceWorker });
      } finally {
        await context?.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    { scope: 'worker' }
  ]
});

module.exports = { expect: test.expect, test };
