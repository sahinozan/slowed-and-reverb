'use strict';

// Nothing here asks an audio context for its output latency: not the
// outputLatency property, and not getOutputTimestamp(), which reads the same
// value in Firefox. In Firefox 160.0 on Linux with PulseAudio, a page's first
// such read while the context plays can stop the page for good. The stacks
// show the page waiting for Firefox's main process, the main process for
// PulseAudio's thread, that thread for the page to hand over its next sound,
// and the page's own audio threads waiting in turn, most likely for a lock
// the read holds (issue 186). Every other page's sound stops with it until
// the page's process ends. The audio suites' snapshot read the property, and
// most runs on GitHub's Ubuntu runners failed in one check or another: the 5
// the issue began with, and 6 of the 8 made while looking for the cause.
//
// The browser tests are kept from it so they can finish, and the extension
// and the website so they can't set it off in a user's page.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { root } = require('./helpers/load-script');
const { trackedFiles } = require('./helpers/workflow-paths');

const FOLDERS = ['e2e', 'extension', 'scripts', 'site'];
const LATENCY = /\b(?:outputLatency|getOutputTimestamp)\b/;

// The lines of these files that name either, as "file:line". A comment
// closed on its line is taken out first, so code after it is still read; a
// line that is then only a comment is left out. A name put together while
// the code runs isn't seen.
function latencyReads(sources) {
  return Object.entries(sources).flatMap(([file, text]) =>
    text.split('\n').flatMap((line, index) => {
      const code = line.replace(/\/\*.*?\*\//g, '');
      return /^\s*(?:\/\/|\/\*|\*)/.test(code) || !LATENCY.test(code) ? [] : [`${file}:${index + 1}`];
    })
  );
}

test('nothing asks an audio context for its output latency', () => {
  const files = FOLDERS.flatMap((folder) => trackedFiles(folder)).filter((file) => /\.(?:js|mjs|html)$/.test(file));
  assert.ok(files.includes('e2e/audio-capture/capture-observer.js'), 'the audio suites are among the files read');
  assert.ok(files.includes('e2e/ui/site.spec.js'), 'the website tests are among the files read');
  assert.ok(files.includes('extension/youtube-main.js'), 'the engines are among the files read');
  const sources = Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  assert.deepEqual(latencyReads(sources), []);
});

test('a read of the output latency is found, and a comment about it is not', () => {
  const sources = {
    'a.js': ['const context = new AudioContext();', '// its outputLatency is left alone', 'const late = context.outputLatency ?? 0;'].join('\n'),
    'b.js': ['const { outputLatency } = context;', ' * outputLatency in a comment block', '/* and getOutputTimestamp here */'].join('\n'),
    'c.js': 'const latency = context.baseLatency;',
    'd.js': ['const { contextTime } = context.getOutputTimestamp();', "const late = context['outputLatency'];"].join('\n'),
    'e.js': ['/* evidence */ outputLatency: entry.context.outputLatency,', 'const sum = 1; /* not outputLatency */'].join('\n')
  };
  assert.deepEqual(latencyReads(sources), ['a.js:3', 'b.js:1', 'd.js:1', 'd.js:2', 'e.js:1']);
});
