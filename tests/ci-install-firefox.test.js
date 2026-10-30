'use strict';

// Runs scripts/ci-install-firefox.sh against stand-ins for the network and
// GnuPG: curl copies fixture files, gpg writes the status lines a case
// gives, uname says Linux and sha512sum checks with Node. The archive is a
// real .tar.xz holding a fake firefox/application.ini. Each case that should
// be refused must stop before anything is unpacked or FIREFOX_BIN is set.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { root } = require('./helpers/load-script');

const SCRIPT = path.join(root, 'scripts', 'ci-install-firefox.sh');
const PRIMARY = '14F26682D0916CDD81E37B6D61B7B526D98F0353';
const SUBKEY = '827E658608679618CD349F93678E455D76767AA3';
const VALID = `[GNUPG:] VALIDSIG ${SUBKEY} 2026-10-22 1792698588 0 4 0 1 10 00 ${PRIMARY}`;
const GOOD = '[GNUPG:] GOODSIG 678E455D76767AA3 Mozilla Software Releases <release@mozilla.com>';
// What GnuPG wrote for 159.0's SHA512SUMS on the hosted runner (run
// 41080343461): KEYEXPIRED for each of the KEY's five expired subkeys,
// twice, around the good signature.
const EXPIRED_SUBKEYS = ['1684354261', '1500227572', '1561215157', '1622319338', '1746380659']
  .map((when) => `[GNUPG:] KEYEXPIRED ${when}`);
const CONSIDERED = `[GNUPG:] KEY_CONSIDERED ${PRIMARY} 0`;
const SIGNED = [
  '[GNUPG:] NEWSIG', ...EXPIRED_SUBKEYS, CONSIDERED, '[GNUPG:] SIG_ID km67fAlYO/crIJu9etrxL5mDV9w 2026-10-22 1792698588',
  GOOD, VALID, ...EXPIRED_SUBKEYS, CONSIDERED, '[GNUPG:] TRUST_UNDEFINED 0 pgp'
];
const NOT_SIGNED = "isn't signed by Mozilla's release subkey";

function stub(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
}

// A fixture folder for `version`, with the archive holding `holds` as its
// Firefox version. `sums` makes the SHA512SUMS lines from the archive's hash.
function setUp({ version = '159.0', holds = version, sums = (hash, file) => [`${hash}  ${file}`] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-install-firefox-'));
  const fixtures = path.join(dir, 'fixtures');
  const stubs = path.join(dir, 'stubs');
  const temp = path.join(dir, 'runner-temp');
  for (const folder of [fixtures, stubs, temp, path.join(dir, 'tree', 'firefox')]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tree', 'firefox', 'application.ini'), `[App]\nVersion=${holds}\n`);
  fs.writeFileSync(path.join(dir, 'tree', 'firefox', 'firefox'), '#!/bin/sh\n', { mode: 0o755 });
  const tarball = path.join(fixtures, `firefox-${version}.tar.xz`);
  const packed = spawnSync('tar', ['-cJf', tarball, '-C', path.join(dir, 'tree'), 'firefox']);
  assert.equal(packed.status, 0, String(packed.stderr));
  const hash = crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('hex');
  const file = `linux-x86_64/en-US/firefox-${version}.tar.xz`;
  const other = `${'0'.repeat(128)}  linux-x86_64/de/firefox-${version}.tar.xz`;
  fs.writeFileSync(path.join(fixtures, 'SHA512SUMS'), [other, ...sums(hash, file)].join('\n') + '\n');
  fs.writeFileSync(path.join(fixtures, 'KEY'), 'key\n');
  fs.writeFileSync(path.join(fixtures, 'SHA512SUMS.asc'), 'signature\n');
  // curl: -o <file> ... <url>; copies the fixture named like the URL's end.
  stub(stubs, 'curl', `#!/bin/bash
out=""; url=""
while (( $# )); do case "$1" in -o) out=$2; shift 2 ;; -*) [[ $1 =~ ^--(retry|connect-timeout|max-time|proto)$ ]] && shift; shift ;; *) url=$1; shift ;; esac; done
echo "$url" >> "$CALLS"
[[ -n "\${FAIL_URL:-}" && "$url" == *"$FAIL_URL"* ]] && exit 22
cp "$FIXTURES/\${url##*/}" "$out"
`);
  // gpg: --import does nothing; --verify writes the case's status lines to
  // --status-file, or to the descriptor --status-fd names.
  stub(stubs, 'gpg', `#!/bin/bash
for arg; do [[ $arg == --import ]] && exit 0; done
status=/dev/null
while (( $# )); do
  case "$1" in --status-file) status=$2 ;; --status-fd) status=/dev/fd/$2 ;; esac
  shift
done
printf '%s\\n' "\${GPG_STATUS//|/$'\\n'}" > "$status"
exit "\${GPG_EXIT:-0}"
`);
  stub(stubs, 'uname', '#!/bin/sh\necho Linux\n');
  stub(stubs, 'sha512sum', `#!${process.execPath}
const crypto = require('crypto'), fs = require('fs');
const [hash, file] = fs.readFileSync(0, 'utf8').trim().split(/\\s+/);
process.exit(crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex') === hash ? 0 : 1);
`);
  return { dir, fixtures, stubs, temp, version, calls: path.join(dir, 'calls.txt'), env: path.join(dir, 'github-env') };
}

function install(setup, { status = SIGNED, gpgExit = 0, version = setup.version, actions = 'true', failUrl } = {}) {
  const env = {
    PATH: `${setup.stubs}:${process.env.PATH}`,
    HOME: setup.dir,
    RUNNER_TEMP: setup.temp,
    GITHUB_ENV: setup.env,
    FIXTURES: setup.fixtures,
    CALLS: setup.calls,
    FIREFOX_VERSION: version,
    GPG_STATUS: status.join('|'),
    GPG_EXIT: String(gpgExit),
    ...(actions ? { GITHUB_ACTIONS: actions } : {}),
    ...(failUrl ? { FAIL_URL: failUrl } : {})
  };
  const result = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
  const work = path.join(setup.temp, `firefox-${version}`);
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    unpacked: fs.existsSync(path.join(work, 'firefox')),
    githubEnv: fs.existsSync(setup.env) ? fs.readFileSync(setup.env, 'utf8') : '',
    calls: fs.existsSync(setup.calls) ? fs.readFileSync(setup.calls, 'utf8').trim().split('\n') : [],
    work
  };
}

// Refused for the reason expected (`because`, a part of the script's
// message), not some other error, with nothing unpacked or exported.
function refused(result, message, because) {
  assert.notEqual(result.status, 0, `${message}: it was installed\n${result.output}`);
  assert.ok(result.output.includes(because), `${message}: refused for another reason:\n${result.output}`);
  assert.equal(result.unpacked, false, `${message}: it was unpacked`);
  assert.equal(result.githubEnv, '', `${message}: FIREFOX_BIN was set`);
}

// A fresh fixture for each case, so no case runs into another's files.
function fresh(t, options) {
  const setup = setUp(options);
  t.after(() => fs.rmSync(setup.dir, { recursive: true, force: true }));
  return setup;
}

const skip = process.platform === 'win32' && 'the script is for a Linux runner and runs through bash';

describe('scripts/ci-install-firefox.sh', { skip }, () => {
  test('installs a release signed by the pinned subkey, matching its hash and version', (t) => {
    const setup = fresh(t);
    const result = install(setup);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.githubEnv, `FIREFOX_BIN=${result.work}/firefox/firefox\n`);
    assert.deepEqual(result.calls, ['KEY', 'SHA512SUMS', 'SHA512SUMS.asc', 'linux-x86_64/en-US/firefox-159.0.tar.xz']
      .map((file) => `https://archive.mozilla.org/pub/firefox/releases/159.0/${file}`));
  });

  test('refuses a signature GnuPG reports as revoked, expired, bad or unchecked, or by another key', (t) => {
    const cases = {
      'a revoked signing key, though GnuPG exits 0': [...SIGNED, '[GNUPG:] REVKEYSIG 678E455D76767AA3 Mozilla'],
      'a revoked signing key, as GnuPG reports it': ['[GNUPG:] REVKEYSIG 678E455D76767AA3 Mozilla', VALID],
      'a revoked key, with no arguments': [...SIGNED, '[GNUPG:] KEYREVOKED'],
      'an expired signing key': ['[GNUPG:] EXPKEYSIG 678E455D76767AA3 Mozilla', VALID],
      'an expired signature': ['[GNUPG:] EXPSIG 678E455D76767AA3 Mozilla', VALID],
      'a bad signature': ['[GNUPG:] BADSIG 678E455D76767AA3 Mozilla'],
      'a signature that could not be checked': ['[GNUPG:] ERRSIG 678E455D76767AA3 1 10 00 1761148800 9 -'],
      'a good signature and one that could not be checked': [...SIGNED, '[GNUPG:] ERRSIG 678E455D76767AA3 1 10 00 1761148800 9 -'],
      'no public key': ['[GNUPG:] NO_PUBKEY 678E455D76767AA3'],
      'another primary key': [GOOD, VALID.replace(PRIMARY, 'A'.repeat(40))],
      'the revoked previous subkey': [GOOD, VALID.replace(SUBKEY, '09BEED63F3462A2DFFAB3B875ECB6497C1A20256')],
      'two signatures': [...SIGNED, GOOD, VALID],
      'a second VALIDSIG by another key': [...SIGNED, VALID.replace(SUBKEY, 'B'.repeat(40))],
      'no signature at all': []
    };
    for (const [name, status] of Object.entries(cases)) refused(install(fresh(t), { status }), name, NOT_SIGNED);
    refused(install(fresh(t), { gpgExit: 1 }), 'good status lines, but GnuPG exited 1', NOT_SIGNED);
  });

  test('refuses a release number that is not one, before downloading anything', (t) => {
    for (const version of ['159.0; rm -rf /', '../158.0', '159', '159.0\n160.0', '159.0b2']) {
      const result = install(fresh(t), { version });
      refused(result, JSON.stringify(version), 'Not a Firefox release number');
      assert.deepEqual(result.calls, [], `${JSON.stringify(version)} downloaded something`);
    }
    const empty = install(fresh(t), { version: '' });
    refused(empty, 'no release', 'no Firefox release given');
    assert.deepEqual(empty.calls, []);
  });

  test('refuses a failed download, a missing or doubled hash, a changed archive and another version inside', (t) => {
    refused(install(fresh(t), { failUrl: 'firefox-159.0.tar.xz' }), 'a failed download', "Couldn't download https://archive.mozilla.org/pub/firefox/releases/159.0/linux-x86_64/en-US/firefox-159.0.tar.xz");
    refused(install(fresh(t), { failUrl: 'SHA512SUMS.asc' }), 'a missing signature', "Couldn't download https://archive.mozilla.org/pub/firefox/releases/159.0/SHA512SUMS.asc");
    refused(install(fresh(t, { sums: () => [] })), 'no hash for the file', 'no single hash');
    refused(install(fresh(t, { sums: (hash, file) => [`${hash}  ${file}`, `${hash}  ${file}`] })), 'the hash given twice', 'no single hash');
    refused(install(fresh(t, { sums: (hash, file) => [`${'a'.repeat(128)}  ${file}`] })), 'another hash', "doesn't match SHA512SUMS");
    refused(install(fresh(t, { holds: '158.0' })), 'another version in the archive', 'holds Firefox 158.0, not 159.0');
  });

  test('runs only on a GitHub Actions runner', (t) => {
    const result = install(fresh(t), { actions: null });
    refused(result, 'outside GitHub Actions', 'only for a disposable Linux runner');
    assert.deepEqual(result.calls, []);
  });
});
