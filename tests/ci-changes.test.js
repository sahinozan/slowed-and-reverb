'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { classifyFiles, parsePaths } = require('../scripts/classify-ci-changes');

const { root } = require('./helpers/load-script');

describe('CI change classification', () => {
  test('skips the browser tests for documentation, including PRIVACY.md and the store text', () => {
    for (const files of [['PRIVACY.md'], ['SUPPORT.md', 'store-assets/LISTING.md', 'LICENSE'], ['README.md']]) {
      assert.deepEqual(classifyFiles(files), { browser: false }, files.join());
    }
  });

  test('skips the browser tests for tests, tooling and the website', () => {
    assert.deepEqual(
      classifyFiles([
        'tests/package.test.js',
        '.github/dependabot.yml',
        'scripts/render-store-assets.js',
        'scripts/release.js',
        'site/index.html'
      ]),
      { browser: false }
    );
  });

  test('runs the browser tests when what decides or enforces the checks changes', () => {
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/other.yml', 'scripts/classify-ci-changes.js']) {
      assert.deepEqual(classifyFiles([file]), { browser: true }, file);
    }
  });

  test('runs the browser tests for extension runtime and dependency changes', () => {
    for (const file of [
      'extension/background.js',
      'extension/popup.css',
      'extension/manifest.json',
      'package.json',
      'package-lock.json',
      'extension/assets/icon128.png',
      'e2e/extension.spec.js'
    ]) {
      assert.deepEqual(classifyFiles([file]), { browser: true }, file);
    }
  });

  test('runs the browser tests for unfamiliar paths, empty comparisons and mixed changes', () => {
    assert.deepEqual(classifyFiles(['new-area/config.toml']), { browser: true });
    assert.deepEqual(classifyFiles([]), { browser: true });
    assert.deepEqual(classifyFiles(['README.md', 'extension/content.js']), { browser: true });
  });

  test('splits paths only at NUL bytes', () => {
    assert.deepEqual(parsePaths('site/a\nextension/b.js\0README.md\0'), ['site/a\nextension/b.js', 'README.md']);
    assert.deepEqual(parsePaths(''), []);
    assert.deepEqual(parsePaths('\0\0'), []);
  });

  test('the command line answers its policy version and rejects other arguments', () => {
    const script = path.join(root, 'scripts', 'classify-ci-changes.js');
    const run = (args, input = '') => spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8' });

    assert.equal(run(['--policy-version']).stdout, '2\n');
    assert.equal(run([], 'docs/notes.md\0').stdout, 'browser=false\n');
    assert.equal(run([], 'extension/content.js\0').stdout, 'browser=true\n');
    assert.equal(run([], '').stdout, 'browser=true\n');

    const unexpected = run(['--browser=false']);
    assert.equal(unexpected.status, 2);
    assert.equal(unexpected.stdout, '');
  });
});
