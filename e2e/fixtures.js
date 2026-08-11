'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium, test: base } = require('@playwright/test');

const root = path.join(__dirname, '..');
const builtExtensionDir = process.env.SLOWED_REVERB_E2E_EXTENSION_DIR
  ? path.resolve(process.env.SLOWED_REVERB_E2E_EXTENSION_DIR)
  : path.join(root, 'dist', 'chromium');

function createToneWav() {
  const sampleRate = 8_000;
  const seconds = 1;
  const sampleCount = sampleRate * seconds;
  const dataLength = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataLength);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataLength, 40);

  for (let sample = 0; sample < sampleCount; sample++) {
    const value = Math.sin((sample / sampleRate) * 2 * Math.PI * 220) * 4_000;
    wav.writeInt16LE(Math.round(value), 44 + sample * 2);
  }

  return wav;
}

function fixtureHtml() {
  const tone = createToneWav().toString('base64');
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Extension audio fixture</title></head>
  <body>
    <h1>Audio fixture</h1>
    <audio id="player" controls preload="auto" src="data:audio/wav;base64,${tone}"></audio>
  </body>
</html>`;
}

async function startFixtureServer() {
  const html = fixtureHtml();
  const server = http.createServer((request, response) => {
    if (new URL(request.url, 'http://127.0.0.1').pathname !== '/') {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8'
    });
    response.end(html);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port');

  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  };
}

function prepareTestExtension(tempRoot) {
  if (!fs.existsSync(path.join(builtExtensionDir, 'manifest.json'))) {
    throw new Error('Chromium build is missing; run npm run build:chromium first');
  }

  const extensionDir = path.join(tempRoot, 'extension');
  fs.cpSync(builtExtensionDir, extensionDir, { recursive: true });

  // Production intentionally accepts only YouTube hosts. Patch the disposable
  // E2E copy so the local audio fixture can exercise the same runtime path.
  const supportPatches = new Map([
    [
      'content.js',
      [
        "location.hostname === 'www.youtube.com' || location.hostname === 'music.youtube.com'",
        "location.hostname === '127.0.0.1' ||\n      location.hostname === 'www.youtube.com' || location.hostname === 'music.youtube.com'"
      ]
    ],
    ...[
      ['background.js', 'YOUTUBE_PERMISSION_ORIGINS'],
      ['popup.js', 'FIREFOX_YOUTUBE_PERMISSIONS']
    ].map(([file, permissionsName]) => [
      file,
      [
        `return hostname in ${permissionsName};`,
        `return hostname === '127.0.0.1' || hostname in ${permissionsName};`
      ]
    ])
  ]);

  for (const [file, [needle, replacement]] of supportPatches) {
    const filePath = path.join(extensionDir, file);
    const source = fs.readFileSync(filePath, 'utf8');
    if (!source.includes(needle)) throw new Error(`E2E support patch did not match ${file}`);
    fs.writeFileSync(filePath, source.replace(needle, replacement));
  }

  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // Production keeps activeTab only. The E2E copy receives localhost access so
  // Playwright can exercise injection without a physical toolbar click.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return extensionDir;
}

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
      const extensionDir = prepareTestExtension(tempRoot);
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
