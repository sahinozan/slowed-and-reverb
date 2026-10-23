'use strict';

// What each Playwright configuration runs, as Playwright itself lists it
// (playwright test --list, which starts no browser). npm run test:e2e must
// run only the installed extension's tests, in Chromium; npm run test:ui the
// popup layout and website tests, in Chromium and Gecko, with what only the
// Firefox build shows in Gecko alone. Neither may pick up the audio suites,
// which run under node --test, or list nothing.

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test } = require('node:test');

const { root } = require('./helpers/load-script');

const cli = require.resolve('@playwright/test/cli');

// Each listed test as "project › file › title".
function listed(config) {
  const result = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json', `--config=${config}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '', SLOWED_REVERB_POPUP_HISTORY: '' }
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.errors, []);
  const tests = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const run of spec.tests) tests.push({ project: run.projectName, file: spec.file, title: spec.title });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  return { projects: report.config.projects.map((project) => project.name), tests };
}

const count = (tests, filter) => tests.filter(filter).length;

describe('Playwright configurations', () => {
  test('npm run test:e2e runs the installed extension tests alone, once', () => {
    const { projects, tests } = listed('playwright.config.js');

    assert.equal(projects.length, 1);
    assert.ok(tests.length >= 7, `${tests.length} tests`);
    assert.deepEqual([...new Set(tests.map(({ file }) => file))], ['extension.spec.js']);
    assert.equal(new Set(tests.map(({ title }) => title)).size, tests.length);
  });

  test('npm run test:ui runs the popup layout and website tests in both engines', () => {
    const { projects, tests } = listed('playwright.ui.config.js');
    const files = [...new Set(tests.map(({ file }) => path.basename(file)))].sort();

    assert.deepEqual(projects, ['chromium', 'firefox']);
    assert.deepEqual(files, ['popup-layout.spec.js', 'site.spec.js']);
    for (const project of projects) {
      for (const file of files) {
        assert.ok(
          count(tests, (run) => run.project === project && path.basename(run.file) === file) >= 10,
          `${project} runs ${file}`
        );
      }
    }

    // The Firefox build's own states run in Gecko only; everything else in both.
    const firefoxOnly = tests.filter(({ title }) => title.includes('@firefox-build'));
    assert.ok(firefoxOnly.length > 0);
    assert.ok(firefoxOnly.every(({ project }) => project === 'firefox'));
    const shared = (project) => tests
      .filter((run) => run.project === project && !run.title.includes('@firefox-build'))
      .map(({ file, title }) => `${file} › ${title}`)
      .sort();
    assert.deepEqual(shared('chromium'), shared('firefox'));
  });
});
