'use strict';

// Shared plumbing for rendering the production popup outside the browser.
//
// Both the store art (scripts/render-store-assets.js) and the site art
// (scripts/render-site-assets.js) load the real popup.html, popup.css, and
// popup.js over a local server with a stubbed extension API, so every image is
// the shipping UI rather than a mockup of it. The stub lives here once: it has
// to match what popup.js asks of chrome.*, and two copies would drift.

const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');

const POPUP_W = 340;

const DEFAULT_SETTINGS = Object.freeze({
  speed: 1, reverb: 0, echo: 0, pan: 0, width: 100,
  keepPitch: false, saturation: 0, eqLow: 0, eqMid: 0, eqHigh: 0
});

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

// `extraRoutes` is a Map of pathname to absolute file, resolved per request so
// callers can register files they have not written yet.
function startServer(extraRoutes = new Map()) {
  const routes = new Map([
    ['/popup.html', path.join(root, 'popup.html')],
    ['/popup.css', path.join(root, 'popup.css')],
    ['/popup.js', path.join(root, 'popup.js')],
    ...extraRoutes
  ]);

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const file = routes.get(pathname);
    if (!file || !fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': contentType(file) });
    fs.createReadStream(file).pipe(response);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Popup preview server did not receive a TCP port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => {
          server.close((error) => (error ? fail(error) : done()));
          server.closeAllConnections();
        })
      });
    });
  });
}

// Serialized into the page before popup.js runs.
function installPopupBrowserMock({ theme, settings, customPresets = [] }) {
  const localData = { uiTheme: theme, customPresets, ...settings };
  const activeTab = { id: 9, url: 'https://www.youtube.com/watch?v=store-preview' };
  const tabState = { enabled: true, settings, blocked: false, live: false };

  const storageGet = (defaults) => {
    if (typeof defaults === 'string') return { [defaults]: localData[defaults] };
    if (Array.isArray(defaults)) {
      return Object.fromEntries(defaults.map((key) => [key, localData[key]]));
    }
    return Object.fromEntries(
      Object.entries(defaults ?? {}).map(([key, fallback]) => [
        key, Object.hasOwn(localData, key) ? localData[key] : fallback
      ])
    );
  };

  window.chrome = {
    action: { setIcon: async () => {} },
    permissions: { contains: async () => true, request: async () => true },
    runtime: {
      id: 'store-preview-extension',
      getManifest: () => ({}),
      sendMessage: async (message) => (
        message.type === 'GET_TAB_STATE' ? tabState : { success: true }
      )
    },
    scripting: { executeScript: async () => [] },
    storage: {
      local: {
        get: async (defaults) => storageGet(defaults),
        set: async (values) => Object.assign(localData, values)
      }
    },
    tabs: {
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      query: async () => [activeTab],
      reload: async () => {},
      sendMessage: async (_tabId, message) => (
        message.type === 'GET_STATE' ? tabState : { success: true }
      )
    }
  };
}

// Writes one popup capture and returns its natural CSS height. The popup is
// content-sized, so a fixed clip would either crop live controls or leave a
// band of dead background under them.
async function renderPopup(browser, baseUrl, variant, { file, scale = 3 }) {
  const context = await browser.newContext({
    deviceScaleFactor: scale,
    // Taller than any panel so nothing scrolls; the clip below trims the slack.
    viewport: { width: POPUP_W, height: 1000 }
  });
  const page = await context.newPage();
  await page.addInitScript(installPopupBrowserMock, variant);
  await page.goto(`${baseUrl}/popup.html`);
  await page.waitForFunction(() => !document.body.classList.contains('booting'));

  if (variant.panel === 'advanced') await page.locator('#effect-tab-advanced').click();
  else if (variant.panel === 'custom') await page.locator('#tab-custom').click();

  await page.waitForTimeout(400);
  const height = await page.evaluate(
    () => Math.ceil(document.body.getBoundingClientRect().height)
  );

  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: POPUP_W, height } });
  await context.close();
  return height;
}

module.exports = {
  DEFAULT_SETTINGS,
  POPUP_W,
  contentType,
  installPopupBrowserMock,
  renderPopup,
  startServer
};
