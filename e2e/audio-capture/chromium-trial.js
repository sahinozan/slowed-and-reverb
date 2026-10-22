'use strict';

// The audio capture trial in Playwright's Chromium (README.md in this
// folder). Run it with npm run test:audio-trial:chromium; it isn't part of
// npm test or npm run test:e2e.
//
// The full trial runs without Playwright's default --mute-audio. A second,
// shorter run keeps Playwright's defaults (which add --mute-audio to headless
// Chromium) and compares the recorded levels with the first.

const { chromiumBrowser } = require('./browsers');
const { defineTrial } = require('./harness');

const unmuted = defineTrial(chromiumBrowser({ muteAudio: false }));
defineTrial(chromiumBrowser({ muteAudio: true }), {
  full: false,
  compareWith: { label: 'chromium', results: unmuted }
});
