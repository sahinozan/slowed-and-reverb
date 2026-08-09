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

function close(harness) {
  harness.dom.window.close();
}

describe('content script audio processing', () => {
  test('builds the audio graph and applies every setting', async () => {
    const harness = await createContentHarness();

    assert.equal(harness.context, undefined);

    assert.equal(
      harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true }).success,
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

  test('returns the graph to neutral values when disabled', async () => {
    const harness = await createContentHarness();

    harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: false });

    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    const outputGains = harness.context.gains.filter((node) =>
      node.connections.some((connection) => connection.target === harness.context.destination)
    );
    assert.deepEqual(outputGains.map((node) => node.gain.value), [1, 0]);

    close(harness);
  });

  test('restores remembered state after reinjection', async () => {
    const harness = await createContentHarness({
      remembered: {
        enabled: true,
        settings: SETTINGS,
        url: 'https://example.com/previous'
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

    harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const state = harness.dispatch({ type: 'GET_STATE' });

    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    assert.equal(state.live, true);
    assert.equal(state.enabled, true);
    assert.equal(harness.context.gains[2].gain.value, 0.35);

    close(harness);
  });

  test('reports static platform restrictions with the correct reason', async () => {
    const cases = [
      ['https://open.spotify.com/track/1', 'drm'],
      ['https://soundcloud.com/artist/song', 'unreachable'],
      ['https://www.twitch.tv/user/clip/example', 'broken']
    ];

    for (const [url, reason] of cases) {
      const harness = await createContentHarness({ url, withMedia: false });
      const state = harness.dispatch({ type: 'GET_STATE' });
      assert.equal(state.blocked, true);
      assert.equal(state.blockReason, reason);
      close(harness);
    }
  });

  test('does not attach blocked media to Web Audio', async () => {
    for (const url of ['https://open.spotify.com/track/1', 'https://soundcloud.com/a/b']) {
      const harness = await createContentHarness({ url });

      harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

      assert.equal(harness.context, undefined);
      assert.equal(harness.media.crossOrigin, null);
      close(harness);
    }
  });

  test('detects media protected with MediaKeys without creating a graph', async () => {
    const harness = await createContentHarness({ mediaKeys: {} });

    harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    const state = harness.dispatch({ type: 'GET_STATE' });

    assert.equal(state.blocked, true);
    assert.equal(state.blockReason, 'drm');
    assert.equal(harness.context, undefined);

    close(harness);
  });

  test('reports ordinary Web Audio conflicts as unsupported rather than DRM', async () => {
    const error = new Error('media source already connected');
    error.name = 'InvalidStateError';
    const harness = await createContentHarness({ mediaSourceError: error });

    const response = harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    assert.equal(response.success, false);
    assert.equal(response.blockReason, 'unsupported');
    assert.equal(harness.dispatch({ type: 'GET_STATE' }).blockReason, 'unsupported');
    assert.equal(harness.warnings.length, 1);

    close(harness);
  });

  test('ignores duplicate injections into the same document', async () => {
    const harness = await createContentHarness();
    assert.equal(harness.runtimeMessage.listeners.length, 1);
    harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    harness.window.eval(harness.source);
    await flushPromises();

    assert.equal(harness.runtimeMessage.listeners.length, 1);
    assert.equal(harness.context.sources.length, 1);

    close(harness);
  });

  test('processes media elements added after the initial injection', async () => {
    const harness = await createContentHarness({ withMedia: false });
    harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

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

    close(harness);
  });

  test('reapplies speed when a reused media element starts playing', async () => {
    const harness = await createContentHarness();
    harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

    harness.media.playbackRate = 1;
    harness.media.dispatchEvent(new harness.window.Event('play'));

    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(harness.context.sources.length, 1);

    close(harness);
  });

  test('restores neutral speed when reused media becomes live', async () => {
    const harness = await createContentHarness();
    harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
    assert.equal(harness.media.playbackRate, SETTINGS.speed);

    Object.defineProperty(harness.media, 'duration', {
      configurable: true,
      value: Number.POSITIVE_INFINITY
    });
    harness.media.dispatchEvent(new harness.window.Event('play'));

    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    assert.equal(harness.dispatch({ type: 'GET_STATE' }).live, true);

    close(harness);
  });

  test('disconnects removed media and reuses its pipeline if reattached', async () => {
    const harness = await createContentHarness();
    harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });
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
    harness.dispatch({ type: 'UPDATE_AUDIO', settings: SETTINGS, enabled: true });

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
