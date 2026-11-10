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
  test('enables the primary preset on a fresh tab', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    t.after(() => close(harness));

    assert.equal(harness.window.document.getElementById('power-toggle').checked, true);
    assert.equal(harness.window.document.getElementById('power-status').textContent, 'On');
    assert.equal(harness.window.document.getElementById('speed-slider').value, '0.8');
    assert.equal(harness.window.document.getElementById('reverb-slider').value, '40');
    assert.equal(audioUpdates(harness).at(-1).message.enabled, true);
    assert.equal(audioUpdates(harness).at(-1).message.settings.speed, 0.8);
    assert.equal(harness.session.data['tabState:9'].enabled, true);
  });

  test('resets to the defaults and keeps a playing effect on', async (t) => {
    const settings = { ...SLOWED, echo: 25, eqLow: 4 };
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings, blocked: false, live: false }
    });
    t.after(() => close(harness));
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
  });

  test('resets to the defaults and leaves an effect that is off turned off', async (t) => {
    const harness = await createPopupHarness({
      session: {
        'tabState:9': { origin: 'https://www.youtube.com', enabled: false, settings: { ...SLOWED, echo: 25 } }
      },
      contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    t.after(() => close(harness));
    const document = harness.window.document;
    assert.equal(document.getElementById('power-toggle').checked, false);

    document.getElementById('reset-btn').click();
    for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

    assert.equal(document.getElementById('power-toggle').checked, false);
    assert.equal(document.getElementById('speed-slider').value, '1');
    assert.equal(presetBar(harness).hidden, true);
  });

  test('shows settings that are already active in the tab', async (t) => {
    const settings = { ...DEFAULT_SETTINGS, speed: 1.15, echo: 25, width: 140 };
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings, blocked: false, live: false }
    });
    t.after(() => close(harness));

    assert.equal(harness.window.document.getElementById('speed-slider').value, '1.15');
    assert.equal(harness.window.document.getElementById('echo-slider').value, '25');
    assert.equal(harness.window.document.getElementById('advanced-badge').hidden, false);
    assert.equal(audioUpdates(harness).length, 0);
  });

  test('disables all effect controls and explains blocked pages', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: false, blocked: true, blockReason: 'unsupportedSite' }
    });
    t.after(() => close(harness));
    const document = harness.window.document;

    assert.equal(document.getElementById('blocked-banner').hidden, false);
    assert.match(document.getElementById('blocked-banner-text').textContent, /isn't supported/);
    assert.equal(document.getElementById('power-toggle').disabled, true);
    assert.equal(document.getElementById('reverb-slider').disabled, true);
    assert.equal(document.getElementById('eq-handle-low').getAttribute('tabindex'), '-1');
    assert.equal(audioUpdates(harness).length, 0);
  });

  test('does not inject outside the exact release support list', async (t) => {
    // Also a host named like an object's built-in property, and YouTube
    // without HTTPS.
    for (const url of ['https://www.twitch.tv/example', 'https://studio.youtube.com/', 'https://constructor/', 'http://www.youtube.com/watch?v=one']) {
      const harness = await createPopupHarness({ activeTab: { id: 9, url } });
      t.after(() => close(harness));
      const document = harness.window.document;

      assert.equal(harness.calls.executeScript.length, 0);
      assert.equal(document.getElementById('power-toggle').checked, false);
      assert.equal(document.getElementById('power-toggle').disabled, true);
      assert.match(document.getElementById('blocked-banner-text').textContent, /YouTube/);
    }
  });

  test('explains when a supported page is waiting for its player', async (t) => {
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
    t.after(() => close(harness));
    const document = harness.window.document;

    assert.equal(document.getElementById('power-toggle').checked, true);
    assert.equal(document.getElementById('blocked-banner').hidden, false);
    assert.match(document.getElementById('blocked-banner-text').textContent, /Play a song/);
  });

  test('shows a pending status when the initial preset starts before the player', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false },
      applyResult: {
        success: true,
        playerDetected: false,
        processingActive: false,
        pending: true
      }
    });
    t.after(() => close(harness));
    const document = harness.window.document;

    assert.equal(audioUpdates(harness).at(-1).message.enabled, true);
    assert.equal(document.getElementById('blocked-banner').hidden, false);
    assert.match(document.getElementById('blocked-banner-text').textContent, /Play a song/);
  });

  test('drops the loading warning once the tab reports the effect started', async (t) => {
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
    t.after(() => close(harness));
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
  });

  test('asks again when the effect starts while its answer is on the way', async (t) => {
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
    t.after(() => close(harness));
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
  });

  test('requests exact optional YouTube access only in Firefox', async (t) => {
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
      t.after(() => close(harness));
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
    }
  });

  test('keeps optional YouTube access out of the Chromium popup flow', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    t.after(() => close(harness));

    assert.equal(harness.window.document.getElementById('youtube-permission-panel').hidden, true);
    assert.equal(harness.calls.permissionRequests.length, 0);
    assert.equal(harness.calls.executeScript.length > 0, true);
  });

  test('keeps Firefox YouTube disabled when optional access is denied', async (t) => {
    const harness = await createPopupHarness({
      activeTab: { id: 9, url: 'https://www.youtube.com/watch?v=example' },
      manifest: { browser_specific_settings: { gecko: {} } },
      permissionRequestResult: false
    });
    t.after(() => close(harness));
    const document = harness.window.document;

    document.getElementById('youtube-permission-btn').click();
    for (let attempt = 0; attempt < 4; attempt++) await flushPromises();

    assert.deepEqual(harness.calls.permissionRequests, [['https://www.youtube.com/*']]);
    assert.equal(document.getElementById('youtube-permission-panel').hidden, false);
    assert.match(document.getElementById('youtube-permission-status').textContent, /allow it any time/);
    assert.equal(harness.calls.executeScript.length, 0);
  });

  test('offers Spotify as an optional permission without injecting into the page', async (t) => {
    const harness = await createPopupHarness({
      activeTab: { id: 9, url: 'https://open.spotify.com/track/example' }
    });
    t.after(() => close(harness));
    const document = harness.window.document;

    assert.equal(document.getElementById('spotify-permission-panel').hidden, false);
    assert.equal(document.getElementById('spotify-permission-btn').textContent.trim(), 'Allow on Spotify');
    assert.equal(document.getElementById('power-toggle').disabled, true);
    assert.equal(harness.calls.executeScript.length, 0);
    assert.equal(harness.calls.permissionRequests.length, 0);
  });

  test('grants Spotify access only after confirmation and reloads the tab', async (t) => {
    const harness = await createPopupHarness({
      activeTab: { id: 9, url: 'https://open.spotify.com/track/example' }
    });
    t.after(() => close(harness));

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
  });

  test('keeps Spotify disabled when optional permission is denied', async (t) => {
    const harness = await createPopupHarness({
      activeTab: { id: 9, url: 'https://open.spotify.com/track/example' },
      permissionRequestResult: false
    });
    t.after(() => close(harness));

    harness.window.document.getElementById('spotify-permission-btn').click();
    for (let attempt = 0; attempt < 4; attempt++) await flushPromises();

    assert.equal(harness.calls.reloadedTabs.length, 0);
    assert.equal(harness.registeredContentScripts.size, 0);
    assert.match(
      harness.window.document.getElementById('spotify-permission-status').textContent,
      /allow it any time/
    );
  });

  test('pins speed and pitch controls while live media is active', async (t) => {
    const harness = await createPopupHarness({
      contentState: {
        enabled: true,
        settings: { ...DEFAULT_SETTINGS, speed: 0.7, keepPitch: true, reverb: 50 },
        blocked: false,
        live: true
      }
    });
    t.after(() => close(harness));
    const document = harness.window.document;

    assert.equal(document.getElementById('speed-slider').value, '1');
    assert.equal(document.getElementById('speed-slider').disabled, true);
    assert.equal(document.getElementById('speed-value').textContent, '(unavailable while live)');
    assert.equal(document.getElementById('keep-pitch-toggle').checked, false);
    assert.equal(document.getElementById('keep-pitch-toggle').disabled, true);
    assert.equal(document.getElementById('reverb-slider').value, '50');
  });

  test('saves and sends slider changes immediately', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    t.after(() => close(harness));
    const slider = harness.window.document.getElementById('reverb-slider');

    slider.value = '55';
    slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await flushPromises();

    assert.equal(harness.local.data.reverb, 55);
    assert.equal(audioUpdates(harness).at(-1).message.settings.reverb, 55);
    assert.equal(audioUpdates(harness).at(-1).message.enabled, true);
    assert.equal(harness.window.document.getElementById('reverb-value').textContent, '(55%)');
  });

  test('creates, applies, edits, and deletes custom presets', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    t.after(() => close(harness));
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
  });

  test('starts on the Glow theme, listed first, until another is picked', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    t.after(() => close(harness));
    const document = harness.window.document;

    assert.equal(document.documentElement.getAttribute('data-theme'), 'glow');
    assert.equal(harness.local.data.uiTheme, undefined);
    const options = [...document.querySelectorAll('.theme-option')];
    assert.deepEqual(options.map((option) => option.dataset.theme), ['glow', 'pink', 'midnight', 'paper', 'frost']);
    assert.ok(options[0].classList.contains('active'));
  });

  test('persists theme selection and closes the picker with Escape', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    t.after(() => close(harness));
    const document = harness.window.document;

    document.getElementById('theme-picker-btn').click();
    assert.equal(document.getElementById('theme-panel').hidden, false);

    document.querySelector('[data-theme="midnight"]').click();
    assert.equal(harness.local.data.uiTheme, 'midnight');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'midnight');

    document.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(document.getElementById('theme-panel').hidden, true);
  });

  test('supports keyboard control of the equalizer', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    t.after(() => close(harness));
    const handle = harness.window.document.getElementById('eq-handle-high');

    handle.dispatchEvent(
      new harness.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })
    );
    await flushPromises();

    assert.equal(handle.getAttribute('aria-valuenow'), '12');
    assert.equal(harness.window.document.getElementById('eq-high-value').textContent, '+12dB');
    assert.equal(audioUpdates(harness).at(-1).message.settings.eqHigh, 12);
  });

  test('exposes named controls and keyboard-operable tabs', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: DEFAULT_SETTINGS, blocked: false, live: false }
    });
    t.after(() => close(harness));
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
  });

  test('shows an unsupported-page state when injection is rejected', async (t) => {
    const harness = await createPopupHarness({ executeScriptError: new Error('restricted page') });
    t.after(() => close(harness));
    const document = harness.window.document;

    assert.equal(document.getElementById('blocked-banner').hidden, true);
    assert.equal(document.getElementById('reload-panel').hidden, false);
    assert.match(document.getElementById('reload-panel').textContent, /can't start on this page/);
    assert.equal(document.getElementById('power-toggle').checked, false);
    assert.equal(document.getElementById('power-toggle').disabled, true);
    assert.equal(audioUpdates(harness).length, 0);
  });

  test('opens with the last preset label before the tab answers', async (t) => {
    const tabState = deferredTabState();
    const harness = await createPopupHarness({
      localStorage: { [PRESET_BAR_KEY]: 'Current Preset: Nightcore' },
      onTabMessage: tabState.onTabMessage
    });
    t.after(() => close(harness));

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
  });

  test('reloads a page whose player the extension cannot reach', async (t) => {
    let reachable = false;
    const harness = await createPopupHarness({
      onTabMessage(_tabId, message) {
        if (message.type !== 'GET_STATE') return { success: true };
        return reachable
          ? { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
          : { enabled: false, blocked: true, blockReason: 'unsupported' };
      }
    });
    t.after(() => close(harness));
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
  });

  // After an update the page can still have the previous version's audio
  // engine, which content.js and the Spotify bridge keep off.
  const outdatedPages = [
    {
      site: 'YouTube',
      activeTab: { id: 9, url: 'https://www.youtube.com/watch?v=example' },
      grantedOrigins: [],
      text: 'Reload the page to finish updating the extension.',
      button: 'Reload page',
      progress: 'Reloading the page…'
    },
    {
      site: 'Spotify',
      activeTab: { id: 9, url: 'https://open.spotify.com/track/example' },
      grantedOrigins: ['https://open.spotify.com/*'],
      text: 'Reload Spotify to finish updating the extension.',
      button: 'Reload Spotify',
      progress: 'Reloading Spotify…'
    }
  ];
  for (const { site, activeTab, grantedOrigins, text, button, progress } of outdatedPages) {
    test(`asks for a reload when ${site} still has the previous version`, async (t) => {
      let updated = false;
      const harness = await createPopupHarness({
        activeTab,
        grantedOrigins,
        onTabMessage(_tabId, message) {
          if (message.type === 'GET_STATE') {
            return updated
              ? { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
              : { enabled: false, blocked: true, blockReason: 'outdated' };
          }
          return { success: true };
        }
      });
      t.after(() => close(harness));
      const document = harness.window.document;

      assert.equal(document.getElementById('blocked-banner').hidden, true);
      assert.equal(document.getElementById('reload-panel').hidden, false);
      assert.equal(document.getElementById('reload-text').textContent, text);
      assert.equal(document.getElementById('reload-btn').textContent, button);
      assert.equal(document.getElementById('power-toggle').disabled, true);
      assert.equal(audioUpdates(harness).length, 0);

      let shownWhileReloading = null;
      const reload = harness.api.tabs.reload;
      harness.api.tabs.reload = (tabId) => {
        shownWhileReloading = document.getElementById('reload-status').textContent;
        updated = true;
        return reload(tabId);
      };
      document.getElementById('reload-btn').click();
      for (let attempt = 0; attempt < 8; attempt++) await flushPromises();

      assert.equal(shownWhileReloading, progress);
      assert.deepEqual(harness.calls.reloadedTabs, [9]);
      assert.equal(document.getElementById('reload-panel').hidden, true);
      assert.equal(document.getElementById('power-toggle').disabled, false);
    });

    test(`asks for a reload when turning the effect on finds the previous version on ${site}`, async (t) => {
      const harness = await createPopupHarness({
        activeTab,
        grantedOrigins,
        onTabMessage(_tabId, message) {
          if (message.type === 'GET_STATE') {
            return { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false };
          }
          return { success: false, blocked: true, blockReason: 'outdated' };
        }
      });
      t.after(() => close(harness));
      const document = harness.window.document;

      // A fresh tab turns the effect on as the popup opens.
      assert.equal(audioUpdates(harness).at(-1).message.enabled, true);
      assert.equal(document.getElementById('reload-panel').hidden, false);
      assert.equal(document.getElementById('reload-text').textContent, text);
      assert.equal(document.getElementById('reload-btn').textContent, button);
      assert.equal(document.getElementById('power-toggle').checked, false);
    });
  }

  test('keeps other blocked reasons as a warning without a reload', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: false, blocked: true, blockReason: 'drm' }
    });
    t.after(() => close(harness));
    const document = harness.window.document;

    assert.equal(document.getElementById('blocked-banner').hidden, false);
    assert.equal(document.getElementById('reload-panel').hidden, true);
  });

  test('hides the remembered preset bar and forgets it on blocked pages', async (t) => {
    const tabState = deferredTabState();
    const harness = await createPopupHarness({
      localStorage: { [PRESET_BAR_KEY]: 'Current Preset: Nightcore' },
      onTabMessage: tabState.onTabMessage
    });
    t.after(() => close(harness));

    tabState.release({ enabled: false, blocked: true, blockReason: 'drm' });
    for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

    assert.equal(presetBar(harness).hidden, true);
    assert.equal(harness.window.document.getElementById('power-toggle').checked, false);
    assert.equal(harness.window.localStorage.getItem(PRESET_BAR_KEY), null);
  });

  test('forgets the preset bar when the effect is turned off', async (t) => {
    const harness = await createPopupHarness({
      contentState: { enabled: true, settings: SLOWED, blocked: false, live: false }
    });
    t.after(() => close(harness));
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
  });

  test('keeps the preset bar hidden until the first answer when nothing is remembered', async (t) => {
    const tabState = deferredTabState();
    const harness = await createPopupHarness({ onTabMessage: tabState.onTabMessage });
    t.after(() => close(harness));

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
  });

  test('shows the preset bar when local storage is unavailable', async (t) => {
    const harness = await createPopupHarness({
      localStorageUnavailable: true,
      contentState: { enabled: true, settings: SLOWED, blocked: false, live: false }
    });
    t.after(() => close(harness));

    assert.deepEqual(presetBar(harness), {
      hidden: false,
      label: 'Current Preset: Slowed + Reverb'
    });
  });

  test('keeps the newest value after rapid slider changes', async (t) => {
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
    t.after(() => close(harness));
    const slider = harness.window.document.getElementById('reverb-slider');

    slider.value = '10';
    slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    // Let 10 leave, so that 80 is a second message and not a change to the first.
    await flushPromises();
    slider.value = '80';
    slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    // The slow answer to 10 arrives during this wait, and the check is that
    // it changes nothing, so the wait is fixed.
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(audioUpdates(harness).at(-1).message.settings.reverb, 80);
    assert.equal(harness.local.data.reverb, 80);
    assert.equal(harness.session.data['tabState:9'].settings.reverb, 80);
  });

  describe('rating', () => {
    const PLAYING = { enabled: true, settings: SLOWED, blocked: false, live: false };
    const today = () => {
      const date = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    const ratePrompt = (harness) => harness.window.document.getElementById('rate-prompt');

    test('links to the store the build came from', async (t) => {
      const chromium = await createPopupHarness({ contentState: PLAYING });
      t.after(() => close(chromium));
      assert.match(
        chromium.window.document.getElementById('rate-link').href,
        /^https:\/\/chromewebstore\.google\.com\/detail\/slowed-reverb\/[a-z]+\/reviews$/
      );

      const firefox = await createPopupHarness({
        contentState: PLAYING,
        manifest: { browser_specific_settings: { gecko: {} } },
        grantedOrigins: ['https://www.youtube.com/*']
      });
      t.after(() => close(firefox));
      for (const id of ['rate-link', 'rate-prompt-link']) {
        assert.equal(
          firefox.window.document.getElementById(id).href,
          'https://addons.mozilla.org/firefox/addon/slowed-reverb/'
        );
      }
    });

    test('counts each day once and asks on the fifth', async (t) => {
      const sameDay = await createPopupHarness({
        contentState: PLAYING,
        local: { ratingPrompt: { days: 4, lastDay: today(), done: false } }
      });
      t.after(() => close(sameDay));
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();
      assert.equal(ratePrompt(sameDay).hidden, true);
      assert.equal(sameDay.local.data.ratingPrompt.days, 4);

      const fifthDay = await createPopupHarness({
        contentState: PLAYING,
        local: { ratingPrompt: { days: 4, lastDay: '2000-01-01', done: false } }
      });
      t.after(() => close(fifthDay));
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();
      assert.equal(ratePrompt(fifthDay).hidden, false);
      assert.deepEqual(fifthDay.local.data.ratingPrompt, { days: 5, lastDay: today(), done: false });
    });

    test('does not count a day when the effect is off', async (t) => {
      const harness = await createPopupHarness({
        session: {
          'tabState:9': { origin: 'https://www.youtube.com', enabled: false, settings: SLOWED }
        },
        contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false },
        local: { ratingPrompt: { days: 4, lastDay: '2000-01-01', done: false } }
      });
      t.after(() => close(harness));
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();

      assert.equal(ratePrompt(harness).hidden, true);
      assert.equal(harness.local.data.ratingPrompt.days, 4);
    });

    test('stays answered when the answer comes while the day count is still loading', async (t) => {
      const tabState = deferredTabState();
      const harness = await createPopupHarness({
        onTabMessage: tabState.onTabMessage,
        local: { ratingPrompt: { days: 4, lastDay: '2000-01-01', done: false } }
      });
      t.after(() => close(harness));
      // The popup reads the day count, but the answer to that read arrives
      // only after the click, still holding what was stored before it.
      let releaseRead = null;
      const readNow = harness.local.get.bind(harness.local);
      harness.local.get = async (query) => {
        const stored = await readNow(query);
        if (query === 'ratingPrompt') await new Promise((resolve) => { releaseRead = resolve; });
        return stored;
      };

      tabState.release(PLAYING);
      for (let attempt = 0; attempt < 5; attempt++) await flushPromises();
      assert.equal(typeof releaseRead, 'function');

      harness.window.document.getElementById('rate-prompt-dismiss').click();
      releaseRead();
      for (let attempt = 0; attempt < 5; attempt++) await flushPromises();

      assert.equal(ratePrompt(harness).hidden, true);
      assert.equal(harness.local.data.ratingPrompt.done, true);
    });

    test('does not count a day in a private window', async (t) => {
      const harness = await createPopupHarness({
        activeTab: { id: 9, url: 'https://www.youtube.com/watch?v=example', incognito: true },
        contentState: PLAYING,
        local: { ratingPrompt: { days: 4, lastDay: '2000-01-01', done: false } }
      });
      t.after(() => close(harness));
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();

      assert.equal(ratePrompt(harness).hidden, true);
      assert.deepEqual(harness.local.data.ratingPrompt, { days: 4, lastDay: '2000-01-01', done: false });
    });

    test('stops asking once answered', async (t) => {
      const harness = await createPopupHarness({
        contentState: PLAYING,
        local: { ratingPrompt: { days: 7, lastDay: '2000-01-01', done: false } }
      });
      t.after(() => close(harness));
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();
      assert.equal(ratePrompt(harness).hidden, false);

      harness.window.document.getElementById('rate-prompt-dismiss').click();
      await flushPromises();
      assert.equal(ratePrompt(harness).hidden, true);
      assert.equal(harness.local.data.ratingPrompt.done, true);

      const later = await createPopupHarness({
        contentState: PLAYING,
        local: { ratingPrompt: { days: 8, lastDay: '2000-01-01', done: true } }
      });
      t.after(() => close(later));
      for (let attempt = 0; attempt < 3; attempt++) await flushPromises();
      assert.equal(ratePrompt(later).hidden, true);
      assert.equal(later.local.data.ratingPrompt.days, 8);
    });
  });

  describe('finer speed control', () => {
    const FIREFOX = {
      manifest: { browser_specific_settings: { gecko: {} } },
      grantedOrigins: ['https://www.youtube.com/*']
    };
    const playingAt = (speed) => ({
      enabled: true,
      settings: { ...DEFAULT_SETTINGS, speed },
      blocked: false,
      live: false
    });
    const settle = async () => {
      for (let attempt = 0; attempt < 6; attempt++) await flushPromises();
    };
    const speedControls = (harness) => {
      const document = harness.window.document;
      return {
        slider: document.getElementById('speed-slider'),
        field: document.getElementById('speed-input'),
        down: document.getElementById('speed-down-btn'),
        up: document.getElementById('speed-up-btn'),
        stepper: document.getElementById('speed-stepper')
      };
    };
    // What the slider and the field show, and what the field is read out as.
    const shown = (harness) => {
      const { slider, field } = speedControls(harness);
      return [slider.value, field.value, field.getAttribute('aria-valuetext')];
    };
    const sentSpeeds = (harness) => audioUpdates(harness).map(({ message }) => message.settings.speed);
    // What the popup has handed to the browser so far, before any answer:
    // each change's speed and whether it turns the effect on.
    const appliesSent = (harness) => harness.calls.runtimeMessages
      .filter((message) => message.type === 'APPLY_TO_TAB')
      .map((message) => [message.settings.speed, message.enabled]);
    const press = (harness, element, key, init = {}) => {
      const event = new harness.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      element.dispatchEvent(event);
      return event;
    };
    const type = (harness, text) => {
      const { field } = speedControls(harness);
      field.value = text;
      press(harness, field, 'Enter');
    };
    const pointer = (harness, element, name, init = {}) =>
      element.dispatchEvent(new harness.window.MouseEvent(name, { bubbles: true, button: 0, ...init }));

    // Puts the popup's timers in the test's hands, so a hold or a wait takes
    // no real time and ends exactly when the test says.
    function fakeTimers(window) {
      let now = 0;
      let lastId = 0;
      const timers = new Map();
      window.setTimeout = (callback, delay = 0) => {
        timers.set(++lastId, { at: now + delay, callback });
        return lastId;
      };
      window.clearTimeout = (id) => {
        timers.delete(id);
      };
      return {
        advance(ms) {
          const end = now + ms;
          for (;;) {
            const [id, timer] = [...timers].filter(([, { at }]) => at <= end).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
            if (!timer) break;
            timers.delete(id);
            now = timer.at;
            timer.callback();
          }
          now = end;
        }
      };
    }

    // Holds each of the tab's answers to a change until the test lets it go,
    // with `{ success: true }` unless the test gives another answer.
    function slowTab(speed) {
      const answers = [];
      return {
        answers,
        onTabMessage(_tabId, message) {
          if (message.type === 'GET_STATE') return playingAt(speed);
          return new Promise((resolve) => {
            answers.push((answer = { success: true }) => resolve(answer));
          });
        }
      };
    }

    test('opens with the slider, the field and the buttons on the speed in use', async (t) => {
      const harness = await createPopupHarness({ contentState: playingAt(0.83) });
      t.after(() => close(harness));
      const { slider, field, down, up, stepper } = speedControls(harness);

      assert.deepEqual(shown(harness), ['0.83', '0.83', '0.83x']);
      assert.equal(field.getAttribute('aria-valuenow'), '0.83');
      assert.equal(slider.getAttribute('aria-valuetext'), '0.83x');
      // The field shows the speed, so the label doesn't repeat it.
      assert.equal(harness.window.document.getElementById('speed-value').textContent, '');
      assert.equal(stepper.hidden, false);
      assert.deepEqual([field.disabled, down.disabled, up.disabled], [false, false, false]);
      assert.equal(audioUpdates(harness).length, 0);

      // The slider can sit on any speed the field gives it, and the field
      // tells a screen reader the same range as the settings allow.
      const [minimum, maximum] = harness.window.SlowedReverbSettings.BOUNDS.speed;
      assert.equal(slider.step, '0.01');
      assert.deepEqual([Number(slider.min), Number(slider.max)], [minimum, maximum]);
      assert.deepEqual(
        [Number(field.getAttribute('aria-valuemin')), Number(field.getAttribute('aria-valuemax'))],
        [minimum, maximum]
      );
      assert.equal(field.getAttribute('aria-label'), 'Exact speed');
      assert.deepEqual([down.getAttribute('aria-label'), down.title], ['Slower by 0.01x', 'Slower by 0.01x']);
      assert.deepEqual([up.getAttribute('aria-label'), up.title], ['Faster by 0.01x', 'Faster by 0.01x']);
    });

    test('keeps the field with the slider through presets and Reset Defaults', async (t) => {
      const harness = await createPopupHarness({
        contentState: playingAt(0.83),
        local: { customPresets: [{ ...DEFAULT_SETTINGS, id: 'fine', name: 'Fine', speed: 0.97 }] }
      });
      t.after(() => close(harness));
      const document = harness.window.document;

      document.querySelector('[data-preset="nightcore"]').click();
      await settle();
      assert.deepEqual(shown(harness), ['1.2', '1.20', '1.20x']);

      document.querySelector('.custom-preset-btn').click();
      await settle();
      assert.deepEqual(shown(harness), ['0.97', '0.97', '0.97x']);
      assert.deepEqual(presetBar(harness), { hidden: false, label: 'Current Preset: Fine' });

      document.getElementById('reset-btn').click();
      await settle();
      assert.deepEqual(shown(harness), ['1', '1.00', '1.00x']);
      assert.deepEqual(sentSpeeds(harness), [1.2, 0.97, 1]);
    });

    test('takes a typed speed on Enter and when the field is left', async (t) => {
      const harness = await createPopupHarness({ contentState: playingAt(1) });
      t.after(() => close(harness));
      const { field } = speedControls(harness);

      type(harness, '0.83');
      await settle();
      assert.deepEqual(shown(harness), ['0.83', '0.83', '0.83x']);
      assert.equal(harness.local.data.speed, 0.83);
      assert.equal(harness.session.data['tabState:9'].settings.speed, 0.83);

      field.value = '1.07';
      // Nothing is sent while typing.
      field.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
      await settle();
      assert.deepEqual(sentSpeeds(harness), [0.83]);
      field.dispatchEvent(new harness.window.Event('blur'));
      await settle();
      assert.deepEqual(shown(harness), ['1.07', '1.07', '1.07x']);
      assert.deepEqual(sentSpeeds(harness), [0.83, 1.07]);
    });

    test('rounds a typed speed to two decimals and keeps it inside the range', async (t) => {
      const harness = await createPopupHarness({ contentState: playingAt(1) });
      t.after(() => close(harness));

      const typed = [
        ['0.834', 0.83],
        ['0.836', 0.84],
        // Halves round up, also the ones a computer stores as a little less.
        ['0.575', 0.58],
        ['1.005', 1.01],
        ['1.255', 1.26],
        ['0.845', 0.85],
        ['2', 1.5],
        ['0.1', 0.5],
        ['0,9', 0.9],
        ['-3', 0.5],
        ['.75', 0.75],
        ['1.', 1],
        [' 1.25x ', 1.25],
        ['+1.3', 1.3],
        ['99999', 1.5]
      ];
      for (const [text, speed] of typed) {
        type(harness, text);
        await settle();
        assert.deepEqual(
          shown(harness),
          [String(speed), speed.toFixed(2), `${speed.toFixed(2)}x`],
          `typing "${text}"`
        );
        assert.equal(sentSpeeds(harness).at(-1), speed, `typing "${text}"`);
      }
      // One message for each speed that was a change.
      assert.equal(sentSpeeds(harness).length, typed.length);
    });

    test('drops typed text that is not a speed', async (t) => {
      const harness = await createPopupHarness({ contentState: playingAt(0.83) });
      t.after(() => close(harness));

      for (const text of ['', ' ', 'fast', 'x', '1e0', '0x10', '1.2.3', '1,2,3', '--1', 'Infinity', 'NaN', '0.8 0.9']) {
        type(harness, text);
        await settle();
        assert.deepEqual(shown(harness), ['0.83', '0.83', '0.83x'], `typing "${text}"`);
      }
      // The same speed again changes nothing either.
      type(harness, '0.830');
      await settle();
      assert.deepEqual(shown(harness), ['0.83', '0.83', '0.83x']);
      assert.equal(audioUpdates(harness).length, 0);
    });

    test('steps by 0.01 with the buttons and with the arrow keys in the field', async (t) => {
      const harness = await createPopupHarness({ contentState: playingAt(0.83) });
      t.after(() => close(harness));
      const { field, down, up } = speedControls(harness);

      up.click();
      assert.deepEqual(shown(harness), ['0.84', '0.84', '0.84x']);
      down.click();
      down.click();
      assert.deepEqual(shown(harness), ['0.82', '0.82', '0.82x']);

      const arrowUp = press(harness, field, 'ArrowUp');
      assert.equal(arrowUp.defaultPrevented, true);
      assert.deepEqual(shown(harness), ['0.83', '0.83', '0.83x']);
      press(harness, field, 'ArrowDown');
      press(harness, field, 'ArrowDown');
      assert.deepEqual(shown(harness), ['0.81', '0.81', '0.81x']);

      // An arrow key steps from what is typed, when that is a speed...
      field.value = '1.1';
      press(harness, field, 'ArrowUp');
      assert.deepEqual(shown(harness), ['1.11', '1.11', '1.11x']);
      // ...and from the speed in use when it isn't.
      field.value = 'fast';
      press(harness, field, 'ArrowDown');
      assert.deepEqual(shown(harness), ['1.1', '1.10', '1.10x']);

      // The other keys are the field's own.
      assert.equal(press(harness, field, 'ArrowLeft').defaultPrevented, false);
      await settle();
      assert.equal(sentSpeeds(harness).at(-1), 1.1);
      assert.equal(harness.local.data.speed, 1.1);
    });

    test('stops at the ends of the range without sending anything', async (t) => {
      for (const [speed, button, text] of [[1.5, 'up', '1.50'], [0.5, 'down', '0.50']]) {
        const harness = await createPopupHarness({ contentState: playingAt(speed) });
        t.after(() => close(harness));
        const controls = speedControls(harness);

        controls[button].click();
        press(harness, controls.field, button === 'up' ? 'ArrowUp' : 'ArrowDown');
        press(harness, controls.slider, button === 'up' ? 'ArrowRight' : 'ArrowLeft');
        await settle();

        assert.deepEqual(shown(harness), [String(speed), text, `${text}x`]);
        assert.equal(audioUpdates(harness).length, 0);
      }
    });

    test("keeps the slider's own moves on the 0.05 marks", async (t) => {
      const harness = await createPopupHarness({ contentState: playingAt(0.83) });
      t.after(() => close(harness));
      const { slider } = speedControls(harness);
      const moveTo = (value) => {
        slider.value = value;
        slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
      };

      // A drag reports the 0.01 step it is over, and goes to the nearest mark.
      moveTo('0.84');
      assert.deepEqual(shown(harness), ['0.85', '0.85', '0.85x']);
      await settle();
      moveTo('0.86');
      moveTo('0.87');
      assert.deepEqual(shown(harness), ['0.85', '0.85', '0.85x']);
      moveTo('0.88');
      assert.deepEqual(shown(harness), ['0.9', '0.90', '0.90x']);
      await settle();
      // Moving within a mark is no change of speed.
      assert.deepEqual(sentSpeeds(harness), [0.85, 0.9]);

      // The arrow keys go to the next mark, also from a speed between two.
      type(harness, '0.83');
      const right = press(harness, slider, 'ArrowRight');
      assert.equal(right.defaultPrevented, true);
      assert.deepEqual(shown(harness), ['0.85', '0.85', '0.85x']);
      press(harness, slider, 'ArrowUp');
      assert.deepEqual(shown(harness), ['0.9', '0.90', '0.90x']);
      type(harness, '0.83');
      press(harness, slider, 'ArrowLeft');
      assert.deepEqual(shown(harness), ['0.8', '0.80', '0.80x']);
      press(harness, slider, 'ArrowDown');
      assert.deepEqual(shown(harness), ['0.75', '0.75', '0.75x']);

      // Home, End and the page keys stay the slider's own, and a shortcut
      // with an arrow in it is the browser's.
      for (const key of ['Home', 'End', 'PageUp', 'PageDown']) {
        assert.equal(press(harness, slider, key).defaultPrevented, false, key);
      }
      assert.equal(press(harness, slider, 'ArrowLeft', { altKey: true }).defaultPrevented, false);
      assert.deepEqual(shown(harness), ['0.75', '0.75', '0.75x']);
    });

    test('sends one change at a time and always the speed it ends on', async (t) => {
      const tab = slowTab(1);
      const harness = await createPopupHarness({ onTabMessage: tab.onTabMessage });
      t.after(() => close(harness));
      const { up } = speedControls(harness);

      up.click();
      await settle();
      for (let step = 0; step < 9; step++) up.click();
      await settle();
      // The first step is on its way and the tab hasn't answered: the nine
      // after it wait as one.
      assert.deepEqual(sentSpeeds(harness), [1.01]);
      assert.deepEqual(shown(harness), ['1.1', '1.10', '1.10x']);

      tab.answers.shift()();
      await settle();
      assert.deepEqual(sentSpeeds(harness), [1.01, 1.1]);

      // More steps while that one is on its way, then nothing left over.
      up.click();
      up.click();
      tab.answers.shift()();
      await settle();
      assert.deepEqual(sentSpeeds(harness), [1.01, 1.1, 1.12]);
      tab.answers.shift()();
      await settle();
      assert.deepEqual(sentSpeeds(harness), [1.01, 1.1, 1.12]);
      assert.equal(tab.answers.length, 0);
      assert.equal(harness.local.data.speed, 1.12);
      assert.equal(harness.session.data['tabState:9'].settings.speed, 1.12);
      assert.equal(harness.window.document.getElementById('power-toggle').checked, true);
    });

    test('ignores the answer to a change that a newer one has replaced', async (t) => {
      const tab = slowTab(1);
      const harness = await createPopupHarness({ onTabMessage: tab.onTabMessage });
      t.after(() => close(harness));
      const { up, field } = speedControls(harness);
      const power = harness.window.document.getElementById('power-toggle');

      up.click();
      await settle();
      up.click();
      // The tab refuses the first step, but the popup has moved on from it.
      tab.answers.shift()({ success: false, blocked: true, blockReason: 'drm' });
      await settle();
      assert.equal(harness.window.document.getElementById('blocked-banner').hidden, true);
      assert.deepEqual([power.checked, field.disabled], [true, false]);
      assert.deepEqual(shown(harness), ['1.02', '1.02', '1.02x']);

      // The answer to the newest change does count.
      tab.answers.shift()({ success: false, blocked: true, blockReason: 'drm' });
      await settle();
      assert.equal(harness.window.document.getElementById('blocked-banner').hidden, false);
      assert.deepEqual([power.checked, field.disabled], [false, true]);
    });

    test('sends steps made before the first has left as one change', async (t) => {
      const harness = await createPopupHarness({ contentState: playingAt(1) });
      t.after(() => close(harness));
      const { up } = speedControls(harness);

      for (let step = 0; step < 10; step++) up.click();
      await settle();
      assert.deepEqual(appliesSent(harness), [[1.1, true]]);
      assert.equal(harness.local.data.speed, 1.1);
    });

    test('keeps the last choice when the effect is turned off while a change is on its way', async (t) => {
      const tab = slowTab(1);
      const harness = await createPopupHarness({ onTabMessage: tab.onTabMessage });
      t.after(() => close(harness));
      const { up } = speedControls(harness);
      const power = harness.window.document.getElementById('power-toggle');

      up.click();
      await settle();
      up.click();
      power.checked = false;
      power.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
      tab.answers.shift()();
      await settle();
      tab.answers.shift()();
      await settle();

      const sent = audioUpdates(harness).map(({ message }) => [message.settings.speed, message.enabled]);
      assert.deepEqual(sent, [[1.01, true], [1.02, false]]);
      assert.equal(power.checked, false);
      assert.equal(presetBar(harness).hidden, true);
    });

    test('repeats while a button is held down, and not for the click that ends the hold', async (t) => {
      const harness = await createPopupHarness({ contentState: playingAt(1) });
      t.after(() => close(harness));
      const timers = fakeTimers(harness.window);
      const { up, down } = speedControls(harness);

      pointer(harness, up, 'pointerdown');
      timers.advance(399);
      assert.deepEqual(shown(harness), ['1', '1.00', '1.00x']);
      timers.advance(1);
      assert.deepEqual(shown(harness), ['1.01', '1.01', '1.01x']);
      timers.advance(120);
      assert.deepEqual(shown(harness), ['1.03', '1.03', '1.03x']);
      pointer(harness, up, 'pointerup');
      pointer(harness, up, 'click', { detail: 1 });
      timers.advance(5000);
      assert.deepEqual(shown(harness), ['1.03', '1.03', '1.03x']);

      // A short press is one step, made by its click.
      pointer(harness, up, 'pointerdown');
      timers.advance(150);
      pointer(harness, up, 'pointerup');
      pointer(harness, up, 'click', { detail: 1 });
      timers.advance(5000);
      assert.deepEqual(shown(harness), ['1.04', '1.04', '1.04x']);

      // A hold that ends off the button has no click, and the keyboard's
      // click after it still steps.
      pointer(harness, down, 'pointerdown');
      timers.advance(400);
      pointer(harness, down, 'pointerleave');
      timers.advance(5000);
      assert.deepEqual(shown(harness), ['1.03', '1.03', '1.03x']);
      down.click();
      assert.deepEqual(shown(harness), ['1.02', '1.02', '1.02x']);

      // Another mouse button doesn't start a hold.
      pointer(harness, down, 'pointerdown', { button: 2 });
      timers.advance(5000);
      assert.deepEqual(shown(harness), ['1.02', '1.02', '1.02x']);
    });

    test('stops repeating at the end of the range', async (t) => {
      const harness = await createPopupHarness({ contentState: playingAt(1.48) });
      t.after(() => close(harness));
      const timers = fakeTimers(harness.window);
      const { up } = speedControls(harness);

      pointer(harness, up, 'pointerdown');
      timers.advance(5000);
      await settle();
      assert.deepEqual(shown(harness), ['1.5', '1.50', '1.50x']);
      assert.equal(sentSpeeds(harness).at(-1), 1.5);
    });

    test('hides and turns off the field and the buttons on a live stream', async (t) => {
      const harness = await createPopupHarness({
        contentState: { ...playingAt(0.7), live: true }
      });
      t.after(() => close(harness));
      const { slider, field, down, up, stepper } = speedControls(harness);

      assert.equal(stepper.hidden, true);
      assert.deepEqual([slider.disabled, field.disabled, down.disabled, up.disabled], [true, true, true, true]);
      assert.deepEqual(shown(harness), ['1', '1.00', '1.00x']);
      assert.equal(
        harness.window.document.getElementById('speed-value').textContent,
        '(unavailable while live)'
      );

      // Whatever reaches them anyway changes nothing.
      field.value = '0.6';
      field.dispatchEvent(new harness.window.Event('blur'));
      await settle();
      assert.equal(audioUpdates(harness).length, 0);
    });

    test('turns off the field and the buttons on a page the effects cannot work on', async (t) => {
      const harness = await createPopupHarness({
        contentState: { enabled: false, blocked: true, blockReason: 'drm' }
      });
      t.after(() => close(harness));
      const { field, down, up, stepper } = speedControls(harness);

      assert.equal(stepper.hidden, false);
      assert.deepEqual([field.disabled, down.disabled, up.disabled], [true, true, true]);
      assert.deepEqual(shown(harness), ['1', '1.00', '1.00x']);
    });

    // The Firefox engines make a change of speed at once unless it goes to
    // normal speed, away from it or across it, so the popup has no reason to
    // keep steps back there: each one is sent as it is made, as in Chromium.
    test('sends each step as it is made in Firefox too', async (t) => {
      const harness = await createPopupHarness({ ...FIREFOX, contentState: playingAt(0.8) });
      t.after(() => close(harness));
      const { up, field } = speedControls(harness);

      for (let step = 0; step < 3; step++) {
        up.click();
        await settle();
      }
      press(harness, field, 'ArrowUp', { repeat: true });
      await settle();
      assert.deepEqual(sentSpeeds(harness), [0.81, 0.82, 0.83, 0.84]);
    });

    test('sends a change that was still waiting for the tab when the popup closes', async (t) => {
      const tab = slowTab(1);
      const harness = await createPopupHarness({ onTabMessage: tab.onTabMessage });
      t.after(() => close(harness));
      const { up } = speedControls(harness);

      up.click();
      await settle();
      up.click();
      up.click();
      // The tab hasn't answered the first step, so the popup has sent only that.
      assert.deepEqual(appliesSent(harness), [[1.01, true]]);
      harness.window.dispatchEvent(new harness.window.Event('pagehide'));
      // The popup's own queue never runs again once it has closed, so the
      // change has to leave at this moment.
      assert.deepEqual(appliesSent(harness), [[1.01, true], [1.03, true]]);

      // It is sent once, also if the popup lives on.
      while (tab.answers.length > 0) {
        tab.answers.shift()();
        await settle();
      }
      assert.deepEqual(appliesSent(harness), [[1.01, true], [1.03, true]]);
      assert.equal(harness.session.data['tabState:9'].settings.speed, 1.03);

      // With nothing waiting, closing sends nothing.
      harness.window.dispatchEvent(new harness.window.Event('pagehide'));
      await settle();
      assert.deepEqual(appliesSent(harness), [[1.01, true], [1.03, true]]);
    });

    test('sends a change that was still looking up the tab when the popup closes', async (t) => {
      const tab = slowTab(1);
      const harness = await createPopupHarness({ onTabMessage: tab.onTabMessage });
      t.after(() => close(harness));
      const { up } = speedControls(harness);
      const power = harness.window.document.getElementById('power-toggle');

      up.click();
      await settle();
      // Turned off while the step is on its way...
      power.checked = false;
      power.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
      // ...and from here on the popup's lookups of the tab don't come back.
      harness.api.tabs.query = () => new Promise(() => {});
      tab.answers.shift()();
      await settle();
      assert.deepEqual(appliesSent(harness), [[1.01, true]]);

      harness.window.dispatchEvent(new harness.window.Event('pagehide'));
      assert.deepEqual(appliesSent(harness), [[1.01, true], [1.01, false]]);
    });
  });
});
