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
const { EXIT, summarize } = require('../scripts/dependency-audit');

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

function report(vulnerabilities) {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } }
  });
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
    assert.match(result.markdown, /SECURITY\.md/);
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
      'a count that disagrees': (v) => JSON.stringify({ auditReportVersion: 2, vulnerabilities: v, metadata: { vulnerabilities: { total: 1 } } }),
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

  test('puts npm\'s text into Markdown without its markup', () => {
    const hostile = 'x <img src=x onerror=alert(1)> [click](https://example.com) `code` *bold*\n### Not a heading\u2028## Nor this';
    const stdout = report({
      'left-pad': entry('left-pad', {
        via: [
          advisory({ title: hostile, range: '<1 [x](https://example.com)' }),
          advisory({ url: 'javascript:alert(1)', title: 'Not a GitHub advisory' })
        ],
        nodes: ['node_modules/left-pad</li><script>']
      })
    });
    const result = summarize({ stdout, exitCode: 1, lock: { packages: { 'node_modules/left-pad</li><script>': { version: '<b>1</b>' } } } });
    assert.equal(result.exitCode, EXIT.advisories);
    assert.doesNotMatch(result.markdown, /<img|<script|<\/li>|<b>/);
    assert.doesNotMatch(result.markdown, /(?<!\\)\]\((?:https:\/\/example\.com|javascript:)/);
    assert.doesNotMatch(result.markdown, /(?<!\\)`code/);
    assert.deepEqual(headings(result.markdown), [
      '## Dependency audit',
      '### [GHSA-2222-3333-4444](https://github.com/advisories/GHSA-2222-3333-4444) (low)',
      '### javascript:alert(1) (low)'
    ]);
    assert.match(result.markdown, /x &lt;img src=x onerror=alert\(1\)&gt; \\\[click\\\]\(https:\/\/example\.com\) \\`code\\` \\\*bold\\\* ### Not a heading ## Nor this/);
  });
});

describe('dependency audit command', () => {
  // Runs the script the way npm runs a package script, with a stand-in for
  // npm that records its arguments and prints the given output.
  function run(t, { stdout = '', stderr = '', status = 0, args = ['out'] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-audit-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'npm-output.json'), JSON.stringify({ stdout, stderr, status }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(LOCK_10_8));
    fs.writeFileSync(path.join(dir, 'step-summary.md'), 'Earlier step\n');
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
    return { ...result, dir, read, exists };
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
    assert.equal(result.stdout, result.read('out/summary.md'));
  });

  test('keeps the evidence and fails when npm returns no report', (t) => {
    const stdout = fixture('registry-unreachable.json');
    const stderr = 'npm error audit endpoint returned an error\n';
    const result = run(t, { stdout, stderr, status: 1 });
    assert.equal(result.status, EXIT.error);
    assert.equal(result.read('out/npm-audit.json'), stdout);
    assert.equal(result.read('out/npm-audit.stderr.txt'), stderr);
    assert.match(result.read('out/summary.md'), /The audit didn't finish/);
  });

  test('runs nothing it finds in npm\'s output', (t) => {
    const name = '$(touch ran-a-command); touch ran-a-command';
    const stdout = report({ [name]: entry(name, { via: [advisory({ title: '`touch ran-a-command`' })] }) });
    const result = run(t, { stdout, status: 1 });
    assert.equal(result.status, EXIT.advisories);
    assert.equal(result.exists('ran-a-command'), false);
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

  test('runs the audit weekly, by hand and for dependency changes, with read-only access', () => {
    assert.match(workflow, /^ {2}schedule:\n {4}- cron: '[^']+'$/m);
    assert.match(workflow, /^ {2}workflow_dispatch:$/m);
    for (const file of ['package.json', 'package-lock.json', '.npmrc', 'scripts/dependency-audit.js']) {
      assert.match(workflow, new RegExp(`^ {6}- '${file.replace(/\./g, '\\.')}'$`, 'm'), file);
    }
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
