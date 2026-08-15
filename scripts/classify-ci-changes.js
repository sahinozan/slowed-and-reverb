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
  'scripts/render-site-assets.js',
  'scripts/render-store-assets.js',
  'wrangler.jsonc'
]);

const NON_BROWSER_DIRECTORIES = ['.github/', 'site/', 'store-assets/', 'tests/'];

function isDocumentation(file) {
  return file === 'LICENSE' || file.endsWith('.md');
}

function isKnownNonBrowserChange(file) {
  return (
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
