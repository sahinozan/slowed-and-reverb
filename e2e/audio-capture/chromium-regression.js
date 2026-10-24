'use strict';

// The audio regression suite in Playwright's Chromium, without Playwright's
// default --mute-audio (README.md in this folder), or with it when
// AUDIO_REGRESSION_MUTE=1, for a machine someone is listening to. Run it
// with npm run test:audio:chromium; it isn't part of npm test, npm run
// check or npm run test:e2e.

const { chromiumBrowser } = require('./browsers');
const { defineRegression } = require('./regression');

defineRegression(chromiumBrowser({ muteAudio: process.env.AUDIO_REGRESSION_MUTE === '1' }));
