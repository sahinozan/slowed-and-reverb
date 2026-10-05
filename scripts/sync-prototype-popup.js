'use strict';

// Copies the shipping popup into the site prototypes so the page can run the
// real interface. The only change is one extra script tag, loading the host
// that stands in for the extension API. Run after any change to
// extension/popup.html, popup.css, or popup.js.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'extension');
const out = path.join(root, 'site', 'prototypes', 'shared', 'popup');

fs.mkdirSync(out, { recursive: true });
for (const file of ['popup.css', 'popup.js']) {
  fs.copyFileSync(path.join(source, file), path.join(out, file));
}

const tag = '<script src="popup.js"></script>';
const html = fs.readFileSync(path.join(source, 'popup.html'), 'utf8');
if (!html.includes(tag)) throw new Error('popup.html no longer loads popup.js with the expected tag');
fs.writeFileSync(
  path.join(out, 'popup.html'),
  html.replace(tag, `<script src="popup-host.js"></script>\n  ${tag}`)
);
console.log(`popup copied to ${path.relative(root, out)}`);
