'use strict';

// Runs after a coding agent's file edit. When the edit was to a source of
// generated files, it runs that source's generator in the same checkout
// (generated-files.js has the list and says how the hooks are set up), and
// tells the agent which files the command changed, or that it failed. It
// never stops anything: a failure is only reported.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { GENERATED, HOME, editedFiles, matches, matchesAny, place, readInput } = require('./generated-files');

const plain = (cell) => cell.replaceAll('`', '');

// The files in a checkout that a pattern names: a path, or a folder's
// files with * for part of the name.
function filesNamed(checkout, pattern) {
  const folder = path.posix.dirname(pattern);
  try {
    return fs.readdirSync(path.join(checkout, folder))
      .map((name) => path.posix.join(folder, name))
      .filter((file) => matches(pattern, file) && fs.statSync(path.join(checkout, file)).isFile());
  } catch {
    return [];
  }
}

function contents(checkout, patterns) {
  const files = patterns.flatMap((pattern) => filesNamed(checkout, pattern));
  return new Map(files.map((file) => [file, fs.readFileSync(path.join(checkout, file), 'utf8')]));
}

// Runs the generators this edit calls for and returns what to tell the
// agent, one line for each command that changed a file or failed.
function regenerate(input, home = HOME) {
  const lines = [];
  const done = new Set();
  for (const edited of editedFiles(input)) {
    const at = place(edited, home);
    if (!at) continue;
    for (const { command, regenerate: generator } of GENERATED) {
      const script = generator && path.join(at.checkout, generator.script);
      if (!script || !matchesAny(generator.after, at.file) || done.has(script) || !fs.existsSync(script)) continue;
      done.add(script);
      const before = contents(at.checkout, generator.writes);
      const run = spawnSync(process.execPath, [script], { cwd: at.checkout, encoding: 'utf8', timeout: 30_000 });
      if (run.status !== 0) {
        const said = (run.error?.message ?? run.stderr ?? '').trim().split('\n').slice(0, 5).join('\n');
        lines.push(`${plain(command)} failed after the edit to ${at.file}, so what it makes may be out of date. Run it again once the source is right. It said:\n${said}`);
        continue;
      }
      const after = contents(at.checkout, generator.writes);
      const changed = [...after.keys()].filter((file) => after.get(file) !== before.get(file));
      if (changed.length > 0) {
        lines.push(`${plain(command)} ran after the edit to ${at.file} and changed ${changed.join(', ')}. What it makes is generated (AGENTS.md, "Generated files") and belongs in the same commit as its source.`);
      }
    }
  }
  return lines;
}

if (require.main === module) {
  const lines = regenerate(readInput());
  if (lines.length > 0) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') } })}\n`);
  }
}

module.exports = { regenerate, scriptName: path.basename(__filename) };
