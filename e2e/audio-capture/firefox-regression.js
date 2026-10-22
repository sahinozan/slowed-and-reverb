'use strict';

// The audio regression suite in the installed Firefox, through
// puppeteer-core and WebDriver BiDi (README.md in this folder). Run it with
// npm run test:audio:firefox; it isn't part of npm test, npm run check or
// npm run test:firefox. Set FIREFOX_BIN to use a Firefox other than the
// usual install.

const { firefoxBrowser } = require('./browsers');
const { defineRegression } = require('./regression');

defineRegression(firefoxBrowser({ addonManager: true }));
