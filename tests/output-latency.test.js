'use strict';

// Nothing here reads an audio context's output latency. In Firefox 160.0 on
// Linux with PulseAudio, reading it while the context plays can stop the page
// for good: the page waits for Firefox's main process, which waits for
// PulseAudio's thread, which waits for the page to hand over its next sound,
// which waits for the page (issue 186). Every other page's sound stops with
// it until the page's process ends. The audio suites' snapshot read it, and
// so each run on GitHub's Ubuntu runners failed in one check or another.
//
// The browser tests are kept from it so they can finish, and the extension
// and the website so their users' pages can't stop this way.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { root } = require('./helpers/load-script');
const { trackedFiles } = require('./helpers/workflow-paths');

const FOLDERS = ['e2e', 'extension', 'scripts', 'site'];

// The lines of these files that read the property, as "file:line". A line
// that is only a comment is left out. A name put together while the code
// runs isn't seen.
function latencyReads(sources) {
  return Object.entries(sources).flatMap(([file, text]) =>
    text.split('\n').flatMap((line, index) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) || !/\boutputLatency\b/.test(line) ? [] : [`${file}:${index + 1}`]))
  );
}

test("nothing reads an audio context's output latency", () => {
  const files = FOLDERS.flatMap((folder) => trackedFiles(folder)).filter((file) => /\.(?:js|mjs|html)$/.test(file));
  assert.ok(files.includes('e2e/audio-capture/capture-observer.js'), 'the audio suites are among the files read');
  assert.ok(files.includes('extension/youtube-main.js'), 'the engines are among the files read');
  const sources = Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  assert.deepEqual(latencyReads(sources), []);
});

test('a read of the output latency is found, and a comment about it is not', () => {
  const sources = {
    'a.js': ['const context = new AudioContext();', '// its outputLatency is left alone', 'const late = context.outputLatency ?? 0;'].join('\n'),
    'b.js': ['const { outputLatency } = context;', ' * outputLatency in a comment block'].join('\n'),
    'c.js': 'const latency = context.baseLatency;'
  };
  assert.deepEqual(latencyReads(sources), ['a.js:3', 'b.js:1']);
});
