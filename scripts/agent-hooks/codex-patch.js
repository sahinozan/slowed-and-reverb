'use strict';

// Reads the patch Codex's apply_patch is given, for the hooks next to this
// file: which files it names, and what one of them will hold afterward.
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
// `whole` makes a path as the patch gives it, from the session's folder,
// into the file's full path.

// The patch's parts, one for each file it names: what is done to the file,
// its path, where it moves to, and the lines that follow, up to the next
// file or the patch's end.
function parts(patch, whole) {
  const found = [];
  let open = null;
  for (const line of String(patch).split('\n')) {
    const head = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (head?.[1] === 'Move to') {
      if (open) open.movedTo = whole(head[2].trim());
    } else if (head) {
      open = { does: head[1], file: whole(head[2].trim()), lines: [] };
      found.push(open);
    } else if (/^\*\*\* (Begin|End) Patch/.test(line)) {
      open = null;
    } else if (open && !line.startsWith('*** ')) {
      open.lines.push(line);
    }
  }
  return found;
}

// Every file the patch names, a file's new place included.
function filesNamed(patch, whole) {
  return parts(patch, whole).flatMap((part) => (part.movedTo ? [part.file, part.movedTo] : [part.file]));
}

// Where these lines are in the text's lines, looking from a line on:
// exactly, then with spaces at the lines' ends left out, then at both ends,
// as Codex looks. -1 when they aren't there.
function find(lines, wanted, from) {
  for (const same of [(line) => line, (line) => line.trimEnd(), (line) => line.trim()]) {
    for (let at = from; at + wanted.length <= lines.length; at += 1) {
      if (wanted.every((line, index) => same(lines[at + index]) === same(line))) return at;
    }
  }
  return -1;
}

// An Update File part's hunks: the line to look for first, the lines the
// hunk expects, and the lines it leaves. Null when a line is none of these.
function hunks(lines) {
  const found = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      found.push({ first: line.slice(2).trim(), expects: [], leaves: [] });
      continue;
    }
    if (found.length === 0) found.push({ first: '', expects: [], leaves: [] });
    const [mark, rest] = [line.slice(0, 1), line.slice(1)];
    if (mark !== '+' && mark !== '-' && mark !== ' ' && line !== '') return null;
    if (mark !== '+') found.at(-1).expects.push(rest);
    if (mark !== '-') found.at(-1).leaves.push(rest);
  }
  return found;
}

// The text with an Update File part's hunks applied, in order, or null
// when a hunk's lines can't be found.
function updated(before, lines) {
  const text = before.split('\n');
  const all = hunks(lines);
  if (!all) return null;
  let from = 0;
  for (const { first, expects, leaves } of all) {
    if (first) {
      const at = find(text, [first], from);
      if (at === -1) return null;
      from = at + 1;
    }
    let [old, now] = [expects, leaves];
    // A hunk that only adds lines adds them at the end of the file.
    let at = old.length === 0 ? text.length - (text.at(-1) === '' ? 1 : 0) : find(text, old, from);
    if (at === -1 && old.at(-1) === '') {
      // Its last line may be the one after the file's last.
      [old, now] = [old.slice(0, -1), now.at(-1) === '' ? now.slice(0, -1) : now];
      at = find(text, old, from);
    }
    if (at === -1) return null;
    text.splice(at, old.length, ...now);
    from = at + now.length;
  }
  return text.join('\n');
}

// What the file will hold after the patch: its text, '' when the patch
// takes the file away, or null when the patch doesn't name it or can't be
// followed here.
function textAfter(patch, whole, file, before) {
  let text = before;
  let named = false;
  for (const part of parts(patch, whole)) {
    if (part.file !== file) continue;
    named = true;
    if (part.does === 'Delete File' || part.movedTo) text = '';
    else if (part.does === 'Add File') text = part.lines.filter((line) => line.startsWith('+')).map((line) => `${line.slice(1)}\n`).join('');
    else text = updated(text, part.lines);
    if (text === null) return null;
  }
  return named ? text : null;
}

module.exports = { filesNamed, textAfter };
