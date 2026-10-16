'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { dispatchRuntimeMessage, flushPromises } = require('./helpers/browser-api');
const { createPopupHarness } = require('./helpers/popup-harness');

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

function audioUpdates(harness) {
  return harness.calls.tabMessages.filter(({ message }) => message.type === 'UPDATE_AUDIO');
}

function close(harness) {
  harness.dom.window.close();
}

const SLOWED = { ...DEFAULT_SETTINGS, speed: 0.8, reverb: 40 };
const PRESET_BAR_KEY = 'presetBarLabel';

// Holds the tab's GET_STATE answer until the test releases it.
function deferredTabState() {
  let release;
  const answer = new Promise((resolve) => {
    release = resolve;
  });
  return {
    release,
    onTabMessage(_tabId, message) {
      return message.type === 'GET_STATE' ? answer : { success: true };
    }
  };
}

function presetBar(harness) {
  const document = harness.window.document;
  return {
    hidden: document.getElementById('current-preset-bar').hidden,
    label: document.getElementById('current-preset-label').textContent
  };
}

describe('popup behavior', () => {
  test('enables the primary preset on a fresh tab', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });

    assert.equal(harness.window.document.getElementById('power-toggle').checked, true);
    assert.equal(harness.window.document.getElementById('power-status').textContent, 'On');
    assert.equal(harness.window.document.getElementById('speed-slider').value, '0.8');
    assert.equal(harness.window.document.getElementById('reverb-slider').value, '40');
    assert.equal(audioUpdates(harness).at(-1).message.enabled, true);
    assert.equal(audioUpdates(harness).at(-1).message.settings.speed, 0.8);
    assert.equal(harness.session.data['tabState:9'].enabled, true);

    close(harness);
  });

  test('resets to the defaults and keeps a playing effect on', async () => {
    const settings = { ...SLOWED, echo: 25, eqLow: 4 };
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings, blocked: false, live: false }
    });
    const document = harness.window.document;

    document.getElementById('reset-btn').click();
    for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

    assert.equal(document.getElementById('power-toggle').checked, true);
    assert.equal(document.getElementById('power-status').textContent, 'On');
    assert.equal(document.getElementById('speed-slider').value, '1');
    assert.equal(document.getElementById('reverb-slider').value, '0');
    assert.deepEqual(presetBar(harness), { hidden: false, label: 'Current Preset: Default' });
    assert.equal(audioUpdates(harness).at(-1).message.enabled, true);
    assert.deepEqual(audioUpdates(harness).at(-1).message.settings, DEFAULT_SETTINGS);

    close(harness);
  });

  test('resets to the defaults and leaves an effect that is off turned off', async () => {
    const harness = await createPopupHarness({
      session: {
        'tabState:9': { origin: 'https://www.youtube.com', enabled: false, settings: { ...SLOWED, echo: 25 } }
      },
      contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    const document = harness.window.document;
    assert.equal(document.getElementById('power-toggle').checked, false);

    document.getElementById('reset-btn').click();
    for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

    assert.equal(document.getElementById('power-toggle').checked, false);
    assert.equal(document.getElementById('speed-slider').value, '1');
    assert.equal(presetBar(harness).hidden, true);

    close(harness);
  });

  test('shows settings that are already active in the tab', async () => {
    const settings = { ...DEFAULT_SETTINGS, speed: 1.15, echo: 25, width: 140 };
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings, blocked: false, live: false }
    });

    assert.equal(harness.window.document.getElementById('speed-slider').value, '1.15');
    assert.equal(harness.window.document.getElementById('echo-slider').value, '25');
    assert.equal(harness.window.document.getElementById('advanced-badge').hidden, false);
    assert.equal(audioUpdates(harness).length, 0);

    close(harness);
  });

  test('disables all effect controls and explains blocked pages', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: false, blocked: true, blockReason: 'unsupportedSite' }
    });
    const document = harness.window.document;

    assert.equal(document.getElementById('blocked-banner').hidden, false);
    assert.match(document.getElementById('blocked-banner-text').textContent, /isn't supported/);
    assert.equal(document.getElementById('power-toggle').disabled, true);
    assert.equal(document.getElementById('reverb-slider').disabled, true);
    assert.equal(document.getElementById('eq-handle-low').getAttribute('tabindex'), '-1');
    assert.equal(audioUpdates(harness).length, 0);

    close(harness);
  });

  test('does not inject outside the exact release support list', async () => {
    for (const url of ['https://www.twitch.tv/example', 'https://studio.youtube.com/']) {
      const harness = await createPopupHarness({ activeTab: { id: 9, url } });
      const document = harness.window.document;

      assert.equal(harness.calls.executeScript.length, 0);
      assert.equal(document.getElementById('power-toggle').checked, false);
      assert.equal(document.getElementById('power-toggle').disabled, true);
      assert.match(document.getElementById('blocked-banner-text').textContent, /YouTube/);

      close(harness);
    }
  });

  test('explains when a supported page is waiting for its player', async () => {
    const harness = await createPopupHarness({
      contentState: {
        enabled: true,
        settings: DEFAULT_SETTINGS,
        blocked: false,
        live: false,
        playerDetected: false,
        processingActive: false,
        pending: true
      }
    });
    const document = harness.window.document;

    assert.equal(document.getElementById('power-toggle').checked, true);
    assert.equal(document.getElementById('blocked-banner').hidden, false);
    assert.match(document.getElementById('blocked-banner-text').textContent, /Play a song/);

    close(harness);
  });

  test('shows a pending status when the initial preset starts before the player', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false },
      applyResult: {
        success: true,
        playerDetected: false,
        processingActive: false,
        pending: true
      }
    });
    const document = harness.window.document;

    assert.equal(audioUpdates(harness).at(-1).message.enabled, true);
    assert.equal(document.getElementById('blocked-banner').hidden, false);
    assert.match(document.getElementById('blocked-banner-text').textContent, /Play a song/);

    close(harness);
  });

  test('drops the loading warning once the tab reports the effect started', async () => {
    const loading = {
      enabled: true,
      settings: SLOWED,
      blocked: false,
      live: false,
      playerDetected: true,
      processingActive: false,
      pending: true
    };
    let tabState = loading;
    const harness = await createPopupHarness({
      onTabMessage(_tabId, message) {
        return message.type === 'GET_STATE' ? tabState : { success: true };
      }
    });
    const document = harness.window.document;
    const banner = document.getElementById('blocked-banner');
    assert.equal(banner.hidden, false);
    assert.match(document.getElementById('blocked-banner-text').textContent, /once the song loads/);

    const report = (tabId) =>
      dispatchRuntimeMessage(
        harness.events.runtimeMessage,
        {
          type: 'CONTENT_STATE_CHANGED',
          enabled: true,
          settings: SLOWED,
          origin: 'https://www.youtube.com',
          playerDetected: true,
          processingActive: true
        },
        { id: harness.api.runtime.id, tab: { id: tabId, url: 'https://www.youtube.com/watch?v=example' } }
      );

    tabState = { ...loading, processingActive: true, pending: false };
    // Another tab starting its effect says nothing about this one.
    await report(12);
    for (let attempt = 0; attempt < 4; attempt++) await flushPromises();
    assert.equal(banner.hidden, false);

    await report(9);
    for (let attempt = 0; attempt < 4; attempt++) await flushPromises();
    assert.equal(banner.hidden, true);
    assert.equal(document.getElementById('power-toggle').checked, true);

    close(harness);
  });

  test('asks again when the effect starts while its answer is on the way', async () => {
    const active = {
      enabled: true,
      settings: SLOWED,
      blocked: false,
      live: false,
      playerDetected: true,
      processingActive: true,
      pending: false
    };
    let tabState = active;
    // Only called after the popup has opened, once harness is set.
    function report() {
      return dispatchRuntimeMessage(
        harness.events.runtimeMessage,
        {
          type: 'CONTENT_STATE_CHANGED',
          enabled: true,
          settings: SLOWED,
          origin: 'https://www.youtube.com',
          playerDetected: true,
          processingActive: true
        },
        { id: harness.api.runtime.id, tab: { id: 9, url: 'https://www.youtube.com/watch?v=example' } }
      );
    }
    const harness = await createPopupHarness({
      onTabMessage(_tabId, message) {
        if (message.type === 'GET_STATE') return tabState;
        if (message.type !== 'UPDATE_AUDIO') return { success: true };
        if (!message.enabled) {
          tabState = { ...active, enabled: false, processingActive: false };
          return { success: true, ...tabState };
        }
        // The effect starts and the tab reports it before its own answer,
        // which still says "waiting", reaches the popup.
        tabState = active;
        report();
        return { success: true, ...active, processingActive: false, pending: true };
      }
    });
    const document = harness.window.document;
    const power = document.getElementById('power-toggle');
    const banner = document.getElementById('blocked-banner');

    power.checked = false;
    power.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    for (let attempt = 0; attempt < 5; attempt++) await flushPromises();
    power.checked = true;
    power.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    for (let attempt = 0; attempt < 8; attempt++) await flushPromises();

    assert.equal(power.checked, true);
    assert.equal(banner.hidden, true);

    close(harness);
  });

  test('requests exact optional YouTube access only in Firefox', async () => {
    const firefoxManifest = { browser_specific_settings: { gecko: {} } };
    const sites = [
      {
        url: 'https://www.youtube.com/watch?v=example',
        name: 'YouTube',
        origin: 'https://www.youtube.com/*'
      },
      {
        url: 'https://music.youtube.com/watch?v=example',
        name: 'YouTube Music',
        origin: 'https://music.youtube.com/*'
      }
    ];

    for (const site of sites) {
      const harness = await createPopupHarness({
        activeTab: { id: 9, url: site.url },
        manifest: firefoxManifest,
        contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
      });
      const document = harness.window.document;

      assert.equal(document.getElementById('youtube-permission-panel').hidden, false);
      assert.equal(document.getElementById('reload-panel').hidden, true);
      assert.equal(
        document.getElementById('youtube-permission-btn').textContent.trim(),
        `Allow on ${site.name}`
      );
      assert.equal(harness.calls.executeScript.length, 0);

      const callStart = harness.calls.order.length;
      document.getElementById('youtube-permission-btn').click();
      for (let attempt = 0; attempt < 6; attempt++) await flushPromises();

      assert.deepEqual(harness.calls.permissionRequests, [[site.origin]]);
      assert.deepEqual(harness.calls.order.slice(callStart, callStart + 2), [
        'permissions.request',
        'tabs.query'
      ]);
      assert.equal(document.getElementById('youtube-permission-panel').hidden, true);
      assert.equal(harness.calls.executeScript.length > 0, true);
      assert.equal(document.getElementById('power-toggle').checked, true);

      close(harness);
    }
  });

  test('keeps optional YouTube access out of the Chromium popup flow', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });

    assert.equal(harness.window.document.getElementById('youtube-permission-panel').hidden, true);
    assert.equal(harness.calls.permissionRequests.length, 0);
    assert.equal(harness.calls.executeScript.length > 0, true);

    close(harness);
  });

  test('keeps Firefox YouTube disabled when optional access is denied', async () => {
    const harness = await createPopupHarness({
      activeTab: { id: 9, url: 'https://www.youtube.com/watch?v=example' },
      manifest: { browser_specific_settings: { gecko: {} } },
      permissionRequestResult: false
    });
    const document = harness.window.document;

    document.getElementById('youtube-permission-btn').click();
    for (let attempt = 0; attempt < 4; attempt++) await flushPromises();

    assert.deepEqual(harness.calls.permissionRequests, [['https://www.youtube.com/*']]);
    assert.equal(document.getElementById('youtube-permission-panel').hidden, false);
    assert.match(document.getElementById('youtube-permission-status').textContent, /allow it any time/);
    assert.equal(harness.calls.executeScript.length, 0);

    close(harness);
  });

  test('offers Spotify as an optional permission without injecting into the page', async () => {
    const harness = await createPopupHarness({
      activeTab: { id: 9, url: 'https://open.spotify.com/track/example' }
    });
    const document = harness.window.document;

    assert.equal(document.getElementById('spotify-permission-panel').hidden, false);
    assert.equal(document.getElementById('spotify-permission-btn').textContent.trim(), 'Allow on Spotify');
    assert.equal(document.getElementById('power-toggle').disabled, true);
    assert.equal(harness.calls.executeScript.length, 0);
    assert.equal(harness.calls.permissionRequests.length, 0);

    close(harness);
  });

  test('grants Spotify access only after confirmation and reloads the tab', async () => {
    const harness = await createPopupHarness({
      activeTab: { id: 9, url: 'https://open.spotify.com/track/example' }
    });

    const callStart = harness.calls.order.length;
    harness.window.document.getElementById('spotify-permission-btn').click();
    for (let attempt = 0; attempt < 8; attempt++) await flushPromises();

    assert.deepEqual(harness.calls.permissionRequests, [['https://open.spotify.com/*']]);
    assert.deepEqual(harness.calls.order.slice(callStart, callStart + 2), [
      'permissions.request',
      'tabs.query'
    ]);
    assert.deepEqual([...harness.registeredContentScripts.keys()].sort(), [
      'spotify-bridge',
      'spotify-main'
    ]);
    assert.deepEqual(harness.calls.reloadedTabs, [9]);
    assert.equal(
      harness.window.document.getElementById('spotify-permission-panel').hidden,
      true
    );
    assert.equal(harness.window.document.getElementById('power-toggle').disabled, false);

    close(harness);
  });

  test('keeps Spotify disabled when optional permission is denied', async () => {
    const harness = await createPopupHarness({
      activeTab: { id: 9, url: 'https://open.spotify.com/track/example' },
      permissionRequestResult: false
    });

    harness.window.document.getElementById('spotify-permission-btn').click();
    for (let attempt = 0; attempt < 4; attempt++) await flushPromises();

    assert.equal(harness.calls.reloadedTabs.length, 0);
    assert.equal(harness.registeredContentScripts.size, 0);
    assert.match(
      harness.window.document.getElementById('spotify-permission-status').textContent,
      /allow it any time/
    );

    close(harness);
  });

  test('pins speed and pitch controls while live media is active', async () => {
    const harness = await createPopupHarness({
      contentState: {
        enabled: true,
        settings: { ...DEFAULT_SETTINGS, speed: 0.7, keepPitch: true, reverb: 50 },
        blocked: false,
        live: true
      }
    });
    const document = harness.window.document;

    assert.equal(document.getElementById('speed-slider').value, '1');
    assert.equal(document.getElementById('speed-slider').disabled, true);
    assert.equal(document.getElementById('speed-value').textContent, '(unavailable while live)');
    assert.equal(document.getElementById('keep-pitch-toggle').checked, false);
    assert.equal(document.getElementById('keep-pitch-toggle').disabled, true);
    assert.equal(document.getElementById('reverb-slider').value, '50');

    close(harness);
  });

  test('saves and sends slider changes immediately', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    const slider = harness.window.document.getElementById('reverb-slider');

    slider.value = '55';
    slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await flushPromises();

    assert.equal(harness.local.data.reverb, 55);
    assert.equal(audioUpdates(harness).at(-1).message.settings.reverb, 55);
    assert.equal(audioUpdates(harness).at(-1).message.enabled, true);
    assert.equal(harness.window.document.getElementById('reverb-value').textContent, '(55%)');

    close(harness);
  });

  test('creates, applies, edits, and deletes custom presets', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    const document = harness.window.document;

    document.getElementById('preset-name-input').value = 'Late Night';
    document.getElementById('save-preset-btn').click();
    await flushPromises();

    assert.equal(harness.local.data.customPresets.length, 1);
    assert.equal(harness.local.data.customPresets[0].name, 'Late Night');
    assert.equal(document.querySelector('.custom-preset-btn').textContent, 'Late Night');

    document.querySelector('.custom-preset-btn').click();
    await flushPromises();
    assert.equal(audioUpdates(harness).at(-1).message.enabled, true);

    document.querySelector('.edit-preset-btn').click();
    const nameInput = document.querySelector('.custom-preset-name-input');
    nameInput.value = 'After Hours';
    document.querySelector('.confirm-preset-btn').click();
    await flushPromises();
    assert.equal(harness.local.data.customPresets[0].name, 'After Hours');

    document.querySelector('.delete-preset-btn').click();
    await flushPromises();
    assert.deepEqual(harness.local.data.customPresets, []);
    assert.match(document.querySelector('.custom-presets-empty').textContent, /No saved presets/);

    close(harness);
  });

  test('starts on the Glow theme, listed first, until another is picked', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    const document = harness.window.document;

    assert.equal(document.documentElement.getAttribute('data-theme'), 'glow');
    assert.equal(harness.local.data.uiTheme, undefined);
    const options = [...document.querySelectorAll('.theme-option')];
    assert.deepEqual(options.map((option) => option.dataset.theme), ['glow', 'pink', 'midnight', 'paper', 'frost']);
    assert.ok(options[0].classList.contains('active'));

    close(harness);
  });

  test('persists theme selection and closes the picker with Escape', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    const document = harness.window.document;

    document.getElementById('theme-picker-btn').click();
    assert.equal(document.getElementById('theme-panel').hidden, false);

    document.querySelector('[data-theme="midnight"]').click();
    assert.equal(harness.local.data.uiTheme, 'midnight');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'midnight');

    document.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(document.getElementById('theme-panel').hidden, true);

    close(harness);
  });

  test('supports keyboard control of the equalizer', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    const handle = harness.window.document.getElementById('eq-handle-high');

    handle.dispatchEvent(
      new harness.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })
    );
    await flushPromises();

    assert.equal(handle.getAttribute('aria-valuenow'), '12');
    assert.equal(harness.window.document.getElementById('eq-high-value').textContent, '+12dB');
    assert.equal(audioUpdates(harness).at(-1).message.settings.eqHigh, 12);

    close(harness);
  });

  test('exposes named controls and keyboard-operable tabs', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    const document = harness.window.document;
    const presetsTab = document.getElementById('tab-presets');
    const customTab = document.getElementById('tab-custom');

    assert.equal(document.getElementById('power-toggle').getAttribute('aria-label'), 'Toggle audio effects');
    assert.equal(presetsTab.getAttribute('aria-selected'), 'true');
    customTab.dispatchEvent(
      new harness.window.KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
        cancelable: true
      })
    );
    assert.equal(presetsTab.getAttribute('aria-selected'), 'true');

    presetsTab.dispatchEvent(
      new harness.window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true
      })
    );
    assert.equal(customTab.getAttribute('aria-selected'), 'true');
    assert.equal(document.getElementById('panel-custom').hidden, false);
    assert.equal(presetsTab.tabIndex, -1);
    assert.equal(customTab.tabIndex, 0);

    close(harness);
  });

  test('shows an unsupported-page state when injection is rejected', async () => {
    const harness = await createPopupHarness({ executeScriptError: new Error('restricted page') });
    const document = harness.window.document;

    assert.equal(document.getElementById('blocked-banner').hidden, true);
    assert.equal(document.getElementById('reload-panel').hidden, false);
    assert.match(document.getElementById('reload-panel').textContent, /can't start on this page/);
    assert.equal(document.getElementById('power-toggle').checked, false);
    assert.equal(document.getElementById('power-toggle').disabled, true);
    assert.equal(audioUpdates(harness).length, 0);

    close(harness);
  });

  test('opens with the last preset label before the tab answers', async () => {
    const tabState = deferredTabState();
    const harness = await createPopupHarness({
      localStorage: { [PRESET_BAR_KEY]: 'Current Preset: Nightcore' },
      onTabMessage: tabState.onTabMessage
    });

    assert.deepEqual(presetBar(harness), { hidden: false, label: 'Current Preset: Nightcore' });
    // The switch opens on too, rather than flipping on once the tab answers.
    assert.equal(harness.window.document.getElementById('power-toggle').checked, true);
    assert.equal(harness.window.document.getElementById('power-status').textContent, 'On');

    tabState.release({ enabled: true, settings: SLOWED, blocked: false, live: false });
    for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

    assert.deepEqual(presetBar(harness), {
      hidden: false,
      label: 'Current Preset: Slowed + Reverb'
    });
    assert.equal(
      harness.window.localStorage.getItem(PRESET_BAR_KEY),
      'Current Preset: Slowed + Reverb'
    );

    close(harness);
  });

  test('reloads a page whose player the extension cannot reach', async () => {
    let reachable = false;
    const harness = await createPopupHarness({
      onTabMessage(_tabId, message) {
        if (message.type !== 'GET_STATE') return { success: true };
        return reachable
          ? { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
          : { enabled: false, blocked: true, blockReason: 'unsupported' };
      }
    });
    const document = harness.window.document;
    assert.equal(document.getElementById('reload-panel').hidden, false);
    assert.equal(document.getElementById('power-toggle').disabled, true);

    reachable = true;
    document.getElementById('reload-btn').click();
    for (let attempt = 0; attempt < 8; attempt++) await flushPromises();

    assert.deepEqual(harness.calls.reloadedTabs, [9]);
    assert.equal(document.getElementById('reload-panel').hidden, true);
    assert.equal(document.getElementById('blocked-banner').hidden, true);
    assert.equal(document.getElementById('power-toggle').disabled, false);

    close(harness);
  });

  test('keeps other blocked reasons as a warning without a reload', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: false, blocked: true, blockReason: 'drm' }
    });
    const document = harness.window.document;

    assert.equal(document.getElementById('blocked-banner').hidden, false);
    assert.equal(document.getElementById('reload-panel').hidden, true);

    close(harness);
  });

  test('hides the remembered preset bar and forgets it on blocked pages', async () => {
    const tabState = deferredTabState();
    const harness = await createPopupHarness({
      localStorage: { [PRESET_BAR_KEY]: 'Current Preset: Nightcore' },
      onTabMessage: tabState.onTabMessage
    });

    tabState.release({ enabled: false, blocked: true, blockReason: 'drm' });
    for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

    assert.equal(presetBar(harness).hidden, true);
    assert.equal(harness.window.document.getElementById('power-toggle').checked, false);
    assert.equal(harness.window.localStorage.getItem(PRESET_BAR_KEY), null);

    close(harness);
  });

  test('forgets the preset bar when the effect is turned off', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: SLOWED, blocked: false, live: false }
    });
    const power = harness.window.document.getElementById('power-toggle');

    assert.equal(
      harness.window.localStorage.getItem(PRESET_BAR_KEY),
      'Current Preset: Slowed + Reverb'
    );

    power.checked = false;
    power.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

    assert.equal(presetBar(harness).hidden, true);
    assert.equal(harness.window.localStorage.getItem(PRESET_BAR_KEY), null);

    close(harness);
  });

  test('keeps the preset bar hidden until the first answer when nothing is remembered', async () => {
    const tabState = deferredTabState();
    const harness = await createPopupHarness({ onTabMessage: tabState.onTabMessage });

    assert.equal(presetBar(harness).hidden, true);

    tabState.release({ enabled: true, settings: SLOWED, blocked: false, live: false });
    for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

    assert.deepEqual(presetBar(harness), {
      hidden: false,
      label: 'Current Preset: Slowed + Reverb'
    });
    assert.equal(
      harness.window.localStorage.getItem(PRESET_BAR_KEY),
      'Current Preset: Slowed + Reverb'
    );

    close(harness);
  });

  test('shows the preset bar when local storage is unavailable', async () => {
    const harness = await createPopupHarness({
      localStorageUnavailable: true,
      contentState: { enabled: true, settings: SLOWED, blocked: false, live: false }
    });

    assert.deepEqual(presetBar(harness), {
      hidden: false,
      label: 'Current Preset: Slowed + Reverb'
    });

    close(harness);
  });

  test('keeps the newest value after rapid slider changes', async () => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false },
      async onTabMessage(_tabId, message) {
        if (message.type === 'GET_STATE') {
          return { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false };
        }
        if (message.settings.reverb === 10) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { success: true };
      }
    });
    const slider = harness.window.document.getElementById('reverb-slider');

    slider.value = '10';
    slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    slider.value = '80';
    slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(audioUpdates(harness).at(-1).message.settings.reverb, 80);
    assert.equal(harness.local.data.reverb, 80);
    assert.equal(harness.session.data['tabState:9'].settings.reverb, 80);

    close(harness);
  });

  describe('rating', () => {
    const PLAYING = { enabled: true, settings: SLOWED, blocked: false, live: false };
    const today = () => {
      const date = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    const ratePrompt = (harness) => harness.window.document.getElementById('rate-prompt');

    test('links to the store the build came from', async () => {
      const chromium = await createPopupHarness({ contentState: PLAYING });
      assert.match(
        chromium.window.document.getElementById('rate-link').href,
        /^https:\/\/chromewebstore\.google\.com\/detail\/slowed-reverb\/[a-z]+\/reviews$/
      );
      close(chromium);

      const firefox = await createPopupHarness({
        contentState: PLAYING,
        manifest: { browser_specific_settings: { gecko: {} } },
        grantedOrigins: ['https://www.youtube.com/*']
      });
      for (const id of ['rate-link', 'rate-prompt-link']) {
        assert.equal(
          firefox.window.document.getElementById(id).href,
          'https://addons.mozilla.org/firefox/addon/slowed-reverb/'
        );
      }
      close(firefox);
    });

    test('counts each day once and asks on the fifth', async () => {
      const sameDay = await createPopupHarness({
        contentState: PLAYING,
        local: { ratingPrompt: { days: 4, lastDay: today(), done: false } }
      });
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();
      assert.equal(ratePrompt(sameDay).hidden, true);
      assert.equal(sameDay.local.data.ratingPrompt.days, 4);
      close(sameDay);

      const fifthDay = await createPopupHarness({
        contentState: PLAYING,
        local: { ratingPrompt: { days: 4, lastDay: '2000-01-01', done: false } }
      });
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();
      assert.equal(ratePrompt(fifthDay).hidden, false);
      assert.deepEqual(fifthDay.local.data.ratingPrompt, { days: 5, lastDay: today(), done: false });
      close(fifthDay);
    });

    test('does not count a day when the effect is off', async () => {
      const harness = await createPopupHarness({
        session: {
          'tabState:9': { origin: 'https://www.youtube.com', enabled: false, settings: SLOWED }
        },
        contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false },
        local: { ratingPrompt: { days: 4, lastDay: '2000-01-01', done: false } }
      });
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();

      assert.equal(ratePrompt(harness).hidden, true);
      assert.equal(harness.local.data.ratingPrompt.days, 4);

      close(harness);
    });

    test('stops asking once answered', async () => {
      const harness = await createPopupHarness({
        contentState: PLAYING,
        local: { ratingPrompt: { days: 7, lastDay: '2000-01-01', done: false } }
      });
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();
      assert.equal(ratePrompt(harness).hidden, false);

      harness.window.document.getElementById('rate-prompt-dismiss').click();
      await flushPromises();
      assert.equal(ratePrompt(harness).hidden, true);
      assert.equal(harness.local.data.ratingPrompt.done, true);
      close(harness);

      const later = await createPopupHarness({
        contentState: PLAYING,
        local: { ratingPrompt: { days: 8, lastDay: '2000-01-01', done: true } }
      });
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();
      assert.equal(ratePrompt(later).hidden, true);
      assert.equal(later.local.data.ratingPrompt.days, 8);
      close(later);
    });
  });
});
