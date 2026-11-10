'use strict';

// The classifier's decisions, which come from checks.json
// (tests/checks-map.test.js checks the map itself), and its command line.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { POLICY_VERSION, classifyFiles, parsePaths } = require('../scripts/classify-ci-changes');

const { root } = require('./helpers/load-script');

describe('CI change classification', () => {
  test('skips the browser tests for documentation, including PRIVACY.md and the store text', () => {
    for (const files of [['PRIVACY.md'], ['SUPPORT.md', 'store-assets/LISTING.md', 'LICENSE'], ['README.md']]) {
      assert.deepEqual(classifyFiles(files), { browser: false }, files.join());
    }
  });

  test('skips the browser tests for tests and tooling', () => {
    assert.deepEqual(
      classifyFiles([
        'tests/package.test.js',
        '.github/dependabot.yml',
        'scripts/render-store-assets.js',
        'scripts/release.js',
        'site/README.md'
      ]),
      { browser: false }
    );
  });

  test('skips the browser tests for what none of them loads: the audio suite, the audit and the checking tools', () => {
    for (const file of [
      'e2e/audio-capture/harness.js',
      'e2e/audio-capture/recorder-worklet.js',
      'scripts/ci-install-firefox.sh',
      'scripts/firefox-release.js',
      'audit-exceptions.json',
      'scripts/dependency-audit.js',
      '.claude/launch.json',
      'scripts/check-whitespace.js',
      'scripts/node-test-results.js',
      'scripts/render-checks-tables.js'
    ]) {
      assert.deepEqual(classifyFiles([file]), { browser: false }, file);
    }
    // What the browser job itself sets up with still runs them, and so do
    // npm's settings and how git writes files out, which its install and
    // its checkout read.
    for (const file of ['scripts/ci-package-downloads.sh', '.npmrc', '.gitattributes']) {
      assert.deepEqual(classifyFiles([file]), { browser: true }, file);
    }
  });

  test('runs the browser tests for the website and what serves the popup and the site to them', () => {
    for (const file of [
      'site/index.html',
      'site/changelog.html',
      'site/styles.css',
      'site/demo-audio.js',
      'site/popup/popup.css',
      'site/popup/popup-host.js',
      'site/assets/audio/start-again-loop.mp3',
      'scripts/popup-preview.js',
      'scripts/serve-site.js',
      'playwright.ui.config.js',
      'e2e/popup-geometry.js',
      'e2e/ui/site.spec.js'
    ]) {
      assert.deepEqual(classifyFiles([file]), { browser: true }, file);
    }
  });

  test('runs the browser tests when what decides or enforces the checks changes', () => {
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/other.yml', 'scripts/classify-ci-changes.js', 'checks.json']) {
      assert.deepEqual(classifyFiles([file]), { browser: true }, file);
    }
  });

  test('runs the browser tests for extension runtime, dependency and Node.js version changes', () => {
    for (const file of [
      '.nvmrc',
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

    assert.equal(POLICY_VERSION, '3');
    assert.equal(run(['--policy-version']).stdout, '3\n');
    assert.equal(run([], 'docs/notes.md\0').stdout, 'browser=false\n');
    assert.equal(run([], 'extension/content.js\0').stdout, 'browser=true\n');
    assert.equal(run([], '').stdout, 'browser=true\n');

    const unexpected = run(['--browser=false']);
    assert.equal(unexpected.status, 2);
    assert.equal(unexpected.stdout, '');
  });

  // CI runs a copy of the classifier from a temporary folder, with the
  // base commit's map in the folder above it.
  test('a copy reads the map above its own folder, and decides nothing without one', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-classifier-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const copy = path.join(dir, 'scripts', 'classify-ci-changes.js');
    fs.mkdirSync(path.dirname(copy));
    fs.copyFileSync(path.join(root, 'scripts', 'classify-ci-changes.js'), copy);
    const run = (args, input = '') => spawnSync(process.execPath, [copy, ...args], { input, encoding: 'utf8' });

    // Its version needs no map; a decision does.
    assert.equal(run(['--policy-version']).stdout, '3\n');
    const without = run([], 'README.md\0');
    assert.notEqual(without.status, 0);
    assert.equal(without.stdout, '');

    // A map of its own, not the repository's: here the website needs no
    // browser tests and documentation does.
    const map = {
      checks: {
        repo: { by: 'ci', job: 'repository-checks', run: ['npm run check'], about: 'Every change.' },
        extension: { by: 'ci', job: 'browser-smoke', run: ['npm run test:e2e'], about: 'The extension.' }
      },
      rules: [
        { about: 'The website.', paths: ['site/**'], needs: ['repo'] },
        { about: 'Documentation.', paths: ['**/*.md'], needs: ['repo', 'extension'] }
      ]
    };
    fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(map));
    assert.equal(run([], 'site/index.html\0').stdout, 'browser=false\n');
    assert.equal(run([], 'README.md\0').stdout, 'browser=true\n');
    assert.equal(run([], 'site/index.html\0tests/a.test.js\0').stdout, 'browser=true\n');

    // A map it can't read whole stops it, with nothing printed to decide from.
    fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify({ ...map, rules: [] }));
    const broken = run([], 'site/index.html\0');
    assert.notEqual(broken.status, 0);
    assert.equal(broken.stdout, '');
    assert.match(broken.stderr, /checks\.json: has no rules/);
  });
});
