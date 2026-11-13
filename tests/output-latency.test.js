'use strict';

// Nothing here asks an audio context for its output latency: not the
// property of that name, and not the method that gives the context's output
// timestamp, which reads the same value in Firefox (LATENCY below has both
// names). In Firefox 160.0 on Linux with PulseAudio, a page's first such
// read while the context plays can stop the page for good. The stacks show
// the page waiting for Firefox's main process, the main process for
// PulseAudio's thread, that thread for the page to hand over its next sound,
// and the page's own audio threads waiting in turn, most likely for a lock
// the read holds (issue 186). Every other page's sound stops with it until
// the page's process ends. The audio suites' snapshot read the property, and
// most runs on GitHub's Ubuntu runners failed in one check or another: the 5
// the issue began with, and 6 of the 8 made while looking for the cause.
//
// The browser tests are kept from it so they can finish, and the extension
// and the website so they can't set it off in a user's page.
//
// The two names may not be written in these files at all, in code, in a
// string or in a comment, so there is no telling code from comment to get
// wrong. A comment says "output latency" in words. Only a name put together
// while the code runs isn't seen.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { root } = require('./helpers/load-script');
const { trackedFiles } = require('./helpers/workflow-paths');

const FOLDERS = ['e2e', 'extension', 'scripts', 'site'];
const LATENCY = /\b(?:outputLatency|getOutputTimestamp)\b/;

// The lines of these files that have either name, as "file:line".
function latencyNames(sources) {
  return Object.entries(sources).flatMap(([file, text]) =>
    text.split('\n').flatMap((line, index) => (LATENCY.test(line) ? [`${file}:${index + 1}`] : []))
  );
}

test('nothing asks an audio context for its output latency', () => {
  const files = FOLDERS.flatMap((folder) => trackedFiles(folder)).filter((file) => /\.(?:js|mjs|cjs|html)$/.test(file));
  assert.ok(files.includes('e2e/audio-capture/capture-observer.js'), 'the audio suites are among the files read');
  assert.ok(files.includes('e2e/ui/site.spec.js'), 'the website tests are among the files read');
  assert.ok(files.includes('extension/youtube-main.js'), 'the engines are among the files read');
  assert.ok(files.includes('site/index.html'), "the website's pages are among the files read");
  const sources = Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  assert.deepEqual(latencyNames(sources), []);
});

test('either name is found however it is written, and other latencies are not', () => {
  const sources = {
    'plain.js': ['const context = new AudioContext();', 'const late = context.outputLatency ?? 0;', 'const { outputLatency } = context;'].join('\n'),
    'method.js': 'const { contextTime } = context.getOutputTimestamp();',
    'bracket.js': "const late = context['outputLatency'];",
    'after-comment.js': '/* evidence */ outputLatency: entry.context.outputLatency,',
    'carried-over.js': ['const frames = sampleRate', '  * context.outputLatency;'].join('\n'),
    'template.js': 'const note = `/* ${context.outputLatency} */`;',
    'comment.js': ['// its outputLatency is left alone', ' * getOutputTimestamp in a comment block'].join('\n'),
    'other.js': ['const latency = context.baseLatency;', '// the output latency, in words', 'const outputLatencyMs = 0;'].join('\n')
  };
  assert.deepEqual(latencyNames(sources), [
    'plain.js:2',
    'plain.js:3',
    'method.js:1',
    'bracket.js:1',
    'after-comment.js:1',
    'carried-over.js:2',
    'template.js:1',
    'comment.js:1',
    'comment.js:2'
  ]);
});
