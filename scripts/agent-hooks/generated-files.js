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
// Node's own modules and make no network requests.

const fs = require('node:fs');
const path = require('node:path');

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

// The repository a checkout belongs to. A worktree's .git is a file that
// names its own folder inside the repository's .git, and a file there names
// the way back to the repository's.
function repositoryOf(checkout) {
  try {
    const dotGit = path.join(checkout, '.git');
    if (fs.statSync(dotGit).isDirectory()) return fs.realpathSync(dotGit);
    const own = path.resolve(checkout, /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))[1].trim());
    return fs.realpathSync(path.resolve(own, fs.readFileSync(path.join(own, 'commondir'), 'utf8').trim()));
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

// What a hook is given on standard input, and the files the edit names.
// Claude Code's Edit and Write name one file. Codex's apply_patch names each
// file in its patch, from the session's folder.
function readInput() {
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}

function editedFiles(input) {
  const given = input?.tool_input ?? {};
  const from = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  if (typeof given.file_path === 'string') return [path.resolve(from, given.file_path)];
  const patch = [given.command ?? []].flat().join('\n');
  const named = patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm);
  return [...new Set([...named].map((match) => path.resolve(from, match[1].trim())))];
}

module.exports = { GENERATED, HOME, editedFiles, matches, matchesAny, place, readInput };
