'use strict';

// Checks how scripts/firefox-release.js picks the Firefox release for the
// audio workflow's nightly runs from Mozilla's product-details, with the
// files as product-details gave them on November 7, 2026, trimmed.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { root } = require('./helpers/load-script');
const { pickRelease } = require('../scripts/firefox-release');

const SCRIPT = path.join(root, 'scripts', 'firefox-release.js');

// Runs the script as the workflow does, with fetch replaced (through
// --require) by one that answers from `replies`, a map of file name to
// [status, body], or fails for a file it doesn't list.
function runScript(t, request, replies = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefox-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, 'fetch-stub.js');
  fs.writeFileSync(stub, `const replies = ${JSON.stringify(replies)};
globalThis.fetch = async (url) => {
  const reply = replies[String(url).split('/').pop()];
  if (!reply) throw new Error('network down: ' + url);
  return { ok: reply[0] === 200, status: reply[0], json: async () => JSON.parse(reply[1]) };
};
`);
  const record = path.join(dir, 'out', 'firefox-release.json');
  const output = path.join(dir, 'github-output');
  const result = spawnSync(process.execPath, ['--require', stub, SCRIPT, request, record], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output }
  });
  return {
    status: result.status,
    stderr: result.stderr,
    record: fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null,
    output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : ''
  };
}

const DETAILS = {
  versions: { LATEST_FIREFOX_VERSION: '159.0.1', LATEST_FIREFOX_DEVEL_VERSION: '160.0b5', FIREFOX_ESR: '153.6.0esr' },
  majors: { '153.0': '2026-07-21', '157.0': '2026-09-29', '158.0': '2026-10-13', '159.0': '2026-10-27' },
  stability: {
    '153.0.1': '2026-07-28',
    '153.5.1': '2026-10-20',
    '153.6.0': '2026-10-27',
    '158.0.1': '2026-10-20',
    '159.0.1': '2026-11-03'
  }
};

describe('scripts/firefox-release.js', () => {
  test("picks Mozilla's latest release, and the latest of the major version before it", () => {
    assert.equal(pickRelease('current', DETAILS), '159.0.1');
    assert.equal(pickRelease('previous', DETAILS), '158.0.1');
  });

  test('takes a major release when the version before has no dot release', () => {
    const details = { ...DETAILS, versions: { LATEST_FIREFOX_VERSION: '158.0.1' } };
    assert.equal(pickRelease('previous', details), '157.0');
  });

  test('picks the highest dot release by number, not by text', () => {
    const details = { ...DETAILS, stability: { ...DETAILS.stability, '158.0.2': 'x', '158.0.10': 'y' } };
    assert.equal(pickRelease('previous', details), '158.0.10');
  });

  test("never picks an ESR's own release, whose files have another name", () => {
    // Once 154 is out, 153's latest on the release channel is 153.0.1, not
    // the ESR's 153.6.0.
    const details = { ...DETAILS, versions: { LATEST_FIREFOX_VERSION: '154.0' } };
    assert.equal(pickRelease('previous', details), '153.0.1');
  });

  test('passes a release given by hand through, and refuses anything else', () => {
    assert.equal(pickRelease('159.0', {}), '159.0');
    assert.equal(pickRelease('158.0.1', {}), '158.0.1');
    for (const request of ['latest', '159', '159.0b2', '159.0; rm -rf /', 'Current']) {
      assert.throws(() => pickRelease(request, DETAILS), /Not a Firefox release/, request);
    }
  });

  test("refuses product-details that give no current release, or none of the version before", () => {
    assert.throws(() => pickRelease('current', { ...DETAILS, versions: {} }), /no current release/);
    assert.throws(() => pickRelease('current', { ...DETAILS, versions: { LATEST_FIREFOX_VERSION: '160.0b5' } }), /no current release/);
    assert.throws(() => pickRelease('previous', { versions: { LATEST_FIREFOX_VERSION: '170.0' }, majors: DETAILS.majors, stability: DETAILS.stability }), /no release of Firefox 169/);
  });

  describe('as the workflow runs it', () => {
    const replies = {
      'firefox_versions.json': [200, JSON.stringify(DETAILS.versions)],
      'firefox_history_major_releases.json': [200, JSON.stringify(DETAILS.majors)],
      'firefox_history_stability_releases.json': [200, JSON.stringify(DETAILS.stability)]
    };

    test('records what it was asked and chose, and gives the version to the next steps', (t) => {
      const result = runScript(t, 'previous', replies);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output, 'version=158.0.1\n');
      assert.equal(result.record.asked, 'previous');
      assert.equal(result.record.version, '158.0.1');
      assert.equal(result.record.latest, '159.0.1');
      assert.equal(result.record.error, undefined);
      const runner = runScript(t, '');
      assert.equal(runner.status, 0, runner.stderr);
      assert.equal(runner.output, 'version=\n');
      assert.equal(runner.record.source, 'runner');
    });

    test('a failed choice fails the step, keeps a record of why, and gives no version', (t) => {
      const cases = {
        'the network down': [{}, /network down/],
        'an HTTP error': [{ ...replies, 'firefox_versions.json': [503, '""'] }, /HTTP 503/],
        'a reply that is not JSON': [{ ...replies, 'firefox_versions.json': [200, 'not json'] }, /JSON/],
        'no release of the version before': [{ ...replies, 'firefox_history_major_releases.json': [200, '{}'], 'firefox_history_stability_releases.json': [200, '{}'] }, /no release of Firefox 158/]
      };
      for (const [name, [given, error]] of Object.entries(cases)) {
        const result = runScript(t, 'previous', given);
        assert.notEqual(result.status, 0, `${name}: the step succeeded`);
        assert.equal(result.output, '', `${name}: a version was given`);
        assert.ok(result.record, `${name}: no record was kept`);
        assert.equal(result.record.asked, 'previous', name);
        assert.equal(result.record.version, null, name);
        assert.match(result.record.error, error, name);
      }
      const refused = runScript(t, 'latest');
      assert.notEqual(refused.status, 0);
      assert.equal(refused.output, '');
      assert.match(refused.record.error, /Not a Firefox release/);
    });
  });
});
