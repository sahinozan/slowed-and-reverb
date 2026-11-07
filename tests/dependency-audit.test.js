'use strict';

// scripts/dependency-audit.js against npm audit's real output, recorded in
// tests/fixtures/npm-audit/ (web-ext-10.7.0.json is this repository's lockfile
// before web-ext 10.8.0, web-ext-10.8.0.json after it; the error files come
// from a folder with no lockfile and a registry that refused the connection),
// and against reports made up to break it. Nothing here reaches the network:
// the command-line tests give the script a stand-in for npm.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { EXCEPTIONS_FILE, EXIT, MAX_REVIEW_DAYS, STATUS_LINES, summarize } = require('../scripts/dependency-audit');

const { root } = require('./helpers/load-script');

const fixtures = path.join(__dirname, 'fixtures', 'npm-audit');
const fixture = (name) => fs.readFileSync(path.join(fixtures, name), 'utf8');

// The installed versions the recorded reports refer to.
const LOCK_10_7 = {
  packages: {
    'node_modules/web-ext': { version: '10.7.0' },
    'node_modules/fx-runner': { version: '1.6.0' },
    'node_modules/shell-quote': { version: '1.10.0' },
    'node_modules/@devicefarmer/adbkit': { version: '3.3.9' },
    'node_modules/node-forge': { version: '1.4.0' }
  }
};
const LOCK_10_8 = {
  packages: {
    'node_modules/web-ext': { version: '10.8.0' },
    'node_modules/@devicefarmer/adbkit': { version: '3.3.9' },
    'node_modules/node-forge': { version: '1.4.0' }
  }
};

function advisory(overrides = {}) {
  return {
    source: 1,
    name: 'left-pad',
    dependency: 'left-pad',
    title: 'Example advisory',
    url: 'https://github.com/advisories/GHSA-2222-3333-4444',
    severity: 'low',
    range: '<1.0.1',
    ...overrides
  };
}

function entry(name, overrides = {}) {
  return {
    name,
    severity: 'low',
    isDirect: false,
    via: [],
    effects: [],
    range: '*',
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
    ...overrides
  };
}

// A report as npm writes it, counting each entry under its severity; counts
// replaces some of those numbers.
function report(vulnerabilities, counts = {}) {
  const counted = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const { severity } of Object.values(vulnerabilities)) {
    counted[severity] += 1;
    counted.total += 1;
  }
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { ...counted, ...counts },
      dependencies: { prod: 1, dev: 10, optional: 0, peer: 0, peerOptional: 0, total: 10 }
    }
  });
}

// A recorded report, changed by edit.
function changed(name, edit) {
  const parsed = JSON.parse(fixture(name));
  edit(parsed);
  return JSON.stringify(parsed);
}

function headings(markdown) {
  return markdown.split('\n').filter((line) => line.startsWith('#'));
}

describe('dependency audit summary', () => {
  test('passes a report with no advisories only when npm also exited with 0', () => {
    const clean = summarize({ stdout: fixture('clean.json'), exitCode: 0 });
    assert.equal(clean.status, 'clean');
    assert.equal(clean.exitCode, 0);
    assert.match(clean.markdown, /No known advisories/);

    const disagreeing = summarize({ stdout: fixture('clean.json'), exitCode: 1 });
    assert.equal(disagreeing.status, 'error');
    assert.equal(disagreeing.exitCode, EXIT.error);
    assert.doesNotMatch(disagreeing.markdown, /No known advisories/);
  });

  test('lists each advisory once, with its link, installed version and chain', () => {
    const result = summarize({ stdout: fixture('web-ext-10.7.0.json'), exitCode: 1, lock: LOCK_10_7 });
    assert.equal(result.status, 'advisories');
    assert.equal(result.exitCode, EXIT.advisories);
    assert.match(result.markdown, /\*\*2 known advisories\*\*/);
    assert.match(result.markdown, /npm counts 5 affected packages/);
    assert.deepEqual(headings(result.markdown), [
      '## Dependency audit',
      '## Needs attention',
      '### [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) (critical)',
      '### [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) (high)'
    ]);
    assert.match(result.markdown, /- shell-quote 1\.10\.0, affected: &gt;=1\.8\.4 &lt;1\.11\.0\./);
    assert.match(result.markdown, /Installed at node_modules\/shell-quote\n/);
    assert.match(result.markdown, /Brought in by web-ext 10\.7\.0 &gt; fx-runner 1\.6\.0 &gt; shell-quote 1\.10\.0\n/);
    assert.match(result.markdown, /- node-forge 1\.4\.0, affected: &lt;=1\.4\.0\./);
    assert.match(result.markdown, /Brought in by web-ext 10\.7\.0 &gt; @devicefarmer\/adbkit 3\.3\.9 &gt; node-forge 1\.4\.0\n/);
  });

  test('keeps failing for the node-forge advisory that has no fixed version', () => {
    const result = summarize({ stdout: fixture('web-ext-10.8.0.json'), exitCode: 1, lock: LOCK_10_8 });
    assert.equal(result.status, 'advisories');
    assert.equal(result.exitCode, EXIT.advisories);
    assert.match(result.markdown, /\*\*1 known advisory\*\*/);
    assert.match(result.markdown, /npm counts 3 affected packages/);
    assert.doesNotMatch(result.markdown, /GHSA-pqg4-j6r4-53mv|shell-quote/);
    assert.match(result.markdown, /Brought in by web-ext 10\.8\.0 &gt; @devicefarmer\/adbkit 3\.3\.9 &gt; node-forge 1\.4\.0\n/);
    assert.match(result.markdown, /- node-forge 1\.4\.0, .*\n {2}- \*\*Needs attention:\*\* Not in audit-exceptions\.json\.\n/);
  });

  test('fails when the report lists advisories even if npm exited with 0', () => {
    const result = summarize({ stdout: fixture('web-ext-10.8.0.json'), exitCode: 0, lock: LOCK_10_8 });
    assert.equal(result.exitCode, EXIT.advisories);
    assert.match(result.markdown, /npm exited with 0 although its report lists advisories/);
  });

  test('shows every installed copy, every chain and every severity', () => {
    const stdout = report({
      'left-pad': entry('left-pad', {
        severity: 'info',
        via: [advisory({ severity: 'info' })],
        effects: ['a', 'b'],
        nodes: ['node_modules/left-pad', 'node_modules/b/node_modules/left-pad']
      }),
      a: entry('a', { isDirect: true, via: ['left-pad'], effects: ['b'] }),
      b: entry('b', { isDirect: true, via: ['left-pad', 'a'] })
    });
    const lock = {
      packages: {
        'node_modules/left-pad': { version: '1.0.0' },
        'node_modules/b/node_modules/left-pad': { version: '0.9.0' },
        'node_modules/a': { version: '2.0.0' },
        'node_modules/b': { version: '3.0.0' }
      }
    };
    const result = summarize({ stdout, exitCode: 1, lock });
    assert.equal(result.exitCode, EXIT.advisories);
    assert.match(result.markdown, /\(info\)/);
    assert.match(result.markdown, /- left-pad 1\.0\.0, 0\.9\.0, affected/);
    assert.match(result.markdown, /Installed at node_modules\/left-pad\n/);
    assert.match(result.markdown, /Installed at node_modules\/b\/node_modules\/left-pad\n/);
    assert.match(result.markdown, /Brought in by a 2\.0\.0 &gt; left-pad 1\.0\.0, 0\.9\.0\n/);
    assert.match(result.markdown, /Brought in by b 3\.0\.0 &gt; a 2\.0\.0 &gt; left-pad 1\.0\.0, 0\.9\.0\n/);
    assert.match(result.markdown, /Brought in by b 3\.0\.0 &gt; left-pad 1\.0\.0, 0\.9\.0\n/);
  });

  test('says when there is no report, instead of passing or counting advisories', () => {
    const cases = {
      'no lockfile': { stdout: fixture('no-lockfile.json'), exitCode: 1, says: /ENOLOCK: This command requires an existing lockfile/ },
      'registry unreachable': { stdout: fixture('registry-unreachable.json'), exitCode: 1, says: /ECONNREFUSED/ },
      'no output': { stdout: '', exitCode: 1, says: /printed no report/ },
      'whitespace': { stdout: ' \n', exitCode: 0, says: /printed no report/ },
      'not JSON': { stdout: 'npm ERR! something', exitCode: 1, says: /isn't JSON/ },
      'cut short': { stdout: fixture('web-ext-10.8.0.json').slice(0, 400), exitCode: 1, says: /isn't JSON/ },
      'a list': { stdout: '[]', exitCode: 0, says: /isn't an object/ },
      'another format': { stdout: '{"auditReportVersion":1,"advisories":{}}', exitCode: 0, says: /format this doesn't recognize/ },
      'no count': { stdout: '{"auditReportVersion":2,"vulnerabilities":{}}', exitCode: 0, says: /no count/ },
      'stopped': { stdout: fixture('clean.json'), exitCode: null, signal: 'SIGTERM', says: /didn't run to the end/ },
      'not started': { stdout: '', exitCode: null, spawnError: 'spawn ENOENT', says: /couldn't be run: spawn ENOENT/ }
    };
    for (const [name, { says, ...run }] of Object.entries(cases)) {
      const result = summarize(run);
      assert.equal(result.status, 'error', name);
      assert.equal(result.exitCode, EXIT.error, name);
      assert.match(result.markdown, /The audit didn't finish/, name);
      assert.match(result.markdown, says, name);
      assert.doesNotMatch(result.markdown, /No known advisories|known advisor(?:y|ies)\*\*/, name);
    }
  });

  test('rejects reports whose entries disagree or are incomplete', () => {
    const good = () => ({
      'left-pad': entry('left-pad', { via: [advisory()], effects: ['a'] }),
      a: entry('a', { isDirect: true, via: ['left-pad'] })
    });
    const broken = {
      'a count that disagrees': (v) => report(v, { total: 1 }),
      'no installed copies': (v) => report({ ...v, a: { ...v.a, nodes: [] } }),
      'a cause it does not list': (v) => report({ ...v, a: { ...v.a, via: ['right-pad'] } }),
      'an effect it does not list': (v) => report({ ...v, a: { ...v.a, effects: ['right-pad'] } }),
      'an advisory without a link': (v) => report({ ...v, 'left-pad': { ...v['left-pad'], via: [advisory({ url: undefined })] } }),
      'an unknown severity': (v) => report({ ...v, 'left-pad': { ...v['left-pad'], via: [advisory({ severity: 'urgent' })] } }),
      'a mislabeled entry': (v) => report({ ...v, a: { ...v.a, name: 'b' } }),
      'no advisory behind the entries': (v) => report({ a: { ...v.a, via: ['a'] } })
    };
    assert.equal(summarize({ stdout: report(good()), exitCode: 1 }).exitCode, EXIT.advisories);
    for (const [name, make] of Object.entries(broken)) {
      const result = summarize({ stdout: make(good()), exitCode: 1 });
      assert.equal(result.exitCode, EXIT.error, name);
    }
  });

  test('passes or fails on the report\'s counts only when they agree with its entries', () => {
    const clean = {
      'a severity the entries lack': changed('clean.json', (r) => { r.metadata.vulnerabilities.high = 3; }),
      'counts that add up to the total but not the entries': changed('clean.json', (r) => {
        Object.assign(r.metadata.vulnerabilities, { high: 3, total: 3 });
      }),
      'an error next to the report': changed('clean.json', (r) => {
        r.error = { code: 'EAUDIT', summary: 'Audit endpoint failed' };
      }),
      'an empty error next to the report': changed('clean.json', (r) => { r.error = null; }),
      'only a total': '{"auditReportVersion":2,"vulnerabilities":{},"metadata":{"vulnerabilities":{"total":0}}}',
      'no severity counts': changed('clean.json', (r) => { delete r.metadata.vulnerabilities.low; }),
      'a count as text': changed('clean.json', (r) => { r.metadata.vulnerabilities.info = '0'; }),
      'a negative count': changed('clean.json', (r) => { Object.assign(r.metadata.vulnerabilities, { low: -1, info: 1 }); }),
      'a severity npm doesn\'t have': changed('clean.json', (r) => { r.metadata.vulnerabilities.urgent = 1; }),
      'a severity counted as nothing': changed('clean.json', (r) => { r.metadata.vulnerabilities.urgent = null; }),
      'no count of dependencies': changed('clean.json', (r) => { delete r.metadata.dependencies; })
    };
    const advisories = {
      'counts under the wrong severity': changed('web-ext-10.8.0.json', (r) => {
        Object.assign(r.metadata.vulnerabilities, { high: 2, moderate: 1 });
      }),
      'an error next to the advisories': changed('web-ext-10.8.0.json', (r) => {
        r.error = { code: 'EAUDIT', summary: 'Audit endpoint failed' };
      })
    };
    for (const [name, stdout] of Object.entries({ ...clean, ...advisories })) {
      for (const exitCode of [0, 1]) {
        const result = summarize({ stdout, exitCode, lock: LOCK_10_8 });
        assert.equal(result.status, 'error', `${name}, npm exited with ${exitCode}`);
        assert.equal(result.exitCode, EXIT.error, name);
        assert.match(result.markdown, /The audit didn't finish/, name);
        assert.doesNotMatch(result.markdown, /No known advisories|known advisor(?:y|ies)\*\*/, name);
      }
    }
    assert.match(summarize({ stdout: clean['an error next to the report'], exitCode: 0 }).markdown, /npm reported an error: EAUDIT: Audit endpoint failed/);
    assert.match(summarize({ stdout: advisories['counts under the wrong severity'], exitCode: 1 }).markdown, /counts 1 moderate vulnerable packages but lists 0/);

    // The reports npm really printed still pass or fail as before.
    assert.equal(summarize({ stdout: fixture('clean.json'), exitCode: 0 }).status, 'clean');
    assert.equal(summarize({ stdout: fixture('web-ext-10.8.0.json'), exitCode: 1, lock: LOCK_10_8 }).status, 'advisories');
    assert.equal(summarize({ stdout: fixture('web-ext-10.7.0.json'), exitCode: 1, lock: LOCK_10_7 }).status, 'advisories');
  });

  test('says the report couldn\'t be read instead of crashing', () => {
    const lock = {
      get packages() {
        throw new Error('::add-mask::GHSA-86w9-cpqp-85rv');
      }
    };
    const result = summarize({ stdout: fixture('web-ext-10.8.0.json'), exitCode: 1, lock });
    assert.equal(result.status, 'error');
    assert.equal(result.exitCode, EXIT.error);
    assert.match(result.markdown, /The report couldn't be summarized: ::add-mask::GHSA-86w9-cpqp-85rv/);
  });

  test('puts npm\'s text into Markdown without its markup', () => {
    const hostile = 'x <img src=x onerror=alert(1)> <SCRIPT>alert(2)</SCRIPT> <ImG SrC=x OnErRoR=alert(3)> [click](https://example.com) `code` *bold*\n### Not a heading\u2028## Nor this';
    const lower = 'node_modules/left-pad</li><script>';
    const upper = 'node_modules/b/node_modules/left-pad</LI><SCRIPT>';
    const stdout = report({
      'left-pad': entry('left-pad', {
        via: [
          advisory({ title: hostile, range: '<1 [x](https://example.com)' }),
          advisory({ url: 'javascript:alert(1)', title: 'Not a GitHub advisory' })
        ],
        nodes: [lower, upper]
      })
    });
    const lock = { packages: { [lower]: { version: '<b>1</b>' }, [upper]: { version: '<B>2</B>' } } };
    const result = summarize({ stdout, exitCode: 1, lock });
    assert.equal(result.exitCode, EXIT.advisories);
    // The summary's own text has no angle brackets, so any here are npm's.
    assert.doesNotMatch(result.markdown, /[<>]/);
    assert.doesNotMatch(result.markdown, /(?<!\\)\]\((?:https:\/\/example\.com|javascript:)/);
    assert.doesNotMatch(result.markdown, /(?<!\\)`code/);
    assert.deepEqual(headings(result.markdown), [
      '## Dependency audit',
      '## Needs attention',
      '### [GHSA-2222-3333-4444](https://github.com/advisories/GHSA-2222-3333-4444) (low)',
      '### javascript:alert(1) (low)'
    ]);
    assert.match(result.markdown, /x &lt;img src=x onerror=alert\(1\)&gt; &lt;SCRIPT&gt;alert\(2\)&lt;\/SCRIPT&gt; &lt;ImG SrC=x OnErRoR=alert\(3\)&gt; \\\[click\\\]\(https:\/\/example\.com\) \\`code\\` \\\*bold\\\* ### Not a heading ## Nor this/);
    assert.match(result.markdown, /- left-pad &lt;b&gt;1&lt;\/b&gt;, &lt;B&gt;2&lt;\/B&gt;, affected: &lt;1 \\\[x\\\]\(https:\/\/example\.com\)\./);
    assert.match(result.markdown, /Installed at node_modules\/left-pad&lt;\/li&gt;&lt;script&gt;\n/);
    assert.match(result.markdown, /Installed at node_modules\/b\/node_modules\/left-pad&lt;\/LI&gt;&lt;SCRIPT&gt;\n/);
  });
});

describe('dependency audit exceptions', () => {
  const TODAY = '2026-11-07';
  const FORGE = {
    advisory: 'GHSA-86w9-cpqp-85rv',
    package: 'node-forge',
    versions: ['1.4.0'],
    reason: 'Only the TCP-to-USB bridge checks these signatures, and nothing here starts it.',
    reviewBy: '2027-01-01'
  };
  const SHELL_QUOTE = {
    advisory: 'GHSA-pqg4-j6r4-53mv',
    package: 'shell-quote',
    versions: ['1.10.0'],
    reason: 'Only quotes arguments this repository writes.',
    reviewBy: '2027-01-01'
  };
  const audit = (exceptions, overrides = {}) =>
    summarize({ stdout: fixture('web-ext-10.8.0.json'), exitCode: 1, lock: LOCK_10_8, exceptions, today: TODAY, ...overrides });
  const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

  test('lets through an advisory reviewed in the exceptions, showing why and until when', () => {
    const result = audit([FORGE]);
    assert.equal(result.status, 'reviewed');
    assert.equal(result.exitCode, EXIT.clean);
    assert.match(result.markdown, /\*\*1 known advisory\*\* in package-lock\.json, 0 needing attention and 1 reviewed in audit-exceptions\.json\./);
    assert.deepEqual(headings(result.markdown), [
      '## Dependency audit',
      '## Reviewed in audit-exceptions.json',
      '### [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) (high)'
    ]);
    assert.match(result.markdown, /\*\*Reviewed:\*\* Only the TCP-to-USB bridge checks these signatures, and nothing here starts it\. Look again by 2027-01-01\./);
    assert.match(result.markdown, /Brought in by web-ext 10\.8\.0 &gt; @devicefarmer\/adbkit 3\.3\.9 &gt; node-forge 1\.4\.0\n/);
    // Still valid on its last day.
    assert.equal(audit([FORGE], { today: FORGE.reviewBy }).status, 'reviewed');
  });

  test('fails once the date to look again by has passed', () => {
    const result = audit([FORGE], { today: '2027-01-02' });
    assert.equal(result.status, 'advisories');
    assert.equal(result.exitCode, EXIT.advisories);
    assert.match(result.markdown, /\*\*Needs attention:\*\* The exception was to be looked at again by 2027-01-01\./);
    assert.ok(headings(result.markdown).includes('## Needs attention'));
    assert.ok(!headings(result.markdown).includes('## Reviewed in audit-exceptions.json'));
  });

  test('fails when the installed version isn\'t one that was reviewed, or isn\'t known', () => {
    const newer = audit([{ ...FORGE, versions: ['1.3.9'] }]);
    assert.equal(newer.status, 'advisories');
    assert.match(newer.markdown, /audit-exceptions\.json covers 1\.3\.9, not 1\.4\.0\. Look again before adding a version\./);

    const unknown = audit([FORGE], { lock: null });
    assert.equal(unknown.status, 'advisories');
    assert.match(unknown.markdown, /The lockfile doesn't give its installed version, so the exception can't be checked\./);
  });

  test('fails for any advisory, or any affected package, the exceptions don\'t cover', () => {
    const result = summarize({ stdout: fixture('web-ext-10.7.0.json'), exitCode: 1, lock: LOCK_10_7, exceptions: [FORGE], today: TODAY });
    assert.equal(result.status, 'advisories');
    assert.equal(result.exitCode, EXIT.advisories);
    assert.match(result.markdown, /2 known advisories\*\* in package-lock\.json, 1 needing attention and 1 reviewed/);
    assert.deepEqual(headings(result.markdown), [
      '## Dependency audit',
      '## Needs attention',
      '### [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) (critical)',
      '## Reviewed in audit-exceptions.json',
      '### [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) (high)'
    ]);
    assert.equal(
      summarize({ stdout: fixture('web-ext-10.7.0.json'), exitCode: 1, lock: LOCK_10_7, exceptions: [FORGE, SHELL_QUOTE], today: TODAY }).status,
      'reviewed'
    );

    // One advisory over two packages, with only one of them reviewed.
    const both = [advisory(), advisory({ name: 'right-pad', dependency: 'right-pad' })];
    const stdout = report({ 'left-pad': entry('left-pad', { via: [both[0]] }), 'right-pad': entry('right-pad', { via: [both[1]] }) });
    const lock = { packages: { 'node_modules/left-pad': { version: '1.0.0' }, 'node_modules/right-pad': { version: '1.0.0' } } };
    const partly = summarize({
      stdout,
      exitCode: 1,
      lock,
      today: TODAY,
      exceptions: [{ advisory: 'GHSA-2222-3333-4444', package: 'left-pad', versions: ['1.0.0'], reason: 'Not reached.', reviewBy: '2027-01-01' }]
    });
    assert.equal(partly.status, 'advisories');
    assert.match(partly.markdown, /- left-pad 1\.0\.0, .*\n {2}- \*\*Reviewed:\*\* Not reached\./);
    assert.match(partly.markdown, /- right-pad 1\.0\.0, .*\n {2}- \*\*Needs attention:\*\* Not in audit-exceptions\.json\./);

    // An advisory that isn't on GitHub can't be reviewed in the list.
    const elsewhere = report({ 'left-pad': entry('left-pad', { via: [advisory({ url: 'https://example.com/advisory' })] }) });
    assert.equal(summarize({ stdout: elsewhere, exitCode: 1, lock, today: TODAY, exceptions: [] }).status, 'advisories');
  });

  test('fails for exceptions that are no longer needed', () => {
    const fixed = summarize({ stdout: fixture('clean.json'), exitCode: 0, exceptions: [FORGE], today: TODAY });
    assert.equal(fixed.status, 'advisories');
    assert.equal(fixed.exitCode, EXIT.advisories);
    assert.match(fixed.markdown, /No known advisories/);
    assert.match(fixed.markdown, /## Exceptions no longer needed\n\nRemove these from audit-exceptions\.json:\n\n- GHSA-86w9-cpqp-85rv for node-forge: nothing installed is affected any more\./);

    const other = audit([FORGE, SHELL_QUOTE]);
    assert.equal(other.status, 'advisories');
    assert.match(other.markdown, /- GHSA-pqg4-j6r4-53mv for shell-quote: nothing installed is affected any more\./);

    const extra = audit([{ ...FORGE, versions: ['1.3.9', '1.4.0'] }]);
    assert.equal(extra.status, 'advisories');
    assert.match(extra.markdown, /- GHSA-86w9-cpqp-85rv for node-forge: 1\.3\.9 is no longer installed\./);
  });

  test('still fails when npm exited with 0 although its report lists reviewed advisories', () => {
    const result = audit([FORGE], { exitCode: 0 });
    assert.equal(result.status, 'advisories');
    assert.match(result.markdown, /npm exited with 0 although its report lists advisories; this still fails\./);
  });

  test('refuses an exceptions list that isn\'t in the expected format, instead of trusting it', () => {
    const cases = [
      [{ exceptions: {} }, /audit-exceptions\.json isn't a list\./],
      [{ exceptions: ['GHSA-86w9-cpqp-85rv'] }, /Entry 1 in audit-exceptions\.json isn't an object\./],
      [{ exceptions: [{ ...FORGE, note: 'x' }] }, /needs exactly these fields: advisory, package, versions, reason, reviewBy\./],
      [{ exceptions: [{ ...FORGE, reviewBy: undefined }] }, /needs exactly these fields|needs a reviewBy date/],
      [{ exceptions: [{ ...FORGE, advisory: 'CVE-2026-85393' }] }, /doesn't name a GitHub advisory/],
      [{ exceptions: [{ ...FORGE, package: ' ' }] }, /doesn't name a package\./],
      [{ exceptions: [{ ...FORGE, versions: [] }] }, /doesn't list the installed versions it covers\./],
      [{ exceptions: [{ ...FORGE, versions: '1.4.0' }] }, /doesn't list the installed versions it covers\./],
      [{ exceptions: [{ ...FORGE, versions: ['1.4.0', '1.4.0'] }] }, /lists a version twice\./],
      [{ exceptions: [{ ...FORGE, reason: '' }] }, /gives no reason\./],
      [{ exceptions: [{ ...FORGE, reason: 'x'.repeat(401) }] }, /has a reason longer than 400 characters/],
      [{ exceptions: [{ ...FORGE, reviewBy: '2027-02-30' }] }, /needs a reviewBy date written YYYY-MM-DD\./],
      [{ exceptions: [{ ...FORGE, reviewBy: 'soon' }] }, /needs a reviewBy date/],
      [{ exceptions: [{ ...FORGE, reviewBy: addDays(TODAY, MAX_REVIEW_DAYS + 1) }] }, /has a reviewBy date more than 90 days ahead\./],
      [{ exceptions: [SHELL_QUOTE, FORGE, { ...FORGE, reason: 'Again.' }] }, /Entry 3 in audit-exceptions\.json repeats GHSA-86w9-cpqp-85rv for node-forge\./],
      [{ exceptionsError: 'audit-exceptions.json isn\'t valid JSON.' }, /audit-exceptions\.json isn't valid JSON\./],
      [{ today: 'someday' }, /Today's date isn't known\./]
    ];
    for (const [overrides, message] of cases) {
      const result = audit([FORGE], overrides);
      assert.equal(result.status, 'error', message);
      assert.equal(result.exitCode, EXIT.error, message);
      assert.match(result.markdown, message);
      assert.doesNotMatch(result.markdown, /Reviewed:|Needs attention/);
    }
    assert.equal(audit([{ ...FORGE, reviewBy: addDays(TODAY, MAX_REVIEW_DAYS) }]).status, 'reviewed');
  });

  test('puts the reason into Markdown without markup of its own', () => {
    const reason = 'No __proto__ key <script>alert(1)</script> [x](https://example.com) `code` *bold*';
    const result = audit([{ ...FORGE, reason }]);
    assert.equal(result.status, 'reviewed');
    assert.match(result.markdown, /\*\*Reviewed:\*\* No \\_\\_proto\\_\\_ key &lt;script&gt;alert\(1\)&lt;\/script&gt; \\\[x\\\]\(https:\/\/example\.com\) \\`code\\` \\\*bold\\\* Look again/);
 
    // A backslash of its own can't undo the escaping that follows it.
    const slashed = audit([{ ...FORGE, reason: 'C:\\path_x \\*not bold*' }]);
    assert.match(slashed.markdown, /\*\*Reviewed:\*\* C:\\\\path\\_x \\\\\\\*not bold\\\* Look again/);
  });

  test('the repository\'s own list is in the expected format', () => {
    const exceptions = JSON.parse(fs.readFileSync(path.join(root, EXCEPTIONS_FILE), 'utf8'));
    // Today's date, since how far ahead a reviewBy date may be counts from it.
    const result = summarize({ stdout: fixture('clean.json'), exitCode: 0, exceptions });
    assert.notEqual(result.status, 'error', result.markdown);
  });
});

describe('dependency audit command', () => {
  // Runs the script the way npm runs a package script, with a stand-in for
  // npm that records its arguments and prints the given output. setup gets
  // the folder it runs in before it starts.
  function run(t, { stdout = '', stderr = '', status = 0, args = ['out'], lock = LOCK_10_8, setup } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-audit-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'npm-output.json'), JSON.stringify({ stdout, stderr, status }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
    fs.writeFileSync(path.join(dir, 'step-summary.md'), 'Earlier step\n');
    setup?.(dir);
    const fakeNpm = path.join(dir, 'fake-npm.js');
    fs.writeFileSync(
      fakeNpm,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync('npm-args.json', JSON.stringify(process.argv.slice(2)));",
        "const { stdout, stderr, status } = JSON.parse(fs.readFileSync('npm-output.json', 'utf8'));",
        'process.stdout.write(stdout);',
        'process.stderr.write(stderr);',
        'process.exitCode = status;'
      ].join('\n')
    );
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'dependency-audit.js'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        npm_execpath: fakeNpm,
        GITHUB_STEP_SUMMARY: path.join(dir, 'step-summary.md')
      }
    });
    const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
    const exists = (name) => fs.existsSync(path.join(dir, name));
    // All the script prints for a run that ended this way.
    const printed = (status) => `${STATUS_LINES[status]} The summary is in ${path.join(fs.realpathSync(dir), 'out', 'summary.md')}.\n`;
    return { ...result, dir, read, exists, printed };
  }

  test('audits the lockfile with development tools included, and changes nothing', (t) => {
    const result = run(t, { stdout: fixture('clean.json') });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(result.read('npm-args.json'));
    assert.equal(args[0], 'audit');
    for (const flag of ['--package-lock-only', '--include=dev', '--json']) assert.ok(args.includes(flag), flag);
    assert.ok(!args.some((arg) => /fix|omit|audit-level|production/.test(arg)), args.join(' '));
    assert.equal(result.read('out/npm-audit.json'), fixture('clean.json'));
    assert.equal(result.read('out/npm-audit-exit.txt'), 'npm exited with 0\n');
    assert.equal(result.read('step-summary.md'), `Earlier step\n${result.read('out/summary.md')}`);
    assert.match(result.read('out/summary.md'), /No known advisories/);
    assert.equal(result.stdout, result.printed('clean'));
  });

  test('keeps npm\'s output and fails when there are advisories', (t) => {
    const stdout = fixture('web-ext-10.8.0.json');
    const result = run(t, { stdout, stderr: 'npm warn something\n', status: 1 });
    assert.equal(result.status, EXIT.advisories);
    assert.equal(result.read('out/npm-audit.json'), stdout);
    assert.equal(result.read('out/npm-audit.stderr.txt'), 'npm warn something\n');
    assert.equal(result.read('out/npm-audit-exit.txt'), 'npm exited with 1\n');
    assert.match(result.read('out/summary.md'), /GHSA-86w9-cpqp-85rv/);
    assert.match(result.read('out/summary.md'), /web-ext 10\.8\.0 &gt; @devicefarmer\/adbkit 3\.3\.9 &gt; node-forge 1\.4\.0/);
    assert.equal(result.stdout, result.printed('advisories'));
    assert.equal(result.stderr, '');
  });

  test('reads the exceptions from audit-exceptions.json, and passes when they cover every advisory', (t) => {
    const exception = {
      advisory: 'GHSA-86w9-cpqp-85rv',
      package: 'node-forge',
      versions: ['1.4.0'],
      reason: 'Not reached.',
      reviewBy: new Date(Date.now() + 86400000).toISOString().slice(0, 10)
    };
    const setup = (dir) => fs.writeFileSync(path.join(dir, EXCEPTIONS_FILE), JSON.stringify([exception]));
    const result = run(t, { stdout: fixture('web-ext-10.8.0.json'), status: 1, setup });
    assert.equal(result.status, EXIT.clean, result.read('out/summary.md'));
    assert.match(result.read('out/summary.md'), /\*\*Reviewed:\*\* Not reached\./);
    assert.equal(result.stdout, result.printed('reviewed'));
  });

  test('fails as unfinished when audit-exceptions.json isn\'t valid JSON', (t) => {
    const setup = (dir) => fs.writeFileSync(path.join(dir, EXCEPTIONS_FILE), '[{');
    const result = run(t, { stdout: fixture('web-ext-10.8.0.json'), status: 1, setup });
    assert.equal(result.status, EXIT.error);
    assert.match(result.read('out/summary.md'), /audit-exceptions\.json isn't valid JSON\./);
    assert.equal(result.stdout, result.printed('error'));
  });

  test('keeps the evidence and fails when npm returns no report', (t) => {
    const stdout = fixture('registry-unreachable.json');
    const stderr = 'npm error audit endpoint returned an error\n';
    const result = run(t, { stdout, stderr, status: 1 });
    assert.equal(result.status, EXIT.error);
    assert.equal(result.read('out/npm-audit.json'), stdout);
    assert.equal(result.read('out/npm-audit.stderr.txt'), stderr);
    assert.match(result.read('out/summary.md'), /The audit didn't finish/);
    assert.equal(result.stdout, result.printed('error'));
  });

  test('prints nothing from npm\'s output, which GitHub Actions could read as commands', (t) => {
    // Lines a runner reads as commands, current and older forms.
    const forged = [
      '::add-mask::GHSA-86w9-cpqp-85rv',
      '::error::Forged annotation',
      '  ::warning title=x::Indented',
      '::stop-commands::token',
      '##[error]Older form',
      '##[add-mask]GHSA-86w9-cpqp-85rv'
    ].join('\n');
    const npmStderr = `${forged}\n`;
    const advisories = changed('web-ext-10.8.0.json', (r) => {
      const forge = r.vulnerabilities['node-forge'];
      forge.via[0].title = '::add-mask::GHSA-86w9-cpqp-85rv';
      forge.via[0].range = forged;
      forge.via.push({ ...forge.via[0], url: '::error::not a link', title: forged });
      forge.nodes.push('::notice::node_modules/a/node_modules/node-forge');
      forge.fixAvailable = { name: '::error::web-ext', version: '##[error]5.1.0', isSemVerMajor: true };
    });
    const lock = { packages: { ...LOCK_10_8.packages, 'node_modules/node-forge': { version: forged } } };
    const name = '::add-mask::left-pad';
    const runs = {
      advisories: {
        stdout: advisories,
        status: 1,
        lock,
        kept: [/^::add-mask::GHSA-86w9-cpqp-85rv$/m, /::error::Forged annotation/, /Installed at ::notice::node_modules/, /::error::web-ext/]
      },
      clean: { stdout: changed('clean.json', (r) => { r.metadata.dependencies.note = forged; }), status: 0, kept: [/No known advisories/] },
      error: {
        stdout: report({ [name]: entry(name, { name: forged, via: [advisory({ title: forged })] }) }),
        status: 1,
        kept: [/entry for ::add-mask::left-pad isn't/]
      },
      'npm error': {
        stdout: JSON.stringify({ error: { code: '::error::EAUDIT', summary: '::add-mask::GHSA-86w9-cpqp-85rv' } }),
        status: 1,
        kept: [/npm reported an error: ::error::EAUDIT: ::add-mask::GHSA-86w9-cpqp-85rv/]
      }
    };
    for (const [outcome, { stdout, status, lock: runLock, kept }] of Object.entries(runs)) {
      const ending = outcome === 'npm error' ? 'error' : outcome;
      const result = run(t, { stdout, stderr: npmStderr, status, lock: runLock });
      assert.equal(result.status, EXIT[ending], outcome);
      assert.equal(result.stdout, result.printed(ending), outcome);
      assert.equal(result.stderr, '', outcome);
      // npm's output is kept byte for byte, and the summary keeps its words.
      assert.equal(result.read('out/npm-audit.json'), stdout, outcome);
      assert.equal(result.read('out/npm-audit.stderr.txt'), npmStderr, outcome);
      const summary = result.read('out/summary.md');
      for (const pattern of kept) assert.match(summary, pattern, outcome);
      assert.equal(result.read('step-summary.md'), `Earlier step\n${summary}`, outcome);
    }
  });

  test('runs nothing it finds in npm\'s output', (t) => {
    const name = '$(touch ran-a-command); touch ran-a-command';
    const stdout = report({ [name]: entry(name, { via: [advisory({ title: '`touch ran-a-command`' })] }) });
    const result = run(t, { stdout, status: 1 });
    assert.equal(result.status, EXIT.advisories);
    assert.equal(result.exists('ran-a-command'), false);
  });

  test('fails as unfinished, keeping what it wrote, when it can\'t write its output', (t) => {
    const stdout = fixture('clean.json');
    const stderr = 'npm warn something\n';
    const raw = { 'npm-audit.json': stdout, 'npm-audit.stderr.txt': stderr, 'npm-audit-exit.txt': 'npm exited with 0\n' };
    // Where a file or folder is in the way, what the script then says it
    // couldn't do, and whether it had already run npm and written npm's
    // output and summary.md.
    const cases = {
      'the folder is a file': { block: 'out', file: true, says: (out) => `create ${out}`, ran: false },
      'npm-audit.json is a folder': { block: 'out/npm-audit.json', says: (out) => `write ${path.join(out, 'npm-audit.json')}` },
      'summary.md is a folder': { block: 'out/summary.md', says: (out) => `write ${path.join(out, 'summary.md')}`, output: true },
      'the job summary is a folder': {
        block: 'step-summary.md',
        says: (out, dir) => `add to ${path.join(dir, 'step-summary.md')}`,
        output: true,
        summary: true
      }
    };
    for (const [name, { block, file = false, says, ran = true, output = false, summary = false }] of Object.entries(cases)) {
      const result = run(t, {
        stdout,
        stderr,
        setup: (dir) => {
          fs.rmSync(path.join(dir, block), { force: true });
          if (file) fs.writeFileSync(path.join(dir, block), 'in the way\n');
          else fs.mkdirSync(path.join(dir, block), { recursive: true });
        }
      });
      const out = path.join(fs.realpathSync(result.dir), 'out');
      assert.equal(result.status, EXIT.error, name);
      assert.equal(result.stdout, '', name);
      // One fixed line naming the step and the error's code, nothing else.
      const code = / \(E[A-Z]+\),/;
      assert.match(result.stderr, code, name);
      assert.equal(
        result.stderr.replace(code, ','),
        `Dependency audit: couldn't ${says(out, result.dir)}, so this says nothing about advisories.\n`,
        name
      );
      assert.equal(result.exists('npm-args.json'), ran, name);
      if (output) for (const [kept, content] of Object.entries(raw)) assert.equal(result.read(`out/${kept}`), content, name);
      if (summary) assert.match(result.read('out/summary.md'), /No known advisories/, name);
      if (block !== 'step-summary.md') assert.equal(result.read('step-summary.md'), 'Earlier step\n', name);
    }
  });

  test('takes exactly one folder and needs npm to run it', (t) => {
    assert.equal(run(t, { args: [] }).status, EXIT.error);
    assert.equal(run(t, { args: ['out', 'more'] }).status, EXIT.error);
    const option = run(t, { args: ['--fix'] });
    assert.equal(option.status, EXIT.error);
    assert.equal(option.exists('npm-args.json'), false);

    const direct = spawnSync(process.execPath, [path.join(root, 'scripts', 'dependency-audit.js'), 'out'], {
      cwd: option.dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH }
    });
    assert.equal(direct.status, EXIT.error);
    assert.match(direct.stderr, /Run this through npm/);
  });
});

describe('dependency audit workflow', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'dependency-audit.yml'), 'utf8');
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  // The shell code of every run: step, single-line or block.
  function runScripts() {
    const lines = workflow.split('\n');
    const found = [];
    lines.forEach((line, index) => {
      const match = /^(\s*)(?:- )?run: (.*)$/.exec(line);
      if (!match) return;
      if (match[2] !== '|') return found.push(match[2]);
      const body = [];
      for (const next of lines.slice(index + 1)) {
        if (next.trim() && next.search(/\S/) <= match[1].length) break;
        body.push(next);
      }
      found.push(body.join('\n'));
    });
    return found;
  }

  // The files listed under an event's paths:, as written.
  function paths(trigger) {
    const lines = workflow.split('\n');
    const start = lines.indexOf(`  ${trigger}:`);
    assert.notEqual(start, -1, trigger);
    const found = [];
    let listing = false;
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith('    ')) break;
      if (line === '    paths:') listing = true;
      else if (listing && line.startsWith("      - '") && line.endsWith("'")) found.push(line.slice(9, -1));
      else listing = false;
    }
    return found;
  }

  test('runs the audit weekly, by hand and for dependency changes, with read-only access', () => {
    assert.match(workflow, /^ {2}schedule:\n {4}- cron: '[^']+'$/m);
    assert.match(workflow, /^ {2}workflow_dispatch:$/m);
    const files = [
      '.github/workflows/dependency-audit.yml',
      '.npmrc',
      'audit-exceptions.json',
      'package.json',
      'package-lock.json',
      'scripts/dependency-audit.js'
    ];
    for (const trigger of ['pull_request', 'push']) assert.deepEqual(paths(trigger), files, trigger);
    assert.match(workflow, /^permissions:\n {2}contents: read\n\n/m);
    assert.doesNotMatch(workflow, /: write\b/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /node-version: 24\.19\.0/);
    assert.match(workflow, /npm install --global npm@11\.19\.0/);
    assert.match(workflow, /timeout-minutes: \d+/);
    for (const [, action] of workflow.matchAll(/uses: (\S+)/g)) assert.match(action, /@[0-9a-f]{40}$/, action);
  });

  test('lets an advisory or a missing report fail the job, and keeps the evidence', () => {
    assert.equal(scripts['audit:dependencies'], 'node scripts/dependency-audit.js');
    const shell = runScripts();
    assert.ok(shell.includes('npm run audit:dependencies -- "$RUNNER_TEMP/dependency-audit"'), shell.join('\n---\n'));
    for (const code of shell) {
      assert.doesNotMatch(code, /\$\{\{/, code);
      assert.doesNotMatch(code, /\|\| *(?:true|:|exit 0)|; *true\b|set \+e/, code);
      assert.doesNotMatch(code, /audit fix|--omit|--audit-level|--production/, code);
    }
    assert.doesNotMatch(workflow, /continue-on-error/);
    assert.match(workflow, /if: \$\{\{ !cancelled\(\) \}\}\n\s+uses: actions\/upload-artifact@/);
    assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/dependency-audit\/\n\s+if-no-files-found: error/);
  });

  test('stays out of the required checks and the release', () => {
    assert.doesNotMatch(scripts.check, /audit/);
    assert.doesNotMatch(scripts.test, /audit/);
    const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.doesNotMatch(ci, /audit/);
  });
});
