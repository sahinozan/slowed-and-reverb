'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const { describe, test } = require('node:test');
const { JSDOM } = require('jsdom');

const { createBrowserApi, dispatchRuntimeMessage, flushPromises } = require('./helpers/browser-api');
const { root } = require('./helpers/load-script');

const SETTINGS = {
  speed: 0.8,
  reverb: 40,
  echo: 0,
  pan: 0,
  width: 100,
  keepPitch: false,
  saturation: 0,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0
};

describe('Spotify isolated bridge', () => {
  test('relays extension settings and neutralizes the engine after permission removal', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
      url: 'https://open.spotify.com/',
      runScripts: 'outside-only'
    });
    const { window } = dom;
    const harness = createBrowserApi();
    const engineMessages = [];
    window.chrome = harness.api;
    window.postMessage = (message) => engineMessages.push(message);
    const originalAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = (type, listener, options) => {
      if (type === 'message') window.__bridgeMessageListener = listener;
      return originalAddEventListener(type, listener, options);
    };
    window.eval(fs.readFileSync(`${root}/extension/spotify-bridge.js`, 'utf8'));
    window.addEventListener = originalAddEventListener;
    await flushPromises();

    const iframe = window.document.createElement('iframe');
    window.document.body.appendChild(iframe);
    window.eval(`window.__bridgeMessageListener({
      source: document.querySelector('iframe').contentWindow,
      data: ${JSON.stringify({
        channel: 'SLOWED_REVERB_SPOTIFY',
        type: 'STATUS',
        playerDetected: true,
        effectsUnavailable: true
      })}
    })`);
    const stateAfterSpoof = await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'GET_STATE'
    });
    assert.equal(stateAfterSpoof.playerDetected, false);
    assert.equal(stateAfterSpoof.effectsUnavailable, false);

    window.eval(`window.__bridgeMessageListener({
      source: window,
      data: { channel: 'SLOWED_REVERB_SPOTIFY', type: 'READY' }
    })`);
    const pending = await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'UPDATE_AUDIO',
      enabled: true,
      settings: SETTINGS
    });
    await flushPromises();
    assert.equal(pending.pending, true);
    assert.equal(pending.processingActive, false);
    assert.equal(engineMessages.at(-1).type, 'APPLY');
    assert.equal(engineMessages.at(-1).enabled, true);
    assert.equal(engineMessages.at(-1).settings.speed, 0.8);

    window.eval(`window.__bridgeMessageListener({
      source: window,
      data: {
        channel: 'SLOWED_REVERB_SPOTIFY',
        type: 'STATUS',
        playerDetected: true,
        effectsUnavailable: false,
        processingActive: true
      }
    })`);
    await flushPromises();
    const active = await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'GET_STATE'
    });
    assert.equal(active.processingActive, true);
    assert.equal(active.pending, false);
    assert.equal(
      harness.calls.runtimeMessages.some(
        ({ type, processingActive }) =>
          type === 'CONTENT_STATE_CHANGED' && processingActive === true
      ),
      true
    );

    await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'SPOTIFY_PERMISSION_REVOKED'
    });
    await flushPromises();
    assert.equal(engineMessages.at(-1).type, 'APPLY');
    assert.equal(engineMessages.at(-1).enabled, false);
    assert.equal(
      harness.calls.runtimeMessages.some(({ type }) => type === 'SPOTIFY_BRIDGE_READY'),
      true
    );

    dom.window.close();
  });
});
