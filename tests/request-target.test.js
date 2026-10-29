'use strict';

// The local servers (the site and popup previews, and the browser tests'
// fixtures) against request targets URL can't parse, which used to throw out
// of their request listeners and stop them, and against the targets they
// serve. Each request is sent as written, with http.request's `path` or over
// a raw socket: fetch() would parse the address itself first.
// e2e/ui/site.spec.js checks the site tests' own listener, which holds
// answers back.

const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const { requestPathname } = require('../scripts/request-target');
const { createSiteServer } = require('../scripts/serve-site');
const { startServer } = require('../scripts/popup-preview');
const { startFixtureServer } = require('../e2e/extension-copy');
const { createStereoToneWav, TONE, TONE_B, startTrialServer } = require('../e2e/audio-capture/fixture');

const root = path.join(__dirname, '..');

// Targets Node's HTTP parser passes to the listener and URL can't parse:
// the reported ones (an empty IPv6 host), other spellings of a broken host
// or port, in origin, network-path and absolute form, and backslashes, which
// URL reads as slashes in an http address.
const UNPARSABLE = [
  '//[', '//%5B', '//%5b', '//[/x', '//[::1', '//[::1]:99999', '//h:99999/x', '//h:abc/x', '//',
  'http://%5B/guide', 'HTTP://[/x', 'http://[::1/x', 'http://', '/\\[', '/\\%5B'
];

// Sends one request with `target` as written and resolves with the answer.
function send(port, target, { method = 'GET', host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: target, agent: false, headers: { host } });
    request.setTimeout(5_000, () => request.destroy(new Error(`no answer to ${method} ${target}`)));
    request.on('error', reject);
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.end();
  });
}

// Writes `text` to a new connection and resolves with everything the server
// sends back before it closes the connection or `waitMs` passes. Once
// connected, it waits for `beforeWrite(socket)`, if given, before writing.
function sendRaw(port, text, { waitMs = 2_000, beforeWrite } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const socket = net.connect(port, '127.0.0.1', async () => {
      await beforeWrite?.(socket);
      socket.write(text);
    });
    const timer = setTimeout(() => socket.destroy(), waitMs);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
  });
}

async function expectRejected(port, target) {
  const answer = await send(port, target);
  assert.equal(answer.status, 400, target);
  assert.equal(answer.body.length, 0, target);
}

// Every unparsable target gets an empty 400, then the same server, still
// listening, answers `control`.
async function checkUnparsable(port, control) {
  for (const target of UNPARSABLE) await expectRejected(port, target);
  const answer = await send(port, control);
  assert.equal(answer.status, 200, control);
}

describe('requestPathname', () => {
  function fakeResponse() {
    const calls = [];
    return {
      calls,
      writeHead(status) {
        calls.push(['writeHead', status]);
        return this;
      },
      end() {
        calls.push(['end']);
        return this;
      }
    };
  }

  test("returns the pathname URL parses, as URL parses it, and doesn't answer", () => {
    for (const [target, pathname] of [
      ['/guide?v=1', '/guide'],
      ['/%70opup.html', '/%70opup.html'],
      ['/gu%69de', '/gu%69de'],
      ['/a/../guide', '/guide'],
      ['/%2e%2e/x', '/x'],
      ['///guide', '/'],
      ['http://example.com/guide', '/guide'],
      ['//[::1]:8080/guide', '/guide'],
      ['*', '/*']
    ]) {
      const response = fakeResponse();
      assert.equal(requestPathname({ url: target }, response, 'http://localhost'), pathname, target);
      assert.equal(pathname, new URL(target, 'http://localhost').pathname, target);
      assert.deepEqual(response.calls, [], target);
    }
  });

  test('answers an empty 400 and returns null for a target URL throws on', () => {
    for (const target of UNPARSABLE) {
      assert.throws(() => new URL(target, 'http://127.0.0.1'), { code: 'ERR_INVALID_URL' }, target);
      const response = fakeResponse();
      assert.equal(requestPathname({ url: target }, response, 'http://127.0.0.1'), null, target);
      assert.deepEqual(response.calls, [['writeHead', 400], ['end']], target);
    }
  });

  test("leaves the response's own errors to the caller", () => {
    const response = {
      writeHead() {
        throw new Error('the response failed');
      }
    };
    assert.throws(() => requestPathname({ url: '//[' }, response, 'http://localhost'), /the response failed/);
  });

  test('is how every local server reads its request target', () => {
    for (const file of [
      'scripts/serve-site.js',
      'scripts/popup-preview.js',
      'e2e/extension-copy.js',
      'e2e/audio-capture/fixture.js',
      'e2e/ui/site.spec.js'
    ]) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      // Playwright's request.url() in site.spec.js is a browser's request, not the server's.
      assert.ok(!/new URL\(request\.url,/.test(source), `${file} parses request.url itself`);
      assert.ok(
        /const pathname = requestPathname\(request, response, '[^']+'\);\n\s+if \(pathname === null\) return;/.test(source),
        `${file} doesn't return at once after requestPathname's 400`
      );
    }
  });
});

describe('the site preview (scripts/serve-site.js)', () => {
  let server;
  let port;
  const requests = [];
  const openSockets = new Set();

  // Resolves with the server's end of `client`'s connection. While `client`
  // is connected, no other open connection can have its port.
  function accepted(client) {
    return new Promise((resolve) => {
      const find = () => {
        const socket = [...openSockets].find((open) => open.remotePort === client.localPort);
        if (!socket) return false;
        server.off('connection', find);
        resolve(socket);
        return true;
      };
      if (!find()) server.on('connection', find);
    });
  }

  before(async () => {
    server = createSiteServer();
    server.on('connection', (socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
    });
    server.on('request', (request) => requests.push({ url: request.url, socket: request.socket }));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    ({ port } = server.address());
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test('answers unparsable targets with an empty 400 and keeps serving', async () => {
    await checkUnparsable(port, '/guide');
  });

  test('keeps serving after unparsable targets on the same connection', async () => {
    const text = await sendRaw(port, [
      'GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
      'GET //%5B HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
      'GET /guide HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    ].join(''));
    const statuses = text.match(/^HTTP\/1\.1 \d+/gm);
    assert.deepEqual(statuses, ['HTTP/1.1 400', 'HTTP/1.1 400', 'HTTP/1.1 200']);
  });

  test("leaves to Node the targets its HTTP parser refuses, and CONNECT, which isn't a request here", async () => {
    // Only requests from this test's own connections count: other programs
    // on a developer's computer may send their own requests to any local
    // port (T3 Code sends GET / to each one every 15 seconds or so). They
    // are told apart by the server's socket, not the port, which a later
    // connection can reuse.
    const ours = new Set();
    const ourConnection = async (client) => ours.add(await accepted(client));
    const reached = () => requests.filter((request) => ours.has(request.socket)).map((request) => request.url);
    for (const target of ['\\\\[', '\\/[']) {
      const text = await sendRaw(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`, { beforeWrite: ourConnection });
      assert.match(text, /^HTTP\/1\.1 400 Bad Request\r\n/, target);
    }
    // With no 'connect' listener, Node closes a CONNECT's connection itself.
    const connect = await sendRaw(port, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n', { beforeWrite: ourConnection });
    assert.equal(connect, '');
    assert.equal(ours.size, 3);
    assert.deepEqual(reached(), [], 'none of them reaches the request listener');
    // A request that reaches it is counted, and the server is still serving.
    const control = await sendRaw(port, 'GET /guide HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n', { beforeWrite: ourConnection });
    assert.match(control, /^HTTP\/1\.1 200 /);
    assert.deepEqual(reached(), ['/guide']);
  });

  test('serves pages at clean addresses, ignoring the query, and redirects .html addresses', async () => {
    const guide = fs.readFileSync(path.join(root, 'site/guide.html'));
    for (const target of ['/guide', '/guide?v=x', '/guide?x=//%5B', '/gu%69de', 'http://example.com/guide', '//[::1]:8080/guide']) {
      const answer = await send(port, target);
      assert.equal(answer.status, 200, target);
      assert.equal(answer.headers['content-type'], 'text/html; charset=utf-8', target);
      assert.equal(answer.headers['cache-control'], 'no-store', target);
      assert.deepEqual(answer.body, guide, target);
    }
    const home = await send(port, '/');
    assert.equal(home.status, 200);
    assert.deepEqual(home.body, fs.readFileSync(path.join(root, 'site/index.html')));
    const style = await send(port, '/styles.css?v=1');
    assert.equal(style.status, 200);
    assert.equal(style.headers['content-type'], 'text/css; charset=utf-8');

    for (const [target, location] of [
      ['/index.html', '/'],
      ['/guide.html?v=x', '/guide'],
      ['//example.com/guide.html?v=1', '/guide']
    ]) {
      const answer = await send(port, target);
      assert.equal(answer.status, 307, target);
      assert.equal(answer.headers.location, location, target);
    }
  });

  test('answers 404 with the 404 page for missing, hidden, malformed and climbing addresses', async () => {
    const notFound = fs.readFileSync(path.join(root, 'site/404.html'));
    for (const target of [
      '/no-such-page', '/README.md', '/.assetsignore', '/%E0%A4%A', '/..%2fpackage.json',
      '/guide%252ehtml', '/%2e%2e/package.json'
    ]) {
      const answer = await send(port, target);
      assert.equal(answer.status, 404, target);
      assert.equal(answer.headers['content-type'], 'text/html; charset=utf-8', target);
      assert.equal(answer.headers['cache-control'], 'no-store', target);
      assert.deepEqual(answer.body, notFound, target);
    }
    // OPTIONS * reaches the listener and parses as /*, which isn't a page.
    const options = await send(port, '*', { method: 'OPTIONS' });
    assert.equal(options.status, 404);
  });
});

test('the standalone site preview keeps running after an unparsable target', async () => {
  const free = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const child = spawn(process.execPath, [path.join(root, 'scripts/serve-site.js'), String(free)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the preview didn't start: ${stderr}`)), 10_000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('site/ at')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', () => reject(new Error(`the preview stopped: ${stderr}`)));
    });
    await expectRejected(free, '//[');
    await expectRejected(free, '//%5B');
    assert.equal((await send(free, '/guide')).status, 200);
    const stillRunning = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('running'), 200))]);
    assert.equal(stillRunning, 'running', stderr);
  } finally {
    child.kill();
    await exited;
  }
});

describe('the popup preview (scripts/popup-preview.js)', () => {
  let temp;
  let server;
  let port;
  let late;

  before(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'request-target-'));
    fs.writeFileSync(path.join(temp, 'other-popup.html'), '<p>replaced</p>');
    late = path.join(temp, 'late.png');
    server = await startServer(new Map([
      ['/popup.html', path.join(temp, 'other-popup.html')],
      ['/late.png', late]
    ]));
    port = Number(new URL(server.baseUrl).port);
  });

  after(async () => {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  test('answers unparsable targets with an empty 400 and keeps serving', async () => {
    await checkUnparsable(port, '/popup.css');
  });

  test('serves its own files, with the routes given overriding them', async () => {
    for (const [target, file, type] of [
      ['/popup.css', 'extension/popup.css', 'text/css; charset=utf-8'],
      ['/popup.js?v=1', 'extension/popup.js', 'text/javascript; charset=utf-8'],
      ['http://example.com/settings.js', 'extension/settings.js', 'text/javascript; charset=utf-8']
    ]) {
      const answer = await send(port, target);
      assert.equal(answer.status, 200, target);
      assert.equal(answer.headers['content-type'], type, target);
      assert.equal(answer.headers['cache-control'], 'no-store', target);
      assert.deepEqual(answer.body, fs.readFileSync(path.join(root, file)), target);
    }
    const replaced = await send(port, '/popup.html');
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.toString(), '<p>replaced</p>');
  });

  test("serves a route's file once it's written, and nothing at addresses it doesn't list", async () => {
    assert.equal((await send(port, '/late.png')).status, 404);
    fs.writeFileSync(late, 'png');
    const answer = await send(port, '/late.png');
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['content-type'], 'image/png');
    // Its routes are addresses as written: an escaped letter is another address.
    for (const target of ['/%70opup.css', '/popup.css/', '/manifest.json', '*']) {
      const missing = await send(port, target, target === '*' ? { method: 'OPTIONS' } : {});
      assert.equal(missing.status, 404, target);
      assert.equal(missing.body.length, 0, target);
    }
  });
});

describe("the extension tests' audio page (e2e/extension-copy.js)", () => {
  let server;
  let port;

  before(async () => {
    server = await startFixtureServer();
    port = Number(new URL(server.url).port);
  });

  after(() => server.close());

  test('answers unparsable targets with an empty 400 and keeps serving', async () => {
    await checkUnparsable(port, '/');
  });

  test('serves its page at / alone', async () => {
    for (const target of ['/', '/?x=1', 'http://example.com/']) {
      const answer = await send(port, target);
      assert.equal(answer.status, 200, target);
      assert.equal(answer.headers['content-type'], 'text/html; charset=utf-8', target);
      assert.equal(answer.headers['cache-control'], 'no-store', target);
      assert.match(answer.body.toString(), /<audio id="player" controls preload="auto" src="data:audio\/wav;base64,UklGR/, target);
    }
    for (const target of ['/x', '/%2F', '//example.com/x']) {
      const answer = await send(port, target);
      assert.equal(answer.status, 404, target);
      assert.equal(answer.body.length, 0, target);
    }
  });
});

describe("the audio suites' server (e2e/audio-capture/fixture.js)", () => {
  let server;
  let port;

  before(async () => {
    server = await startTrialServer();
    port = Number(new URL(server.youtubeUrl).port);
  });

  after(() => server.close());

  test('answers unparsable targets with an empty 400 and keeps serving', async () => {
    await checkUnparsable(port, '/tone.wav');
  });

  test('serves the same bytes under 127.0.0.1 and localhost', async () => {
    const page = (song) => (body) => {
      const html = body.toString();
      assert.ok(html.includes(`src="${song}"`), song);
      assert.ok(!html.includes('/SONG'));
    };
    const exact = (bytes) => (body) => assert.ok(body.equals(bytes));
    const routes = [
      ['/', 'text/html; charset=utf-8', page('/tone.wav')],
      ['/long', 'text/html; charset=utf-8', page('/tone-long.wav')],
      ['/tone.wav', 'audio/wav', exact(createStereoToneWav())],
      ['/tone-long.wav', 'audio/wav', exact(createStereoToneWav({ ...TONE, seconds: 30 }))],
      ['/tone-b-long.wav', 'audio/wav', exact(createStereoToneWav({ ...TONE_B, seconds: 30 }))],
      [server.workletPath, 'text/javascript; charset=utf-8', exact(fs.readFileSync(path.join(root, 'e2e/audio-capture/recorder-worklet.js')))]
    ];
    assert.equal(new URL(server.spotifyUrl).hostname, 'localhost');
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      for (const [target, type, check] of routes) {
        const answer = await send(port, target, { host });
        assert.equal(answer.status, 200, `${host}${target}`);
        assert.equal(answer.headers['content-type'], type, `${host}${target}`);
        assert.equal(answer.headers['cache-control'], 'no-store', `${host}${target}`);
        assert.equal(Number(answer.headers['content-length']), answer.body.length, `${host}${target}`);
        check(answer.body);
      }
    }
    // The addresses the pages use, through the host's own name.
    for (const base of [server.youtubeUrl, server.spotifyUrl]) {
      const answer = await fetch(new URL('/tone.wav', base));
      assert.equal(answer.status, 200, base);
    }
    for (const target of ['/%74one.wav', '/tone.wav/', '/missing']) {
      const answer = await send(port, target);
      assert.equal(answer.status, 404, target);
      assert.equal(answer.body.length, 0, target);
    }
  });
});
