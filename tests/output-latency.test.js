'use strict';

// Nothing here asks an audio context for its output latency: not the
// property of that name, and not the method that gives the context's output
// timestamp, which reads the same value in Firefox (NAMES below has both).
// In Firefox 160.0 on Linux with PulseAudio, a page's first such read while
// the context plays can stop the page for good. The stacks show the page
// waiting for Firefox's main process, the main process for PulseAudio's
// thread, that thread for the page to hand over its next sound, and the
// page's own audio threads waiting in turn, most likely for a lock the read
// holds (issue 186). Every other page's sound stops with it until the page's
// process ends. The audio suites' snapshot read the property, and most runs
// on GitHub's Ubuntu runners failed in one check or another: the 5 the issue
// began with, and 6 of the 8 made while looking for the cause.
//
// The browser tests are kept from it so they can finish, and the extension
// and the website so they can't set it off in a user's page.
//
// The two names may not be written in these files at all, in code, in a
// string or in a comment, so there is no telling code from comment to get
// wrong. A comment says "output latency" in words. A letter written as an
// escape is read as the letter. A longer name that only contains one of
// them, such as a variable for the latency in milliseconds, is left alone.
// What isn't seen: a name put together while the code runs, or one split
// over two lines inside a string.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { root } = require('./helpers/load-script');
const { trackedFiles } = require('./helpers/workflow-paths');

const FOLDERS = ['e2e', 'extension', 'scripts', 'site'];
const NAMES = ['outputLatency', 'getOutputTimestamp'];
// Either name standing whole: with no letter, digit, underscore or dollar
// sign against it, which would make it part of another name.
const LATENCY = new RegExp(`(?<![\\p{ID_Continue}$])(?:${NAMES.join('|')})(?![\\p{ID_Continue}$])`, 'u');

// A line with its escapes read as the characters they stand for: in
// JavaScript a backslash with u and four digits, with u and digits in
// braces, or with x and two digits; in a page, & and # with a number.
function unescaped(line) {
  const character = (digits, base) => {
    const code = Number.parseInt(digits, base);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  };
  return line
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (match, digits) => character(digits, 16))
    .replace(/\\u([0-9a-f]{4})/gi, (match, digits) => character(digits, 16))
    .replace(/\\x([0-9a-f]{2})/gi, (match, digits) => character(digits, 16))
    .replace(/&#x([0-9a-f]{1,6});?/gi, (match, digits) => character(digits, 16))
    .replace(/&#([0-9]{1,7});?/g, (match, digits) => character(digits, 10));
}

// The lines of these files that have either name, as "file:line".
function latencyNames(sources) {
  return Object.entries(sources).flatMap(([file, text]) =>
    text.split('\n').flatMap((line, index) => (LATENCY.test(unescaped(line)) ? [`${file}:${index + 1}`] : []))
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

test('either name is found however it is written, and other names are not', () => {
  // Put together here so this file holds no escape of its own for a tool to
  // read as the letter.
  const backslash = String.fromCharCode(92);
  const sources = {
    'plain.js': ['const context = new AudioContext();', 'const late = context.outputLatency ?? 0;', 'const { outputLatency } = context;'].join('\n'),
    'method.js': 'const { contextTime } = context.getOutputTimestamp();',
    'bracket.js': "const late = context['outputLatency'];",
    'after-comment.js': '/* evidence */ outputLatency: entry.context.outputLatency,',
    'carried-over.js': ['const frames = sampleRate', '  * context.outputLatency;'].join('\n'),
    'template.js': 'const note = `/* ${context.outputLatency} */`;',
    'comment.js': ['// its outputLatency is left alone', ' * getOutputTimestamp in a comment block'].join('\n'),
    'escaped.js': [
      `const a = context.output${backslash}u004catency;`,
      `const b = context.output${backslash}u{4c}atency;`,
      `const c = context['output${backslash}x4catency'];`,
      `const d = context.getOutput${backslash}u0054imestamp();`
    ].join('\n'),
    'page.html': ['<button onclick="show(context.output&#76;atency)">', '<button onclick="show(context.output&#x4c;atency)">'].join('\n'),
    'other.js': [
      'const latency = context.baseLatency;',
      '// the output latency, in words',
      'const outputLatencyMs = 0;',
      'const $outputLatency = document.querySelector("#latency");',
      'const myoutputLatency = 0;',
      'const outputLatency_ms = 0;',
      `const path = 'C:${backslash}users${backslash}x41';`
    ].join('\n')
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
    'comment.js:2',
    'escaped.js:1',
    'escaped.js:2',
    'escaped.js:3',
    'escaped.js:4',
    'page.html:1',
    'page.html:2'
  ]);
});
