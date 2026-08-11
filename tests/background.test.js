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
    activeTab: { id: 7, url: 'https://www.youtube.com/watch?v=one' },
    ...options
  });
  loadScript('background.js', { chrome: harness.api });
  return harness;
}

function updates(calls) {
  return calls.tabMessages.filter(({ message }) => message.type === 'UPDATE_AUDIO');
}

describe('background service worker', () => {
  test('registers Spotify hooks only while optional site access is granted', async () => {
    const harness = setup({
      activeTab: { id: 7, url: 'https://open.spotify.com/track/example' }
    });

    await harness.events.installed.emit();
    assert.equal(harness.registeredContentScripts.size, 0);

    await harness.api.permissions.request({ origins: ['https://open.spotify.com/*'] });
    await flushPromises();
    assert.deepEqual([...harness.registeredContentScripts.keys()].sort(), [
      'spotify-bridge',
      'spotify-main'
    ]);
    assert.equal(harness.registeredContentScripts.get('spotify-main').world, 'MAIN');
    assert.equal(harness.registeredContentScripts.get('spotify-main').runAt, 'document_start');

    await dispatchRuntimeMessage(
      harness.events.runtimeMessage,
      { type: 'SPOTIFY_BRIDGE_READY' },
      { tab: { id: 7, url: 'https://open.spotify.com/' } }
    );

    await harness.api.permissions.remove({ origins: ['https://open.spotify.com/*'] });
    await flushPromises();
    assert.equal(harness.registeredContentScripts.size, 0);
    assert.equal(
      harness.calls.tabMessages.some(
        ({ message }) => message.type === 'SPOTIFY_PERMISSION_REVOKED'
      ),
      true
    );
  });

  test('does not clear unrelated tab state after a tracked Spotify tab navigates away', async () => {
    const settings = { ...DEFAULT_SETTINGS, reverb: 25 };
    const harness = setup({
      activeTab: { id: 7, url: 'https://www.youtube.com/watch?v=example' },
      grantedOrigins: ['https://open.spotify.com/*'],
      session: {
        'tabState:7': {
          origin: 'https://www.youtube.com',
          enabled: true,
          settings
        }
      }
    });

    await dispatchRuntimeMessage(
      harness.events.runtimeMessage,
      { type: 'SPOTIFY_BRIDGE_READY' },
      { tab: { id: 7, url: 'https://open.spotify.com/' } }
    );
    await harness.api.permissions.remove({ origins: ['https://open.spotify.com/*'] });
    await flushPromises();

    assert.deepEqual(harness.session.data['tabState:7'], {
      origin: 'https://www.youtube.com',
      enabled: true,
      settings
    });
    assert.equal(
      harness.calls.tabMessages.some(
        ({ message }) => message.type === 'SPOTIFY_PERMISSION_REVOKED'
      ),
      false
    );
  });

  test('neutralizes remembered Spotify tabs after a service worker restart', async () => {
    const harness = setup({
      grantedOrigins: ['https://open.spotify.com/*'],
      session: {
        'tabState:7': {
          origin: 'https://open.spotify.com',
          enabled: true,
          settings: SLOWED
        }
      },
      onTabMessage() {
        return { success: true };
      }
    });

    await harness.api.permissions.remove({ origins: ['https://open.spotify.com/*'] });
    await flushPromises();

    assert.equal(
      harness.calls.tabMessages.some(
        ({ message }) => message.type === 'SPOTIFY_PERMISSION_REVOKED'
      ),
      true
    );
    assert.equal(harness.session.data['tabState:7'], undefined);
    assert.match(harness.calls.icons.at(-1).path[16], /icon16-off\.png$/);
  });

  test('reloads the active Spotify tab after optional access is granted', async () => {
    const harness = setup({
      activeTab: { id: 7, url: 'https://open.spotify.com/track/example' }
    });

    await harness.api.permissions.request({ origins: ['https://open.spotify.com/*'] });
    await flushPromises();

    assert.deepEqual(harness.calls.reloadedTabs, [7]);
    assert.deepEqual([...harness.registeredContentScripts.keys()].sort(), [
      'spotify-bridge',
      'spotify-main'
    ]);
  });

  test('routes an enabled Spotify tab through its early bridge', async () => {
    const harness = setup({
      activeTab: { id: 7, url: 'https://open.spotify.com/track/example' },
      grantedOrigins: ['https://open.spotify.com/*'],
      onTabMessage(_tabId, message) {
        return message.type === 'GET_STATE'
          ? { enabled: false, settings: DEFAULT_SETTINGS, blocked: false }
          : { success: true };
      }
    });

    await harness.events.command.emit('toggle-slowed-reverb');

    assert.equal(harness.calls.executeScript.length, 0);
    assert.equal(updates(harness.calls).length, 1);
    assert.equal(updates(harness.calls)[0].message.enabled, true);
  });

  test('does not inject into sites outside the release support list', async () => {
    for (const url of ['https://www.twitch.tv/example', 'https://studio.youtube.com/']) {
      const harness = setup({ activeTab: { id: 7, url } });

      await harness.events.command.emit('toggle-slowed-reverb');

      assert.equal(harness.calls.executeScript.length, 0);
      assert.equal(harness.calls.tabMessages.length, 0);
      assert.equal(harness.local.writes.length, 0);
    }
  });

  test('neutralizes a tracked YouTube tab when its optional permission is revoked', async () => {
    const harness = setup({
      grantedOrigins: ['https://www.youtube.com/*'],
      onTabMessage(_tabId, message) {
        if (message.type === 'GET_STATE') {
          return { enabled: false, settings: DEFAULT_SETTINGS, blocked: false };
        }
        return { success: true };
      }
    });

    await harness.events.command.emit('toggle-slowed-reverb');
    await harness.api.permissions.remove({ origins: ['https://www.youtube.com/*'] });
    await flushPromises();

    assert.equal(
      harness.calls.tabMessages.some(
        ({ message }) => message.type === 'YOUTUBE_PERMISSION_REVOKED'
      ),
      true
    );
    assert.equal(harness.session.data['tabState:7'], undefined);
    assert.match(harness.calls.icons.at(-1).path[16], /icon16-off\.png$/);
  });

  test('neutralizes remembered YouTube tabs after a service worker restart', async () => {
    const harness = setup({
      grantedOrigins: ['https://www.youtube.com/*'],
      session: {
        'tabState:7': {
          origin: 'https://www.youtube.com',
          enabled: true,
          settings: SLOWED
        }
      },
      onTabMessage() {
        return { success: true };
      }
    });

    await harness.api.permissions.remove({ origins: ['https://www.youtube.com/*'] });
    await flushPromises();

    assert.equal(
      harness.calls.tabMessages.some(
        ({ message }) => message.type === 'YOUTUBE_PERMISSION_REVOKED'
      ),
      true
    );
    assert.equal(harness.session.data['tabState:7'], undefined);
    assert.match(harness.calls.icons.at(-1).path[16], /icon16-off\.png$/);
  });

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
    assert.deepEqual(harness.session.data['tabState:7'], {
      origin: 'https://www.youtube.com',
      enabled: true,
      settings: SLOWED
    });
    assert.match(harness.calls.icons.at(-1).path[16], /icon16\.png$/);
  });

  test('keeps the toolbar icon off while a supported player is pending', async () => {
    const harness = setup({
      onTabMessage(_tabId, message) {
        return message.type === 'GET_STATE'
          ? { enabled: false, settings: DEFAULT_SETTINGS }
          : {
              success: true,
              playerDetected: false,
              processingActive: false,
              pending: true
            };
      }
    });

    await harness.events.command.emit('toggle-slowed-reverb');

    assert.equal(harness.session.data['tabState:7'].enabled, true);
    assert.match(harness.calls.icons.at(-1).path[16], /icon16-off\.png$/);
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
        'tabState:7': { origin: 'https://www.youtube.com', enabled: false, settings: custom }
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
      activeTab: { id: 7, url: 'https://music.youtube.com/watch?v=other' },
      session: {
        'tabState:7': { origin: 'https://www.youtube.com', enabled: false, settings: custom }
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
        origin: 'https://www.youtube.com'
      },
      { tab: { id: 7, url: 'https://www.youtube.com/watch?v=private' } }
    );
    await flushPromises();

    assert.deepEqual(harness.session.data['tabState:7'], {
      origin: 'https://www.youtube.com',
      enabled: true,
      settings
    });
    assert.match(harness.calls.icons.at(-1).path[16], /icon16\.png$/);

    const recalled = await dispatchRuntimeMessage(
      harness.events.runtimeMessage,
      { type: 'GET_TAB_STATE', url: 'https://www.youtube.com/watch?v=another' },
      { tab: { id: 7, url: 'https://www.youtube.com/watch?v=another' } }
    );
    assert.deepEqual({ ...recalled.settings }, settings);

    await harness.events.tabRemoved.emit(7);
    assert.equal(harness.session.data['tabState:7'], undefined);
  });

  test('rejects cross-tab actions from content scripts and normalizes reported settings', async () => {
    const harness = setup();

    const rejected = await dispatchRuntimeMessage(
      harness.events.runtimeMessage,
      {
        type: 'APPLY_TO_TAB',
        tabId: 99,
        url: 'https://www.youtube.com/watch?v=other',
        settings: SLOWED,
        enabled: true
      },
      { tab: { id: 7, url: 'https://www.youtube.com/watch?v=one' } }
    );

    assert.equal(rejected, undefined);
    assert.equal(harness.calls.tabMessages.length, 0);

    await dispatchRuntimeMessage(
      harness.events.runtimeMessage,
      {
        type: 'CONTENT_STATE_CHANGED',
        enabled: true,
        settings: {
          ...DEFAULT_SETTINGS,
          speed: 99,
          reverb: Number.POSITIVE_INFINITY,
          keepPitch: 'yes'
        }
      },
      { tab: { id: 7, url: 'https://www.youtube.com/watch?v=one' } }
    );
    await flushPromises();

    assert.equal(harness.session.data['tabState:7'].settings.speed, 1.5);
    assert.equal(harness.session.data['tabState:7'].settings.reverb, 0);
    assert.equal(harness.session.data['tabState:7'].settings.keepPitch, false);
  });

  test('allows packaged Chromium and Firefox popup messages with active-tab context', async () => {
    for (const popupUrl of [
      'chrome-extension://example/popup.html',
      'moz-extension://example/popup.html'
    ]) {
      const harness = setup({
        onTabMessage(_tabId, message) {
          return message.type === 'UPDATE_AUDIO' ? { success: true } : null;
        }
      });

      const response = await dispatchRuntimeMessage(
        harness.events.runtimeMessage,
        {
          type: 'APPLY_TO_TAB',
          tabId: 7,
          url: 'https://www.youtube.com/watch?v=one',
          settings: SLOWED,
          enabled: true
        },
      {
        id: 'example',
        url: popupUrl,
          tab: { id: 7, url: 'https://www.youtube.com/watch?v=one' }
        }
      );

      assert.equal(response.success, true, popupUrl);
      assert.equal(updates(harness.calls).length, 1, popupUrl);
    }
  });

  test('rejects a popup-shaped sender from a different extension', async () => {
    const harness = setup();

    const response = await dispatchRuntimeMessage(
      harness.events.runtimeMessage,
      {
        type: 'APPLY_TO_TAB',
        tabId: 7,
        url: 'https://www.youtube.com/watch?v=one',
        settings: SLOWED,
        enabled: true
      },
      { id: 'different-extension', url: 'chrome-extension://different-extension/popup.html' }
    );

    assert.equal(response, undefined);
    assert.equal(harness.calls.tabMessages.length, 0);
  });

  test('uses a validated reported origin when the browser omits the sender tab URL', async () => {
    const harness = setup();
    const settings = { ...DEFAULT_SETTINGS, pan: -50 };

    await dispatchRuntimeMessage(
      harness.events.runtimeMessage,
      {
        type: 'CONTENT_STATE_CHANGED',
        enabled: true,
        settings,
        origin: 'https://www.youtube.com'
      },
      { tab: { id: 7 } }
    );
    await flushPromises();

    const recalled = await dispatchRuntimeMessage(
      harness.events.runtimeMessage,
      { type: 'GET_TAB_STATE', url: 'https://www.youtube.com' },
      { tab: { id: 7 } }
    );

    assert.deepEqual({ ...recalled.settings }, settings);
  });

  test('updates the icon across tab loading and activation', async () => {
    const harness = setup({
      session: {
        'tabState:7': { origin: 'https://www.youtube.com', enabled: true, settings: SLOWED }
      },
      onTabMessage(_tabId, message) {
        return message.type === 'GET_STATE' ? { enabled: true, settings: SLOWED } : null;
      }
    });

    await harness.events.tabUpdated.emit(
      7,
      { status: 'loading' },
      { url: 'https://www.youtube.com' }
    );
    assert.match(harness.calls.icons.at(-1).path[16], /icon16-off\.png$/);

    await harness.events.tabUpdated.emit(
      7,
      { status: 'complete' },
      { url: 'https://www.youtube.com/watch?v=example' }
    );
    assert.match(harness.calls.icons.at(-1).path[16], /icon16\.png$/);

    await harness.events.tabActivated.emit({ tabId: 7 });
    assert.match(harness.calls.icons.at(-1).path[16], /icon16\.png$/);
  });

  test('does not inject on navigation when a tab has no enabled state to restore', async () => {
    const harness = setup();

    await harness.events.tabUpdated.emit(
      7,
      { status: 'complete' },
      { url: 'https://www.youtube.com/watch?v=example' }
    );
    await harness.events.tabActivated.emit({ tabId: 7 });

    assert.equal(harness.calls.executeScript.length, 0);
    assert.equal(harness.calls.tabMessages.length, 0);
    assert.match(harness.calls.icons.at(-1).path[16], /icon16-off\.png$/);
  });

  test('does not record activation when applying to the page fails', async () => {
    const harness = setup({
      onTabMessage(_tabId, message) {
        if (message.type === 'GET_STATE') {
          return { enabled: false, settings: DEFAULT_SETTINGS, blocked: false };
        }
        return null;
      }
    });

    await harness.events.command.emit('toggle-slowed-reverb');

    assert.equal(harness.local.writes.length, 0);
    assert.equal(harness.session.data['tabState:7'], undefined);
    assert.match(harness.calls.icons.at(-1).path[16], /icon16-off\.png$/);
  });

  test('serializes rapid applies and preserves the newest settings', async () => {
    const harness = setup({
      async onTabMessage(_tabId, message) {
        if (message.type !== 'UPDATE_AUDIO') return { enabled: false, settings: DEFAULT_SETTINGS };
        if (message.settings.reverb === 10) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { success: true };
      }
    });
    const first = { ...DEFAULT_SETTINGS, reverb: 10 };
    const second = { ...DEFAULT_SETTINGS, reverb: 80 };

    await Promise.all([
      harness.api.runtime.sendMessage({
        type: 'APPLY_TO_TAB',
        tabId: 7,
        url: 'https://www.youtube.com/watch?v=one',
        settings: first,
        enabled: true
      }),
      harness.api.runtime.sendMessage({
        type: 'APPLY_TO_TAB',
        tabId: 7,
        url: 'https://www.youtube.com/watch?v=two',
        settings: second,
        enabled: true
      })
    ]);

    assert.equal(updates(harness.calls).at(-1).message.settings.reverb, 80);
    assert.equal(harness.local.data.reverb, 80);
    assert.equal(harness.session.data['tabState:7'].settings.reverb, 80);
  });
});
