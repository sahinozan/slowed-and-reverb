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

// How long the page waits for the engine to receive each request of a
// sweep before it sends no more.
const SWEEP_RECEIPT_MS = 1_000;

// Requests sent through the extension's test driver (harness.js) as a
// dragged slider sends them, each meant to reach the engine `stepMs` after
// the one before. Run in the page, as pageStep is.
//
// The pace is set by when requests reach the engine, not by a timetable: a
// request is sent only once the one before has reached the engine, and
// then `stepMs` after that arrival, less the time requests have usually
// taken to get there so far (the lower median, which one late arrival
// doesn't move once there are two). So a page, a Node side or a background script
// that runs late delays the requests after it instead of sending them
// together to catch up. A request has reached the engine when the page's
// own message to it (from content.js or spotify-bridge.js) is dispatched:
// the engine's listener was added first, so it has run by then. The
// driver's reply says only that the background script is done.
//
// If a request doesn't reach the engine within `receiptMs`, no more are
// sent. Then it waits up to `replyMs` after the last request for the
// driver's replies, and returns when each request was sent, reached the
// engine and was answered, and the answers. It removes its listener and
// timers either way.
//
// A page's timer can go off up to about a millisecond before its time by
// performance.now(): timers count whole milliseconds (in Chromium and in
// Node, which runs this in the unit tests), and Firefox's performance.now()
// does too. So after each timer it checks the time again and waits out
// what's left, at least a millisecond at a time. If the time still hasn't
// come after 5 timers, it sends no more.
function pageSweep({ channel, engineChannels, requests, stepMs, receiptMs, replyMs }) {
  const timers = new Set();
  const sent = [];
  let arrived = null;
  let replied = null;
  const timer = (ms) => {
    let id;
    const promise = new Promise((resolve) => {
      id = setTimeout(() => {
        timers.delete(id);
        resolve(false);
      }, ms);
      timers.add(id);
    });
    return { promise, cancel: () => (clearTimeout(id), timers.delete(id)) };
  };
  // `promise`, or false once `ms` have passed.
  const within = async (promise, ms) => {
    const deadline = timer(ms);
    const value = await Promise.race([promise, deadline.promise]);
    deadline.cancel();
    return value;
  };
  const allReplied = () => sent.every((request) => request.reply);
  function listener(event) {
    const data = event.data ?? {};
    if (data.channel === channel && data.type === 'RESULT') {
      const request = sent.find((candidate) => candidate.id === data.id);
      if (!request || request.reply) return;
      request.replyMs = performance.now();
      try {
        request.reply = JSON.parse(data.reply);
      } catch (error) {
        request.reply = { error: `the test driver's reply couldn't be read: ${error.message}` };
      }
      if (allReplied()) replied?.();
    } else if (event.source === window && engineChannels.includes(data.channel) && data.type === 'APPLY') {
      const request = sent[sent.length - 1];
      if (!request || request.receiptMs !== undefined) return;
      if (data.enabled !== request.enabled || data.settings?.pan !== request.settings.pan) return;
      request.receiptMs = performance.now();
      arrived?.();
    }
  }
  const lowerMedian = (values) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
  // True once performance.now() has reached `atMs`, false if 5 timers in a
  // row went off before it.
  const until = async (atMs) => {
    for (let tries = 0; tries < 5; tries++) {
      const left = atMs - performance.now();
      if (left <= 0) return true;
      await timer(tries === 0 ? left : Math.max(1, Math.ceil(left))).promise;
    }
    return performance.now() >= atMs;
  };

  window.addEventListener('message', listener);
  return (async () => {
    let stopped = null;
    for (const [index, { settings, enabled }] of requests.entries()) {
      const before = sent[index - 1];
      if (before) {
        const usual = lowerMedian(sent.map((request) => request.receiptMs - request.sentMs));
        if (!(await until(before.receiptMs + Math.max(0, stepMs - usual)))) {
          stopped = `the page's timers went off early 5 times in a row before request ${index + 1} of ${requests.length}, so no more were sent`;
          break;
        }
      }
      const request = { id: `${index}-${Math.random().toString(36).slice(2)}`, settings, enabled };
      const reached = new Promise((resolve) => {
        arrived = () => resolve(true);
      });
      sent.push(request);
      request.sentMs = performance.now();
      window.postMessage({ channel, type: 'APPLY', id: request.id, settings, enabled }, '*');
      const inTime = await within(reached, receiptMs);
      arrived = null;
      if (!inTime) {
        stopped = `request ${index + 1} of ${requests.length} didn't reach the engine within ${receiptMs} ms, so no more were sent`;
        break;
      }
    }
    if (!allReplied()) {
      const lastSent = sent[sent.length - 1].sentMs;
      await within(new Promise((resolve) => (replied = resolve)), Math.max(0, lastSent + replyMs - performance.now()));
    }
    const round = (value) => (value === undefined ? null : Math.round(value * 10) / 10);
    return {
      stopped,
      replyMs,
      requests: sent.map((request) => ({
        pan: request.settings.pan,
        enabled: request.enabled,
        sentMs: round(request.sentMs),
        receiptMs: round(request.receiptMs),
        replyMs: round(request.replyMs),
        reply: request.reply ?? null
      }))
    };
  })().finally(() => {
    window.removeEventListener('message', listener);
    for (const id of timers) clearTimeout(id);
    timers.clear();
  });
}

// The longest a sweep of `count` requests may take in the page.
function sweepLimitMs(count, { stepMs, receiptMs = SWEEP_RECEIPT_MS, replyMs = PAGE_STEP_MS }) {
  return count * (stepMs + receiptMs) + replyMs;
}

// Runs a pageSweep in `page`, with the Node side's own deadline in case the
// page stops answering. Fails, as a measurement failure, if the driver
// didn't answer a request that was sent or answered with an error, as
// applyThroughExtension (harness.js) does. A request that didn't reach the
// engine is left for the caller to report (`stopped`).
async function runSweep(
  page,
  { channel, engineChannels, requests, stepMs, receiptMs = SWEEP_RECEIPT_MS, replyMs = PAGE_STEP_MS, backstopMs = PAGE_BACKSTOP_MS }
) {
  const result = await withDeadline(
    page.evaluate(pageSweep, { channel, engineChannels, requests, stepMs, receiptMs, replyMs }),
    sweepLimitMs(requests.length, { stepMs, receiptMs, replyMs }) + backstopMs,
    "the page didn't finish the sweep"
  );
  for (const [index, request] of result.requests.entries()) {
    if (!request.reply) throw new Error(`applying settings failed: no reply from the extension's test driver within ${replyMs} ms of the sweep's last request (request ${index + 1})`);
    if (request.reply.error !== undefined) throw new Error(`applying settings failed: ${request.reply.error} (request ${index + 1} of the sweep)`);
  }
  return result;
}

module.exports = {
  ACTION_LIMIT_MS,
  PAGE_BACKSTOP_MS,
  PAGE_STEP_MS,
  SWEEP_RECEIPT_MS,
  pageStep,
  pageSweep,
  runPageStep,
  runSweep,
  sweepLimitMs,
  withDeadline
};
