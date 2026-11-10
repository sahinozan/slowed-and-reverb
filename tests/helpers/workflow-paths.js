'use strict';

// For the workflows GitHub starts from their own paths: whether those paths
// are the ones the map (checks.json) gives the workflow's check.

const { execFileSync } = require('node:child_process');
const { checksFor, patternRegExp, ruleFor } = require('../../scripts/classify-ci-changes');

const { root } = require('./load-script');

// The files git tracks, so a file the system leaves in a folder doesn't
// count.
function trackedFiles(folder = '.') {
  return execFileSync('git', ['ls-files', '-z', '--', folder], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

// The paths: of one of a workflow's triggers, as written. It is read
// strictly: the trigger has to be there, with one paths: list of
// single-quoted patterns below it and no paths-ignore:. Anything else
// throws, so a path this didn't see (an item quoted another way, a list
// written on one line) can't start or stop the workflow unnoticed.
function workflowPaths(text, trigger) {
  const lines = text.split('\n');
  const on = lines.indexOf('on:');
  if (on === -1) throw new Error("the workflow has no on: block this can read");
  const after = lines.slice(on + 1);
  const end = after.findIndex((line) => line !== '' && !/^[ #]/.test(line));
  const block = end === -1 ? after : after.slice(0, end);
  const start = block.indexOf(`  ${trigger}:`);
  if (start === -1) throw new Error(`the workflow doesn't start for ${trigger}`);
  // The trigger's own lines: those indented deeper than its key.
  const own = [];
  for (const line of block.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('    ')) break;
    own.push(line);
  }
  if (own.some((line) => /^ {4}paths-ignore\b/.test(line))) throw new Error(`${trigger} has a paths-ignore`);
  const at = own.indexOf('    paths:');
  if (at === -1 || own.filter((line) => /^ {4}paths\b/.test(line)).length !== 1) {
    throw new Error(`${trigger} needs one paths: list, written as a list below its key`);
  }
  const found = [];
  for (const line of own.slice(at + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (!line.startsWith('      ')) break;
    const item = /^ {6}- '([^']+)'$/.exec(line);
    if (!item) throw new Error(`can't read "${line.trim()}" in ${trigger}'s paths`);
    found.push(item[1]);
  }
  if (found.length === 0) throw new Error(`${trigger}'s paths: list is empty`);
  return found;
}

// Where a workflow's paths and the map disagree about a check: in the
// patterns themselves, which have to be the same list, and then file by
// file, read as GitHub reads its path filters. The workflow may run for a
// file the map's documentation rule takes (the audio suite's README, say):
// GitHub can't tell, and such a change doesn't need the check.
function workflowPathProblems(files, filters, map, check) {
  const problems = [];
  const patterns = map.rules.filter((rule) => rule.needs.includes(check)).flatMap((rule) => rule.paths);
  for (const pattern of patterns) {
    if (!filters.includes(pattern)) problems.push(`checks.json gives ${pattern} ${check}, but it isn't in the workflow's paths`);
  }
  for (const filter of filters) {
    if (!patterns.includes(filter)) problems.push(`${filter} is in the workflow's paths, but checks.json doesn't give it ${check}`);
  }
  const matchers = filters.map(patternRegExp);
  for (const file of files) {
    const needs = checksFor(map, file).includes(check);
    const runs = matchers.some((matcher) => matcher.test(file));
    const documentation = ruleFor(map, file)?.paths.includes('**/*.md') ?? false;
    if (needs && !runs) problems.push(`${file} needs ${check}, but the workflow doesn't run for it`);
    if (runs && !needs && !documentation) problems.push(`the workflow runs for ${file}, which doesn't need ${check}`);
  }
  return problems;
}

module.exports = { trackedFiles, workflowPathProblems, workflowPaths };
