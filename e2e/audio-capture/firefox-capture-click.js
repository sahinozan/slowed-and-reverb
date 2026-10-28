'use strict';

// A reproducer, with no extension involved, for a click Firefox makes on
// its own (README.md in this folder, "Limits"): a player that is already
// playing is routed into an audio graph, its speed changes 60 ms later, and
// one click follows some seconds after. Firefox puts one frame of silence
// into the song there, as it changes over from playing the player itself
// to feeding the graph. By default the player is routed a second after it
// starts, as when the effect is turned on during a song; with `playing` it
// is routed as it starts playing, as the Spotify engine does. Run it with
//   node e2e/audio-capture/firefox-capture-click.js [runs] [playing] [quiet] [seconds=6] [rate=0.8] [control] [save=<folder>]
// It prints each run's clicks; it isn't a test and passes or fails nothing.
// Set FIREFOX_BIN to use a Firefox other than the usual install. Firefox's
// own account of it is in its log: with
//   MOZ_LOG=timestamp,MediaDecoder:5,AudioSink:4 MOZ_LOG_FILE=<path>
// set, the content process's log has "Detect a gap in audio, insert
// silence=1" from DecodedStream at the time of the click.
//
// `rate=<speed>` is the speed set after routing (0.8 unless given);
// `rate=1` leaves the speed alone, and the frame of silence is then
// recorded as it is: one frame of exactly 0 in both channels.
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
// twice or left out reads as about -8 or +8. `sourceFrames` is that move
// in frames of the song itself (the move times the speed): Firefox's frame
// of silence reads as 1 at any speed (1.25 samples at 0.8). `zeroFrame` is
// where, from the click's first frame, a frame of exactly 0 in both channels
// follows one that isn't near 0, or null. It also prints how fast the
// context's clock and the player ran against the wall clock.
//
// `slips` doesn't depend on a click being found: it follows the tone's phase
// through the whole recording, 20 ms at a time from half a second in, and
// lists every place it moves by a quarter of a sample or more, so a frame of
// silence too quiet to count as a click still shows. `control` is the
// check that this works: the graph gets one frame of silence 4 seconds after
// the routing, with the song a frame late after it, as Firefox's own, and
// `controlMs` says where it went. A run with `control` has to show it in
// `slips`. `save=<folder>` writes each run's recording there, as a 32-bit
// float WAV, with what was printed for it.

const puppeteer = require('puppeteer-core');

const fs = require('fs');
const path = require('path');

const { launchFirefox } = require('../firefox-launch');
const { withDeadline } = require('./actions');
const { installAudioTrialObserver } = require('./capture-observer');
const { TONE, startTrialServer } = require('./fixture');
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

// phaseOf with a Hann window, so a window that doesn't hold a whole number
// of the tone's periods gives no ripple.
function hannPhaseOf(samples, from, length, omega) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < length; i++) {
    const n = from + i;
    const weight = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    re += weight * samples[n] * Math.cos(omega * n);
    im -= weight * samples[n] * Math.sin(omega * n);
  }
  return Math.atan2(im, re);
}

// Every place the tone's phase moves by `minSamples` or more, as
// { ms, samples }, from half a second in: the phase of each 20 ms is taken
// every 10 ms (with a Hann window) against the tone's frequency fitted over
// the whole span, and a
// move is the median of the 5 windows after a point against the 5 before
// it. Windows without the tone (a gap) are left out.
function slipsIn(samples, sampleRate, hz, minSamples = 0.25) {
  const window = Math.round(sampleRate * 0.02);
  const hop = Math.round(sampleRate * 0.01);
  const omega0 = (2 * Math.PI * hz) / sampleRate;
  const points = [];
  for (let from = Math.round(sampleRate * 0.5); from + window <= samples.length; from += hop) {
    let energy = 0;
    for (let n = from; n < from + window; n++) energy += samples[n] * samples[n];
    if (Math.sqrt(energy / window) < 0.05) continue;
    points.push({ from, phase: hannPhaseOf(samples, from, window, omega0) });
  }
  if (points.length < 12) return [];
  // The drift of the phase from window to window gives the frequency's
  // offset from `hz`; the median ignores the windows across a move.
  const slopes = [];
  for (let k = 1; k < points.length; k++) {
    slopes.push(wrap(points[k].phase - points[k - 1].phase) / (points[k].from - points[k - 1].from));
  }
  const slope = slopes.sort((a, b) => a - b)[Math.floor(slopes.length / 2)];
  const omega = omega0 - slope;
  let unwrapped = 0;
  const residual = points.map((point, k) => {
    if (k > 0) unwrapped += wrap(point.phase - points[k - 1].phase - slope * (point.from - points[k - 1].from));
    return { from: point.from, value: unwrapped };
  });
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const moves = [];
  for (let k = 5; k + 5 <= residual.length; k++) {
    const before = median(residual.slice(k - 5, k).map(({ value }) => value));
    const after = median(residual.slice(k, k + 5).map(({ value }) => value));
    const moved = -(after - before) / omega;
    if (Math.abs(moved) >= minSamples) moves.push({ k, frame: residual[k].from, samples: moved });
  }
  // Neighboring windows see the same move; the largest of each run is kept.
  const slips = [];
  for (const move of moves) {
    const last = slips.at(-1);
    if (last && move.k - last.k <= 5) {
      if (Math.abs(move.samples) > Math.abs(last.samples)) Object.assign(last, move);
      continue;
    }
    slips.push({ ...move });
  }
  return slips.map(({ frame, samples }) => ({
    ms: Math.round((frame / sampleRate) * 1000),
    samples: Math.round(samples * 100) / 100
  }));
}

// A stereo 32-bit float WAV, so the recording is kept exactly.
function floatWav([left, right], sampleRate) {
  const frames = left.length;
  const wav = Buffer.alloc(44 + frames * 8);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + frames * 8, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 8, 28);
  wav.writeUInt16LE(8, 32);
  wav.writeUInt16LE(32, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 8, 40);
  for (let i = 0; i < frames; i++) {
    wav.writeFloatLE(left[i], 44 + i * 8);
    wav.writeFloatLE(right[i], 48 + i * 8);
  }
  return wav;
}

// The control's worklet: from context frame `at` on, the song comes one
// frame late, with a frame of exactly 0 in its place, as Firefox's own
// frame of silence.
const GAP_PROCESSOR = `registerProcessor('one-frame-gap', class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.at = options.processorOptions.at;
    this.previous = [0, 0];
  }
  process([input], [output]) {
    for (let channel = 0; channel < output.length; channel++) {
      const from = input[channel] ?? input[0];
      const to = output[channel];
      for (let k = 0; k < to.length; k++) {
        const value = from ? from[k] : 0;
        const frame = currentFrame + k;
        if (frame < this.at) to[k] = value;
        else {
          to[k] = frame === this.at ? 0 : this.previous[channel];
          this.previous[channel] = value;
        }
      }
    }
    return true;
  }
});`;

// Where, from `frame`, a frame within two of it is exactly 0 in both
// channels after one that isn't near 0; null if none is.
function zeroFrameAt([left, right], frame) {
  for (let k = Math.max(1, frame - 2); k <= frame + 2 && k < left.length; k++) {
    if (left[k] === 0 && right[k] === 0 && Math.abs(left[k - 1]) + Math.abs(right[k - 1]) > 0.02) return k - frame;
  }
  return null;
}

async function main(runs, { atStart, quiet, seconds, rate, control, save }) {
  if (save) fs.mkdirSync(save, { recursive: true });
  const server = await startTrialServer();
  let browser = null;
  try {
    browser = await launchFirefox((options) => puppeteer.launch(options), { browser: 'firefox', executablePath: firefoxPath(), headless: true }, { deadline: LAUNCH_MS });
    console.log(`Firefox ${await withDeadline(browser.version(), STEP_MS, 'no version')}; routed ${atStart ? 'as it starts playing' : 'a second after it starts'}${quiet ? ', quiet until then' : ''}; ${rate === 1 ? 'speed left at 1' : `speed ${rate}`}; ${seconds} s recorded${control ? '; with the control' : ''}`);
    for (let run = 1; run <= runs; run++) {
      const page = await withDeadline(browser.newPage(), STEP_MS, 'no new page');
      const step = (promise, what) => withDeadline(promise, STEP_MS, what);
      try {
        await step(page.evaluateOnNewDocument(installAudioTrialObserver, { workletUrl: server.workletPath, retainSeconds: seconds + 6 }), 'the observer was not installed');
        await step(page.goto(`${server.youtubeUrl}long`), 'the page did not load');
        if (quiet) await step(page.evaluate(() => { document.getElementById('player').volume = 0; }), 'the player was not turned down');
        // Routes the playing player into a graph, then changes its speed.
        // With the control, the graph's one-frame gap goes in first: its
        // module loads before the player is routed, so the routing itself
        // happens as without it. Returns the context frame of the gap.
        const route = async (quiet, rate, gapProcessor) => {
          const context = new AudioContext();
          const player = document.getElementById('player');
          let into = context.destination;
          let at = null;
          if (gapProcessor) {
            const url = URL.createObjectURL(new Blob([gapProcessor], { type: 'text/javascript' }));
            await context.audioWorklet.addModule(url);
            at = Math.round((context.currentTime + 4) * context.sampleRate);
            into = new AudioWorkletNode(context, 'one-frame-gap', {
              outputChannelCount: [2],
              channelCount: 2,
              channelCountMode: 'explicit',
              processorOptions: { at }
            });
            into.connect(context.destination);
          }
          context.createMediaElementSource(player).connect(into);
          if (quiet) player.volume = 1;
          if (rate !== 1) {
            setTimeout(() => {
              player.preservesPitch = false;
              player.playbackRate = rate;
            }, 60);
          }
          return at;
        };
        const gap = control ? GAP_PROCESSOR : null;
        let gapAt = null;
        if (atStart) {
          await step(
            page.evaluate(
              (source, quiet, rate, gap) => {
                const route = new Function(`return (${source})`)();
                window.__gapAt = null;
                document.getElementById('player').addEventListener('playing', async () => (window.__gapAt = await route(quiet, rate, gap)), { once: true });
              },
              route.toString(),
              quiet,
              rate,
              gap
            ),
            'the routing was not set up'
          );
          await step(clickStart(page), 'the player did not start');
        } else {
          await step(clickStart(page), 'the player did not start');
          await sleep(1000);
          gapAt = await step(page.evaluate(route, quiet, rate, gap), 'the player was not routed');
        }
        await step(page.evaluate(() => window.__audioTrial.waitReady(0, 10_000)), 'the recorder did not start');
        const start = await step(snapshot(page), 'no first snapshot');
        await sleep(seconds * 1000);
        const end = await step(snapshot(page), 'no last snapshot');
        if (atStart && control) gapAt = await step(page.evaluate(() => window.__gapAt), 'no gap frame');
        const read = await step(page.evaluate(({ from, to }) => window.__audioTrial.read(0, from, to), { from: 0, to: end.recorder.nextFrame }), 'the recording was not read');
        const channels = decodeChannels(read);
        const health = spanHealth(start, end, channels, 0).map(({ code }) => code);
        const wall = (end.wallMs - start.wallMs) / 1000;
        const rates = {
          context: Math.round(((end.context.currentTime - start.context.currentTime) / wall) * 1e5) / 1e5,
          player: Math.round(((end.media.clock - start.media.clock) / wall) * 1e5) / 1e5,
          outputLatency: end.context.outputLatency
        };
        const clicks = findClicks(...channels, read.sampleRate).map(({ frame, frames, peak, channel }) => {
          const slip = slipAt(channels[0], read.sampleRate, frame, TONE.leftHz * rate);
          return {
            ms: Math.round((frame / read.sampleRate) * 1000),
            peak,
            channel,
            frames,
            slip: slip && { ...slip, sourceFrames: Math.round(slip.samples * rate * 100) / 100 },
            zeroFrame: zeroFrameAt(channels, frame)
          };
        });
        let controlMs;
        if (gapAt !== null) {
          // A mark maps the context's frames to the recording's.
          const mark = await step(page.evaluate(() => window.__audioTrial.mark(0, 'control')), 'no mark');
          controlMs = Math.round(((gapAt - (mark.contextFrame - mark.recorderFrame)) / read.sampleRate) * 1000);
        }
        const slips = slipsIn(channels[0], read.sampleRate, TONE.leftHz * rate);
        const result = { run, clicks, slips, controlMs, health, rates };
        console.log(JSON.stringify(result));
        if (save) {
          fs.writeFileSync(path.join(save, `run-${run}.wav`), floatWav(channels, read.sampleRate));
          fs.writeFileSync(path.join(save, `run-${run}.json`), `${JSON.stringify(result, null, 2)}\n`);
        }
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

if (require.main === module) {
  const args = process.argv.slice(2);
  const secondsArg = args.find((arg) => arg.startsWith('seconds='));
  const rateArg = args.find((arg) => arg.startsWith('rate='));
  main(Math.max(1, Number(args[0]) || 5), {
    atStart: args.includes('playing'),
    quiet: args.includes('quiet'),
    seconds: Math.min(14, Math.max(1, Number(secondsArg?.split('=')[1]) || 6)),
    rate: Math.min(2, Math.max(0.5, Number(rateArg?.split('=')[1]) || 0.8)),
    control: args.includes('control'),
    save: args.find((arg) => arg.startsWith('save='))?.slice(5) || null
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { slipsIn };
