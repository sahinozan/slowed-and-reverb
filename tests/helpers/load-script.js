'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');

function runFile(context, file) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

function loadScript(file, globals = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    URL,
    ...globals
  });
  // Like a service worker, scripts can load files next to themselves.
  context.importScripts = (...names) => {
    for (const name of names) runFile(context, path.join(path.dirname(file), name));
  };
  runFile(context, file);
  return context;
}

module.exports = { loadScript, root };
