'use strict';

// Checks how scripts/firefox-release.js picks the Firefox release for the
// audio workflow's nightly runs from Mozilla's product-details, with the
// files as product-details gave them on November 7, 2026, trimmed.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { pickRelease } = require('../scripts/firefox-release');

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
});
