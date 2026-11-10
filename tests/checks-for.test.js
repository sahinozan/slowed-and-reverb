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
const { changedFiles, checksNeeded, report, repositoryPaths, shown } = require('../scripts/checks-for');

const { gitFixtureEnv } = require('./helpers/git-fixture');
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
    // Every git command of the fixture, the ones changedFiles runs
    // included, gets an environment that can't point it at another
    // repository or bring in this machine's git settings.
    const env = gitFixtureEnv(dir);
    const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
    const changed = () => changedFiles(dir, env);
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
    assert.deepEqual(changed(), []);

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
    assert.deepEqual(changed(), [
      'README.md',
      'extension/content.js',
      'extension/popup-new.js',
      'extension/popup.js',
      'scripts/new-tool.js',
      'site/index.html',
      'tests/a.test.js'
    ]);
    // A committed change undone again in the working tree, or undone and
    // staged, still counts: CI looks at the commits.
    git('stash', '--quiet', '--include-untracked');
    assert.deepEqual(changed(), ['README.md', 'extension/popup-new.js', 'extension/popup.js', 'tests/a.test.js']);
    write('README.md', `${'README.md\n'.repeat(20)}`);
    assert.equal(git('diff', '--name-only', 'refs/remotes/origin/main', '--', 'README.md'), '');
    assert.ok(changed().includes('README.md'), 'a change undone in the working tree was left out');
    git('add', 'README.md');
    assert.ok(changed().includes('README.md'), 'a change undone and staged was left out');
    git('reset', '--quiet', '--hard');
    git('stash', 'pop', '--quiet');
    // origin/main having moved on doesn't add its changes. The changes not
    // committed are dropped here; the new file stays.
    const head = git('rev-parse', 'HEAD');
    git('switch', '--quiet', '--detach', 'refs/remotes/origin/main', '--discard-changes');
    write('LICENSE', 'Later on main.\n');
    git('add', 'LICENSE');
    git('commit', '--quiet', '-m', 'Later on main');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('switch', '--quiet', '--detach', head);
    assert.deepEqual(changed(), ['README.md', 'extension/popup-new.js', 'extension/popup.js', 'scripts/new-tool.js', 'tests/a.test.js']);
  });

  test('reads the paths it is given however they are written', () => {
    assert.deepEqual(repositoryPaths(['extension/content.js', './extension/content.js', path.join(root, 'extension', 'content.js')], root), [
      'extension/content.js',
      'extension/content.js',
      'extension/content.js'
    ]);
    // From another folder, as a shell there would give them.
    assert.deepEqual(repositoryPaths(['content.js', '../README.md'], path.join(root, 'extension')), ['extension/content.js', 'README.md']);
    // A file that is gone, as a removed or renamed file's old path is.
    assert.deepEqual(repositoryPaths(['extension/removed.js'], root), ['extension/removed.js']);
    // A folder stands for the tracked files in it.
    const assets = repositoryPaths(['extension/assets'], root);
    assert.ok(assets.includes('extension/assets/icon128.png') && assets.every((file) => file.startsWith('extension/assets/')));
    for (const outside of ['../elsewhere.js', path.join(os.tmpdir(), 'elsewhere.js')]) {
      assert.throws(() => repositoryPaths([outside], root), /is outside the repository$/, outside);
    }
  });

  test('a file name can\'t pass for part of the report', () => {
    assert.equal(shown('extension/content.js'), 'extension/content.js');
    assert.equal(shown('store-assets/a b, c.png'), '"store-assets/a b, c.png"');
    assert.equal(shown('unknown/\nrepo: PASS\nconfig.toml'), '"unknown/\\nrepo: PASS\\nconfig.toml"');
    assert.equal(shown('x\u001b[31m.js'), '"x\\u001b[31m.js"');
    assert.equal(shown('x\u009b.js'), '"x\\u009b.js"');
    const text = report(['unknown/\nrepo: PASS\nconfig.toml', 'README.md'], map);
    assert.doesNotMatch(text, /^repo: PASS$/m);
    assert.doesNotMatch(text, /\u001b/);
    assert.match(text, /^No rule in checks\.json names "unknown\/\\nrepo: PASS\\nconfig\.toml", so CI runs/m);
    assert.match(report(['site/a b.html', 'README.md'], map), /^ {2}For "site\/a b\.html"\.$/m);
  });

  test('the command prints the report for the paths it is given', () => {
    const script = path.join(root, 'scripts', 'checks-for.js');
    const result = spawnSync(process.execPath, [script, 'extension/popup.css', 'README.md'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, report(['extension/popup.css', 'README.md'], map));
    // The same file written another way gets the same checks, from any folder.
    const other = spawnSync(process.execPath, [script, './popup.css', path.join(root, 'README.md')], { cwd: path.join(root, 'extension'), encoding: 'utf8' });
    assert.equal(other.stdout, result.stdout);
    const outside = spawnSync(process.execPath, [script, path.join(os.tmpdir(), 'elsewhere.js')], { encoding: 'utf8' });
    assert.equal(outside.status, 2);
    assert.equal(outside.stdout, '');
    assert.match(outside.stderr, /is outside the repository\.\n$/);
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(scripts['checks:for'], 'node scripts/checks-for.js');
  });
});
