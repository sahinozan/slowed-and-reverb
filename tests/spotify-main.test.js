'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const { describe, test } = require('node:test');
const { JSDOM } = require('jsdom');

const { FakeAudioContext } = require('./helpers/content-harness');
const { root } = require('./helpers/load-script');

const SETTINGS = {
  speed: 0.75,
  reverb: 50,
  echo: 40,
  pan: -25,
  width: 150,
  keepPitch: true,
  saturation: 30,
  eqLow: 2,
  eqMid: -3,
  eqHigh: 4
};

// A change of pitch mode reaches the player 40 ms after the change arrives,
// once the output has faded out (see spotify-main.js). Then a second passes
// on the audio clock, unless the test keeps it still, so the fades complete.
function settle(advance = 1) {
  return new Promise((resolve) =>
    setTimeout(() => {
      FakeAudioContext.advance(advance);
      resolve();
    }, 60)
  );
}

// Where each recorded change of a setting was heading, and when it got there.
function ramps(param) {
  return param.ramps.map(({ to, endTime }) => ({ to, endTime: Math.round(endTime * 1000) / 1000 }));
}

// The biggest change between two milliseconds: a fade moves a little each
// millisecond, a jump all at once.
function largestStep(param, from, to) {
  let largest = 0;
  for (let time = from; time < to; time += 0.001) {
    largest = Math.max(largest, Math.abs(param.valueAt(time + 0.001) - param.valueAt(time)));
  }
  return largest;
}

function setup(options = {}) {
  FakeAudioContext.instances = [];
  FakeAudioContext.mediaSourceError = options.mediaSourceError ?? null;
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://open.spotify.com/',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  if (options.userAgent) {
    Object.defineProperty(window.navigator, 'userAgent', { value: options.userAgent });
  }
  const warnings = [];
  const statusMessages = [];
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;
  window.console.warn = (...args) => warnings.push(args);
  window.postMessage = (message) => statusMessages.push(message);
  window.eval(fs.readFileSync(`${root}/extension/spotify-main.js`, 'utf8'));

  const media = window.document.createElement('audio');
  Object.defineProperties(media, {
    duration: { configurable: true, value: 300 },
    mediaKeys: { configurable: true, value: options.mediaKeys ?? {} },
    readyState: { configurable: true, value: 2 }
  });
  media.playbackRate = 1;
  // jsdom has no default; browsers keep the original pitch unless told not to.
  media.preservesPitch = true;

  function apply(enabled, settings = SETTINGS) {
    window.dispatchEvent(
      new window.MessageEvent('message', {
        source: window,
        data: { channel: 'SLOWED_REVERB_SPOTIFY', type: 'APPLY', enabled, settings }
      })
    );
  }

  return { apply, dom, media, statusMessages, warnings, window };
}

const FIREFOX_USER_AGENT = 'Mozilla/5.0 (Macintosh; rv:158.0) Gecko/20100101 Firefox/158.0';

// The gains that reach the speakers: the unchanged path, then the effect.
function outputGains(context) {
  return context.gains.filter((node) =>
    node.connections.some(({ target }) => target === context.destination)
  );
}

describe('Spotify main-world audio engine', () => {
  test('captures dynamically created protected media and applies the full graph', async () => {
    const harness = setup();
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    await settle();

    const context = FakeAudioContext.instances[0];
    assert.equal(context.sources.length, 1);
    assert.equal(context.sources[0].media, harness.media);
    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(harness.media.preservesPitch, true);
    assert.deepEqual(
      context.filters.map(({ gain }) => gain.value),
      [SETTINGS.eqLow, SETTINGS.eqMid, SETTINGS.eqHigh]
    );
    assert.equal(context.gains[2].gain.value, 0.35);
    assert.equal(context.gains[3].gain.value, 0.2);
    assert.equal(context.gains[4].gain.value, 0.18);
    assert.equal(context.panners[0].pan.value, -0.25);
    assert.equal(
      harness.statusMessages.filter(({ type }) => type === 'STATUS').at(-1).processingActive,
      true
    );

    harness.dom.window.close();
  });

  test('keeps the graph attached and returns it to bypass when disabled', async () => {
    const harness = setup();
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    harness.apply(false);
    await settle();

    const context = FakeAudioContext.instances[0];
    assert.equal(context.sources.length, 1);
    assert.equal(harness.media.playbackRate, 1);
    const destinationGains = context.gains.filter((node) =>
      node.connections.some(({ target }) => target === context.destination)
    );
    assert.deepEqual(destinationGains.map(({ gain }) => gain.value), [1, 0]);

    harness.dom.window.close();
  });

  test('stays silent while the player changes its pitch mode', async () => {
    const harness = setup();
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    const context = FakeAudioContext.instances[0];
    const [bypass, processed] = context.gains.filter((node) =>
      node.connections.some(({ target }) => target === context.destination)
    );

    harness.apply(false);
    // Until the output has faded out, the player keeps its pitch mode.
    assert.equal(harness.media.preservesPitch, true);
    await settle();

    assert.equal(harness.media.preservesPitch, false);
    // Both fade out over 10 ms, stay silent 80 ms, then fade to their new level.
    assert.deepEqual(ramps(bypass.gain).slice(-2), [
      { to: 0, endTime: 0.03 },
      { to: 1, endTime: 0.105 }
    ]);
    assert.deepEqual(ramps(processed.gain).slice(-2), [
      { to: 0, endTime: 0.03 },
      { to: 0, endTime: 0.105 }
    ]);

    // A change of settings alone fades without the silence.
    context.currentTime = 1;
    harness.apply(true, { ...SETTINGS, reverb: 0, keepPitch: false });
    assert.deepEqual(ramps(processed.gain).at(-1), { to: 1, endTime: 1.045 });
    assert.deepEqual(ramps(context.gains[2].gain).at(-1), { to: 0, endTime: 1.045 });

    harness.dom.window.close();
  });


  test('carries on from a change still under way without jumping', async () => {
    const harness = setup();
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    await settle();
    const context = FakeAudioContext.instances[0];
    const wet = context.gains[2].gain;

    harness.apply(true, { ...SETTINGS, reverb: 100 });
    context.currentTime = 1.03;
    harness.apply(true, { ...SETTINGS, reverb: 0 });

    assert.equal(wet.valueAt(1.05), 0.7);
    assert.equal(wet.valueAt(1.2), 0);
    assert.ok(largestStep(wet, 1, 1.2) < 0.05);

    harness.dom.window.close();
  });

  test('keeps the silence an earlier change needs when a later one is taken back', async () => {
    const harness = setup();
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    await settle();
    const context = FakeAudioContext.instances[0];
    const processed = context.gains.filter((node) =>
      node.connections.some(({ target }) => target === context.destination)
    )[1];

    // The player changes its pitch mode at 1.00 s, so its click needs
    // silence until 1.08 s.
    harness.apply(true, { ...SETTINGS, keepPitch: false });
    await settle(0);
    // Another change is asked for, then taken back before it happens.
    harness.apply(true, { ...SETTINGS, keepPitch: true });
    harness.apply(true, { ...SETTINGS, keepPitch: false });
    await settle(0);

    assert.equal(harness.media.preservesPitch, false);
    assert.equal(processed.gain.valueAt(1.07), 0);
    assert.equal(processed.gain.valueAt(1.2), 1);

    harness.dom.window.close();
  });

  // Spotify sets its player back to normal speed every few seconds, and to 0
  // while it seeks. Firefox clicks at any change of speed, and putting the
  // speed back afterward needed a silent gap, heard as a skip.
  test('keeps the effect speed through Spotify setting the player to normal speed', async () => {
    const harness = setup({ userAgent: FIREFOX_USER_AGENT });
    harness.apply(true, { ...SETTINGS, keepPitch: false });
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    await settle();
    const context = FakeAudioContext.instances[0];
    const processed = outputGains(context)[1];
    let rateChanges = 0;
    harness.media.addEventListener('ratechange', () => rateChanges++);

    context.currentTime = 2;
    harness.media.playbackRate = 1;
    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    await settle(0);

    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(rateChanges, 0);
    for (const time of [2.02, 2.05, 2.1, 2.2]) assert.equal(processed.gain.valueAt(time), 1);

    harness.dom.window.close();
  });

  test('lets Spotify hold the player at 0 while it seeks, then keeps the effect speed', async () => {
    const harness = setup({ userAgent: FIREFOX_USER_AGENT });
    harness.apply(true, { ...SETTINGS, keepPitch: false });
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    await settle();
    const context = FakeAudioContext.instances[0];
    const processed = outputGains(context)[1];

    context.currentTime = 2;
    harness.media.playbackRate = 0;
    await settle(0);
    assert.equal(harness.media.playbackRate, 0);

    context.currentTime = 3;
    harness.media.playbackRate = 1;
    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    await settle(0);
    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    for (const time of [3.02, 3.05, 3.1, 3.2]) assert.equal(processed.gain.valueAt(time), 1);

    harness.dom.window.close();
  });

  // A change of pitch mode waits 40 ms for the output to fade out. Spotify's
  // requests in that time must reach the player when the change happens.
  test('resumes at the speed Spotify asks for during a change still waiting', async () => {
    const harness = setup();
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    await settle();
    // Spotify holds the player at 0 while it seeks, and the engine has seen it.
    harness.media.playbackRate = 0;
    await settle();
    assert.equal(harness.media.playbackRate, 0);

    // Turning the effect off changes the pitch mode, which waits; Spotify
    // asks for normal speed in the meantime.
    harness.apply(false);
    harness.media.playbackRate = 1;
    await settle();

    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);

    harness.dom.window.close();
  });

  test('keeps Spotify holding the player at 0 during a change still waiting', async () => {
    const harness = setup();
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    await settle();

    harness.apply(true, { ...SETTINGS, keepPitch: false });
    harness.media.playbackRate = 0;
    await settle();

    assert.equal(harness.media.playbackRate, 0);
    assert.equal(harness.media.preservesPitch, false);

    harness.media.playbackRate = 1;
    await settle();
    assert.equal(harness.media.playbackRate, SETTINGS.speed);

    harness.dom.window.close();
  });

  test('leaves the speed Spotify sets alone while the effect is off', async () => {
    const harness = setup({ userAgent: FIREFOX_USER_AGENT });
    harness.apply(true, { ...SETTINGS, keepPitch: false });
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    await settle();
    harness.apply(false);
    await settle();
    assert.equal(harness.media.playbackRate, 1);

    harness.media.playbackRate = 1.25;
    await settle();
    assert.equal(harness.media.playbackRate, 1.25);

    harness.dom.window.close();
  });

  test('keeps Spotify speed available when its Web Audio source fails', () => {
    const error = new Error('protected output unavailable');
    const harness = setup({ mediaSourceError: error });
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));

    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(harness.warnings.length, 1);

    harness.dom.window.close();
  });

  test('does not touch restored Spotify state until encrypted playback has started', () => {
    const harness = setup();
    harness.apply(true);

    assert.equal(FakeAudioContext.instances.length, 0);
    assert.equal(harness.media.playbackRate, 1);

    harness.media.dispatchEvent(new harness.window.Event('playing'));

    assert.equal(FakeAudioContext.instances.length, 1);
    assert.equal(harness.media.playbackRate, SETTINGS.speed);

    harness.dom.window.close();
  });

  test('normalizes untrusted page-world settings before applying them', async () => {
    const harness = setup();
    harness.apply(true, {
      speed: Number.POSITIVE_INFINITY,
      reverb: 200,
      echo: -1,
      pan: -250,
      width: 500,
      keepPitch: 'true',
      saturation: Number.NaN,
      eqLow: -30,
      eqMid: 30,
      eqHigh: '12'
    });
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    await settle();

    const context = FakeAudioContext.instances[0];
    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    assert.deepEqual(
      context.filters.map(({ gain }) => gain.value),
      [-12, 12, 0]
    );
    assert.equal(context.gains[2].gain.value, 0.7);
    assert.equal(context.gains[3].gain.value, 0);
    assert.equal(context.gains[4].gain.value, 0);
    assert.equal(context.panners[0].pan.value, -1);

    harness.dom.window.close();
  });

  test('does not enable processing for non-boolean page-world values', () => {
    const harness = setup();
    harness.apply('true');
    harness.media.dispatchEvent(new harness.window.Event('playing'));

    assert.equal(FakeAudioContext.instances.length, 0);
    assert.equal(harness.media.playbackRate, 1);
    assert.equal(
      harness.statusMessages.filter(({ type }) => type === 'STATUS').at(-1).processingActive,
      false
    );

    harness.dom.window.close();
  });

  test('turns itself off when the bridge stops answering and accepts a new one', async (t) => {
    const harness = setup();
    t.after(() => harness.dom.window.close());
    const wait = () => new Promise((resolve) => setTimeout(resolve, 300));
    let bridgeRunning = true;
    harness.window.document.addEventListener('SLOWED_REVERB_SPOTIFY_CHECK', (event) => {
      if (bridgeRunning) event.preventDefault();
    });

    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    await wait();
    assert.equal(harness.media.playbackRate, SETTINGS.speed);

    // Firefox removes the bridge when the extension is turned off.
    bridgeRunning = false;
    await wait();
    // Let the fade back to the unchanged path play out.
    FakeAudioContext.advance(1);
    const context = FakeAudioContext.instances[0];
    assert.equal(harness.media.playbackRate, 1);
    assert.deepEqual(
      context.gains
        .filter((node) => node.connections.some(({ target }) => target === context.destination))
        .map(({ gain }) => gain.value),
      [1, 0]
    );
    assert.equal(
      harness.statusMessages.filter(({ type }) => type === 'STATUS').at(-1).processingActive,
      false
    );

    // Turned back on, Firefox injects a new bridge into the same page.
    bridgeRunning = true;
    harness.window.dispatchEvent(
      new harness.window.MessageEvent('message', {
        source: harness.window,
        data: { channel: 'SLOWED_REVERB_SPOTIFY', type: 'BRIDGE_READY' }
      })
    );
    assert.equal(harness.statusMessages.at(-2).type, 'READY');
    assert.equal(harness.statusMessages.at(-2).bridgeCheck, true);
    // The bridge compares these with its own version.
    const { version } = JSON.parse(fs.readFileSync(`${root}/extension/manifest.json`, 'utf8'));
    assert.equal(harness.statusMessages.at(-2).version, version);
    assert.equal(harness.statusMessages.at(-1).type, 'STATUS');
    assert.equal(harness.statusMessages.at(-1).version, version);
    harness.apply(true);
    await wait();
    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(FakeAudioContext.instances.length, 1);
  });
});
