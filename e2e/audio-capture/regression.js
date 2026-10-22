'use strict';

// The audio regression suite (README.md in this folder): the sound the
// extension's engines actually make, recorded without a gap across the
// changes that have gone wrong before, in a browser of each kind. The
// browser drivers are chromium-regression.js and firefox-regression.js.
//
// Each check records one continuous span of a page's audio. Every action
// the check takes is marked on the context's clock just before and just
// after it, and every frame of the span is checked: for clicks, for silent
// stretches the engines don't make on purpose, and in the steady stretches
// between actions for the tones, channels and player speed that should be
// there. The recorder is running, and has recorded at least 100 ms, before
// each action, so a transition is never cropped away.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const {
  ENGINE_SETTINGS,
  READY_TIMEOUT_MS,
  RECORDER_PROBLEMS,
  applyThroughExtension,
  clickStart,
  prepareTrialExtension,
  provenance,
  root,
  sleep,
  snapshot,
  waitFor
} = require('./harness');
const { HISTORY } = require('./history');
const { TONE, TONE_B, encodeWav, startTrialServer } = require('./fixture');
const { CLICK_THRESHOLD, analyzeSpan, decodeChannels, envelope, spanHealth } = require('./metrics');

const ARTIFACT_ROOT = path.join(root, 'test-results', 'audio-regression');
// "compact" keeps the JSON but writes sound excerpts only around problems,
// for repeated runs.
const COMPACT = process.env.AUDIO_REGRESSION_EVIDENCE === 'compact';
const RETAIN_SECONDS = 20;
// Recorded before a span's first action.
const PRE_ROLL_MS = 300;
// From the song starting to a span that starts in it (the trial's settle).
const START_SETTLE_MS = 750;
// After an action, before a steady stretch is measured, and how long that is.
const SETTLE_MS = 400;
const HOLD_MS = 600;
const EXCERPT_BEFORE_MS = 50;
const EXCERPT_AFTER_MS = 400;

// The silence the engines make on purpose (youtube-main.js and
// spotify-main.js). A change that makes the player click (in Firefox any
// change of speed or pitch mode, in Chromium a change of pitch mode) fades
// the output out over 10 ms from 20 ms ahead, changes the player 40 ms
// after the request and keeps the output silent until 80 ms after that:
// about 90 ms of silence. 60 ms more allows for a page timer running late.
const DIP_MS = 150;
// A player routed into the graph for the first time: Firefox's engines keep
// the output silent for 250 ms (Firefox itself goes silent and clicks then)
// and fade in over 25 ms; in Chromium only a change of pitch mode's silence
// applies. 60 ms more allows for a late timer, as above.
const FIRST_ROUTE_MS = { chromium: DIP_MS, firefox: 250 + 25 + 60 };
// How long after an action its silence or clicks may start: the request's
// own round trip and the engine's timers, with room for a busy machine.
const ACTION_WINDOW_MS = 300;
// After the extension is turned off, removed or updated, the engines notice
// within their 250 ms check and fade back to the unchanged sound. The window
// also allows for the browser shutting the extension down first.
const LIFECYCLE_WINDOW_MS = 1500;
const RESTORE_LIMIT_MS = 1000;
// A change starts 20 ms ahead and fades over 25 ms, so a second change that
// reaches the engine 20 to 45 ms after the first arrives mid-fade. A slider
// sends one about every 16 ms as it is dragged; the sweep sends one every
// 30 ms, and at least 3 of its 7 steps have to land mid-fade.
const OVERLAP_MS = [20, 45];
const SWEEP_STEP_MS = 30;
const MIN_OVERLAPPING = 3;

const EFFECT = Object.freeze({ ...ENGINE_SETTINGS });

// What a steady stretch should sound like. The engines' compressor raises
// the level a little (0.287 for a tone of 0.25), and reverb mixes in copies
// of the tone at other phases, so levels through the effect are coarse. The
// unchanged path is the song itself, so its level is exact.
function effectExpect(settings, tones = TONE) {
  const pitch = settings.keepPitch ? 1 : settings.speed;
  const wrong = settings.keepPitch ? settings.speed : 1;
  const present = (hz) => ({ hz, min: 0.1, max: 0.5 });
  const absent = (hz) => ({ hz, min: 0, max: 0.02 });
  const [left, right] = [tones.leftHz * pitch, tones.rightHz * pitch];
  const media = { rate: settings.speed };
  if (settings.pan === -100) {
    return { channels: [{ tones: [present(left), present(right), absent(tones.leftHz * wrong)] }, { maxRms: 0.001 }], media };
  }
  if (settings.pan === 0) {
    return { channels: [{ tones: [present(left), absent(right)] }, { tones: [present(right), absent(left)] }], media };
  }
  throw new Error(`no expectation for pan ${settings.pan}`);
}

function dryExpect(rate = 1, tones = TONE) {
  const exact = (hz) => ({ hz, min: 0.24, max: 0.26 });
  const absent = (hz) => ({ hz, min: 0, max: 0.005 });
  const [left, right] = [tones.leftHz * rate, tones.rightHz * rate];
  return { channels: [{ tones: [exact(left), absent(right)] }, { tones: [exact(right), absent(left)] }], media: { rate } };
}

// For an action that should change nothing about the sound: no silence and
// no clicks.
const NOTHING = Object.freeze({});

// What a change of settings may do: the engines' silent dip when it changes
// how the player plays, nothing otherwise.
function settingsChange(target, from, to) {
  const pitchChanges = from.keepPitch !== to.keepPitch;
  const speedChanges = Math.abs(from.speed - to.speed) > 0.001;
  return pitchChanges || (target === 'firefox' && speedChanges) ? { silenceMs: DIP_MS } : NOTHING;
}

function defineRegression(browser) {
  const artifacts = path.join(ARTIFACT_ROOT, browser.label);
  const target = browser.target;
  let server;
  let tempRoot;
  let normal;
  let older;
  const summary = { browser: browser.label, checks: [] };

  describe(`audio regression suite: ${browser.label}`, { concurrency: 1 }, () => {
    before(async () => {
      fs.rmSync(artifacts, { recursive: true, force: true });
      fs.mkdirSync(artifacts, { recursive: true });
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-audio-regression-'));
      server = await startTrialServer();
      normal = prepareTrialExtension(path.join(tempRoot, 'normal'), target);
      older = prepareTrialExtension(path.join(tempRoot, 'older'), target, { version: '0.0.1' });
      const environment = { label: browser.label, ...provenance(target), extensionCopy: normal, olderCopy: older };
      environment.suite = { retainSeconds: RETAIN_SECONDS, settleMs: SETTLE_MS, holdMs: HOLD_MS, clickThreshold: CLICK_THRESHOLD, dipMs: DIP_MS, firstRouteMs: FIRST_ROUTE_MS, restoreLimitMs: RESTORE_LIMIT_MS };
      environment.hostAtLaunch = { loadAverage: os.loadavg(), freeMemoryMb: Math.round(os.freemem() / 1e6), cpus: os.cpus().length };
      try {
        environment.browser = await browser.start({ server, extensionDir: normal.extensionDir, artifacts });
      } catch (error) {
        environment.startupFailure = String(error?.message ?? error).slice(0, 2_000);
        throw new Error(`browser startup failed before any audio was measured: ${error?.message ?? error}`, { cause: error });
      } finally {
        fs.writeFileSync(path.join(artifacts, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);
      }
    });

    after(async () => {
      fs.writeFileSync(path.join(artifacts, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      await browser.stop();
      await server?.close();
      if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    // --- pages and spans ---------------------------------------------------

    function urlFor(site) {
      return `${site === 'spotify' ? server.spotifyUrl : server.youtubeUrl}long`;
    }

    // Logs every request that reaches the page's engine, to show when
    // changes overlapped.
    function logEngineRequests() {
      window.engineRequests = [];
      window.addEventListener('message', (event) => {
        const { channel, type, enabled, settings } = event.data ?? {};
        if (event.source !== window || type !== 'APPLY') return;
        if (channel !== 'SLOWED_REVERB_YOUTUBE' && channel !== 'SLOWED_REVERB_SPOTIFY') return;
        window.engineRequests.push({ atMs: performance.now(), enabled, pan: settings?.pan, speed: settings?.speed });
      });
    }

    async function waitForEngine(page, site) {
      if (site === 'spotify') {
        // Spotify's scripts are registered by the extension for the page and
        // run as it loads; the first load can come before the registration.
        await waitFor(
          async () => {
            if (await page.evaluate(() => window.__slowedReverbSpotifyMain === true)) return true;
            await page.reload();
            return false;
          },
          10_000,
          "the extension's registered Spotify engine never ran in the page"
        );
      } else {
        await waitFor(() => page.evaluate(() => document.getElementById('player').readyState >= 1), 10_000, 'the tone never loaded');
      }
      await page.evaluate(logEngineRequests);
    }

    // Waits for the song to be heard, so a span taken next starts in it.
    async function untilSounding(page) {
      await page.evaluate((timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS);
      await sleep(START_SETTLE_MS);
    }

    // Opens a page with the effect on (`settings`) before the song starts,
    // or with `playing` set, the song already playing without it.
    async function openSite(site, { settings = EFFECT, playing = false } = {}) {
      const page = await browser.newPage(urlFor(site), { workletUrl: server.workletPath, retainSeconds: RETAIN_SECONDS });
      await waitForEngine(page, site);
      if (playing) {
        if (site === 'spotify') await applyThroughExtension(page, settings, false);
        await clickStart(page);
      } else {
        const applied = await applyThroughExtension(page, settings, true);
        assert.equal(applied?.success, true, `the effect didn't turn on: ${JSON.stringify(applied)}`);
        await clickStart(page);
        await untilSounding(page);
      }
      return page;
    }

    async function mark(span, label) {
      const value = await span.page.evaluate(({ label }) => window.__audioTrial.mark(0, label), { label });
      span.marks.push(value);
      return value;
    }

    // Starts recording a span once the recorder is running. `fromStart`
    // takes the span from the first recorded frame, for an action that
    // created the audio context itself.
    async function beginSpan(page, name, { fromStart = false } = {}) {
      await page.evaluate((timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS);
      const start = await snapshot(page);
      const span = { page, name, start, fromFrame: fromStart ? 0 : start.recorder.nextFrame, marks: [], actions: [], segments: [], checks: [] };
      if (!fromStart) await sleep(PRE_ROLL_MS);
      return span;
    }

    async function act(spans, label, allow, run) {
      const list = Array.isArray(spans) ? spans : [spans];
      const befores = [];
      for (const span of list) befores.push(await mark(span, `${label}: before`));
      const started = Date.now();
      const result = await run();
      const durationMs = Date.now() - started;
      for (const [index, span] of list.entries()) {
        const afterMark = await mark(span, `${label}: after`);
        const allowed = typeof allow === 'function' ? allow({ durationMs, span }) : allow;
        span.actions.push({
          label,
          startFrame: befores[index].recorderFrame,
          endFrame: afterMark.recorderFrame,
          allow: { windowMs: ACTION_WINDOW_MS, ...allowed },
          durationMs,
          result
        });
      }
      return result;
    }

    // A steady stretch, measured from SETTLE_MS after the last action.
    async function hold(spans, label, expect, { settleMs = SETTLE_MS, holdMs = HOLD_MS } = {}) {
      const list = Array.isArray(spans) ? spans : [spans];
      const expects = Array.isArray(expect) ? expect : list.map(() => expect);
      await sleep(settleMs);
      const froms = [];
      for (const span of list) froms.push(await mark(span, `${label}: from`));
      await sleep(holdMs);
      for (const [index, span] of list.entries()) {
        const to = await mark(span, `${label}: to`);
        span.segments.push({ label, fromFrame: froms[index].recorderFrame, toFrame: to.recorderFrame, expect: expects[index], from: froms[index], to });
      }
    }

    function mediaProblems(segment) {
      const wanted = segment.expect?.media;
      if (!wanted) return [];
      const { from, to } = segment;
      const seconds = (to.wallMs - from.wallMs) / 1000;
      const rate = seconds > 0 && from.media && to.media ? (to.media.clock - from.media.clock) / seconds : 0;
      segment.mediaRate = Math.round(rate * 1000) / 1000;
      const problems = [];
      if (!from.media || to.media.paused || from.media.paused) {
        problems.push({ code: 'media-stopped', message: `${segment.label}: the player was paused` });
      } else if (Math.abs(rate - wanted.rate) > wanted.rate * 0.15) {
        problems.push({ code: 'media-rate', message: `${segment.label}: the player advanced at ${segment.mediaRate} times the wall clock (wanted ${wanted.rate})` });
      }
      return problems;
    }

    // When the sound came back unchanged after a lifecycle action: the first
    // frame from which every 10 ms of the right channel carries the song's
    // own right tone (RMS 0.177; the effect, panned left, leaves it silent),
    // up to the end of the steady stretch after it.
    function restoration(analysisInput, action, segment) {
      const { right, sampleRate, fromFrame } = analysisInput;
      const step = Math.round(sampleRate / 100);
      const start = action.startFrame - fromFrame;
      const end = Math.min(right.length, (segment?.toFrame ?? fromFrame + right.length) - fromFrame);
      let restored = null;
      for (let block = start; block + step <= end; block += step) {
        let sum = 0;
        for (let i = block; i < block + step; i++) sum += right[i] ** 2;
        const dry = Math.sqrt(sum / step) >= 0.1;
        if (!dry) restored = null;
        else if (restored === null) restored = block;
      }
      return restored === null ? null : Math.round(((restored - start) / sampleRate) * 1000);
    }

    // Ends a span, measures it and keeps its evidence. Returns its problems.
    async function finishSpan(span) {
      const end = await snapshot(span.page);
      const read = await span.page.evaluate(
        ({ from, to }) => window.__audioTrial.read(0, from, to),
        { from: span.fromFrame, to: end.recorder.nextFrame }
      );
      const [left, right] = decodeChannels(read);
      const { sampleRate } = read;
      const health = spanHealth(span.start, end, [left, right], span.fromFrame);
      const analysis = analyzeSpan({ sampleRate, fromFrame: span.fromFrame, left, right, actions: span.actions, segments: span.segments });
      const problems = [...health, ...analysis.problems];
      for (const segment of span.segments) problems.push(...mediaProblems(segment));

      const restorations = [];
      for (const action of span.actions.filter((candidate) => candidate.allow?.restores)) {
        const segment = span.segments.find((candidate) => candidate.fromFrame > action.endFrame);
        const restoredAfterMs = restoration({ right, sampleRate, fromFrame: span.fromFrame }, action, segment);
        restorations.push({ action: action.label, restoredAfterMs, limitMs: RESTORE_LIMIT_MS });
        if (restoredAfterMs === null || restoredAfterMs > RESTORE_LIMIT_MS) {
          problems.push({
            code: 'not-restored',
            message: `${action.label}: ${restoredAfterMs === null ? 'the unchanged sound never came back' : `the unchanged sound came back after ${restoredAfterMs} ms`} (wanted within ${RESTORE_LIMIT_MS} ms)`
          });
        }
      }
      // The player paused by anything but the check itself, such as another
      // app taking the system's media controls: an interrupted recording,
      // not the extension's sound.
      const playerEvents = await span.page.evaluate(() => window.playerEvents ?? []);
      const ignoredMediaActions = await span.page.evaluate(() => window.ignoredMediaActions ?? []);
      const startMs = span.start.wallMs;
      const byAction = (atMs) =>
        span.actions.some((action) => {
          const before = span.marks.find((mark) => mark.label === `${action.label}: before`);
          const done = span.marks.find((mark) => mark.label === `${action.label}: after`);
          return before && done ? atMs >= before.wallMs && atMs <= done.wallMs + 100 : false;
        });
      for (const event of playerEvents.filter((candidate) => candidate.type === 'pause' && candidate.atMs >= startMs)) {
        if (!byAction(event.atMs)) {
          problems.push({ code: 'interrupted', message: `the player paused ${Math.round(event.atMs - startMs)} ms into the span, not by the check` });
        }
      }
      problems.push(...span.checks);

      const name = span.name;
      const toMs = (frame) => Math.round(((frame - span.fromFrame) / sampleRate) * 10_000) / 10;
      const excerpts = [];
      const keep = (label, frame) => {
        const from = Math.max(0, frame - span.fromFrame - Math.round((EXCERPT_BEFORE_MS / 1000) * sampleRate));
        const to = Math.min(left.length, frame - span.fromFrame + Math.round((EXCERPT_AFTER_MS / 1000) * sampleRate));
        if (to <= from) return;
        const file = `${name}-${excerpts.length + 1}.wav`;
        fs.writeFileSync(path.join(artifacts, file), encodeWav(left.subarray(from, to), right.subarray(from, to), sampleRate));
        excerpts.push({ file, label, fromMs: toMs(span.fromFrame + from), toMs: toMs(span.fromFrame + to) });
      };
      if (!COMPACT) for (const action of span.actions) keep(action.label, action.startFrame);
      for (const event of [...analysis.clicks, ...analysis.silences].filter((item) => item.allowed === false)) keep(`problem at ${event.atMs} ms`, event.frame);

      const record = {
        name,
        browser: browser.label,
        problems,
        health,
        quietPeak: analysis.quietPeak,
        clickThreshold: analysis.clickThreshold,
        sampleRate,
        frames: left.length,
        firstContextFrame: end.recorder.firstContextFrame,
        frameOffset: end.recorder.frameOffset,
        contexts: end.contextCount,
        actions: span.actions.map((action) => ({
          label: action.label,
          atMs: toMs(action.startFrame),
          doneMs: toMs(action.endFrame),
          durationMs: action.durationMs,
          allow: action.allow,
          result: action.result ?? null
        })),
        clicks: analysis.clicks,
        silences: analysis.silences,
        segments: analysis.segments.map((segment, index) => ({ ...segment, mediaRate: span.segments[index].mediaRate ?? null })),
        restorations,
        excerpts,
        marks: span.marks,
        rateChanges: await span.page.evaluate(() => window.rateChanges ?? []),
        playerEvents,
        ignoredMediaActions,
        engineRequests: await span.page.evaluate(() => window.engineRequests ?? []),
        envelope10ms: envelope(left, right, sampleRate),
        snapshots: { start: span.start, end }
      };
      fs.writeFileSync(path.join(artifacts, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
      summary.checks.push({
        name,
        problems: problems.map(({ code, message }) => `${code}: ${message}`),
        clicks: analysis.clicks.length,
        silences: analysis.silences.map(({ atMs, durationMs, action }) => ({ atMs, durationMs, action })),
        restorations,
        maxClick: Math.max(0, ...analysis.clicks.map((click) => click.peak)),
        quietPeak: analysis.quietPeak,
        firstContextFrame: end.recorder.firstContextFrame
      });
      return problems;
    }

    function assertClean(name, problems) {
      assert.deepEqual(
        problems.map(({ code, message }) => `${code}: ${message}`),
        [],
        `${name} (evidence in ${path.relative(root, artifacts)}/${name}.json)`
      );
    }

    // The page's own actions, as a site does them.
    const pageActions = {
      setRate: (page, rate) => page.evaluate((rate) => { document.getElementById('player').playbackRate = rate; }, rate),
      pause: (page) => page.evaluate(() => document.getElementById('player').pause()),
      play: (page) => page.evaluate(() => document.getElementById('player').play().then(() => 'playing')),
      rateChangesSince: (page, atMs) => page.evaluate((atMs) => window.rateChanges.filter((change) => change.atMs >= atMs), atMs)
    };

    // --- the checks ----------------------------------------------------------

    // Speed and pitch as heard, and the reverb as a tail after the song
    // stops: none without reverb, some with it.
    async function steadyCheck(site, name) {
      const page = await openSite(site);
      const span = await beginSpan(page, name);
      await hold(span, '0.8x with the pitch following', effectExpect(EFFECT), { settleMs: 0 });
      const keepPitch = { ...EFFECT, keepPitch: true };
      await act(span, 'keep the pitch', settingsChange(target, EFFECT, keepPitch), () => applyThroughExtension(page, keepPitch, true));
      await hold(span, '0.8x with the pitch kept', effectExpect(keepPitch));
      const tail = { clicks: true, silenceMs: Infinity };
      await act(span, 'stop the song without reverb', tail, () => pageActions.pause(page));
      await hold(span, 'after the song without reverb', { channels: [{ maxRms: 1e-4 }, { maxRms: 1e-4 }] }, { settleMs: 50, holdMs: 400 });
      const reverb = { ...EFFECT, reverb: 60 };
      await act(span, 'reverb 60 and play', { clicks: true, silenceMs: Infinity }, async () => {
        await applyThroughExtension(page, reverb, true);
        return pageActions.play(page);
      });
      await hold(span, '0.8x with reverb', effectExpect(reverb), { settleMs: 1000 });
      await act(span, 'stop the song with reverb', tail, () => pageActions.pause(page));
      // The tail of a 2 s reverb, from 50 to 450 ms after the song stops.
      await hold(span, 'after the song with reverb', { channels: [{ minRms: 0.005 }, { maxRms: 0.001 }] }, { settleMs: 50, holdMs: 400 });
      const problems = await finishSpan(span);
      await page.close();
      return problems;
    }

    // Turning the effect on while the song plays: the engine routes the
    // playing player into a new graph, and the recording starts with that
    // graph, so the whole change is heard. The span ends about a second
    // after the sound comes in: Firefox itself clicks once, 2 to 4 s after
    // a playing player is routed into a graph and its speed or pitch mode
    // changes, with or without the extension (README.md in this folder).
    async function firstEnableCheck(site, name) {
      const page = await openSite(site, { playing: true });
      assert.equal(await page.evaluate(() => window.__audioTrial.contextCount()), 0, 'an audio context existed before the effect turned on');
      const firstOn = Date.now();
      const applied = await applyThroughExtension(page, EFFECT, true);
      const span = await beginSpan(page, name, { fromStart: true });
      const on = await mark(span, 'turn on while playing: after');
      span.actions.push({
        label: 'turn on while playing',
        startFrame: 0,
        endFrame: on.recorderFrame,
        allow: { fromRecordingStart: true, silenceMs: FIRST_ROUTE_MS[target], windowMs: ACTION_WINDOW_MS },
        durationMs: Date.now() - firstOn,
        result: applied
      });
      if (applied?.success !== true) span.checks.push({ code: 'setup', message: `the effect didn't turn on: ${JSON.stringify(applied)}` });
      await hold(span, 'on', effectExpect(EFFECT));
      const problems = await finishSpan(span);
      await page.close();
      return problems;
    }

    // Changes of each kind while the song plays through the effect: reverb,
    // pan, speed, changes overlapping as when a slider is dragged, the pitch
    // mode, and turning the effect off and on.
    async function transitionsCheck(site, name) {
      const page = await openSite(site);
      const span = await beginSpan(page, name);
      let current = EFFECT;
      const change = async (label, next) => {
        await act(span, label, settingsChange(target, current, next), () => applyThroughExtension(page, next, true));
        current = next;
        await hold(span, label, effectExpect(next));
      };
      await hold(span, 'on', effectExpect(EFFECT), { settleMs: 0 });
      await change('reverb 40', { ...current, reverb: 40 });
      await change('pan to the middle', { ...current, pan: 0 });
      await change('speed 0.9', { ...current, speed: 0.9 });

      // A dragged slider: requests SWEEP_STEP_MS apart, without waiting for
      // the answers, so each one reaches the engine while the fade the one
      // before started is still under way.
      const sweep = [100, -100, 100, -100, 100, -100, 100, -100].map((pan) => ({ ...current, pan }));
      const requestsFrom = await page.evaluate(() => performance.now());
      await act(span, 'overlapping changes', NOTHING, () =>
        Promise.all(sweep.map((settings, index) => sleep(index * SWEEP_STEP_MS).then(() => applyThroughExtension(page, settings, true))))
      );
      current = sweep[sweep.length - 1];
      const requests = await page.evaluate((atMs) => window.engineRequests.filter((request) => request.atMs >= atMs), requestsFrom);
      const spacing = requests.slice(1).map((request, index) => Math.round((request.atMs - requests[index].atMs) * 10) / 10);
      const overlapping = spacing.filter((gap) => gap >= OVERLAP_MS[0] && gap < OVERLAP_MS[1]).length;
      span.actions[span.actions.length - 1].result = { spacingMs: spacing, overlapping };
      if (requests.length !== sweep.length || requests[requests.length - 1].pan !== current.pan) {
        span.checks.push({ code: 'setup', message: `the engine got ${requests.length} requests, the last with pan ${requests[requests.length - 1]?.pan}` });
      } else if (overlapping < MIN_OVERLAPPING) {
        span.checks.push({
          code: 'not-overlapping',
          message: `only ${overlapping} requests reached the engine ${OVERLAP_MS[0]} to ${OVERLAP_MS[1]} ms after the one before (${spacing.join(', ')} ms apart; wanted ${MIN_OVERLAPPING})`
        });
      }
      await hold(span, 'after overlapping changes', effectExpect(current));

      await change('keep the pitch', { ...current, keepPitch: true });
      await change('pitch following again', { ...current, keepPitch: false });
      await act(span, 'turn off', settingsChange(target, current, { ...current, speed: 1 }), () => applyThroughExtension(page, current, false));
      await hold(span, 'off', dryExpect());
      await act(span, 'turn on', settingsChange(target, { ...current, speed: 1 }, current), () => applyThroughExtension(page, current, true));
      await hold(span, 'on again', effectExpect(current));
      const problems = await finishSpan(span);
      await page.close();
      return problems;
    }

    // Spotify sets its player back to normal speed every few seconds, holds
    // it at 0 while it seeks, and changes the song on the same player.
    async function spotifyResetsCheck(name) {
      const page = await openSite('spotify');
      const span = await beginSpan(page, name);
      await hold(span, 'on', effectExpect(EFFECT), { settleMs: 0 });

      const resetsFrom = await page.evaluate(() => performance.now());
      await act(span, 'Spotify resets the speed three times', NOTHING, async () => {
        for (let reset = 0; reset < 3; reset++) {
          await pageActions.setRate(page, 1);
          await sleep(300);
        }
      });
      const changes = await pageActions.rateChangesSince(page, resetsFrom);
      span.actions[span.actions.length - 1].result = { rateChanges: changes };
      // A check of the player, not of the sound: the player's speed never
      // changed, so there was nothing for the engine to hide.
      if (changes.length) span.checks.push({ code: 'rate-changed', message: `the player changed speed ${changes.length} times during Spotify's resets` });
      await hold(span, 'after the resets', effectExpect(EFFECT));

      // A seek: Spotify holds the player at 0, then asks for normal speed.
      await act(span, 'a seek holds the player still', ({ durationMs }) => ({ clicks: true, silenceMs: durationMs + DIP_MS }), async () => {
        await pageActions.setRate(page, 0);
        await sleep(300);
        await pageActions.setRate(page, 1);
      });
      await hold(span, 'after the seek', effectExpect(EFFECT));

      const keepPitch = { ...EFFECT, keepPitch: true };
      await act(span, 'keep the pitch', settingsChange(target, EFFECT, keepPitch), () => applyThroughExtension(page, keepPitch, true));
      await hold(span, 'pitch kept', effectExpect(keepPitch));

      // Turning the effect off changes the pitch mode, so the change waits
      // 40 ms for the output to fade out. Spotify, holding the player still
      // for a seek, asks for normal speed 5 ms into that wait.
      await act(span, 'turn off while Spotify holds the player and then asks for normal speed', ({ durationMs }) => ({ clicks: true, silenceMs: durationMs + DIP_MS }), async () => {
        await pageActions.setRate(page, 0);
        await sleep(200);
        await page.evaluate(() => {
          window.addEventListener('message', function listener(event) {
            if (event.source !== window || event.data?.channel !== 'SLOWED_REVERB_SPOTIFY' || event.data.type !== 'APPLY') return;
            if (event.data.enabled !== false) return;
            window.removeEventListener('message', listener);
            setTimeout(() => { document.getElementById('player').playbackRate = 1; }, 5);
          });
        });
        return applyThroughExtension(page, keepPitch, false);
      });
      await hold(span, 'off', dryExpect());

      await act(span, 'turn on', settingsChange(target, { ...EFFECT, speed: 1 }, EFFECT), () => applyThroughExtension(page, EFFECT, true));
      await hold(span, 'on again', effectExpect(EFFECT));

      // The next song on the same player. Loading it sets the player back to
      // its default speed, which the engine undoes, and Spotify then asks for
      // normal speed itself, which the engine keeps.
      await act(span, 'the next song', ({ durationMs }) => ({ clicks: true, silenceMs: durationMs + DIP_MS }), () =>
        page.evaluate(async () => {
          const player = document.getElementById('player');
          const playing = new Promise((resolve) => player.addEventListener('playing', resolve, { once: true }));
          player.src = '/tone-b-long.wav';
          await player.play();
          await playing;
          player.playbackRate = 1;
        })
      );
      await hold(span, 'the next song', effectExpect(EFFECT, TONE_B));
      const contexts = await page.evaluate(() => window.__audioTrial.contextCount());
      if (contexts !== 1) span.checks.push({ code: 'contexts', message: `${contexts} audio contexts, wanted 1` });
      const problems = await finishSpan(span);
      await page.close();
      return problems;
    }

    // Turning the extension off in the browser, as from its extensions page,
    // and on again. On YouTube, with the extension off, the page then takes
    // its player out and puts it back, at a speed of its own.
    async function lifecycleCheck(site, name, { remove = false } = {}) {
      const page = await openSite(site);
      const span = await beginSpan(page, name);
      await hold(span, 'on', effectExpect(EFFECT), { settleMs: 0 });
      const off = { restores: true, silenceMs: settingsChange(target, EFFECT, { ...EFFECT, speed: 1 }).silenceMs ?? 0, windowMs: LIFECYCLE_WINDOW_MS };
      if (remove) await act(span, 'remove the extension', off, () => browser.remove());
      else await act(span, 'turn the extension off', off, () => browser.disable());
      await hold(span, 'off', dryExpect(), { settleMs: 1000 });

      if (site === 'youtube') {
        await act(span, 'the page takes its player out and puts it back at 1.25x', ({ durationMs }) => ({ clicks: true, silenceMs: durationMs + DIP_MS }), () =>
          page.evaluate(async () => {
            const player = document.getElementById('player');
            const parent = player.parentNode;
            player.remove();
            // Longer than the engine waits before it looks at the page again.
            await new Promise((resolve) => setTimeout(resolve, 400));
            player.playbackRate = 1.25;
            parent.append(player);
            await player.play();
          })
        );
        await hold(span, 'put back at 1.25x', dryExpect(1.25));
      }
      if (remove) {
        const problems = await finishSpan(span);
        await page.close();
        return problems;
      }

      await act(span, 'turn the extension back on', NOTHING, () => browser.enable());
      await hold(span, 'back on, effect off', dryExpect(site === 'youtube' ? 1.25 : 1));
      await browser.reinjectDriver(page);
      const fromRate = site === 'youtube' ? 1.25 : 1;
      let reply;
      await act(span, 'turn the effect on again', settingsChange(target, { ...EFFECT, speed: fromRate }, EFFECT), async () => {
        reply = await applyThroughExtension(page, EFFECT, true);
        return reply;
      });
      // Chromium doesn't put Spotify's scripts back into an open tab, so
      // Spotify needs a reload there, as the popup says.
      const spotifyNeedsReload = site === 'spotify' && target === 'chromium';
      if (spotifyNeedsReload) {
        if (reply?.success !== false) span.checks.push({ code: 'setup', message: `Spotify answered without a reload: ${JSON.stringify(reply)}` });
        await hold(span, 'without a reload', dryExpect());
      } else {
        if (reply?.success !== true) span.checks.push({ code: 'not-on', message: `the effect didn't turn on again: ${JSON.stringify(reply)}` });
        await hold(span, 'on again', effectExpect(EFFECT));
      }
      const problems = await finishSpan(span);
      if (spotifyNeedsReload) problems.push(...(await afterReload(page, `${name}-reloaded`, site)));
      await page.close();
      return problems;
    }

    // A reloaded page runs this version's engine, with the effect.
    async function afterReload(page, name, site) {
      await page.reload();
      await waitForEngine(page, site);
      const applied = await applyThroughExtension(page, EFFECT, true);
      await clickStart(page);
      await untilSounding(page);
      const span = await beginSpan(page, name);
      if (applied?.success !== true) span.checks.push({ code: 'not-on', message: `the effect didn't turn on after a reload: ${JSON.stringify(applied)}` });
      await hold(span, 'reloaded', effectExpect(EFFECT), { settleMs: 0 });
      return finishSpan(span);
    }

    // An update leaves the previous version's engine in the page. It turns
    // itself off, and has to stay off until the page is reloaded: on Spotify
    // in Firefox also after the extension is turned off and on, which puts
    // the new bridge next to it.
    async function updateCheck(site, name, newer) {
      await browser.useExtension(older.extensionDir);
      try {
        const page = await openSite(site);
        const span = await beginSpan(page, name);
        await hold(span, 'on, previous version', effectExpect(EFFECT), { settleMs: 0 });
        const off = { restores: true, silenceMs: settingsChange(target, EFFECT, { ...EFFECT, speed: 1 }).silenceMs ?? 0, windowMs: LIFECYCLE_WINDOW_MS };
        await act(span, 'update the extension', off, () => browser.update(newer.extensionDir));
        await hold(span, 'updated', dryExpect(), { settleMs: 1000 });
        if (site === 'spotify') {
          await act(span, 'turn the extension off and on', NOTHING, async () => {
            await browser.disable();
            await browser.enable();
          });
          await hold(span, 'off and on', dryExpect());
        }
        await browser.reinjectDriver(page);
        let reply;
        await act(span, 'ask for the effect', NOTHING, async () => {
          reply = await applyThroughExtension(page, EFFECT, true);
          return reply;
        });
        await hold(span, 'kept off until a reload', dryExpect());
        const blocked = reply?.success === false && reply.blockReason === 'outdated';
        if (!blocked) {
          span.checks.push({ code: 'old-engine-ran', message: `the previous version's engine was used: ${JSON.stringify(reply)}` });
        }
        const problems = await finishSpan(span);
        problems.push(...(await afterReload(page, `${name}-reloaded`, site)));
        await page.close();
        return problems;
      } finally {
        await browser.useExtension(normal.extensionDir);
      }
    }

    // --- tests ---------------------------------------------------------------

    const sites = ['youtube', 'spotify'];

    for (const site of sites) {
      test(`speed, pitch and reverb as heard: ${site}`, async () => {
        assertClean(`steady-${site}`, await steadyCheck(site, `steady-${site}`));
      });
    }
    for (const site of sites) {
      test(`turning the effect on while the song plays: ${site}`, async () => {
        assertClean(`first-enable-${site}`, await firstEnableCheck(site, `first-enable-${site}`));
      });
    }
    for (const site of sites) {
      test(`changes while the song plays: ${site}`, async () => {
        assertClean(`transitions-${site}`, await transitionsCheck(site, `transitions-${site}`));
      });
    }
    test("Spotify's own speed resets, a seek and the next song", async () => {
      assertClean('spotify-resets', await spotifyResetsCheck('spotify-resets'));
    });
    for (const site of sites) {
      test(`turning the extension off and on in the browser: ${site}`, async () => {
        assertClean(`lifecycle-${site}`, await lifecycleCheck(site, `lifecycle-${site}`));
      });
    }
    if (browser.canRemove) {
      for (const site of sites) {
        test(`removing the extension: ${site}`, async () => {
          try {
            assertClean(`removed-${site}`, await lifecycleCheck(site, `removed-${site}`, { remove: true }));
          } finally {
            await browser.useExtension(normal.extensionDir);
          }
        });
      }
    }
    for (const site of target === 'firefox' ? sites : ['youtube']) {
      test(`an update keeps the previous engine off until a reload: ${site}`, async () => {
        assertClean(`update-${site}`, await updateCheck(site, `update-${site}`, normal));
      });
    }

    // The historical defects, each put back into a copy and caught.
    const runCheck = {
      transitions: async (id) => [...(await transitionsCheck('youtube', `${id}-youtube`)), ...(await transitionsCheck('spotify', `${id}-spotify`))],
      'overlapping changes': async (id) => [...(await transitionsCheck('youtube', `${id}-youtube`)), ...(await transitionsCheck('spotify', `${id}-spotify`))],
      "Spotify's speed resets": (id) => spotifyResetsCheck(`${id}-spotify`),
      'a speed request during a waiting change': (id) => spotifyResetsCheck(`${id}-spotify`),
      'turning the extension off': async (id, entry) => {
        const list = entry.id.startsWith('9a900c4') ? ['youtube'] : entry.id === '1127987' ? ['spotify'] : sites;
        const problems = [];
        for (const site of list) problems.push(...(await lifecycleCheck(site, `${id}-${site}`)));
        return problems;
      },
      'an update': async (id, entry, copy) => updateCheck(entry.id === '4565b80' ? 'spotify' : 'youtube', `${id}-update`, copy)
    };

    for (const entry of HISTORY.filter((candidate) => candidate.browsers.includes(target))) {
      test(`control: ${entry.id} (${entry.kind}): ${entry.defect}`, async () => {
        const copy = prepareTrialExtension(path.join(tempRoot, `control-${entry.id}`), target, { mutations: entry.mutations });
        fs.writeFileSync(path.join(artifacts, `control-${entry.id}-copy.json`), `${JSON.stringify({ ...entry, copy }, null, 2)}\n`);
        const name = `control-${entry.id}`;
        let problems;
        if (entry.check === 'an update') {
          problems = await runCheck[entry.check](name, entry, copy);
        } else {
          await browser.useExtension(copy.extensionDir);
          try {
            problems = await runCheck[entry.check](name, entry, copy);
          } finally {
            await browser.useExtension(normal.extensionDir);
          }
        }
        const codes = problems.map((problem) => problem.code);
        const listed = problems.map(({ code, message }) => `${code}: ${message}`);
        summary.checks.push({ name: `${name} result`, codes: [...new Set(codes)] });
        for (const { code, during } of entry.expect) {
          const matching = problems.filter((problem) => problem.code === code && problem.message.includes(during));
          assert.ok(matching.length, `${entry.id} should fail with ${code} in "${during}"; got ${JSON.stringify(listed)}`);
        }
        const broken = problems.filter(
          (problem) =>
            RECORDER_PROBLEMS.includes(problem.code) ||
            ['setup', 'not-covered', 'onset-not-observed', 'not-overlapping', 'non-finite', 'interrupted'].includes(problem.code)
        );
        assert.deepEqual(broken.map(({ code, message }) => `${code}: ${message}`), [], `${entry.id} must fail for its sound, not its setup`);
      });
    }
  });
}

module.exports = { defineRegression };
