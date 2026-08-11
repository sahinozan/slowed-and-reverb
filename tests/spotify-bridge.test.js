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
    window.addEventListener('message', (event) => {
      if (event.data?.channel === 'SLOWED_REVERB_SPOTIFY') engineMessages.push(event.data);
    });
    window.eval(fs.readFileSync(`${root}/spotify-bridge.js`, 'utf8'));
    await flushPromises();

    window.eval(`window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: { channel: 'SLOWED_REVERB_SPOTIFY', type: 'READY' }
    }))`);
    await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'UPDATE_AUDIO',
      enabled: true,
      settings: SETTINGS
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(engineMessages.at(-1).type, 'APPLY');
    assert.equal(engineMessages.at(-1).enabled, true);
    assert.equal(engineMessages.at(-1).settings.speed, 0.8);

    await dispatchRuntimeMessage(harness.events.runtimeMessage, {
      type: 'SPOTIFY_PERMISSION_REVOKED'
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(engineMessages.at(-1).type, 'APPLY');
    assert.equal(engineMessages.at(-1).enabled, false);
    assert.equal(
      harness.calls.runtimeMessages.some(({ type }) => type === 'SPOTIFY_BRIDGE_READY'),
      true
    );

    dom.window.close();
  });
});
