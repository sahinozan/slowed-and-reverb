'use strict';

// A reproducer, with no extension involved, for a click Firefox makes on
// its own (README.md in this folder): a player that is already playing is
// routed into an audio graph, its speed changes 60 ms later, and one click
// follows some seconds after. Run it with
//   node e2e/audio-capture/firefox-capture-click.js [runs]
// It prints each run's clicks; it isn't a test and passes or fails nothing.
// Set FIREFOX_BIN to use a Firefox other than the usual install.

const puppeteer = require('puppeteer-core');

const { installAudioTrialObserver } = require('./capture-observer');
const { startTrialServer } = require('./fixture');
const { clickStart, sleep, snapshot } = require('./harness');
const { decodeChannels, findClicks, spanHealth } = require('./metrics');

function firefoxPath() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  if (process.platform === 'darwin') return '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (process.platform === 'win32') return 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
  return '/usr/bin/firefox';
}

async function main(runs) {
  const server = await startTrialServer();
  const browser = await puppeteer.launch({ browser: 'firefox', executablePath: firefoxPath(), headless: true });
  try {
    console.log(`Firefox ${await browser.version()}`);
    for (let run = 1; run <= runs; run++) {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(installAudioTrialObserver, { workletUrl: server.workletPath, retainSeconds: 12 });
      await page.goto(`${server.youtubeUrl}long`);
      await clickStart(page);
      await sleep(1000);
      // Routes the playing player into a graph, then slows it down.
      await page.evaluate(() => {
        const context = new AudioContext();
        const player = document.getElementById('player');
        context.createMediaElementSource(player).connect(context.destination);
        setTimeout(() => {
          player.preservesPitch = false;
          player.playbackRate = 0.8;
        }, 60);
      });
      await page.evaluate(() => window.__audioTrial.waitReady(0, 10_000));
      const start = await snapshot(page);
      await sleep(6000);
      const end = await snapshot(page);
      const read = await page.evaluate(({ from, to }) => window.__audioTrial.read(0, from, to), { from: 0, to: end.recorder.nextFrame });
      const channels = decodeChannels(read);
      const health = spanHealth(start, end, channels, 0).map(({ code }) => code);
      const clicks = findClicks(...channels, read.sampleRate).map(
        ({ frame, peak }) => `${peak} at ${Math.round((frame / read.sampleRate) * 1000)} ms`
      );
      console.log(`run ${run}: ${clicks.length ? clicks.join(', ') : 'no click'}${health.length ? ` (recording problems: ${health.join(', ')})` : ''}`);
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main(Math.max(1, Number(process.argv[2]) || 5)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
