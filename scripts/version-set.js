'use strict';

// Writes a version bump (AGENTS.md, "Releases"):
//
//   npm run version:set -- X.Y.Z
//
// PLACES below is the one list of what a bump touches. This script writes the
// new version to each place, and the release (scripts/release.js) checks each
// with versionBumpProblems, so the two can't come to disagree about where the
// version is. A new place is one more entry, with both how to check it and how
// to write it.
//
// It works out every edit and checks the result before it writes anything, so
// a run that fails leaves the repository as it was. It uses no network and no
// npm. The release notes are a person's to write: the changelog gets an entry
// with the version, the day and a TODO comment where they go, and the check
// reports that entry until they are written.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];
// What marks release notes still to write, as in the release's draft record.
// In the changelog it opens a comment; the word in the notes themselves is
// only a word.
const NOTES_MARKER = 'TODO';
const NOTES_COMMENT = new RegExp(`<!--\\s*${NOTES_MARKER}\\b`);

// A problem a person can fix, shown without a stack trace.
class VersionError extends Error {}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  return left.map((part, index) => part - right[index]).find((difference) => difference !== 0) ?? 0;
}

function versionsIn(text) {
  return text?.match(/\d+\.\d+\.\d+/g) ?? [];
}

// The website's pages, which each show the version in their footer.
function sitePages(directory) {
  return fs
    .readdirSync(path.join(directory, 'site'))
    .filter((name) => name.endsWith('.html'))
    .sort();
}

function parsedJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The value at a path of keys, or undefined.
function valueAt(json, keys) {
  return keys.reduce((value, key) => (value !== null && typeof value === 'object' ? value[key] : undefined), json);
}

// A JSON file whose version is at each of spots: { keys, pattern }, the path
// of keys to it and what finds it in the file's text. The text is edited, not
// written out again from the parsed file, which would lose how it is laid out
// (package.json writes its trademark sign as \u2122). The result is then read
// back, and refused unless the versions are the only thing that changed.
function jsonVersion(file, spots, problem) {
  return {
    files: () => [file],
    problem(_, text, version) {
      const json = parsedJson(text);
      return spots.every((spot) => valueAt(json, spot.keys) === version) ? null : problem(json);
    },
    write(_, text, version) {
      const expected = parsedJson(text);
      if (!expected) throw new VersionError(`${file} can't be read as JSON`);
      let after = text;
      for (const { keys, pattern } of spots) {
        if (typeof valueAt(expected, keys) !== 'string') throw new VersionError(`${file} has no version where one is expected`);
        after = after.replace(pattern, (_, open, close) => open + version + close);
        valueAt(expected, keys.slice(0, -1))[keys[keys.length - 1]] = version;
      }
      if (JSON.stringify(parsedJson(after)) !== JSON.stringify(expected)) {
        throw new VersionError(`${file}: its version isn't written the expected way, so it can't be changed safely`);
      }
      return after;
    }
  };
}

// The version at the top of a JSON file indented by two spaces.
const ROOT_VERSION = { keys: ['version'], pattern: /^( {2}"version": ")[^"]*(")/m };
// The lockfile's entry for the project itself, the first of its packages.
const LOCK_ROOT_PACKAGE = { keys: ['packages', '', 'version'], pattern: /("packages": \{\s*"": \{[^{}]*?"version": ")[^"]*(")/ };

// A script's own copy of the version. The scripts compare these, not the
// manifest's (AGENTS.md, "Releases").
function versionLiteral(file) {
  const pattern = /const VERSION = '([^']*)';/g;
  return {
    files: () => [file],
    problem(_, text, version) {
      const literal = new RegExp(pattern.source).exec(text);
      return literal?.[1] === version ? null : `${file} has VERSION ${literal?.[1]}`;
    },
    write(_, text, version) {
      if ((text.match(pattern) ?? []).length !== 1) throw new VersionError(`${file} doesn't define VERSION once, the expected way`);
      return text.replace(pattern, `const VERSION = '${version}';`);
    }
  };
}

const footer = (version) => `<span>Slowed &amp; Reverb ${version}</span>`;

// The version in the footer of every page of the website.
const footers = {
  files: (pages) => pages.map((page) => `site/${page}`),
  problem(file, text, version) {
    return text.includes(footer(version)) ? null : `${file} doesn't show ${version} in its footer`;
  },
  write(file, text, version) {
    const pattern = new RegExp(footer('\\d+\\.\\d+\\.\\d+'), 'g');
    if ((text.match(pattern) ?? []).length !== 1) throw new VersionError(`${file} doesn't show a version once in its footer`);
    return text.replace(pattern, footer(version));
  }
};

function changelogNotesProblem(file, version) {
  return `${file}'s entry for ${version} has no release notes yet`;
}

// The changelog's entry for the version. The writer adds the entry with the
// day and a TODO comment where the release notes go; it doesn't write them.
// The check wants an entry that says something and has no such comment left
// in it, so the new entry can't pass for a finished one.
const changelogEntry = {
  files: () => ['site/changelog.html'],
  problem(file, text, version) {
    const start = text.indexOf(`<h2>${version} `);
    if (start < 0) return `${file} has no entry for ${version}`;
    // The entry's pieces after its heading, up to the tag that ends it: a
    // comment, a tag, or the words between them. Read in order, so that what
    // looks like a tag inside a comment or an attribute isn't taken for one.
    const body = text.slice(start).replace(/^<h2>[\s\S]*?<\/h2>/, '');
    let [words, placeholder] = [false, false];
    for (const [piece] of body.matchAll(/<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</g)) {
      if (piece.startsWith('<!--')) placeholder ||= NOTES_COMMENT.test(piece);
      else if (/^<(\/section|h2)\b/i.test(piece)) break;
      else if (!piece.startsWith('<')) words ||= piece.trim() !== '';
    }
    return placeholder || !words ? changelogNotesProblem(file, version) : null;
  },
  write(file, text, version, { today }) {
    // An entry someone wrote ahead of the bump stays as it is.
    if (text.includes(`<h2>${version} `)) return text;
    const newest = /^([ \t]*)<section class="entry">/m.exec(text);
    if (!newest) throw new VersionError(`${file} has no entry to put the new one above`);
    const indent = newest[1];
    const iso = [today.getFullYear(), today.getMonth() + 1, today.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
    const day = `${MONTHS[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;
    const entry = [
      '<section class="entry">',
      `  <h2>${version} <time datetime="${iso}">${day}</time></h2>`,
      '  <ul>',
      `    <!-- ${NOTES_MARKER}: the release notes for ${version}, one <li> for each change, in place of this comment -->`,
      '  </ul>',
      '</section>'
    ];
    const lines = entry.map((line) => indent + line).join('\n');
    return `${text.slice(0, newest.index)}${lines}\n\n${text.slice(newest.index)}`;
  }
};

// A paragraph's words on lines of at most width characters, ended by eol.
function wrapWords(paragraph, width, eol) {
  const lines = [];
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 1 + word.length <= width) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  return lines.join(eol);
}

// The empty line between two paragraphs, which may hold spaces.
const BLANK_LINE = /\r?\n[ \t]*\r?\n/;
// A line that starts a heading, a quote, a list item, code or a table.
const MARKDOWN_BLOCK = /^[ \t]*(#|>|[-*+][ \t]|\d+\.[ \t]|```|\|)/m;

// "a, b and c", or with oxford "a, b, and c".
function listed(items, oxford) {
  if (items.length < 3) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}${oxford ? ',' : ''} and ${items[items.length - 1]}`;
}

// A list of versions as either policy writes it, and nothing else, so that
// what is taken for the list can't reach past it into the rest of the policy.
const VERSION_LIST = '((?:[\\d.,`\\s]|and)+?)';

// The sentence of a privacy policy that names the versions it covers, found
// by the words before and after its list, however the line is broken. It gets
// the new version at the end of the list, written by list(versions); with
// width, the paragraph around it is wrapped again to that many characters.
function policyVersions(file, [wordsBefore, wordsAfter], list, width) {
  const spaced = (words) => words.split(' ').join('\\s+');
  const sentence = new RegExp(`(${spaced(wordsBefore)}\\s+)${VERSION_LIST}(\\s+${spaced(wordsAfter)}\\b)`);
  return {
    files: () => [file],
    problem(_, text, version) {
      return versionsIn(sentence.exec(text)?.[2]).includes(version) ? null : `${file}'s versions line doesn't list ${version}`;
    },
    write(_, text, version) {
      const found = sentence.exec(text);
      const versions = versionsIn(found?.[2]);
      if (!versions.length) throw new VersionError(`${file} has no line naming the versions the policy covers`);
      if (versions.includes(version)) return text;
      const [before, after] = [text.slice(0, found.index), text.slice(found.index + found[0].length)];
      const written = `${found[1]}${list([...versions, version])}${found[3]}`;
      if (!width) return before + written + after;
      const breaks = [...before.matchAll(new RegExp(BLANK_LINE, 'g'))];
      const start = breaks.length ? breaks.at(-1).index + breaks.at(-1)[0].length : 0;
      const end = BLANK_LINE.exec(after)?.index ?? after.length;
      const paragraph = before.slice(start) + written + after.slice(0, end);
      if (MARKDOWN_BLOCK.test(paragraph)) {
        throw new VersionError(`${file}: the versions aren't named in a plain paragraph, so it can't be wrapped again`);
      }
      const wrapped = wrapWords(paragraph, width, text.includes('\r\n') ? '\r\n' : '\n');
      return before.slice(0, start) + wrapped + /\s*$/.exec(paragraph)[0] + after.slice(end);
    }
  };
}

// Everything a version bump touches (AGENTS.md, "Releases"), each with how to
// check it and how to write it:
//
//   files(pages)                        the files it is in, from the repository
//                                       root; pages are the website's pages
//   problem(file, text, version)        what is wrong in the file's text if it
//                                       doesn't show version, or null
//   write(file, text, version, bump)    the text with version written, or the
//                                       text as it is; it throws if it can't
//                                       find its place. bump.today is the day.
//
// The release reads the version it checks from the manifest.
const PLACES = [
  jsonVersion('extension/manifest.json', [ROOT_VERSION], (json) => `extension/manifest.json has version ${json?.version}`),
  jsonVersion('package.json', [ROOT_VERSION], (json) => `package.json has version ${json?.version}`),
  jsonVersion('package-lock.json', [ROOT_VERSION, LOCK_ROOT_PACKAGE], () => 'package-lock.json has another version in its root entries'),
  versionLiteral('extension/content.js'),
  versionLiteral('extension/spotify-bridge.js'),
  versionLiteral('extension/spotify-main.js'),
  versionLiteral('extension/youtube-main.js'),
  footers,
  changelogEntry,
  // The policy names every version it covers, in the repository and on the
  // website. PRIVACY.md is wrapped by hand, to 78 characters in this paragraph.
  policyVersions('PRIVACY.md', ['applies to versions', 'of the'], (versions) => listed(versions.map((version) => `\`${version}\``), true), 78),
  policyVersions('site/privacy.html', ['covers versions', 'of Slowed'], (versions) => listed(versions, false))
];

// The files a version bump touches.
function versionFiles(pages, places = PLACES) {
  return [...new Set(places.flatMap((place) => place.files(pages)))];
}

// What a version bump touches that doesn't show version. read(file) returns a
// file's text from the repository root.
function versionBumpProblems(read, pages, version, places = PLACES) {
  return places.flatMap((place) => place.files(pages).map((file) => place.problem(file, read(file), version))).filter(Boolean);
}

// The text of every file a bump to version touches, with it written.
function versionEdits(read, pages, version, bump, places = PLACES) {
  const texts = new Map();
  for (const place of places) {
    for (const file of place.files(pages)) {
      texts.set(file, place.write(file, texts.get(file) ?? read(file), version, bump));
    }
  }
  return texts;
}

function listProblems(problems) {
  return problems.map((problem) => `  ${problem}`).join('\n');
}

// Puts each new text in place of its file in directory, all of them or none.
// Everything is written first, to a folder of its own beside them: each new
// text, with its file's permissions, and a copy of each file as it is. Only
// then are the files replaced, by renaming, which writes no data, so a disk
// that has stopped taking writes is found out before any file is touched. If
// a rename fails, each file already replaced is renamed back from its copy;
// one that can't be is named in the error, and the folder is kept with its
// copy in it. Returns the folder if it couldn't be removed afterward, which
// doesn't undo a bump that was written, or null.
function replaceFiles(directory, changed, io) {
  let stage;
  const replaced = [];
  const leftover = () => {
    try {
      io.rmSync(stage, { recursive: true, force: true });
      return null;
    } catch {
      return stage;
    }
  };
  try {
    stage = io.mkdtempSync(path.join(directory, '.version-set-'));
    const staged = changed.map(([file, text], index) => {
      const item = { file, target: path.join(directory, file), next: path.join(stage, `${index}.new`), kept: path.join(stage, `${index}.old`) };
      io.copyFileSync(item.target, item.kept);
      io.writeFileSync(item.next, text);
      // Set afterward: the permissions a file is created with are cut down
      // by the umask.
      io.chmodSync(item.next, io.statSync(item.target).mode & 0o7777);
      return item;
    });
    for (const item of staged) {
      io.renameSync(item.next, item.target);
      replaced.push(item);
    }
  } catch (error) {
    const stuck = replaced.filter((item) => {
      try {
        io.renameSync(item.kept, item.target);
        return false;
      } catch {
        return true;
      }
    });
    if (stuck.length) {
      const names = stuck.map((item) => `  ${item.file} (kept as ${path.basename(item.kept)})`).join('\n');
      throw new Error(
        `Writing stopped (${error.message}), and these have the new version and couldn't be put back. ` +
          `Each is kept as it was in ${stage}; copy it back by hand:\n${names}`,
        { cause: error }
      );
    }
    const folder = stage && leftover();
    throw new VersionError(`The files couldn't be written: ${error.message}${folder ? `\n${leftoverNote(folder)}` : ''}`, { cause: error });
  }
  return leftover();
}

function leftoverNote(folder) {
  return `The folder ${folder}, used while writing, couldn't be removed. Remove it by hand.`;
}

// Writes the bump to version in the repository at directory, or throws having
// changed nothing (replaceFiles has the one exception). Returns the version it
// replaced, the files it changed, whether the changelog's entry still needs
// its release notes, and the folder used for writing if it is still there.
function setVersion({ directory = root, version, today = new Date(), io = fs }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
    throw new VersionError(`Give the new version as three numbers, like 1.3.0${version ? `, not "${version}"` : ''}.`);
  }
  const read = (file) => fs.readFileSync(path.join(directory, file), 'utf8');
  const pages = sitePages(directory);
  const current = parsedJson(read('extension/manifest.json'))?.version;
  if (typeof current !== 'string' || !parseVersion(current)) {
    throw new VersionError(`extension/manifest.json has version ${current}, which isn't three numbers.`);
  }
  if (compareVersions(version, current) <= 0) {
    throw new VersionError(`${version} isn't higher than the current version, ${current}.`);
  }
  const unfinished = versionBumpProblems(read, pages, current);
  if (unfinished.length) {
    throw new VersionError(`The repository doesn't show ${current} everywhere yet. Finish or undo that first:\n${listProblems(unfinished)}`);
  }

  const texts = versionEdits(read, pages, version, { today });
  const notes = changelogNotesProblem('site/changelog.html', version);
  const left = versionBumpProblems((file) => texts.get(file), pages, version);
  const wrong = left.filter((problem) => problem !== notes);
  if (wrong.length) {
    throw new VersionError(`The edits worked out for ${version} wouldn't pass the release's check:\n${listProblems(wrong)}`);
  }

  const changed = [...texts].filter(([file, text]) => text !== read(file));
  const leftover = replaceFiles(directory, changed, io);
  return { current, version, files: changed.map(([file]) => file), notesLeft: left.includes(notes), leftover };
}

// What the command prints once the bump is written.
function report({ current, version, files, notesLeft, leftover }) {
  const steps = [
    notesLeft
      ? `Write the release notes in site/changelog.html, in place of the ${NOTES_MARKER} comment in the entry for ${version}. ` +
        "The entry has today's date; change it if the stores publish on another day."
      : `site/changelog.html already had an entry for ${version}, which is as it was. Check its notes and its date.`,
    `Put the Firefox release notes for ${version} in store-assets/LISTING.md.`,
    'If the Chrome store summary changes with this release, change the description in extension/manifest.json and ' +
      'package.json (132 characters at most).',
    `Run npm run check.${notesLeft ? ' It fails until the release notes are written.' : ''}`
  ];
  return [
    `Changed ${current} to ${version} in ${files.length} files:`,
    ...files.map((file) => `  ${file}`),
    '',
    'Left to do by hand:',
    ...steps.map((step, index) => `  ${index + 1}. ${step}`),
    '',
    'Building the packages comes after the merge: npm run release -- <commit> (AGENTS.md, "Releases").',
    ...(leftover ? ['', leftoverNote(leftover)] : [])
  ].join('\n');
}

function main(args, options = {}) {
  if (args.length !== 1) throw new VersionError('Usage: npm run version:set -- X.Y.Z');
  return report(setVersion({ ...options, version: args[0] }));
}

if (require.main === module) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof VersionError)) throw error;
    console.error(`${error.message}\nNothing was changed.`);
    process.exitCode = 1;
  }
}

module.exports = {
  compareVersions,
  parseVersion,
  PLACES,
  report,
  setVersion,
  sitePages,
  VersionError,
  versionBumpProblems,
  versionEdits,
  versionFiles
};
