'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const { describe, test } = require('node:test');
const { JSDOM } = require('jsdom');

const {
  createBrowserApi,
  dispatchRuntimeMessage,
  flushPromises,
  waitFor
} = require('./helpers/browser-api');
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
  test('relays extension settings and neutralizes the engine after permission removal', async (t) => {
    const dom = new JSDOM('<!doctype html><body></body>', {
      url: 'https://open.spotify.com/',
      runScripts: 'outside-only'
    });
    t.after(() => dom.window.close());
    const { window } = dom;
    const harness = createBrowserApi();
    const engineMessages = [];
    let engineStatus = { playerDetected: true, effectsUnavailable: false, processingActive: false };
    let reportsOnTheWay = 0;
    window.chrome = harness.api;
    window.postMessage = (message) => {
      engineMessages.push(message);
      // Like the real engine, report the status after every change.
      if (message.type !== 'APPLY') return;
      const data = { channel: 'SLOWED_REVERB_SPOTIFY', type: 'STATUS', ...engineStatus };
      reportsOnTheWay++;
      setTimeout(() => {
        reportsOnTheWay--;
        window.eval(`window.__bridgeMessageListener({ source: window, data: ${JSON.stringify(data)} })`);
      });
    };
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
      data: { channel: 'SLOWED_REVERB_SPOTIFY', type: 'READY', bridgeCheck: true }
    })`);
    const pending = await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'UPDATE_AUDIO',
      enabled: true,
      settings: SETTINGS
    });
    // Wait for the engine's own report on this change, so it can't arrive
    // after the report below and undo it.
    await waitFor(() => reportsOnTheWay === 0);
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

    // Turning the effect back on while the song plays answers with the
    // engine's report on that change, not the state from before it.
    await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'UPDATE_AUDIO',
      enabled: false,
      settings: SETTINGS
    });
    await waitFor(() => reportsOnTheWay === 0);
    assert.equal(harness.calls.runtimeMessages.at(-1).processingActive, false);
    engineStatus = { ...engineStatus, processingActive: true };
    const resumed = await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'UPDATE_AUDIO',
      enabled: true,
      settings: SETTINGS
    });
    assert.equal(resumed.processingActive, true);
    assert.equal(resumed.pending, false);

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
  });

  test('answers the engine only while the extension is running', async (t) => {
    const dom = new JSDOM('<!doctype html><body></body>', {
      url: 'https://open.spotify.com/',
      runScripts: 'outside-only'
    });
    t.after(() => dom.window.close());
    const { window } = dom;
    const harness = createBrowserApi();
    const engineMessages = [];
    const pageListeners = [];
    window.chrome = harness.api;
    window.postMessage = (message) => engineMessages.push(message);
    const originalAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = (type, listener, options) => {
      if (type === 'message') pageListeners.push(listener);
      return originalAddEventListener(type, listener, options);
    };
    window.eval(fs.readFileSync(`${root}/extension/spotify-bridge.js`, 'utf8'));
    await flushPromises();
    const fromEngine = (data) => {
      for (const listener of pageListeners) {
        listener({ source: window, data: { channel: 'SLOWED_REVERB_SPOTIFY', ...data } });
      }
    };
    const bridgeAnswers = () =>
      !window.document.dispatchEvent(
        new window.Event('SLOWED_REVERB_SPOTIFY_CHECK', { cancelable: true })
      );

    assert.equal(engineMessages.at(-1).type, 'BRIDGE_READY');
    assert.equal(bridgeAnswers(), true);

    // Chromium leaves the script running once the extension is turned off.
    delete harness.api.runtime.id;
    assert.equal(bridgeAnswers(), false);

    // A later engine status or restart reaches nothing that would message the extension.
    harness.calls.runtimeMessages.length = 0;
    const sentToEngine = engineMessages.length;
    fromEngine({ type: 'STATUS', playerDetected: true });
    fromEngine({ type: 'READY' });
    assert.deepEqual(harness.calls.runtimeMessages, []);
    assert.equal(engineMessages.length, sentToEngine);
  });

  test('keeps an engine from before the bridge check off until the page is reloaded', async (t) => {
    const dom = new JSDOM('<!doctype html><body></body>', {
      url: 'https://open.spotify.com/',
      runScripts: 'outside-only'
    });
    t.after(() => dom.window.close());
    const { window } = dom;
    const harness = createBrowserApi();
    const engineMessages = [];
    const pageListeners = [];
    window.chrome = harness.api;
    window.postMessage = (message) => engineMessages.push(message);
    const originalAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = (type, listener, options) => {
      if (type === 'message') pageListeners.push(listener);
      return originalAddEventListener(type, listener, options);
    };
    window.eval(fs.readFileSync(`${root}/extension/spotify-bridge.js`, 'utf8'));
    await flushPromises();

    // An engine left in the tab by the previous version answers without the check.
    for (const listener of pageListeners) {
      listener({ source: window, data: { channel: 'SLOWED_REVERB_SPOTIFY', type: 'READY' } });
    }
    const response = await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'UPDATE_AUDIO',
      enabled: true,
      settings: SETTINGS
    });
    assert.deepEqual({ ...response }, { success: false, blocked: true, blockReason: 'unsupported' });
    assert.equal(engineMessages.at(-1).type, 'APPLY');
    assert.equal(engineMessages.at(-1).enabled, false);

    const state = await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'GET_STATE'
    });
    assert.equal(state.blocked, true);
    assert.equal(state.blockReason, 'unsupported');
  });
});
