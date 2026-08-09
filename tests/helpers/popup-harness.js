'use strict';

const fs = require('fs');
const { JSDOM } = require('jsdom');

const { createBrowserApi, flushPromises } = require('./browser-api');
const { root } = require('./load-script');

async function createPopupHarness(options = {}) {
  const html = fs.readFileSync(`${root}/popup.html`, 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://extension.invalid/popup.html',
    runScripts: 'outside-only'
  });
  const { window } = dom;

  const harness = createBrowserApi({
    activeTab: options.activeTab ?? { id: 9, url: 'https://example.com/watch' },
    local: options.local,
    session: options.session,
    onTabMessage(_tabId, message) {
      if (message.type === 'GET_STATE') return options.contentState ?? null;
      return { success: true };
    }
  });

  window.chrome = harness.api;
  window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };

  const source = fs.readFileSync(`${root}/popup.js`, 'utf8');
  window.eval(source);
  for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

  return { ...harness, dom, window };
}

module.exports = { createPopupHarness };
