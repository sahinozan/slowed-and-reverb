'use strict';

// Checks .github/workflows/audio-capture-trial.yml without running it: that
// every step of each job has a deadline, that the deadlines leave time to
// upload the evidence whichever step runs out of time, judged by GitHub's
// rules for which steps run after a failure, and that the workflow runs for
// a change to any file the audio suites load.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { root } = require('./helpers/load-script');

const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'audio-capture-trial.yml'), 'utf8');
// Minutes kept for the runner's own work between and around the steps.
const RESERVE_MINUTES = 5;
const UPLOAD_MINUTES = 5;

function jobText(name) {
  const match = new RegExp(`^ {2}${name}:\\n[\\s\\S]*?(?=^ {2}\\S|(?![\\s\\S]))`, 'm').exec(workflow);
  assert.ok(match, `no ${name} job`);
  return match[0];
}

// Each step's name, condition, deadline, id and one-line run command.
function steps(job) {
  return job
    .split(/\n(?= {6}- name: )/)
    .slice(1)
    .map((text) => ({
      name: /^ {6}- name: (.*)$/m.exec(text)[1],
      id: /^ {8}id: (\S+)$/m.exec(text)?.[1] ?? null,
      condition: /^ {8}if: (.*)$/m.exec(text)?.[1] ?? null,
      run: /^ {8}run: (.*)$/m.exec(text)?.[1] ?? null,
      minutes: Number(/^ {8}timeout-minutes: (\d+)$/m.exec(text)?.[1] ?? NaN)
    }));
}

// Whether a step runs once an earlier step has failed, by GitHub's rules: a
// step with no condition runs only if all before it succeeded; always() and
// !cancelled() run after a failure. A step that needs the sink's output
// runs only if the sink step finished. Conditions on the Chromium cache
// pick one of two steps and don't depend on a failure.
function runsAfterFailure(step, failedIndex, index, all) {
  const condition = step.condition ?? '';
  if (/always\(\)/.test(condition)) return true;
  if (!/!cancelled\(\)/.test(condition)) return false;
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

// What is wrong with a job's two browser steps: each has to run its own
// browser's command, the Chromium step first, the Firefox step right after.
function browserStepProblems(job, commands) {
  const all = steps(job);
  const problems = [];
  const chromium = all.findIndex((step) => step.name.includes('Chromium audio'));
  const firefox = all.findIndex((step) => step.name.includes('Firefox audio'));
  if (chromium === -1 || firefox !== chromium + 1) problems.push('the Firefox step does not follow the Chromium step');
  if (all[chromium]?.run !== commands.chromium) problems.push(`the Chromium step runs ${all[chromium]?.run}`);
  if (all[firefox]?.run !== commands.firefox) problems.push(`the Firefox step runs ${all[firefox]?.run}`);
  return problems;
}

const JOBS = [
  ['linux-null-sink', 45, { chromium: 'npm run test:audio-trial:chromium', firefox: 'npm run test:audio-trial:firefox' }],
  ['linux-regression', 55, { chromium: 'npm run test:audio:chromium', firefox: 'npm run test:audio:firefox' }]
];

describe('the audio workflow', () => {
  for (const [job, cap, commands] of JOBS) {
    test(`${job}: every step has a deadline, and the upload has its time whichever step runs out`, () => {
      const text = jobText(job);
      assert.match(text, new RegExp(`^ {4}timeout-minutes: ${cap}$`, 'm'));
      const all = steps(text);
      for (const step of all) assert.ok(Number.isInteger(step.minutes) && step.minutes > 0, `${job}: "${step.name}" has no deadline`);
      const upload = all.at(-1);
      assert.match(upload.name, /^Upload /);
      assert.equal(upload.condition, '${{ always() }}');
      assert.equal(upload.minutes, UPLOAD_MINUTES);
      assert.deepEqual(lateUploads(all, cap), [], job);
      // The sums the job's comment gives.
      const setUp = uploadStart(all.slice(0, all.findIndex(({ id }) => id === 'sink') + 1), all.length);
      assert.equal(setUp, 24);
      assert.match(text, new RegExp(`\\(${setUp} minutes to set up,`));
      assert.match(text, new RegExp(`come to ${uploadStart(all, all.length) + UPLOAD_MINUTES}, leaving ${RESERVE_MINUTES}`));
      // Firefox runs after a Chromium failure once the sink is there.
      const chromium = all.findIndex((step) => step.name.includes('Chromium audio'));
      const firefox = all.findIndex((step) => step.name.includes('Firefox audio'));
      assert.ok(chromium !== -1 && firefox === chromium + 1);
      assert.equal(all[firefox].condition, "${{ !cancelled() && steps.sink.outputs.ready == 'true' }}");
      assert.ok(runsAfterFailure(all[firefox], chromium, firefox, all));
      assert.equal(runsAfterFailure(all[firefox], all.findIndex(({ id }) => id === 'sink'), firefox, all), false);
      assert.deepEqual(browserStepProblems(text, commands), [], job);
    });
  }

  test("finds a browser step that runs the wrong command, another browser's, or none", () => {
    const trial = jobText('linux-null-sink');
    const [, , commands] = JOBS[0];
    const chromiumLine = '        run: npm run test:audio-trial:chromium\n';
    const firefoxLine = '        run: npm run test:audio-trial:firefox\n';
    assert.equal(trial.split(chromiumLine).length, 2);
    assert.equal(trial.split(firefoxLine).length, 2);
    const swapped = trial.replace(chromiumLine, 'SWAP').replace(firefoxLine, chromiumLine).replace('SWAP', firefoxLine);
    assert.deepEqual(browserStepProblems(swapped, commands), [
      'the Chromium step runs npm run test:audio-trial:firefox',
      'the Firefox step runs npm run test:audio-trial:chromium'
    ]);
    // The regression suite's command in the trial's job.
    assert.deepEqual(browserStepProblems(trial.replace(chromiumLine, '        run: npm run test:audio:chromium\n'), commands), [
      'the Chromium step runs npm run test:audio:chromium'
    ]);
    // Both steps on one browser.
    assert.deepEqual(browserStepProblems(trial.replace(firefoxLine, chromiumLine), commands), [
      'the Firefox step runs npm run test:audio-trial:chromium'
    ]);
    // A step with its command gone, though the command is still written in
    // the job (here in a comment).
    assert.deepEqual(browserStepProblems(trial.replace(firefoxLine, `        # ${commands.firefox}\n`), commands), [
      'the Firefox step runs null'
    ]);
    // A command with something after it.
    assert.deepEqual(browserStepProblems(trial.replace(chromiumLine, '        run: npm run test:audio-trial:chromium || true\n'), commands), [
      'the Chromium step runs npm run test:audio-trial:chromium || true'
    ]);
  });

  test('finds a setup step given more time than the job has left, or none', () => {
    // The check above, against the trial's job with npm ci given 10
    // minutes: the upload is late once npm ci has taken them, unless npm ci
    // is the step that failed, which skips the rest of the setup.
    const longer = steps(jobText('linux-null-sink').replace(/(- name: Install exact dependencies\n {8}timeout-minutes: )3\n/, '$110\n'));
    assert.equal(longer.find(({ name }) => name === 'Install exact dependencies').minutes, 10);
    const late = lateUploads(longer, 45);
    assert.ok(late.includes('with nothing failing, the upload starts by minute 42'), late.join('\n'));
    assert.ok(late.some((text) => text.includes('"Run the Firefox audio capture trial" out of time')));
    assert.ok(!late.some((text) => text.includes('"Install exact dependencies" out of time')));
    // And one with no deadline at all.
    const unbounded = steps(jobText('linux-null-sink').replace(/(- name: Check out repository\n) {8}timeout-minutes: 1\n/, '$1'));
    assert.ok(Number.isNaN(unbounded[0].minutes));
  });

  test('runs for a change to any file the audio suites load', () => {
    const filters = [...workflow.matchAll(/^ {6}- '([^']+)'$/gm)].map((match) => match[1]);
    const covered = (file) =>
      filters.some((filter) => (filter.endsWith('/**') ? file.startsWith(filter.slice(0, -2)) : file === filter));
    // Every local module reached from the suites' entry points.
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
    assert.ok(seen.has('e2e/firefox-launch.js'));
    for (const file of seen) assert.ok(covered(file), `${file} is loaded by the audio suites but not in the workflow's paths`);
  });
});
