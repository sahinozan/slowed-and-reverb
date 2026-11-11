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
  const names = fields.map(([, name]) => name);
  assert.equal(new Set(names).size, names.length, 'a name is given once');
  return { fields: Object.fromEntries(fields.map(([, name, value]) => [name, value])), body: found[2] };
}

// What a skill's text names in code: `like this`, and each line of a
// fenced block.
const coded = (body) => [
  ...[...body.matchAll(/```\w*\n([\s\S]*?)```/g)].flatMap((block) => block[1].split('\n')),
  ...[...body.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1])
].map((text) => text.trim()).filter(Boolean);

// What a build, a run or a release writes isn't in the repository.
const MADE = /^(dist|test-results)\/|^(summary\.json|environment\.json|summary\.md|firefox-privacy-policy\.txt)$/;
const FILE = /\.(json|js|md|html|css|yml|txt|png|svg|woff2|sh)$/;

const PATH = /^[\w.*/-]+$/;
// The folders at the repository's root.
const FOLDERS = new Set(tracked.filter((file) => file.includes('/')).map((file) => file.split('/')[0]));

// What is wrong with what a skill points at: a command the package
// doesn't have, a file that isn't in the repository, a heading its file
// doesn't have. The description is plain text, so its commands and files
// are found as words. The text after it gives them in code. A piece of
// code that is one path is a file. So is a word of a longer piece, such as
// a command with a comment after it, when it is below one of the
// repository's folders or has a file's ending; a word is what is between
// spaces, without the quotes, brackets and punctuation around it. What
// follows an equals sign may be a file the command makes, so it is a file
// only below one of the folders. Any ./ and .. are taken out of a path
// first, by its spelling alone. A path from the root of the disk, such as
// /dev/null, or to outside the repository isn't looked for. This finds the
// ways a file is usually written in a skill, not every way one can be.
function problems({ fields, body }, has = (file) => fs.existsSync(path.join(root, file))) {
  const found = [];
  const texts = [fields.description, ...coded(body)];
  for (const [, command] of texts.flatMap((text) => [...text.matchAll(/\bnpm run ([\w:-]+)/g)])) {
    if (!Object.hasOwn(scripts, command)) found.push(`npm run ${command} is not one of package.json's scripts`);
  }
  const words = fields.description.match(/[\w.@-]+(?:\/[\w.*-]+)*/g).map((word) => word.replace(/\.$/, ''));
  // A path the repository could hold, with ./ and .. taken out.
  const within = (text) => (PATH.test(text) && !text.startsWith('/') ? [path.posix.normalize(text)] : []).filter((file) => !file.startsWith('../'));
  const whole = [...words, ...coded(body)].flatMap(within).filter((file) => file.includes('/') || FILE.test(file));
  const inside = coded(body).flatMap((text) => text.split(/\s+/)).flatMap((word) => {
    const [last, ...before] = word.split('=').reverse();
    return within(last.replace(/^[(["']+|[)\]"',;:.]+$/g, ''))
      .filter((file) => (file.includes('/') && FOLDERS.has(file.split('/')[0])) || (before.length === 0 && FILE.test(file)));
  });
  for (const given of new Set([...whole, ...inside].filter((file) => !MADE.test(file)))) {
    const pattern = given.endsWith('/') ? `${given}**` : given;
    const there = tracked.filter((file) => matches(pattern, file));
    if (there.length === 0 || (there.length === 1 && there[0] === given && !has(given))) found.push(`${given} isn't in the repository`);
  }
  for (const [, file, heading] of body.matchAll(/`([\w./-]+\.md)`\s+\("([^"]+)"\)/g)) {
    const headings = tracked.includes(file) ? read(file).split('\n').filter((line) => /^#{1,6} /.test(line)).map((line) => line.replace(/^#+ /, '')) : [];
    if (!headings.includes(heading)) found.push(`${file} has no heading "${heading}"`);
  }
  return found;
}

const skills = NAMES.map((name) => ({ name, file: `${SKILLS}/${name}/SKILL.md`, text: read(`${SKILLS}/${name}/SKILL.md`) }))
  .map((skill) => ({ ...skill, ...parts(skill.text) }));
const skill = (wanted) => skills.find(({ name }) => name === wanted);

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
      // A colon followed by a space, or a # after one, would end the
      // value for a stricter reader, and so would these at its start.
      assert.doesNotMatch(fields.description, /: | #|^["'[{>|*&!%@`-]/, name);
      assert.match(body, /^\n# \S/, name);
    }
    // A name given twice, or a value on a line of its own, isn't read.
    const { text } = skill('release');
    assert.throws(() => parts(text.replace('\ndescription: ', '\nname: release\ndescription: ')), /a name is given once/);
    assert.throws(() => parts(text.replace('\ndescription: ', '\ndescription:\n  ')), /on one line/);
    assert.throws(() => parts(text.replace(/^---\n/, '')), /between two --- lines/);
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

  test('name only commands, files and headings that are there', () => {
    for (const each of skills) assert.deepEqual(problems(each), [], each.name);
    // What is looked at: commands, files with and without a folder, and
    // headings, in every skill.
    for (const { name, body } of skills) {
      assert.ok(coded(body).some((text) => /\bnpm run [\w:-]+/.test(text)), name);
      assert.ok(coded(body).some((text) => tracked.includes(text)), name);
    }
    assert.ok(skills.flatMap(({ body }) => [...body.matchAll(/`[\w./-]+\.md`\s+\("[^"]+"\)/g)]).length >= 5);
  });

  test('a skill that names something that isn\'t there is caught', () => {
    const changed = (name, from, to) => {
      const { text } = skill(name);
      assert.ok(text.includes(from), `${name} doesn't have ${from}`);
      return parts(text.replace(from, to));
    };
    const cases = [
      // In the text after the description: a command, a file in a
      // folder, a file at the root, a folder, a pattern, a heading.
      [changed('release', '`npm run checks:for`', '`npm run checks:four`'), "npm run checks:four is not one of package.json's scripts"],
      [changed('release', 'npm run release -- <the commit on main>', 'npm run publish -- <the commit on main>'), "npm run publish is not one of package.json's scripts"],
      [changed('release', '`scripts/version-set.js`', '`scripts/version-sets.js`'), "scripts/version-sets.js isn't in the repository"],
      [changed('land-dependabot', '`audit-exceptions.json`', '`audit-exemptions.json`'), "audit-exemptions.json isn't in the repository"],
      [changed('store-assets', '`store-assets/originals/`', '`store-assets/captures/`'), "store-assets/captures/ isn't in the repository"],
      [changed('release', '`site/*.html`', '`site/*.htm`'), "site/*.htm isn't in the repository"],
      [changed('release', '`AGENTS.md` ("Git")', '`AGENTS.md` ("Merging")'), 'AGENTS.md has no heading "Merging"'],
      [changed('release', '`AGENTS.md` ("Git")', '`docs/git.md` ("Git")'), "docs/git.md isn't in the repository"],
      // A file among the words of a command's line, and a command with
      // the name of something every object has.
      [changed('store-assets', 'marquee, site/assets/og-card.png', 'marquee, site/assets/missing-card.png'), "site/assets/missing-card.png isn't in the repository"],
      [changed('release', 'it runs `npm run check`', 'it runs `npm run constructor`'), "npm run constructor is not one of package.json's scripts"],
      // A file's name is taken as it is spelled, a period after it included.
      [changed('release', '`scripts/version-set.js`', '`scripts/version-set.js.`'), "scripts/version-set.js. isn't in the repository"],
      // A file after ./, in quotes, and below a folder the repository
      // doesn't have.
      [changed('release', '`scripts/version-set.js`', '`node ./scripts/version-sets.js`'), "scripts/version-sets.js isn't in the repository"],
      [changed('release', '`scripts/version-set.js`', '`"scripts/version-sets.js"`'), "scripts/version-sets.js isn't in the repository"],
      [changed('release', '`scripts/version-set.js`', '`node script/version-set.js`'), "script/version-set.js isn't in the repository"],
      // After an equals sign, and in square brackets.
      [changed('release', '`scripts/version-set.js`', '`node --require=./scripts/version-sets.js`'), "scripts/version-sets.js isn't in the repository"],
      [changed('release', '`scripts/version-set.js`', '`cat [scripts/version-sets.js]`'), "scripts/version-sets.js isn't in the repository"],
      // In the description, where they are plain words.
      [changed('land-dependabot', 'package.json and package-lock.json', 'package.json and package-locks.json'), "package-locks.json isn't in the repository"],
      [changed('popup-change', '(extension/settings.js).', '(extension/setting.js).'), "extension/setting.js isn't in the repository"],
      [changed('release', 'with npm run release,', 'with npm run publish,'), "npm run publish is not one of package.json's scripts"]
    ];
    for (const [changedSkill, problem] of cases) assert.ok(problems(changedSkill).includes(problem), `${problem}: ${problems(changedSkill).join('; ')}`);
    // A command may send what it prints somewhere, and the comment after
    // it may have a slash or a period, without either being a file here.
    const command = 'git fetch\nnpm run check > /dev/null 2>&1   # pass/fail only (see ./notes, or ~/logs/check.log).\n';
    assert.deepEqual(problems(changed('release', 'git fetch\n', command)), []);
    // A file may be reached through ./ and .., a path from the root of the
    // disk or to outside the repository isn't the repository's, and a
    // command may name the file it writes after an equals sign.
    for (const code of ['node --check ././scripts/version-set.js', 'node --check ./scripts/../scripts/version-set.js', '././scripts/version-set.js', '/dev/null', 'cat ../notes.txt', '../notes.txt', 'node --test --test-reporter-destination=results.txt tests/agent-skills.test.js']) {
      assert.deepEqual(problems(changed('release', '`scripts/version-set.js`', `\`${code}\``)), [], code);
    }
    // A file git still lists that is gone from the folder.
    assert.deepEqual(problems(skill('release'), (file) => file !== 'scripts/release.js'), ["scripts/release.js isn't in the repository"]);
  });

  test('send their reader to npm run checks:for for which checks a change needs', () => {
    for (const { name, body } of skills) assert.ok(coded(body).some((text) => /^npm run checks:for\b/.test(text)), name);
  });

  test('the audio run uses the map\'s commands, and asks before the one that plays sound', () => {
    const { body } = skill('mac-audio-run');
    const commands = readMap().checks['audio-mac'].run;
    assert.deepEqual(commands, ['AUDIO_REGRESSION_MUTE=1 npm run test:audio:chromium', 'npm run test:audio:firefox']);
    for (const command of commands) assert.ok(coded(body).includes(command), command);
    assert.ok(body.indexOf('Ask the owner') !== -1 && body.indexOf('Ask the owner') < body.indexOf('npm run test:audio:firefox\n```'), 'the question comes before the Firefox run');
  });

  test('leave the uploads and the merges to the owner', () => {
    assert.match(skill('release').body, /Never upload to a store/);
    assert.match(skill('store-assets').body, /Uploading to a store\s+is the owner's; never do it/);
    assert.match(skill('land-dependabot').body, /Ask the owner\*\* for permission to merge/);
  });
});
