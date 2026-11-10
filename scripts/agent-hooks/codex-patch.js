'use strict';

// Reads the patch Codex's apply_patch is given, for the hooks next to this
// file: which files it names, and whether it changes a stretch of one.
//
//   *** Begin Patch
//   *** Update File: a/path          (or Add File, or Delete File)
//   *** Move to: another/path        (optional, after Update File)
//   @@ a line to look for first      (optional; a bare @@ starts a hunk too)
//    a line kept
//   -a line taken out
//   +a line put in
//   *** End Patch
//
// It doesn't work out what a file will hold afterward: that would take a
// copy of how Codex finds each hunk's place, and a copy that differed would
// refuse patches that do no harm. `changes` says yes only when it is sure.

// The patch's parts, one for each file it names: what is done to the file,
// its path as given, where it moves to, and the lines that follow, up to
// the next file or the patch's end.
function parts(patch) {
  const found = [];
  let open = null;
  for (const line of String(patch).split('\n')) {
    const head = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (head?.[1] === 'Move to') {
      if (open) open.movedTo = head[2].trim();
    } else if (head) {
      open = { does: head[1], file: head[2].trim(), lines: [] };
      found.push(open);
    } else if (/^\*\*\* (Begin|End) Patch/.test(line)) {
      open = null;
    } else if (open && !line.startsWith('*** ')) {
      open.lines.push(line);
    }
  }
  return found;
}

// A line as Codex compares lines at its loosest: without the spaces at its
// ends, and with typographic dashes, quotes and spaces as plain ones.
const loose = (line) => line.trim()
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/[\u2018-\u201B]/g, "'")
  .replace(/[\u201C-\u201F]/g, '"')
  .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');

// One hunk's lines as the lines it expects to find, in order and loosely,
// and its changes: where in those lines each starts, the lines it takes
// out and the lines it puts in. Lines taken out and put straight back, at
// a change's start or end, are lines kept.
function read(hunk) {
  const expects = [];
  const found = [];
  let open = null;
  for (const line of hunk) {
    const text = line.slice(1);
    if (line.startsWith('+') || line.startsWith('-')) {
      open ??= found[found.push({ at: expects.length, out: [], put: [] }) - 1];
      if (line.startsWith('+')) open.put.push(text);
      else expects.push(loose(open.out[open.out.push(text) - 1]));
    } else {
      // A line kept: it starts with a space, or is empty.
      open = null;
      expects.push(loose(text));
    }
  }
  const changes = found.map(({ at, out, put }) => {
    let [start, end] = [0, 0];
    while (start < Math.min(out.length, put.length) && out[start] === put[start]) start += 1;
    while (end < Math.min(out.length, put.length) - start && out.at(-1 - end) === put.at(-1 - end)) end += 1;
    return { from: at + start, to: at + out.length - end, puts: put.length - start - end > 0 };
  });
  return { expects, changes: changes.filter(({ from, to, puts }) => to > from || puts) };
}

// Whether an Update File part's lines change a stretch of the file, given
// the stretch's lines, from its first to its last, and the file's other
// lines. It goes by the lines that are in the stretch and nowhere else in
// the file, however loosely compared: a hunk that expects one can only be
// about that place, and the lines it expects around it are the file's
// lines around it. A hunk changes the stretch when it takes one of the
// stretch's lines out, or puts lines in right after one (the stretch's
// last line aside) or right before one (its first aside). A hunk that
// expects only lines the stretch shares with the rest of the file isn't
// caught.
function changes(lines, inside, outside) {
  const only = new Set(inside.map(loose));
  for (const line of outside) only.delete(loose(line));
  const [first, last] = [loose(inside[0]), loose(inside.at(-1))];

  const hunks = [[]];
  for (const line of lines) {
    if (line.startsWith('@@')) hunks.push([]);
    else hunks.at(-1).push(line);
  }
  return hunks.some((hunk) => {
    const { expects, changes: changed } = read(hunk);
    // Which expected lines are in the stretch: those found nowhere else,
    // and their neighbors up to the stretch's two ends.
    const within = expects.map((line) => only.has(line));
    for (let at = 1; at < expects.length; at += 1) within[at] ||= within[at - 1] && expects[at - 1] !== last;
    for (let at = expects.length - 2; at >= 0; at -= 1) within[at] ||= within[at + 1] && expects[at + 1] !== first;
    return changed.some(({ from, to }) => within.slice(from, to).some(Boolean)
      || (from > 0 && within[from - 1] && expects[from - 1] !== last)
      || (to < expects.length && within[to] && expects[to] !== first));
  });
}

module.exports = { changes, parts };
