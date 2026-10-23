'use strict';

// A reproducer, with no extension involved, for the stale frame numbers the
// recorder counts as `staleFrameLabels` (README.md in this folder). A steady
// 440 Hz tone plays to the destination while a silent branch is connected
// to it and disconnected every 37 ms. Chromium then sometimes gives the
// recorder a block with the previous block's frame number. For each such
// block this prints the frame number Chromium reported (raw) and the one the
// recorder took instead (expected), and the largest third difference of the
// recorded tone around it: a repeated or missing 128-frame block would jump
// the tone's phase by about 7 radians and click far above the suite's 0.05.
// To show that the measure would hear one, it then repeats one block, and
// drops another, in a copy of the same recording and measures again.
//
//   node e2e/audio-capture/chromium-stale-frame.js [runs]
//
// It isn't a test and passes or fails nothing.

const { chromium } = require('@playwright/test');

const { installAudioTrialObserver } = require('./capture-observer');
const { startTrialServer } = require('./fixture');
const { clickActivate, sleep, snapshot } = require('./harness');
const { CLICK_THRESHOLD, decodeChannels, findClicks } = require('./metrics');

const BLOCK = 128;

function peakAround(samples, index, reach = 256) {
  let peak = 0;
  for (let i = Math.max(3, index - reach); i < Math.min(samples.length, index + reach); i++) {
    peak = Math.max(peak, Math.abs(samples[i] - 3 * samples[i - 1] + 3 * samples[i - 2] - samples[i - 3]));
  }
  return Math.round(peak * 1e6) / 1e6;
}

async function main(runs) {
  const server = await startTrialServer();
  const browser = await chromium.launch({ channel: 'chromium', headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  try {
    console.log(`Chromium ${browser.version()}; click threshold ${CLICK_THRESHOLD}`);
    const context = await browser.newContext();
    for (let run = 1; run <= runs; run++) {
      const page = await context.newPage();
      await page.addInitScript(installAudioTrialObserver, { workletUrl: server.workletPath, retainSeconds: 14 });
      await page.goto(server.youtubeUrl);
      await clickActivate(page);
      await page.evaluate(() => {
        const audio = new AudioContext();
        const tone = new OscillatorNode(audio, { frequency: 440 });
        tone.connect(new GainNode(audio, { gain: 0.25 })).connect(audio.destination);
        tone.start();
        const silent = new GainNode(audio, { gain: 0 });
        const branch = new OscillatorNode(audio, { frequency: 660 });
        branch.connect(silent);
        branch.start();
        let connected = false;
        setInterval(() => {
          if (connected) silent.disconnect();
          else silent.connect(audio.destination);
          connected = !connected;
        }, 37);
        window.trialNodes = { audio };
      });
      await page.evaluate(() => window.__audioTrial.waitReady(0, 10_000));
      await sleep(300);
      const start = await snapshot(page);
      await sleep(10_000);
      const end = await snapshot(page);
      const read = await page.evaluate(({ from, to }) => window.__audioTrial.read(0, from, to), {
        from: start.recorder.nextFrame,
        to: end.recorder.nextFrame
      });
      const [left] = decodeChannels(read);
      const from = start.recorder.nextFrame;
      const recorder = end.recorder;
      console.log(
        `run ${run}: ${recorder.staleFrameLabels} stale labels, ${recorder.contextFrameGaps} skipped blocks, ` +
          `${recorder.offsetChanges} offset changes since the recorder started; ` +
          `${findClicks(left, left, read.sampleRate).length} clicks in the 10 s recorded`
      );
      for (const entry of (recorder.gapLog ?? []).filter((item) => item.recorderFrame >= from)) {
        const index = entry.recorderFrame - from;
        console.log(
          `  recorded frame ${entry.recorderFrame}: raw ${entry.contextFrame}, expected ${entry.expected}, ` +
            `${entry.stale ? 'taken as expected' : 'a skipped block'}; largest third difference around it ${peakAround(left, index)}`
        );
      }
      // The same recording with one block repeated, and one left out.
      const middle = Math.floor(left.length / BLOCK / 2) * BLOCK;
      const repeated = new Float32Array(left.length + BLOCK);
      repeated.set(left.subarray(0, middle));
      repeated.set(left.subarray(middle - BLOCK, middle), middle);
      repeated.set(left.subarray(middle), middle + BLOCK);
      const dropped = new Float32Array(left.length - BLOCK);
      dropped.set(left.subarray(0, middle));
      dropped.set(left.subarray(middle + BLOCK), middle);
      console.log(
        `  planted: a repeated block clicks at ${peakAround(repeated, middle)}, a missing one at ${peakAround(dropped, middle)}`
      );
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main(Math.max(1, Number(process.argv[2]) || 4)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
