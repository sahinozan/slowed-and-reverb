'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { describe, test } = require('node:test');
const { JSDOM } = require('jsdom');

const { root } = require('./helpers/load-script');
const siteRoot = path.join(root, 'site');
const PAGES = ['index.html', 'guide.html', 'faq.html', 'changelog.html', 'privacy.html', '404.html'];
const DEMO_PAGES = ['index.html', 'guide.html'];

function parse(file) {
  return new JSDOM(fs.readFileSync(path.join(siteRoot, file), 'utf8')).window.document;
}

// Every address a page loads or links to, with the attribute it came from.
function references(document) {
  const found = [];
  for (const element of document.querySelectorAll('[href], [src]')) {
    for (const attribute of ['href', 'src']) {
      const value = element.getAttribute(attribute);
      if (value) {
        found.push({ tag: element.tagName.toLowerCase(), rel: element.getAttribute('rel') || '', attribute, value });
      }
    }
  }
  return found;
}

function isExternal(value) {
  return /^(https?:)?\/\//.test(value) || value.startsWith('mailto:');
}

describe('website', () => {
  test('the embedded popup is the shipping popup', () => {
    for (const file of ['popup.js', 'popup.css']) {
      assert.equal(
        fs.readFileSync(path.join(siteRoot, 'popup', file), 'utf8'),
        fs.readFileSync(path.join(root, 'extension', file), 'utf8'),
        `site/popup/${file} differs from extension/${file}; run npm run site:popup`
      );
    }
    const shipped = fs.readFileSync(path.join(root, 'extension', 'popup.html'), 'utf8');
    const copy = fs.readFileSync(path.join(siteRoot, 'popup', 'popup.html'), 'utf8');
    assert.equal(
      copy.replace('<script src="popup-host.js"></script>\n  ', ''),
      shipped,
      'site/popup/popup.html differs from extension/popup.html; run npm run site:popup'
    );
  });

  test('local links, images, scripts and anchors all exist', () => {
    const ids = new Map(PAGES.map((page) => [page, new Set(
      [...parse(page).querySelectorAll('[id]')].map((element) => element.id)
    )]));

    for (const page of PAGES) {
      for (const { value } of references(parse(page))) {
        if (isExternal(value)) continue;
        const [address, anchor] = value.split('#');
        // 404.html is served at any depth, so its links are root-relative.
        const target = address === '' ? page : address.replace(/^\//, '') || 'index.html';
        assert.ok(fs.existsSync(path.join(siteRoot, target)), `${page} links to missing ${value}`);
        if (anchor && ids.has(target)) {
          assert.ok(ids.get(target).has(anchor), `${page} links to missing anchor ${value}`);
        }
      }
    }
  });

  test('pages load nothing from other websites', () => {
    for (const page of PAGES) {
      for (const { tag, rel, attribute, value } of references(parse(page))) {
        // canonical and similar <link>s name an address; these make the browser fetch one.
        const fetched = /\b(stylesheet|icon|preload|modulepreload|manifest)\b/.test(rel);
        const loads = attribute === 'src' || (tag === 'link' && fetched);
        if (!loads) continue;
        assert.ok(!isExternal(value), `${page} loads ${value} from another site`);
      }
    }
    const css = fs.readFileSync(path.join(siteRoot, 'styles.css'), 'utf8');
    assert.doesNotMatch(css, /url\(\s*["']?(https?:)?\/\//, 'styles.css loads from another site');
  });

  test('pages that play the demo song credit it', () => {
    for (const page of DEMO_PAGES) {
      const text = parse(page).body.textContent.replace(/\s+/g, ' ');
      assert.match(text, /“Start Again” by Alex Beroza featuring Snowflake & Subliminal \(CC BY 3\.0\)/, page);
      const links = references(parse(page)).map(({ value }) => value);
      assert.ok(links.includes('https://ccmixter.org/files/AlexBeroza/31670'), `${page} links the source`);
      assert.ok(links.includes('https://creativecommons.org/licenses/by/3.0/'), `${page} links the license`);
    }
    assert.ok(fs.existsSync(path.join(siteRoot, 'assets', 'audio', 'start-again-loop.mp3')));
    assert.ok(fs.existsSync(path.join(siteRoot, 'assets', 'audio', 'CREDITS.txt')));
  });

  test('the repository README is not published', () => {
    const ignored = fs.readFileSync(path.join(siteRoot, '.assetsignore'), 'utf8').split('\n');
    assert.ok(ignored.includes('README.md'));
  });
});
