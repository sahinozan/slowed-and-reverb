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
  CHANNEL,
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
const { ACTION_LIMIT_MS, PAGE_BACKSTOP_MS, PAGE_STEP_MS, runPageStep, runSweep, withDeadline } = require('./actions');
const { HISTORY, controlVerdict } = require('./history');
const { TONE, TONE_B, encodeWav, startTrialServer } = require('./fixture');
const {
  CLICK_THRESHOLD,
  DRY_LEVEL_TOLERANCE,
  DRY_RESIDUAL_RMS,
  analyzeSpan,
  decodeChannels,
  dryRestoration,
  envelope,
  markProblems,
  spanHealth
} = require('./metrics');

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
// How long the engines' reverb rings (REVERB_DURATION in youtube-main.js
// and spotify-main.js). Its convolver comes before the pan and keeps
// hearing the song while the effect is off, so for 2 seconds after a
// change of pitch, or after the effect turns back on, its tail still
// carries the tones played before: the sound of any reverb, not a tone
// the effect should have lost. A tone the stretch after such a change
// shouldn't have is checked once the tail is over (ringingTones).
const REVERB_TAIL_MS = 2000;
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
// The unchanged sound has to be back this soon after such an action: both
// channels' own tones at their exact level and nothing else (dryRestoration
// in metrics.js).
const RESTORE_LIMIT_MS = 1000;
const DRY_TONES = [
  { hz: TONE.leftHz, amplitude: TONE.amplitude },
  { hz: TONE.rightHz, amplitude: TONE.amplitude }
];
// Turning the effect on while a song plays is recorded until this long
// after it: Firefox's own click after a playing player is routed into a
// graph comes 2 to 4 s later (README.md in this folder), so a click then is
// heard and fails the check.
const FIRST_ENABLE_OBSERVE_MS = 6000;
// How long cleaning up after a check that couldn't finish may wait for the
// page.
const CLEANUP_MS = 5_000;
// A change starts 20 ms ahead and fades over 25 ms, so a second change that
// reaches the engine 20 to 45 ms after the first arrives mid-fade. A slider
// sends one about every 16 ms as it is dragged; the sweep paces its
// requests to reach the engine 30 ms apart (pageSweep in actions.js), and
// at least 3 of its 7 steps have to land mid-fade.
const OVERLAP_MS = [20, 45];
const SWEEP_STEP_MS = 30;
const MIN_OVERLAPPING = 3;
// Where the extension's content scripts reach the engines.
const ENGINE_CHANNELS = ['SLOWED_REVERB_YOUTUBE', 'SLOWED_REVERB_SPOTIFY'];

const EFFECT = Object.freeze({ ...ENGINE_SETTINGS });
// The manifest's version, which every engine's VERSION equals
// (tests/settings.test.js).
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'manifest.json'), 'utf8')).version;

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

// The tones `next` shouldn't have that the stretch before (`previous`) had,
// in any channel, and `next` doesn't: with reverb on, the tail still rings
// them for REVERB_TAIL_MS after the change.
function ringingTones(previous, next, settings) {
  if (!(settings.reverb > 0)) return [];
  const tones = (expect, present) => expect.channels.flatMap((channel) => (channel.tones ?? []).filter((tone) => (tone.min > 0) === present).map((tone) => tone.hz));
  const before = tones(previous, true);
  const now = tones(next, true);
  return [...new Set(tones(next, false).filter((hz) => before.includes(hz) && !now.includes(hz)))];
}

// `expect` with no limit on the tones in `ringing` that it says shouldn't be
// there: they are still measured and kept with the stretch, marked as
// ringing, but any level passes.
function withoutRinging(expect, ringing) {
  return {
    ...expect,
    channels: expect.channels.map((channel) =>
      channel.tones
        ? { ...channel, tones: channel.tones.map((tone) => (tone.min > 0 || !ringing.includes(tone.hz) ? tone : { hz: tone.hz, min: 0, ringing: true })) }
        : channel
    )
  };
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
      environment.suite = {
        retainSeconds: RETAIN_SECONDS,
        settleMs: SETTLE_MS,
        holdMs: HOLD_MS,
        clickThreshold: CLICK_THRESHOLD,
        dipMs: DIP_MS,
        reverbTailMs: REVERB_TAIL_MS,
        firstRouteMs: FIRST_ROUTE_MS,
        firstEnableObserveMs: FIRST_ENABLE_OBSERVE_MS,
        restoreLimitMs: RESTORE_LIMIT_MS,
        dryLevelTolerance: DRY_LEVEL_TOLERANCE,
        dryResidualRms: DRY_RESIDUAL_RMS,
        pageStepMs: PAGE_STEP_MS,
        actionLimitMs: ACTION_LIMIT_MS
      };
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

    // The pages and spans of the check under way, so one that can't finish
    // still leaves its evidence and closes its pages (guarded).
    const live = { pages: new Set(), spans: new Set() };

    // A page's answer, or a measurement failure if it doesn't answer in time.
    function ask(page, what, fn, arg) {
      return withDeadline(page.evaluate(fn, arg), PAGE_STEP_MS + PAGE_BACKSTOP_MS, `the page didn't answer ${what}`);
    }

    async function closePage(page) {
      live.pages.delete(page);
      await withDeadline(page.close(), CLEANUP_MS, 'the page did not close').catch(() => {});
    }

    // Runs a check. If it can't finish (an action or the page that never
    // answers, a setup that fails), it writes what it has of each span to
    // <name>-failed.json, closes its pages and fails as a measurement
    // failure: never a sound result, and never a control caught.
    async function guarded(name, run) {
      try {
        return await run();
      } catch (error) {
        const spans = [];
        for (const span of live.spans) {
          const latest = await withDeadline(snapshot(span.page), CLEANUP_MS, 'no snapshot').catch((failure) => ({ error: failure.message }));
          spans.push({ name: span.name, fromFrame: span.fromFrame, actions: span.actions, marks: span.marks, checks: span.checks, start: span.start, latest });
        }
        const record = { name, browser: browser.label, error: String(error?.stack ?? error).slice(0, 4_000), spans };
        fs.writeFileSync(path.join(artifacts, `${name}-failed.json`), `${JSON.stringify(record, null, 2)}\n`);
        throw new Error(
          `${name}: the check couldn't finish, so this is a measurement failure, not a sound result: ${error?.message ?? error} ` +
            `(evidence in ${path.relative(root, artifacts)}/${name}-failed.json)`,
          { cause: error }
        );
      } finally {
        live.spans.clear();
        for (const page of [...live.pages]) await closePage(page);
      }
    }

    function urlFor(site) {
      return `${site === 'spotify' ? server.spotifyUrl : server.youtubeUrl}long`;
    }

    // Logs every request that reaches the page's engine, to show when
    // changes overlapped.
    function logEngineRequests(engineChannels) {
      window.engineRequests = [];
      window.addEventListener('message', (event) => {
        const { channel, type, enabled, settings } = event.data ?? {};
        if (event.source !== window || type !== 'APPLY' || !engineChannels.includes(channel)) return;
        window.engineRequests.push({ atMs: performance.now(), enabled, pan: settings?.pan, speed: settings?.speed });
      });
    }

    async function waitForEngine(page, site) {
      if (site === 'spotify') {
        // Spotify's scripts are registered by the extension for the page and
        // run as it loads; the first load can come before the registration.
        await waitFor(
          async () => {
            if (await ask(page, 'whether the engine ran', () => window.__slowedReverbSpotifyMain === true)) return true;
            await page.reload();
            return false;
          },
          10_000,
          "the extension's registered Spotify engine never ran in the page"
        );
      } else {
        await waitFor(() => ask(page, 'whether the tone loaded', () => document.getElementById('player').readyState >= 1), 10_000, 'the tone never loaded');
      }
      await ask(page, 'its request log', logEngineRequests, ENGINE_CHANNELS);
    }

    // Waits for the song to be heard, so a span taken next starts in it.
    async function untilSounding(page) {
      await ask(page, 'that the recorder is ready', (timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS);
      await sleep(START_SETTLE_MS);
    }

    // Opens a page with the effect on (`settings`) before the song starts,
    // or with `playing` set, the song already playing without it.
    async function openSite(site, { settings = EFFECT, playing = false } = {}) {
      const page = await browser.newPage(urlFor(site), { workletUrl: server.workletPath, retainSeconds: RETAIN_SECONDS });
      live.pages.add(page);
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
      const value = await ask(span.page, `a mark (${label})`, ({ label }) => window.__audioTrial.mark(0, label), { label });
      span.marks.push(value);
      return value;
    }

    // Starts recording a span once the recorder is running. `fromStart`
    // takes the span from the first recorded frame, for an action that
    // created the audio context itself.
    async function beginSpan(page, name, { fromStart = false } = {}) {
      await ask(page, 'that the recorder is ready', (timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS);
      const start = await withDeadline(snapshot(page), PAGE_STEP_MS, "the page didn't answer a snapshot");
      const span = { page, name, start, fromFrame: fromStart ? 0 : start.recorder.nextFrame, marks: [], actions: [], segments: [], checks: [] };
      live.spans.add(span);
      if (!fromStart) await sleep(PRE_ROLL_MS);
      return span;
    }

    // An action, marked before and after. One that isn't done within
    // ACTION_LIMIT_MS (or whose page step times out) fails the check as a
    // measurement failure (guarded), with the action kept in the evidence.
    async function act(spans, label, allow, run) {
      const list = Array.isArray(spans) ? spans : [spans];
      const befores = [];
      for (const span of list) befores.push(await mark(span, `${label}: before`));
      const started = Date.now();
      let result;
      try {
        result = await withDeadline(Promise.resolve().then(run), ACTION_LIMIT_MS, `the action "${label}"`);
      } catch (error) {
        for (const [index, span] of list.entries()) {
          span.actions.push({ label, startFrame: befores[index].recorderFrame, endFrame: null, durationMs: Date.now() - started, error: String(error?.message ?? error) });
        }
        throw error;
      }
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

    // A snapshot from at least one batch after `end`, so a stale run the
    // recorder logged near the span's end has caught up (frameLabelProblems
    // in metrics.js). If none comes, the span's own end stands in, and such
    // a run counts as unverified.
    async function settledAfter(page, end) {
      return waitFor(
        async () => {
          const later = await withDeadline(snapshot(page), PAGE_STEP_MS, "the page didn't answer a snapshot");
          return later.recorder.nextFrame > end.recorder.nextFrame ? later : null;
        },
        1_000,
        'no batch after the span'
      ).catch(() => end);
    }

    // Ends a span, measures it and keeps its evidence. Returns its problems.
    // `wholeSpan` also keeps all of its sound, as a WAV.
    async function finishSpan(span, { wholeSpan = false } = {}) {
      const end = await withDeadline(snapshot(span.page), PAGE_STEP_MS, "the page didn't answer a snapshot");
      const read = await ask(span.page, 'with its recording', ({ from, to }) => window.__audioTrial.read(0, from, to), {
        from: span.fromFrame,
        to: end.recorder.nextFrame
      });
      const settled = await settledAfter(span.page, end);
      const [left, right] = decodeChannels(read);
      const { sampleRate } = read;
      const health = [...spanHealth(span.start, end, [left, right], span.fromFrame, settled), ...markProblems(span.marks)];
      const analysis = analyzeSpan({ sampleRate, fromFrame: span.fromFrame, left, right, actions: span.actions, segments: span.segments });
      const problems = [...health, ...analysis.problems];
      for (const segment of span.segments) problems.push(...mediaProblems(segment));

      // The exact unchanged sound back after the extension is turned off,
      // removed or updated, within RESTORE_LIMIT_MS of the action's first
      // mark and up to the end of the steady stretch after it.
      const restorations = [];
      for (const action of span.actions.filter((candidate) => candidate.allow?.restores)) {
        const segment = span.segments.find((candidate) => candidate.fromFrame > action.endFrame);
        const restoration = dryRestoration({
          left,
          right,
          sampleRate,
          fromFrame: span.fromFrame,
          startFrame: action.startFrame,
          toFrame: segment?.toFrame ?? span.fromFrame + left.length,
          dry: DRY_TONES
        });
        const { restoredAfterMs, energyOnsetMs } = restoration;
        restorations.push({ action: action.label, ...restoration, limitMs: RESTORE_LIMIT_MS });
        if (restoredAfterMs === null || restoredAfterMs > RESTORE_LIMIT_MS) {
          const heard = energyOnsetMs === null ? '' : `; sound on the right from ${energyOnsetMs} ms`;
          problems.push({
            code: 'not-restored',
            message:
              `${action.label}: ${restoredAfterMs === null ? 'the unchanged sound never came back' : `the unchanged sound came back after ${restoredAfterMs} ms`}` +
              ` (both songs' tones at their exact level and nothing else, wanted within ${RESTORE_LIMIT_MS} ms${heard})`
          });
        }
      }
      // The player paused by anything but the check itself, such as another
      // app taking the system's media controls: an interrupted recording,
      // not the extension's sound.
      const playerEvents = await ask(span.page, 'its player events', () => window.playerEvents ?? []);
      const ignoredMediaActions = await ask(span.page, 'its media actions', () => window.ignoredMediaActions ?? []);
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
      if (wholeSpan && (!COMPACT || problems.length)) {
        const file = `${name}-whole.wav`;
        fs.writeFileSync(path.join(artifacts, file), encodeWav(left, right, sampleRate));
        excerpts.push({ file, label: 'the whole span', fromMs: 0, toMs: toMs(span.fromFrame + left.length) });
      }

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
        initialFrameLabel: end.recorder.initialFrameLabel ?? null,
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
        rateChanges: await ask(span.page, 'its speed changes', () => window.rateChanges ?? []),
        playerEvents,
        ignoredMediaActions,
        engineRequests: await ask(span.page, 'its engine requests', () => window.engineRequests ?? []),
        envelope10ms: envelope(left, right, sampleRate),
        snapshots: { start: span.start, end, settled }
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
        firstContextFrame: end.recorder.firstContextFrame,
        initialFrameLabel: end.recorder.initialFrameLabel ?? null
      });
      live.spans.delete(span);
      return problems;
    }

    // Problems that make a span invalid as a measurement: the recording,
    // the setup or something outside the check failed, so the span says
    // nothing about the sound either way.
    const NOT_SOUND = [
      ...RECORDER_PROBLEMS,
      'mark-out-of-step',
      'observer-error',
      'no-context',
      'sample-rate-mismatch',
      'not-stereo',
      'non-finite',
      'setup',
      'not-covered',
      'onset-not-observed',
      'not-overlapping',
      'interrupted'
    ];

    function assertClean(name, problems) {
      const invalid = problems.some((problem) => NOT_SOUND.includes(problem.code));
      assert.deepEqual(
        problems.map(({ code, message }) => `${code}: ${message}`),
        [],
        `${name}${invalid ? ': the recording is not valid data, so this is a measurement failure, not a sound result' : ''} ` +
          `(evidence in ${path.relative(root, artifacts)}/${name}.json)`
      );
    }

    // The page's own actions, as a site does them.
    const pageActions = {
      setRate: (page, rate) => ask(page, 'a change of speed', (rate) => { document.getElementById('player').playbackRate = rate; }, rate),
      pause: (page) => ask(page, 'a pause', () => document.getElementById('player').pause()),
      play: (page) => runPageStep(page, 'play'),
      rateChangesSince: (page, atMs) => ask(page, 'its speed changes', (atMs) => window.rateChanges.filter((change) => change.atMs >= atMs), atMs)
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
      await closePage(page);
      return problems;
    }

    // Turning the effect on while the song plays: the engine routes the
    // playing player into a new graph, and the recording starts with that
    // graph, so the whole change is heard. The span goes on until
    // FIRST_ENABLE_OBSERVE_MS after the effect turned on, through the 2 to
    // 4 s after it in which Firefox has clicked on its own (README.md in this
    // folder), and every frame of it is checked, so such a click fails the
    // check. The whole span's sound is kept.
    async function firstEnableCheck(site, name) {
      const page = await openSite(site, { playing: true });
      assert.equal(await ask(page, 'its contexts', () => window.__audioTrial.contextCount()), 0, 'an audio context existed before the effect turned on');
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
      // Counted on the recording, which starts with the context the effect
      // created.
      const recordedMs = (span.segments[0].to.recorderFrame / span.start.context.sampleRate) * 1000;
      await hold(span, `on, ${FIRST_ENABLE_OBSERVE_MS / 1000} s after turning it on`, effectExpect(EFFECT), {
        settleMs: Math.max(0, FIRST_ENABLE_OBSERVE_MS - HOLD_MS - recordedMs)
      });
      const problems = await finishSpan(span, { wholeSpan: true });
      await closePage(page);
      return problems;
    }

    // Changes of each kind while the song plays through the effect: reverb,
    // pan, speed, changes overlapping as when a slider is dragged, the pitch
    // mode, and turning the effect off and on.
    async function transitionsCheck(site, name) {
      const page = await openSite(site);
      const span = await beginSpan(page, name);
      let current = EFFECT;
      let heard = effectExpect(EFFECT);
      // A steady stretch after a change from what was `heard`. Where the
      // reverb still rings tones from before (ringingTones), the stretch is
      // checked twice: from SETTLE_MS after the change for everything else,
      // and from REVERB_TAIL_MS later for everything, those tones included.
      const settle = async (label, expect, settings) => {
        const ringing = ringingTones(heard, expect, settings);
        if (ringing.length) {
          await hold(span, label, withoutRinging(expect, ringing));
          await hold(span, `${label}: after the reverb tail`, expect, { settleMs: REVERB_TAIL_MS - HOLD_MS });
        } else {
          await hold(span, label, expect);
        }
        heard = expect;
      };
      const change = async (label, next) => {
        await act(span, label, settingsChange(target, current, next), () => applyThroughExtension(page, next, true));
        current = next;
        await settle(label, effectExpect(next), next);
      };
      await hold(span, 'on', effectExpect(EFFECT), { settleMs: 0 });
      await change('reverb 40', { ...current, reverb: 40 });
      await change('pan to the middle', { ...current, pan: 0 });
      await change('speed 0.9', { ...current, speed: 0.9 });

      // A dragged slider: requests paced to reach the engine SWEEP_STEP_MS
      // apart, without waiting for the answers, so each one reaches it
      // while the fade the one before started is still under way. The
      // engine's own log of what reached it, not the pacing, decides
      // whether they did.
      const sweep = [100, -100, 100, -100, 100, -100, 100, -100].map((pan) => ({ ...current, pan }));
      const requestsFrom = await ask(page, 'its clock', () => performance.now());
      const paced = await act(span, 'overlapping changes', NOTHING, () =>
        runSweep(page, {
          channel: CHANNEL,
          engineChannels: ENGINE_CHANNELS,
          requests: sweep.map((settings) => ({ settings, enabled: true })),
          stepMs: SWEEP_STEP_MS
        })
      );
      current = sweep[sweep.length - 1];
      const requests = await ask(page, 'its engine requests', (atMs) => window.engineRequests.filter((request) => request.atMs >= atMs), requestsFrom);
      const spacing = requests.slice(1).map((request, index) => Math.round((request.atMs - requests[index].atMs) * 10) / 10);
      const overlapping = spacing.filter((gap) => gap >= OVERLAP_MS[0] && gap < OVERLAP_MS[1]).length;
      span.actions[span.actions.length - 1].result = { spacingMs: spacing, overlapping, paced };
      if (paced.stopped) {
        span.checks.push({ code: 'setup', message: `the overlapping changes stopped: ${paced.stopped}` });
      } else if (requests.length !== sweep.length || requests[requests.length - 1].pan !== current.pan) {
        span.checks.push({ code: 'setup', message: `the engine got ${requests.length} requests, the last with pan ${requests[requests.length - 1]?.pan}` });
      } else if (overlapping < MIN_OVERLAPPING) {
        span.checks.push({
          code: 'not-overlapping',
          message: `only ${overlapping} requests reached the engine ${OVERLAP_MS[0]} to ${OVERLAP_MS[1]} ms after the one before (${spacing.join(', ')} ms apart; wanted ${MIN_OVERLAPPING})`
        });
      }
      await settle('after overlapping changes', effectExpect(current), current);

      await change('keep the pitch', { ...current, keepPitch: true });
      await change('pitch following again', { ...current, keepPitch: false });
      await act(span, 'turn off', settingsChange(target, current, { ...current, speed: 1 }), () => applyThroughExtension(page, current, false));
      await settle('off', dryExpect(), { ...current, reverb: 0 });
      await act(span, 'turn on', settingsChange(target, { ...current, speed: 1 }, current), () => applyThroughExtension(page, current, true));
      await settle('on again', effectExpect(current), current);
      const problems = await finishSpan(span);
      await closePage(page);
      return problems;
    }

    // Spotify sets its player back to normal speed every few seconds, holds
    // it at 0 while it seeks, and changes the song on the same player.
    async function spotifyResetsCheck(name) {
      const page = await openSite('spotify');
      const span = await beginSpan(page, name);
      await hold(span, 'on', effectExpect(EFFECT), { settleMs: 0 });

      const resetsFrom = await ask(page, 'its clock', () => performance.now());
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
        await ask(page, 'a listener for the request', () => {
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
        runPageStep(page, 'nextSong', { src: '/tone-b-long.wav' })
      );
      await hold(span, 'the next song', effectExpect(EFFECT, TONE_B));
      const contexts = await ask(page, 'its contexts', () => window.__audioTrial.contextCount());
      if (contexts !== 1) span.checks.push({ code: 'contexts', message: `${contexts} audio contexts, wanted 1` });
      const problems = await finishSpan(span);
      await closePage(page);
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
        // Out for longer than the engine waits before it looks at the page
        // again.
        await act(span, 'the page takes its player out and puts it back at 1.25x', ({ durationMs }) => ({ clicks: true, silenceMs: durationMs + DIP_MS }), () =>
          runPageStep(page, 'putBack', { rate: 1.25, waitMs: 400 })
        );
        await hold(span, 'put back at 1.25x', dryExpect(1.25));
      }
      if (remove) {
        const problems = await finishSpan(span);
        await closePage(page);
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
      await closePage(page);
      return problems;
    }

    // The version the page's engine reports, asked as its own scripts ask:
    // YouTube's engine gives it with its state, Spotify's when it's ready.
    // The second makes Spotify's bridge send its settings again, so this is
    // asked only after a recording.
    function reportedEngineVersion(page, site) {
      const [channel, type, reply] =
        site === 'spotify' ? ['SLOWED_REVERB_SPOTIFY', 'BRIDGE_READY', 'READY'] : ['SLOWED_REVERB_YOUTUBE', 'GET_STATE', 'STATE'];
      return ask(
        page,
        "the engine's version",
        ({ channel, type, reply }) =>
          new Promise((resolve) => {
            const done = (version) => {
              clearTimeout(timer);
              window.removeEventListener('message', listen);
              resolve(version);
            };
            const listen = (event) => {
              const data = event.data;
              if (event.source === window && data?.channel === channel && data.type === reply) done(data.version ?? null);
            };
            const timer = setTimeout(() => done(undefined), 2000);
            window.addEventListener('message', listen);
            window.postMessage({ channel, type, requestId: 'audio-suite-version' }, '*');
          }),
        { channel, type, reply }
      );
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
      const problems = await finishSpan(span);
      const version = await reportedEngineVersion(page, site);
      if (version !== VERSION) {
        problems.push({ code: 'old-engine-ran', message: `reloaded: the page's engine reports version ${JSON.stringify(version)}, not ${VERSION}` });
      }
      return problems;
    }

    // An update leaves the previous version's engine in the page. It turns
    // itself off, and has to stay off until the page is reloaded: on Spotify
    // in Firefox also after the extension is turned off and on, which puts
    // the new bridge next to it. Chromium puts no new Spotify scripts into
    // an open tab, so there the request finds nothing to answer it and is
    // refused as unsupported; elsewhere the new scripts refuse it as
    // outdated.
    async function updateCheck(site, name, newer) {
      await browser.useExtension(older.extensionDir);
      try {
        const page = await openSite(site);
        const span = await beginSpan(page, name);
        await hold(span, 'on, previous version', effectExpect(EFFECT), { settleMs: 0 });
        const off = { restores: true, silenceMs: settingsChange(target, EFFECT, { ...EFFECT, speed: 1 }).silenceMs ?? 0, windowMs: LIFECYCLE_WINDOW_MS };
        await act(span, 'update the extension', off, () => browser.update(newer.extensionDir));
        await hold(span, 'updated', dryExpect(), { settleMs: 1000 });
        if (site === 'spotify' && target === 'firefox') {
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
        const refusal = site === 'spotify' && target === 'chromium' ? 'unsupported' : 'outdated';
        const blocked = reply?.success === false && reply.blockReason === refusal;
        if (!blocked) {
          span.checks.push({ code: 'old-engine-ran', message: `the previous version's engine was used: ${JSON.stringify(reply)}` });
        }
        const problems = await finishSpan(span);
        problems.push(...(await afterReload(page, `${name}-reloaded`, site)));
        await closePage(page);
        return problems;
      } finally {
        await browser.useExtension(normal.extensionDir);
      }
    }

    // --- tests ---------------------------------------------------------------

    const sites = ['youtube', 'spotify'];

    for (const site of sites) {
      test(`speed, pitch and reverb as heard: ${site}`, async () => {
        const name = `steady-${site}`;
        assertClean(name, await guarded(name, () => steadyCheck(site, name)));
      });
    }
    for (const site of sites) {
      test(`turning the effect on while the song plays: ${site}`, async () => {
        const name = `first-enable-${site}`;
        assertClean(name, await guarded(name, () => firstEnableCheck(site, name)));
      });
    }
    for (const site of sites) {
      test(`changes while the song plays: ${site}`, async () => {
        const name = `transitions-${site}`;
        assertClean(name, await guarded(name, () => transitionsCheck(site, name)));
      });
    }
    test("Spotify's own speed resets, a seek and the next song", async () => {
      assertClean('spotify-resets', await guarded('spotify-resets', () => spotifyResetsCheck('spotify-resets')));
    });
    for (const site of sites) {
      test(`turning the extension off and on in the browser: ${site}`, async () => {
        const name = `lifecycle-${site}`;
        assertClean(name, await guarded(name, () => lifecycleCheck(site, name)));
      });
    }
    if (browser.canRemove) {
      for (const site of sites) {
        test(`removing the extension: ${site}`, async () => {
          const name = `removed-${site}`;
          try {
            assertClean(name, await guarded(name, () => lifecycleCheck(site, name, { remove: true })));
          } finally {
            await browser.useExtension(normal.extensionDir);
          }
        });
      }
    }
    for (const site of sites) {
      test(`an update keeps the previous engine off until a reload: ${site}`, async () => {
        const name = `update-${site}`;
        assertClean(name, await guarded(name, () => updateCheck(site, name, normal)));
      });
    }

    // The historical defects, each put back into a copy and caught by every
    // engine it was put back into, each on its own (controlVerdict in
    // history.js).
    const runCheck = {
      transitions: (id, site) => transitionsCheck(site, `${id}-${site}`),
      'overlapping changes': (id, site) => transitionsCheck(site, `${id}-${site}`),
      "Spotify's speed resets": (id) => spotifyResetsCheck(`${id}-spotify`),
      'a speed request during a waiting change': (id) => spotifyResetsCheck(`${id}-spotify`),
      'turning the extension off': (id, site) => lifecycleCheck(site, `${id}-${site}`),
      'an update': (id, site, copy) => updateCheck(site, `${id}-update`, copy)
    };

    for (const entry of HISTORY.filter((candidate) => candidate.browsers.includes(target))) {
      test(`control: ${entry.id} (${entry.kind}): ${entry.defect}`, async () => {
        const copy = prepareTrialExtension(path.join(tempRoot, `control-${entry.id}`), target, { mutations: entry.mutations });
        fs.writeFileSync(path.join(artifacts, `control-${entry.id}-copy.json`), `${JSON.stringify({ ...entry, copy }, null, 2)}\n`);
        const name = `control-${entry.id}`;
        const results = [];
        const runAll = async () => {
          for (const site of entry.sites) {
            results.push({ site, problems: await guarded(`${name}-${site}`, () => runCheck[entry.check](name, site, copy)) });
          }
        };
        if (entry.check === 'an update') {
          await runAll();
        } else {
          await browser.useExtension(copy.extensionDir);
          try {
            await runAll();
          } finally {
            await browser.useExtension(normal.extensionDir);
          }
        }
        summary.checks.push({
          name: `${name} result`,
          sites: results.map(({ site, problems }) => ({ site, codes: [...new Set(problems.map((problem) => problem.code))] }))
        });
        assert.deepEqual(controlVerdict(entry, results, NOT_SOUND), [], `${entry.id} wasn't caught as it should be`);
      });
    }
  });
}

module.exports = { defineRegression, dryExpect, effectExpect, ringingTones, withoutRinging };
