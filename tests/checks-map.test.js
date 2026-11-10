'use strict';

// Checks checks.json, the map of which checks a change needs: that it is
// whole, that every tracked file has a rule and every pattern still decides
// a file, that what decides the checks always runs all of them, that the CI
// jobs it names run its commands, and that every file the browser tests
// load has them in the map.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { BROWSER_JOB, checksFor, classifyFiles, patternRegExp, readMap, ruleFor } = require('../scripts/classify-ci-changes');

const { root } = require('./helpers/load-script');
const { commandFiles, jobFiles, loadClosure, namedFiles, playwrightFiles } = require('./helpers/load-graph');

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
// a check CI's browser job runs is followed to the files it names, the
// tests and setup files Playwright runs for it, and the modules those
// load; each of those files has to need that check, or another check with
// the same command (the popup's and the website's tests are one command).
// Whatever else the job's own steps name or run needs one of the job's
// checks. A file the browser tests load that the map doesn't give them
// could change without the tests that use it running. A load that can't be
// followed is a problem too.
function browserLoadProblems(checkMap, scripts, workflowText, playwright) {
  const problems = [];
  const follow = (entries) => loadClosure(entries, { scripts, tracked, playwright });
  const browser = Object.keys(checkMap.checks).filter((name) => checkMap.checks[name].job === BROWSER_JOB);
  const commands = [...new Set(browser.flatMap((name) => checkMap.checks[name].run))];
  for (const command of commands) {
    const any = browser.filter((name) => checkMap.checks[name].run.includes(command));
    const script = /^npm run ([\w:-]+)$/.exec(command)?.[1];
    const { files, unread } = follow(commandFiles(scripts, script, tracked, playwright));
    for (const file of files) {
      if (!checksFor(checkMap, file).some((name) => any.includes(name))) {
        problems.push(`${command} loads ${file}, but checks.json doesn't give it ${any.join(' or ')}`);
      }
    }
    problems.push(...unread.map((what) => `${what}, so what ${command} loads can't be followed`));
  }
  const job = new RegExp(`^ {2}${BROWSER_JOB}:\\n[\\s\\S]*?(?=^ {2}\\S|(?![\\s\\S]))`, 'm').exec(workflowText)?.[0] ?? '';
  for (const file of follow(jobFiles(job, scripts, tracked, playwright)).files) {
    if (!checksFor(checkMap, file).some((name) => browser.includes(name))) {
      problems.push(`the ${BROWSER_JOB} job uses ${file}, but checks.json gives it none of ${browser.join(', ')}`);
    }
  }
  return [...new Set(problems)];
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
    // Playwright reads each configuration once for the checks below.
    const read = new Map();
    const playwright = (config) => read.get(config) ?? read.set(config, playwrightFiles(config, tracked)).get(config);
    assert.deepEqual(browserLoadProblems(map, scripts, ciWorkflow, playwright), []);

    // What is followed: the commands' own files and what they load.
    const follow = (name) => loadClosure(commandFiles(scripts, name, tracked, playwright), { scripts, tracked, playwright }).files;
    const e2e = follow('test:e2e');
    for (const file of ['scripts/build-extension.js', 'playwright.config.js', 'e2e/extension.spec.js', 'e2e/extension-copy.js', 'scripts/request-target.js']) {
      assert.ok(e2e.includes(file), `test:e2e wasn't followed to ${file}`);
    }
    const ui = follow('test:ui');
    for (const file of ['playwright.ui.config.js', 'e2e/ui/site.spec.js', 'e2e/limiter-stage.js', 'scripts/popup-preview.js', 'scripts/serve-site.js']) {
      assert.ok(ui.includes(file), `test:ui wasn't followed to ${file}`);
    }
    const firefox = follow('test:firefox');
    assert.ok(firefox.includes('e2e/firefox-launch.js'));
    // And the job's own steps: what it sets up with and reads.
    const job = /^ {2}browser-smoke:\n[\s\S]*?(?=^ {2}\S)/m.exec(ciWorkflow)[0];
    const steps = jobFiles(job, scripts, tracked, playwright);
    for (const file of ['scripts/ci-package-downloads.sh', '.nvmrc', 'package-lock.json', 'e2e/firefox-shutdown.js']) {
      assert.ok(steps.includes(file), `the job wasn't followed to ${file}`);
    }
    // None of them loads the audio suite, the audit or the checking tools,
    // which is why those don't need the browser tests.
    const loaded = new Set([...e2e, ...ui, ...firefox, ...steps]);
    for (const file of loaded) assert.ok(!file.startsWith('e2e/audio-capture/'), file);
    for (const file of ['scripts/dependency-audit.js', 'scripts/firefox-release.js', 'scripts/check-whitespace.js', 'scripts/node-test-results.js']) {
      assert.ok(!loaded.has(file), file);
      assert.deepEqual(classifyFiles([file], map), { browser: false }, file);
    }
  });

  // The browser tests read these as data, which isn't followed above: the
  // build copies the extension's files, and the popup's, the limiter's and
  // the website's tests serve or read them.
  test("the extension's and the website's files all need the browser tests that read them", () => {
    const without = (prefix, check) =>
      tracked.filter((file) => file.startsWith(prefix) && !file.endsWith('.md') && !checksFor(map, file).includes(check));
    assert.deepEqual(without('extension/', 'extension'), []);
    assert.deepEqual(without('site/', 'site'), []);
    assert.ok(tracked.some((file) => file.startsWith('site/assets/')) && tracked.some((file) => file.startsWith('extension/assets/')));
    // A file of either given the repository checks alone is found.
    const fonts = readMap(changed((copy) => copy.rules.unshift({ about: 'Fonts.', paths: ['site/assets/fonts/**'], needs: ['repo'] })));
    assert.ok(tracked.some((file) => file.startsWith('site/assets/fonts/') && !checksFor(fonts, file).includes('site')));
  });

  test('finds a file the browser tests load that the map leaves out of them', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const playwright = (config) => (config === 'playwright.config.js' ? ['e2e/extension.spec.js'] : ['e2e/ui/site.spec.js']);
    assert.deepEqual(browserLoadProblems(map, scripts, ciWorkflow, playwright), []);
    // The rule for the disposable copy of the build and for starting
    // Firefox taken out of the extension's tests.
    const without = readMap(
      changed((copy) => {
        const rule = copy.rules.find(({ paths }) => paths.includes('e2e/extension-copy.js'));
        rule.needs = rule.needs.filter((name) => name !== 'extension');
      })
    );
    assert.deepEqual(browserLoadProblems(without, scripts, ciWorkflow, playwright), [
      "npm run test:e2e loads e2e/extension-copy.js, but checks.json doesn't give it extension",
      "npm run test:firefox loads e2e/extension-copy.js, but checks.json doesn't give it extension",
      "npm run test:firefox loads e2e/firefox-launch.js, but checks.json doesn't give it extension",
      'the browser-smoke job uses e2e/extension-copy.js, but checks.json gives it none of extension, ui, site',
      'the browser-smoke job uses e2e/firefox-launch.js, but checks.json gives it none of extension, ui, site'
    ]);
    // A command that starts running a file of the audio suite, and a
    // Playwright configuration that starts using one as its setup.
    const runs = { ...scripts, 'test:ui': `${scripts['test:ui']} && node e2e/audio-capture/metrics.js` };
    assert.deepEqual(browserLoadProblems(map, runs, ciWorkflow, playwright), [
      "npm run test:ui loads e2e/audio-capture/metrics.js, but checks.json doesn't give it ui or site",
      'the browser-smoke job uses e2e/audio-capture/metrics.js, but checks.json gives it none of extension, ui, site'
    ]);
    const setup = (config) => [...playwright(config), ...(config === 'playwright.ui.config.js' ? ['scripts/node-test-results.js'] : [])];
    assert.deepEqual(browserLoadProblems(map, scripts, ciWorkflow, setup), [
      "npm run test:ui loads scripts/node-test-results.js, but checks.json doesn't give it ui or site",
      'the browser-smoke job uses scripts/node-test-results.js, but checks.json gives it none of extension, ui, site'
    ]);
    // Steps added to the job: a script it runs, and a package command.
    const step = (run) => ciWorkflow.replace('        run: npm run test:e2e\n', `        run: npm run test:e2e\n\n      - name: Another step\n        run: ${run}\n`);
    assert.notEqual(step('true'), ciWorkflow);
    assert.deepEqual(browserLoadProblems(map, scripts, step('bash scripts/ci-install-firefox.sh'), playwright), [
      'the browser-smoke job uses scripts/ci-install-firefox.sh, but checks.json gives it none of extension, ui, site'
    ]);
    assert.deepEqual(browserLoadProblems(map, scripts, step('npm run site:popup'), playwright), [
      'the browser-smoke job uses scripts/sync-site-popup.js, but checks.json gives it none of extension, ui, site'
    ]);
    assert.deepEqual(browserLoadProblems(map, scripts, step('node e2e/audio-capture/chromium-trial.js'), playwright).slice(0, 1), [
      'the browser-smoke job uses e2e/audio-capture/chromium-trial.js, but checks.json gives it none of extension, ui, site'
    ]);
    // A comment that names a file isn't a step.
    assert.deepEqual(browserLoadProblems(map, scripts, step('true # not scripts/ci-install-firefox.sh').replace('        run: true # not', '        # bash'), playwright), []);
  });

  test('follows what a module loads however it is written, and says what it can\'t follow', () => {
    const sources = {
      'e2e/a.spec.js': [
        "const one = require('./one');",
        'const two = require("./two.js");',
        'const three = require(`../scripts/three`);',
        "const four = require ('./four');",
        "const five = import('./five.js');",
        "const six = require.resolve('./six');",
        "const { test } = require('@playwright/test');",
        "const fs = require('node:fs');",
        "// A former helper was require('./commented').",
        "const text = \"require('./in-a-string')\";",
        'const data = require("./data.json");',
        "const folder = require('./folder');"
      ].join('\n'),
      'e2e/one.js': "require('./deeper/seven');",
      'e2e/two.js': '',
      'scripts/three.js': '',
      'e2e/four.js': '',
      'e2e/five.js': '',
      'e2e/six.js': '',
      'e2e/deeper/seven.js': '',
      'e2e/data.json': '{}',
      'e2e/folder/index.js': '',
      'e2e/commented.js': '',
      'e2e/in-a-string.js': ''
    };
    const read = (file) => sources[file] ?? null;
    const { files, unread } = loadClosure(['e2e/a.spec.js'], { read });
    assert.deepEqual(files.sort(), [
      'e2e/a.spec.js',
      'e2e/data.json',
      'e2e/deeper/seven.js',
      'e2e/five.js',
      'e2e/folder/index.js',
      'e2e/four.js',
      'e2e/one.js',
      'e2e/six.js',
      'e2e/two.js',
      'scripts/three.js'
    ]);
    assert.deepEqual(unread, []);
    // A path worked out while the code runs, a missing file, and a file
    // that isn't a script are said, not passed over.
    const odd = {
      'e2e/b.spec.js': "const name = './one';\nrequire(name);\nimport(`./${name}.js`);\nrequire('./gone');\nrequire('./broken');",
      'e2e/broken.js': 'const = ;'
    };
    const result = loadClosure(['e2e/b.spec.js'], { read: (file) => odd[file] ?? null });
    assert.deepEqual(result.files, ['e2e/b.spec.js', 'e2e/broken.js']);
    assert.equal(result.unread.length, 4);
    assert.deepEqual(result.unread.slice(0, 3), [
      'e2e/b.spec.js:2 has a require() of a path worked out while it runs',
      'e2e/b.spec.js:3 has an import() of a path worked out while it runs',
      "e2e/b.spec.js loads ./gone, which isn't there"
    ]);
    assert.match(result.unread[3], /^e2e\/broken\.js can't be read as a script \(/);
    // A shell script is followed to the files it names and the package
    // commands it runs.
    const shell = loadClosure(['scripts/setup.sh'], {
      read: (file) =>
        ({
          'scripts/setup.sh': '# not scripts/release.js\nnode scripts/build-extension.js firefox\nnpm run icons\n',
          'scripts/build-extension.js': '',
          'scripts/release.js': '',
          'scripts/render-icons.js': ''
        })[file] ?? null,
      scripts: { icons: 'node scripts/render-icons.js' },
      tracked: ['scripts/build-extension.js', 'scripts/release.js', 'scripts/render-icons.js']
    });
    assert.deepEqual(shell.files, ['scripts/setup.sh', 'scripts/build-extension.js', 'scripts/render-icons.js']);
    assert.deepEqual(namedFiles('bash ./scripts/a.sh && cat site/README.md README.mdx x/README.md', ['README.md', 'scripts/a.sh', 'site/README.md']), [
      'scripts/a.sh',
      'site/README.md'
    ]);
  });

  test('reads what a Playwright configuration runs besides its tests, in each environment', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-playwright-config-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = path.join(dir, 'playwright.config.js');
    fs.writeFileSync(
      config,
      `const path = require('node:path');
const root = ${JSON.stringify(root)};
module.exports = {
  testDir: path.join(root, 'e2e', 'ui'),
  testMatch: process.env.CI ? '{site,limiter}.spec.js' : 'site.spec.js',
  globalSetup: path.join(root, 'tests', 'helpers', 'load-script.js'),
  reporter: [['line'], [path.join(root, 'scripts', 'node-test-results.js')]],
  webServer: { command: 'node scripts/serve-site.js', url: 'http://127.0.0.1:9', reuseExistingServer: true }
};
`
    );
    const files = playwrightFiles(path.relative(root, config), tracked).sort();
    assert.deepEqual(files, [
      'e2e/ui/limiter.spec.js',
      'e2e/ui/site.spec.js',
      'scripts/node-test-results.js',
      'scripts/serve-site.js',
      'tests/helpers/load-script.js'
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
