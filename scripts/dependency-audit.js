'use strict';

// Asks the npm registry for advisories against package-lock.json, development
// tools included, without installing anything:
//
//   npm run audit:dependencies -- <folder>
//
// runs npm audit --package-lock-only --include=dev --json and keeps what npm
// printed, unchanged, in <folder>: npm-audit.json, npm-audit.stderr.txt and
// npm-audit-exit.txt. It then writes summary.md, also added to the job
// summary on GitHub Actions: each advisory once, with its link, the installed
// versions it affects and the chains of dependencies that bring them in. npm
// counts every package in such a chain, so its total is larger than the
// number of advisories.
//
// Advisories the project has looked at and can't fix yet are listed in
// audit-exceptions.json, each with the package and installed versions it
// covers, a short reason and a date to look at it again by, at most
// MAX_REVIEW_DAYS ahead. An advisory is let through only while an entry
// covers every installed version it affects and its date hasn't passed.
//
// It exits with 0 when npm returned a report whose advisories, if any, are all
// covered that way, and every entry is still needed. It exits with 1 when an
// advisory isn't covered (whatever its severity, and whether or not a fix
// exists), an entry's date has passed, or an entry no longer matches anything
// installed. It exits with 2 when there is no report to trust: npm failed,
// couldn't reach the registry, was stopped, or printed something this doesn't
// recognize; when audit-exceptions.json can't be read or isn't in the expected
// format; or when the folder, its files or the job summary couldn't be
// written. Files written before such a failure are left in place.
// Nothing in npm's output is run; it is only parsed and escaped into Markdown.
// None of it is printed either: GitHub Actions reads lines like ::add-mask::
// in a step's output as commands, so the script prints only a fixed line
// saying how the audit ended and where summary.md is.
//
// This isn't part of npm run check or the release. It has its own workflow,
// .github/workflows/dependency-audit.yml.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AUDIT_ARGS = ['audit', '--package-lock-only', '--include=dev', '--json'];
const COMMAND = `npm ${AUDIT_ARGS.join(' ')}`;
const EXIT = { clean: 0, advisories: 1, error: 2 };
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];
const GHSA = 'GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}';
const GHSA_URL = new RegExp(`^https://github\\.com/advisories/(${GHSA})$`);
const GHSA_ID = new RegExp(`^${GHSA}$`);
const EXCEPTIONS_FILE = 'audit-exceptions.json';
const EXCEPTION_KEYS = ['advisory', 'package', 'versions', 'reason', 'reviewBy'];
const MAX_REVIEW_DAYS = 90;
const MAX_REASON_LENGTH = 400;
const MAX_CHAINS = 20;
// All the script prints, so nothing from npm's output reaches the console.
const STATUS_LINES = {
  clean: 'Dependency audit: no known advisories.',
  reviewed: `Dependency audit: only advisories reviewed in ${EXCEPTIONS_FILE}.`,
  advisories: 'Dependency audit: advisories or exceptions need attention.',
  error: 'Dependency audit: the audit didn\'t finish, so this says nothing about advisories.'
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isCount = (value) => Number.isInteger(value) && value >= 0;

// Text from npm's output, safe to put in Markdown: one line, with no HTML,
// links, images, code or emphasis of its own.
function text(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*[\]~]/g, '\\$&')
    .trim();
}

// Why the parsed output isn't a version 2 report this can read, or null.
function reportProblem(report) {
  if (!isObject(report)) return 'npm printed JSON that isn\'t an object.';
  // npm's errors come as { error: { code, summary } }; one next to a report
  // means the report can't be trusted either.
  const error = isObject(report.error) ? report.error : {};
  const parts = [error.code, error.summary, report.message].filter((part) => typeof part === 'string' && part);
  if ('error' in report) {
    return parts.length ? `npm reported an error: ${parts.join(': ')}` : 'npm reported an error without saying what it was.';
  }
  if (report.auditReportVersion !== 2) {
    return parts.length
      ? `npm reported an error instead of a report: ${parts.join(': ')}`
      : 'npm printed JSON in a format this doesn\'t recognize.';
  }
  const { vulnerabilities, metadata } = report;
  if (!isObject(vulnerabilities)) return 'The report has no list of vulnerable packages.';
  const counts = metadata?.vulnerabilities;
  if (!isObject(counts) || ![...SEVERITIES, 'total'].every((key) => isCount(counts[key]))) {
    return 'The report has no count of vulnerable packages for each severity.';
  }
  if (!Object.values(counts).every(isCount)) return 'The report counts vulnerable packages with something other than a number.';
  if (!isCount(metadata.dependencies?.total)) return 'The report has no count of the dependencies it checked.';
  const { total } = counts;
  const names = Object.keys(vulnerabilities);
  if (total !== names.length) {
    return `The report counts ${total} vulnerable packages but lists ${names.length}.`;
  }
  for (const name of names) {
    const entry = vulnerabilities[name];
    const valid =
      isObject(entry) &&
      entry.name === name &&
      typeof entry.isDirect === 'boolean' &&
      SEVERITIES.includes(entry.severity) &&
      Array.isArray(entry.via) &&
      entry.via.length > 0 &&
      isStringArray(entry.effects) &&
      isStringArray(entry.nodes) &&
      entry.nodes.length > 0;
    if (!valid) return `The report's entry for ${name} isn't in the expected format.`;
    for (const cause of entry.via) {
      if (typeof cause === 'string') {
        if (!vulnerabilities[cause]) return `${name} is listed as affected through ${cause}, which the report doesn't list.`;
      } else if (
        !isObject(cause) ||
        typeof cause.url !== 'string' ||
        typeof cause.title !== 'string' ||
        typeof cause.range !== 'string' ||
        !SEVERITIES.includes(cause.severity)
      ) {
        return `An advisory for ${name} isn't in the expected format.`;
      }
    }
    const unknown = entry.effects.find((effect) => !vulnerabilities[effect]);
    if (unknown) return `${name} is listed as affecting ${unknown}, which the report doesn't list.`;
  }
  // npm counts each listed package once, under its own severity.
  for (const [severity, count] of Object.entries(counts)) {
    if (severity === 'total') continue;
    const listed = names.filter((name) => vulnerabilities[name].severity === severity).length;
    if (count !== listed) return `The report counts ${count} ${severity} vulnerable packages but lists ${listed}.`;
  }
  if (names.length && !names.some((name) => vulnerabilities[name].via.some(isObject))) {
    return 'The report lists vulnerable packages but no advisory behind them.';
  }
  return null;
}

// A date written YYYY-MM-DD, as a time in UTC, or null if it isn't one.
function dayOf(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value ? null : time;
}

// Why audit-exceptions.json's content can't be used, or null. today is
// YYYY-MM-DD in UTC.
function exceptionsProblem(list, today) {
  if (!Array.isArray(list)) return `${EXCEPTIONS_FILE} isn't a list.`;
  const latest = dayOf(today) + MAX_REVIEW_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set();
  for (const [index, item] of list.entries()) {
    const where = `Entry ${index + 1} in ${EXCEPTIONS_FILE}`;
    if (!isObject(item)) return `${where} isn't an object.`;
    const keys = Object.keys(item);
    if (keys.length !== EXCEPTION_KEYS.length || !EXCEPTION_KEYS.every((key) => keys.includes(key))) {
      return `${where} needs exactly these fields: ${EXCEPTION_KEYS.join(', ')}.`;
    }
    if (typeof item.advisory !== 'string' || !GHSA_ID.test(item.advisory)) return `${where} doesn't name a GitHub advisory (GHSA-…).`;
    if (typeof item.package !== 'string' || !item.package.trim()) return `${where} doesn't name a package.`;
    if (!isStringArray(item.versions) || !item.versions.length || item.versions.some((version) => !version.trim())) {
      return `${where} doesn't list the installed versions it covers.`;
    }
    if (new Set(item.versions).size !== item.versions.length) return `${where} lists a version twice.`;
    if (typeof item.reason !== 'string' || !item.reason.trim()) return `${where} gives no reason.`;
    if (item.reason.length > MAX_REASON_LENGTH) return `${where} has a reason longer than ${MAX_REASON_LENGTH} characters; keep it short.`;
    const reviewBy = dayOf(item.reviewBy);
    if (reviewBy === null) return `${where} needs a reviewBy date written YYYY-MM-DD.`;
    if (reviewBy > latest) return `${where} has a reviewBy date more than ${MAX_REVIEW_DAYS} days ahead.`;
    const key = `${item.advisory} ${item.package}`;
    if (seen.has(key)) return `${where} repeats ${item.advisory} for ${item.package}.`;
    seen.add(key);
  }
  return null;
}

// Each chain from a package the project depends on directly, or from the top
// of the report's chain, down to the named package.
function chains(vulnerabilities, name, below = []) {
  const entry = vulnerabilities[name];
  const parents = entry.effects.filter((effect) => effect !== name && !below.includes(effect));
  const found = entry.isDirect || parents.length === 0 ? [[name]] : [];
  for (const parent of parents) {
    for (const chain of chains(vulnerabilities, parent, [...below, name])) found.push([...chain, name]);
  }
  return found;
}

// Each advisory once, most severe first, with every package entry it appears in.
function collectAdvisories(vulnerabilities) {
  const byUrl = new Map();
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    for (const cause of entry.via) {
      if (!isObject(cause)) continue;
      const advisory = byUrl.get(cause.url) ?? {
        id: GHSA_URL.exec(cause.url)?.[1] ?? null,
        url: cause.url,
        title: cause.title,
        severity: cause.severity,
        affected: []
      };
      advisory.affected.push({ name, range: cause.range });
      byUrl.set(cause.url, advisory);
    }
  }
  return [...byUrl.values()].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.url.localeCompare(b.url)
  );
}

// The installed versions of a package entry, each once; null for one the
// lockfile doesn't give.
function installedVersions(lock, entry) {
  const versions = entry.nodes.map((node) => lock?.packages?.[node]?.version);
  return [...new Set(versions.map((version) => (typeof version === 'string' ? version : null)))];
}

function versionsOf(lock, entry) {
  return installedVersions(lock, entry).map((version) => version ?? 'unknown version').join(', ');
}

// Whether audit-exceptions.json lets each package an advisory affects
// through: on each item of advisory.affected, sets exception (the entry, or
// null) and problem (why it isn't let through, or null).
function review(advisory, vulnerabilities, lock, exceptions, today) {
  for (const item of advisory.affected) {
    const exception = advisory.id
      ? exceptions.find((candidate) => candidate.advisory === advisory.id && candidate.package === item.name) ?? null
      : null;
    item.exception = exception;
    const versions = installedVersions(lock, vulnerabilities[item.name]);
    if (!exception) item.problem = `Not in ${EXCEPTIONS_FILE}.`;
    else if (versions.includes(null)) item.problem = 'The lockfile doesn\'t give its installed version, so the exception can\'t be checked.';
    else if (!versions.every((version) => exception.versions.includes(version))) {
      item.problem = `${EXCEPTIONS_FILE} covers ${text(exception.versions.join(', '))}, not ${text(versions.join(', '))}. Look again before adding a version.`;
    } else if (exception.reviewBy < today) item.problem = `The exception was to be looked at again by ${text(exception.reviewBy)}.`;
    else item.problem = null;
  }
  return advisory.affected.every((item) => !item.problem);
}

function fixOf(entry) {
  const fix = entry.fixAvailable;
  if (fix === true) return 'npm says a compatible update fixes it.';
  if (isObject(fix) && typeof fix.name === 'string' && typeof fix.version === 'string') {
    const major = fix.isSemVerMajor ? ', a major version change; check it before trusting it' : '';
    return `npm suggests ${text(fix.name)} ${text(fix.version)}${major}.`;
  }
  return 'npm knows no fix.';
}

function advisorySection(advisory, vulnerabilities, lock) {
  const label = advisory.id ? `[${advisory.id}](${advisory.url})` : text(advisory.url);
  const lines = [`### ${label} (${advisory.severity})`, '', text(advisory.title), ''];
  for (const { name, range, exception, problem } of advisory.affected) {
    const entry = vulnerabilities[name];
    lines.push(`- ${text(name)} ${text(versionsOf(lock, entry))}, affected: ${text(range)}. ${fixOf(entry)}`);
    if (problem) lines.push(`  - **Needs attention:** ${problem}`);
    // The reason is the project's own text, but escaped too; also its
    // underscores, so a word like __proto__ isn't read as emphasis.
    else if (exception) lines.push(`  - **Reviewed:** ${text(exception.reason).replace(/_/g, '\\_')} Look again by ${text(exception.reviewBy)}.`);
    for (const node of entry.nodes) lines.push(`  - Installed at ${text(node)}`);
    const found = chains(vulnerabilities, name);
    for (const chain of found.slice(0, MAX_CHAINS)) {
      const steps = chain.map((step) => `${text(step)} ${text(versionsOf(lock, vulnerabilities[step]))}`);
      lines.push(`  - Brought in by ${steps.join(' &gt; ')}`);
    }
    if (found.length > MAX_CHAINS) lines.push(`  - And ${found.length - MAX_CHAINS} more chains`);
  }
  return lines;
}

function describeExit({ exitCode, signal, spawnError }) {
  if (spawnError) return `npm couldn't be run: ${spawnError}`;
  if (signal) return `npm was stopped by ${signal}`;
  return `npm exited with ${exitCode}`;
}

const EVIDENCE = 'npm\'s own output is kept unchanged in npm-audit.json and npm-audit.stderr.txt.';

function heading(ended) {
  return ['## Dependency audit', '', `\`${COMMAND}\`: ${text(ended)}.`, ''];
}

function failure(ended, problem) {
  return {
    status: 'error',
    exitCode: EXIT.error,
    markdown: [...heading(ended), '**The audit didn\'t finish, so this says nothing about advisories.**', '', text(problem), '', EVIDENCE, ''].join('\n')
  };
}

// What npm's run means: { status, exitCode, markdown }. stdout is what npm
// printed; exitCode, signal and spawnError say how it ended; lock is the
// parsed package-lock.json, used to show and check installed versions;
// exceptions is the parsed audit-exceptions.json, or exceptionsError why it
// couldn't be read; today is the date in UTC, YYYY-MM-DD.
function summarize({
  stdout,
  exitCode = null,
  signal = null,
  spawnError = null,
  lock = null,
  exceptions = [],
  exceptionsError = null,
  today = new Date().toISOString().slice(0, 10)
}) {
  const ended = describeExit({ exitCode, signal, spawnError });
  try {
    return judge({ stdout, exitCode, signal, spawnError, lock, exceptions, exceptionsError, today, ended });
  } catch (error) {
    // Rather than a crash, whose exit code 1 would read as advisories and
    // whose message on the console could quote the report.
    return failure(ended, `The report couldn't be summarized: ${error?.message ?? error}`);
  }
}

function judge({ stdout, exitCode, signal, spawnError, lock, exceptions, exceptionsError, today, ended }) {
  const fail = (problem) => failure(ended, problem);
  if (spawnError || signal || !Number.isInteger(exitCode)) return fail('npm didn\'t run to the end.');
  if (!stdout || !stdout.trim()) return fail('npm printed no report.');
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return fail('npm printed something that isn\'t JSON.');
  }
  const problem = reportProblem(report);
  if (problem) return fail(problem);
  if (dayOf(today) === null) return fail('Today\'s date isn\'t known.');
  if (exceptionsError) return fail(exceptionsError);
  const exceptionsInvalid = exceptionsProblem(exceptions, today);
  if (exceptionsInvalid) return fail(exceptionsInvalid);

  const { vulnerabilities } = report;
  const packages = Object.keys(vulnerabilities).length;
  if (packages === 0 && exitCode !== 0) return fail(`npm reported no advisories but ${ended}.`);

  const advisories = collectAdvisories(vulnerabilities);
  const attention = advisories.filter((advisory) => !review(advisory, vulnerabilities, lock, exceptions, today));
  const reviewed = advisories.filter((advisory) => !attention.includes(advisory));
  const used = new Set(advisories.flatMap((advisory) => advisory.affected.map((item) => item.exception)));
  const unused = exceptions.filter((exception) => !used.has(exception));
  // Versions an entry lists that are no longer installed.
  const extra = exceptions.flatMap((exception) => {
    if (!used.has(exception)) return [];
    const installed = advisories.flatMap((advisory) =>
      advisory.affected.filter((item) => item.exception === exception).flatMap((item) => installedVersions(lock, vulnerabilities[item.name]))
    );
    const gone = exception.versions.filter((version) => !installed.includes(version));
    return gone.length ? [{ exception, gone }] : [];
  });
  const npmDisagrees = packages > 0 && exitCode === 0;
  const ok = !attention.length && !unused.length && !extra.length && !npmDisagrees;

  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const lines = [...heading(ended)];
  if (packages === 0) {
    lines.push('**No known advisories** for the versions in package-lock.json, development tools included.', '');
  } else {
    lines.push(
      `**${count(advisories.length, 'known advisory', 'known advisories')}** in package-lock.json, ` +
        `${attention.length} needing attention and ${reviewed.length} reviewed in ${EXCEPTIONS_FILE}. ` +
        `npm counts ${count(packages, 'affected package', 'affected packages')}: each package an advisory names, and the ones that depend on it.`,
      ''
    );
  }
  if (npmDisagrees) lines.push('npm exited with 0 although its report lists advisories; this still fails.', '');
  if (attention.length) {
    lines.push('## Needs attention', '');
    for (const advisory of attention) lines.push(...advisorySection(advisory, vulnerabilities, lock), '');
  }
  if (unused.length || extra.length) {
    lines.push(`## Exceptions no longer needed`, '', `Remove these from ${EXCEPTIONS_FILE}:`, '');
    for (const exception of unused) {
      lines.push(`- ${text(exception.advisory)} for ${text(exception.package)}: nothing installed is affected any more.`);
    }
    for (const { exception, gone } of extra) {
      lines.push(`- ${text(exception.advisory)} for ${text(exception.package)}: ${text(gone.join(', '))} is no longer installed.`);
    }
    lines.push('');
  }
  if (reviewed.length) {
    lines.push(`## Reviewed in ${EXCEPTIONS_FILE}`, '');
    for (const advisory of reviewed) lines.push(...advisorySection(advisory, vulnerabilities, lock), '');
  }
  lines.push(EVIDENCE, '');
  const markdown = lines.join('\n');
  if (!ok) return { status: 'advisories', exitCode: EXIT.advisories, markdown };
  return { status: packages ? 'reviewed' : 'clean', exitCode: EXIT.clean, markdown };
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// { exceptions } from audit-exceptions.json, an empty list if there is no such
// file, or { exceptionsError } if it can't be read.
function readExceptions(file) {
  let data;
  try {
    data = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exceptions: [] };
    return { exceptionsError: `${EXCEPTIONS_FILE} couldn't be read.` };
  }
  try {
    return { exceptions: JSON.parse(data) };
  } catch {
    return { exceptionsError: `${EXCEPTIONS_FILE} isn't valid JSON.` };
  }
}

function main(args) {
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('Usage: npm run audit:dependencies -- <folder for the output>\n');
    return EXIT.error;
  }
  // npm sets this to its own entry point for the scripts it runs.
  const npm = process.env.npm_execpath;
  if (!npm) {
    process.stderr.write('Run this through npm: npm run audit:dependencies -- <folder>\n');
    return EXIT.error;
  }
  const folder = path.resolve(args[0]);
  const summary = path.join(folder, 'summary.md');
  // What it was doing, named if that fails.
  let step = `create ${folder}`;
  const write = (file, data) => {
    step = `write ${file}`;
    fs.writeFileSync(file, data);
  };
  let result;
  try {
    fs.mkdirSync(folder, { recursive: true });

    const run = spawnSync(process.execPath, [npm, ...AUDIT_ARGS], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5 * 60 * 1000
    });
    const ending = {
      exitCode: run.status,
      signal: run.signal,
      spawnError: run.error ? run.error.message : null
    };
    write(path.join(folder, 'npm-audit.json'), run.stdout ?? '');
    write(path.join(folder, 'npm-audit.stderr.txt'), run.stderr ?? '');
    write(path.join(folder, 'npm-audit-exit.txt'), `${describeExit(ending)}\n`);

    result = summarize({
      stdout: run.stdout,
      ...ending,
      lock: readLock('package-lock.json'),
      ...readExceptions(EXCEPTIONS_FILE)
    });
    write(summary, result.markdown);
    if (process.env.GITHUB_STEP_SUMMARY) {
      step = `add to ${process.env.GITHUB_STEP_SUMMARY}`;
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.markdown);
    }
  } catch (error) {
    // Rather than a crash, whose exit code 1 would read as advisories. Only
    // the step and the error's code are printed, never its message.
    const code = /^E[A-Z]+$/.test(error?.code) ? ` (${error.code})` : '';
    process.stderr.write(`Dependency audit: couldn't ${step}${code}, so this says nothing about advisories.\n`);
    return EXIT.error;
  }
  process.stdout.write(`${STATUS_LINES[result.status]} The summary is in ${summary}.\n`);
  return result.exitCode;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { AUDIT_ARGS, EXCEPTIONS_FILE, EXIT, MAX_REVIEW_DAYS, STATUS_LINES, summarize };
