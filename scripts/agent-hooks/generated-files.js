'use strict';

// The generated files, as the hooks for coding agents know them. Claude Code
// (.claude/settings.json) and Codex (.codex/hooks.json) run the two scripts
// next to this file around an agent's file edits:
//
// - refuse-generated-edit.js, before an edit, refuses one to a generated
//   file and names the source to change and the command to run;
// - regenerate.js, after an edit to a source, runs the command whose
//   generator is quick and needs nothing installed.
//
// They only see an agent's edit tools. A command that writes a file, as the
// generators themselves do, isn't stopped. They read the edit from standard
// input, read and write files in this repository only, load nothing but
// Node's own modules and this file, and make no network requests.
// Claude Code loads its settings only in a session started at a checkout's
// root, so a session started in a folder below it has no hooks.

const fs = require('node:fs');
const path = require('node:path');

// One entry for each row of the "Generated files" table in AGENTS.md, in
// the table's order, with the row's three cells as they are written there
// (tests/agent-hooks.test.js keeps them equal). Then what the hooks do:
//
// - whole: files made whole, so any edit to them is refused. `except` takes
//   files out again.
// - between: a part of a file edited by hand elsewhere, between two marker
//   lines. An edit by Claude Code is refused when it changes what is
//   between them. A Codex patch to such a file isn't judged (see readEdit).
// - regenerate: the generator's script, the sources it runs after an edit
//   to, and the files it may write.
//
// A pattern is a path from the repository's root, with * for part of one
// name and a folder followed by /** for everything in it.
const GENERATED = [
  {
    files: '`dist/`',
    source: '`extension/`',
    command: '`npm run build:chromium`, `npm run build:firefox`, `npm run package`',
    whole: ['dist/**'],
    // A release's draft notes, whose TODO lines are filled in by hand.
    except: ['dist/packages/*/RELEASE-*.txt']
  },
  {
    files: '`site/popup/popup.*`, `site/popup/settings.js`',
    source: '`extension/popup.*`, `extension/settings.js`',
    command: '`npm run site:popup`',
    whole: ['site/popup/popup.*', 'site/popup/settings.js'],
    regenerate: {
      script: 'scripts/sync-site-popup.js',
      after: ['extension/popup.*', 'extension/settings.js'],
      writes: ['site/popup/popup.*', 'site/popup/settings.js']
    }
  },
  {
    // Only the stamps are made, so the pages stay editable. Stamping again
    // after an edit to a page puts back a stamp changed by hand.
    files: '`?v=` stamps in `site/*.html`',
    source: '`site/styles.css`, `site/*.js`',
    command: '`npm run site:stamp`',
    regenerate: {
      script: 'scripts/stamp-site-assets.js',
      after: ['site/styles.css', 'site/*.js', 'site/*.html'],
      writes: ['site/*.html']
    }
  },
  {
    files: '`docs/checks.md`, and the items under "When it applies" in `RELEASE-CHECKLIST.md`',
    source: '`checks.json`',
    command: '`npm run checks:tables`',
    whole: ['docs/checks.md'],
    between: [
      {
        file: 'RELEASE-CHECKLIST.md',
        part: 'The items under "When it applies"',
        start: "<!-- Made from checks.json by npm run checks:tables. Don't edit between these two lines. -->",
        end: '<!-- The end of the part made from checks.json. -->'
      }
    ],
    regenerate: {
      script: 'scripts/render-checks-tables.js',
      after: ['checks.json', 'RELEASE-CHECKLIST.md'],
      writes: ['docs/checks.md', 'RELEASE-CHECKLIST.md']
    }
  },
  {
    // npm run icons starts a browser, so it is left to whoever changes the
    // drawing.
    files: '`extension/assets/icon*`, `store-assets/chrome/store-icon-128.png`, the popup\'s header mark',
    source: '`scripts/render-icons.js`',
    command: '`npm run icons`',
    whole: ['extension/assets/icon*', 'store-assets/chrome/store-icon-128.png'],
    between: [
      {
        file: 'extension/popup.html',
        part: "The popup's header mark",
        start: '<!-- icon:start -->',
        end: '<!-- icon:end -->'
      }
    ]
  },
  {
    files: '`store-assets/screenshots/`, `store-assets/firefox/`, the promo tile and marquee in `store-assets/chrome/`, `site/assets/og-card.png`',
    source: '`scripts/render-store-assets.js`, the popup, the captures in `store-assets/originals/`, the cassette in `site/index.html`, `site/assets/fonts/fraunces.woff2`',
    command: '`npm run store:assets` (needs macOS fonts)',
    whole: [
      'store-assets/screenshots/**',
      'store-assets/firefox/**',
      'store-assets/chrome/promotional-tile-440x280.png',
      'store-assets/chrome/marquee-1400x560.png',
      'site/assets/og-card.png'
    ]
  }
];

// With `anyCase`, letters match in either case, as file names do where the
// file system takes the two for one.
function matches(pattern, file, anyCase = false) {
  const source = pattern
    .split(/(\/\*\*$|\*)/)
    .map((piece) => {
      if (piece === '/**') return '/.*';
      if (piece === '*') return '[^/]*';
      return piece.replace(/[.\\+?^${}()|[\]]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`, anyCase ? 'isu' : 's').test(file);
}

const matchesAny = (patterns = [], file, anyCase = false) => patterns.some((pattern) => matches(pattern, file, anyCase));

// The checkout a file is in: the nearest folder above it that has a .git.
// The file itself needn't be there yet.
function checkoutOf(file) {
  for (let folder = path.dirname(file); ; folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, '.git'))) return folder;
    if (folder === path.dirname(folder)) return null;
  }
}

// The repository a checkout belongs to, as its git folder. A checkout's
// .git is that folder, or a file that names it. A worktree's names its own
// folder inside the repository's, where a file, commondir, names the way
// back to the repository's.
function repositoryOf(checkout) {
  try {
    const dotGit = path.join(checkout, '.git');
    if (fs.statSync(dotGit).isDirectory()) return fs.realpathSync(dotGit);
    const own = path.resolve(checkout, /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))[1].trim());
    const back = path.join(own, 'commondir');
    return fs.realpathSync(fs.existsSync(back) ? path.resolve(own, fs.readFileSync(back, 'utf8').trim()) : own);
  } catch {
    return null;
  }
}

// The checkout these hooks are in.
const HOME = path.join(__dirname, '..', '..');

// Where a file is, when it is in a checkout of this repository: the main
// one or any of its worktrees, wherever the session started. Its path is
// given from that checkout's root, with forward slashes. Null for any other
// file. `anyCase` says that names there ignore letter case, which a file
// that isn't there yet can't show by its own spelling (see real).
function place(file, home = HOME) {
  const checkout = checkoutOf(file);
  const repository = repositoryOf(home);
  if (!checkout || !repository || repositoryOf(checkout) !== repository) return null;
  return {
    checkout,
    file: path.relative(checkout, file).split(path.sep).join('/'),
    anyCase: !fs.existsSync(file) && fs.existsSync(path.join(checkout, '.GIT'))
  };
}

// A path as the file system has it: links followed and, where names
// ignore case, spelled as the file is. What isn't there yet keeps the
// spelling given, under the nearest folder that is. With `itself`, a link
// by that name is meant and not the file it leads to, as when it is
// deleted or moved away.
function real(file, itself = false) {
  if (itself && fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return path.join(real(path.dirname(file)), path.basename(file));
  }
  const missing = [];
  for (let at = file; ; at = path.dirname(at)) {
    try {
      return path.join(fs.realpathSync.native(at), ...missing);
    } catch {
      if (at === path.dirname(at)) return file;
      missing.unshift(path.basename(at));
    }
  }
}

// What a hook is given on standard input.
function readInput() {
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}

// The files a Codex patch names, each with what is done to it:
//
//   *** Begin Patch
//   *** Update File: a/path          (or Add File, or Delete File)
//   *** Move to: another/path        (optional, after Update File)
//   *** End Patch
//
// It is read the way Codex's applier reads it (its streaming_parser.rs, as
// of Codex 0.167.0), so that the two agree on which lines are these and
// which are a file's text:
//
// - Lines end at a line feed only, and the patch is what is from the Begin
//   Patch line to the End Patch line. Nothing is read before or after: the
//   applier takes nothing there but the first and last lines of a patch
//   given inside <<EOF and EOF, and no patch that has anything else.
// - Space around one of these lines doesn't count, by Rust's meaning of
//   space (JavaScript's trim also takes U+FEFF and leaves U+0085). So a
//   path keeps the space before it and loses the space after.
// - While a file is updated, only the space after a line doesn't count:
//   a line that starts with a space is a line of the file, whatever
//   follows the space.
const AROUND = /^\p{White_Space}+|\p{White_Space}+$/gu;
const AFTER = /\p{White_Space}+$/u;

function patchFiles(patch) {
  const named = [];
  let started = false;
  let updating = false;
  for (const line of patch.split('\n')) {
    const text = line.replace(updating ? AFTER : AROUND, '');
    if (!started) {
      started = text === '*** Begin Patch';
      continue;
    }
    if (text === '*** End Patch') break;
    const [, does, file] = (updating ? /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/s : /^\*\*\* (Add File|Update File|Delete File): (.+)$/s).exec(text) ?? [];
    if (!does) continue;
    updating = does === 'Update File' || does === 'Move to';
    named.push({ does, file });
  }
  return named;
}

// Where a path in a patch leads, from the session's folder. Codex's applier
// works that out itself, name by name, as a URL (its path-uri crate, as of
// Codex 0.167.0), and not as the file system would:
//
// - A name written `..` takes back the name before it, whatever that is.
//   In a path from the root, these are all taken back first; in a path from
//   the session's folder, each as it comes.
// - Tabs and carriage returns are then taken out of a name. One left empty
//   or as `.` stays in the path as an empty name, which leads nowhere but
//   is there to take back. One left as `..` takes back the name before it
//   and stays as an empty name itself.
function patchPath(from, file) {
  const start = path.isAbsolute(file) ? file : path.resolve(from);
  const { root } = path.parse(start);
  const names = (text) => text.split(path.sep === '/' ? '/' : /[\\/]/).filter((name) => name !== '' && name !== '.');
  const led = [];
  const add = (name) => {
    const left = name.replace(/[\t\r]/g, '');
    if (left === '..') led.pop();
    led.push(left === '.' || left === '..' ? '' : left);
  };
  if (start === file) {
    const kept = [];
    for (const name of names(file.slice(root.length))) name === '..' ? kept.pop() : kept.push(name);
    kept.forEach(add);
  } else {
    led.push(...names(start.slice(root.length)));
    for (const name of names(file)) name === '..' ? led.pop() : add(name);
  }
  return path.join(root, ...led);
}

// The edit a hook is given: the files it names and, for one of them, the
// text it will hold afterward, or null when the edit doesn't say.
//
// Claude Code's Edit and Write name one file; Write gives its text whole,
// and Edit a text to find and the text to put there. Codex's apply_patch
// names its files in the patch, from the session's folder.
//
// A patch doesn't say what a file will hold. Working that out takes a copy
// of how Codex finds each hunk's place, and a copy that differs refuses
// patches that do no harm, so a patch is only read for the files it names.
function readEdit(input) {
  const given = input?.tool_input ?? {};
  const from = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  if (typeof given.file_path === 'string') {
    const textAfter = (before) => {
      if (typeof given.content === 'string') return given.content;
      if (typeof given.old_string !== 'string' || typeof given.new_string !== 'string') return null;
      if (given.replace_all) return before.split(given.old_string).join(given.new_string);
      return before.replace(given.old_string, () => given.new_string);
    };
    return { files: [real(path.resolve(from, given.file_path))], textAfter };
  }
  const named = patchFiles([given.command ?? []].flat().join('\n'));
  // A file deleted, or moved to the name on the next line, goes by the
  // name given: of a link, the link goes and the file it leads to stays.
  const gone = ({ does }, index) => does === 'Delete File' || named[index + 1]?.does === 'Move to';
  return { files: [...new Set(named.map((entry, index) => real(patchPath(from, entry.file), gone(entry, index))))], textAfter: () => null };
}

module.exports = { GENERATED, HOME, matches, matchesAny, patchFiles, place, readEdit, readInput };
