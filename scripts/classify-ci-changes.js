'use strict';

// Decides whether a change needs the browser smoke tests. CI always runs the
// repository checks; this only says whether the browser tests may be skipped.
//
// Reads the changed paths, NUL-separated, on standard input (git diff
// --no-renames --name-only -z, so a rename lists the old path as well as the
// new one) and prints "browser=true" or "browser=false".
//
// CI runs the copy of this file from the pull request's base commit, not the
// one in the pull request, so a change can't choose its own checks. It first
// asks that copy for its policy version (--policy-version); a base commit
// without this file, or with a copy that doesn't answer POLICY_VERSION, has no
// policy CI can read, so CI runs everything. The copy runs alone from a
// temporary folder, so it can't require other repository files.

const fs = require('node:fs');

const POLICY_VERSION = '2';

const NON_BROWSER_PATHS = new Set([
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  'eslint.config.js',
  'scripts/popup-preview.js',
  'scripts/release.js',
  'scripts/render-icons.js',
  'scripts/serve-site.js',
  'scripts/stamp-site-assets.js',
  'scripts/sync-site-popup.js',
  'scripts/render-store-assets.js',
  'wrangler.jsonc'
]);

const NON_BROWSER_DIRECTORIES = ['.github/', 'site/', 'store-assets/', 'tests/'];

// What decides and enforces which checks run: the workflows (including
// Dependabot's action updates) and this file. Changing them runs everything.
const CHECK_INFRASTRUCTURE_DIRECTORIES = ['.github/workflows/'];
const CHECK_INFRASTRUCTURE_PATHS = new Set(['scripts/classify-ci-changes.js']);

function isDocumentation(file) {
  return file === 'LICENSE' || file.endsWith('.md');
}

function isCheckInfrastructure(file) {
  return (
    CHECK_INFRASTRUCTURE_PATHS.has(file) ||
    CHECK_INFRASTRUCTURE_DIRECTORIES.some((directory) => file.startsWith(directory))
  );
}

function needsBrowser(file) {
  if (isCheckInfrastructure(file)) return true;
  return !(
    isDocumentation(file) ||
    NON_BROWSER_PATHS.has(file) ||
    NON_BROWSER_DIRECTORIES.some((directory) => file.startsWith(directory))
  );
}

// An empty list means the comparison found nothing, which shouldn't happen
// for a real change, so it runs everything too.
function classifyFiles(files) {
  return { browser: files.length === 0 || files.some(needsBrowser) };
}

function parsePaths(input) {
  return input.split('\0').filter(Boolean);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--policy-version') {
    process.stdout.write(`${POLICY_VERSION}\n`);
  } else if (args.length === 0) {
    const { browser } = classifyFiles(parsePaths(fs.readFileSync(0, 'utf8')));
    process.stdout.write(`browser=${browser}\n`);
  } else {
    process.stderr.write(`Unexpected arguments: ${args.join(' ')}\n`);
    process.exitCode = 2;
  }
}

module.exports = { POLICY_VERSION, classifyFiles, parsePaths };
