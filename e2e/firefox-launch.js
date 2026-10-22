'use strict';

// Starts Firefox for e2e/firefox-shutdown.js through puppeteer.launch and
// prints how the start went: which Firefox it is, how long it took to open
// its WebDriver BiDi port, what it printed meanwhile and, if the start failed,
// what its processes were doing and how they ended. Puppeteer's own timeout
// error says none of this, and Firefox has sometimes not opened the port
// within the 30 seconds puppeteer allows on GitHub's Ubuntu runners.
//
// Puppeteer doesn't hand out the browser process until the start succeeds,
// so this finds it through Node's 'child_process' diagnostics channel, which
// reports every process the test starts, and keeps only the first lines of
// output from the start.

const { execFileSync } = require('node:child_process');
const diagnosticsChannel = require('node:diagnostics_channel');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const MAX_LINES = 200;
const MAX_LINE_LENGTH = 500;
// Puppeteer gives a Firefox that didn't start 5 seconds to quit before it
// kills it, so this waits a little longer to see how it ended.
const EXIT_WAIT_MS = 10_000;
const ENDPOINT_LINE = /^WebDriver BiDi listening on ws:\/\//;

// The version Firefox records next to its executable (on macOS, in the app's
// Resources folder), read without starting another Firefox.
function installedVersion(executablePath) {
  let directory;
  try {
    directory = path.dirname(fs.realpathSync(executablePath));
  } catch (error) {
    return `unknown (${error.code ?? error.message})`;
  }
  const candidates = [
    path.join(directory, 'application.ini'),
    path.join(directory, '..', 'Resources', 'application.ini')
  ];
  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const value = (key) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1].trim();
    return `${value('Version') ?? 'unknown'} (build ${value('BuildID') ?? 'unknown'}, ${file})`;
  }
  return `unknown (no application.ini near ${directory})`;
}

// Splits text from one output stream into lines where puppeteer's readline
// does (at \n, \r\n or a lone \r) and calls onLine(text, cut) for each. Only
// the first MAX_LINE_LENGTH characters of a line are kept, with cut set if
// there were more; the rest is skipped up to the line's real end, however the
// output is split into chunks, so a long line is still one line and the next
// one starts where the browser started it.
function lineReader(onLine) {
  let pending = '';
  let cut = false;
  const add = (text) => {
    if (cut) return;
    pending += text;
    if (pending.length > MAX_LINE_LENGTH) {
      pending = pending.slice(0, MAX_LINE_LENGTH);
      cut = true;
    }
  };
  const finish = () => {
    const line = pending;
    const wasCut = cut;
    pending = '';
    cut = false;
    onLine(line, wasCut);
  };
  return {
    write(text) {
      const parts = text.split(/\r\n|\r|\n/);
      add(parts[0]);
      for (const part of parts.slice(1)) {
        finish();
        add(part);
      }
    },
    // Like readline, counts text left without a line end as a last line.
    end() {
      if (pending) finish();
    },
    // How many characters are held for the unfinished line.
    get buffered() {
      return pending.length;
    }
  };
}

// Watches for the first process started from `executablePath` and records
// when it started, its first lines of output and how it ended. stop() lets go
// of the process without pausing its output, which puppeteer still reads.
function watchLaunch(executablePath, now = () => performance.now()) {
  const startedAt = now();
  const record = {
    executablePath,
    pid: null,
    spawnedAt: null,
    endpointAt: null,
    lines: [],
    droppedLines: 0,
    finishedAt: null,
    exit: null
  };
  let child = null;
  let stopped = false;
  const detach = [];
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const elapsed = () => Math.round(now() - startedAt);

  const addLine = (stream, line, cut) => {
    if (!line.trim()) return;
    const at = elapsed();
    // The announcement is short, so the kept start of a line is enough to
    // tell whether puppeteer will take it as one.
    if (record.endpointAt === null && ENDPOINT_LINE.test(line)) record.endpointAt = at;
    if (record.lines.length >= MAX_LINES) {
      record.droppedLines += 1;
      return;
    }
    record.lines.push({ at, stream, text: cut ? `${line}…` : line });
  };

  // A 'data' listener rather than readline, whose close() would pause the
  // stream for puppeteer too and could leave Firefox blocked on a full pipe.
  const follow = (stream, name) => {
    if (!stream) return;
    const decoder = new StringDecoder('utf8');
    const reader = lineReader((line, cut) => addLine(name, line, cut));
    const onData = (chunk) => reader.write(decoder.write(chunk));
    const onEnd = () => {
      reader.write(decoder.end());
      reader.end();
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    detach.push(() => {
      stream.off('data', onData);
      stream.off('end', onEnd);
    });
  };

  const onSpawn = ({ process: candidate }) => {
    // The channel reports the process before it starts; its file name and
    // output streams are set by the time spawn() returns.
    process.nextTick(() => {
      if (stopped || child || candidate.spawnfile !== executablePath) return;
      child = candidate;
      diagnosticsChannel.unsubscribe('child_process', onSpawn);
      record.pid = child.pid ?? null;
      record.spawnedAt = elapsed();
      follow(child.stdout, 'stdout');
      follow(child.stderr, 'stderr');
      const onExit = (code, signal) => {
        record.exit = { at: elapsed(), code, signal };
        resolveExit();
      };
      const onError = (error) => {
        record.exit = { at: elapsed(), error: error.message };
        resolveExit();
      };
      child.once('exit', onExit);
      child.once('error', onError);
      detach.push(() => {
        child.off('exit', onExit);
        child.off('error', onError);
      });
    });
  };
  diagnosticsChannel.subscribe('child_process', onSpawn);

  return {
    record,
    elapsed,
    // Resolves once the process has ended, or after `timeout` ms.
    async waitForExit(timeout) {
      if (!child || record.exit) return;
      let timer;
      await Promise.race([exited, new Promise((resolve) => (timer = setTimeout(resolve, timeout)))]);
      clearTimeout(timer);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      diagnosticsChannel.unsubscribe('child_process', onSpawn);
      for (const undo of detach) undo();
    }
  };
}

// The processes in the browser's process group (puppeteer starts it as a
// group leader on Linux and macOS), with each one's state and, where the
// system reports it, the kernel function it is waiting in.
function processSnapshot(pid) {
  if (!pid || process.platform === 'win32') return null;
  let output;
  try {
    output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,etime=,wchan=,args='], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (error) {
    return [`ps failed: ${error.message}`];
  }
  const rows = output
    .split('\n')
    .filter((row) => row.trim().split(/\s+/)[2] === String(pid))
    .map((row) => (row.length > 240 ? `${row.slice(0, 240)}…` : row.trimEnd()));
  return rows.length ? rows : [`no processes left in group ${pid}`];
}

function formatReport({ record, outcome, version, browserVersion, snapshot, error, exitWait }) {
  const seconds = (ms) => (ms === null || ms === undefined ? 'never' : `${(ms / 1000).toFixed(1)} s`);
  const lines = [
    `Firefox start ${outcome} after ${seconds(record.finishedAt)}: ${record.executablePath}`,
    `  installed version: ${version}`
  ];
  if (browserVersion) lines.push(`  browser reports: ${browserVersion}`);
  if (record.spawnedAt === null) {
    lines.push('  no Firefox process was seen starting');
  } else {
    lines.push(`  process ${record.pid} started at ${seconds(record.spawnedAt)}`);
    lines.push(`  WebDriver BiDi port announced at ${seconds(record.endpointAt)}`);
  }
  if (error) lines.push(`  error: ${String(error.message ?? error).split('\n')[0]}`);
  if (snapshot) {
    lines.push('  processes when it failed (pid ppid pgid stat elapsed wchan args):');
    for (const row of snapshot) lines.push(`    ${row}`);
  }
  if (record.exit) {
    const { at, code, signal, error: exitError } = record.exit;
    const how = exitError ? `failed to run (${exitError})` : `exited with code ${code}, signal ${signal}`;
    lines.push(`  process ${how} at ${seconds(at)}`);
  } else if (record.spawnedAt !== null && outcome !== 'succeeded') {
    lines.push(`  process still running ${seconds(exitWait)} after the failure`);
  }
  lines.push(`  output (${record.lines.length} lines${record.droppedLines ? `, ${record.droppedLines} more not kept` : ''}):`);
  for (const { at, stream, text } of record.lines) lines.push(`    +${seconds(at)} ${stream}: ${text}`);
  return lines.join('\n');
}

// Calls launch(options), which starts Firefox, and prints a report on how the
// start went through `log`. Rethrows the launch's own error unchanged.
async function launchFirefox(launch, options, { log = console.error, exitWait = EXIT_WAIT_MS } = {}) {
  const version = installedVersion(options.executablePath);
  const watch = watchLaunch(options.executablePath);
  let browser;
  try {
    browser = await launch(options);
  } catch (error) {
    watch.record.finishedAt = watch.elapsed();
    // Taken before puppeteer kills the process, then wait to see how it ends.
    const snapshot = processSnapshot(watch.record.pid);
    await watch.waitForExit(exitWait);
    watch.stop();
    log(formatReport({ record: watch.record, outcome: 'failed', version, snapshot, error, exitWait }));
    throw error;
  }
  watch.record.finishedAt = watch.elapsed();
  watch.stop();
  const browserVersion = await Promise.resolve()
    .then(() => browser.version())
    .catch((error) => `unavailable (${error.message})`);
  log(formatReport({ record: watch.record, outcome: 'succeeded', version, browserVersion }));
  return browser;
}

module.exports = { MAX_LINES, MAX_LINE_LENGTH, installedVersion, launchFirefox, lineReader };
