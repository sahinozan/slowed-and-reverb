'use strict';

// site/site.js keeps the theme the demo panel reports for the next page of
// the visit. It listens only to a frame of its own page from this site, and
// keeps only a theme the site has.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { describe, test } = require('node:test');
const { JSDOM } = require('jsdom');

const { root } = require('./helpers/load-script');

const SITE_JS = fs.readFileSync(path.join(root, 'site', 'site.js'), 'utf8');

function page() {
  const dom = new JSDOM(
    '<!doctype html><html><head><link rel="icon" href="/assets/icon.svg"></head><body><iframe id="popup"></iframe></body></html>',
    { url: 'https://slowedreverbapp.com/', runScripts: 'outside-only' }
  );
  dom.window.eval(SITE_JS);
  return dom;
}

// A message as the browser delivers it, from `source` at `origin`.
function deliver(dom, data, { origin = 'https://slowedreverbapp.com', source = dom.window.document.getElementById('popup').contentWindow } = {}) {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, origin, source }));
  return dom.window.sessionStorage.getItem('sr-demo-theme');
}

describe("the website's theme from the demo panel", () => {
  test('keeps a theme the panel in its own frame reports', () => {
    const dom = page();
    assert.equal(deliver(dom, { source: 'sr-popup', type: 'theme', theme: 'midnight' }), 'midnight');
    dom.window.close();
  });

  test('ignores another origin, a window that is not its frame, and a theme it does not have', () => {
    const dom = page();
    const theme = { source: 'sr-popup', type: 'theme', theme: 'paper' };
    assert.equal(deliver(dom, theme, { origin: 'https://example.com' }), null);
    assert.equal(deliver(dom, theme, { source: dom.window }), null);
    assert.equal(deliver(dom, theme, { source: null }), null);
    assert.equal(deliver(dom, { ...theme, theme: 'url(javascript:alert(1))' }), null);
    assert.equal(deliver(dom, { ...theme, theme: 'constructor' }), null);
    dom.window.close();
  });

  test("knows the popup's themes", () => {
    const popup = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
    const block = popup.slice(popup.indexOf('const THEMES = ['), popup.indexOf('];', popup.indexOf('const THEMES = [')));
    const popupThemes = [...block.matchAll(/^\s+(?:\{\s*)?id: '([a-z]+)'/gm)].map(([, id]) => id);
    const siteThemes = JSON.parse(SITE_JS.match(/const THEMES = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
    assert.deepEqual(siteThemes, popupThemes);
  });
});
