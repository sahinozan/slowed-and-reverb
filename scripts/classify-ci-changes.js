'use strict';

// Decides whether a change needs the browser smoke tests, from the map of
// which checks a change needs (checks.json). CI always runs the repository
// checks; this only says whether the browser tests may be skipped.
//
// Reads the changed paths, NUL-separated, on standard input (git diff
// --no-renames --name-only -z, so a rename lists the old path as well as the
// new one) and prints "browser=true" or "browser=false".
//
// CI runs the copies of this file and of the map from the pull request's
// base commit, not the ones in the pull request, so a change can't choose
// its own checks. It first asks this file's copy for its policy version
// (--policy-version); a base commit without this file or the map, or with a
// copy that doesn't answer POLICY_VERSION, has no policy CI can read, so CI
// runs everything. The copies run alone from a temporary folder laid out
// like the repository (this file in scripts/, the map above it), so this
// file can't require other repository files.

const fs = require('node:fs');
const path = require('node:path');

const POLICY_VERSION = '3';
const MAP_FILE = path.join(__dirname, '..', 'checks.json');

// The CI job this file decides. The map names the job of each check CI runs.
const BROWSER_JOB = 'browser-smoke';

const WHO = ['ci', 'workflow', 'hand'];

// A pattern is a path, with * for part of one name, ** for anything, and
// **/ for any folders, none included. GitHub's path filters read these the
// same way; nothing else they allow (?, !, [], {}) is read here.
function patternRegExp(pattern) {
  if (typeof pattern !== 'string' || !/^[\w.*/-]+$/.test(pattern) || /\*{3}|^\/|\/$|\/\/|(^|\/)\.\.?(\/|$)/.test(pattern)) {
    throw new Error(`checks.json: "${pattern}" is not a pattern this map reads`);
  }
  const source = pattern
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return part.replace(/[.\\+?^${}()|[\]]/g, '\\$&');
    })
    .join('');
  // Git allows any character in a path, a newline included.
  return new RegExp(`^${source}$`, 's');
}

function fail(message) {
  throw new Error(`checks.json: ${message}`);
}

function isStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item !== '');
}

// The map, checked, with each rule's patterns ready to match. A map this
// file can't read whole decides nothing: it throws instead.
function readMap(source = fs.readFileSync(MAP_FILE, 'utf8')) {
  const map = JSON.parse(source);
  if (map === null || typeof map !== 'object' || Array.isArray(map)) fail('is not an object');
  const { checks, rules } = map;
  if (checks === null || typeof checks !== 'object' || Array.isArray(checks) || Object.keys(checks).length === 0) fail('has no checks');
  for (const [name, check] of Object.entries(checks)) {
    if (check === null || typeof check !== 'object' || !WHO.includes(check.by)) fail(`check "${name}" doesn't say who runs it (${WHO.join(', ')})`);
    if (typeof check.about !== 'string' || check.about === '') fail(`check "${name}" has no description`);
    if (check.run !== undefined && !isStrings(check.run)) fail(`check "${name}" has commands that aren't text`);
    if ((check.by === 'ci') !== (typeof check.job === 'string' && check.job !== '')) fail(`check "${name}" needs a CI job if, and only if, CI runs it`);
  }
  if (!Array.isArray(rules) || rules.length === 0) fail('has no rules');
  const seen = new Set();
  const read = rules.map((rule, index) => {
    const where = `rule ${index + 1}`;
    if (rule === null || typeof rule !== 'object') fail(`${where} is not an object`);
    if (typeof rule.about !== 'string' || rule.about === '') fail(`${where} has no description`);
    if (!isStrings(rule.paths)) fail(`${where} has no paths`);
    if (!isStrings(rule.needs)) fail(`${where} has no checks`);
    for (const name of rule.needs) {
      if (!Object.hasOwn(checks, name)) fail(`${where} needs "${name}", which is not a check`);
    }
    if (new Set(rule.needs).size !== rule.needs.length) fail(`${where} names a check twice`);
    for (const pattern of rule.paths) {
      if (seen.has(pattern)) fail(`"${pattern}" is in two rules, and only the first would count`);
      seen.add(pattern);
    }
    return { about: rule.about, paths: rule.paths, needs: rule.needs, matchers: rule.paths.map(patternRegExp) };
  });
  return { checks, rules: read };
}

// The first rule that matches a path, or null.
function ruleFor(map, file) {
  return map.rules.find((rule) => rule.matchers.some((matcher) => matcher.test(file))) ?? null;
}

// The checks a path needs: its rule's, or every check CI decides for a path
// no rule matches.
function checksFor(map, file) {
  const rule = ruleFor(map, file);
  if (rule) return rule.needs;
  return Object.keys(map.checks).filter((name) => map.checks[name].by === 'ci');
}

// An empty list means the comparison found nothing, which shouldn't happen
// for a real change, so it runs everything too.
function classifyFiles(files, map = readMap()) {
  const needsBrowser = (file) => checksFor(map, file).some((name) => map.checks[name].job === BROWSER_JOB);
  return { browser: files.length === 0 || files.some(needsBrowser) };
}

function parsePaths(input) {
  return input.split('\0').filter(Boolean);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--policy-version') {
    process.stdout.write(`${POLICY_VERSION}\n`);
  } else if (args.length === 0) {
    const { browser } = classifyFiles(parsePaths(fs.readFileSync(0, 'utf8')));
    process.stdout.write(`browser=${browser}\n`);
  } else {
    process.stderr.write(`Unexpected arguments: ${args.join(' ')}\n`);
    process.exitCode = 2;
  }
}

module.exports = { BROWSER_JOB, POLICY_VERSION, checksFor, classifyFiles, parsePaths, patternRegExp, readMap, ruleFor };
