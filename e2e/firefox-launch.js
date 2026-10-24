'use strict';

// Starts Firefox for e2e/firefox-shutdown.js, the audio suites and their
// reproducers (e2e/audio-capture/) through puppeteer.launch and prints how
// the start went: which Firefox it is, how long it took to open its
// WebDriver BiDi port, what it printed meanwhile and, if the start failed,
// what its processes were doing and how they ended. Puppeteer's own timeout
// error says none of this, and Firefox has sometimes not opened the port
// within the 30 seconds puppeteer allows on GitHub's Ubuntu runners.
//
// Puppeteer doesn't hand out the browser process until the start succeeds,
// so this finds it through Node's 'child_process' diagnostics channel, which
// reports every process the test starts, and keeps only the first lines of
// output from the start.
//
// Given a deadline, it also ends a start that outlasts it. Puppeteer's own
// timeout covers only the wait for the port (30 seconds); the WebDriver
// BiDi session that follows can wait up to its protocol timeout (180
// seconds), and racing the launch against a timer would leave it running,
// or leave a browser that starts later with nobody to close it. So the
// launch gets an AbortSignal, which puppeteer answers by killing the
// browser's processes, and the deadline is aborted; then this waits, for a
// bounded time, for the launch to end and closes a browser it hands over
// after all, and for the process it started to exit, killing that process
// (and its group) itself if it hasn't. Only that process is touched. The
// deadline's error is what the caller gets, with nothing tried again.
//
// A start that is slow but succeeds says nothing about where the time went,
// and on GitHub's Ubuntu runners some starts have taken 24 to 25 seconds to
// open the port, close to puppeteer's 30. So if the port hasn't been
// announced 15 seconds after the process started, this also takes a list of
// the browser's processes then (with the CPU time each has used), and the
// report shows it whether the start then succeeds or fails. It changes no
// timeout.

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
// After a deadline, how long each of these may take: the launch to end once
// aborted, a browser it hands over after all to close, and the process to
// exit, before and after this kills it.
const ABORT_WAIT_MS = 10_000;
const ENDPOINT_LINE = /^WebDriver BiDi listening on ws:\/\//;
// How long after the process starts a start counts as slow (see above).
const SLOW_START_MS = 15_000;

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
function watchLaunch(executablePath, { now = () => performance.now(), slowStartMs = SLOW_START_MS } = {}) {
  const startedAt = now();
  const record = {
    executablePath,
    pid: null,
    spawnedAt: null,
    endpointAt: null,
    lines: [],
    droppedLines: 0,
    finishedAt: null,
    exit: null,
    slowStart: null
  };
  let child = null;
  let stopped = false;
  let slowTimer = null;
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
      slowTimer = setTimeout(() => {
        if (stopped || record.endpointAt !== null || record.exit) return;
        record.slowStart = { at: elapsed(), processes: processSnapshot(record.pid) };
      }, slowStartMs);
      slowTimer.unref?.();
      detach.push(() => clearTimeout(slowTimer));
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
    // Whether the process seen starting is still running.
    get running() {
      return child !== null && record.exit === null;
    },
    // Kills that process, and the group it leads outside Windows (puppeteer
    // starts it as a group leader there). Until its exit is seen, Node
    // hasn't reaped it, so its number can't belong to another process.
    kill() {
      if (!child || record.exit) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
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
// group leader on Linux and macOS), with each one's state, the CPU time it
// has used and, where the system reports it, the kernel function it is
// waiting in.
const SNAPSHOT_COLUMNS = 'pid ppid pgid stat elapsed cpu-time wchan args';
function processSnapshot(pid) {
  if (!pid || process.platform === 'win32') return null;
  let output;
  try {
    output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,etime=,time=,wchan=,args='], {
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

function formatReport({ record, outcome, version, browserVersion, snapshot, error, exitWait, abandoned }) {
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
  if (record.slowStart?.processes) {
    lines.push(`  processes at ${seconds(record.slowStart.at)}, before the port was announced (${SNAPSHOT_COLUMNS}):`);
    for (const row of record.slowStart.processes) lines.push(`    ${row}`);
  }
  if (error) lines.push(`  error: ${String(error.message ?? error).split('\n')[0]}`);
  if (abandoned) lines.push(`  after the deadline: ${abandoned.join('; ')}`);
  if (snapshot) {
    lines.push(`  processes when it failed (${SNAPSHOT_COLUMNS}):`);
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

// `promise`'s outcome, { value } or { error }, or null if it has none
// within `ms`.
async function within(promise, ms) {
  let timer;
  const outcome = Promise.resolve(promise).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  try {
    return await Promise.race([outcome, late]);
  } finally {
    clearTimeout(timer);
  }
}

// Ends a launch that outlasted its deadline (see the top of this file) and
// says what it took, for the report.
async function abandon(launching, controller, watch, reason, wait) {
  const steps = [];
  controller.abort(reason);
  const ended = await within(launching, wait);
  if (ended === null) {
    steps.push(`the launch had not ended ${wait} ms after it was aborted`);
  } else if (ended.error) {
    steps.push(`the aborted launch ended: ${String(ended.error.message ?? ended.error).split('\n')[0]}`);
  } else {
    const closed = await within(Promise.resolve().then(() => ended.value.close()), wait);
    steps.push(`the browser started after the deadline and ${closed === null ? `had not closed within ${wait} ms` : closed.error ? `failed to close (${closed.error.message})` : 'was closed'}`);
  }
  if (watch.running) await watch.waitForExit(wait);
  if (watch.running) {
    watch.kill();
    await watch.waitForExit(wait);
    steps.push(watch.running ? `process ${watch.record.pid} was killed but had not exited within ${wait} ms` : `process ${watch.record.pid} was killed`);
  }
  return steps;
}

// Calls launch(options), which starts Firefox, and prints a report on how the
// start went through `log`. Rethrows the launch's own error unchanged. With
// a `deadline` in ms, the launch is also given `signal`, an AbortSignal, and
// a start that outlasts the deadline is ended (see the top of this file)
// and fails with the deadline's error, whose `code` is 'timeout'.
// `slowStartMs` is when a start counts as slow (SLOW_START_MS; the tests
// shorten it).
async function launchFirefox(launch, options, { log = console.error, exitWait = EXIT_WAIT_MS, deadline = null, abortWait = ABORT_WAIT_MS, slowStartMs = SLOW_START_MS } = {}) {
  const version = installedVersion(options.executablePath);
  const watch = watchLaunch(options.executablePath, { slowStartMs });
  const controller = deadline === null ? null : new AbortController();
  const launching = Promise.resolve().then(() => launch(controller ? { ...options, signal: controller.signal } : options));
  let expired = null;
  let timer;
  let browser;
  try {
    browser = await (controller
      ? Promise.race([
        launching,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            expired = new Error(`Firefox did not start (not done within ${deadline} ms)`);
            expired.code = 'timeout';
            reject(expired);
          }, deadline);
        })
      ])
      : launching);
  } catch (error) {
    watch.record.finishedAt = watch.elapsed();
    // Taken before the process is killed, then wait to see how it ends.
    const snapshot = processSnapshot(watch.record.pid);
    let abandoned = null;
    if (error === expired) abandoned = await abandon(launching, controller, watch, error, abortWait);
    else await watch.waitForExit(exitWait);
    watch.stop();
    log(formatReport({ record: watch.record, outcome: 'failed', version, snapshot, error, exitWait: abandoned ? abortWait : exitWait, abandoned }));
    throw error;
  } finally {
    clearTimeout(timer);
  }
  watch.record.finishedAt = watch.elapsed();
  watch.stop();
  let browserVersion;
  if (controller) {
    // Given a deadline, asking for the version can't hold the start up either.
    const answer = await within(Promise.resolve().then(() => browser.version()), abortWait);
    browserVersion = answer === null ? `unavailable (no answer within ${abortWait} ms)` : answer.error ? `unavailable (${answer.error.message})` : answer.value;
  } else {
    browserVersion = await Promise.resolve()
      .then(() => browser.version())
      .catch((error) => `unavailable (${error.message})`);
  }
  log(formatReport({ record: watch.record, outcome: 'succeeded', version, browserVersion }));
  return browser;
}

module.exports = { ABORT_WAIT_MS, MAX_LINES, MAX_LINE_LENGTH, SLOW_START_MS, installedVersion, launchFirefox, lineReader };
