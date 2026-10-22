'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Buffer } = require('buffer');
const { spawn, spawnSync } = require('child_process');
const { describe, test } = require('node:test');
const {
  describeEntries,
  firefoxPrivacyText,
  lineChanges,
  nodeTestResults,
  previousVersion,
  pullRequests,
  releaseFiles,
  releaseRecord,
  resultsReporter,
  run,
  stillRunning,
  TEST_SCRIPTS,
  versionBumpProblems,
  wrap,
  writeReleaseFolder
} = require('../scripts/release');

const { root } = require('./helpers/load-script');

describe('Firefox privacy policy text', () => {
  test('drops the title, makes headings bold and puts each paragraph and item on one line', () => {
    const markdown = [
      '# Privacy Policy for Slowed & Reverb',
      '',
      'Effective date: October 16, 2026',
      '',
      '## Summary',
      '',
      'Slowed & Reverb processes audio',
      'locally in the browser.',
      '',
      '## Data stored on the device',
      '',
      'The browser holds only:',
      '',
      '- effect settings, such as speed',
      '  and reverb; and',
      '- the selected popup theme.',
      '',
      '## Permissions',
      '',
      '- `storage` saves local settings.',
      ''
    ].join('\n');

    assert.equal(
      firefoxPrivacyText(markdown),
      [
        'Effective date: October 16, 2026',
        '',
        '**Summary**',
        'Slowed & Reverb processes audio locally in the browser.',
        '',
        '**Data stored on the device**',
        'The browser holds only:',
        '',
        '- effect settings, such as speed and reverb; and',
        '- the selected popup theme.',
        '',
        '**Permissions**',
        '',
        '- `storage` saves local settings.',
        ''
      ].join('\n')
    );
  });

  test('keeps web links and turns email links into plain addresses', () => {
    const markdown = [
      '# Privacy Policy',
      '',
      'Use the [public issue tracker](https://github.com/sahinozan/slowed-and-reverb/issues),',
      'or email [help@example.com](mailto:help@example.com).'
    ].join('\n');

    assert.equal(
      firefoxPrivacyText(markdown),
      'Use the [public issue tracker](https://github.com/sahinozan/slowed-and-reverb/issues), or email help@example.com.\n'
    );
  });

  test('a list right after a paragraph line gets a blank line before it, like the others', () => {
    assert.equal(
      firefoxPrivacyText('The extension does not:\n- send data; or\n- track you.\n'),
      'The extension does not:\n\n- send data; or\n- track you.\n'
    );
  });

  test('the repository privacy policy converts cleanly', () => {
    const markdown = fs.readFileSync(path.join(root, 'PRIVACY.md'), 'utf8');
    const text = firefoxPrivacyText(markdown);

    assert.doesNotMatch(text, /^#/m);
    assert.doesNotMatch(text, /mailto:/);
    assert.doesNotMatch(text, /\n{3}/);
    assert.match(text, /^\*\*Summary\*\*\nSlowed & Reverb processes audio locally in the browser\. /m);
    for (const link of markdown.match(/\]\(https:[^)]+\)/g)) assert.ok(text.includes(link), link);
  });
});

describe('Release folders', () => {
  test('compares with the newest earlier release', () => {
    assert.equal(previousVersion(['1.0.1', '1.1.0', '1.1.1', 'notes'], '1.1.2'), '1.1.1');
    assert.equal(previousVersion(['1.9.0', '1.10.0', '2.0.0'], '1.10.1'), '1.10.0');
    assert.equal(previousVersion(['1.1.1'], '1.1.1'), null);
    assert.equal(previousVersion([], '1.0.0'), null);
  });

  test('describes archive entries the way the records do', () => {
    const entries = [
      { name: 'manifest.json', isDirectory: false },
      { name: 'assets/', isDirectory: true },
      { name: 'assets/icon16.png', isDirectory: false }
    ];
    assert.equal(describeEntries(entries), '3 (2 files plus the assets directory entry)');
    assert.equal(describeEntries(entries.filter((entry) => !entry.isDirectory)), '2');
  });

  test('finds pull requests in merge and squash subjects', () => {
    assert.deepEqual(
      pullRequests([
        'Merge pull request #84 from sahinozan/fix/youtube-engine-version',
        'Keep the engines off after an update (#85)',
        'Merge remote-tracking branch origin/main into fix/youtube-engine-version'
      ]),
      [84, 85]
    );
  });
});

describe('Version bump', () => {
  const pages = ['index.html', 'changelog.html', 'privacy.html'];
  const footer = (version) => `<footer><span>Slowed &amp; Reverb ${version}</span></footer>`;
  const files = (version) => ({
    'package.json': JSON.stringify({ version }),
    'package-lock.json': JSON.stringify({ version, packages: { '': { version } } }),
    'extension/content.js': `  const VERSION = '${version}';`,
    'extension/spotify-bridge.js': `  const VERSION = '${version}';`,
    'extension/spotify-main.js': `  const VERSION = '${version}';`,
    'extension/youtube-main.js': `  const VERSION = '${version}';`,
    'site/index.html': footer(version),
    'site/changelog.html': `<h2>${version} <time datetime="2026-10-20">October 20, 2026</time></h2>${footer(version)}`,
    'site/privacy.html': `This policy covers versions 1.0.0, 1.1.1 and ${version} of Slowed &amp; Reverb.${footer(version)}`,
    'PRIVACY.md': `This policy applies to versions \`1.0.0\`, \`1.1.1\`, and \`${version}\` of the\nextension.`
  });

  test('passes when everything shows the new version', () => {
    const repo = files('1.1.2');
    assert.deepEqual(versionBumpProblems((file) => repo[file], pages, '1.1.2'), []);
  });

  test('lists everything still showing the old version', () => {
    const repo = files('1.1.1');
    repo['package.json'] = JSON.stringify({ version: '1.1.2' });
    repo['extension/spotify-main.js'] = "  const VERSION = '1.1.2';";
    repo['PRIVACY.md'] = 'This policy applies to versions `1.0.0`, `1.1.1`, and `1.1.12` of the\nextension.';

    assert.deepEqual(versionBumpProblems((file) => repo[file], pages, '1.1.2'), [
      'package-lock.json has another version in its root entries',
      'extension/content.js has VERSION 1.1.1',
      'extension/spotify-bridge.js has VERSION 1.1.1',
      'extension/youtube-main.js has VERSION 1.1.1',
      "site/index.html doesn't show 1.1.2 in its footer",
      "site/changelog.html doesn't show 1.1.2 in its footer",
      "site/privacy.html doesn't show 1.1.2 in its footer",
      'site/changelog.html has no entry for 1.1.2',
      "PRIVACY.md's versions line doesn't list 1.1.2",
      "site/privacy.html's versions line doesn't list 1.1.2"
    ]);
  });

  test('the repository is consistent with its own version', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
    const sitePages = fs.readdirSync(path.join(root, 'site')).filter((name) => name.endsWith('.html'));
    const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
    assert.deepEqual(versionBumpProblems(read, sitePages, version), []);
  });
});

describe('Release record', () => {
  const info = (size, sha256, entries) => ({ size, sha256, entries });
  const release = {
    version: '1.1.2',
    previous: '1.1.1',
    date: '2026-10-20',
    commit: 'a'.repeat(40),
    commitNote: 'main, after PR #86',
    mergedSince: [83, 84, 86],
    node: '24.19.0',
    npm: '11.19.0',
    packages: {
      chromium: info(61400, 'b'.repeat(64), '17 (16 files plus the assets directory entry)'),
      firefox: info(61500, 'c'.repeat(64), '17 (16 files plus the assets directory entry)'),
      source: info(6740000, 'd'.repeat(64), '127')
    },
    inventory: { files: 16, added: [], removed: [] },
    changed: {
      chromium: ['content.js', 'manifest.json'],
      firefox: ['content.js', 'manifest.json']
    },
    privacyChanges: {
      same: false,
      changed: ['This policy applies to versions `1.0.0`, `1.0.1`, `1.1.0`, `1.1.1`, and `1.1.2` of the'],
      added: [],
      removed: []
    },
    checks: {
      tests: 150,
      e2e: 5,
      firefox: 4,
      descriptionLength: 130,
      lint: { errors: 0, warnings: 0, notices: 0 }
    }
  };

  test('records the packages, checks and what is left to fill in', () => {
    const record = releaseRecord(release);
    const flat = record.replace(/\s+/g, ' ');

    assert.match(record, /^Slowed & Reverb 1\.1\.2 release artifact record\nDate: 2026-10-20\n/);
    assert.match(record, new RegExp(`^Source commit: ${'a'.repeat(40)} \\(main, after PR #86\\)$`, 'm'));
    assert.match(record, /^Release changes merged in: TODO \(merged since 1\.1\.1: PR #83, #84, #86\)$/m);
    assert.match(record, /^slowed-reverb-chromium\.zip {2}\(upload to the Chrome Web Store\)\nSize: 61400 bytes\nSHA-256: b{64}\n/m);
    assert.match(record, /^slowed-reverb-firefox\.zip {2}\(upload to Firefox Add-ons\)\nSize: 61500 bytes\nSHA-256: c{64}\n/m);
    assert.match(record, /^SHA-256: d{64}\nEntries: 127\nMade with: git archive --format=zip HEAD -- \. ':\(exclude\)store-assets\/originals'$/m);
    assert.match(flat, /Compared with the 1\.1\.1 copy, 1 line changed \("This policy applies to versions `1\.0\.0`,…"\)\./);
    assert.match(record, /^- npm run check: passed \(150 tests; Chromium lint; Firefox build and lint\)$/m);
    assert.match(record, /^- Archive inventories: the same 16 files as 1\.1\.1$/m);
    assert.match(flat, / - Compared with the 1\.1\.1 archives, content\.js and manifest\.json differ, in both packages - /);
    assert.match(record, /^- TODO: what was checked by hand/m);
    assert.match(
      flat,
      /Upload the files in this folder; logs\/ holds the output of each check and is not for upload\. Do not rebuild them without repeating verification and replacing this record\. $/
    );
    // Only the files' headings and the command are longer, as in earlier records.
    for (const line of record.split('\n').filter((line) => !/^(slowed-reverb|firefox-privacy|Made with)/.test(line))) {
      assert.ok(line.length <= 78, line);
    }
  });

  test('asks why files were added or removed', () => {
    const record = releaseRecord({
      ...release,
      inventory: { files: 17, added: ['equalizer.js'], removed: [] },
      changed: { chromium: ['manifest.json'], firefox: ['background.js', 'manifest.json'] }
    });
    const flat = record.replace(/\s+/g, ' ');

    assert.match(flat, / - Archive inventories: 17 files; added since 1\.1\.1: equalizer\.js \(TODO: say why\) - /);
    assert.match(
      flat,
      / - Compared with the 1\.1\.1 archives: in the Chromium package manifest\.json differs; in the Firefox package background\.js and manifest\.json differ - /
    );
  });

  test('says how the privacy policy copy changed, removals included', () => {
    const note = (privacyChanges) => releaseRecord({ ...release, privacyChanges }).replace(/\s+/g, ' ');
    const none = { changed: [], added: [], removed: [] };

    assert.match(note({ same: true, ...none }), /It is the same as the 1\.1\.1 copy\./);
    assert.match(
      note({ same: false, ...none, removed: ['Optional site permissions are recorded and managed by the browser.'] }),
      /Compared with the 1\.1\.1 copy, 1 line removed \("Optional site permissions are recorded and…"\)\./
    );
    assert.match(note({ same: false, ...none }), /It differs from the 1\.1\.1 copy only in blank lines\./);
  });

  test('wraps long lines at the record width', () => {
    assert.equal(wrap('- one two three', '  ', 9), '- one two\n  three');
  });
});

describe('Line changes', () => {
  const policy = ['Effective date: October 16, 2026', '', 'Versions 1.1.0 and 1.1.1.', '', 'Summary.', '', 'Storage.', ''].join('\n');

  test('finds nothing in the same text', () => {
    assert.deepEqual(lineChanges(policy, policy), { same: true, changed: [], added: [], removed: [] });
  });

  test('pairs a line changed in place and keeps a removed one apart', () => {
    const after = policy.replace('Versions 1.1.0 and 1.1.1.', 'Versions 1.1.0, 1.1.1 and 1.1.2.').replace('Summary.\n\n', '');
    assert.deepEqual(lineChanges(policy, after), {
      same: false,
      changed: ['Versions 1.1.0, 1.1.1 and 1.1.2.'],
      added: [],
      removed: ['Summary.']
    });
  });

  test('reports a removal on its own and a change of order', () => {
    assert.deepEqual(lineChanges(policy, policy.replace('Storage.\n', '')).removed, ['Storage.']);

    const reordered = lineChanges(policy, policy.replace('Summary.\n\nStorage.', 'Storage.\n\nSummary.'));
    assert.equal(reordered.same, false);
    assert.ok(reordered.changed.length + reordered.added.length + reordered.removed.length > 0);
  });

  test('ignores blank lines in the lists but not in the comparison', () => {
    assert.deepEqual(lineChanges(policy, `${policy}\n`), { same: false, changed: [], added: [], removed: [] });
  });
});

describe('Release folder', () => {
  const temporary = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-release-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  // A scratch folder as a release leaves it: built packages, the source zip
  // and each check's log.
  const scratch = (dir) => {
    const work = path.join(dir, 'work');
    const builtDir = path.join(work, 'tree', 'dist', 'packages');
    const logs = path.join(work, 'logs');
    fs.mkdirSync(builtDir, { recursive: true });
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(builtDir, 'slowed-reverb-chromium.zip'), Buffer.from([0x50, 0x4b, 0, 1, 2, 0xff]));
    fs.writeFileSync(path.join(builtDir, 'slowed-reverb-firefox.zip'), Buffer.from([0x50, 0x4b, 3, 4, 0xfe]));
    fs.writeFileSync(path.join(work, 'slowed-reverb-firefox-source.zip'), 'source');
    fs.writeFileSync(path.join(logs, 'check.log'), 'ℹ tests 3\nℹ pass 3\n');
    fs.writeFileSync(path.join(logs, 'web-ext-lint.json'), '{"count":{}}');
    return {
      work,
      logs,
      files: releaseFiles({
        version: '1.1.2',
        builtDir,
        sourceZip: path.join(work, 'slowed-reverb-firefox-source.zip'),
        privacy: 'policy\n',
        record: 'record\n',
        logs
      })
    };
  };

  test('writes the files into a new folder', (t) => {
    const dir = temporary(t);
    const zip = path.join(dir, 'built.zip');
    fs.writeFileSync(zip, 'zip');
    const outDir = path.join(dir, 'packages', '1.1.2');

    writeReleaseFolder(outDir, { 'slowed-reverb-chromium.zip': { from: zip }, 'RELEASE-1.1.2.txt': { text: 'record' } });

    assert.deepEqual(fs.readdirSync(outDir).sort(), ['RELEASE-1.1.2.txt', 'slowed-reverb-chromium.zip']);
    assert.equal(fs.readFileSync(path.join(outDir, 'slowed-reverb-chromium.zip'), 'utf8'), 'zip');
    assert.deepEqual(fs.readdirSync(path.dirname(outDir)), ['1.1.2']);
  });

  test("keeps the checks' logs and the exact packages after the scratch folder is removed", (t) => {
    const dir = temporary(t);
    const { work, files } = scratch(dir);
    const before = Object.fromEntries(
      Object.entries(files)
        .filter(([, file]) => 'from' in file)
        .map(([name, file]) => [name, fs.readFileSync(file.from)])
    );
    const outDir = path.join(dir, 'packages', '1.1.2');

    writeReleaseFolder(outDir, files);
    fs.rmSync(work, { recursive: true, force: true });

    assert.deepEqual(fs.readdirSync(outDir).sort(), [
      'RELEASE-1.1.2.txt',
      'firefox-privacy-policy.txt',
      'logs',
      'slowed-reverb-chromium.zip',
      'slowed-reverb-firefox-source.zip',
      'slowed-reverb-firefox.zip'
    ]);
    assert.deepEqual(fs.readdirSync(path.join(outDir, 'logs')), ['check.log', 'web-ext-lint.json']);
    for (const [name, bytes] of Object.entries(before)) assert.ok(fs.readFileSync(path.join(outDir, name)).equals(bytes), name);
  });

  test('never writes into a folder that appeared during the checks', (t) => {
    const dir = temporary(t);
    const outDir = path.join(dir, '1.1.2');
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, 'RELEASE-1.1.2.txt'), 'verified');

    assert.throws(
      () => writeReleaseFolder(outDir, { 'RELEASE-1.1.2.txt': { text: 'draft' }, 'extra.txt': { text: 'x' } }),
      /appeared while the checks ran/
    );
    assert.deepEqual(fs.readdirSync(outDir), ['RELEASE-1.1.2.txt']);
    assert.equal(fs.readFileSync(path.join(outDir, 'RELEASE-1.1.2.txt'), 'utf8'), 'verified');
    assert.deepEqual(fs.readdirSync(dir), ['1.1.2']);
  });

  test('never replaces a folder that appeared while the files were written', (t) => {
    const dir = temporary(t);
    const zip = path.join(dir, 'built.zip');
    fs.writeFileSync(zip, 'zip');
    const outDir = path.join(dir, 'packages', '1.1.2');
    const appearing = {
      get from() {
        fs.mkdirSync(outDir);
        fs.writeFileSync(path.join(outDir, 'RELEASE-1.1.2.txt'), 'verified');
        return zip;
      }
    };

    assert.throws(
      () => writeReleaseFolder(outDir, { 'RELEASE-1.1.2.txt': { text: 'draft' }, 'slowed-reverb-chromium.zip': appearing }),
      /appeared while the checks ran/
    );
    assert.deepEqual(fs.readdirSync(path.dirname(outDir)), ['1.1.2']);
    assert.deepEqual(fs.readdirSync(outDir), ['RELEASE-1.1.2.txt']);
    assert.equal(fs.readFileSync(path.join(outDir, 'RELEASE-1.1.2.txt'), 'utf8'), 'verified');
  });

  // rename() replaces an empty folder, so this one must be refused too.
  test('never replaces an empty folder that appeared while the files were written', (t) => {
    const dir = temporary(t);
    const { files } = scratch(dir);
    const packages = path.join(dir, 'packages');
    const outDir = path.join(packages, '1.1.2');
    // Another release's hidden folder isn't this one's to clean up.
    const other = path.join(packages, '.1.1.2.incomplete-other');
    fs.mkdirSync(other, { recursive: true });
    let appeared;
    const source = files['slowed-reverb-firefox-source.zip'].from;
    files['slowed-reverb-firefox-source.zip'] = {
      get from() {
        fs.mkdirSync(outDir);
        appeared = fs.statSync(outDir);
        return source;
      }
    };

    assert.throws(() => writeReleaseFolder(outDir, files), /appeared while the checks ran/);
    assert.deepEqual(fs.readdirSync(packages).sort(), ['.1.1.2.incomplete-other', '1.1.2']);
    assert.deepEqual(fs.readdirSync(outDir), []);
    const now = fs.statSync(outDir);
    assert.deepEqual([now.dev, now.ino], [appeared.dev, appeared.ino]);
  });

  test('leaves no partial folder when a file cannot be written, and the logs stay in scratch', (t) => {
    const dir = temporary(t);
    const { logs, files } = scratch(dir);
    fs.rmSync(files['slowed-reverb-firefox-source.zip'].from);
    const packages = path.join(dir, 'packages');
    const outDir = path.join(packages, '1.1.2');

    assert.throws(() => writeReleaseFolder(outDir, files), { code: 'ENOENT' });
    assert.deepEqual(fs.readdirSync(packages), []);
    assert.deepEqual(fs.readdirSync(logs).sort(), ['check.log', 'web-ext-lint.json']);
  });
});

describe('Node test results', () => {
  // Without NODE_TEST_CONTEXT, a node --test run inside one reports to its parent.
  const plainEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));

  // Writes throwaway test files (by name, or one sample.test.js), and runs
  // node --test on them with the release's reporters.
  const runTests = (t, files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-release-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    if (typeof files === 'string') files = { 'sample.test.js': files };
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), `const { before, describe, test } = require('node:test');\n${body}`);
    }
    const results = path.join(dir, 'results.json');
    const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...resultsReporter(results)], {
      cwd: dir,
      encoding: 'utf8',
      env: plainEnv()
    });
    return { dir, results, status: run.status, log: run.stdout + run.stderr, ...nodeTestResults(results) };
  };

  // The printed report is interrupted by output without a newline before a
  // required suite's result, which hid it from the summary's readers.
  const interrupted = (suite) => [
    "process.stdout.write('Loading required fixture... ');",
    `${suite}('required regression suite', () => {`,
    "  require('./missing-fixture.json');",
    "  test('required regression', () => {});",
    '});',
    "test('unrelated pass', () => {});"
  ].join('\n');

  test('accepts a run in which every test passed, whatever the tests print', (t) => {
    const run = runTests(t, {
      'a.test.js': [
        "process.stdout.write('partial stdout ');",
        "process.stderr.write('partial stderr ');",
        "describe('outer # TODO', () => { test('a (1ms) # TODO', () => { process.stdout.write('\\u2139 todo 0\\n# skipped 0'); }); });",
        "test('\\u26A0 b (1ms) # TODO', () => {});",
        "test('\\uFE63 c # SKIP', () => { console.log('not ok 1 - c # TODO'); });"
      ].join('\n'),
      'b.test.js': "test('d', async (t) => { await t.test('e', () => {}); });"
    });
    assert.equal(run.status, 0, run.log);
    assert.deepEqual(run.problems, []);
    assert.equal(run.counts.tests, 5);
    assert.equal(run.counts.passed, 5);
  });

  test('rejects to-do and skipped suites after output without a newline', (t) => {
    const todo = runTests(t, interrupted('describe.todo'));
    // node --test itself passes this run, and its summary counts one test.
    assert.equal(todo.status, 0, todo.log);
    assert.match(todo.log, /^ℹ todo 0$/m);
    assert.deepEqual(todo.problems, [
      '1 failed (suite "required regression suite")',
      '1 to-do (suite "required regression suite")'
    ]);

    const skip = runTests(t, interrupted('describe.skip'));
    assert.equal(skip.status, 0, skip.log);
    assert.deepEqual(skip.problems, ['1 skipped (suite "required regression suite")']);
  });

  test('rejects to-do suites, with or without a reason, nested or empty', (t) => {
    const run = runTests(t, [
      "describe('later', { todo: 'reason' }, () => { throw new Error('no'); });",
      "describe('outer', () => { describe.todo('inner', () => { throw new Error('no'); }); test('b', () => {}); });",
      "describe.todo('empty', () => {});",
      "describe.todo('passing', () => { test('c', () => {}); });",
      "test('d', () => {});"
    ].join('\n'));
    assert.deepEqual(run.problems, [
      '2 failed (suite "later" and suite "inner")',
      '5 to-do (suite "later", suite "inner", suite "empty" and 2 more)'
    ]);
  });

  test('rejects skipped suites, with or without a reason, and nested', (t) => {
    const run = runTests(t, [
      "describe.skip('required', () => { test('a', () => {}); });",
      "describe('outer', () => { describe('later', { skip: 'reason' }, () => { test('b', () => {}); }); test('c', () => {}); });",
      "test('d', () => {});"
    ].join('\n'));
    assert.equal(run.status, 0, run.log);
    assert.deepEqual(run.problems, ['2 skipped (suite "required" and suite "later")']);
  });

  test('rejects skipped and to-do tests', (t) => {
    const run = runTests(t, "test('a', () => {});\ntest('b', { skip: true }, () => {});\ntest('c', { todo: 'reason' }, () => {});\n");
    assert.deepEqual(run.problems, ['1 skipped (test "b")', '1 to-do (test "c")']);
    assert.deepEqual([run.counts.tests, run.counts.passed, run.counts.skipped, run.counts.todo], [3, 1, 1, 1]);
  });

  test('rejects failed and cancelled tests and suites', (t) => {
    // A test that times out is cancelled, and so are a suite's tests when its
    // hook fails.
    const run = runTests(t, [
      "test('a', () => { throw new Error('no'); });",
      "test('b', { timeout: 50 }, () => new Promise(() => {}));",
      "describe('broken', () => { before(() => { throw new Error('no'); }); test('c', () => {}); });",
      "test('d', () => {});"
    ].join('\n'));
    assert.notEqual(run.status, 0);
    assert.deepEqual(run.problems, [
      '2 failed (test "a" and suite "broken")',
      '2 cancelled (test "b" and test "c")',
      'a summary that says the run failed'
    ]);
  });

  test('counts a failed to-do test once, though the printed report repeats it', (t) => {
    const run = runTests(t, "test('a', { todo: true }, () => { throw new Error('no'); });\ntest('b', () => {});\n");
    assert.equal(run.log.match(/⚠ a \(/g)?.length, 2, run.log);
    assert.deepEqual(run.problems, ['1 failed (test "a")', '1 to-do (test "a")']);
  });

  test('rejects a test file that exits before its summary', (t) => {
    const run = runTests(t, {
      'early.test.js': "test('a', () => {});\ntest('b', () => new Promise((resolve) => setTimeout(resolve, 50)));\nsetTimeout(() => process.exit(0), 1);",
      'later.test.js': "test('c', () => {});"
    });
    assert.equal(run.status, 0, run.log);
    assert.deepEqual(run.problems, ['1 file without a summary (early.test.js)']);
    assert.equal(run.counts.tests, 2);
  });

  // The release's own tests run node --test inside a test, as this does.
  test("ignores a node --test run inside a test, and its printed report", (t) => {
    const run = runTests(t, [
      "const { spawnSync } = require('child_process');",
      "require('fs').writeFileSync('inner.js', \"require('node:test').test('inner', () => { throw new Error('no'); });\\n\");",
      "test('runs a failing inner run', () => {",
      "  const env = { ...process.env };",
      '  delete env.NODE_TEST_CONTEXT;',
      "  const inner = spawnSync(process.execPath, ['--test', 'inner.js'], { env, stdio: ['ignore', 'inherit', 'inherit'] });",
      "  if (inner.status !== 1) throw new Error('the inner run should fail');",
      "  process.stdout.write('\\u2139 tests 9');",
      '});'
    ].join('\n'));
    assert.match(run.log, /^ℹ fail 1$/m);
    assert.deepEqual(run.problems, []);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(run.results, 'utf8')).results.map((result) => result.name),
      ['runs a failing inner run']
    );
  });

  test('rejects a missing, partial or foreign results file', (t) => {
    const { results } = runTests(t, "test('a', () => {});\n");
    const text = fs.readFileSync(results, 'utf8');
    const report = JSON.parse(text);
    assert.deepEqual(nodeTestResults(results).problems, []);

    const check = (contents) => {
      fs.writeFileSync(results, typeof contents === 'string' ? contents : JSON.stringify(contents));
      return nodeTestResults(results).problems;
    };
    assert.deepEqual(check(''), ['no complete results file']);
    assert.deepEqual(check(text.slice(0, -20)), ['no complete results file']);
    assert.deepEqual(check({ ...report, format: 'another' }), ['no complete results file']);
    assert.deepEqual(check({ ...report, summaries: report.summaries.filter((summary) => summary.file) }), ['0 run summaries']);
    const runSummary = report.summaries.find((summary) => summary.file === null);
    assert.deepEqual(check({ ...report, summaries: [...report.summaries, runSummary] }), ['2 run summaries']);
    assert.deepEqual(check({ ...report, results: [] }), ['no tests passed', "a summary that doesn't match the results"]);
    fs.rmSync(results);
    assert.deepEqual(nodeTestResults(results).problems, ['no complete results file']);
  });

  test(
    'rejects an interrupted to-do or skipped suite through npm test, as the release runs it',
    { skip: process.platform === 'win32' && 'process groups are POSIX-only' },
    async (t) => {
      // Run as from a plain shell, as the release is, not as a test file.
      const context = process.env.NODE_TEST_CONTEXT;
      delete process.env.NODE_TEST_CONTEXT;
      t.after(() => {
        if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
      });
      const expected = {
        'describe.todo': ['1 failed (suite "required regression suite")', '1 to-do (suite "required regression suite")'],
        'describe.skip': ['1 skipped (suite "required regression suite")'],
        // With its fixture there, the same suite passes.
        describe: []
      };
      for (const [suite, problems] of Object.entries(expected)) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-release-test-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const scripts = { test: TEST_SCRIPTS.test };
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', private: true, scripts }));
        if (suite === 'describe') fs.writeFileSync(path.join(dir, 'missing-fixture.json'), '{}');
        fs.writeFileSync(path.join(dir, 'sample.test.js'), `const { describe, test } = require('node:test');\n${interrupted(suite)}`);
        const results = path.join(dir, 'results.json');
        const log = path.join(dir, 'check.log');

        await run('npm', ['test', '--', ...resultsReporter(results)], { cwd: dir, log });
        assert.match(fs.readFileSync(log, 'utf8'), /^Loading required fixture\.\.\. \S/m, suite);
        assert.deepEqual(nodeTestResults(results).problems, problems, suite);
      }
    }
  );

  test("runs the package's test scripts as the release does", () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const [name, script] of Object.entries(TEST_SCRIPTS)) assert.equal(scripts[name], script, name);
  });
});

describe('Release steps', () => {
  test(
    'a step finishes only once what it started has stopped',
    { skip: process.platform === 'win32' && 'process groups are POSIX-only' },
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-release-test-'));
      const ready = path.join(dir, 'ready');
      let leftover = null;
      t.after(() => {
        if (leftover) {
          try {
            process.kill(leftover, 'SIGKILL');
          } catch {
            // Already gone, as it should be.
          }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      });

      // The step starts a process that ignores SIGTERM and exits as soon as
      // that process is ready, leaving it behind in the step's process group.
      // Stopping the tests doesn't reach that group, so both end on their own
      // once this test process is gone, or after 30 seconds.
      const selfEnding = `
        const tester = Number(process.argv[2]);
        setInterval(() => {
          try {
            process.kill(tester, 0);
          } catch {
            process.exit(0);
          }
        }, 100);
        setTimeout(() => process.exit(0), 30000);`;
      const leftoverScript = `${selfEnding}
        process.on('SIGTERM', () => {});
        require('fs').writeFileSync(process.argv[1], String(process.pid));`;
      const stepScript = `${selfEnding}
        const fs = require('fs');
        const ready = process.argv[1];
        require('child_process')
          .spawn(process.execPath, ['-e', ${JSON.stringify(leftoverScript)}, ready, String(tester)], { stdio: 'ignore' })
          .unref();
        setInterval(() => {
          if (fs.existsSync(ready) && fs.readFileSync(ready, 'utf8')) process.exit(0);
        }, 20);`;

      await run(process.execPath, ['-e', stepScript, ready, String(process.pid)], {
        cwd: dir,
        log: path.join(dir, 'step.log'),
        graceMs: 300
      });

      leftover = Number(fs.readFileSync(ready, 'utf8'));
      assert.equal(stillRunning(leftover), false);
    }
  );

  test(
    'a process that has ended but not been reaped is not running',
    { skip: process.platform === 'win32' && 'zombies are POSIX-only' },
    async (t) => {
      // sleep never reaps its child, so the child stays a zombie, as orphans
      // do in Linux containers whose init doesn't reap them.
      const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
      t.after(() => parent.kill('SIGKILL'));
      const [line] = await new Promise((resolve) => parent.stdout.once('data', (data) => resolve(String(data).split('\n'))));
      const zombie = Number(line);
      const deadline = Date.now() + 3000;
      while (stillRunning(zombie) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

      assert.doesNotThrow(() => process.kill(zombie, 0), 'the zombie still has its process entry');
      assert.equal(stillRunning(zombie), false);
      assert.equal(stillRunning(parent.pid), true);
    }
  );
});
