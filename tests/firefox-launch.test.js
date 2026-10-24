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
const { describe, test } = require('node:test');

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

// A process that lives until it is killed, as a Firefox that hangs would,
// started by a stand-in for puppeteer.launch that calls `then(child, options)`
// for what the launch does next.
function hangingLaunch(then) {
  return (options) => {
    const child = spawn(options.executablePath, ['-e', 'setInterval(() => {}, 1000);'], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return then(child, options);
  };
}

function deadlineLaunch(launchFunction, helperOptions) {
  const reports = [];
  const result = launchFirefox(launchFunction, { executablePath: process.execPath }, {
    log: (report) => reports.push(report),
    deadline: 200,
    abortWait: 1_000,
    ...helperOptions
  });
  return { result, reports };
}

const deadlineError = (error) => error.code === 'timeout' && /^Firefox did not start \(not done within 200 ms\)$/.test(error.message);

describe('a start given a deadline', () => {
  test('passes no signal without one, and returns a start within it unchanged', async () => {
    let given;
    const plain = launchFirefox(async (options) => ((given = options), { version: async () => 'fake/1.0' }), { executablePath: process.execPath }, { log: () => {} });
    await plain;
    assert.equal('signal' in given, false);
    const { result, reports } = deadlineLaunch(async (options) => ((given = options), { version: async () => 'fake/1.0' }));
    await result;
    assert.ok(given.signal instanceof globalThis.AbortSignal);
    assert.equal(given.signal.aborted, false);
    assert.match(reports[0], /^Firefox start succeeded/);
  });

  test('aborts a launch that outlasts it and waits for the browser to end, as puppeteer does on abort', async () => {
    let child;
    let signal;
    const { result, reports } = deadlineLaunch(
      hangingLaunch((started, options) => {
        child = started;
        signal = options.signal;
        // As @puppeteer/browsers: the abort kills the process, and the
        // launch rejects once it has exited.
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => started.kill('SIGKILL'), { once: true });
          started.once('exit', () => reject(new Error('Failed to launch the browser process: Code: null')));
        });
      })
    );
    await assert.rejects(result, deadlineError);
    assert.equal(signal.aborted, true);
    assert.equal(child.signalCode, 'SIGKILL');
    assert.match(reports[0], /^Firefox start failed after 0\.\d s: /);
    assert.match(reports[0], /after the deadline: the aborted launch ended: Failed to launch the browser process/);
    assert.match(reports[0], /process exited with code null, signal SIGKILL/);
    assert.equal(diagnosticsChannel.hasSubscribers('child_process'), false);
  });

  test('closes a browser that starts after it', async () => {
    let child;
    const closed = [];
    const { result, reports } = deadlineLaunch(
      hangingLaunch((started) => {
        child = started;
        // The session started at 300 ms, after the deadline, whatever the
        // signal said.
        return new Promise((resolve) =>
          setTimeout(() => resolve({ close: async () => (closed.push(true), started.kill('SIGKILL')) }), 300)
        );
      })
    );
    await assert.rejects(result, deadlineError);
    // Closed before the start's failure was handed back, not later.
    assert.deepEqual(closed, [true]);
    await ended(child);
    assert.match(reports[0], /after the deadline: the browser started after the deadline and was closed/);
    assert.doesNotMatch(reports[0], /was killed/);
  });

  test('kills the process it started when the launch neither ends nor closes', async () => {
    for (const late of ['never ends', 'never closes']) {
      let child;
      const { result, reports } = deadlineLaunch(
        hangingLaunch((started) => {
          child = started;
          return late === 'never ends' ? new Promise(() => {}) : new Promise((resolve) => setTimeout(() => resolve({ close: () => new Promise(() => {}) }), 300));
        }),
        { abortWait: 300 }
      );
      await assert.rejects(result, deadlineError);
      assert.ok(child.signalCode === 'SIGKILL', late);
      const said = late === 'never ends' ? /the launch had not ended 300 ms after it was aborted/ : /started after the deadline and had not closed within 300 ms/;
      assert.match(reports[0], said, late);
      assert.match(reports[0], new RegExp(`process ${child.pid} was killed(;|$)`, 'm'), late);
    }
  });

  test('leaves other processes from the same executable alone', async () => {
    // One started before the start and one after it, as another Firefox
    // would be.
    const before = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    let after;
    let child;
    try {
      const { result } = deadlineLaunch(
        hangingLaunch((started) => {
          child = started;
          after = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
          return new Promise(() => {});
        }),
        { abortWait: 300 }
      );
      await assert.rejects(result, deadlineError);
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(before.exitCode ?? before.signalCode, null);
      assert.equal(after.exitCode ?? after.signalCode, null);
    } finally {
      for (const other of [before, after]) other?.kill('SIGKILL');
      await Promise.all([before, after].filter(Boolean).map(ended));
    }
  });

  test('passes on a launch that fails within it unchanged', async () => {
    const failure = new Error('Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!');
    const { result, reports } = deadlineLaunch(
      hangingLaunch((started) => {
        setTimeout(() => started.kill('SIGKILL'), 20);
        return new Promise((resolve, reject) => started.once('exit', () => reject(failure)));
      })
    );
    await assert.rejects(result, (error) => error === failure);
    assert.doesNotMatch(reports[0], /after the deadline/);
  });
});

// Node standing in for Firefox, for the installed puppeteer: `announce`
// prints the WebDriver BiDi line for a WebSocket server that completes the
// handshake and then answers nothing, so session.new never comes back.
function standIn(directory, { announce }) {
  const executablePath = path.join(directory, 'firefox');
  fs.writeFileSync(
    executablePath,
    `#!${process.execPath}
    const announce = ${announce};
    if (!announce) { console.error('*** You are running in headless mode.'); setInterval(() => {}, 1000); }
    else {
      const crypto = require('node:crypto');
      const server = require('node:http').createServer();
      server.on('upgrade', (request, socket) => {
        const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
        socket.on('data', () => {});
        console.error('session requested');
      });
      server.listen(0, '127.0.0.1', () => console.error('WebDriver BiDi listening on ws://127.0.0.1:' + server.address().port));
    }
    `,
    { mode: 0o755 }
  );
  return executablePath;
}

for (const [phase, announce, pattern] of [
  ['the port is never announced', false, /WebDriver BiDi port announced at never/],
  ['the session never starts', true, /stderr: session requested/]
]) {
  test(
    `ends the installed puppeteer's start at the deadline when ${phase}`,
    { skip: process.platform === 'win32' && 'the stand-in is started through a #! line', timeout: 20_000 },
    async (t) => {
      const puppeteer = require('puppeteer-core');
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'firefox-launch-test-'));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const executablePath = standIn(directory, { announce });
      let child;
      const onSpawn = ({ process: started }) => process.nextTick(() => {
        if (started.spawnfile === executablePath) child = started;
      });
      diagnosticsChannel.subscribe('child_process', onSpawn);
      t.after(() => diagnosticsChannel.unsubscribe('child_process', onSpawn));
      const reports = [];
      const started = Date.now();
      // Puppeteer's own timeouts, 10 s for the port and 10 s for the
      // session, are far beyond the deadline, so only the abort ends it.
      const launching = launchFirefox(
        (options) => puppeteer.launch(options),
        { browser: 'firefox', executablePath, headless: true, timeout: 10_000, protocolTimeout: 10_000 },
        { log: (report) => reports.push(report), deadline: 1_500, abortWait: 3_000 }
      );
      await assert.rejects(launching, (error) => error.code === 'timeout' && /within 1500 ms/.test(error.message));
      assert.ok(Date.now() - started < 6_000);
      assert.ok(child, 'the stand-in was started');
      assert.equal(child.signalCode, 'SIGKILL');
      const [report] = reports;
      assert.match(report, pattern);
      assert.match(report, /after the deadline: the aborted launch ended: /);
      assert.doesNotMatch(report, /was killed/);
      assert.equal(diagnosticsChannel.hasSubscribers('child_process'), true);
    }
  );
}
