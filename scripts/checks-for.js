'use strict';

// Prints which checks a change needs, from the map (checks.json): for the
// paths given, or with none for the files changed since the branch left
// origin/main, committed or not (npm run checks:for). docs/checks.md has
// the whole map.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checksFor, readMap, ruleFor } = require('./classify-ci-changes');
const { about, runBy } = require('./render-checks-tables');

const root = path.join(__dirname, '..');

// The files a change touches, in a checkout: what the branch's commits
// changed since it left origin/main, which is what CI looks at, and on top
// of that what is staged, what is changed and not staged, and the new files
// git doesn't track yet. A removed or renamed file's old path is included.
// Each is listed by itself, so a committed change undone in the working
// tree still counts: CI would still see it.
function changedFiles(directory = root, env = process.env) {
  const git = (...args) => execFileSync('git', args, { cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const names = (...args) => git('diff', '--no-renames', '--name-only', '-z', ...args).split('\0');
  const base = git('merge-base', 'origin/main', 'HEAD').trim();
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0');
  return [...new Set([...names(base, 'HEAD'), ...names('--cached'), ...names(), ...untracked].filter(Boolean))].sort();
}

// The paths given on the command line as the map knows them: from the
// repository's root, with forward slashes. A folder stands for the tracked
// files in it. A path outside the repository is refused.
function repositoryPaths(paths, directory = process.cwd()) {
  return paths.flatMap((given) => {
    const full = path.resolve(directory, given);
    const file = path.relative(root, full).split(path.sep).join('/');
    if (file === '..' || file.startsWith('../') || path.isAbsolute(file)) throw new Error(`${shown(given)} is outside the repository`);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      const tracked = execFileSync('git', ['ls-files', '-z', '--', full], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return tracked.split('\0').filter(Boolean);
    }
    return [file];
  });
}

// A file's name as printed: as it is when it is plain, and otherwise in
// quotes with anything that could pass for another line or steer a
// terminal written out, so a name can't be taken for part of the report.
function shown(file) {
  if (/^[\w./@+-]+$/.test(file)) return file;
  return JSON.stringify(file).replace(/[\u007f-\u009f\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// The checks these files need, in the map's order, each with the files
// that need it, and the files no rule names.
function checksNeeded(files, map) {
  return {
    needed: Object.keys(map.checks)
      .map((name) => ({ name, files: files.filter((file) => checksFor(map, file).includes(name)) }))
      .filter((check) => check.files.length > 0),
    unknown: files.filter((file) => ruleFor(map, file) === null)
  };
}

// A few files by name, and how many more.
function some(files, most = 4) {
  const more = files.length - most;
  const names = files.map(shown);
  return more > 0 ? `${names.slice(0, most).join(', ')} and ${more} more` : names.join(', ');
}

// What to print for these files.
function report(files, map) {
  if (files.length === 0) return 'No files to look up.\n';
  const { needed, unknown } = checksNeeded(files, map);
  const plain = (text) => text;
  const lines = [`${files.length === 1 ? 'This file needs' : `These ${files.length} files need`}:`, ''];
  for (const { name, files: needing } of needed) {
    const check = map.checks[name];
    lines.push(`${name}: ${runBy(map, name, plain)}`);
    for (const command of check.run ?? []) lines.push(`  ${command}`);
    lines.push(`  ${about(check, plain)}`);
    if (needing.length < files.length) lines.push(`  For ${some(needing)}.`);
    lines.push('');
  }
  if (unknown.length > 0) {
    lines.push(`No rule in checks.json names ${some(unknown)}, so CI runs every check it decides for ${unknown.length === 1 ? 'it' : 'them'}. Add a rule.`, '');
  }
  return lines.join('\n');
}

if (require.main === module) {
  const paths = process.argv.slice(2);
  let files;
  try {
    files = paths.length > 0 ? repositoryPaths(paths) : null;
  } catch (error) {
    process.stderr.write(`${error.message}.\n`);
    process.exitCode = 2;
  }
  if (files === null) {
    try {
      files = changedFiles();
    } catch (error) {
      process.stderr.write(`Couldn't work out what changed against origin/main (${String(error.message).split('\n')[0]}). Give the paths to look up.\n`);
      process.exitCode = 2;
    }
  }
  if (process.exitCode !== 2) process.stdout.write(report(files, readMap()));
}

module.exports = { changedFiles, checksNeeded, report, repositoryPaths, shown };
