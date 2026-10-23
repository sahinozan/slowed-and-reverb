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
// It exits with 0 only when npm returned a report with no advisories, 1 when
// the report lists any (whatever their severity, and whether or not a fix
// exists), and 2 when there is no report to trust: npm failed, couldn't reach
// the registry, was stopped, or printed something this doesn't recognize, or
// the folder, its files or the job summary couldn't be written. Files written
// before such a failure are left in place.
// Nothing in npm's output is run; it is only parsed and escaped into Markdown.
// None of it is printed either: GitHub Actions reads lines like ::add-mask::
// in a step's output as commands, so the script prints only a fixed line
// saying how the audit ended and where summary.md is.
//
// This isn't part of npm run check or the release. It has its own workflow,
// .github/workflows/dependency-audit.yml, and an advisory with no fixed
// version keeps it failing; see "Development dependencies" in SECURITY.md.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AUDIT_ARGS = ['audit', '--package-lock-only', '--include=dev', '--json'];
const COMMAND = `npm ${AUDIT_ARGS.join(' ')}`;
const EXIT = { clean: 0, advisories: 1, error: 2 };
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];
const GHSA_URL = /^https:\/\/github\.com\/advisories\/(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/;
const MAX_CHAINS = 20;
// All the script prints, so nothing from npm's output reaches the console.
const STATUS_LINES = {
  clean: 'Dependency audit: no known advisories.',
  advisories: 'Dependency audit: known advisories found.',
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

function versionsOf(lock, entry) {
  const versions = entry.nodes.map((node) => lock?.packages?.[node]?.version ?? 'unknown version');
  return [...new Set(versions)].join(', ');
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
  for (const { name, range } of advisory.affected) {
    const entry = vulnerabilities[name];
    lines.push(`- ${text(name)} ${text(versionsOf(lock, entry))}, affected: ${text(range)}. ${fixOf(entry)}`);
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
// parsed package-lock.json, used only to show installed versions.
function summarize({ stdout, exitCode = null, signal = null, spawnError = null, lock = null }) {
  const ended = describeExit({ exitCode, signal, spawnError });
  try {
    return judge({ stdout, exitCode, signal, spawnError, lock, ended });
  } catch (error) {
    // Rather than a crash, whose exit code 1 would read as advisories and
    // whose message on the console could quote the report.
    return failure(ended, `The report couldn't be summarized: ${error?.message ?? error}`);
  }
}

function judge({ stdout, exitCode, signal, spawnError, lock, ended }) {
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

  const { vulnerabilities } = report;
  const packages = Object.keys(vulnerabilities).length;
  if (packages === 0) {
    if (exitCode !== 0) return fail(`npm reported no advisories but ${ended}.`);
    return {
      status: 'clean',
      exitCode: EXIT.clean,
      markdown: [...heading(ended), '**No known advisories** for the versions in package-lock.json, development tools included.', '', EVIDENCE, ''].join('\n')
    };
  }

  const advisories = collectAdvisories(vulnerabilities);
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const lines = [
    ...heading(ended),
    `**${count(advisories.length, 'known advisory', 'known advisories')}** in package-lock.json. ` +
      `npm counts ${count(packages, 'affected package', 'affected packages')}: each package an advisory names, and the ones that depend on it.`,
    ''
  ];
  if (exitCode === 0) lines.push('npm exited with 0 although its report lists advisories; this still fails.', '');
  for (const advisory of advisories) lines.push(...advisorySection(advisory, vulnerabilities, lock), '');
  lines.push(
    'Advisories the project has looked at but can\'t fix yet are described under "Development dependencies" in SECURITY.md. They still fail this check.',
    '',
    EVIDENCE,
    ''
  );
  return { status: 'advisories', exitCode: EXIT.advisories, markdown: lines.join('\n') };
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
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

    result = summarize({ stdout: run.stdout, ...ending, lock: readLock('package-lock.json') });
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

module.exports = { AUDIT_ARGS, EXIT, STATUS_LINES, summarize };
