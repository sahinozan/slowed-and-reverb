'use strict';

// Checks checks.json, the map of which checks a change needs: that it is
// whole, that every tracked file has a rule and every pattern still decides
// a file, that what decides the checks always runs all of them, that the CI
// jobs it names run its commands, and that every file the browser tests
// load has them in the map.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { BROWSER_JOB, checksFor, classifyFiles, patternRegExp, readMap, ruleFor } = require('../scripts/classify-ci-changes');

const { root } = require('./helpers/load-script');
const { commandFiles, playwrightTestFiles, requireClosure } = require('./helpers/load-graph');

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

// Where the map and what the browser tests load disagree. Each command of
// a check CI's browser job runs is followed to the files it runs and the
// modules they require; each of those files has to need that check, or
// another check with the same command (the popup's and the website's tests
// are one command). The job's own scripts in the workflow need one of the
// job's checks. A file the browser tests load that the map doesn't give
// them could change without the tests that use it running.
function browserLoadProblems(checkMap, scripts, workflowText, listTests) {
  const problems = [];
  const browser = Object.keys(checkMap.checks).filter((name) => checkMap.checks[name].job === BROWSER_JOB);
  const commands = [...new Set(browser.flatMap((name) => checkMap.checks[name].run))];
  for (const command of commands) {
    const any = browser.filter((name) => checkMap.checks[name].run.includes(command));
    const script = /^npm run ([\w:-]+)$/.exec(command)?.[1];
    for (const file of requireClosure(commandFiles(scripts, script, listTests))) {
      if (!checksFor(checkMap, file).some((name) => any.includes(name))) {
        problems.push(`${command} loads ${file}, but checks.json doesn't give it ${any.join(' or ')}`);
      }
    }
  }
  const job = new RegExp(`^ {2}${BROWSER_JOB}:\\n[\\s\\S]*?(?=^ {2}\\S|(?![\\s\\S]))`, 'm').exec(workflowText)?.[0] ?? '';
  for (const file of new Set([...job.matchAll(/\b(scripts\/[\w.-]+\.(?:js|sh))\b/g)].map((match) => match[1]))) {
    if (!checksFor(checkMap, file).some((name) => browser.includes(name))) {
      problems.push(`the ${BROWSER_JOB} job runs ${file}, but checks.json gives it none of ${browser.join(', ')}`);
    }
  }
  return problems;
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
    // The checks a workflow of its own runs name a workflow that is there.
    const own = Object.entries(map.checks).filter(([, check]) => check.by === 'workflow');
    assert.deepEqual(own.map(([name]) => name), ['audio-hosted', 'dependency-audit']);
    for (const [name, { workflow }] of own) assert.ok(tracked.includes(workflow), `${name}: no ${workflow}`);
    // The commands are the package's own scripts.
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const [name, { run = [] }] of Object.entries(map.checks)) {
      for (const command of run) {
        const script = /npm run ([\w:-]+)(?: -- <folder>)?$/.exec(command)?.[1];
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

  test('every file the browser tests load has them in the map', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    // Playwright lists each configuration's tests once for the checks below.
    const listed = new Map();
    const listTests = (config) => listed.get(config) ?? listed.set(config, playwrightTestFiles(config)).get(config);
    assert.deepEqual(browserLoadProblems(map, scripts, ciWorkflow, listTests), []);

    // What is followed: the commands' own files and what they require.
    const e2e = requireClosure(commandFiles(scripts, 'test:e2e', listTests));
    for (const file of ['scripts/build-extension.js', 'playwright.config.js', 'e2e/extension.spec.js', 'e2e/extension-copy.js', 'scripts/request-target.js']) {
      assert.ok(e2e.includes(file), `test:e2e wasn't followed to ${file}`);
    }
    const ui = requireClosure(commandFiles(scripts, 'test:ui', listTests));
    for (const file of ['playwright.ui.config.js', 'e2e/ui/site.spec.js', 'e2e/limiter-stage.js', 'scripts/popup-preview.js', 'scripts/serve-site.js']) {
      assert.ok(ui.includes(file), `test:ui wasn't followed to ${file}`);
    }
    assert.ok(requireClosure(commandFiles(scripts, 'test:firefox', listTests)).includes('e2e/firefox-launch.js'));
    // None of them loads the audio suite, the audit or the checking tools,
    // which is why those don't need the browser tests.
    const loaded = new Set([...e2e, ...ui, ...requireClosure(commandFiles(scripts, 'test:firefox', listTests))]);
    for (const file of loaded) assert.ok(!file.startsWith('e2e/audio-capture/'), file);
    for (const file of ['scripts/dependency-audit.js', 'scripts/firefox-release.js', 'scripts/check-whitespace.js', 'scripts/node-test-results.js']) {
      assert.ok(!loaded.has(file), file);
      assert.deepEqual(classifyFiles([file], map), { browser: false }, file);
    }
  });

  test('finds a file the browser tests load that the map leaves out of them', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const listTests = (config) => (config === 'playwright.config.js' ? ['e2e/extension.spec.js'] : ['e2e/ui/site.spec.js']);
    assert.deepEqual(browserLoadProblems(map, scripts, ciWorkflow, listTests), []);
    // The rule for the disposable copy of the build and for starting
    // Firefox taken out of the extension's tests.
    const without = readMap(
      changed((copy) => {
        const rule = copy.rules.find(({ paths }) => paths.includes('e2e/extension-copy.js'));
        rule.needs = rule.needs.filter((name) => name !== 'extension');
      })
    );
    assert.deepEqual(browserLoadProblems(without, scripts, ciWorkflow, listTests), [
      "npm run test:e2e loads e2e/extension-copy.js, but checks.json doesn't give it extension",
      "npm run test:firefox loads e2e/extension-copy.js, but checks.json doesn't give it extension",
      "npm run test:firefox loads e2e/firefox-launch.js, but checks.json doesn't give it extension"
    ]);
    // A test that starts loading a file of the audio suite.
    const loads = { ...scripts, 'test:ui': `${scripts['test:ui']} && node e2e/audio-capture/metrics.js` };
    assert.deepEqual(browserLoadProblems(map, loads, ciWorkflow, listTests), [
      "npm run test:ui loads e2e/audio-capture/metrics.js, but checks.json doesn't give it ui or site"
    ]);
    // A script the job runs that the map gives none of its checks.
    const job = ciWorkflow.replace('run: bash scripts/ci-package-downloads.sh', 'run: bash scripts/ci-install-firefox.sh');
    assert.notEqual(job, ciWorkflow);
    assert.deepEqual(browserLoadProblems(map, scripts, job, listTests), [
      'the browser-smoke job runs scripts/ci-install-firefox.sh, but checks.json gives it none of extension, ui, site'
    ]);
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
    refused((copy) => delete copy.checks['audio-hosted'].workflow, /check "audio-hosted" needs a workflow/);
    refused((copy) => (copy.checks.repo.workflow = '.github/workflows/ci.yml'), /check "repo" needs a workflow/);
    refused((copy) => (copy.checks.listen.when = ''), /check "listen" has a "when" that isn't text/);
    refused((copy) => (copy.checks.listen.steps = ['Listen.']), /check "listen" has a "steps" that isn't text/);
    refused((copy) => (copy.checks.listen.when = 17), /check "listen" has a "when" that isn't text/);
    refused((copy) => (copy.checks.listen.job = 42), /check "listen" has a "job" that isn't text/);
    refused((copy) => (copy.checks['audio-hosted'].workflow = 7), /check "audio-hosted" has a "workflow" that isn't text/);
    refused((copy) => delete copy.checks.extension.run, /check "extension" has no commands for CI to run/);
    refused((copy) => delete copy.checks['audio-mac'].run, /check "audio-mac" is done by hand, so it needs commands or a condition/);
    refused((copy) => delete copy.checks.listen.when, /check "listen" is done by hand, so it needs commands or a condition/);
    refused((copy) => (copy.checks['site-popup-sync'].steps = 'Copy it.'), /check "site-popup-sync" has steps but no condition/);
    // A key the map doesn't read, such as a misspelled one.
    refused((copy) => (copy.checks.listen.whn = 'always'), /check "listen" has "whn", which this map doesn't read/);
    refused((copy) => (copy.rules[0].need = ['repo']), /rule 1 has "need", which this map doesn't read/);
    refused((copy) => (copy.rule = []), /has "rule", which this map doesn't read/);
    assert.throws(() => readMap('[]'), /is not an object/);
    assert.throws(() => readMap('{'), SyntaxError);
    // And the map as it is reads.
    assert.equal(readMap(changed(() => {})).rules.length, map.rules.length);
  });
});
