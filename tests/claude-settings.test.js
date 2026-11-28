'use strict';

// Checks the shared Claude Code settings (.claude/settings.json): that its
// allowed commands are quiet scripts from package.json, that audit exceptions
// still require confirmation, that forbidden commands stay denied, and that
// no CLAUDE.md shadows AGENTS.md.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, test } = require('node:test');

const { root } = require('./helpers/load-script');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('shared Claude Code settings', () => {
  const claude = JSON.parse(read('.claude/settings.json'));

  test('allow only quiet commands of the package, ask before the audit\'s exceptions change, and deny what the rules forbid', () => {
    const { scripts } = JSON.parse(read('package.json'));
    assert.deepEqual(Object.keys(claude), ['permissions']);
    assert.deepEqual(Object.keys(claude.permissions), ['allow', 'ask', 'deny']);
    for (const rule of claude.permissions.allow) {
      // Exact commands only: a trailing * would also allow npm options or
      // arbitrary test files (including the audio suites).
      const name = /^Bash\(npm (test)\)$/.exec(rule)?.[1] ?? /^Bash\(npm run ([\w:-]+)\)$/.exec(rule)?.[1];
      assert.ok(name && scripts[name], `${rule} is not one of package.json's scripts`);
      assert.doesNotMatch(name, /^(test:audio|test:firefox|test:watch|audit|release|icons|store|site:serve)/, rule);
    }
    assert.ok(claude.permissions.allow.includes('Bash(npm run check)') && claude.permissions.allow.includes('Bash(npm test)'));
    assert.deepEqual(claude.permissions.ask, ['Edit(audit-exceptions.json)']);
    assert.ok(tracked.includes('audit-exceptions.json'));
    assert.deepEqual(claude.permissions.deny, [
      'Bash(npm audit fix)',
      'Bash(npm audit fix *)',
      'Bash(git push origin main)',
      'Bash(git push origin main *)',
      'Bash(git push origin HEAD:main)',
      'Bash(git push origin HEAD:main *)'
    ]);
    for (const rule of claude.permissions.deny) assert.match(rule, /^Bash\([^*]+( \*)?\)$/, rule);
  });

  test('no CLAUDE.md is tracked: Claude Code would read it in place of AGENTS.md', () => {
    assert.deepEqual(tracked.filter((file) => /(^|\/)CLAUDE(\.local)?\.md$/i.test(file)), []);
  });
});
