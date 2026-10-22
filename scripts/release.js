'use strict';

// Builds and checks the store upload packages for a release, then records them
// in dist/packages/<version>/ of the main checkout (AGENTS.md, "Releases"):
//
//   npm run release -- <commit on main> [--out <folder>]
//
// It works in a clean worktree of the commit, runs every check one at a time
// (the browser tests are timing-sensitive, so run nothing else meanwhile),
// checks that the packages are exactly what the commit builds, and writes a
// draft RELEASE-<version>.txt to finish by hand, with each check's log in
// logs/. The Node tests' results come from a second reporter
// (scripts/node-test-results.js) writing to its own file in logs/, not from
// their printed output, which the tests' own output can interrupt. It never
// replaces an existing version folder. Needs macOS or Linux, Chromium for
// Playwright and Firefox.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { FORMAT: RESULTS_FORMAT } = require('./node-test-results');

const root = path.join(__dirname, '..');
const TARGETS = ['chromium', 'firefox'];
const EXTENSION_NAME = 'Slowed & Reverb';
// The Chrome Web Store summary is the manifest's description.
const DESCRIPTION_LIMIT = 132;
// The raw screen captures are large and the build doesn't use them.
const SOURCE_PATHSPEC = ['.', ':(exclude)store-assets/originals'];
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
// How long a stopped step and what it started get to exit before being killed.
const STOP_GRACE_MS = 10000;
const INTERRUPTED = 'Stopped; nothing was recorded.';

// Firefox Add-ons shows the privacy policy as Markdown that drops headings and
// keeps only http(s) links, so its copy of PRIVACY.md has no title, section
// headings as bold lines, one line per paragraph and list item, and email
// links as plain text.
function firefoxPrivacyText(markdown) {
  const lines = markdown.split(/\r?\n/);
  if (/^#\s/.test(lines[0])) lines.shift();

  const blocks = [];
  let open = null;
  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      open = null;
    } else if (/^#{2,6}\s/.test(line)) {
      blocks.push({ kind: 'heading', text: `**${text.replace(/^#+\s+/, '')}**` });
      open = null;
    } else if (line.startsWith('- ')) {
      if (open?.kind !== 'list') {
        open = { kind: 'list', items: [] };
        blocks.push(open);
      }
      open.items.push(text);
    } else if (open?.kind === 'list') {
      open.items[open.items.length - 1] += ` ${text}`;
    } else if (open?.kind === 'paragraph') {
      open.text += ` ${text}`;
    } else {
      open = { kind: 'paragraph', text };
      blocks.push(open);
    }
  }

  const output = blocks
    .map((block, index) => {
      const text = block.kind === 'list' ? block.items.join('\n') : block.text;
      // A heading sits directly above its paragraph but keeps a blank line
      // before a list.
      const joined = block.kind === 'heading' && blocks[index + 1]?.kind === 'paragraph';
      return text + (joined ? '\n' : '\n\n');
    })
    .join('')
    .trimEnd();
  return `${output.replace(/\[([^\]]+@[^\]]+)\]\(mailto:[^)]+\)/g, '$1')}\n`;
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  return left.map((part, index) => part - right[index]).find((difference) => difference !== 0) ?? 0;
}

// The newest release folder older than version, or null.
function previousVersion(folders, version) {
  return (
    folders
      .filter((name) => parseVersion(name) && compareVersions(name, version) < 0)
      .sort(compareVersions)
      .pop() ?? null
  );
}

function versionsIn(text) {
  return text?.match(/\d+\.\d+\.\d+/g) ?? [];
}

// What a version bump touches (AGENTS.md, "Releases") that still shows
// another version. read(file) returns a file's text from the repository root.
function versionBumpProblems(read, pages, version) {
  const problems = [];
  const expect = (ok, problem) => {
    if (!ok) problems.push(problem);
  };

  const packageJson = JSON.parse(read('package.json'));
  expect(packageJson.version === version, `package.json has version ${packageJson.version}`);
  const lock = JSON.parse(read('package-lock.json'));
  expect(
    lock.version === version && lock.packages?.['']?.version === version,
    'package-lock.json has another version in its root entries'
  );
  for (const file of [
    'extension/content.js',
    'extension/spotify-bridge.js',
    'extension/spotify-main.js',
    'extension/youtube-main.js'
  ]) {
    const literal = /const VERSION = '([^']*)';/.exec(read(file));
    expect(literal?.[1] === version, `${file} has VERSION ${literal?.[1]}`);
  }
  for (const page of pages) {
    expect(
      read(`site/${page}`).includes(`<span>Slowed &amp; Reverb ${version}</span>`),
      `site/${page} doesn't show ${version} in its footer`
    );
  }
  expect(read('site/changelog.html').includes(`<h2>${version} `), `site/changelog.html has no entry for ${version}`);
  const policy = /applies to versions ([\s\S]*?) of the/.exec(read('PRIVACY.md'))?.[1];
  expect(versionsIn(policy).includes(version), `PRIVACY.md's versions line doesn't list ${version}`);
  const page = /covers versions ([\s\S]*?) of Slowed/.exec(read('site/privacy.html'))?.[1];
  expect(versionsIn(page).includes(version), `site/privacy.html's versions line doesn't list ${version}`);
  return problems;
}

// "17 (16 files plus the assets directory entry)" for entries of
// { name, isDirectory }.
function describeEntries(entries) {
  const directories = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name.replace(/\/$/, ''));
  if (directories.length === 0) return String(entries.length);
  const files = entries.length - directories.length;
  const noun = directories.length === 1 ? 'entry' : 'entries';
  return `${entries.length} (${files} files plus the ${listWords(directories)} directory ${noun})`;
}

function listWords(words) {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// Word-wraps a paragraph to the record's width; later lines get the indent.
function wrap(text, indent = '', width = 78) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const prefix = lines.length ? indent : '';
    if (line && (prefix + line + ' ' + word).length > width) {
      lines.push(prefix + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push((lines.length ? indent : '') + line);
  return lines.join('\n');
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function inventoryLine(release) {
  const { previous, inventory } = release;
  if (!previous) return 'Archive inventories: no earlier release folder to compare with';
  if (!inventory.added.length && !inventory.removed.length) {
    return `Archive inventories: the same ${inventory.files} files as ${previous}`;
  }
  const changes = [
    inventory.added.length && `added since ${previous}: ${inventory.added.join(', ')}`,
    inventory.removed.length && `removed since ${previous}: ${inventory.removed.join(', ')}`
  ].filter(Boolean);
  return `Archive inventories: ${inventory.files} files; ${changes.join('; ')} (TODO: say why)`;
}

function changedLine(release) {
  const { previous, changed } = release;
  const [chromium, firefox] = TARGETS.map((target) => changed[target]);
  const describe = (files) =>
    files.length ? `${listWords(files)} ${files.length === 1 ? 'differs' : 'differ'}` : 'nothing differs';
  if (chromium.join() === firefox.join()) {
    return `Compared with the ${previous} archives, ${describe(chromium)}, in both packages`;
  }
  return `Compared with the ${previous} archives: in the Chromium package ${describe(chromium)}; in the Firefox package ${describe(firefox)}`;
}

// How the lines of one text differ from another's, from a longest common
// subsequence of their lines: lines changed in place (by their new text), added
// and removed, leaving out blank lines. Moved lines count as removed and added.
function lineChanges(before, after) {
  const changes = { same: before === after, changed: [], added: [], removed: [] };
  const [a, b] = [before.split('\n'), after.split('\n')];
  const common = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }

  let [removed, added] = [[], []];
  const settle = () => {
    const paired = Math.min(removed.length, added.length);
    changes.changed.push(...added.slice(0, paired));
    changes.added.push(...added.slice(paired));
    changes.removed.push(...removed.slice(paired));
    [removed, added] = [[], []];
  };
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      settle();
      i += 1;
      j += 1;
    } else if (j === b.length || (i < a.length && common[i + 1][j] >= common[i][j + 1])) {
      if (a[i]) removed.push(a[i]);
      i += 1;
    } else {
      if (b[j]) added.push(b[j]);
      j += 1;
    }
  }
  settle();
  return changes;
}

function privacyNote(release) {
  const { previous, privacyChanges: changes } = release;
  if (!changes) return '';
  if (changes.same) return ` It is the same as the ${previous} copy.`;
  const starts = (lines) => listWords(lines.map((line) => `"${line.split(' ').slice(0, 6).join(' ')}…"`));
  const parts = ['changed', 'added', 'removed']
    .filter((kind) => changes[kind].length)
    .map((kind) => `${plural(changes[kind].length, 'line')} ${kind} (${starts(changes[kind])})`);
  if (!parts.length) return ` It differs from the ${previous} copy only in blank lines.`;
  return ` Compared with the ${previous} copy, ${listWords(parts)}.`;
}

function packageBlock(file, purpose, info) {
  return [
    `${file}  (${purpose})`,
    `Size: ${info.size} bytes`,
    `SHA-256: ${info.sha256}`,
    `Entries: ${info.entries}`
  ].join('\n');
}

// The draft RELEASE-<version>.txt, in the shape of the earlier records.
function releaseRecord(release) {
  const { version, previous, checks } = release;
  const merged = release.mergedSince?.length
    ? `TODO (merged since ${previous}: PR ${release.mergedSince.map((number) => `#${number}`).join(', ')})`
    : 'TODO';
  const lint = checks.lint;
  const verification = [
    `npm run check: passed (${checks.tests} tests; Chromium lint; Firefox build and lint)`,
    `npm run test:e2e: ${checks.e2e} passed (the real extension in Chromium)`,
    `npm run test:firefox: ${checks.firefox} passed (the Firefox build in the installed Firefox)`,
    `Both manifests: version ${version}, name "${EXTENSION_NAME}", ${checks.descriptionLength}-character description`,
    'Extracted Chromium archive: byte-identical to a fresh build of this commit',
    `Extracted Firefox archive: byte-identical to a fresh build of this commit; web-ext lint: ${plural(lint.errors, 'error')}, ${plural(lint.warnings, 'warning')}, ${plural(lint.notices, 'notice')}`,
    inventoryLine(release),
    previous && changedLine(release),
    'Firefox build from the extracted source zip: byte-identical to the packaged add-on',
    'Tracked worktree remained clean after packaging and verification',
    'TODO: what was checked by hand, in which browsers and on which sites'
  ].filter(Boolean);

  return [
    [
      `${EXTENSION_NAME} ${version} release artifact record`,
      `Date: ${release.date}`,
      `Source commit: ${release.commit} (${release.commitNote})`,
      wrap(`Release changes merged in: ${merged}`),
      wrap(`Built in a clean worktree of that commit with no local changes, with Node ${release.node} and npm ${release.npm}.`)
    ].join('\n'),
    packageBlock('slowed-reverb-chromium.zip', 'upload to the Chrome Web Store', release.packages.chromium),
    packageBlock('slowed-reverb-firefox.zip', 'upload to Firefox Add-ons', release.packages.firefox),
    [
      packageBlock(
        'slowed-reverb-firefox-source.zip',
        'source code for the Firefox review, if asked',
        release.packages.source
      ),
      `Made with: git archive --format=zip HEAD -- ${SOURCE_PATHSPEC.map((spec) => (spec === '.' ? spec : `'${spec}'`)).join(' ')}`,
      "(the raw 5K screen captures are left out; the build doesn't use them)",
      'Build: npm ci, then npm run build:firefox (output in dist/firefox)'
    ].join('\n'),
    [
      'firefox-privacy-policy.txt  (paste into Manage Authors & License → Privacy Policy)',
      wrap(
        'Made from PRIVACY.md: the title dropped, section headings as bold lines, each ' +
          'paragraph and list item on one line, and the support email as plain text, ' +
          `since Firefox keeps only http(s) links.${privacyNote(release)}`
      )
    ].join('\n'),
    ['Verification', ...verification.map((line) => wrap(`- ${line}`, '  '))].join('\n'),
    wrap(
      `These files live in dist/packages/${version}/ because npm test rebuilds ` +
        'dist/packages/*.zip, and the zips record file times, so a rebuild changes the ' +
        'SHA-256 even when the contents are the same. Upload the files in this folder; ' +
        'logs/ holds the output of each check and is not for upload. ' +
        'Do not rebuild them without repeating verification and replacing this record.'
    )
  ].join('\n\n') + '\n';
}

// Running the release ---------------------------------------------------------

class ReleaseError extends Error {
  constructor(message, log) {
    super(message);
    this.log = log;
  }
}

let running = null;
let stopping = null;

// Each step runs as from a plain shell, without this npm run's settings.
function childEnv() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key) && key !== 'INIT_CWD')
  );
  env.PATH = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => !dir.includes(`${path.sep}node_modules${path.sep}`))
    .join(path.delimiter);
  return env;
}

function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Sends a signal to a step's process group.
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

// Whether a process, or with a negative pid a process group, is still
// running. A process that has ended but hasn't been reaped yet (a zombie, as
// orphans stay in Linux containers whose init doesn't reap them) doesn't count.
function stillRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  try {
    return execFileSync('ps', ['-A', '-o', `${pid < 0 ? 'pgid' : 'pid'}=,stat=`], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .some(([id, stat]) => Number(id) === Math.abs(pid) && stat && !stat.startsWith('Z'));
  } catch {
    return true;
  }
}

// Waits until nothing in the group is running, and kills what is left after
// the grace period.
async function endGroup(pid, graceMs) {
  const killAt = Date.now() + graceMs;
  const giveUpAt = killAt + 5000;
  while (stillRunning(-pid) && Date.now() < giveUpAt) {
    if (Date.now() >= killAt) signalGroup(pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Asks the running step's whole process group to stop. If the step itself
// doesn't exit within its grace period, the group is killed.
function stopRunning(reason, signal = 'SIGTERM') {
  stopping ??= reason;
  if (!running) return;
  signalGroup(running.pid, signal);
  const { pid } = running;
  running.killTimer ??= setTimeout(() => signalGroup(pid, 'SIGKILL'), running.graceMs);
}

// Runs a command in its own process group, so a timeout or Ctrl+C also stops
// the browsers and test runners it starts, and nothing it started outlives
// it. Output goes to log.
function run(command, args, { cwd, log, stdout = log, graceMs = STOP_GRACE_MS }) {
  const what = `${command} ${args.join(' ')}`;
  if (stopping) return Promise.reject(new ReleaseError(stopping));
  return new Promise((resolve, reject) => {
    const out = fs.openSync(stdout, 'a');
    const err = fs.openSync(log, 'a');
    const child = spawn(command, args, { cwd, env: childEnv(), stdio: ['ignore', out, err], detached: true });
    const step = { pid: child.pid, graceMs, killTimer: null };
    running = step;
    const timer = setTimeout(
      () => stopRunning(`${what} took more than ${STEP_TIMEOUT_MS / 60000} minutes`),
      STEP_TIMEOUT_MS
    );
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(step.killTimer);
      running = null;
      fs.closeSync(out);
      fs.closeSync(err);
      // After Ctrl+C the log only shows the tests being cancelled.
      if (error) reject(new ReleaseError(stopping ?? error, stopping === INTERRUPTED ? undefined : log));
      else resolve(fs.readFileSync(log, 'utf8'));
    };
    child.on('error', (error) => finish(`${command}: ${error.message}`));
    child.on('exit', (code, signal) => {
      const failure = code === 0 && !stopping ? null : `${what} failed (${signal ?? `exit code ${code}`})`;
      if (!stillRunning(-child.pid)) return finish(failure);
      signalGroup(child.pid, 'SIGTERM');
      endGroup(child.pid, graceMs).then(() => finish(failure));
    });
  });
}

function count(log, pattern) {
  const match = pattern.exec(log);
  return match ? Number(match[1]) : 0;
}

// What the release runs of npm run check and npm run test:firefox. node --test
// reads options only before the files it's given, and npm run check passes no
// arguments on, so the release runs the parts of these scripts itself to add
// the results reporter, and stops if the scripts no longer match.
const TEST_SCRIPTS = {
  check: 'npm run lint && npm test && npm run lint:firefox',
  test: 'node --test --test-concurrency=1',
  'test:firefox': 'npm run build:firefox && node --test e2e/firefox-shutdown.js'
};

// node --test's options for the usual printed report, in the log, and the
// results from scripts/node-test-results.js, in file.
function resultsReporter(file) {
  return [
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${path.join(__dirname, 'node-test-results.js')}`,
    `--test-reporter-destination=${file}`
  ];
}

// The results file of a node --test run (scripts/node-test-results.js). A
// release needs every test and suite to have passed: none failed, was
// cancelled, skipped or left to do. The run's summary leaves some of these
// out, such as a skipped suite's tests or a to-do suite that failed before its
// tests were registered, so each result is checked, and the counts are only
// reported. The only skips in the suites are for Windows, which the release
// doesn't run on, so none are allowed.
//
// Every test file must also have finished. A file that exits early has no
// summary of its own, and the tests it hadn't finished report nothing, so the
// run's summary, which counts every result from every file (and a file that
// reported none as a test of its own), must be what the files' summaries add
// up to. A result can't say which file ran it: its file is where test() was
// called, and a test file may import another's tests. So a test file with no
// tests or suites of its own, such as an empty one or one with only hooks, is
// rejected as unfinished too, though node --test passes it; an empty suite is
// a result of its own and passes.
const CANCELLED = new Set(['cancelledByParent', 'testTimeoutFailure']);
const COUNTS = ['tests', 'suites', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'topLevel'];

function nodeTestResults(file) {
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing, empty or cut short.
  }
  if (report?.format !== RESULTS_FORMAT || !Array.isArray(report.results) || !Array.isArray(report.summaries)) {
    return { counts: null, problems: ['no complete results file'] };
  }
  const { results, summaries } = report;
  const runSummaries = summaries.filter((summary) => summary.file === null);
  if (runSummaries.length !== 1) return { counts: null, problems: [`${runSummaries.length} run summaries`] };
  const { counts, success } = runSummaries[0];

  const problems = [];
  const names = (items, name) => {
    const shown = items.slice(0, 3).map(name);
    return listWords(items.length > 3 ? [...shown, `${items.length - 3} more`] : shown);
  };
  const expect = (kind, failing) => {
    if (failing.length) problems.push(`${failing.length} ${kind} (${names(failing, (result) => `${result.type} "${result.name}"`)})`);
  };
  expect('failed', results.filter((result) => !result.passed && !CANCELLED.has(result.failureType)));
  expect('cancelled', results.filter((result) => !result.passed && CANCELLED.has(result.failureType)));
  expect('skipped', results.filter((result) => result.skip !== false));
  expect('to-do', results.filter((result) => result.todo !== false));

  const tests = results.filter((result) => result.type === 'test');
  const suites = results.filter((result) => result.type === 'suite');
  const passed = tests.filter((result) => result.passed && result.skip === false && result.todo === false);
  if (!passed.length) problems.push('no tests passed');
  if (counts?.tests !== tests.length || counts?.suites !== suites.length || counts?.passed !== passed.length) {
    problems.push("a summary that doesn't match the results");
  }
  if (success !== true) problems.push('a summary that says the run failed');

  const files = summaries.filter((summary) => summary.file !== null);
  const inFiles = (key) => files.reduce((sum, summary) => sum + summary.counts?.[key], 0);
  const unfinished = COUNTS.find((key) => inFiles(key) !== counts?.[key]);
  if (unfinished) {
    problems.push(`results from a test file that didn't finish (${unfinished}: ${counts?.[unfinished]} in the run, ${inFiles(unfinished)} in the files' summaries)`);
  }
  return { counts, problems };
}

// The release's npm run check and npm run test:firefox (TEST_SCRIPTS), as
// steps. inTree(name, command, args) runs a command in the release's worktree
// with its output in logs/<name>.log, and each results file is new in logs/,
// so a run that writes none leaves none to read.
async function runCheck({ inTree, logs, checks }) {
  const results = path.join(logs, 'check-results.json');
  await inTree('check', 'npm', ['run', 'lint']);
  await inTree('check', 'npm', ['test', '--', ...resultsReporter(results)]);
  const { counts, problems } = nodeTestResults(results);
  if (problems.length) {
    throw new ReleaseError(`npm test didn't pass every test: ${problems.join('; ')}`, path.join(logs, 'check.log'));
  }
  await inTree('check', 'npm', ['run', 'lint:firefox']);
  checks.tests = counts.tests;
  return `passed, ${counts.tests} tests`;
}

async function runFirefoxTests({ inTree, logs, checks }) {
  const results = path.join(logs, 'firefox-results.json');
  await inTree('firefox', 'npm', ['run', 'build:firefox']);
  // node --test reads options only before the files it's given.
  await inTree('firefox', 'node', ['--test', ...resultsReporter(results), 'e2e/firefox-shutdown.js']);
  const { counts, problems } = nodeTestResults(results);
  if (problems.length) {
    throw new ReleaseError(`The Firefox tests didn't all pass: ${problems.join('; ')}`, path.join(logs, 'firefox.log'));
  }
  checks.firefox = counts.passed;
  return `${counts.passed} passed`;
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(file, base) : [path.relative(base, file).split(path.sep).join('/')];
  });
}

// Differences between two folders' files, as diff -r would report them.
function compareTrees(left, right) {
  const leftFiles = new Set(listFiles(left));
  const rightFiles = new Set(listFiles(right));
  const differences = [];
  for (const file of leftFiles) {
    if (!rightFiles.has(file)) differences.push(`only in ${left}: ${file}`);
    else if (!fs.readFileSync(path.join(left, file)).equals(fs.readFileSync(path.join(right, file)))) {
      differences.push(`differs: ${file}`);
    }
  }
  for (const file of rightFiles) {
    if (!leftFiles.has(file)) differences.push(`only in ${right}: ${file}`);
  }
  return differences;
}

function expectSameTree(left, right, what) {
  const differences = compareTrees(left, right);
  if (differences.length) throw new ReleaseError(`${what}:\n  ${differences.join('\n  ')}`);
}

function zipFiles(zipPath) {
  return new Map(
    new AdmZip(zipPath)
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => [entry.entryName, entry.getData()])
  );
}

// Writes the release folder's files, each { from: path } or { text }, under
// names that may include a subfolder ("logs/check.log"). The files go into a
// hidden folder next to it first, so a failure leaves no partial version
// folder. The folder must not exist yet: nothing already there is replaced,
// even when it appeared while the checks ran. rename() would replace an empty
// folder, so once the files are written, mkdir claims the name, failing if
// anything has it, and the hidden folder is renamed onto the empty folder
// this made.
function writeReleaseFolder(outDir, files) {
  const appeared = () => new ReleaseError(`${outDir} appeared while the checks ran. Nothing was written to it.`);
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  if (fs.existsSync(outDir)) throw appeared();
  const staging = fs.mkdtempSync(path.join(path.dirname(outDir), `.${path.basename(outDir)}.incomplete-`));
  try {
    for (const [name, file] of Object.entries(files)) {
      const target = path.join(staging, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if ('from' in file) fs.copyFileSync(file.from, target, fs.constants.COPYFILE_EXCL);
      else fs.writeFileSync(target, file.text, { flag: 'wx' });
    }
    try {
      fs.mkdirSync(outDir);
    } catch (error) {
      if (error.code === 'EEXIST') throw appeared();
      throw error;
    }
    try {
      fs.renameSync(staging, outDir);
    } catch (error) {
      // Files put into the claimed folder meanwhile stop the rename; leave them.
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw appeared();
      try {
        fs.rmdirSync(outDir);
      } catch {
        // It holds files now, so it isn't only the folder made above.
      }
      throw error;
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

// What the release folder holds: the verified packages, the privacy policy
// copy, the record, and each check's log from the scratch folder's logs/.
function releaseFiles({ version, builtDir, sourceZip, privacy, record, logs }) {
  return {
    ...Object.fromEntries(
      TARGETS.map((target) => [`slowed-reverb-${target}.zip`, { from: path.join(builtDir, `slowed-reverb-${target}.zip`) }])
    ),
    'slowed-reverb-firefox-source.zip': { from: sourceZip },
    'firefox-privacy-policy.txt': { text: privacy },
    [`RELEASE-${version}.txt`]: { text: record },
    ...Object.fromEntries(
      fs
        .readdirSync(logs)
        .sort()
        .map((name) => [`logs/${name}`, { from: path.join(logs, name) }])
    )
  };
}

function fileInfo(file, entries) {
  return {
    size: fs.statSync(file).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    entries
  };
}

// Pull request numbers in first-parent subjects: merge commits and squashes.
function pullRequests(subjects) {
  return subjects
    .map((subject) => /^Merge pull request #(\d+)/.exec(subject) ?? /\(#(\d+)\)$/.exec(subject))
    .filter(Boolean)
    .map((match) => Number(match[1]));
}

function parseArgs(argv) {
  const options = { commit: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') options.out = argv[++index];
    else if (!argv[index].startsWith('-') && !options.commit) options.commit = argv[index];
    else throw new ReleaseError(`Unexpected argument: ${argv[index]}`);
  }
  if (!options.commit || (argv.includes('--out') && !options.out)) {
    throw new ReleaseError('Usage: npm run release -- <commit on main> [--out <folder>]');
  }
  return options;
}

// The main checkout, where earlier releases are recorded, even when this runs
// from another worktree.
function mainCheckout() {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return path.basename(common) === '.git' ? path.dirname(common) : root;
}

function seconds(ms) {
  return ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

async function step(title, action) {
  if (stopping) throw new ReleaseError(stopping);
  process.stdout.write(`${title} ... `);
  const started = Date.now();
  try {
    const result = await action();
    console.log(`${result ?? 'done'} (${seconds(Date.now() - started)})`);
    return result;
  } catch (error) {
    console.log('FAILED');
    throw error;
  }
}

async function release(options) {
  // The steps run in process groups, and the test suites skip only on Windows.
  if (process.platform === 'win32') throw new ReleaseError('Releases need macOS or Linux.');
  let sha;
  try {
    sha = git(['rev-parse', '--verify', '--quiet', `${options.commit}^{commit}`]);
  } catch {
    throw new ReleaseError(`${options.commit} is not a commit in this repository`);
  }
  try {
    git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']);
  } catch {
    throw new ReleaseError(
      `${options.commit} is not on origin/main. Release from a commit on main (git fetch first if it was just merged).`
    );
  }

  const version = JSON.parse(git(['show', `${sha}:extension/manifest.json`])).version;
  const packagesDir = path.join(mainCheckout(), 'dist', 'packages');
  // npm runs scripts from the repository root; --out is relative to where it was typed.
  const outDir = options.out
    ? path.resolve(process.env.INIT_CWD ?? process.cwd(), options.out)
    : path.join(packagesDir, version);
  if (fs.existsSync(outDir)) {
    throw new ReleaseError(`${outDir} already exists. It may hold verified files; move it aside or pass --out.`);
  }
  const recorded = fs.existsSync(packagesDir)
    ? fs
      .readdirSync(packagesDir)
      .filter((name) => TARGETS.every((target) => fs.existsSync(path.join(packagesDir, name, `slowed-reverb-${target}.zip`))))
    : [];
  const previous = previousVersion(recorded, version);
  const previousDir = previous && path.join(packagesDir, previous);
  const subject = git(['log', '-1', '--format=%s', sha]);
  const pull = pullRequests([subject])[0];

  console.log(`Release ${version} from ${sha.slice(0, 7)}: ${subject}`);
  console.log(previous ? `Comparing with ${previousDir}` : 'No earlier release folder to compare with');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `slowed-reverb-release-${version}-`));
  const tree = path.join(work, 'tree');
  const logs = path.join(work, 'logs');
  const extracted = path.join(work, 'extracted');
  const sourceZip = path.join(work, 'slowed-reverb-firefox-source.zip');
  const sourceDir = path.join(work, 'source');
  fs.mkdirSync(logs);
  console.log(`Working in ${work}`);

  const removeWorktree = () => {
    try {
      git(['worktree', 'remove', '--force', tree]);
    } catch {
      fs.rmSync(tree, { recursive: true, force: true });
      git(['worktree', 'prune']);
    }
  };
  // The steps run in their own process groups, which Ctrl+C in the terminal
  // doesn't reach, so pass it on; the worktree is removed once they stop.
  const interrupt = (signal) => stopRunning(INTERRUPTED, signal);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  let finished = false;
  try {
    git(['worktree', 'add', '--detach', tree, sha]);
    const inTree = (name, command, args) => run(command, args, { cwd: tree, log: path.join(logs, `${name}.log`) });
    const read = (file) => fs.readFileSync(path.join(tree, file), 'utf8');
    const checks = {};

    await step('Version bump', () => {
      const pages = fs.readdirSync(path.join(tree, 'site')).filter((name) => name.endsWith('.html'));
      const problems = versionBumpProblems(read, pages, version);
      if (problems.length) throw new ReleaseError(`The version bump to ${version} is incomplete:\n  ${problems.join('\n  ')}`);
      return `everything shows ${version}`;
    });
    await step('Test scripts', () => {
      const scripts = JSON.parse(read('package.json')).scripts ?? {};
      const changed = Object.keys(TEST_SCRIPTS).filter((name) => scripts[name] !== TEST_SCRIPTS[name]);
      if (changed.length) {
        throw new ReleaseError(
          `package.json's ${listWords(changed)} ${changed.length === 1 ? 'script has' : 'scripts have'} changed; ` +
            'update TEST_SCRIPTS in scripts/release.js and how it runs them'
        );
      }
      return 'as expected';
    });
    await step('npm ci', () => inTree('install', 'npm', ['ci', '--no-audit', '--no-fund']).then(() => null));
    await step('npm run check', () => runCheck({ inTree, logs, checks }));
    await step('npm run package', () => inTree('package', 'npm', ['run', 'package']).then(() => null));
    await step('npm run test:e2e', async () => {
      const log = await inTree('e2e', 'npm', ['run', 'test:e2e']);
      const passed = count(log, /^\s*(\d+) passed\b/m);
      const other = ['failed', 'flaky', 'skipped', 'did not run'].filter((word) =>
        new RegExp(`^\\s*\\d+ ${word}\\b`, 'm').test(log)
      );
      if (!passed || other.length) {
        const report = other.length ? `tests that ${listWords(other)}` : 'no tests that passed';
        throw new ReleaseError(`Playwright reported ${report}`, path.join(logs, 'e2e.log'));
      }
      checks.e2e = passed;
      return `${passed} passed`;
    });
    await step('npm run test:firefox', () => runFirefoxTests({ inTree, logs, checks }));

    const packages = {};
    const changed = {};
    let inventory = null;
    await step('Archives against a fresh build', async () => {
      // The browser tests build their own copies, so build once more.
      for (const target of TARGETS) await inTree(`build-${target}`, 'npm', ['run', `build:${target}`]);
      for (const target of TARGETS) {
        const zipPath = path.join(tree, 'dist', 'packages', `slowed-reverb-${target}.zip`);
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(path.join(extracted, target), true);
        expectSameTree(path.join(extracted, target), path.join(tree, 'dist', target), `The ${target} archive isn't its build`);
        const entries = zip.getEntries().map((entry) => ({ name: entry.entryName, isDirectory: entry.isDirectory }));
        packages[target] = fileInfo(zipPath, describeEntries(entries));

        const manifest = JSON.parse(fs.readFileSync(path.join(extracted, target, 'manifest.json'), 'utf8'));
        const problems = [
          manifest.version !== version && `version ${manifest.version}`,
          manifest.name !== EXTENSION_NAME && `name "${manifest.name}"`,
          manifest.description.length > DESCRIPTION_LIMIT && `a ${manifest.description.length}-character description`
        ].filter(Boolean);
        if (problems.length) throw new ReleaseError(`The ${target} manifest has ${problems.join(', ')}`);
        checks.descriptionLength = manifest.description.length;

        if (previous) {
          const before = zipFiles(path.join(previousDir, `slowed-reverb-${target}.zip`));
          const after = zipFiles(zipPath);
          const names = (map) => [...map.keys()].sort();
          const targetInventory = {
            files: after.size,
            added: names(after).filter((name) => !before.has(name)),
            removed: names(before).filter((name) => !after.has(name))
          };
          if (inventory && JSON.stringify(inventory) !== JSON.stringify(targetInventory)) {
            throw new ReleaseError('The Chromium and Firefox archives hold different files');
          }
          inventory = targetInventory;
          changed[target] = names(after).filter((name) => before.has(name) && !before.get(name).equals(after.get(name)));
        }
      }
      return `byte-identical, ${packages.chromium.entries.split(' ')[0]} entries each`;
    });

    await step('web-ext lint on the Firefox archive', async () => {
      const report = path.join(logs, 'web-ext-lint.json');
      await run(
        path.join(tree, 'node_modules', '.bin', 'web-ext'),
        ['lint', `--source-dir=${path.join(extracted, 'firefox')}`, '--no-config-discovery', '--output=json'],
        { cwd: tree, log: path.join(logs, 'web-ext-lint.log'), stdout: report }
      );
      const result = JSON.parse(fs.readFileSync(report, 'utf8'));
      const lint = Object.fromEntries(
        ['errors', 'warnings', 'notices'].map((kind) => [kind, result.count?.[kind] ?? result[kind].length])
      );
      if (lint.errors || lint.warnings) {
        throw new ReleaseError(`web-ext lint: ${lint.errors} errors, ${lint.warnings} warnings (see ${report})`);
      }
      checks.lint = lint;
      return `${lint.errors} errors, ${lint.warnings} warnings, ${lint.notices} notices`;
    });

    await step('Firefox source zip', async () => {
      git(['archive', '--format=zip', '-o', sourceZip, 'HEAD', '--', ...SOURCE_PATHSPEC], tree);
      const zip = new AdmZip(sourceZip);
      zip.extractAllTo(sourceDir, true);
      await run(process.execPath, ['scripts/build-extension.js', 'firefox'], {
        cwd: sourceDir,
        log: path.join(logs, 'source-build.log')
      });
      expectSameTree(
        path.join(sourceDir, 'dist', 'firefox'),
        path.join(extracted, 'firefox'),
        "The Firefox build from the source zip isn't the packaged add-on"
      );
      packages.source = fileInfo(sourceZip, String(zip.getEntries().length));
      return `builds the same add-on, ${packages.source.entries} entries`;
    });

    await step('Worktree', () => {
      const status = git(['status', '--porcelain', '--untracked-files=no'], tree);
      if (status) throw new ReleaseError(`Packaging changed tracked files:\n${status}`);
      return 'clean';
    });

    const privacy = firefoxPrivacyText(read('PRIVACY.md'));
    const previousPrivacy = previous && path.join(previousDir, 'firefox-privacy-policy.txt');
    const privacyChanges =
      previousPrivacy && fs.existsSync(previousPrivacy)
        ? lineChanges(fs.readFileSync(previousPrivacy, 'utf8'), privacy)
        : null;

    let mergedSince = null;
    const previousRecord = previous && path.join(previousDir, `RELEASE-${previous}.txt`);
    const previousCommit =
      previousRecord && fs.existsSync(previousRecord)
        ? /^Source commit: ([0-9a-f]{40})/m.exec(fs.readFileSync(previousRecord, 'utf8'))?.[1]
        : null;
    if (previousCommit) {
      try {
        mergedSince = pullRequests(git(['log', '--first-parent', '--format=%s', `${previousCommit}..${sha}`]).split('\n')).reverse();
      } catch {
        mergedSince = null;
      }
    }

    const record = releaseRecord({
      version,
      previous,
      date: new Date().toLocaleDateString('en-CA'),
      commit: sha,
      commitNote: pull ? `main, after PR #${pull}` : 'main',
      mergedSince,
      node: process.version.replace(/^v/, ''),
      npm: execFileSync('npm', ['--version'], { cwd: tree, env: childEnv(), encoding: 'utf8' }).trim(),
      packages,
      inventory,
      changed,
      privacyChanges,
      checks
    });

    // The logs are copied before the scratch folder is removed below.
    writeReleaseFolder(
      outDir,
      releaseFiles({ version, builtDir: path.join(tree, 'dist', 'packages'), sourceZip, privacy, record, logs })
    );

    console.log(`\nRecorded in ${outDir}:`);
    for (const [file, info] of [
      ['slowed-reverb-chromium.zip', packages.chromium],
      ['slowed-reverb-firefox.zip', packages.firefox],
      ['slowed-reverb-firefox-source.zip', packages.source]
    ]) {
      console.log(`  ${file}  ${info.size} bytes  ${info.sha256}`);
    }
    console.log(`  firefox-privacy-policy.txt\n  RELEASE-${version}.txt (a draft: fill in the lines marked TODO)\n  logs/`);
    finished = true;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    removeWorktree();
    if (finished) fs.rmSync(work, { recursive: true, force: true });
    else console.log(`Logs are in ${logs}`);
  }
}

if (require.main === module) {
  Promise.resolve()
    .then(() => release(parseArgs(process.argv.slice(2))))
    .catch((error) => {
      console.error(`\n${error.message}`);
      if (error.log && fs.existsSync(error.log)) {
        const tail = fs.readFileSync(error.log, 'utf8').trimEnd().split('\n').slice(-40).join('\n');
        console.error(`\nEnd of ${error.log}:\n${tail}`);
      }
      process.exitCode = 1;
    });
}

module.exports = {
  compareVersions,
  describeEntries,
  firefoxPrivacyText,
  lineChanges,
  nodeTestResults,
  previousVersion,
  pullRequests,
  releaseFiles,
  releaseRecord,
  resultsReporter,
  run,
  runCheck,
  runFirefoxTests,
  stillRunning,
  TEST_SCRIPTS,
  versionBumpProblems,
  wrap,
  writeReleaseFolder
};
