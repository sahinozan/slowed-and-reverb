'use strict';

// The audio capture trial in the installed Firefox, through puppeteer-core
// and WebDriver BiDi (README.md in this folder). Run it with npm run
// test:audio-trial:firefox; it isn't part of npm test or npm run
// test:firefox. Set FIREFOX_BIN to use a Firefox other than the usual install.
//
// Firefox runs with puppeteer's own preferences only: no autoplay or audio
// preferences are set, so the player starts from the Start click alone.

const { firefoxBrowser } = require('./browsers');
const { defineTrial } = require('./harness');

defineTrial(firefoxBrowser());
