'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { describe, test } = require('node:test');
const {
  PLACES,
  parseVersion,
  report,
  setVersion,
  sitePages,
  VersionError,
  versionBumpProblems,
  versionEdits,
  versionFiles
} = require('../scripts/version-set');
const release = require('../scripts/release');

const { root } = require('./helpers/load-script');

// These tests never write a version to the repository: every bump is made in
// a temporary copy of the files a bump touches.
const pages = sitePages(root);
const files = versionFiles(pages);
const current = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')).version;
const [major, minor, patch] = parseVersion(current);
const next = `${major}.${minor}.${patch + 1}`;
const today = new Date(2026, 10, 20);
const NOTES = `site/changelog.html's entry for ${next} has no release notes yet`;
const TODO = `<!-- TODO: the release notes for ${next}, one <li> for each change, in place of this comment -->`;

const reader = (directory) => (file) => fs.readFileSync(path.join(directory, file), 'utf8');

// The files a bump touches, as the repository has them. While its own newest
// entry in the changelog waits for its release notes, the copies get some, so
// that only the test of the repository itself fails until they are written.
const original = new Map(files.map((file) => [file, reader(root)(file)]));
original.set('site/changelog.html', original.get('site/changelog.html').replace(/<!-- TODO[\s\S]*?-->/, '<li>A fix.</li>'));
const unchanged = (file) => original.get(file);

function copyRepository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-version-set-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of [...files, 'scripts/version-set.js']) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), original.get(file) ?? reader(root)(file));
  }
  return directory;
}

function edit(directory, file, change) {
  const text = reader(directory)(file);
  const changed = change(text);
  assert.ok(changed !== text, `the test's edit of ${file} changed nothing`);
  fs.writeFileSync(path.join(directory, file), changed);
}

// The files of a copy that differ from what it was made from. Whole files
// are compared here and not by assert.equal, which would print both.
function changedFiles(directory) {
  return files.filter((file) => reader(directory)(file) !== unchanged(file));
}

function refuses(directory, version, message, options = {}) {
  assert.throws(
    () => setVersion({ directory, version, today, ...options }),
    (error) => error instanceof VersionError && message.test(error.message)
  );
  assert.deepEqual(changedFiles(directory), []);
}

describe('The check of a version bump', () => {
  const somePages = ['index.html', 'changelog.html', 'privacy.html'];
  const footer = (version) => `<footer><span>Slowed &amp; Reverb ${version}</span></footer>`;
  const repository = (version) => ({
    'extension/manifest.json': JSON.stringify({ version }),
    'package.json': JSON.stringify({ version }),
    'package-lock.json': JSON.stringify({ version, packages: { '': { version } } }),
    'extension/content.js': `  const VERSION = '${version}';`,
    'extension/spotify-bridge.js': `  const VERSION = '${version}';`,
    'extension/spotify-main.js': `  const VERSION = '${version}';`,
    'extension/youtube-main.js': `  const VERSION = '${version}';`,
    'site/index.html': footer(version),
    'site/changelog.html': `<section><h2>${version} <time datetime="2026-10-20">October 20, 2026</time></h2><ul><li>A fix.</li></ul></section>${footer(version)}`,
    'site/privacy.html': `This policy covers version 1.0.0 and later of Slowed &amp; Reverb.${footer(version)}`
  });

  test('passes when everything shows the new version', () => {
    const repo = repository('1.1.2');
    assert.deepEqual(versionBumpProblems((file) => repo[file], somePages, '1.1.2'), []);
  });

  test('lists everything still showing the old version', () => {
    const repo = repository('1.1.1');
    repo['package.json'] = JSON.stringify({ version: '1.1.2' });
    repo['extension/spotify-main.js'] = "  const VERSION = '1.1.2';";

    assert.deepEqual(versionBumpProblems((file) => repo[file], somePages, '1.1.2'), [
      'extension/manifest.json has version 1.1.1',
      'package-lock.json has another version in its root entries',
      'extension/content.js has VERSION 1.1.1',
      'extension/spotify-bridge.js has VERSION 1.1.1',
      'extension/youtube-main.js has VERSION 1.1.1',
      "site/index.html doesn't show 1.1.2 in its footer",
      "site/changelog.html doesn't show 1.1.2 in its footer",
      "site/privacy.html doesn't show 1.1.2 in its footer",
      'site/changelog.html has no entry for 1.1.2'
    ]);
  });

  test('reports a lockfile with only one of its root versions changed', () => {
    const repo = repository('1.1.2');
    repo['package-lock.json'] = JSON.stringify({ version: '1.1.2', packages: { '': { version: '1.1.1' } } });
    assert.deepEqual(versionBumpProblems((file) => repo[file], somePages, '1.1.2'), [
      'package-lock.json has another version in its root entries'
    ]);
  });

  test("doesn't take a changelog entry for finished until its release notes are written", () => {
    const repo = repository('1.1.2');
    const entry = (body) => `<section><h2>1.1.2 <time datetime="2026-10-20">October 20, 2026</time></h2>${body}</section>
      <section><h2>1.1.1 <time datetime="2026-10-16">October 16, 2026</time></h2><ul><li>An earlier fix.</li></ul></section>`;
    const problems = (body) => {
      repo['site/changelog.html'] = entry(body) + footer('1.1.2');
      return versionBumpProblems((file) => repo[file], somePages, '1.1.2');
    };
    const unwritten = ["site/changelog.html's entry for 1.1.2 has no release notes yet"];

    assert.deepEqual(problems('<ul><!-- TODO: the release notes for 1.1.2 --></ul>'), unwritten);
    assert.deepEqual(problems('<ul><!-- TODO: the release notes for 1.1.2 --><li>A fix.</li></ul>'), unwritten);
    assert.deepEqual(problems('<ul></ul>'), unwritten);
    assert.deepEqual(problems('<ul><li></li></ul>'), unwritten);
    assert.deepEqual(problems('<!-- A fix. -->'), unwritten);
    // What looks like a tag inside a comment or an attribute isn't one.
    assert.deepEqual(problems('<!-- Keep the </section> tag below. --><ul><!-- TODO: the release notes for 1.1.2 --></ul>'), unwritten);
    assert.deepEqual(problems('<!-- Keep the <h2> above. --><ul></ul>'), unwritten);
    assert.deepEqual(problems('<ul><li title=">"></li></ul>'), unwritten);
    assert.deepEqual(problems("<ul><li title='>'></li></ul>"), unwritten);
    assert.deepEqual(problems('<ul><!-- TODO: the release notes, one <li> for each change'), unwritten);
    assert.deepEqual(problems('<!-- Keep the </section> tag below. --><ul><li title=">">A fix.</li></ul>'), []);
    assert.deepEqual(problems('<ul><li>A fix.</li></ul>'), []);
    assert.deepEqual(problems('<p>The first release.</p>'), []);
    // The comment is the placeholder. The word in the notes is only a word.
    assert.deepEqual(problems('<ul><li>Saved presets named TODO now keep their names.</li></ul>'), []);
  });

  test('the repository is consistent with its own version', () => {
    assert.deepEqual(versionBumpProblems(reader(root), pages, current), []);
  });
});

describe('One list of places', () => {
  test('the release checks a bump with the function that goes through the list the command writes from', () => {
    assert.ok(release.versionBumpProblems === versionBumpProblems);
    const source = fs.readFileSync(path.join(root, 'scripts/release.js'), 'utf8');
    assert.match(source, /versionBumpProblems\(read, sitePages\(tree\), version\)/);
    // The list's own patterns stay out of the release tool.
    assert.doesNotMatch(source, /const VERSION =|Slowed &amp; Reverb|applies to versions|covers versions|<h2>/);
  });

  test('the check and the command read the list they are given', () => {
    const place = {
      files: () => ['a.txt'],
      problem: (file, text, version) => (text === version ? null : `${file} has ${text}`),
      write: (file, text, version) => version
    };
    const read = () => '1.0.0';
    assert.deepEqual(versionBumpProblems(read, [], '1.0.1', [place]), ['a.txt has 1.0.0']);
    assert.deepEqual([...versionEdits(read, [], '1.0.1', { today }, [place])], [['a.txt', '1.0.1']]);
    assert.deepEqual(versionFiles([], [place]), ['a.txt']);
  });

  test('a place added to the list is written by the command and checked by the release, with no list handed to either', (t) => {
    const directory = copyRepository(t);
    fs.writeFileSync(path.join(directory, 'added.txt'), current);
    const place = {
      files: () => ['added.txt'],
      problem: (file, text, version) => (text === version ? null : `${file} has ${text}`),
      write: (file, text, version) => version
    };
    PLACES.push(place);
    try {
      assert.deepEqual(release.versionBumpProblems(reader(directory), pages, current), []);
      assert.ok(release.versionBumpProblems(reader(directory), pages, next).includes(`added.txt has ${current}`));
      assert.ok(versionFiles(pages).includes('added.txt'));

      const result = setVersion({ directory, version: next, today });
      assert.deepEqual(result.files, [...files, 'added.txt']);
      assert.equal(reader(directory)('added.txt'), next);
      assert.deepEqual(release.versionBumpProblems(reader(directory), pages, next), [NOTES]);
    } finally {
      PLACES.splice(PLACES.indexOf(place), 1);
    }
    assert.ok(!versionFiles(pages).includes('added.txt'));
  });

  test('each place is checked in the files it is written in, and its own writing satisfies its own check', () => {
    assert.ok(PLACES.length > 0);
    for (const place of PLACES) {
      const names = place.files(pages).join(', ');
      const checked = [];
      const before = versionBumpProblems(
        (file) => {
          checked.push(file);
          return unchanged(file);
        },
        pages,
        next,
        [place]
      );
      // Unchanged, every file of the place is reported.
      assert.equal(before.length, place.files(pages).length, names);

      const texts = versionEdits(unchanged, pages, next, { today }, [place]);
      assert.deepEqual([...texts.keys()], checked, names);
      for (const [file, text] of texts) assert.ok(text !== unchanged(file), `${file} is written`);
      const after = versionBumpProblems((file) => texts.get(file), pages, next, [place]);
      assert.deepEqual(after, names === 'site/changelog.html' ? [NOTES] : [], names);
    }
  });

  test('what the list names is what AGENTS.md says a bump touches', () => {
    assert.deepEqual(
      [...files].sort(),
      [
        'extension/content.js',
        'extension/manifest.json',
        'extension/spotify-bridge.js',
        'extension/spotify-main.js',
        'extension/youtube-main.js',
        'package-lock.json',
        'package.json',
        ...pages.map((page) => `site/${page}`)
      ].sort()
    );
    assert.ok(pages.includes('changelog.html') && pages.includes('privacy.html'));
  });
});

describe('npm run version:set', () => {
  test('writes the version everywhere, leaving only the release notes for the check to report', (t) => {
    const directory = copyRepository(t);
    const result = setVersion({ directory, version: next, today });

    assert.deepEqual(result, { current, version: next, files, notesLeft: true, leftover: null });
    assert.deepEqual(changedFiles(directory), files);
    // Nothing of the writing is left beside the files.
    assert.deepEqual(fs.readdirSync(directory).sort(), ['extension', 'package-lock.json', 'package.json', 'scripts', 'site']);
    assert.deepEqual(versionBumpProblems(reader(directory), pages, next), [NOTES]);

    edit(directory, 'site/changelog.html', (text) => text.replace(TODO, '<li>A fix.</li>'));
    assert.deepEqual(versionBumpProblems(reader(directory), pages, next), []);
  });

  test('changes only the version in each file', (t) => {
    const directory = copyRepository(t);
    setVersion({ directory, version: next, today });
    // The lines of a file that differ, where the bump adds no lines.
    const changedLines = (file) => {
      const [before, after] = [unchanged(file).split('\n'), reader(directory)(file).split('\n')];
      assert.equal(after.length, before.length, file);
      return after.filter((line, index) => line !== before[index]);
    };

    assert.deepEqual(changedLines('extension/manifest.json'), [`  "version": "${next}",`]);
    assert.deepEqual(changedLines('package.json'), [`  "version": "${next}",`]);
    assert.deepEqual(changedLines('package-lock.json'), [`  "version": "${next}",`, `      "version": "${next}",`]);
    const lock = JSON.parse(reader(directory)('package-lock.json'));
    assert.equal(lock.version, next);
    assert.equal(lock.packages[''].version, next);
    for (const file of ['content.js', 'spotify-bridge.js', 'spotify-main.js', 'youtube-main.js']) {
      assert.deepEqual(changedLines(`extension/${file}`), [`  const VERSION = '${next}';`]);
    }
    // The privacy policy's page is one of these: only its footer changes.
    assert.ok(pages.includes('privacy.html'));
    for (const page of pages.filter((name) => name !== 'changelog.html')) {
      assert.deepEqual(changedLines(`site/${page}`), [`    <span>Slowed &amp; Reverb ${next}</span>`]);
    }
  });

  test("adds the changelog's entry above the newest, with the day and a place for the release notes", (t) => {
    const directory = copyRepository(t);
    setVersion({ directory, version: next, today });
    const [before, after] = [unchanged('site/changelog.html'), reader(directory)('site/changelog.html')];
    const entry = [
      '    <section class="entry">',
      `      <h2>${next} <time datetime="2026-11-20">November 20, 2026</time></h2>`,
      '      <ul>',
      `        ${TODO}`,
      '      </ul>',
      '    </section>',
      '',
      ''
    ].join('\n');
    const at = before.indexOf('    <section class="entry">');
    const expected = (before.slice(0, at) + entry + before.slice(at)).replace(
      `<span>Slowed &amp; Reverb ${current}</span>`,
      `<span>Slowed &amp; Reverb ${next}</span>`
    );
    assert.ok(after === expected, 'the changelog is the earlier one with the new entry first and the new footer');
  });

  test('writes the day with two digits where the page wants them', (t) => {
    const directory = copyRepository(t);
    setVersion({ directory, version: next, today: new Date(2027, 0, 5) });
    assert.ok(reader(directory)('site/changelog.html').includes(`<h2>${next} <time datetime="2027-01-05">January 5, 2027</time></h2>`));
  });

  test('keeps a changelog entry written ahead of the bump', (t) => {
    const directory = copyRepository(t);
    const written = `    <section class="entry">\n      <h2>${next} <time datetime="2026-11-19">November 19, 2026</time></h2>\n      <ul>\n        <li>A fix.</li>\n      </ul>\n    </section>\n\n`;
    edit(directory, 'site/changelog.html', (text) => text.replace('    <section class="entry">', `${written}    <section class="entry">`));
    const ahead = reader(directory)('site/changelog.html');

    const result = setVersion({ directory, version: next, today });
    assert.equal(result.notesLeft, false);
    assert.deepEqual(versionBumpProblems(reader(directory), pages, next), []);
    const footer = (version) => `<span>Slowed &amp; Reverb ${version}</span>`;
    assert.ok(reader(directory)('site/changelog.html') === ahead.replace(footer(current), footer(next)), 'only the footer changed');
    assert.match(report(result), /already had an entry/);
    assert.doesNotMatch(report(result), /TODO/);
  });

  // The policy covers "version 1.0.0 and later", so a release that doesn't
  // change what the extension stores or sends leaves it as it is, and the
  // copy on Firefox Add-ons with it. A list of versions would bring the edit
  // back with every release.
  test("leaves the privacy policy's words alone, which name no version but the first and the rating reminder's", (t) => {
    const directory = copyRepository(t);
    setVersion({ directory, version: next, today });
    assert.ok(!files.includes('PRIVACY.md'));
    const versions = (text) => [...new Set(text.match(/\d+\.\d+\.\d+/g))].sort();
    const policy = reader(root)('PRIVACY.md');
    // The page's words: its article, which leaves out the icons' drawings
    // and the footer.
    const page = /<article[\s\S]*<\/article>/.exec(reader(directory)('site/privacy.html'))[0].replace(/<[^>]*>/g, ' ');
    assert.deepEqual(versions(policy), ['1.0.0', '1.1.0']);
    assert.deepEqual(versions(page), ['1.0.0', '1.1.0']);
    assert.match(policy, /applies to version `1\.0\.0` and later of the/);
    assert.match(page, /covers version 1\.0\.0 and later of Slowed/);
  });

  test("refuses a version that isn't higher than the current one, or isn't one", (t) => {
    const directory = copyRepository(t);
    const lower = patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor > 0 ? minor - 1 : 0}.0`;
    refuses(directory, current, /isn't higher than the current version/);
    refuses(directory, '0.9.9', /isn't higher than the current version/);
    if (lower !== current) refuses(directory, lower, /isn't higher than the current version/);
    for (const version of [undefined, '', '1.3', `v${next}`, `${next}.0`, `${next}-beta`, `0${next}`, `${next} `]) {
      refuses(directory, version, /three numbers/);
    }
  });

  test('compares versions as numbers, not as text', (t) => {
    const directory = copyRepository(t);
    const result = setVersion({ directory, version: `${major}.${minor + 10}.0`, today });
    assert.equal(result.version, `${major}.${minor + 10}.0`);
  });

  test("refuses when the repository doesn't show its current version everywhere", (t) => {
    const directory = copyRepository(t);
    edit(directory, 'extension/content.js', (text) => text.replace(`const VERSION = '${current}';`, "const VERSION = '0.0.1';"));
    assert.throws(
      () => setVersion({ directory, version: next, today }),
      (error) => error instanceof VersionError && /extension\/content\.js has VERSION 0\.0\.1/.test(error.message)
    );
    assert.deepEqual(changedFiles(directory), ['extension/content.js']);
    assert.ok(reader(directory)('extension/content.js').includes("const VERSION = '0.0.1';"));
  });

  test('refuses another bump while the last one still needs its release notes', (t) => {
    const directory = copyRepository(t);
    setVersion({ directory, version: next, today });
    const bumped = files.map((file) => reader(directory)(file));
    assert.throws(
      () => setVersion({ directory, version: `${major + 1}.0.0`, today }),
      (error) => error instanceof VersionError && error.message.includes(NOTES)
    );
    assert.ok(files.every((file, index) => reader(directory)(file) === bumped[index]));
  });

  test("changes nothing when one place can't be written", (t) => {
    // Each of these passes the check for the current version, so it is the
    // writing that stops, after the places before it were worked out.
    const breaks = [
      ['site/privacy.html', (text) => text.replace('</footer>', `<span>Slowed &amp; Reverb ${current}</span></footer>`), /site\/privacy\.html doesn't show a version once/],
      ['extension/youtube-main.js', (text) => `${text}\nconst VERSION = '${current}';\n`, /extension\/youtube-main\.js doesn't define VERSION once/],
      ['package-lock.json', (text) => text.replace(/^ {2}"version": /m, '  "version" : '), /package-lock\.json: its version isn't written the expected way/],
      ['site/changelog.html', (text) => text.replaceAll('<section class="entry">', '<section class="note">'), /site\/changelog\.html has no entry to put the new one above/]
    ];
    for (const [file, change, message] of breaks) {
      const directory = copyRepository(t);
      edit(directory, file, change);
      assert.deepEqual(versionBumpProblems(reader(directory), pages, current), [], file);
      const broken = reader(directory)(file);
      assert.throws(
        () => setVersion({ directory, version: next, today }),
        (error) => error instanceof VersionError && message.test(error.message),
        file
      );
      assert.deepEqual(changedFiles(directory), [file]);
      assert.ok(reader(directory)(file) === broken, `${file} is as the test left it`);
    }
  });

  // The folders the command stages its writes in that are still there.
  const stages = (directory) => fs.readdirSync(directory).filter((name) => name.startsWith('.version-set-'));

  test('touches no file when the new texts fail to write', (t) => {
    const directory = copyRepository(t);
    let writes = 0;
    const io = {
      ...fs,
      writeFileSync(file, text, options) {
        writes += 1;
        if (writes < 4) return fs.writeFileSync(file, text, options);
        // Half a file, as a full disk leaves it, and no write works after it.
        if (writes === 4) fs.writeFileSync(file, text.slice(0, 10), options);
        throw new Error('no space left');
      }
    };
    assert.throws(
      () => setVersion({ directory, version: next, today, io }),
      (error) => error instanceof VersionError && /couldn't be written: no space left/.test(error.message)
    );
    assert.equal(writes, 4);
    assert.deepEqual(changedFiles(directory), []);
    assert.deepEqual(stages(directory), []);
  });

  test('puts back the files it replaced when one fails to be replaced, without writing', (t) => {
    const directory = copyRepository(t);
    let renames = 0;
    let failed = false;
    const io = {
      ...fs,
      renameSync(from, to) {
        renames += 1;
        if (renames === 4) {
          failed = true;
          throw new Error('input/output error');
        }
        return fs.renameSync(from, to);
      },
      // Once the disk fails, it takes no writes at all.
      writeFileSync(...args) {
        if (failed) throw new Error('input/output error');
        return fs.writeFileSync(...args);
      },
      copyFileSync(...args) {
        if (failed) throw new Error('input/output error');
        return fs.copyFileSync(...args);
      }
    };
    assert.throws(
      () => setVersion({ directory, version: next, today, io }),
      (error) => error instanceof VersionError && /couldn't be written: input\/output error/.test(error.message)
    );
    // Three replaced, one failed, three put back.
    assert.equal(renames, 7);
    assert.deepEqual(changedFiles(directory), []);
    assert.deepEqual(stages(directory), []);
  });

  test("puts back every file it can, and names the ones it can't with where each is kept", (t) => {
    const directory = copyRepository(t);
    let renames = 0;
    const io = {
      ...fs,
      // The fourth file fails to be replaced. Of the three to put back, the
      // second fails.
      renameSync(from, to) {
        renames += 1;
        if (renames === 4 || renames === 6) throw new Error('input/output error');
        return fs.renameSync(from, to);
      }
    };
    let thrown;
    try {
      setVersion({ directory, version: next, today, io });
    } catch (error) {
      thrown = error;
    }
    // Not the kind of error the command follows with "Nothing was changed."
    assert.ok(thrown instanceof Error && !(thrown instanceof VersionError));
    assert.equal(renames, 7);
    const [stage] = stages(directory);
    assert.ok(stage);
    assert.equal(
      thrown.message,
      "Writing stopped (input/output error), and these have the new version and couldn't be put back. " +
        `Each is kept as it was in ${path.join(directory, stage)}; copy it back by hand:\n  package.json (kept as 1.old)`
    );
    assert.deepEqual(changedFiles(directory), ['package.json']);
    assert.ok(fs.readFileSync(path.join(directory, stage, '1.old'), 'utf8') === unchanged('package.json'), 'package.json is kept as it was');
  });

  test('keeps each file as it was when none can be put back', (t) => {
    const directory = copyRepository(t);
    let renames = 0;
    const io = {
      ...fs,
      renameSync(from, to) {
        renames += 1;
        if (renames >= 4) throw new Error('input/output error');
        return fs.renameSync(from, to);
      }
    };
    assert.throws(
      () => setVersion({ directory, version: next, today, io }),
      (error) => !(error instanceof VersionError) && files.slice(0, 3).every((file, index) => error.message.includes(`  ${file} (kept as ${index}.old)`))
    );
    const [stage] = stages(directory);
    assert.deepEqual(changedFiles(directory), files.slice(0, 3));
    files.slice(0, 3).forEach((file, index) => {
      assert.ok(fs.readFileSync(path.join(directory, stage, `${index}.old`), 'utf8') === unchanged(file), `${file} is kept as it was`);
    });
  });

  test("a folder that can't be removed afterward doesn't undo the bump or hide why one failed", (t) => {
    const stuck = { ...fs, rmSync: () => { throw new Error('directory not empty'); } };

    const written = copyRepository(t);
    const result = setVersion({ directory: written, version: next, today, io: stuck });
    assert.deepEqual(changedFiles(written), files);
    assert.deepEqual(stages(written).map((name) => path.join(written, name)), [result.leftover]);
    assert.match(report(result), new RegExp(`^Changed .* in ${files.length} files:\n`));
    assert.ok(report(result).endsWith(`\n\nThe folder ${result.leftover}, used while writing, couldn't be removed. Remove it by hand.`));
    assert.doesNotMatch(report({ ...result, leftover: null }), /couldn't be removed/);

    const failed = copyRepository(t);
    const io = { ...stuck, writeFileSync: () => { throw new Error('no space left'); } };
    assert.throws(
      () => setVersion({ directory: failed, version: next, today, io }),
      (error) =>
        error instanceof VersionError &&
        error.message ===
          `The files couldn't be written: no space left\nThe folder ${path.join(failed, stages(failed)[0])}, used while writing, couldn't be removed. Remove it by hand.`
    );
    assert.deepEqual(changedFiles(failed), []);
  });

  test('keeps the permissions each file has', (t) => {
    const directory = copyRepository(t);
    const modes = { 'package.json': 0o664, 'site/privacy.html': 0o600, 'extension/content.js': 0o755 };
    for (const [file, mode] of Object.entries(modes)) fs.chmodSync(path.join(directory, file), mode);
    const before = files.map((file) => fs.statSync(path.join(directory, file)).mode);

    setVersion({ directory, version: next, today });
    assert.deepEqual(files.map((file) => fs.statSync(path.join(directory, file)).mode), before);
    for (const [file, mode] of Object.entries(modes)) assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, mode, file);
  });

  test('says what it changed and what is left to do by hand', (t) => {
    const directory = copyRepository(t);
    const run = (...args) => spawnSync(process.execPath, [path.join(directory, 'scripts/version-set.js'), ...args], { encoding: 'utf8' });

    const usage = run();
    assert.equal(usage.status, 1);
    assert.equal(usage.stderr, 'Usage: npm run version:set -- X.Y.Z\nNothing was changed.\n');
    const refused = run(current);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.equal(refused.stderr, `${current} isn't higher than the current version, ${current}.\nNothing was changed.\n`);
    assert.deepEqual(changedFiles(directory), []);

    const done = run(next);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(done.stderr, '');
    assert.deepEqual(changedFiles(directory), files);
    const lines = done.stdout.split('\n');
    assert.equal(lines[0], `Changed ${current} to ${next} in ${files.length} files:`);
    assert.deepEqual(lines.slice(1, 1 + files.length), files.map((file) => `  ${file}`));
    assert.match(done.stdout, /\nLeft to do by hand:\n {2}1\. Write the release notes in site\/changelog\.html, in place of the TODO comment/);
    assert.match(done.stdout, new RegExp(`\\n {2}2\\. Put the Firefox release notes for ${next.replaceAll('.', '\\.')} in store-assets/LISTING\\.md\\.`));
    assert.match(done.stdout, /\n {2}4\. Run npm run check\. It fails until the release notes are written\.\n/);

    const again = run(next);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /isn't higher than the current version/);
  });

  test('is the script npm runs', () => {
    const { scripts } = JSON.parse(reader(root)('package.json'));
    assert.equal(scripts['version:set'], 'node scripts/version-set.js');
  });
});
