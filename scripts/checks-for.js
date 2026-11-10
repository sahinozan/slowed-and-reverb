'use strict';

// Prints which checks a change needs, from the map (checks.json): for the
// paths given, or with none for the files changed since the branch left
// origin/main, committed or not (npm run checks:for). docs/checks.md has
// the whole map.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checksFor, readMap, ruleFor } = require('./classify-ci-changes');
const { about, runBy } = require('./render-checks-tables');

const root = path.join(__dirname, '..');

// The files a change touches, in a checkout: what differs from where the
// branch left origin/main, committed, staged or not, a removed or renamed
// file's old path included, and the new files git doesn't track yet.
function changedFiles(directory = root) {
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const base = git('merge-base', 'origin/main', 'HEAD').trim();
  const changed = git('diff', '--no-renames', '--name-only', '-z', base).split('\0');
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0');
  return [...new Set([...changed, ...untracked].filter(Boolean))].sort();
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
  return more > 0 ? `${files.slice(0, most).join(', ')} and ${more} more` : files.join(', ');
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
  let files = paths;
  if (paths.length === 0) {
    try {
      files = changedFiles();
    } catch (error) {
      process.stderr.write(`Couldn't work out what changed against origin/main (${String(error.message).split('\n')[0]}). Give the paths to look up.\n`);
      process.exitCode = 2;
    }
  }
  if (process.exitCode !== 2) process.stdout.write(report(files, readMap()));
}

module.exports = { changedFiles, checksNeeded, report };
