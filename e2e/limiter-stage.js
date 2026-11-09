'use strict';

// The limiter stage, taken from the files that carry it: the block between
// the "Limiter stage" comments in both engines and the website's demo.
// tests/limiter-stage.test.js runs it with a stand-in for the browser, and
// e2e/ui/limiter.spec.js in Chromium and Firefox.

const LIMITER_STAGE_FILES = Object.freeze(['extension/youtube-main.js', 'extension/spotify-main.js', 'site/demo-audio.js']);

const START = '  // ---- Limiter stage ----\n';
const END = '  // ---- End of the limiter stage ----\n';
// What the stage defines for the code around it and for the tests.
const EXPORTS = 'return { LIMITER, connectLimiter, createLimiter, limiterFilter, limiterFilters };';

// The stage's text in a file's source, comments included.
function limiterStage(source, file) {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${file} has no limiter stage`);
  if (source.indexOf(START, start + 1) >= 0 || source.indexOf(END, end + 1) >= 0) {
    throw new Error(`${file} has more than one limiter stage`);
  }
  return source.slice(start, end + END.length);
}

// The stage as a function body that takes the page's `window` and returns
// what it defines. A browser test passes this to the page.
const limiterStageBody = (stage) => `${stage}\n${EXPORTS}`;

// Runs the stage outside a browser, with a stand-in for its window.
function loadLimiterStage(stage, { userAgent, OfflineAudioContext } = {}) {
  return new Function('window', limiterStageBody(stage))({ navigator: { userAgent }, OfflineAudioContext });
}

module.exports = { LIMITER_STAGE_FILES, limiterStage, limiterStageBody, loadLimiterStage };
