'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createContentHarness } = require('./helpers/content-harness');
const { flushPromises } = require('./helpers/browser-api');

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

function close(harness) {
  harness.dom.window.close();
}

describe('content script audio processing', () => {
  test('builds the audio graph and applies every setting', async () => {
    const harness = await createContentHarness();

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

    close(harness);
  });

  test('fades settings instead of switching them', async () => {
    const harness = await createContentHarness();
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const context = harness.getContext();
    const processed = outputGains(context)[1];
    // Past the silence that switching the effect on started.
    context.currentTime = 1;

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

    close(harness);
  });

  test('stays silent while the player changes its pitch mode', async () => {
    const harness = await createContentHarness();
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const context = harness.getContext();
    const [bypass, processed] = outputGains(context);

    const answer = harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: false });
    // Until the output has faded out, the player keeps its pitch mode.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.media.preservesPitch, true);
    await answer;

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

    close(harness);
  });

  test('stays silent while Firefox changes the speed', async () => {
    const harness = await createContentHarness({
      userAgent: 'Mozilla/5.0 (Macintosh; rv:158.0) Gecko/20100101 Firefox/158.0'
    });
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const processed = outputGains(harness.getContext())[1];

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: { ...SETTINGS, speed: 0.9 }, enabled: true });
    assert.equal(harness.media.playbackRate, 0.9);
    // Firefox also keeps the output silent for 250 ms after first routing
    // the player in, and in this test the audio clock never moves on.
    assert.deepEqual(ramps(processed.gain).slice(-2), [
      { to: 0, endTime: 0.03 },
      { to: 1, endTime: 0.275 }
    ]);

    close(harness);
  });

  test('returns the graph to neutral values when disabled', async () => {
    const harness = await createContentHarness();

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: false });

    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    const outputGains = harness.context.gains.filter((node) =>
      node.connections.some((connection) => connection.target === harness.context.destination)
    );
    assert.deepEqual(outputGains.map((node) => node.gain.value), [1, 0]);

    close(harness);
  });

  test('returns the graph to neutral when YouTube permission is revoked', async () => {
    const harness = await createContentHarness();

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

    close(harness);
  });

  test('returns the graph to neutral when the extension is turned off', async (t) => {
    const harness = await createContentHarness();
    t.after(() => close(harness));

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    harness.runtimeMessages.length = 0;
    delete harness.window.chrome.runtime.id;
    await new Promise((resolve) => setTimeout(resolve, 300));

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
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(source.connections.length, 0);

    delete harness.window.chrome.runtime.id;
    await new Promise((resolve) => setTimeout(resolve, 300));
    harness.media.playbackRate = 1.25;
    harness.window.document.body.appendChild(harness.media);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.ok(source.connections.length > 0);
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
    assert.equal(harness.media.playbackRate, 1);

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

  test('restores remembered state after reinjection', async () => {
    const harness = await createContentHarness({
      remembered: {
        enabled: true,
        settings: SETTINGS,
        url: 'https://www.youtube.com/watch?v=previous'
      }
    });

    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(
      harness.runtimeMessages.some(
        (message) => message.type === 'CONTENT_STATE_CHANGED' && message.enabled === true
      ),
      true
    );

    close(harness);
  });

  test('does not alter speed or pitch on live media', async () => {
    const harness = await createContentHarness({ duration: Number.POSITIVE_INFINITY });

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const state = await harness.dispatch({ type: 'GET_STATE' });

    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    assert.equal(state.live, true);
    assert.equal(state.enabled, true);
    assert.equal(harness.context.gains[2].gain.value, 0.35);

    close(harness);
  });

  test('reports every site outside the release support list as unsupported', async () => {
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
      const state = await harness.dispatch({ type: 'GET_STATE' });
      assert.equal(state.blocked, true);
      assert.equal(state.blockReason, 'unsupportedSite');
      close(harness);
    }
  });

  test('does not attach media on unsupported sites to Web Audio', async () => {
    for (const url of ['https://www.twitch.tv/example', 'https://soundcloud.com/a/b']) {
      const harness = await createContentHarness({ url });

      await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

      assert.equal(harness.context, undefined);
      assert.equal(harness.media.crossOrigin, null);
      close(harness);
    }
  });

  test('detects media protected with MediaKeys without creating a graph', async () => {
    const harness = await createContentHarness({ mediaKeys: {} });

    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const state = await harness.dispatch({ type: 'GET_STATE' });

    assert.equal(state.blocked, true);
    assert.equal(state.blockReason, 'drm');
    assert.equal(harness.context, undefined);

    close(harness);
  });

  test('reports ordinary Web Audio conflicts as unsupported rather than DRM', async () => {
    const error = new Error('media source already connected');
    error.name = 'InvalidStateError';
    const harness = await createContentHarness({ mediaSourceError: error });

    const response = await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    assert.equal(response.success, false);
    assert.equal(response.blockReason, 'unsupported');
    assert.equal((await harness.dispatch({ type: 'GET_STATE' })).blockReason, 'unsupported');
    assert.equal(harness.warnings.length, 1);

    close(harness);
  });

  test('ignores duplicate injections into the same document', async () => {
    const harness = await createContentHarness();
    assert.equal(harness.runtimeMessage.listeners.length, 1);
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    harness.window.eval(harness.source);
    await flushPromises();

    assert.equal(harness.runtimeMessage.listeners.length, 1);
    assert.equal(harness.context.sources.length, 1);

    close(harness);
  });

  test('processes media elements added after the initial injection', async () => {
    const harness = await createContentHarness({ withMedia: false });
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
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(harness.getContext().sources.length, 1);
    assert.equal(media.playbackRate, SETTINGS.speed);
    const state = await harness.dispatch({ type: 'GET_STATE' });
    assert.equal(state.playerDetected, true);
    assert.equal(state.processingActive, true);
    assert.equal(state.pending, false);
    assert.equal(
      harness.runtimeMessages.some(
        (message) => message.type === 'CONTENT_STATE_CHANGED' && message.processingActive === true
      ),
      true
    );

    close(harness);
  });

  test('attaches a replacement player whose metadata loaded before insertion', async () => {
    const harness = await createContentHarness();
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
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(harness.context.sources.length, 2);
    assert.equal(replacement.playbackRate, SETTINGS.speed);
    const state = await harness.dispatch({ type: 'GET_STATE' });
    assert.equal(state.playerDetected, true);
    assert.equal(state.processingActive, true);
    assert.equal(state.pending, false);

    close(harness);
  });

  test('reapplies speed when a reused media element starts playing', async () => {
    const harness = await createContentHarness();
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    harness.media.playbackRate = 1;
    harness.media.dispatchEvent(new harness.window.Event('play'));

    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(harness.context.sources.length, 1);

    close(harness);
  });

  test('restores neutral speed when reused media becomes live', async () => {
    const harness = await createContentHarness();
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    assert.equal(harness.media.playbackRate, SETTINGS.speed);

    Object.defineProperty(harness.media, 'duration', {
      configurable: true,
      value: Number.POSITIVE_INFINITY
    });
    harness.media.dispatchEvent(new harness.window.Event('play'));
    // The change of pitch mode waits for the output to fade out.
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    assert.equal((await harness.dispatch({ type: 'GET_STATE' })).live, true);

    close(harness);
  });

  test('disconnects removed media and reuses its pipeline if reattached', async () => {
    const harness = await createContentHarness();
    await harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const source = harness.context.sources[0];
    assert.ok(source.connections.length > 0);

    harness.media.remove();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(source.connections.length, 0);

    harness.window.document.body.appendChild(harness.media);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(harness.context.sources.length, 1);
    assert.ok(source.connections.length > 0);

    close(harness);
  });

  test('shares reverb data and caps active pipelines on media-heavy pages', async () => {
    const harness = await createContentHarness({ withMedia: false });
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
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(harness.context.sources.length, 32);
    assert.equal(harness.context.buffers.length, 1);

    close(harness);
  });

  test('initializes safely before the document body exists', async () => {
    const harness = await createContentHarness({ withMedia: false, withoutBody: true });

    assert.equal(harness.runtimeMessage.listeners.length, 1);
    assert.equal(harness.context, undefined);

    close(harness);
  });
});
