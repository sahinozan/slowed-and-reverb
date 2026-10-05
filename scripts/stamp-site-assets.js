'use strict';

// Adds a version stamp (?v=<content hash>) to every page's links to the site's
// stylesheet and scripts. site/_headers lets browsers keep those files for a
// year, which is only safe because a changed file gets a new address. Run after
// editing any of them (npm run site:stamp); tests/site.test.js fails until the
// stamps match.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const siteRoot = path.join(__dirname, '..', 'site');
const STAMPED = Object.freeze(['styles.css', 'site.js', 'app.js', 'guide.js', 'demo-audio.js', 'popup-embed.js']);

function stampFor(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(siteRoot, file))).digest('hex').slice(0, 10);
}

function stampPage(html) {
  return STAMPED.reduce((page, file) => {
    const pattern = new RegExp(`((?:href|src)="/?)${file.replace('.', '\\.')}(\\?v=[0-9a-f]*)?"`, 'g');
    return page.replace(pattern, `$1${file}?v=${stampFor(file)}"`);
  }, html);
}

function pages() {
  return fs.readdirSync(siteRoot).filter((name) => name.endsWith('.html'));
}

if (require.main === module) {
  for (const page of pages()) {
    const file = path.join(siteRoot, page);
    const before = fs.readFileSync(file, 'utf8');
    const after = stampPage(before);
    if (after !== before) fs.writeFileSync(file, after);
  }
  console.log(STAMPED.map((file) => `${file}?v=${stampFor(file)}`).join('\n'));
}

module.exports = { STAMPED, stampFor, stampPage };
