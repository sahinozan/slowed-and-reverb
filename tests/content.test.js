'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { FakeAudioContext, createContentHarness } = require('./helpers/content-harness');
const { flushPromises, waitFor } = require('./helpers/browser-api');

const SETTINGS = {
  speed: 0.7,
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

// The two gains that play to the speakers: the unchanged path, then the effect.
function outputGains(context) {
  return context.gains.filter((node) =>
    node.connections.some((connection) => connection.target === context.destination)
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

function close(harness) {
  harness.dom.window.close();
}

describe('content script audio processing', () => {
  test('builds the audio graph and applies every setting', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));

    assert.equal(harness.context, undefined);

    assert.equal(
      (await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true })).success,
      true
    );

    const { context, media } = harness;
    assert.equal(context.sources.length, 1);
    assert.equal(media.crossOrigin, null);
    assert.equal(media.playbackRate, 0.7);
    assert.equal(media.preservesPitch, true);
    assert.equal(context.gains[0].channelCount, 2);
    assert.equal(context.gains[0].channelCountMode, 'explicit');
    assert.equal(context.gains[0].channelInterpretation, 'speakers');
    assert.deepEqual(
      context.filters.map(({ type, frequency, Q, gain }) => ({
        type,
        frequency: frequency.value,
        q: Q.value,
        gain: gain.value
      })),
      [
        { type: 'lowshelf', frequency: 200, q: 0, gain: 2 },
        { type: 'peaking', frequency: 1000, q: 1, gain: -3 },
        { type: 'highshelf', frequency: 4000, q: 0, gain: 4 }
      ]
    );
    assert.equal(context.gains[1].gain.value, 0.85);
    assert.equal(context.gains[2].gain.value, 0.35);
    assert.equal(context.gains[3].gain.value, 0.2);
    assert.equal(context.gains[4].gain.value, 0.18);
    assert.equal(context.gains[5].gain.value, 1.5);
    assert.equal(context.panners[0].pan.value, -0.25);
    assert.equal(context.waveShapers[0].curve.length, 1024);
    assert.deepEqual(
      ['threshold', 'knee', 'ratio', 'attack', 'release'].map(
        (key) => context.compressors[0][key].value
      ),
      [-3, 3, 20, 0.003, 0.25]
    );
  });

  test('fades settings instead of switching them', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const context = harness.getContext();
    const processed = outputGains(context)[1];

    await harness.dispatch({
      type: 'UPDATE_AUDIO',
      settings: { ...SETTINGS, reverb: 0, speed: 0.9 },
      enabled: true
    });
    // Changes start 20 ms ahead and take 25 ms.
    assert.deepEqual(ramps(context.gains[2].gain).at(-1), { to: 0, endTime: 1.045 });
    // Chromium changes speed without a click, so the output carries on.
    assert.deepEqual(ramps(processed.gain).at(-1), { to: 1, endTime: 1.045 });
    assert.equal(harness.media.playbackRate, 0.9);
  });

  test('stays silent while the player changes its pitch mode', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const context = harness.getContext();
    const [bypass, processed] = outputGains(context);

    const answer = harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: false });
    // Until the output has faded out, the player keeps its pitch mode. The
    // wait is short on purpose: the check is that nothing has changed yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.media.preservesPitch, true);
    await answer;

    assert.equal(harness.media.preservesPitch, false);
    // Both fade out over 10 ms, stay silent 80 ms, then fade to their new level.
    assert.deepEqual(ramps(bypass.gain).slice(-2), [
      { to: 0, endTime: 1.03 },
      { to: 1, endTime: 1.105 }
    ]);
    assert.deepEqual(ramps(processed.gain).slice(-2), [
      { to: 0, endTime: 1.03 },
      { to: 0, endTime: 1.105 }
    ]);
  });

  test('carries on from a change still under way without jumping', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const context = harness.getContext();
    const wet = context.gains[2].gain;

    // Reverb up, then back down while the first fade is still under way.
    await harness.dispatch(
      { type: 'UPDATE_AUDIO', settings: { ...SETTINGS, reverb: 100 }, enabled: true },
      { advance: 0 }
    );
    context.currentTime = 1.03;
    await harness.dispatch(
      { type: 'UPDATE_AUDIO', settings: { ...SETTINGS, reverb: 0 }, enabled: true },
      { advance: 0 }
    );

    assert.equal(wet.valueAt(1.05), 0.7);
    assert.equal(wet.valueAt(1.2), 0);
    assert.ok(largestStep(wet, 1, 1.2) < 0.05);
  });

  test('keeps a fading-out output silent when another change arrives', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const context = harness.getContext();
    const processed = outputGains(context)[1];

    // A change of pitch mode fades the output out from 1.02 to 1.03 s; a
    // reverb change arrives halfway through.
    await harness.dispatch(
      { type: 'UPDATE_AUDIO', settings: { ...SETTINGS, keepPitch: false }, enabled: true },
      { advance: 0 }
    );
    context.currentTime = 1.025;
    await harness.dispatch(
      { type: 'UPDATE_AUDIO', settings: { ...SETTINGS, keepPitch: false, reverb: 0 }, enabled: true },
      { advance: 0 }
    );

    assert.equal(processed.gain.valueAt(1.05), 0);
    assert.equal(processed.gain.valueAt(1.2), 1);
    // The 10 ms fade-out moves 0.1 a millisecond; a jump would be far more.
    assert.ok(largestStep(processed.gain, 1, 1.2) <= 0.1 + 1e-9);
  });

  test('keeps the silence an earlier change needs when a later one is taken back', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const context = harness.getContext();
    const processed = outputGains(context)[1];
    const withPitch = (keepPitch) => ({
      type: 'UPDATE_AUDIO',
      settings: { ...SETTINGS, keepPitch },
      enabled: true
    });

    // The player changes its pitch mode at 1.00 s, so its click needs
    // silence until 1.08 s.
    await harness.dispatch(withPitch(false), { advance: 0 });
    // Another change is asked for, then taken back before it happens.
    const askedFor = harness.dispatch(withPitch(true), { advance: 0 });
    await harness.dispatch(withPitch(false), { advance: 0 });
    await askedFor;

    assert.equal(harness.media.preservesPitch, false);
    assert.equal(processed.gain.valueAt(1.07), 0);
    assert.equal(processed.gain.valueAt(1.2), 1);
  });

  test('stays silent while Firefox changes the speed', async (t) => {
    const harness = await createContentHarness({
      userAgent: 'Mozilla/5.0 (Macintosh; rv:158.0) Gecko/20100101 Firefox/158.0'
    });
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const processed = outputGains(harness.getContext())[1];

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: { ...SETTINGS, speed: 0.9 }, enabled: true });
    assert.equal(harness.media.playbackRate, 0.9);
    assert.deepEqual(ramps(processed.gain).slice(-2), [
      { to: 0, endTime: 1.03 },
      { to: 1, endTime: 1.105 }
    ]);
  });

  test('returns the graph to neutral values when disabled', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: false });

    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    const outputGains = harness.context.gains.filter((node) =>
      node.connections.some((connection) => connection.target === harness.context.destination)
    );
    assert.deepEqual(outputGains.map((node) => node.gain.value), [1, 0]);
  });

  test('returns the graph to neutral when YouTube permission is revoked', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const response = await harness.dispatch({ type: 'YOUTUBE_PERMISSION_REVOKED' });

    assert.equal(response.success, true);
    assert.equal(response.enabled, false);
    assert.equal(harness.media.playbackRate, 1);
    assert.equal((await harness.dispatch({ type: 'GET_STATE' })).enabled, false);
    const outputGains = harness.context.gains.filter((node) =>
      node.connections.some((connection) => connection.target === harness.context.destination)
    );
    assert.deepEqual(outputGains.map((node) => node.gain.value), [1, 0]);
  });

  test('returns the graph to neutral when the extension is turned off', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    harness.runtimeMessages.length = 0;
    await harness.turnOff();
    // The player's speed and pitch mode change once the output has faded out.
    await waitFor(() => harness.media.playbackRate === 1 && harness.media.preservesPitch === false);
    // Let the fades back to the unchanged path play out.
    FakeAudioContext.advance(1);

    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    const outputGains = harness.context.gains.filter((node) =>
      node.connections.some((connection) => connection.target === harness.context.destination)
    );
    assert.deepEqual(outputGains.map((node) => node.gain.value), [1, 0]);

    // The orphaned script leaves the page's own speed alone, captures no new
    // players and no longer messages the extension.
    harness.media.playbackRate = 1.5;
    harness.media.dispatchEvent(new harness.window.Event('play'));
    harness.window.document.dispatchEvent(new harness.window.Event('yt-navigate-finish'));
    harness.window.document.body.append(harness.window.document.createElement('video'));
    // Nothing should happen, so this waits a fixed time: longer than the
    // engine takes to notice a new player.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(harness.media.playbackRate, 1.5);
    assert.deepEqual(harness.runtimeMessages, []);
    assert.equal(harness.context.sources.length, 1);
  });

  test('reconnects captured media unchanged after the extension is turned off', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const source = harness.context.sources[0];
    harness.media.remove();
    await waitFor(() => source.connections.length === 0);

    await harness.turnOff();
    harness.media.playbackRate = 1.25;
    harness.window.document.body.appendChild(harness.media);
    await waitFor(() => source.connections.length > 0);

    FakeAudioContext.advance(1);
    const outputGains = harness.context.gains.filter((node) =>
      node.connections.some((connection) => connection.target === harness.context.destination)
    );
    assert.deepEqual(outputGains.map((node) => node.gain.value), [1, 0]);
    assert.equal(harness.media.playbackRate, 1.25);
  });

  test('reuses captured media when the extension is turned off and on again', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    await harness.reinject();
    // The player's speed changes back once the output has faded out.
    await waitFor(() => harness.media.playbackRate === 1);

    const response = await harness.dispatch({
      type: 'UPDATE_AUDIO',
      settings: SETTINGS,
      enabled: true
    });
    assert.equal(response.success, true);
    assert.equal(response.processingActive, true);
    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    // One graph per player: a second one would play next to the first.
    assert.equal(harness.context.sources.length, 1);
    const outputGains = harness.context.gains.filter((node) =>
      node.connections.some((connection) => connection.target === harness.context.destination)
    );
    assert.deepEqual(outputGains.map((node) => node.gain.value), [0, 1]);
  });

  test('a late answer to the startup request does not undo a newer change', async (t) => {
    // Lets content.js receive the remembered state and ask the engine to
    // apply it, without letting the engine answer yet.
    const harness = await createContentHarness({ settle: false });
    t.after(() => close(harness));
    for (let index = 0; index < 10; index++) await Promise.resolve();

    const response = await harness.dispatch({
      type: 'UPDATE_AUDIO',
      settings: SETTINGS,
      enabled: true
    });
    assert.equal(response.success, true);

    const state = await harness.dispatch({ type: 'GET_STATE' });
    assert.equal(state.enabled, true);
    assert.equal(state.processingActive, true);
    assert.equal(harness.media.playbackRate, SETTINGS.speed);
  });

  test('restores remembered state after reinjection', async (t) => {
    const harness = await createContentHarness({
      remembered: {
        enabled: true,
        settings: SETTINGS,
        url: 'https://www.youtube.com/watch?v=previous'
      }
    });
    t.after(() => close(harness));

    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(
      harness.runtimeMessages.some(
        (message) => message.type === 'CONTENT_STATE_CHANGED' && message.enabled === true
      ),
      true
    );
  });

  test('does not alter speed or pitch on live media', async (t) => {
    const harness = await createContentHarness({ duration: Number.POSITIVE_INFINITY });
    t.after(() => close(harness));

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const state = await harness.dispatch({ type: 'GET_STATE' });

    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    assert.equal(state.live, true);
    assert.equal(state.enabled, true);
    assert.equal(harness.context.gains[2].gain.value, 0.35);
  });

  test('reports every site outside the release support list as unsupported', async (t) => {
    const urls = [
      'https://www.twitch.tv/example',
      'https://clips.twitch.tv/ExampleClip',
      'https://soundcloud.com/artist/song',
      'https://music.apple.com/album/example',
      'https://open.spotify.com/track/1',
      'https://studio.youtube.com/',
      'https://m.youtube.com/watch?v=example'
    ];

    for (const url of urls) {
      const harness = await createContentHarness({ url, withMedia: false });
      t.after(() => close(harness));
      const state = await harness.dispatch({ type: 'GET_STATE' });
      assert.equal(state.blocked, true);
      assert.equal(state.blockReason, 'unsupportedSite');
    }
  });

  test('does not attach media on unsupported sites to Web Audio', async (t) => {
    for (const url of ['https://www.twitch.tv/example', 'https://soundcloud.com/a/b']) {
      const harness = await createContentHarness({ url });
      t.after(() => close(harness));

      await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

      assert.equal(harness.context, undefined);
      assert.equal(harness.media.crossOrigin, null);
    }
  });

  test('detects media protected with MediaKeys without creating a graph', async (t) => {
    const harness = await createContentHarness({ mediaKeys: {} });
    t.after(() => close(harness));

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const state = await harness.dispatch({ type: 'GET_STATE' });

    assert.equal(state.blocked, true);
    assert.equal(state.blockReason, 'drm');
    assert.equal(harness.context, undefined);
  });

  test('reports ordinary Web Audio conflicts as unsupported rather than DRM', async (t) => {
    const error = new Error('media source already connected');
    error.name = 'InvalidStateError';
    const harness = await createContentHarness({ mediaSourceError: error });
    t.after(() => close(harness));

    const response = await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    assert.equal(response.success, false);
    assert.equal(response.blockReason, 'unsupported');
    assert.equal((await harness.dispatch({ type: 'GET_STATE' })).blockReason, 'unsupported');
    assert.equal(harness.warnings.length, 1);
  });

  test('ignores duplicate injections into the same document', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));
    assert.equal(harness.runtimeMessage.listeners.length, 1);
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    harness.window.eval(harness.source);
    await flushPromises();

    assert.equal(harness.runtimeMessage.listeners.length, 1);
    assert.equal(harness.context.sources.length, 1);
  });

  test('processes media elements added after the initial injection', async (t) => {
    const harness = await createContentHarness({ withMedia: false });
    t.after(() => close(harness));
    const initial = await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    assert.equal(initial.playerDetected, false);
    assert.equal(initial.processingActive, false);
    assert.equal(initial.pending, true);

    const media = harness.window.document.createElement('audio');
    Object.defineProperties(media, {
      duration: { configurable: true, value: 120 },
      mediaKeys: { configurable: true, value: null },
      readyState: { configurable: true, value: 2 }
    });
    media.playbackRate = 1;
    harness.window.document.body.appendChild(media);
    await waitFor(() => media.playbackRate === SETTINGS.speed);
    await waitFor(() =>
      harness.runtimeMessages.some(
        (message) => message.type === 'CONTENT_STATE_CHANGED' && message.processingActive === true
      )
    );

    assert.equal(harness.getContext().sources.length, 1);
    const state = await harness.dispatch({ type: 'GET_STATE' });
    assert.equal(state.playerDetected, true);
    assert.equal(state.processingActive, true);
    assert.equal(state.pending, false);
  });

  test('attaches a replacement player whose metadata loaded before insertion', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    harness.media.remove();
    const replacement = harness.window.document.createElement('audio');
    Object.defineProperties(replacement, {
      duration: { configurable: true, value: 240 },
      mediaKeys: { configurable: true, value: null },
      readyState: { configurable: true, value: 1 }
    });
    replacement.playbackRate = 1;
    harness.window.document.body.appendChild(replacement);
    await waitFor(() => replacement.playbackRate === SETTINGS.speed);

    assert.equal(harness.context.sources.length, 2);
    const state = await harness.dispatch({ type: 'GET_STATE' });
    assert.equal(state.playerDetected, true);
    assert.equal(state.processingActive, true);
    assert.equal(state.pending, false);
  });

  test('reapplies speed when a reused media element starts playing', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    harness.media.playbackRate = 1;
    harness.media.dispatchEvent(new harness.window.Event('play'));

    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(harness.context.sources.length, 1);
  });

  test('restores neutral speed when reused media becomes live', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    assert.equal(harness.media.playbackRate, SETTINGS.speed);

    Object.defineProperty(harness.media, 'duration', {
      configurable: true,
      value: Number.POSITIVE_INFINITY
    });
    harness.media.dispatchEvent(new harness.window.Event('play'));
    // The change of pitch mode waits for the output to fade out.
    await waitFor(() => harness.media.playbackRate === 1 && harness.media.preservesPitch === false);

    assert.equal((await harness.dispatch({ type: 'GET_STATE' })).live, true);
  });

  test('disconnects removed media and reuses its pipeline if reattached', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const source = harness.context.sources[0];
    assert.ok(source.connections.length > 0);

    harness.media.remove();
    await waitFor(() => source.connections.length === 0);

    harness.window.document.body.appendChild(harness.media);
    await waitFor(() => source.connections.length > 0);
    assert.equal(harness.context.sources.length, 1);
  });

  test('shares reverb data and caps active pipelines on media-heavy pages', async (t) => {
    const harness = await createContentHarness({ withMedia: false });
    t.after(() => close(harness));
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    for (let index = 0; index < 40; index++) {
      const media = harness.window.document.createElement('audio');
      Object.defineProperties(media, {
        duration: { configurable: true, value: 120 },
        mediaKeys: { configurable: true, value: null },
        readyState: { configurable: true, value: 2 }
      });
      harness.window.document.body.appendChild(media);
    }
    // The engine takes in every new player at once.
    await waitFor(() => harness.context?.sources.length > 0);

    assert.equal(harness.context.sources.length, 32);
    assert.equal(harness.context.buffers.length, 1);
  });

  test('initializes safely before the document body exists', async (t) => {
    const harness = await createContentHarness({ withMedia: false, withoutBody: true });
    t.after(() => close(harness));

    assert.equal(harness.runtimeMessage.listeners.length, 1);
    assert.equal(harness.context, undefined);
  });
});
