'use strict';

const fs = require('fs');
const { JSDOM } = require('jsdom');

const { createBrowserApi, flushPromises } = require('./browser-api');
const { loadScript, root } = require('./load-script');

async function createPopupHarness(options = {}) {
  const html = fs.readFileSync(`${root}/extension/popup.html`, 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://extension.invalid/popup.html',
    runScripts: 'outside-only'
  });
  const { window } = dom;

  const harness = createBrowserApi({
    activeTab: options.activeTab ?? {
      id: 9,
      url: 'https://www.youtube.com/watch?v=example'
    },
    local: options.local,
    session: options.session,
    manifest: options.manifest,
    grantedOrigins: options.grantedOrigins,
    permissionRequestResult: options.permissionRequestResult,
    executeScriptError: options.executeScriptError,
    onTabMessage(tabId, message) {
      if (options.onTabMessage) return options.onTabMessage(tabId, message);
      if (message.type === 'GET_STATE') return options.contentState ?? null;
      return options.applyResult ?? { success: true };
    }
  });

  window.chrome = harness.api;
  window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };

  loadScript('extension/background.js', { chrome: harness.api });
  const source = fs.readFileSync(`${root}/extension/popup.js`, 'utf8');
  window.eval(source);
  for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

  return { ...harness, dom, window };
}

module.exports = { createPopupHarness };
