'use strict';

const fs = require('fs');
const path = require('path');

const TARGETS = new Set(['chromium', 'firefox']);
const SOURCE_FILES = [
  'background.js',
  'content.js',
  'spotify-bridge.js',
  'spotify-main.js',
  'popup.js',
  'popup.html',
  'popup.css'
];
const GECKO_ID = 'slowed-reverb@sahinozan';
const GECKO_MIN_VERSION = '142.0';
const FIREFOX_YOUTUBE_ORIGINS = [
  'https://www.youtube.com/*',
  'https://music.youtube.com/*'
];

const target = process.argv[2];
if (!TARGETS.has(target)) {
  throw new Error(`Expected one build target: ${[...TARGETS].join(', ')}`);
}

const root = path.join(__dirname, '..');
const sourceDir = path.join(root, 'extension');
const outDir = path.join(root, 'dist', target);
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
const assetFiles = [
  ...new Set([
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons)
  ])
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });

for (const file of SOURCE_FILES) {
  fs.copyFileSync(path.join(sourceDir, file), path.join(outDir, file));
}

for (const file of assetFiles) {
  fs.copyFileSync(path.join(sourceDir, file), path.join(outDir, file));
}

if (target === 'firefox') {
  // Firefox MV3 uses background.scripts; Chromium requires background.service_worker.
  manifest.background = { scripts: ['background.js'] };
  manifest.optional_host_permissions = [
    ...manifest.optional_host_permissions,
    ...FIREFOX_YOUTUBE_ORIGINS
  ];
  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION,
      data_collection_permissions: { required: ['none'] }
    }
  };
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built ${outDir}`);
