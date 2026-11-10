'use strict';

// Checks npm run checks:for, which prints the checks the files of a change
// need, from checks.json.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { readMap } = require('../scripts/classify-ci-changes');
const { changedFiles, checksNeeded, report } = require('../scripts/checks-for');

const { root } = require('./helpers/load-script');

const map = readMap();
const names = (files) => checksNeeded(files, map).needed.map(({ name }) => name);

describe('npm run checks:for', () => {
  test('gives each file the checks of the first rule that matches it', () => {
    assert.deepEqual(names(['README.md']), ['repo']);
    assert.deepEqual(names(['extension/popup.css']), ['repo', 'extension', 'ui', 'site', 'firefox-frame-look', 'site-popup-sync']);
    assert.deepEqual(names(['extension/youtube-main.js']), ['repo', 'extension', 'ui', 'audio-hosted', 'audio-mac', 'listen']);
    // Documentation in the audio suite's folder needs none of its runs.
    assert.deepEqual(names(['e2e/audio-capture/README.md']), ['repo']);
    assert.deepEqual(names(['e2e/audio-capture/harness.js']), ['repo', 'audio-hosted', 'audio-mac']);
  });

  test('a change needs the checks of every file it touches, each with the files that need it', () => {
    const { needed, unknown } = checksNeeded(['README.md', 'extension/content.js', 'package.json'], map);
    assert.deepEqual(unknown, []);
    assert.deepEqual(
      needed.map(({ name, files }) => `${name}: ${files.join(' ')}`),
      [
        'repo: README.md extension/content.js package.json',
        'extension: extension/content.js package.json',
        'ui: package.json',
        'site: package.json',
        'audio-hosted: extension/content.js package.json',
        'audio-mac: extension/content.js',
        'dependency-audit: package.json',
        'listen: extension/content.js',
        'permission-steps: extension/content.js'
      ]
    );
  });

  test('a path no rule names gets every check CI decides, and is named as needing a rule', () => {
    const { needed, unknown } = checksNeeded(['new-area/config.toml', 'README.md'], map);
    assert.deepEqual(unknown, ['new-area/config.toml']);
    assert.deepEqual(needed.map(({ name }) => name), ['repo', 'extension', 'ui', 'site']);
    assert.match(report(['new-area/config.toml'], map), /^No rule in checks\.json names new-area\/config\.toml, so CI runs every check it decides for it\. Add a rule\.$/m);
  });

  test('prints each check with who runs it, its commands, what it is, and the files it is for', () => {
    const text = report(['README.md', 'extension/popup.css'], map);
    assert.ok(text.startsWith('These 2 files need:\n\nrepo: CI\'s required check\n  npm run check\n  Lint, the unit tests and Firefox\'s lint of the build.\n\n'), text);
    assert.match(text, /^firefox-frame-look: by hand, when the popup's frame changed in CSS\n {2}Look at the real popup in Firefox, with its rounded panel corners\.\n {2}For extension\/popup\.css\.\n$/m);
    assert.match(text, /^site-popup-sync: by hand\n {2}npm run site:popup\n/m);
    // A check every file here needs doesn't list them.
    assert.doesNotMatch(text, /Firefox's lint of the build\.\n {2}For /);
    // The steps the release checklist spells out are pointed at.
    assert.match(report(['extension/content.js'], map), /^listen: by hand, when a change can affect how the effect sounds .*\n {2}Listen to how the effect sounds, with music, in both browsers\. Its steps are in RELEASE-CHECKLIST\.md, "When it applies"\.$/m);
    assert.match(report(['extension/content.js'], map), /^audio-hosted: its own workflow \(audio-capture-trial\.yml\)$/m);
    assert.equal(report(['README.md'], map), "This file needs:\n\nrepo: CI's required check\n  npm run check\n  Lint, the unit tests and Firefox's lint of the build.\n");
    assert.equal(report([], map), 'No files to look up.\n');
    // Many files are named a few at a time.
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `site/${name}.html`);
    assert.match(report([...many, 'README.md'], map), /^ {2}For site\/a\.html, site\/b\.html, site\/c\.html, site\/d\.html and 2 more\.$/m);
  });

  test('with no paths, looks up what changed since the branch left origin/main, committed or not', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-checks-for-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    };
    const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    };
    git('init', '--quiet', '--initial-branch=main');
    for (const file of ['README.md', 'extension/content.js', 'extension/popup.js', 'site/index.html', 'tests/a.test.js']) {
      write(file, `${file}\n`.repeat(20));
    }
    git('add', '--all');
    git('commit', '--quiet', '-m', 'Base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.deepEqual(changedFiles(dir), []);

    // Committed on the branch: one file changed, one renamed, one removed.
    git('switch', '--quiet', '-c', 'work');
    write('README.md', 'Changed.\n');
    git('mv', 'extension/popup.js', 'extension/popup-new.js');
    git('rm', '--quiet', 'tests/a.test.js');
    git('commit', '--quiet', '--all', '-m', 'Work');
    // Not committed: one staged, one only in the working tree, one new.
    write('site/index.html', '<p>Changed</p>\n');
    git('add', 'site/index.html');
    write('extension/content.js', 'changed();\n');
    write('scripts/new-tool.js', 'new();\n');
    assert.deepEqual(changedFiles(dir), [
      'README.md',
      'extension/content.js',
      'extension/popup-new.js',
      'extension/popup.js',
      'scripts/new-tool.js',
      'site/index.html',
      'tests/a.test.js'
    ]);
    // origin/main having moved on doesn't add its changes. The changes not
    // committed are dropped here; the new file stays.
    const head = git('rev-parse', 'HEAD');
    git('switch', '--quiet', '--detach', 'refs/remotes/origin/main', '--discard-changes');
    write('LICENSE', 'Later on main.\n');
    git('add', 'LICENSE');
    git('commit', '--quiet', '-m', 'Later on main');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('switch', '--quiet', '--detach', head);
    assert.deepEqual(changedFiles(dir), ['README.md', 'extension/popup-new.js', 'extension/popup.js', 'scripts/new-tool.js', 'tests/a.test.js']);
  });

  test('the command prints the report for the paths it is given', () => {
    const script = path.join(root, 'scripts', 'checks-for.js');
    const result = spawnSync(process.execPath, [script, 'extension/popup.css', 'README.md'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, report(['extension/popup.css', 'README.md'], map));
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(scripts['checks:for'], 'node scripts/checks-for.js');
  });
});
