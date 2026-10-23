'use strict';

// Deadlines for what the audio regression suite (regression.js) asks of a
// page, so a player that never starts, an event that never comes or a page
// that stops answering ends the check as a measurement failure instead of
// hanging it. tests/audio-continuity.test.js checks them without a browser.

// How long a page may take over one of the suite's own steps (playing,
// changing the song...), and how much longer the Node side waits for the
// page to answer at all, as for the extension's requests (harness.js).
const PAGE_STEP_MS = 10_000;
const PAGE_BACKSTOP_MS = 2_000;
// How long any action of a check may take, the browser's own (turning the
// extension off, updating it...) included. Each took under 5 s on the Mac.
const ACTION_LIMIT_MS = 30_000;

// `promise`, or a rejection once `ms` have passed. The error's `code` is
// 'timeout'. The timer is cleared either way.
function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${message} (not done within ${ms} ms)`);
      error.code = 'timeout';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// A step of the page's own, run in the page: the browser driver serializes
// it, so it has to stay self-contained. It gives up after `timeoutMs`,
// removing the listeners and timers it added either way.
//   play: plays the player.
//   nextSong: plays `src` on the same player, then asks for normal speed
//     once it is playing, as Spotify does.
//   putBack: takes the player out of the page for `waitMs`, then puts it
//     back at speed `rate` and plays it, as YouTube does.
function pageStep({ step, timeoutMs, src, rate, waitMs }) {
  const player = document.getElementById('player');
  const cleanups = [];
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the page's step "${step}" wasn't done within ${timeoutMs} ms`)), timeoutMs);
  });
  const event = (type) =>
    new Promise((resolve) => {
      player.addEventListener(type, resolve, { once: true });
      cleanups.push(() => player.removeEventListener(type, resolve));
    });
  const wait = (ms) =>
    new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      cleanups.push(() => clearTimeout(id));
    });
  const steps = {
    async play() {
      await player.play();
      return 'playing';
    },
    async nextSong() {
      const playing = event('playing');
      player.src = src;
      await player.play();
      await playing;
      player.playbackRate = 1;
      return 'playing';
    },
    async putBack() {
      const parent = player.parentNode;
      player.remove();
      await wait(waitMs);
      player.playbackRate = rate;
      parent.append(player);
      await player.play();
      return 'playing';
    }
  };
  const run = steps[step];
  if (!run) return Promise.reject(new Error(`no page step "${step}"`));
  return Promise.race([run(), deadline]).finally(() => {
    clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
  });
}

// Runs a pageStep in `page`, with the Node side's own deadline in case the
// page stops answering.
function runPageStep(page, step, args = {}, { timeoutMs = PAGE_STEP_MS, backstopMs = PAGE_BACKSTOP_MS } = {}) {
  return withDeadline(
    page.evaluate(pageStep, { step, timeoutMs, ...args }),
    timeoutMs + backstopMs,
    `the page didn't answer its step "${step}"`
  );
}

module.exports = { ACTION_LIMIT_MS, PAGE_BACKSTOP_MS, PAGE_STEP_MS, pageStep, runPageStep, withDeadline };
