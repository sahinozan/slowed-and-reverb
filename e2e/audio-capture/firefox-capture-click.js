'use strict';

// A reproducer, with no extension involved, for a click Firefox makes on
// its own (README.md in this folder): a player that is already playing is
// routed into an audio graph, its speed changes 60 ms later, and one click
// follows some seconds after. By default the player is routed a second
// after it starts, as when the effect is turned on during a song; with
// `playing` it is routed as it starts playing, as the Spotify engine does.
// Run it with
//   node e2e/audio-capture/firefox-capture-click.js [runs] [playing] [quiet] [seconds=6]
// It prints each run's clicks; it isn't a test and passes or fails nothing.
// Set FIREFOX_BIN to use a Firefox other than the usual install.
//
// The song is heard for that first second, before it is routed. With
// `quiet`, the player plays at volume 0 until it is routed and is turned up
// in the same step, so nothing is heard; that is a different condition from
// the one the suite meets, so its results are kept apart.
//
// For each click it also prints how far the tone moved across it, in
// samples: the left tone's frequency is fitted over the second before the
// click and its phase compared just before and just after. A sample dropped
// moves it by about -1 and one added by about +1; a gap that leaves the tone
// where it was, by about 0. The phase only gives the move to within the
// tone's period (136 samples at 352 Hz), so a whole block of 128 played
// twice or left out reads as about -8 or +8. It also
// prints how fast the context's clock and the player ran against the wall
// clock.

const puppeteer = require('puppeteer-core');

const { launchFirefox } = require('../firefox-launch');
const { withDeadline } = require('./actions');
const { installAudioTrialObserver } = require('./capture-observer');
const { startTrialServer } = require('./fixture');
const { clickStart, sleep, snapshot } = require('./harness');
const { decodeChannels, findClicks, spanHealth } = require('./metrics');

// Every step in the page or the browser, and the browser's own start and
// close, give up after these. A start that runs out of time is ended, and
// its browser closed if it starts after all (e2e/firefox-launch.js).
const STEP_MS = 15_000;
const LAUNCH_MS = 60_000;

function firefoxPath() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  if (process.platform === 'darwin') return '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (process.platform === 'win32') return 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
  return '/usr/bin/firefox';
}

// The phase, in radians, of a tone of `omega` radians per sample over
// samples[from, from + length), as at sample 0.
function phaseOf(samples, from, length, omega) {
  let re = 0;
  let im = 0;
  for (let n = from; n < from + length; n++) {
    re += samples[n] * Math.cos(omega * n);
    im -= samples[n] * Math.sin(omega * n);
  }
  return Math.atan2(im, re);
}

const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

// How far the tone in `samples` moved across the click at `frame`, in
// samples, with the tone's frequency (near `hz`) fitted over the second
// before it; null if there isn't a second of it.
function slipAt(samples, sampleRate, frame, hz) {
  const window = Math.round(sampleRate * 0.02);
  const fitFrom = frame - Math.round(sampleRate * 1.02);
  if (fitFrom < 0 || frame + 2 * window > samples.length) return null;
  let omega = (2 * Math.PI * hz) / sampleRate;
  // Two passes: the phase drift over the second gives the frequency.
  for (let pass = 0; pass < 2; pass++) {
    const steps = 10;
    const spacing = Math.floor((frame - window - fitFrom - window) / steps);
    let slope = 0;
    let previous = phaseOf(samples, fitFrom, window, omega);
    for (let k = 1; k <= steps; k++) {
      const next = phaseOf(samples, fitFrom + k * spacing, window, omega);
      slope += wrap(next - previous) / spacing;
      previous = next;
    }
    omega += slope / steps;
  }
  const before = phaseOf(samples, frame - window - 64, window, omega);
  const after = phaseOf(samples, frame + 64, window, omega);
  return {
    fittedHz: Math.round(((omega * sampleRate) / (2 * Math.PI)) * 1000) / 1000,
    samples: Math.round((-wrap(after - before) / omega) * 100) / 100
  };
}

async function main(runs, { atStart, quiet, seconds }) {
  const server = await startTrialServer();
  let browser = null;
  try {
    browser = await launchFirefox((options) => puppeteer.launch(options), { browser: 'firefox', executablePath: firefoxPath(), headless: true }, { deadline: LAUNCH_MS });
    console.log(`Firefox ${await withDeadline(browser.version(), STEP_MS, 'no version')}; routed ${atStart ? 'as it starts playing' : 'a second after it starts'}${quiet ? ', quiet until then' : ''}; ${seconds} s recorded`);
    for (let run = 1; run <= runs; run++) {
      const page = await withDeadline(browser.newPage(), STEP_MS, 'no new page');
      const step = (promise, what) => withDeadline(promise, STEP_MS, what);
      try {
        await step(page.evaluateOnNewDocument(installAudioTrialObserver, { workletUrl: server.workletPath, retainSeconds: seconds + 6 }), 'the observer was not installed');
        await step(page.goto(`${server.youtubeUrl}long`), 'the page did not load');
        if (quiet) await step(page.evaluate(() => { document.getElementById('player').volume = 0; }), 'the player was not turned down');
        // Routes the playing player into a graph, then slows it down.
        const route = (quiet) => {
          const context = new AudioContext();
          const player = document.getElementById('player');
          context.createMediaElementSource(player).connect(context.destination);
          if (quiet) player.volume = 1;
          setTimeout(() => {
            player.preservesPitch = false;
            player.playbackRate = 0.8;
          }, 60);
        };
        if (atStart) {
          await step(page.evaluate(`document.getElementById('player').addEventListener('playing', () => (${route})(${quiet}), { once: true })`), 'the routing was not set up');
          await step(clickStart(page), 'the player did not start');
        } else {
          await step(clickStart(page), 'the player did not start');
          await sleep(1000);
          await step(page.evaluate(route, quiet), 'the player was not routed');
        }
        await step(page.evaluate(() => window.__audioTrial.waitReady(0, 10_000)), 'the recorder did not start');
        const start = await step(snapshot(page), 'no first snapshot');
        await sleep(seconds * 1000);
        const end = await step(snapshot(page), 'no last snapshot');
        const read = await step(page.evaluate(({ from, to }) => window.__audioTrial.read(0, from, to), { from: 0, to: end.recorder.nextFrame }), 'the recording was not read');
        const channels = decodeChannels(read);
        const health = spanHealth(start, end, channels, 0).map(({ code }) => code);
        const wall = (end.wallMs - start.wallMs) / 1000;
        const rates = {
          context: Math.round(((end.context.currentTime - start.context.currentTime) / wall) * 1e5) / 1e5,
          player: Math.round(((end.media.clock - start.media.clock) / wall) * 1e5) / 1e5,
          outputLatency: end.context.outputLatency
        };
        const clicks = findClicks(...channels, read.sampleRate).map(({ frame, frames, peak, channel }) => ({
          ms: Math.round((frame / read.sampleRate) * 1000),
          peak,
          channel,
          frames,
          slip: slipAt(channels[0], read.sampleRate, frame, 352)
        }));
        console.log(JSON.stringify({ run, clicks, health, rates }));
      } catch (error) {
        console.log(JSON.stringify({ run, error: String(error?.message ?? error) }));
      } finally {
        await withDeadline(page.close(), STEP_MS, 'the page did not close').catch(() => {});
      }
    }
  } finally {
    if (browser) {
      try {
        await withDeadline(browser.close(), STEP_MS, 'Firefox did not close');
      } catch (error) {
        browser.process()?.kill('SIGKILL');
        console.error(String(error?.message ?? error));
      }
    }
    await server.close();
  }
}

const args = process.argv.slice(2);
const secondsArg = args.find((arg) => arg.startsWith('seconds='));
main(Math.max(1, Number(args[0]) || 5), {
  atStart: args.includes('playing'),
  quiet: args.includes('quiet'),
  seconds: Math.min(14, Math.max(1, Number(secondsArg?.split('=')[1]) || 6))
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
