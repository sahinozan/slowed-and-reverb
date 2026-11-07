'use strict';

// scripts/check-whitespace.js, which npm run lint runs: the same check as
// CI's git diff --check, over every tracked file in the working tree.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test } = require('node:test');

const script = path.join(__dirname, '..', 'scripts', 'check-whitespace.js');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

// A throwaway repository holding `files`, all tracked unless listed in
// `untracked`.
function repository(t, files, untracked = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whitespace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const tracked = Object.keys(files).filter((name) => !untracked.includes(name));
  if (tracked.length > 0) git(dir, 'add', '--', ...tracked);
  return dir;
}

function check(cwd) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

describe('whitespace check', () => {
  test('passes clean tracked files', (t) => {
    assert.equal(check(repository(t, { 'a.js': 'const a = 1;\n' })).status, 0);
  });

  test('fails trailing spaces in a tracked file, even before it is staged again', (t) => {
    const dir = repository(t, { 'a.js': 'const a = 1;\n' });
    fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1; \n');
    const result = check(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /a\.js:1: trailing whitespace/);
  });

  test('fails a blank line at the end of a file', (t) => {
    const result = check(repository(t, { 'a.md': 'Text\n\n' }));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /a\.md:\d+: new blank line at EOF/);
  });

  test('leaves out untracked files and files marked -whitespace', (t) => {
    const dir = repository(t, {
      '.gitattributes': 'LICENSE.txt -whitespace\n',
      'LICENSE.txt': 'Kept as published. \n',
      'notes/draft.md': 'Local note. \n'
    }, ['notes/draft.md']);
    const result = check(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});
