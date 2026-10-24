'use strict';

// A reproducer, with no extension involved, for where the recorder's first
// block falls (README.md in this folder, "How it records"). It plays two
// known ramps into an observed context, one in each channel, each sample one
// step of 2^-20 above the one before:
//
// - on the left, a ramp started as the context is created, before the
//   recorder runs, so every recorded sample, from the very first, has to be
//   one step above the one before it; a block missing or played twice moves
//   it by 128 steps;
// - on the right, a ramp started at a known context frame, on a block
//   boundary ahead of the clock, so its first sample has to be recorded at
//   that context frame by the recorder's own frame numbers (the mapping
//   marks use).
//
// Nothing is heard: the observer ends in a gain of 0, and Chromium runs
// with Playwright's default --mute-audio unless `unmuted` is given.
//
//   node e2e/audio-capture/recorder-first-block.js chromium|firefox [runs] [sample rate] [control] [unmuted]
//
// Without a sample rate the context uses the device's. A control, which
// should fail, changes one thing:
//   planted        the left ramp leaves out a block at 0.5 s and repeats one at 1 s;
//   clock-stopped  the recorder's native clock is never ramped;
//   clock-fast     it is ramped at twice the context's rate.
// It prints one JSON line per run. It isn't a test and passes or fails
// nothing. Set FIREFOX_BIN to use a Firefox other than the usual install.

const { launchFirefox } = require('../firefox-launch');
const { installAudioTrialObserver } = require('./capture-observer');
const { withDeadline } = require('./actions');
const { startTrialServer } = require('./fixture');
const { clickActivate, sleep, snapshot } = require('./harness');
const { decodeChannels } = require('./metrics');

const RAMP_FRAMES = 2 ** 20;
const STEP_MS = 15_000;
// How long the browser may take to start. Each browser's launcher ends a
// start that runs out of time itself: Playwright's timeout, and for
// Firefox e2e/firefox-launch.js, which also closes a browser that starts
// after all.
const LAUNCH_MS = 60_000;
const CONTROLS = ['none', 'planted', 'clock-stopped', 'clock-fast'];

function firefoxPath() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  if (process.platform === 'darwin') return '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (process.platform === 'win32') return 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
  return '/usr/bin/firefox';
}

async function launch(name, unmuted) {
  if (name === 'chromium') {
    const { chromium } = require('@playwright/test');
    const browser = await chromium.launch({ channel: 'chromium', headless: true, timeout: LAUNCH_MS, ...(unmuted ? { ignoreDefaultArgs: ['--mute-audio'] } : {}) });
    return {
      version: browser.version(),
      newPage: async (options) => {
        const page = await browser.newPage();
        await page.addInitScript(installAudioTrialObserver, options);
        return page;
      },
      close: () => browser.close()
    };
  }
  const puppeteer = require('puppeteer-core');
  const browser = await launchFirefox((options) => puppeteer.launch(options), { browser: 'firefox', executablePath: firefoxPath(), headless: true }, { deadline: LAUNCH_MS });
  const close = async () => {
    try {
      await withDeadline(browser.close(), STEP_MS, 'Firefox did not close');
    } catch (error) {
      browser.process()?.kill('SIGKILL');
      throw error;
    }
  };
  let version;
  try {
    version = await withDeadline(browser.version(), STEP_MS, 'Firefox gave no version');
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return {
    version,
    newPage: async (options) => {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(installAudioTrialObserver, options);
      return page;
    },
    close
  };
}

// In the page: the context, the two ramps and, for a control, its change.
function setUp({ sampleRate, control, rampFrames }) {
  if (control === 'clock-stopped' || control === 'clock-fast') {
    const ramp = AudioParam.prototype.linearRampToValueAtTime;
    AudioParam.prototype.linearRampToValueAtTime = function (value, time) {
      if (control === 'clock-stopped') return this;
      // The observer ramps to `value` over `value` seconds; this gets there
      // in half the time.
      return ramp.call(this, value, time - value / 2);
    };
  }
  const audio = sampleRate ? new AudioContext({ sampleRate }) : new AudioContext();
  const rate = audio.sampleRate;
  const buffer = (planted) => {
    const ramp = audio.createBuffer(1, rampFrames, rate);
    const data = ramp.getChannelData(0);
    for (let i = 0; i < rampFrames; i++) data[i] = (i + 1) / rampFrames;
    if (planted) {
      const missing = Math.round(rate * 0.5);
      const repeated = Math.round(rate * 1.0);
      for (let i = missing; i < rampFrames; i++) data[i] = Math.min(rampFrames, i + 129) / rampFrames;
      for (let i = repeated; i < rampFrames; i++) data[i] = Math.min(rampFrames, i + 1) / rampFrames;
    }
    return ramp;
  };
  const merger = new ChannelMergerNode(audio, { numberOfInputs: 2 });
  const running = new AudioBufferSourceNode(audio, { buffer: buffer(control === 'planted') });
  running.connect(merger, 0, 0);
  running.start();
  const timed = new AudioBufferSourceNode(audio, { buffer: buffer(false) });
  timed.connect(merger, 0, 1);
  // Reading `destination` enrolls the context and starts the recorder.
  merger.connect(audio.destination);
  window.firstBlockProbe = { audio, timed };
  return rate;
}

// Steps of each ramp from `from` on: where a sample isn't one step above the
// one before it.
function breaks(samples, from) {
  const found = [];
  for (let i = from + 1; i < samples.length; i++) {
    const step = Math.round(samples[i] * RAMP_FRAMES) - Math.round(samples[i - 1] * RAMP_FRAMES);
    if (step !== 1 && found.length < 8) found.push({ at: i, step });
  }
  return found;
}

async function run(browser, server, { sampleRate, control }) {
  const page = await browser.newPage({ workletUrl: server.workletPath, retainSeconds: 6 });
  try {
    const step = (promise, what) => withDeadline(promise, STEP_MS, what);
    await step(page.goto(server.youtubeUrl), 'the page did not load');
    await step(clickActivate(page), 'the page was not activated');
    const rate = await step(page.evaluate(setUp, { sampleRate, control, rampFrames: RAMP_FRAMES }), 'the graph was not set up');
    await step(page.evaluate(() => window.__audioTrial.waitReady(0, 10_000)), 'the recorder did not start');
    const startFrame = await step(
      page.evaluate(() => {
        const { audio, timed } = window.firstBlockProbe;
        const frame = Math.ceil(((audio.currentTime + 0.25) * audio.sampleRate) / 128) * 128;
        timed.start(frame / audio.sampleRate);
        return frame;
      }),
      'the timed ramp was not started'
    );
    await sleep(1600);
    const end = await step(snapshot(page), 'no snapshot');
    const read = await step(page.evaluate((to) => window.__audioTrial.read(0, 0, to), end.recorder.nextFrame), 'the recording was not read');
    await step(page.evaluate(() => window.firstBlockProbe.audio.close()), 'the context did not close');
    const [left, right] = decodeChannels(read);
    const recorder = end.recorder;
    const timedFrom = right.findIndex((value) => value > 0);
    return {
      control,
      sampleRate: rate,
      recordedFrames: left.length,
      firstContextFrame: recorder.firstContextFrame,
      initialFrameLabel: recorder.initialFrameLabel ?? null,
      contextFrameGaps: recorder.contextFrameGaps,
      skippedContextFrames: recorder.skippedContextFrames,
      offsetChanges: recorder.offsetChanges,
      lostFrames: recorder.lostFrames,
      staleRuns: recorder.staleRuns,
      frameLabelFaults: recorder.frameLabelFaults,
      faultLog: (recorder.faultLog ?? []).slice(0, 3),
      gapLog: (recorder.gapLog ?? []).slice(0, 3),
      // The left ramp: playing from the first recorded sample, and unbroken.
      leftFirst: Math.round(left[0] * RAMP_FRAMES),
      leftBreaks: breaks(left, 0),
      // The right ramp: its first sample where the recorder's numbers put
      // context frame `startFrame`, silent before, unbroken after.
      startFrame,
      timedFrom,
      timedFirst: timedFrom >= 0 ? Math.round(right[timedFrom] * RAMP_FRAMES) : null,
      mappingError: timedFrom >= 0 ? timedFrom + recorder.frameOffset - startFrame : null,
      timedBreaks: timedFrom >= 0 ? breaks(right, timedFrom) : null
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main([name, runsText, rateText, controlText = 'none', unmutedText]) {
  if (!['chromium', 'firefox'].includes(name) || !CONTROLS.includes(controlText)) {
    throw new Error(`usage: recorder-first-block.js chromium|firefox [runs] [sample rate] [${CONTROLS.join('|')}] [unmuted]`);
  }
  const runs = Math.max(1, Number(runsText) || 4);
  const sampleRate = Number(rateText) || null;
  const server = await startTrialServer();
  let browser = null;
  try {
    browser = await launch(name, unmutedText === 'unmuted');
    console.log(JSON.stringify({ browser: name, version: browser.version, muted: name === 'chromium' && unmutedText !== 'unmuted', sampleRate, control: controlText }));
    for (let index = 1; index <= runs; index++) {
      try {
        console.log(JSON.stringify({ run: index, ...(await run(browser, server, { sampleRate, control: controlText })) }));
      } catch (error) {
        console.log(JSON.stringify({ run: index, error: String(error?.message ?? error) }));
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
