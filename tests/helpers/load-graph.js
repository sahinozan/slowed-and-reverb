'use strict';

// What a package command loads: the files it runs or hands to a test
// runner, through the commands it runs with npm run, and every local module
// those require. Files read as data (the extension's, the website's) aren't
// followed; they have rules of their own in checks.json.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { root } = require('./load-script');

const relative = (file) => path.relative(root, file).split(path.sep).join('/');

// The test files a Playwright configuration runs, as Playwright itself
// lists them (playwright test --list, which starts no browser).
function playwrightTestFiles(config) {
  const cli = require.resolve('@playwright/test/cli');
  const env = { ...process.env, CI: '', SLOWED_REVERB_POPUP_HISTORY: '' };
  delete env.SLOWED_REVERB_UI_FIREFOX_PLAYBACK;
  const result = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json', `--config=${config}`], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  if (result.status !== 0) throw new Error(`playwright couldn't list ${config}'s tests: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  return [...new Set(report.suites.map((suite) => relative(path.join(report.config.rootDir, suite.file))))];
}

// The repository's files a package command names, in the order it runs
// them: the scripts it runs with node, the test files it gives node --test,
// and for Playwright its configuration and the test files that finds.
function commandFiles(scripts, name, listTests = playwrightTestFiles, seen = new Set()) {
  if (seen.has(name) || typeof scripts[name] !== 'string') return [];
  seen.add(name);
  return scripts[name]
    .split('&&')
    .map((part) => part.trim())
    .flatMap((part) => {
      const run = /^npm run ([\w:-]+)/.exec(part);
      if (run) return commandFiles(scripts, run[1], listTests, seen);
      if (/^playwright test\b/.test(part)) {
        const config = /--config=(\S+)/.exec(part)?.[1] ?? 'playwright.config.js';
        return [config, ...listTests(config)];
      }
      return [...part.matchAll(/(?:^|\s)((?:scripts|e2e)\/[\w./-]+\.js)\b/g)].map((match) => match[1]);
    });
}

// These files and every local module reached from them through require().
// `read` gives a file's text, or null when there is no such file.
function requireClosure(entries, read = (file) => (fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null)) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    const source = read(file);
    if (source === null) return;
    seen.add(file);
    for (const [, request] of source.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
      let target = relative(path.resolve(path.dirname(path.join(root, file)), request));
      if (!/\.(?:js|json)$/.test(target)) target += '.js';
      visit(target);
    }
  };
  for (const entry of entries) visit(entry);
  return [...seen];
}

module.exports = { commandFiles, playwrightTestFiles, requireClosure };
