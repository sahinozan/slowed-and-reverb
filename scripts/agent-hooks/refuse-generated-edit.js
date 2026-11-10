'use strict';

// Runs before a coding agent's file edit and refuses one to a generated
// file (generated-files.js has the list and says how the hooks are set up).
// To refuse, it prints why and ends with status 2, which both Claude Code
// and Codex read as "don't". Anything else, a mistake in this script
// included, lets the edit go on.

const fs = require('node:fs');
const path = require('node:path');
const { GENERATED, HOME, editedFiles, matchesAny, place, readInput } = require('./generated-files');

const plain = (cell) => cell.replaceAll('`', '');

function reason(what, entry) {
  return `${what} generated, so an edit by hand would be lost or fail the tests. Change the source (${plain(entry.source)}), then run ${plain(entry.command)}. See "Generated files" in AGENTS.md.`;
}

// The text between a part's marker lines, the markers included, or null
// when the text doesn't have both.
function between(text, { start, end }) {
  const from = text.indexOf(start);
  const to = from === -1 ? -1 : text.indexOf(end, from);
  return to === -1 ? null : text.slice(from, to + end.length);
}

// The file's text after the edit. Claude Code's Write gives it whole, and
// its Edit gives a text to find and the text to put there. Null when the
// edit doesn't say, as with a Codex patch: the tests catch a changed part
// then.
function textAfter(given, before) {
  if (typeof given.content === 'string') return given.content;
  if (typeof given.old_string !== 'string' || typeof given.new_string !== 'string') return null;
  if (given.replace_all) return before.split(given.old_string).join(given.new_string);
  return before.replace(given.old_string, () => given.new_string);
}

// Why this edit is refused, or null when it may go on.
function refusal(input, home = HOME) {
  for (const edited of editedFiles(input)) {
    const at = place(edited, home);
    if (!at) continue;
    for (const entry of GENERATED) {
      if (matchesAny(entry.whole, at.file) && !matchesAny(entry.except, at.file)) {
        return reason(`${at.file} is`, entry);
      }
      for (const part of entry.between ?? []) {
        if (part.file !== at.file || !fs.existsSync(edited)) continue;
        const before = fs.readFileSync(edited, 'utf8');
        const after = textAfter(input.tool_input ?? {}, before);
        const [made, kept] = [between(before, part), after === null ? null : between(after, part)];
        // Taking the part out whole, or putting it in, moves it: only a
        // change to what is between the markers is refused.
        if (made !== null && kept !== null && made !== kept) {
          return reason(`${part.part} in ${at.file} ${/^The items/.test(part.part) ? 'are' : 'is'}`, entry);
        }
      }
    }
  }
  return null;
}

if (require.main === module) {
  const why = refusal(readInput());
  if (why) {
    process.stderr.write(`${why}\n`);
    process.exitCode = 2;
  }
}

module.exports = { refusal, scriptName: path.basename(__filename) };
