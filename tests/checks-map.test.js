'use strict';

// Checks checks.json, the map of which checks a change needs: that it is
// whole, that every tracked file has a rule and every pattern still decides
// a file, that what decides the checks always runs all of them, that the CI
// jobs it names run its commands, and that it decides the browser tests as
// the classifier's own lists did before it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { BROWSER_JOB, checksFor, classifyFiles, patternRegExp, readMap, ruleFor } = require('../scripts/classify-ci-changes');

const { root } = require('./helpers/load-script');

const source = fs.readFileSync(path.join(root, 'checks.json'), 'utf8');
const map = readMap(source);
const ciWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

const CI_CHECKS = ['repo', 'extension', 'ui', 'site'];

// The map with one change, as readMap would be given it.
function changed(change) {
  const copy = JSON.parse(source);
  change(copy);
  return JSON.stringify(copy);
}

// The classifier's own lists as they were before the map (policy version
// 2), kept to show the map decides the browser tests exactly as they did.
// When a decision is changed on purpose, change it here in the same pull
// request, so the difference is written down.
function browserBeforeTheMap(file) {
  const nonBrowserPaths = [
    '.gitattributes',
    '.gitignore',
    '.npmrc',
    'eslint.config.js',
    'scripts/release.js',
    'scripts/render-icons.js',
    'scripts/stamp-site-assets.js',
    'scripts/sync-site-popup.js',
    'scripts/render-store-assets.js',
    'wrangler.jsonc'
  ];
  const nonBrowserDirectories = ['.github/', 'store-assets/', 'tests/'];
  if (file === 'scripts/classify-ci-changes.js' || file.startsWith('.github/workflows/')) return true;
  if (file === 'LICENSE' || file.endsWith('.md')) return false;
  return !(nonBrowserPaths.includes(file) || nonBrowserDirectories.some((directory) => file.startsWith(directory)));
}

describe('the map of which checks a change needs', () => {
  test('git lists the repository', () => {
    for (const file of ['checks.json', 'package.json', 'extension/content.js', 'site/index.html']) {
      assert.ok(tracked.includes(file), `git ls-files didn't list ${file}`);
    }
  });

  test('every tracked file has a rule', () => {
    const missing = tracked.filter((file) => ruleFor(map, file) === null);
    assert.deepEqual(missing, [], 'add these to a rule in checks.json; until then CI runs every check for them');
  });

  test('every pattern is the first to match some tracked file', () => {
    const deciding = new Set();
    for (const file of tracked) {
      const rule = ruleFor(map, file);
      const index = rule.matchers.findIndex((matcher) => matcher.test(file));
      deciding.add(rule.paths[index]);
    }
    const idle = map.rules.flatMap((rule) => rule.paths).filter((pattern) => !deciding.has(pattern));
    assert.deepEqual(idle, [], 'these patterns decide no file: the file is gone, or an earlier rule or pattern takes it');
  });

  test('every rule needs the repository checks, and names its checks in the map\'s order', () => {
    const order = Object.keys(map.checks);
    for (const rule of map.rules) {
      assert.equal(rule.needs[0], 'repo', rule.about);
      assert.deepEqual(rule.needs, order.filter((name) => rule.needs.includes(name)), rule.about);
    }
  });

  test('has the checks CI decides, each with the job that runs its commands', () => {
    assert.deepEqual(Object.keys(map.checks).filter((name) => map.checks[name].by === 'ci'), CI_CHECKS);
    assert.equal(map.checks.repo.job, 'repository-checks');
    for (const name of ['extension', 'ui', 'site']) assert.equal(map.checks[name].job, BROWSER_JOB, name);
    for (const name of CI_CHECKS) {
      const { job, run } = map.checks[name];
      const text = new RegExp(`^ {2}${job}:\\n[\\s\\S]*?(?=^ {2}\\S|(?![\\s\\S]))`, 'm').exec(ciWorkflow)?.[0];
      assert.ok(text, `ci.yml has no ${job} job`);
      for (const command of run) assert.match(text, new RegExp(`^ {8}run: ${command}$`, 'm'), `${job} doesn't run ${command}`);
    }
    // The commands are the package's own scripts.
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const [name, { run = [] }] of Object.entries(map.checks)) {
      for (const command of run) {
        const script = /npm run ([\w:-]+)$/.exec(command)?.[1];
        assert.ok(script && scripts[script], `${name}: ${command} is not one of package.json's scripts`);
      }
    }
  });

  test('what decides the checks runs every check CI decides', () => {
    for (const file of ['checks.json', 'scripts/classify-ci-changes.js', '.github/workflows/ci.yml', '.github/workflows/other.yml']) {
      for (const name of CI_CHECKS) assert.ok(checksFor(map, file).includes(name), `${file} doesn't need ${name}`);
      assert.deepEqual(classifyFiles([file], map), { browser: true }, file);
    }
    // Also when it is documentation by its name.
    assert.deepEqual(classifyFiles(['.github/workflows/notes.md'], map), { browser: true });
  });

  test('a path no rule matches gets every check CI decides, and no other', () => {
    for (const file of ['new-area/config.toml', 'extension/pitch-main.js', 'scripts/new-tool.js', 'sub/LICENSE']) {
      assert.equal(ruleFor(map, file), null, file);
      assert.deepEqual(checksFor(map, file), CI_CHECKS, file);
      assert.deepEqual(classifyFiles([file], map), { browser: true }, file);
    }
  });

  test('decides the browser tests as the classifier\'s own lists did', () => {
    // Every tracked path, and paths made from them that don't exist: a file
    // beside each, in each of its folders, with and without a
    // documentation name.
    const paths = new Set(tracked);
    for (const file of tracked) {
      paths.add(`${file}.md`);
      const parts = file.split('/');
      for (let depth = 0; depth < parts.length; depth++) {
        const folder = parts.slice(0, depth).join('/');
        for (const name of ['new-file.js', 'new-file', 'notes.md', 'LICENSE', 'checks.json']) {
          paths.add(folder ? `${folder}/${name}` : name);
        }
      }
    }
    assert.ok(paths.size > tracked.length * 2);
    const different = [...paths].filter((file) => classifyFiles([file], map).browser !== browserBeforeTheMap(file));
    // The map itself is new: before it, checks.json was a path like any
    // other the lists didn't know, which ran the browser tests too.
    assert.deepEqual(different, []);
    assert.equal(browserBeforeTheMap('checks.json'), true);
  });

  test('reads patterns as GitHub\'s path filters do, and only the kinds it knows', () => {
    const matches = (pattern, file) => patternRegExp(pattern).test(file);
    assert.ok(matches('package.json', 'package.json'));
    assert.ok(!matches('package.json', 'site/package.json'));
    assert.ok(!matches('package.json', 'package-json'));
    assert.ok(matches('tests/**', 'tests/helpers/png.js'));
    assert.ok(!matches('tests/**', 'tests'));
    assert.ok(!matches('tests/**', 'e2e/tests/a.js'));
    assert.ok(matches('**/*.md', 'README.md'));
    assert.ok(matches('**/*.md', 'e2e/audio-capture/README.md'));
    assert.ok(!matches('**/*.md', 'README.md.txt'));
    assert.ok(matches('site/*.html', 'site/index.html'));
    assert.ok(!matches('site/*.html', 'site/popup/popup.html'));
    assert.ok(matches('site/**/popup.html', 'site/popup/popup.html'));
    assert.ok(matches('site/**/popup.html', 'site/popup.html'));
    // Git allows a newline in a path.
    assert.ok(matches('tests/**', 'tests/odd name\nextension/b.js'));
    for (const pattern of ['', '/tests', 'tests/', 'a//b', '../a', 'a/./b', 'a/***', '!tests/**', 'a?.js', '[ab].js', 'a b.js', '{a,b}', 7]) {
      assert.throws(() => patternRegExp(pattern), /is not a pattern this map reads/, String(pattern));
    }
  });

  test('refuses a map it can\'t read whole', () => {
    const refused = (change, message) => assert.throws(() => readMap(changed(change)), message);
    refused((copy) => delete copy.rules, /has no rules/);
    refused((copy) => (copy.rules = []), /has no rules/);
    refused((copy) => delete copy.checks, /has no checks/);
    refused((copy) => copy.rules[0].needs.push('lisen'), /rule 1 needs "lisen", which is not a check/);
    refused((copy) => copy.rules[0].needs.push('repo'), /rule 1 names a check twice/);
    refused((copy) => (copy.rules[2].needs = []), /rule 3 has no checks/);
    refused((copy) => (copy.rules[2].paths = []), /rule 3 has no paths/);
    refused((copy) => delete copy.rules[1].about, /rule 2 has no description/);
    refused((copy) => copy.rules[3].paths.push('checks.json'), /"checks.json" is in two rules/);
    refused((copy) => copy.rules[3].paths.push('!tests/**'), /is not a pattern this map reads/);
    refused((copy) => (copy.checks.listen.by = 'nobody'), /check "listen" doesn't say who runs it/);
    refused((copy) => delete copy.checks.ui.job, /check "ui" needs a CI job/);
    refused((copy) => (copy.checks.listen.job = 'browser-smoke'), /check "listen" needs a CI job/);
    refused((copy) => (copy.checks.repo.run = 'npm run check'), /check "repo" has commands that aren't text/);
    assert.throws(() => readMap('[]'), /is not an object/);
    assert.throws(() => readMap('{'), SyntaxError);
    // And the map as it is reads.
    assert.equal(readMap(changed(() => {})).rules.length, map.rules.length);
  });
});
