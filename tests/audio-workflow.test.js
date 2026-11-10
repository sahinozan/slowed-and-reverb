'use strict';

// Checks .github/workflows/audio-capture-trial.yml without running it: that
// every step of each browser's job has a deadline, that the deadlines leave
// time to upload the evidence whichever step runs out of time, judged by
// GitHub's rules for which steps run after a failure, that each job runs
// its browser's suite and then its trial, that the nightly runs ask for the
// Firefox releases BASELINE.md needs, that the workflow runs for a change to
// any file the audio suites load, that its paths are the ones checks.json
// gives the hosted audio suites, and that the suites never open the popup,
// which is why the map leaves the popup's files out of them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { checksFor, patternRegExp, readMap, ruleFor } = require('../scripts/classify-ci-changes');

const { root } = require('./helpers/load-script');

const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'audio-capture-trial.yml'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Minutes kept for the runner's own work between and around the steps.
const RESERVE_MINUTES = 5;
const UPLOAD_MINUTES = 5;
const CAP = 50;
const BROWSERS = ['chromium', 'firefox'];

function jobText(name) {
  const match = new RegExp(`^ {2}${name}:\\n[\\s\\S]*?(?=^ {2}\\S|(?![\\s\\S]))`, 'm').exec(workflow);
  assert.ok(match, `no ${name} job`);
  return match[0];
}

// Each step's name, condition, deadline, id, one-line run command and
// whether its failure lets the job go on.
function steps(job) {
  return job
    .split(/\n(?= {6}- name: )/)
    .slice(1)
    .map((text) => ({
      name: /^ {6}- name: (.*)$/m.exec(text)[1],
      id: /^ {8}id: (\S+)$/m.exec(text)?.[1] ?? null,
      condition: /^ {8}if: (.*)$/m.exec(text)?.[1] ?? null,
      run: /^ {8}run: (.*)$/m.exec(text)?.[1] ?? null,
      continueOnError: /^ {8}continue-on-error: true$/m.test(text),
      minutes: Number(/^ {8}timeout-minutes: (\d+)$/m.exec(text)?.[1] ?? NaN)
    }));
}

// The steps that run in one browser's job: not those for another browser,
// nor those that read the output of a step that doesn't run there.
function stepsFor(all, browser) {
  const kept = all.filter(({ condition }) => {
    const only = /matrix\.browser == '(\w+)'/.exec(condition ?? '');
    return !only || only[1] === browser;
  });
  const ids = new Set(kept.map(({ id }) => id));
  return kept.filter(({ condition }) => [...(condition ?? '').matchAll(/steps\.([\w-]+)\.outputs/g)].every(([, id]) => ids.has(id)));
}

// Whether a step runs once an earlier step has failed, by GitHub's rules: a
// step with no status function runs only if all before it succeeded;
// always() and !cancelled() run after a failure. A failed step with
// continue-on-error counts as a success. A step that needs the sink's output
// runs only if the sink step finished, and one that asks that a step didn't
// fail doesn't run after that step's failure. Conditions on the Chromium
// cache pick one of two steps and don't depend on a failure.
function runsAfterFailure(step, failedIndex, index, all) {
  if (all[failedIndex]?.continueOnError) return true;
  const condition = step.condition ?? '';
  if (/always\(\)/.test(condition)) return true;
  if (!/!cancelled\(\)/.test(condition)) return false;
  for (const [, id] of condition.matchAll(/steps\.([\w-]+)\.outcome != 'failure'/g)) {
    if (all.findIndex((candidate) => candidate.id === id) === failedIndex) return false;
  }
  const sink = all.findIndex(({ id }) => id === 'sink');
  if (/steps\.sink\.outputs\.ready == 'true'/.test(condition)) return sink < failedIndex && sink < index;
  return true;
}

const ALTERNATIVES = [/cache-hit != 'true'/, /cache-hit == 'true'/];

// The latest minute at which the upload can start if step `failedIndex`
// runs out of time, with every step before it taking its whole deadline.
// Of the two steps for the Chromium cache only one runs; the longer counts.
function uploadStart(all, failedIndex) {
  let minutes = 0;
  let alternative = 0;
  all.forEach((step, index) => {
    if (step.name.startsWith('Upload')) return;
    const runs = index <= failedIndex || runsAfterFailure(step, failedIndex, index, all);
    if (!runs) return;
    if (ALTERNATIVES.some((pattern) => pattern.test(step.condition ?? ''))) {
      alternative = Math.max(alternative, step.minutes);
      return;
    }
    minutes += step.minutes;
  });
  return minutes + alternative;
}

// Where the upload would start too late: with nothing failing, and with
// each step in turn running out of time.
function lateUploads(all, cap) {
  const late = [];
  for (let failed = -1; failed < all.length - 1; failed++) {
    const start = uploadStart(all, failed === -1 ? all.length : failed);
    if (start + UPLOAD_MINUTES + RESERVE_MINUTES > cap) {
      late.push(`with ${failed === -1 ? 'nothing failing' : `"${all[failed].name}" out of time`}, the upload starts by minute ${start}`);
    }
  }
  return late;
}

const SUITE = 'npm run test:audio:${{ matrix.browser }}';
const TRIAL = 'npm run test:audio-trial:${{ matrix.browser }}';

// What is wrong with a job's suite and trial steps: the suite runs its
// browser's command, and the trial its own, right after it.
function suiteStepProblems(job) {
  const all = steps(job);
  const problems = [];
  const suite = all.findIndex((step) => step.name === 'Run the audio regression suite');
  const trial = all.findIndex((step) => step.name === 'Run the audio capture trial');
  if (suite === -1 || trial !== suite + 1) problems.push('the trial does not follow the suite');
  if (all[suite]?.run !== SUITE) problems.push(`the suite step runs ${all[suite]?.run}`);
  if (all[trial]?.run !== TRIAL) problems.push(`the trial step runs ${all[trial]?.run}`);
  return problems;
}

// Every step's whole condition, by step name. The model above reads parts
// of a condition, so a condition it doesn't know (one with `&& false` added,
// say) is refused here instead of passing on the parts it recognizes. A
// step not listed has no condition.
const CONDITIONS = {
  'Read the Playwright version': "matrix.browser == 'chromium'",
  'Restore Playwright Chromium': "matrix.browser == 'chromium'",
  'Install Playwright Chromium': "matrix.browser == 'chromium' && steps.playwright-cache.outputs.cache-hit != 'true'",
  "Install Chromium's system libraries": "matrix.browser == 'chromium' && steps.playwright-cache.outputs.cache-hit == 'true'",
  'Choose the Firefox release': "matrix.browser == 'firefox'",
  'Install the Firefox asked for': "steps.firefox-release.outputs.version != ''",
  "Read Firefox's files into memory": "matrix.browser == 'firefox'",
  'Run the audio capture trial':
    "${{ !cancelled() && steps.sink.outputs.ready == 'true' && steps.firefox-release.outcome != 'failure' && steps.firefox-install.outcome != 'failure' }}",
  "Show the sound server's state": '${{ !cancelled() }}',
  'Upload the evidence': '${{ always() }}'
};
// The only step whose failure may let the job go on: an experiment that
// can't stop the tests.
const MAY_FAIL = ["Read Firefox's files into memory"];

// What is wrong with the job's conditions and continue-on-error: a
// condition other than the one listed, or a step allowed to fail that may
// not (a suite or trial failure would then leave the job green).
function stepRuleProblems(text) {
  const problems = [];
  for (const step of steps(text)) {
    const expected = CONDITIONS[step.name] ?? null;
    if (step.condition !== expected) problems.push(`"${step.name}" runs if ${step.condition}, not ${expected}`);
    if (step.continueOnError && !MAY_FAIL.includes(step.name)) problems.push(`"${step.name}" may fail without failing the job`);
    if (/continue-on-error/.test(text.split(`- name: ${step.name}\n`)[1]?.split(/\n {6}- name: /)[0] ?? '') && !step.continueOnError) {
      problems.push(`"${step.name}" has a continue-on-error this check can't read`);
    }
  }
  if (/^ {4}continue-on-error:/m.test(text)) problems.push('the job may fail without failing the run');
  return problems;
}

// The workflow's paths.
const FILTERS = [...workflow.matchAll(/^ {6}- '([^']+)'$/gm)].map((match) => match[1]);

// Read as checks.json's patterns are, which is how GitHub reads these.
function covered(file) {
  return FILTERS.some((filter) => patternRegExp(filter).test(file));
}

// Every local module reached from the suites' entry points.
function suiteModules() {
  const entries = ['chromium-regression.js', 'firefox-regression.js', 'chromium-trial.js', 'firefox-trial.js'];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, request] of source.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
      let target = path.relative(root, path.resolve(path.dirname(path.join(root, file)), request));
      if (!target.endsWith('.js') && !target.endsWith('.json')) target += '.js';
      visit(target.split(path.sep).join('/'));
    }
  };
  for (const entry of entries) visit(`e2e/audio-capture/${entry}`);
  return [...seen];
}

// The repository's scripts a package command runs, through the commands it
// runs with npm run.
function commandScripts(scripts, name, seen = new Set()) {
  if (seen.has(name) || typeof scripts[name] !== 'string') return [];
  seen.add(name);
  // In the order the command runs them.
  return [...scripts[name].matchAll(/\bnpm run ([\w:-]+)|\b(scripts\/[\w.-]+\.(?:js|sh))\b/g)].flatMap(([, command, file]) =>
    command ? commandScripts(scripts, command, seen) : [file]
  );
}

// The files git tracks, so a file the system leaves in a folder doesn't
// count.
function trackedFiles(folder = '.') {
  return execFileSync('git', ['ls-files', '-z', '--', folder], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

// Where the workflow's paths and the map (checks.json) disagree about the
// hosted audio suites: in the patterns themselves, which have to be the
// same list, and then file by file, read as GitHub reads its path filters.
// The workflow may run for a file the map's documentation rule takes (the
// suite's README, say): GitHub can't tell, and such a change needs no runs.
function audioPathProblems(files, filters, map) {
  const problems = [];
  const patterns = map.rules.filter((rule) => rule.needs.includes('audio-hosted')).flatMap((rule) => rule.paths);
  for (const pattern of patterns) {
    if (!filters.includes(pattern)) problems.push(`checks.json gives ${pattern} the hosted audio suites, but it isn't in the workflow's paths`);
  }
  for (const filter of filters) {
    if (!patterns.includes(filter)) problems.push(`${filter} is in the workflow's paths, but checks.json doesn't give it the hosted audio suites`);
  }
  const matchers = filters.map(patternRegExp);
  for (const file of files) {
    const needs = checksFor(map, file).includes('audio-hosted');
    const runs = matchers.some((matcher) => matcher.test(file));
    const documentation = ruleFor(map, file)?.paths.includes('**/*.md') ?? false;
    if (needs && !runs) problems.push(`${file} needs the hosted audio suites, but the workflow doesn't run for it`);
    if (runs && !needs && !documentation) problems.push(`the workflow runs for ${file}, which doesn't need the hosted audio suites`);
  }
  return problems;
}

// The lines of these files that match, as "file:line". A line that is only
// a comment is left out: saying something about the popup opens nothing.
// Names are read as they are written, so one put together while the code
// runs isn't seen.
function linesNaming(sources, pattern) {
  return Object.entries(sources).flatMap(([file, text]) =>
    text.split('\n').flatMap((line, index) => {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return [];
      const match = pattern.exec(line);
      return match ? [{ where: `${file}:${index + 1}`, name: match[0], line: line.trim() }] : [];
    })
  );
}

// The popup's page by its name, the browser's call that opens it, and the
// manifest's key that holds its name.
const POPUP_PAGE = /popup\.html|openPopup|default_popup/;

// Where the suites' own files name the popup's page or ask the browser to
// open it. They may patch popup.js in their copy of the build
// (extension-copy.js); they may not load it.
function popupUses(sources) {
  return linesNaming(sources, POPUP_PAGE).map(
    ({ where }) => `${where} names the popup's page; if the suites open the popup, its files belong in the audio workflow's paths`
  );
}

// The only lines of the extension's other files that may name the popup's
// page: the manifest gives it to the toolbar's button, and the background
// script checks that a message came from it. Neither opens it.
const POPUP_PAGE_NAMED = ['"default_popup": "popup.html",', "url.pathname === '/popup.html'"];

// Where the extension's other files name the popup's script or styles,
// which only the popup's page may load, or name its page in any other line
// than those two, as a script that opened the popup by itself would.
function popupLoads(sources) {
  return [
    ...linesNaming(sources, /popup\.(?:css|js)\b/).map(
      ({ where, name }) => `${where} names ${name}; if it runs outside the popup's page, the popup's files belong in the audio workflow's paths`
    ),
    ...linesNaming(sources, POPUP_PAGE)
      .filter(({ line }) => !POPUP_PAGE_NAMED.includes(line))
      .map(({ where }) => `${where} names the popup's page; if the extension opens the popup by itself, its files belong in the audio workflow's paths`)
  ];
}

const job = jobText('linux');
const SETUP = { chromium: 24, firefox: 14 };

describe('the audio workflow', () => {
  test('has one job for each browser, and neither stops the other', () => {
    const browsers = [...job.matchAll(/^ {10}- browser: (\w+)$/gm)].map((match) => match[1]);
    assert.deepEqual(browsers, BROWSERS);
    assert.match(job, /^ {6}fail-fast: false$/m);
    for (const browser of BROWSERS) {
      assert.ok(packageJson.scripts[`test:audio:${browser}`], `no test:audio:${browser}`);
      assert.ok(packageJson.scripts[`test:audio-trial:${browser}`], `no test:audio-trial:${browser}`);
    }
  });

  for (const browser of BROWSERS) {
    test(`${browser}: every step has a deadline, and the upload has its time whichever step runs out`, () => {
      assert.match(job, new RegExp(`^ {4}timeout-minutes: ${CAP}$`, 'm'));
      const all = stepsFor(steps(job), browser);
      for (const step of all) assert.ok(Number.isInteger(step.minutes) && step.minutes > 0, `${browser}: "${step.name}" has no deadline`);
      const upload = all.at(-1);
      assert.match(upload.name, /^Upload /);
      assert.equal(upload.condition, '${{ always() }}');
      assert.equal(upload.minutes, UPLOAD_MINUTES);
      assert.deepEqual(lateUploads(all, CAP), [], browser);
      // The sums the job's comment gives.
      const setUp = uploadStart(all.slice(0, all.findIndex(({ id }) => id === 'sink') + 1), all.length);
      assert.equal(setUp, SETUP[browser]);
      const name = browser === 'chromium' ? 'Chromium' : 'Firefox';
      const comment = job.replace(/\n\s*# /g, ' ');
      assert.match(comment, new RegExp(`${uploadStart(all, all.length) + UPLOAD_MINUTES} in the ${name} job \\(${setUp} to set up,`));
      // The trial runs after a failed suite once the sink is there.
      const suite = all.findIndex((step) => step.name === 'Run the audio regression suite');
      const trial = all.findIndex((step) => step.name === 'Run the audio capture trial');
      assert.equal(all[suite].condition, null, 'the suite runs only if every step before it succeeded');
      assert.ok(runsAfterFailure(all[trial], suite, trial, all));
      assert.equal(runsAfterFailure(all[trial], all.findIndex(({ id }) => id === 'sink'), trial, all), false);
      // A Firefox asked for that can't be chosen or installed (or runs out
      // of time) stops both, in the job that installs one.
      const choose = all.findIndex(({ id }) => id === 'firefox-release');
      const install = all.findIndex(({ id }) => id === 'firefox-install');
      if (browser === 'firefox') {
        assert.ok(choose !== -1 && install === choose + 1 && install < suite, 'the Firefox job chooses and installs a Firefox before the suite');
        assert.equal(all[choose].run, 'node scripts/firefox-release.js "$FIREFOX_ASKED" test-results/audio-regression/firefox-release.json');
        assert.equal(all[install].condition, "steps.firefox-release.outputs.version != ''");
        assert.equal(all[install].run, 'bash scripts/ci-install-firefox.sh');
        assert.match(job, /^ {10}FIREFOX_VERSION: \$\{\{ steps\.firefox-release\.outputs\.version \}\}$/m);
        for (const failed of [choose, install]) {
          assert.equal(runsAfterFailure(all[suite], failed, suite, all), false);
          assert.equal(runsAfterFailure(all[trial], failed, trial, all), false);
        }
      } else {
        assert.equal(choose, -1, 'the Chromium job chooses no Firefox');
        assert.equal(install, -1, 'the Chromium job installs no Firefox');
      }
    });
  }

  test('each job runs its suite, then its trial', () => {
    assert.deepEqual(suiteStepProblems(job), []);
  });

  test('every step runs when it should, and only the experiment may fail without failing the job', () => {
    assert.deepEqual(stepRuleProblems(job), []);
    for (const name of Object.keys(CONDITIONS)) assert.ok(steps(job).some((step) => step.name === name), `no step "${name}"`);
  });

  test('finds a trial turned off, a suite allowed to fail, or a condition changed', () => {
    const trialIf = `        if: ${CONDITIONS['Run the audio capture trial']}\n`;
    assert.equal(job.split(trialIf).length, 2);
    const off = job.replace(trialIf, trialIf.replace(' }}\n', ' && false }}\n'));
    assert.deepEqual(stepRuleProblems(off), [
      `"Run the audio capture trial" runs if ${CONDITIONS['Run the audio capture trial'].replace(' }}', ' && false }}')}, not ${CONDITIONS['Run the audio capture trial']}`
    ]);
    const suiteHead = '      - name: Run the audio regression suite\n';
    assert.equal(job.split(suiteHead).length, 2);
    const failing = job.replace(suiteHead, `${suiteHead}        continue-on-error: true\n`);
    assert.deepEqual(stepRuleProblems(failing), ['"Run the audio regression suite" may fail without failing the job']);
    const guarded = job.replace(suiteHead, `${suiteHead}        if: \${{ always() }}\n`);
    assert.deepEqual(stepRuleProblems(guarded), ['"Run the audio regression suite" runs if ${{ always() }}, not null']);
    const wholeJob = job.replace('    timeout-minutes: 50\n', '    timeout-minutes: 50\n    continue-on-error: true\n');
    assert.deepEqual(stepRuleProblems(wholeJob), ['the job may fail without failing the run']);
  });

  test("finds a suite or trial step that runs the wrong command, or none, or in the wrong order", () => {
    const suiteLine = `        run: ${SUITE}\n`;
    const trialLine = `        run: ${TRIAL}\n`;
    assert.equal(job.split(suiteLine).length, 2);
    assert.equal(job.split(trialLine).length, 2);
    const swapped = job.replace(suiteLine, 'SWAP').replace(trialLine, suiteLine).replace('SWAP', trialLine);
    assert.deepEqual(suiteStepProblems(swapped), [`the suite step runs ${TRIAL}`, `the trial step runs ${SUITE}`]);
    // One browser named outright.
    assert.deepEqual(suiteStepProblems(job.replace(suiteLine, '        run: npm run test:audio:chromium\n')), [
      'the suite step runs npm run test:audio:chromium'
    ]);
    // A step with its command gone, though the command is still written in
    // the job (here in a comment).
    assert.deepEqual(suiteStepProblems(job.replace(trialLine, `        # ${TRIAL}\n`)), ['the trial step runs null']);
    // A command with something after it.
    assert.deepEqual(suiteStepProblems(job.replace(suiteLine, `        run: ${SUITE} || true\n`)), [
      `the suite step runs ${SUITE} || true`
    ]);
    // The trial moved before the suite.
    const trialStep = /\n {6}- name: Run the audio capture trial\n[\s\S]*?(?=\n {6}- name: )/.exec(job)[0];
    const moved = job.replace(trialStep, '').replace('\n      - name: Run the audio regression suite', `${trialStep}\n      - name: Run the audio regression suite`);
    assert.deepEqual(suiteStepProblems(moved), ['the trial does not follow the suite']);
  });

  test('finds a setup step given more time than the job has left, or none', () => {
    // The check above, with npm ci given 10 minutes: the upload is late
    // once npm ci has taken them, unless npm ci is the step that failed,
    // which skips the rest of the setup.
    const longer = stepsFor(steps(job.replace(/(- name: Install exact dependencies\n {8}timeout-minutes: )3\n/, '$110\n')), 'chromium');
    assert.equal(longer.find(({ name }) => name === 'Install exact dependencies').minutes, 10);
    const late = lateUploads(longer, CAP);
    assert.ok(late.includes('with nothing failing, the upload starts by minute 47'), late.join('\n'));
    assert.ok(late.some((text) => text.includes('"Run the audio capture trial" out of time')));
    assert.ok(!late.some((text) => text.includes('"Install exact dependencies" out of time')));
    // And one with no deadline at all.
    const unbounded = steps(job.replace(/(- name: Check out repository\n) {8}timeout-minutes: 1\n/, '$1'));
    assert.ok(Number.isNaN(unbounded[0].minutes));
  });

  test('runs twice each night, first on Firefox\'s current release, then on the one before', () => {
    const crons = [...workflow.matchAll(/^ {4}- cron: '([^']+)'$/gm)].map((match) => match[1]);
    assert.equal(crons.length, 2);
    const asked = /^ {2}FIREFOX_ASKED: (.*)$/m.exec(workflow)?.[1];
    assert.equal(
      asked,
      `\${{ github.event_name == 'schedule' && (github.event.schedule == '${crons[0]}' && 'current' || 'previous') || inputs.firefox }}`
    );
    // On the same day in Berlin, in summer time as in winter: a run's day
    // is when its Chromium suite started there (BASELINE.md).
    for (const cron of crons) {
      const [minute, hour, ...rest] = cron.split(' ');
      assert.deepEqual(rest, ['*', '*', '*']);
      assert.ok(Number(minute) % 60 !== 0, `${cron} starts on the hour`);
      assert.ok(Number(hour) + 2 < 24, `${cron} can fall on the next day in Berlin`);
    }
    // A nightly run never replaces a waiting run started by hand.
    assert.match(workflow, /group: audio-capture-trial-\$\{\{ github\.event_name == 'schedule' && 'nightly' \|\| /);
    assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });

  test('runs for a change to any file the audio suites load or the workflow runs', () => {
    const seen = new Set(suiteModules());
    assert.ok(seen.has('e2e/firefox-launch.js'));
    // And every script a step runs.
    const scripts = [...workflow.matchAll(/\b(scripts\/[\w.-]+\.(?:js|sh))\b/g)].map((match) => match[1]);
    assert.ok(scripts.includes('scripts/firefox-release.js'));
    // And every script the suites' own commands run first, such as the
    // build of the copy they load.
    const commands = BROWSERS.flatMap((browser) => [`test:audio:${browser}`, `test:audio-trial:${browser}`]);
    const built = commands.flatMap((name) => commandScripts(packageJson.scripts, name));
    assert.ok(built.includes('scripts/build-extension.js'));
    for (const file of [...seen, ...scripts, ...built]) assert.ok(covered(file), `${file} is used by the audio workflow but not in its paths`);
    // A command that ran another script first would have to be in the paths too.
    assert.deepEqual(
      commandScripts({ 'test:audio:chromium': 'npm run prepare:audio && node --test e2e/x.js', 'prepare:audio': 'node scripts/prepare.js && npm run build:chromium', 'build:chromium': 'node scripts/build-extension.js chromium' }, 'test:audio:chromium'),
      ['scripts/prepare.js', 'scripts/build-extension.js']
    );
  });

  test('its paths are the ones the map gives the hosted audio suites', () => {
    const map = readMap();
    assert.equal(map.checks['audio-hosted'].workflow, '.github/workflows/audio-capture-trial.yml');
    const files = trackedFiles();
    for (const file of ['extension/settings.js', 'extension/popup.js', 'e2e/audio-capture/README.md', 'package.json']) {
      assert.ok(files.includes(file), `git ls-files didn't list ${file}`);
    }
    assert.deepEqual(audioPathProblems(files, FILTERS, map), []);
    // Of the extension's files, those that can reach the sound: not the
    // popup's or the icons.
    const heard = trackedFiles('extension').filter((file) => checksFor(map, file).includes('audio-hosted'));
    assert.deepEqual(
      heard,
      ['background.js', 'content.js', 'manifest.json', 'settings.js', 'spotify-bridge.js', 'spotify-main.js', 'youtube-main.js'].map(
        (name) => `extension/${name}`
      )
    );
  });

  test('nothing but the toolbar opens the popup, and only its page loads its script and styles', () => {
    // Why the map leaves the popup's files out of the hosted audio suites:
    // the suites don't open the popup, the extension doesn't open it by
    // itself, and nothing but the popup's page loads its script and styles.
    const sources = Object.fromEntries(suiteModules().map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
    assert.deepEqual(popupUses(sources), []);
    const others = Object.fromEntries(
      trackedFiles('extension')
        .filter((file) => /\.(?:js|json)$/.test(file) && file !== 'extension/popup.js')
        .map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')])
    );
    assert.ok(Object.keys(others).includes('extension/manifest.json'));
    assert.deepEqual(popupLoads(others), []);
  });

  test('finds paths and a map that disagree', () => {
    const map = readMap();
    const files = trackedFiles();
    // A file that reaches the sound taken out of the workflow.
    assert.deepEqual(audioPathProblems(files, FILTERS.filter((filter) => filter !== 'extension/settings.js'), map), [
      "checks.json gives extension/settings.js the hosted audio suites, but it isn't in the workflow's paths",
      "extension/settings.js needs the hosted audio suites, but the workflow doesn't run for it"
    ]);
    // The whole folder again, as it was: the popup's files and every icon.
    const whole = audioPathProblems(files, [...FILTERS, 'extension/**'], map);
    assert.equal(whole[0], "extension/** is in the workflow's paths, but checks.json doesn't give it the hosted audio suites");
    assert.ok(whole.includes("the workflow runs for extension/popup.css, which doesn't need the hosted audio suites"), whole.join('\n'));
    assert.ok(whole.includes("the workflow runs for extension/assets/icon128.png, which doesn't need the hosted audio suites"));
    // The map changed alone: the popup's script given the suites, and the
    // settings no longer.
    const copy = JSON.parse(fs.readFileSync(path.join(root, 'checks.json'), 'utf8'));
    copy.rules.find((rule) => rule.paths.includes('extension/popup.js')).needs.push('audio-hosted');
    copy.rules.find((rule) => rule.paths.includes('extension/settings.js')).needs = ['repo'];
    assert.deepEqual(audioPathProblems(files, FILTERS, readMap(JSON.stringify(copy))), [
      "checks.json gives extension/popup.html the hosted audio suites, but it isn't in the workflow's paths",
      "checks.json gives extension/popup.js the hosted audio suites, but it isn't in the workflow's paths",
      "extension/settings.js is in the workflow's paths, but checks.json doesn't give it the hosted audio suites",
      "extension/popup.html needs the hosted audio suites, but the workflow doesn't run for it",
      "extension/popup.js needs the hosted audio suites, but the workflow doesn't run for it",
      "the workflow runs for extension/settings.js, which doesn't need the hosted audio suites"
    ]);
    // Only pictures are icons: a script put among them is a path the map
    // doesn't know, which a test of the map finds.
    assert.equal(ruleFor(map, 'extension/assets/helper.js'), null);
    assert.ok(ruleFor(map, 'extension/assets/icon64.png').paths.includes('extension/assets/*.png'));
    // Documentation in the suite's folder is the one difference allowed.
    assert.ok(patternRegExp('e2e/audio-capture/**').test('e2e/audio-capture/README.md'));
    assert.ok(!checksFor(map, 'e2e/audio-capture/README.md').includes('audio-hosted'));
  });

  test("finds a suite that opens the popup, or a script that loads the popup's files or opens it", () => {
    const suites = "if the suites open the popup, its files belong in the audio workflow's paths";
    assert.deepEqual(
      popupUses({
        'e2e/audio-capture/harness.js': "// Opens the page.\nawait page.goto(`chrome-extension://${id}/popup.html`);\n",
        'e2e/extension-copy.js': "await worker.evaluate(() => chrome.action.openPopup());\n['popup.js', 'youTubePermissionFor']\n",
        'e2e/audio-capture/browsers.js': 'await page.goto(new URL(manifest.action.default_popup, base).href);\n'
      }),
      [
        `e2e/audio-capture/harness.js:2 names the popup's page; ${suites}`,
        `e2e/extension-copy.js:1 names the popup's page; ${suites}`,
        `e2e/audio-capture/browsers.js:1 names the popup's page; ${suites}`
      ]
    );
    // A comment about the popup opens nothing.
    assert.deepEqual(
      popupUses({ 'e2e/audio-capture/harness.js': '// The suites do not open popup.html.\n  /* Nor call openPopup. */\n   * popup.html\n' }),
      []
    );

    const outside = "if it runs outside the popup's page, the popup's files belong in the audio workflow's paths";
    const opens = "if the extension opens the popup by itself, its files belong in the audio workflow's paths";
    assert.deepEqual(
      popupLoads({
        'extension/background.js': [
          "await api.scripting.executeScript({ target: { tabId }, files: ['popup.js'] });",
          "await api.tabs.create({ url: api.runtime.getURL('popup.html'), active: false });",
          'await api.action.openPopup();',
          // The two lines that may name the page, and a comment.
          "      url.pathname === '/popup.html'",
          '// The interface lives in popup.js, which popup.html loads.'
        ].join('\n'),
        'extension/manifest.json': '{\n    "default_popup": "popup.html",\n  "web_accessible_resources": ["popup.css"]\n}\n',
        'extension/content.js': 'location.href = api.runtime.getManifest().action.default_popup;\n'
      }),
      [
        `extension/background.js:1 names popup.js; ${outside}`,
        `extension/manifest.json:3 names popup.css; ${outside}`,
        `extension/background.js:2 names the popup's page; ${opens}`,
        `extension/background.js:3 names the popup's page; ${opens}`,
        `extension/content.js:1 names the popup's page; ${opens}`
      ]
    );
  });
});
