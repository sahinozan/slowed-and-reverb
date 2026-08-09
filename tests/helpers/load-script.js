'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');

function loadScript(file, globals = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    URL,
    ...globals
  });
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  vm.runInContext(source, context, { filename: file });
  return context;
}

module.exports = { loadScript, root };
