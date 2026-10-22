'use strict';

// e2e/firefox-launch.js, with Node standing in for Firefox and a stand-in for
// puppeteer.launch that waits for the WebDriver BiDi line as puppeteer does,
// reading whole lines with readline and matching them with puppeteer's
// pattern. One test runs the installed puppeteer itself against a Node
// stand-in.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const diagnosticsChannel = require('node:diagnostics_channel');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { test } = require('node:test');

const { MAX_LINES, MAX_LINE_LENGTH, installedVersion, launchFirefox, lineReader } = require('../e2e/firefox-launch');

const ENDPOINT = 'WebDriver BiDi listening on ws://127.0.0.1:9222';
// WEBDRIVER_BIDI_WEBSOCKET_ENDPOINT_REGEX in @puppeteer/browsers.
const PUPPETEER_ENDPOINT = /^WebDriver BiDi listening on (ws:\/\/.*)$/;

// Starts Node with `script` and resolves once it prints the endpoint line, or
// rejects after `timeout` ms and kills it `killAfter` ms later.
function fakeLaunch(script, { timeout = 2_000, killAfter = 100, onChild } = {}) {
  return (options) =>
    new Promise((resolve, reject) => {
      // Puppeteer starts the browser as a process group leader outside Windows.
      const child = spawn(options.executablePath, ['-e', script], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      onChild?.(child);
      // Both streams stay read after the start, as puppeteer reads them.
      const lines = [readline.createInterface(child.stdout), readline.createInterface(child.stderr)];
      const onLine = (line) => {
        if (!PUPPETEER_ENDPOINT.test(line)) return;
        stopWaiting();
        resolve({ child, version: async () => 'fake/1.0' });
      };
      const stopWaiting = () => {
        clearTimeout(timer);
        for (const rl of lines) rl.off('line', onLine);
      };
      for (const rl of lines) rl.on('line', onLine);
      const timer = setTimeout(() => {
        stopWaiting();
        setTimeout(() => child.kill('SIGKILL'), killAfter).unref();
        reject(new Error(`Timed out after ${timeout} ms while waiting for the WS endpoint URL to appear in stdout!`));
      }, timeout);
    });
}

async function launch(script, launchOptions, helperOptions) {
  const reports = [];
  const result = launchFirefox(fakeLaunch(script, launchOptions), { executablePath: process.execPath }, {
    log: (report) => reports.push(report),
    ...helperOptions
  });
  return { result, reports };
}

function ended(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve));
}

test('reports a successful start with the time the endpoint appeared and the output', async () => {
  const { result, reports } = await launch(
    `console.log('starting'); setTimeout(() => console.error(${JSON.stringify(ENDPOINT)}), 50); setTimeout(() => {}, 5000);`
  );
  const browser = await result;
  try {
    assert.equal(reports.length, 1);
    const [report] = reports;
    assert.match(report, /^Firefox start succeeded after \d+\.\d s: /);
    assert.match(report, /browser reports: fake\/1\.0/);
    assert.match(report, new RegExp(`process ${browser.child.pid} started at`));
    assert.match(report, /WebDriver BiDi port announced at \d+\.\d s/);
    assert.match(report, /\+\d+\.\d s stdout: starting/);
    assert.match(report, /\+\d+\.\d s stderr: WebDriver BiDi listening/);
    assert.equal(diagnosticsChannel.hasSubscribers('child_process'), false);
  } finally {
    browser.child.kill('SIGKILL');
    await ended(browser.child);
  }
});

test('lets go of the browser output after a start without pausing it', { timeout: 20_000 }, async () => {
  // Writes far more than a pipe holds after it starts, then exits.
  const script = `
    console.error(${JSON.stringify(ENDPOINT)});
    setTimeout(() => {
      const line = 'x'.repeat(1000) + '\\n';
      for (let i = 0; i < 2000; i += 1) process.stderr.write(line);
      process.exit(0);
    }, 100);`;
  const { result } = await launch(script);
  const browser = await result;
  assert.equal(browser.child.stderr.readableFlowing, true);
  assert.equal(browser.child.stderr.listenerCount('data'), 1);
  await ended(browser.child);
  assert.equal(browser.child.exitCode, 0);
});

test('reports a start that times out, with the processes and how the browser ended', async () => {
  let child;
  const { result, reports } = await launch(
    "console.error('*** You are running in headless mode.'); setInterval(() => {}, 1000);",
    { timeout: 300, killAfter: 200, onChild: (started) => (child = started) }
  );
  await assert.rejects(result, /Timed out after 300 ms while waiting for the WS endpoint URL/);
  assert.equal(reports.length, 1);
  const [report] = reports;
  assert.match(report, /^Firefox start failed after \d+\.\d s: /);
  assert.match(report, /WebDriver BiDi port announced at never/);
  assert.match(report, /error: Timed out after 300 ms/);
  assert.match(report, /stderr: \*\*\* You are running in headless mode\./);
  assert.match(report, /process exited with code null, signal SIGKILL at/);
  if (process.platform !== 'win32') {
    assert.match(report, new RegExp(`processes when it failed[^\\n]*\\n\\s+${child.pid}\\s`));
  }
  assert.equal(diagnosticsChannel.hasSubscribers('child_process'), false);
});

test('says when the browser is still running after the wait', async () => {
  let child;
  const { result, reports } = await launch(
    'setInterval(() => {}, 1000);',
    { timeout: 200, killAfter: 5_000, onChild: (started) => (child = started) },
    { exitWait: 100 }
  );
  await assert.rejects(result, /Timed out/);
  assert.match(reports[0], /process still running 0\.1 s after the failure/);
  child.kill('SIGKILL');
  await ended(child);
});

test('keeps only the first lines of a long output', async () => {
  const script = `
    for (let i = 0; i < ${MAX_LINES + 50}; i += 1) console.error('line ' + i + ' ' + 'y'.repeat(600));
    console.error(${JSON.stringify(ENDPOINT)});
    setTimeout(() => {}, 5000);`;
  const { result, reports } = await launch(script);
  const browser = await result;
  try {
    const [report] = reports;
    assert.match(report, new RegExp(`output \\(${MAX_LINES} lines, 51 more not kept\\)`));
    assert.match(report, /stderr: line 0 y+…\n/);
    assert.doesNotMatch(report, new RegExp(`line ${MAX_LINES} `));
    // The endpoint line came after the kept lines but is still timed.
    assert.match(report, /WebDriver BiDi port announced at \d+\.\d s/);
  } finally {
    browser.child.kill('SIGKILL');
    await ended(browser.child);
  }
});

test('reads the installed version from application.ini beside the executable', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'firefox-launch-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'firefox');
  fs.writeFileSync(executable, '');
  assert.match(installedVersion(executable), /^unknown \(no application\.ini near /);
  fs.writeFileSync(
    path.join(directory, 'application.ini'),
    '[App]\nVendor=Mozilla\nName=Firefox\nVersion=157.0\nBuildID=20261006000000\n'
  );
  assert.match(installedVersion(executable), /^157\.0 \(build 20261006000000, .*application\.ini\)$/);
  assert.match(installedVersion(path.join(directory, 'missing')), /^unknown \(ENOENT\)$/);
});

// The lines lineReader finds in `chunks`, leaving out empty ones, which the
// report and puppeteer both skip.
function readLines(chunks) {
  const lines = [];
  const reader = lineReader((text, cut) => {
    if (text) lines.push({ text, cut });
  });
  for (const chunk of chunks) reader.write(chunk);
  reader.end();
  return lines;
}

function chunked(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

test('keeps cutting a long line until it really ends, however the output is split', () => {
  const output = [
    'x'.repeat(MAX_LINE_LENGTH + 1) + ENDPOINT + '\n',
    'y'.repeat(MAX_LINE_LENGTH * 3) + '\r\n',
    ENDPOINT + '\n',
    'e'.repeat(MAX_LINE_LENGTH) + '\n',
    'before\rafter\n',
    'z'.repeat(MAX_LINE_LENGTH + 200)
  ].join('');
  const expected = [
    { text: 'x'.repeat(MAX_LINE_LENGTH), cut: true },
    { text: 'y'.repeat(MAX_LINE_LENGTH), cut: true },
    { text: ENDPOINT, cut: false },
    { text: 'e'.repeat(MAX_LINE_LENGTH), cut: false },
    { text: 'before', cut: false },
    { text: 'after', cut: false },
    { text: 'z'.repeat(MAX_LINE_LENGTH), cut: true }
  ];
  // The announcement arriving on its own after an unfinished long line is
  // still part of that line.
  assert.deepEqual(readLines(['x'.repeat(MAX_LINE_LENGTH + 1), ENDPOINT + '\n']), [
    { text: 'x'.repeat(MAX_LINE_LENGTH), cut: true }
  ]);
  for (const size of [1, 2, 3, 7, 64, MAX_LINE_LENGTH - 1, MAX_LINE_LENGTH, MAX_LINE_LENGTH + 1, 1000, output.length]) {
    assert.deepEqual(readLines(chunked(output, size)), expected, `chunks of ${size}`);
  }
});

test('holds no more than one line of text however long a line runs', () => {
  const lines = [];
  const reader = lineReader((text, cut) => lines.push({ length: text.length, cut }));
  const chunk = 'w'.repeat(64 * 1024);
  for (let i = 0; i < 64; i += 1) {
    reader.write(chunk);
    assert.ok(reader.buffered <= MAX_LINE_LENGTH);
  }
  assert.deepEqual(lines, []);
  reader.write('\nnext');
  assert.deepEqual(lines, [{ length: MAX_LINE_LENGTH, cut: true }]);
  assert.equal(reader.buffered, 4);
  reader.end();
  assert.deepEqual(lines, [
    { length: MAX_LINE_LENGTH, cut: true },
    { length: 4, cut: false }
  ]);
});

test('reports a long line written in pieces as one line and finds the announcement after it', async () => {
  // Pieces written a moment apart usually reach the test as separate chunks.
  const script = `
    const pieces = Array.from({ length: 7 }, () => 'y'.repeat(100));
    const next = () => {
      if (pieces.length) {
        process.stderr.write(pieces.shift());
        setTimeout(next, 10);
      } else {
        process.stderr.write('\\n' + ${JSON.stringify(ENDPOINT)} + '\\n');
      }
    };
    next();
    setTimeout(() => {}, 5000);`;
  const { result, reports } = await launch(script);
  const browser = await result;
  try {
    const [report] = reports;
    assert.match(report, /WebDriver BiDi port announced at \d+\.\d s/);
    assert.match(report, /output \(2 lines\):\n/);
    assert.match(report, new RegExp(`stderr: y{${MAX_LINE_LENGTH}}…\\n.*stderr: ${ENDPOINT}$`));
  } finally {
    browser.child.kill('SIGKILL');
    await ended(browser.child);
  }
});

test(
  'does not report an announcement that puppeteer itself rejects',
  { skip: process.platform === 'win32' && 'the stand-in is started through a #! line', timeout: 20_000 },
  async (t) => {
    const puppeteer = require('puppeteer-core');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'firefox-launch-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    // Node standing in for Firefox: the announcement continues an unfinished
    // long line, so puppeteer never sees a line that starts with it.
    const executablePath = path.join(directory, 'firefox');
    fs.writeFileSync(
      executablePath,
      `#!${process.execPath}
      process.stderr.write('x'.repeat(${MAX_LINE_LENGTH + 1}));
      setTimeout(() => process.stderr.write(${JSON.stringify(ENDPOINT + '\n')}), 60);
      setTimeout(() => process.exit(0), 1_500);
      `,
      { mode: 0o755 }
    );
    const reports = [];
    let original;
    const launching = launchFirefox(
      (options) =>
        puppeteer.launch(options).catch((error) => {
          original = error;
          throw error;
        }),
      { browser: 'firefox', executablePath, headless: true, timeout: 1_000 },
      { log: (report) => reports.push(report) }
    );
    await assert.rejects(launching, (error) => error === original);
    assert.match(original.message, /Timed out after 1000 ms while waiting for the WS endpoint URL/);
    const [report] = reports;
    assert.match(report, /WebDriver BiDi port announced at never/);
    assert.match(report, new RegExp(`output \\(1 lines\\):\\n\\s+\\+\\d+\\.\\d s stderr: x{${MAX_LINE_LENGTH}}…$`));
    assert.equal(diagnosticsChannel.hasSubscribers('child_process'), false);
  }
);
