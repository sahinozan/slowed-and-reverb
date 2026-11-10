'use strict';

// Checks the skills for coding agents (.claude/skills/): that the five are
// there in the form both Claude Code and Codex read, that Codex's folder is
// a link to them and not a second copy, and that what they point at (the
// package's commands, files, headings and the map's commands) is still
// there, so a skill can't go on naming something that has moved.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { readMap } = require('../scripts/classify-ci-changes');
const { matches } = require('../scripts/agent-hooks/generated-files');

const { root } = require('./helpers/load-script');

const SKILLS = '.claude/skills';
const LINK = '.agents/skills';
const NAMES = ['land-dependabot', 'mac-audio-run', 'popup-change', 'release', 'store-assets'];

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { scripts } = JSON.parse(read('package.json'));

// A skill's two parts: what is between the --- lines at its start, as
// names and values, and the text after.
function parts(text) {
  const found = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(found, 'a skill starts with its name and description between two --- lines');
  const fields = found[1].split('\n').map((line) => /^([a-z-]+): (\S.*)$/.exec(line));
  assert.ok(fields.every(Boolean), 'each line between the --- lines is a name, a colon and a value on one line');
  return { fields: Object.fromEntries(fields.map(([, name, value]) => [name, value])), body: found[2] };
}

const skills = NAMES.map((name) => ({ name, file: `${SKILLS}/${name}/SKILL.md`, ...parts(read(`${SKILLS}/${name}/SKILL.md`)) }));

// What a skill names in code: `like this`, and each line of a fenced block.
const named = (body) => [
  ...[...body.matchAll(/```\w*\n([\s\S]*?)```/g)].flatMap((block) => block[1].split('\n')),
  ...[...body.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1])
].map((text) => text.trim()).filter(Boolean);

describe('the skills for coding agents', () => {
  test('are the five, each a folder with one SKILL.md', () => {
    const files = tracked.filter((file) => file.startsWith(`${SKILLS}/`));
    assert.deepEqual(files, NAMES.map((name) => `${SKILLS}/${name}/SKILL.md`));
  });

  test('have the name and description both tools read, and nothing else', () => {
    for (const { name, fields, body } of skills) {
      assert.deepEqual(Object.keys(fields), ['name', 'description'], name);
      // The name is the folder's: lowercase words joined by hyphens.
      assert.equal(fields.name, name);
      assert.match(name, /^[a-z]+(-[a-z]+)*$/);
      // Says what it is for and when to use it, within what the tools show.
      assert.ok(fields.description.length >= 80 && fields.description.length <= 1024, `${name}: ${fields.description.length} characters`);
      assert.match(fields.description, /\bUse when\b/, name);
      // A colon followed by a space would end the value for a stricter reader.
      assert.doesNotMatch(fields.description, /: | #|^["'[{>|*&!%@`-]/, name);
      assert.match(body, /^\n# \S/, name);
    }
  });

  test('reach Codex through one link, not a second copy', () => {
    // Git keeps a link as its target's path. A checkout that can't make
    // links (Windows without Developer Mode) has a file with that path in
    // it, and Codex finds no skills there.
    const entry = execFileSync('git', ['ls-files', '-s', '--', LINK], { cwd: root, encoding: 'utf8' });
    assert.match(entry, /^120000 [0-9a-f]+ 0\t\.agents\/skills\n$/, 'git tracks .agents/skills as a link');
    const full = path.join(root, LINK);
    const target = fs.lstatSync(full).isSymbolicLink() ? fs.readlinkSync(full) : fs.readFileSync(full, 'utf8');
    assert.equal(target, '../.claude/skills');
    assert.deepEqual(tracked.filter((file) => file.startsWith('.agents/')), [LINK]);
  });

  test('name only commands the package has', () => {
    for (const { name, body } of skills) {
      const commands = named(body).flatMap((text) => [...text.matchAll(/\bnpm run ([\w:-]+)/g)].map((match) => match[1]));
      assert.ok(commands.length > 0, name);
      for (const command of commands) assert.ok(scripts[command], `${name}: npm run ${command} is not one of package.json's scripts`);
      // Which checks a change needs is asked of the map, not repeated.
      assert.ok(commands.includes('checks:for'), `${name} doesn't send its reader to npm run checks:for`);
    }
  });

  test('name only files that are there', () => {
    // What a build, a run or a release writes isn't tracked.
    const made = /^(dist|test-results)\//;
    for (const { name, body } of skills) {
      const paths = named(body).filter((text) => /^[\w.*/-]+$/.test(text) && (text.includes('/') || /^[A-Z][A-Z-]*\.md$/.test(text)) && !made.test(text));
      assert.ok(paths.length > 0, name);
      for (const given of paths) {
        const pattern = given.endsWith('/') ? `${given}**` : given;
        assert.ok(tracked.some((file) => matches(pattern, file)), `${name} names ${given}, which isn't in the repository`);
      }
    }
  });

  test('name only headings that are there', () => {
    let count = 0;
    for (const { name, body } of skills) {
      for (const [, file, heading] of body.matchAll(/`([\w./-]+\.md)`\s+\("([^"]+)"\)/g)) {
        count += 1;
        assert.ok(read(file).split('\n').some((line) => /^#{1,6} /.test(line) && line.replace(/^#+ /, '') === heading), `${name}: ${file} has no heading "${heading}"`);
      }
    }
    assert.ok(count >= 5, `only ${count} headings were found to check`);
  });

  test('the audio run uses the map\'s commands, and asks before the one that plays sound', () => {
    const { body } = skills.find(({ name }) => name === 'mac-audio-run');
    const commands = readMap().checks['audio-mac'].run;
    assert.deepEqual(commands, ['AUDIO_REGRESSION_MUTE=1 npm run test:audio:chromium', 'npm run test:audio:firefox']);
    for (const command of commands) assert.ok(named(body).includes(command), command);
    assert.ok(body.indexOf('Ask the owner') !== -1 && body.indexOf('Ask the owner') < body.indexOf('npm run test:audio:firefox\n```'), 'the question comes before the Firefox run');
  });

  test('leave the uploads and the merges to the owner', () => {
    const body = (wanted) => skills.find(({ name }) => name === wanted).body;
    assert.match(body('release'), /Never upload to a store/);
    assert.match(body('store-assets'), /Uploading to a store\s+is the owner's; never do it/);
    assert.match(body('land-dependabot'), /Ask the owner\*\* for permission to merge/);
  });
});
