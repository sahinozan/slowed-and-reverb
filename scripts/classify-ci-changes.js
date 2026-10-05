'use strict';

const fs = require('node:fs');

const NON_BROWSER_PATHS = new Set([
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  'eslint.config.js',
  'scripts/classify-ci-changes.js',
  'scripts/popup-preview.js',
  'scripts/render-icons.js',
  'scripts/serve-site.js',
  'scripts/stamp-site-assets.js',
  'scripts/sync-site-popup.js',
  'scripts/render-store-assets.js',
  'wrangler.jsonc'
]);

const NON_BROWSER_DIRECTORIES = ['.github/', 'site/', 'store-assets/', 'tests/'];

// Markdown files the tests read (tests/package.test.js and tests/site.test.js),
// so editing them needs the full checks even though they are documentation.
const TESTED_DOCUMENTS = new Set(['README.md', 'site/README.md', 'store-assets/README.md']);

function isDocumentation(file) {
  return !TESTED_DOCUMENTS.has(file) && (file === 'LICENSE' || file.endsWith('.md'));
}

function isKnownNonBrowserChange(file) {
  return (
    TESTED_DOCUMENTS.has(file) ||
    NON_BROWSER_PATHS.has(file) ||
    NON_BROWSER_DIRECTORIES.some((directory) => file.startsWith(directory))
  );
}

function classifyFiles(files) {
  if (files.length === 0) return { full: true, browser: true };

  let docsOnly = true;
  let browser = false;

  for (const file of files) {
    if (isDocumentation(file)) continue;

    docsOnly = false;
    if (!isKnownNonBrowserChange(file)) browser = true;
  }

  return { full: !docsOnly, browser };
}

if (require.main === module) {
  const files = fs
    .readFileSync(0, 'utf8')
    .split('\0')
    .filter(Boolean);
  const classification = classifyFiles(files);

  process.stdout.write(`full=${classification.full}\n`);
  process.stdout.write(`browser=${classification.browser}\n`);
}

module.exports = { classifyFiles };
