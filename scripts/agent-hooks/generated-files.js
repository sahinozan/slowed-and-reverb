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
// Node's own modules and each other, and make no network requests.
// Claude Code loads its settings only in a session started at a checkout's
// root, so a session started in a folder below it has no hooks.

const fs = require('node:fs');
const path = require('node:path');
const { changes, parts } = require('./codex-patch');

// One entry for each row of the "Generated files" table in AGENTS.md, in
// the table's order, with the row's three cells as they are written there
// (tests/agent-hooks.test.js keeps them equal). Then what the hooks do:
//
// - whole: files made whole, so any edit to them is refused. `except` takes
//   files out again.
// - between: a part of a file edited by hand elsewhere, between two marker
//   lines. An edit is refused when it changes what is between them.
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

function matches(pattern, file) {
  const source = pattern
    .split(/(\/\*\*$|\*)/)
    .map((piece) => {
      if (piece === '/**') return '/.*';
      if (piece === '*') return '[^/]*';
      return piece.replace(/[.\\+?^${}()|[\]]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`, 's').test(file);
}

const matchesAny = (patterns = [], file) => patterns.some((pattern) => matches(pattern, file));

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
// file.
function place(file, home = HOME) {
  const checkout = checkoutOf(file);
  const repository = repositoryOf(home);
  if (!checkout || !repository || repositoryOf(checkout) !== repository) return null;
  return { checkout, file: path.relative(checkout, file).split(path.sep).join('/') };
}

// A path as the file system has it: links followed and, where names
// ignore case, spelled as the file is. What isn't there yet keeps the
// spelling given, under the nearest folder that is. With `itself`, a link
// by that name is meant and not the file it leads to, as when it is
// deleted.
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

// The edit a hook is given, read once:
//
// - files: the files it names;
// - textAfter(file, before): the text the file will hold, or null when the
//   edit doesn't say;
// - changesLines(file, inside, outside): whether it surely changes a
//   stretch of the file's lines, for an edit that doesn't say what the
//   file will hold.
//
// Claude Code's Edit and Write name one file; Write gives its text whole,
// and Edit a text to find and the text to put there. Codex's apply_patch
// names each file in its patch, from the session's folder. Only its
// Add File gives a file's text; for its Update File, codex-patch.js says
// what can be told.
function readEdit(input) {
  const given = input?.tool_input ?? {};
  const from = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  const whole = (file, itself) => real(path.resolve(from, file), itself);
  if (typeof given.file_path === 'string') {
    const textAfter = (file, before) => {
      if (typeof given.content === 'string') return given.content;
      if (typeof given.old_string !== 'string' || typeof given.new_string !== 'string') return null;
      if (given.replace_all) return before.split(given.old_string).join(given.new_string);
      return before.replace(given.old_string, () => given.new_string);
    };
    return { files: [whole(given.file_path)], textAfter, changesLines: () => false };
  }
  const named = parts([given.command ?? []].flat().join('\n')).map((part) => ({
    ...part,
    file: whole(part.file, part.does === 'Delete File'),
    movedTo: part.movedTo && whole(part.movedTo)
  }));
  const of = (file, does) => named.filter((part) => part.file === file && part.does === does);
  return {
    files: [...new Set(named.flatMap((part) => (part.movedTo ? [part.file, part.movedTo] : [part.file])))],
    textAfter: (file) => of(file, 'Add File').map((part) => part.lines.filter((line) => line.startsWith('+')).map((line) => `${line.slice(1)}\n`).join('')).at(-1) ?? null,
    changesLines: (file, inside, outside) => of(file, 'Update File').some((part) => changes(part.lines, inside, outside))
  };
}

module.exports = { GENERATED, HOME, matches, matchesAny, place, readEdit, readInput };
