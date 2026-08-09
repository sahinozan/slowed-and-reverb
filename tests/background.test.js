'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createBrowserApi,
  dispatchRuntimeMessage,
  flushPromises
} = require('./helpers/browser-api');
const { loadScript } = require('./helpers/load-script');

const DEFAULT_SETTINGS = {
  speed: 1,
  reverb: 0,
  echo: 0,
  pan: 0,
  width: 100,
  keepPitch: false,
  saturation: 0,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0
};
const SLOWED = { ...DEFAULT_SETTINGS, speed: 0.8, reverb: 40 };

function setup(options = {}) {
  const harness = createBrowserApi({
    activeTab: { id: 7, url: 'https://example.com/watch/1' },
    ...options
  });
  loadScript('background.js', { chrome: harness.api });
  return harness;
}

function updates(calls) {
  return calls.tabMessages.filter(({ message }) => message.type === 'UPDATE_AUDIO');
}

describe('background service worker', () => {
  test('applies the slowed preset from its keyboard command', async () => {
    const harness = setup({
      onTabMessage(_tabId, message) {
        return message.type === 'GET_STATE'
          ? { enabled: false, settings: DEFAULT_SETTINGS }
          : { success: true };
      }
    });

    await harness.events.command.emit('toggle-slowed-reverb');

    assert.deepEqual(harness.local.data, SLOWED);
    assert.equal(updates(harness.calls).length, 1);
    assert.deepEqual(updates(harness.calls)[0], {
      tabId: 7,
      message: { type: 'UPDATE_AUDIO', settings: SLOWED, enabled: true }
    });
    assert.deepEqual(harness.session.data.tabState[7], {
      url: 'https://example.com/watch/1',
      enabled: true,
      settings: SLOWED
    });
    assert.match(harness.calls.icons.at(-1).path[16], /icon16\.png$/);
  });

  test('turns off an already active preset', async () => {
    const harness = setup({
      onTabMessage(_tabId, message) {
        return message.type === 'GET_STATE'
          ? { enabled: true, settings: { ...SLOWED, speed: 0.8005 } }
          : { success: true };
      }
    });

    await harness.events.command.emit('toggle-slowed-reverb');

    assert.equal(updates(harness.calls)[0].message.enabled, false);
    assert.match(harness.calls.icons.at(-1).path[16], /icon16-off\.png$/);
  });

  test('restores the last settings only on the same origin', async () => {
    const custom = { ...DEFAULT_SETTINGS, speed: 0.65, echo: 35 };
    const harness = setup({
      session: {
        tabState: {
          7: { url: 'https://example.com/previous', enabled: false, settings: custom }
        }
      },
      onTabMessage(_tabId, message) {
        return message.type === 'GET_STATE'
          ? { enabled: false, settings: DEFAULT_SETTINGS }
          : { success: true };
      }
    });

    await harness.events.command.emit('toggle-effect');
    assert.deepEqual(updates(harness.calls)[0].message.settings, custom);

    const crossOrigin = setup({
      activeTab: { id: 7, url: 'https://other.example/watch' },
      session: {
        tabState: {
          7: { url: 'https://example.com/previous', enabled: false, settings: custom }
        }
      },
      onTabMessage(_tabId, message) {
        return message.type === 'GET_STATE'
          ? { enabled: false, settings: DEFAULT_SETTINGS }
          : { success: true };
      }
    });

    await crossOrigin.events.command.emit('toggle-effect');
    assert.deepEqual(updates(crossOrigin.calls)[0].message.settings, SLOWED);
  });

  test('does nothing when the content script reports a blocked page', async () => {
    const harness = setup({
      onTabMessage(_tabId, message) {
        return message.type === 'GET_STATE' ? { blocked: true, blockReason: 'drm' } : null;
      }
    });

    await harness.events.command.emit('toggle-nightcore');

    assert.equal(updates(harness.calls).length, 0);
    assert.equal(harness.local.writes.length, 0);
  });

  test('tracks content state, answers recall requests, and forgets closed tabs', async () => {
    const harness = setup();
    const settings = { ...DEFAULT_SETTINGS, width: 160 };

    await dispatchRuntimeMessage(
      harness.events.runtimeMessage,
      {
        type: 'CONTENT_STATE_CHANGED',
        enabled: true,
        settings,
        url: 'https://example.com/watch/2'
      },
      { tab: { id: 7 } }
    );
    await flushPromises();

    assert.deepEqual(harness.session.data.tabState[7].settings, settings);
    assert.match(harness.calls.icons.at(-1).path[16], /icon16\.png$/);

    const recalled = await dispatchRuntimeMessage(
      harness.events.runtimeMessage,
      { type: 'GET_TAB_STATE', url: 'https://example.com/another' },
      { tab: { id: 7 } }
    );
    assert.deepEqual(recalled.settings, settings);

    await harness.events.tabRemoved.emit(7);
    assert.equal(harness.session.data.tabState[7], undefined);
  });

  test('updates the icon across tab loading and activation', async () => {
    const harness = setup({
      onTabMessage(_tabId, message) {
        return message.type === 'GET_STATE' ? { enabled: true, settings: SLOWED } : null;
      }
    });

    await harness.events.tabUpdated.emit(7, { status: 'loading' }, { url: 'https://example.com' });
    assert.match(harness.calls.icons.at(-1).path[16], /icon16-off\.png$/);

    await harness.events.tabUpdated.emit(
      7,
      { status: 'complete' },
      { url: 'https://example.com/watch' }
    );
    assert.match(harness.calls.icons.at(-1).path[16], /icon16\.png$/);

    await harness.events.tabActivated.emit({ tabId: 7 });
    assert.match(harness.calls.icons.at(-1).path[16], /icon16\.png$/);
  });
});
