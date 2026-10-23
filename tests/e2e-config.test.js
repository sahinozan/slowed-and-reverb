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

// Runs playwright test --list, with SLOWED_REVERB_UI_FIREFOX_PLAYBACK set to
// `playback` or, when that's undefined, unset.
function list(config, playback) {
  const env = { ...process.env, CI: '', SLOWED_REVERB_POPUP_HISTORY: '' };
  delete env.SLOWED_REVERB_UI_FIREFOX_PLAYBACK;
  if (playback !== undefined) env.SLOWED_REVERB_UI_FIREFOX_PLAYBACK = playback;
  return spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json', `--config=${config}`], {
    cwd: root,
    encoding: 'utf8',
    env
  });
}

// Each listed test as "project › file › title".
function listed(config, playback) {
  const result = list(config, playback);
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

  // The website tests that need Firefox to play sound. They run in both
  // engines unless CI's Windows job leaves them out of Gecko, and then only
  // they are left out, by name.
  const PLAYBACK_TESTS = [
    "site.spec.js › notices when the popup's choices stop reaching the demo @playback",
    'site.spec.js › the demo plays and pauses, and follows the popup both ways @playback'
  ];
  const named = (tests, project) => tests
    .filter((run) => run.project === project)
    .map(({ file, title }) => `${path.basename(file)} › ${title}`);
  const playbackTests = (tests, project) => named(tests, project).filter((title) => title.includes('@playback')).sort();

  test('npm run test:ui plays the demo in both engines unless told to leave Firefox out', () => {
    for (const playback of [undefined, 'run']) {
      const { tests } = listed('playwright.ui.config.js', playback);
      for (const project of ['chromium', 'firefox']) {
        assert.deepEqual(playbackTests(tests, project), PLAYBACK_TESTS, `${project}, SLOWED_REVERB_UI_FIREFOX_PLAYBACK=${playback}`);
      }
    }
  });

  test('SLOWED_REVERB_UI_FIREFOX_PLAYBACK=omit leaves out only the playing tests, only in Gecko', () => {
    const all = listed('playwright.ui.config.js').tests;
    const omitted = listed('playwright.ui.config.js', 'omit').tests;
    assert.deepEqual(named(omitted, 'chromium').sort(), named(all, 'chromium').sort());
    const left = new Set(named(omitted, 'firefox'));
    const missing = named(all, 'firefox').filter((title) => !left.has(title));
    assert.equal(missing.length, PLAYBACK_TESTS.length, missing.join('\n'));
    assert.deepEqual(playbackTests(omitted, 'firefox'), []);
    assert.equal(left.size, named(all, 'firefox').length - PLAYBACK_TESTS.length);
  });

  test('SLOWED_REVERB_UI_FIREFOX_PLAYBACK takes only "run" or "omit"', () => {
    for (const value of ['', 'skip', 'OMIT']) {
      const result = list('playwright.ui.config.js', value);
      assert.notEqual(result.status, 0, `"${value}" was accepted`);
      assert.match(result.stdout + result.stderr, /SLOWED_REVERB_UI_FIREFOX_PLAYBACK must be "run" or "omit"/);
    }
  });
});
