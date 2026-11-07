'use strict';

// Picks the Firefox release the audio workflow's Firefox job installs, for
// the suite's baseline (e2e/audio-capture/BASELINE.md), which needs runs on
// Firefox's current release and the one before.
//
//   node scripts/firefox-release.js <request> <record.json>
//
// The request is empty (the runner's own Firefox), a release such as 159.0,
// `current` (Mozilla's latest release) or `previous` (the latest release of
// the major version before it). `current` and `previous` are read from
// Mozilla's product-details. The script writes `version=<release>` (empty for
// the runner's) to $GITHUB_OUTPUT and what it was asked and chose to the
// record file, which the workflow keeps with the run's evidence. What it
// chooses is only a name: scripts/ci-install-firefox.sh checks the download
// against Mozilla's release key.

const fs = require('node:fs');
const path = require('node:path');

const PRODUCT_DETAILS = 'https://product-details.mozilla.org/1.0';
// A release on Firefox's release channel: 159.0 or 159.0.1. Not a beta, and
// not an ESR's own releases (153.6.0), whose files have another name.
const RELEASE = /^(\d{2,3})\.0(?:\.(\d+))?$/;
// What the workflow's input takes, checked the same way as the install
// script checks it.
const GIVEN = /^\d{2,3}\.\d+(\.\d+)?$/;

function releaseParts(version) {
  const match = RELEASE.exec(version);
  return match ? { major: Number(match[1]), patch: Number(match[2] ?? 0) } : null;
}

// The release a request names, from product-details' three files:
// firefox_versions.json, firefox_history_major_releases.json and
// firefox_history_stability_releases.json.
function pickRelease(request, { versions, majors, stability }) {
  if (GIVEN.test(request)) return request;
  if (request !== 'current' && request !== 'previous') throw new Error(`Not a Firefox release or current or previous: ${JSON.stringify(request)}`);
  const current = versions?.LATEST_FIREFOX_VERSION;
  const parts = typeof current === 'string' ? releaseParts(current) : null;
  if (!parts) throw new Error(`product-details gives no current release: ${JSON.stringify(current)}`);
  if (request === 'current') return current;
  const wanted = parts.major - 1;
  const candidates = [...Object.keys(majors ?? {}), ...Object.keys(stability ?? {})]
    .map((version) => ({ version, parts: releaseParts(version) }))
    .filter((entry) => entry.parts?.major === wanted)
    .sort((a, b) => a.parts.patch - b.parts.patch);
  if (!candidates.length) throw new Error(`product-details lists no release of Firefox ${wanted}`);
  return candidates.at(-1).version;
}

async function fetchJson(file) {
  const response = await fetch(`${PRODUCT_DETAILS}/${file}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Couldn't read ${PRODUCT_DETAILS}/${file}: HTTP ${response.status}`);
  return response.json();
}

async function main([request = '', recordFile]) {
  if (!recordFile) throw new Error('usage: node scripts/firefox-release.js <request> <record.json>');
  const record = { asked: request || null, version: null, source: null, at: new Date().toISOString() };
  if (request === 'current' || request === 'previous') {
    const [versions, majors, stability] = await Promise.all([
      fetchJson('firefox_versions.json'),
      fetchJson('firefox_history_major_releases.json'),
      fetchJson('firefox_history_stability_releases.json')
    ]);
    record.version = pickRelease(request, { versions, majors, stability });
    record.source = PRODUCT_DETAILS;
    record.latest = versions.LATEST_FIREFOX_VERSION;
  } else if (request) {
    record.version = pickRelease(request, {});
    record.source = 'input';
  } else {
    record.source = 'runner';
  }
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${record.version ?? ''}\n`);
  console.log(record.version ? `Firefox ${record.version} (asked: ${request}).` : "The runner's own Firefox.");
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { pickRelease };
