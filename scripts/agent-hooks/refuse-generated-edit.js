'use strict';

// Runs before a coding agent's file edit and refuses one to a generated
// file (generated-files.js has the list and says how the hooks are set up).
// To refuse, it prints why and ends with status 2, which both Claude Code
// and Codex read as "don't". Anything else, a mistake in this script
// included, lets the edit go on.

const fs = require('node:fs');
const { GENERATED, HOME, matchesAny, place, readEdit, readInput } = require('./generated-files');

const plain = (cell) => cell.replaceAll('`', '');

function reason(what, entry, how = '') {
  return `${what} generated, so an edit by hand would be lost or fail the tests.${how} Change the source (${plain(entry.source)}), then run ${plain(entry.command)}. See "Generated files" in AGENTS.md.`;
}

// A part's lines, from its start marker to its end marker, and the text's
// other lines, or null when the text doesn't have each marker once, as a
// line of its own, in that order. The generators find the markers the same
// way.
function between(text, { start, end }) {
  const lines = text.split('\n');
  const at = (marker) => lines.flatMap((line, index) => (line.trim() === marker ? [index] : []));
  const [starts, ends] = [at(start), at(end)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0]) return null;
  return { inside: lines.slice(starts[0], ends[0] + 1), outside: [...lines.slice(0, starts[0]), ...lines.slice(ends[0] + 1)] };
}

// Why this edit is refused, or null when it may go on.
function refusal(input, home = HOME) {
  const { files, textAfter, changesLines } = readEdit(input);
  for (const edited of files) {
    const at = place(edited, home);
    if (!at) continue;
    for (const entry of GENERATED) {
      if (matchesAny(entry.whole, at.file) && !matchesAny(entry.except, at.file)) {
        return reason(`${at.file} is`, entry);
      }
      for (const part of entry.between ?? []) {
        if (part.file !== at.file || !fs.existsSync(edited)) continue;
        const before = fs.readFileSync(edited, 'utf8');
        const made = between(before, part);
        if (!made) continue;
        // When the edit says what the file will hold, the part has to be
        // there afterward as it was; it may move within the file. When it
        // doesn't, as with a Codex patch, the edit is refused only if it
        // surely changes the part's lines: the tests catch the rest.
        const after = textAfter(edited, before);
        const changed = after === null
          ? changesLines(edited, made.inside, made.outside)
          : between(after, part)?.inside.join('\n') !== made.inside.join('\n');
        if (changed) {
          const plural = /^The items/.test(part.part);
          return reason(`${part.part} in ${at.file} ${plural ? 'are' : 'is'}`, entry, ` Leave ${plural ? 'them' : 'it'} and the two marker lines as they are.`);
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

module.exports = { refusal };
