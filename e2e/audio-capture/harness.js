'use strict';

// What both browser runners of the audio capture trial share (README.md in
// this folder): the disposable extension copy, driving the extension,
// recording windows of audio, the evidence files and the trial's checks.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { after, before, describe, test } = require('node:test');

const { prepareTestExtension } = require('../extension-copy');
const { installAudioTrialObserver } = require('./capture-observer');
const { TONE, encodeWav, startTrialServer } = require('./fixture');
const { captureProblems, decodeChannels, measureWindow } = require('./metrics');

const root = path.join(__dirname, '..', '..');
const ARTIFACT_ROOT = path.join(root, 'test-results', 'audio-trial');
const CHANNEL = 'SLOWED_REVERB_AUDIO_TRIAL';
const ENGINE_FILES = ['youtube-main.js', 'spotify-main.js', 'content.js', 'spotify-bridge.js', 'background.js'];

// Kept small and bounded: a few one-second windows per capture.
const WINDOWS = Math.min(10, Math.max(1, Number(process.env.AUDIO_TRIAL_WINDOWS) || 3));
const WINDOW_SECONDS = 1;
const SETTLE_MS = 750;
const READY_TIMEOUT_MS = 10_000;
const EXCERPT_SECONDS = 0.2;

// Slowed to 0.8 with the pitch following, and panned hard left. Only the
// effect's own path can pan, so a silent right channel with both tones on
// the left shows the sound came through the effect, not the unchanged path.
const ENGINE_SETTINGS = Object.freeze({
  speed: 0.8,
  reverb: 0,
  echo: 0,
  pan: -100,
  width: 100,
  keepPitch: false,
  saturation: 0,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0
});
const ENGINE_EXPECT = Object.freeze({
  media: { rate: ENGINE_SETTINGS.speed },
  channels: [
    {
      tones: [
        { hz: TONE.leftHz * ENGINE_SETTINGS.speed, min: 0.15, max: 0.4 },
        { hz: TONE.rightHz * ENGINE_SETTINGS.speed, min: 0.15, max: 0.4 }
      ]
    },
    { maxRms: 0.001 }
  ]
});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', timeout: 5_000 }).trim().slice(0, 4_000);
  } catch (error) {
    return `unavailable: ${String(error.message).split('\n')[0].slice(0, 300)}`;
  }
}

// What the sound server says, on Linux, where the trial expects a null sink.
function soundServer(command) {
  if (process.platform !== 'linux') return null;
  return run('pactl', command);
}

function versionLiteral(file) {
  return /const VERSION = '([^']*)';/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null;
}

function provenance(target) {
  const built = path.join(root, 'dist', target);
  return {
    commit: run('git', ['rev-parse', 'HEAD']),
    uncommittedChanges: run('git', ['status', '--porcelain', '--untracked-files=no']) !== '',
    node: process.version,
    os: { platform: process.platform, release: os.release(), arch: process.arch, version: os.version() },
    runnerImage: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion}` : null,
    engines: Object.fromEntries(
      ENGINE_FILES.map((file) => [
        file,
        {
          sourceSha256: sha256(path.join(root, 'extension', file)),
          builtSha256: sha256(path.join(built, file)),
          ...(file === 'background.js' ? {} : { version: versionLiteral(path.join(built, file)) })
        }
      ])
    ),
    manifestVersion: JSON.parse(fs.readFileSync(path.join(built, 'manifest.json'), 'utf8')).version,
    soundServer: soundServer(['info']),
    sinks: soundServer(['list', 'short', 'sinks']),
    settings: { windows: WINDOWS, windowSeconds: WINDOW_SECONDS, settleMs: SETTLE_MS, tone: TONE }
  };
}

function patchFile(dir, file, needle, replacement) {
  const filePath = path.join(dir, file);
  const source = fs.readFileSync(filePath, 'utf8');
  if (!source.includes(needle)) throw new Error(`audio trial patch no longer matches ${file}`);
  fs.writeFileSync(filePath, source.replace(needle, replacement));
}

// The disposable copy of the build the trial loads. On top of the browser
// tests' copy (127.0.0.1 stands in for YouTube), localhost stands in for
// Spotify, and a test driver lets the page ask the background script to
// turn the effect on with queueTabApply, the call the popup's APPLY_TO_TAB
// message makes. This skips the popup's own page and permission prompts;
// the background script, content scripts, registration and engines are the
// build's own. `breakYouTube` cuts the effect's output from the destination,
// as a deliberately broken engine for a control.
function prepareTrialExtension(tempRoot, target, { breakYouTube = false } = {}) {
  const extensionDir = prepareTestExtension(tempRoot, path.join(root, 'dist', target), target);
  const patches = ['extension-copy.js: 127.0.0.1 is a supported YouTube host'];

  patchFile(extensionDir, 'background.js', "const SPOTIFY_ORIGIN = 'https://open.spotify.com/*';", "const SPOTIFY_ORIGIN = 'http://localhost/*';");
  patchFile(
    extensionDir,
    'background.js',
    "return new URL(url).hostname === 'open.spotify.com';",
    "return new URL(url).hostname === 'localhost';"
  );
  patches.push('background.js: Spotify is localhost');
  fs.appendFileSync(
    path.join(extensionDir, 'background.js'),
    `
// Audio capture trial driver (disposable copy only).
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'AUDIO_TRIAL_APPLY' || sender.tab?.id === undefined) return;
  queueTabApply(sender.tab.id, sender.tab.url, normalizeSettings(message.settings), Boolean(message.enabled)).then(
    (result) => sendResponse({ result }),
    (error) => sendResponse({ error: String(error) })
  );
  return true;
});
`
  );
  fs.writeFileSync(
    path.join(extensionDir, 'audio-trial-driver.js'),
    `(() => {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.channel !== '${CHANNEL}' || event.data.type !== 'APPLY') return;
    const { id, enabled, settings } = event.data;
    api.runtime
      .sendMessage({ type: 'AUDIO_TRIAL_APPLY', enabled, settings })
      .then((reply) => reply ?? { error: 'no reply' }, (error) => ({ error: String(error) }))
      .then((reply) => window.postMessage({ channel: '${CHANNEL}', type: 'RESULT', id, reply: JSON.stringify(reply) }, '*'));
  });
})();
`
  );
  patches.push('background.js and audio-trial-driver.js: test driver');

  if (breakYouTube) {
    patchFile(extensionDir, 'youtube-main.js', '.connect(processed)\n        .connect(context.destination);', '.connect(processed);');
    patches.push("youtube-main.js: control, the effect's output is not connected");
  }

  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
  manifest.content_scripts = [
    {
      matches: ['http://127.0.0.1/*', 'http://localhost/*'],
      js: ['audio-trial-driver.js'],
      run_at: 'document_start'
    }
  ];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    extensionDir,
    patches,
    copySha256: Object.fromEntries(ENGINE_FILES.map((file) => [file, sha256(path.join(extensionDir, file))]))
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await sleep(50);
  }
}

// Asks the extension to apply settings to the page's tab, through the
// test driver and the background script.
async function applyThroughExtension(page, settings, enabled) {
  const reply = await page.evaluate(
    ({ channel, settings, enabled }) =>
      new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        window.addEventListener('message', function listener(event) {
          if (event.data?.channel !== channel || event.data.type !== 'RESULT' || event.data.id !== id) return;
          window.removeEventListener('message', listener);
          resolve(JSON.parse(event.data.reply));
        });
        window.postMessage({ channel, type: 'APPLY', id, settings, enabled }, '*');
      }),
    { channel: CHANNEL, settings, enabled }
  );
  assert.equal(reply.error, undefined, `applying settings failed: ${reply.error}`);
  return reply.result;
}

// Starts the player with a real click on Start.
async function clickStart(page) {
  await waitFor(
    () => page.evaluate(() => document.getElementById('player').readyState >= 3),
    10_000,
    'the tone never loaded'
  );
  await page.click('#start');
  const click = await waitFor(
    () => page.evaluate(() => window.startClicks.find((entry) => entry.button === 'start' && entry.play !== 'pending')),
    10_000,
    'the player never answered play()'
  );
  assert.equal(click.isTrusted, true, 'the Start click was not trusted');
  assert.equal(click.play, 'playing', `the player did not start: ${click.play}`);
  return click;
}

// A trusted click that plays nothing, so the page may start audio.
async function clickActivate(page) {
  await page.click('#activate');
  const click = await waitFor(
    () => page.evaluate(() => window.startClicks.find((entry) => entry.button === 'activate')),
    5_000,
    'the Activate click never arrived'
  );
  assert.equal(click.isTrusted, true, 'the Activate click was not trusted');
}

function snapshot(page, id = 0) {
  return page.evaluate((id) => window.__audioTrial.snapshot(id), id);
}

// Records `count` back-to-back windows from context `id` and measures each.
async function recordWindows(page, { id = 0, count = WINDOWS, seconds = WINDOW_SECONDS, tones, probe } = {}) {
  const windows = [];
  let start = await snapshot(page, id);
  for (let index = 0; index < count; index++) {
    await sleep(seconds * 1000);
    const end = await snapshot(page, id);
    const sinkInputs = probe && index === 0 ? soundServer(['list', 'short', 'sink-inputs']) : undefined;
    let read = null;
    let readError = null;
    if (end.recorder && end.recorder.nextFrame > start.recorder.nextFrame) {
      try {
        read = await page.evaluate(
          ({ id, from, to }) => window.__audioTrial.read(id, from, to),
          { id, from: start.recorder.nextFrame, to: end.recorder.nextFrame }
        );
      } catch (error) {
        readError = String(error.message);
      }
    }
    const measurement = measureWindow(start, end, read, { tones });
    if (readError) measurement.errors = [...measurement.errors, readError];
    windows.push({ measurement, read, start, end, sinkInputs });
    start = end;
  }
  return windows;
}

function toneList(expect) {
  return (expect.channels ?? [[], []]).map((channel) => (channel?.tones ?? []).map((tone) => tone.hz));
}

// Saves every window's numbers, problems and a short excerpt of its audio.
function saveWindows(dir, name, windows, expect, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  return windows.map(({ measurement, read, start, end, sinkInputs }, index) => {
    const problems = captureProblems(measurement, expect);
    const file = `${name}-w${index + 1}`;
    if (read) {
      const [left, right] = decodeChannels(read);
      const frames = Math.min(left.length, Math.round(EXCERPT_SECONDS * read.sampleRate));
      fs.writeFileSync(path.join(dir, `${file}.wav`), encodeWav(left.subarray(0, frames), right.subarray(0, frames), read.sampleRate));
    }
    const record = { name, window: index + 1, expect, problems, measurement, ...extra };
    if (sinkInputs !== undefined) record.sinkInputs = sinkInputs;
    record.snapshots = { start, end };
    fs.writeFileSync(path.join(dir, `${file}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return problems;
  });
}

function assertWindowsHealthy(dir, name, windows, expect, extra) {
  const problems = saveWindows(dir, name, windows, expect, extra);
  const failures = problems
    .map((list, index) => (list.length ? `window ${index + 1}: ${list.map((p) => `${p.code}: ${p.message}`).join('; ')}` : null))
    .filter(Boolean);
  assert.deepEqual(failures, [], `${name} is not a healthy capture (evidence in ${path.relative(root, dir)})`);
}

// For a control: every window must fail with each code in `codes`, and with
// none of `forbidden`.
function assertWindowsFail(dir, name, windows, expect, codes, forbidden = []) {
  const problems = saveWindows(dir, name, windows, expect);
  problems.forEach((list, index) => {
    const found = list.map((problem) => problem.code);
    for (const code of codes) {
      assert.ok(found.includes(code), `${name} window ${index + 1} should fail with ${code}; got ${JSON.stringify(list)}`);
    }
    for (const code of forbidden) {
      assert.ok(!found.includes(code), `${name} window ${index + 1} should not fail with ${code}; got ${JSON.stringify(list)}`);
    }
  });
  return problems;
}

// Problems that mean the clock or the recorder failed, not the signal.
const RECORDER_PROBLEMS = ['not-running', 'clock-stalled', 'no-frames', 'frames-stalled', 'frames-lost', 'recorder-error', 'recorder-not-ready', 'context-gap', 'frame-mismatch'];

function observerScript(server, overrides = {}) {
  return { workletUrl: server.workletPath, ...overrides };
}

// Native graphs with known signals, built in the trial page itself (no
// extension code involved), each connected to `destination`.
const nativeGraphs = {
  stereoTones: () => {
    const context = new AudioContext();
    const merger = context.createChannelMerger(2);
    for (const [channel, hz] of [[0, 440], [1, 660]]) {
      const oscillator = new OscillatorNode(context, { frequency: hz });
      oscillator.connect(new GainNode(context, { gain: 0.25 })).connect(merger, 0, channel);
      oscillator.start();
    }
    merger.connect(context.destination);
    window.trialNodes = { context, merger };
  },
  summedTones: () => {
    const context = new AudioContext();
    const branches = [[440, 0.2], [1000, 0.1]].map(([hz, gain]) => {
      const oscillator = new OscillatorNode(context, { frequency: hz });
      const level = new GainNode(context, { gain });
      oscillator.connect(level).connect(context.destination);
      oscillator.start();
      return level;
    });
    window.trialNodes = { context, branches };
  },
  mediaSource: () => {
    const context = new AudioContext();
    const source = context.createMediaElementSource(document.getElementById('player'));
    source.connect(context.destination);
    window.trialNodes = { context, source };
  }
};

const STEREO_EXPECT = {
  channels: [
    { tones: [{ hz: 440, min: 0.2, max: 0.3 }, { hz: 660, min: 0, max: 0.005 }] },
    { tones: [{ hz: 660, min: 0.2, max: 0.3 }, { hz: 440, min: 0, max: 0.005 }] }
  ]
};
const MEDIA_EXPECT = { ...STEREO_EXPECT, media: { rate: 1 } };

// The trial's checks for one browser. `browser` launches and drives it:
//   label, target ('chromium' or 'firefox')
//   start({ server, extensionDir, artifacts }) -> details for environment.json
//   newPage(url, observerOptions) -> page with evaluate(fn, arg), click(selector), reload(), close()
//   useExtension(extensionDir), stop()
// `full` false runs only the captures the --mute-audio comparison needs,
// and `compareWith` ({ label, results }, from an earlier defineTrial)
// compares their levels with that run's. Returns the measurements, filled in
// as the tests run.
function defineTrial(browser, { full = true, compareWith } = {}) {
  const artifacts = path.join(ARTIFACT_ROOT, browser.label);
  const results = {};
  let server;
  let tempRoot;
  let extension;

  describe(`audio capture trial: ${browser.label}`, { concurrency: 1 }, () => {
    before(async () => {
      fs.rmSync(artifacts, { recursive: true, force: true });
      fs.mkdirSync(artifacts, { recursive: true });
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-audio-trial-'));
      server = await startTrialServer();
      extension = prepareTrialExtension(path.join(tempRoot, 'normal'), browser.target);
      const environment = { label: browser.label, ...provenance(browser.target), extensionCopy: extension };
      // How busy the machine was as the browser started, to tell a slow
      // start from a failed one.
      environment.hostAtLaunch = { loadAverage: os.loadavg(), freeMemoryMb: Math.round(os.freemem() / 1e6), cpus: os.cpus().length };
      try {
        environment.browser = await browser.start({ server, extensionDir: extension.extensionDir, artifacts });
      } catch (error) {
        // Kept apart from audio problems: nothing was measured yet.
        environment.startupFailure = String(error?.message ?? error).slice(0, 2_000);
        throw new Error(`browser startup failed before any audio was measured: ${error?.message ?? error}`, { cause: error });
      } finally {
        fs.writeFileSync(path.join(artifacts, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);
      }
    });

    after(async () => {
      await browser.stop();
      await server?.close();
      if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    async function nativePage(graph, overrides) {
      const page = await browser.newPage(server.youtubeUrl, observerScript(server, overrides));
      await clickActivate(page);
      await page.evaluate(graph);
      return page;
    }

    test('observer: stereo tones keep their channels and level', async () => {
      const page = await nativePage(nativeGraphs.stereoTones);
      await page.evaluate((timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS);
      await sleep(SETTLE_MS);
      const windows = await recordWindows(page, { count: full ? 2 : WINDOWS, tones: toneList(STEREO_EXPECT), probe: true });
      results.stereoTones = windows.map(({ measurement }) => measurement);
      if (full) assertWindowsHealthy(artifacts, 'observer-stereo-tones', windows, STEREO_EXPECT);
      else saveWindows(artifacts, 'observer-stereo-tones', windows, STEREO_EXPECT);
      await page.close();
    });

    if (full) {
      test('observer: the browser sums connections and a disconnect removes one', async () => {
        const page = await nativePage(nativeGraphs.summedTones);
        await page.evaluate((timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS);
        await sleep(SETTLE_MS);
        // A mono connection plays in both channels (speakers mixing).
        const both = { tones: [{ hz: 440, min: 0.16, max: 0.24 }, { hz: 1000, min: 0.08, max: 0.12 }] };
        const summed = { channels: [both, both] };
        assertWindowsHealthy(artifacts, 'observer-summed', await recordWindows(page, { count: 1, tones: toneList(summed) }), summed);

        await page.evaluate(() => window.trialNodes.branches[1].disconnect());
        await sleep(200);
        const one = { tones: [{ hz: 440, min: 0.16, max: 0.24 }, { hz: 1000, min: 0, max: 0.005 }] };
        const single = { channels: [one, one] };
        assertWindowsHealthy(artifacts, 'observer-one-disconnected', await recordWindows(page, { count: 1, tones: toneList(single) }), single);

        // With nothing connected the recorder keeps running and records
        // silence, which must not pass for a healthy capture or look like a
        // recorder failure.
        await page.evaluate(() => window.trialNodes.branches[0].disconnect());
        await sleep(200);
        const problems = assertWindowsFail(
          artifacts,
          'control-all-disconnected',
          await recordWindows(page, { count: 1 }),
          {},
          ['no-signal'],
          RECORDER_PROBLEMS
        );
        results.disconnectedCodes = problems[0].map((problem) => problem.code);
        await page.close();
      });

      test('observer: an unmuted player through a native media source', async () => {
        const page = await browser.newPage(server.youtubeUrl, observerScript(server));
        await page.evaluate(nativeGraphs.mediaSource);
        await clickStart(page);
        await page.evaluate((timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS);
        await sleep(SETTLE_MS);
        assertWindowsHealthy(artifacts, 'observer-media', await recordWindows(page, { count: 2, tones: toneList(MEDIA_EXPECT) }), MEDIA_EXPECT);

        // A muted player never counts as a healthy capture, whatever the
        // browser does with a muted player's samples (which is recorded).
        await page.evaluate(() => { document.getElementById('player').muted = true; });
        await sleep(300);
        const windows = await recordWindows(page, { count: 1, tones: toneList(MEDIA_EXPECT) });
        assertWindowsFail(artifacts, 'control-muted-player', windows, MEDIA_EXPECT, ['media-muted'], RECORDER_PROBLEMS);
        results.mutedPlayerRms = windows[0].measurement.channels.map((channel) => channel.rms);
        await page.close();
      });

      test('control: a suspended clock fails the capture', async () => {
        const page = await nativePage(nativeGraphs.stereoTones);
        await page.evaluate((timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS);
        await page.evaluate(() => window.trialNodes.context.suspend());
        await sleep(200);
        const problems = assertWindowsFail(artifacts, 'control-suspended', await recordWindows(page, { count: 1 }), STEREO_EXPECT, ['not-running', 'clock-stalled', 'no-frames']);
        results.suspendedCodes = problems[0].map((problem) => problem.code);
        await page.close();
      });

      test('control: a recorder whose buffers run out fails the capture', async () => {
        const page = await nativePage(nativeGraphs.stereoTones);
        await page.evaluate((timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS);
        // The page stops handing buffers back, so the pool runs dry.
        await page.evaluate(() => window.__audioTrial.setRecycle(false));
        await sleep(1500);
        const problems = assertWindowsFail(artifacts, 'control-overflow', await recordWindows(page, { count: 1 }), STEREO_EXPECT, ['frames-lost']);
        results.overflowCodes = problems[0].map((problem) => problem.code);
        await page.close();
      });

      test('control: a recorder that cannot load fails explicitly', async () => {
        const page = await nativePage(nativeGraphs.stereoTones, { workletUrl: '/missing-recorder.js' });
        await assert.rejects(
          page.evaluate((timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS),
          /the recorder worklet did not load/
        );
        await page.close();
      });
    }

    async function engineCapture(url, expect = ENGINE_EXPECT) {
      const page = await browser.newPage(url, observerScript(server));
      let applied;
      if (url === server.spotifyUrl) {
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
        applied = await applyThroughExtension(page, ENGINE_SETTINGS, true);
        // The engine builds its graph once the song plays.
        await clickStart(page);
      } else {
        // The YouTube engine builds its graph as the effect turns on, so the
        // tone plays only through it, and silently, from the start.
        await waitFor(() => page.evaluate(() => document.getElementById('player').readyState >= 1), 10_000, 'no metadata');
        applied = await applyThroughExtension(page, ENGINE_SETTINGS, true);
        await clickStart(page);
      }
      await page.evaluate((timeout) => window.__audioTrial.waitReady(0, timeout), READY_TIMEOUT_MS);
      await sleep(SETTLE_MS);
      const windows = await recordWindows(page, { tones: toneList(expect), probe: true });
      const contexts = await page.evaluate(() => window.__audioTrial.contextCount());
      return { page, applied, windows, contexts };
    }

    test('YouTube engine output through the extension', async () => {
      const { page, applied, windows, contexts } = await engineCapture(server.youtubeUrl);
      results.youtube = windows.map(({ measurement }) => measurement);
      const extra = { applied, settings: ENGINE_SETTINGS, contexts };
      if (full) assertWindowsHealthy(artifacts, 'engine-youtube', windows, ENGINE_EXPECT, extra);
      else saveWindows(artifacts, 'engine-youtube', windows, ENGINE_EXPECT, extra);
      assert.equal(applied?.success, true, JSON.stringify(applied));
      assert.equal(contexts, 1);
      await page.close();
    });

    if (compareWith) {
      test(`compare: recorded levels against ${compareWith.label}`, (t) => {
        const picks = [
          ['stereoTones', 0, 440],
          ['stereoTones', 1, 660],
          ['youtube', 0, TONE.leftHz * ENGINE_SETTINGS.speed],
          ['youtube', 0, TONE.rightHz * ENGINE_SETTINGS.speed]
        ];
        const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const level = (list, channel, hz) =>
          median(list.map((m) => m.channels[channel].tones.find((tone) => tone.expectedHz === hz)?.amplitude ?? 0));
        // Levels only count where the clock and the recorder were sound.
        for (const key of ['stereoTones', 'youtube']) {
          for (const [label, list] of [[compareWith.label, compareWith.results[key]], [browser.label, results[key]]]) {
            assert.ok(list?.length, `${label} has no ${key} measurements to compare`);
            for (const m of list) {
              const codes = captureProblems(m, {}).map((problem) => problem.code).filter((code) => RECORDER_PROBLEMS.includes(code));
              assert.deepEqual(codes, [], `${label} ${key}: the clock or recorder failed, so levels can't be compared`);
            }
          }
        }
        const rows = picks.map(([key, channel, hz]) => {
          const reference = level(compareWith.results[key], channel, hz);
          const compared = level(results[key], channel, hz);
          return {
            capture: key,
            channel,
            hz,
            [compareWith.label]: reference,
            [browser.label]: compared,
            differenceDb: reference > 0 && compared > 0 ? Math.round(2000 * Math.log10(compared / reference)) / 100 : null
          };
        });
        const affected = rows.some((row) => row.differenceDb === null || Math.abs(row.differenceDb) > 1);
        const comparison = {
          reference: compareWith.label,
          compared: browser.label,
          rule: 'affected if any level is missing or differs by more than 1 dB',
          upstreamAffected: affected,
          rows
        };
        fs.writeFileSync(path.join(artifacts, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
        t.diagnostic(`recorded levels ${affected ? 'differ' : 'match'}: ${JSON.stringify(rows)}`);
      });
    }

    if (!full) return;

    test('Spotify engine output through the extension', async () => {
      const { page, applied, windows, contexts } = await engineCapture(server.spotifyUrl);
      results.spotify = windows.map(({ measurement }) => measurement);
      assertWindowsHealthy(artifacts, 'engine-spotify', windows, ENGINE_EXPECT, { applied, settings: ENGINE_SETTINGS, contexts });
      assert.equal(applied?.success, true, JSON.stringify(applied));
      assert.equal(contexts, 1);
      await page.close();
    });

    test("control: a YouTube engine with its effect's output cut fails the capture", async () => {
      const broken = prepareTrialExtension(path.join(tempRoot, 'broken'), browser.target, { breakYouTube: true });
      fs.writeFileSync(path.join(artifacts, 'control-broken-engine-copy.json'), `${JSON.stringify(broken, null, 2)}\n`);
      await browser.useExtension(broken.extensionDir);
      const { page, windows } = await engineCapture(server.youtubeUrl);
      assertWindowsFail(artifacts, 'control-broken-youtube-engine', windows, ENGINE_EXPECT, ['no-signal'], RECORDER_PROBLEMS);
      await page.close();
    });
  });
  return results;
}

module.exports = { ARTIFACT_ROOT, defineTrial, installAudioTrialObserver, root };
