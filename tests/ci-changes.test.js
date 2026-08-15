'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { classifyFiles } = require('../scripts/classify-ci-changes');

describe('CI change classification', () => {
  test('uses the lightweight path for documentation-only changes', () => {
    assert.deepEqual(classifyFiles(['README.md', 'site/README.md', 'LICENSE']), {
      full: false,
      browser: false
    });
  });

  test('runs repository checks without browser smoke tests for tests and tooling', () => {
    assert.deepEqual(
      classifyFiles([
        'tests/package.test.js',
        '.github/workflows/ci.yml',
        'scripts/render-store-assets.js'
      ]),
      { full: true, browser: false }
    );
  });

  test('runs browser smoke tests for extension runtime and dependency changes', () => {
    for (const file of [
      'background.js',
      'popup.css',
      'manifest.json',
      'package-lock.json',
      'assets/icon128.png',
      'e2e/extension.spec.js'
    ]) {
      assert.deepEqual(classifyFiles([file]), { full: true, browser: true }, file);
    }
  });

  test('defaults unfamiliar paths and empty comparisons to comprehensive testing', () => {
    assert.deepEqual(classifyFiles(['new-area/config.toml']), { full: true, browser: true });
    assert.deepEqual(classifyFiles([]), { full: true, browser: true });
  });

  test('uses the highest required tier for mixed changes', () => {
    assert.deepEqual(classifyFiles(['README.md', 'content.js']), {
      full: true,
      browser: true
    });
  });
});
