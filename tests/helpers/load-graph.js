'use strict';

// What a package command or a workflow job loads: the files it names, the
// tests and setup files Playwright runs for it, and every local module
// those load. A module's loads are read from its syntax, so a comment or a
// string that looks like one isn't taken for one, and a load written so it
// can't be followed (a path worked out while the code runs) is reported
// instead of passed over. Files read as data (through fs, or served to a
// page) aren't followed.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Linter } = require('eslint');

const { root } = require('./load-script');

const relative = (file) => path.relative(root, file).split(path.sep).join('/');
const inRepository = (file) => !file.startsWith('../') && !file.startsWith('node_modules/') && !path.isAbsolute(file);

// The environments a Playwright configuration is read in: on this machine,
// and as CI's two browser jobs set it. A configuration may run other tests
// or setup files in one than in another.
const ENVIRONMENTS = [
  { CI: '' },
  { CI: 'true', SLOWED_REVERB_UI_FIREFOX_PLAYBACK: 'run' },
  { CI: 'true', SLOWED_REVERB_UI_FIREFOX_PLAYBACK: 'omit' }
];

function environment(values) {
  const env = { ...process.env, SLOWED_REVERB_POPUP_HISTORY: '' };
  delete env.SLOWED_REVERB_UI_FIREFOX_PLAYBACK;
  return { ...env, ...values };
}

// The tracked files a piece of text names, such as a command or a shell
// script: each has to stand as a whole path, so README.md doesn't match
// site/README.md.
function namedFiles(text, tracked) {
  return tracked.filter((file) => {
    const pattern = new RegExp(`(?<![\\w./-])(?:\\./)?${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-]|\\.\\w)`);
    return pattern.test(text);
  });
}

// What a Playwright configuration runs besides its browser: the test files
// Playwright itself lists (playwright test --list, which starts no
// browser), its global setup and teardown, a reporter that is a file of
// the repository, and the files its web server's command names. In every
// environment above.
function playwrightFiles(config, tracked) {
  const cli = require.resolve('@playwright/test/cli');
  const files = new Set();
  for (const values of ENVIRONMENTS) {
    const env = environment(values);
    const listed = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json', `--config=${config}`], { cwd: root, encoding: 'utf8', env });
    if (listed.status !== 0) throw new Error(`playwright couldn't list ${config}'s tests: ${listed.stderr}`);
    const report = JSON.parse(listed.stdout);
    for (const suite of report.suites) files.add(relative(path.join(report.config.rootDir, suite.file)));

    const read = spawnSync(
      process.execPath,
      ['-e', 'const c = require(process.argv[1]); console.log(JSON.stringify([c.globalSetup, c.globalTeardown, c.reporter, c.webServer].map((value) => value ?? null)));', path.join(root, config)],
      { cwd: root, encoding: 'utf8', env }
    );
    if (read.status !== 0) throw new Error(`${config} couldn't be read: ${read.stderr}`);
    const [globalSetup, globalTeardown, reporter, webServer] = JSON.parse(read.stdout);
    const modules = [globalSetup, globalTeardown, ...[reporter].flat().map((entry) => (Array.isArray(entry) ? entry[0] : entry))].flat();
    for (const name of modules) {
      // A reporter is one of Playwright's own by name, or a file.
      if (typeof name !== 'string' || !/[\\/]/.test(name)) continue;
      const file = relative(path.resolve(root, name));
      if (inRepository(file)) files.add(file);
    }
    for (const server of [webServer].flat()) {
      if (server?.command) for (const file of namedFiles(server.command, tracked)) files.add(file);
    }
  }
  return [...files];
}

// The repository's files a package command names, through the commands it
// runs with npm run: the files in its own text, and for Playwright its
// configuration and what that runs.
function commandFiles(scripts, name, tracked, playwright = playwrightFiles, seen = new Set()) {
  if (seen.has(name) || typeof scripts[name] !== 'string') return [];
  seen.add(name);
  return scripts[name].split(/&&|\|\||;/).flatMap((part) => {
    const run = /\bnpm run ([\w:-]+)/.exec(part);
    if (run) return commandFiles(scripts, run[1], tracked, playwright, seen);
    const files = namedFiles(part, tracked);
    if (/\bplaywright test\b/.test(part)) {
      const config = /--config=(\S+)/.exec(part)?.[1] ?? 'playwright.config.js';
      files.push(config, ...playwright(config, tracked));
    }
    return files;
  });
}

// The repository's files a workflow job's text names, comments left out,
// with the files of every package command it runs.
function jobFiles(jobText, scripts, tracked, playwright = playwrightFiles) {
  const text = jobText
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const commands = [...new Set([...text.matchAll(/\bnpm run ([\w:-]+)/g)].map((match) => match[1]))];
  return [...new Set([...namedFiles(text, tracked), ...commands.flatMap((name) => commandFiles(scripts, name, tracked, playwright))])];
}

const linter = new Linter({ configType: 'flat' });

// A file's text, or null when there is no such file.
function readFile(file) {
  const full = path.join(root, file);
  return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null;
}

// What a module loads, read from its syntax: require(), require.resolve(),
// import() and import declarations. `requests` are the ones written out;
// `unread` describes those that aren't, by line.
function moduleLoads(file, source) {
  const requests = [];
  const unread = [];
  const written = (node) => {
    if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
    return null;
  };
  const note = (node, call) => {
    const request = written(node.arguments?.[0] ?? node.source);
    if (request === null) unread.push(`${file}:${node.loc.start.line} has ${call} of a path worked out while it runs`);
    else requests.push(request);
  };
  const plugin = {
    rules: {
      loads: {
        create: () => ({
          CallExpression(node) {
            const { callee } = node;
            const resolve =
              callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'require' && callee.property.name === 'resolve';
            if ((callee.type === 'Identifier' && callee.name === 'require') || resolve) note(node, 'a require()');
          },
          ImportExpression: (node) => note(node, 'an import()'),
          ImportDeclaration: (node) => requests.push(node.source.value),
          ExportAllDeclaration: (node) => requests.push(node.source.value),
          ExportNamedDeclaration: (node) => node.source && requests.push(node.source.value)
        })
      }
    }
  };
  const messages = linter.verify(
    source,
    [{ files: ['**/*'], languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' }, plugins: { graph: plugin }, rules: { 'graph/loads': 'error' } }],
    { filename: path.join(root, 'graph.js') }
  );
  const fatal = messages.find((message) => message.fatal);
  if (fatal) unread.push(`${file} can't be read as a script (${fatal.message})`);
  return { requests, unread };
}

// These files and everything of the repository reached from them: the
// local modules a script loads, by Node's own rules for finding them, and
// the files a shell script names, with the package commands it runs.
// `unread` lists what couldn't be followed. `read` gives a file's text, or
// null when there is no such file.
function loadClosure(
  entries,
  { scripts = {}, tracked = [], playwright = playwrightFiles, read = readFile } = {}
) {
  const files = new Set();
  const unread = [];
  const visit = (file) => {
    if (files.has(file)) return;
    const source = read(file);
    if (source === null) return;
    files.add(file);
    if (file.endsWith('.sh')) {
      for (const next of jobFiles(source, scripts, tracked, playwright)) visit(next);
      return;
    }
    if (!/\.[cm]?js$/.test(file)) return;
    const loads = moduleLoads(file, source);
    unread.push(...loads.unread);
    for (const request of loads.requests) {
      if (!/^\.{1,2}\//.test(request)) continue;
      const target = path.resolve(path.dirname(path.join(root, file)), request);
      let found = null;
      for (const candidate of [target, `${target}.js`, `${target}.json`, path.join(target, 'index.js')]) {
        if (read(relative(candidate)) !== null) {
          found = relative(candidate);
          break;
        }
      }
      if (found === null) unread.push(`${file} loads ${request}, which isn't there`);
      else if (inRepository(found)) visit(found);
    }
  };
  for (const entry of entries) visit(entry);
  return { files: [...files], unread };
}

module.exports = { commandFiles, jobFiles, loadClosure, moduleLoads, namedFiles, playwrightFiles };
