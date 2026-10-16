'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { describe, test } = require('node:test');
const {
  describeEntries,
  firefoxPrivacyText,
  lineChanges,
  previousVersion,
  pullRequests,
  releaseRecord,
  run,
  stillRunning,
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
    assert.match(flat, /Upload the files in this folder\. Do not rebuild them without repeating verification and replacing this record\. $/);
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

  test('writes the files into a new folder', (t) => {
    const dir = temporary(t);
    const zip = path.join(dir, 'built.zip');
    fs.writeFileSync(zip, 'zip');
    const outDir = path.join(dir, 'packages', '1.1.2');

    writeReleaseFolder(outDir, { 'slowed-reverb-chromium.zip': { from: zip }, 'RELEASE-1.1.2.txt': { text: 'record' } });

    assert.deepEqual(fs.readdirSync(outDir).sort(), ['RELEASE-1.1.2.txt', 'slowed-reverb-chromium.zip']);
    assert.equal(fs.readFileSync(path.join(outDir, 'slowed-reverb-chromium.zip'), 'utf8'), 'zip');
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
