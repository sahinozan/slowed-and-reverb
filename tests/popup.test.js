'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { flushPromises } = require('./helpers/browser-api');
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
      contentState: { enabled: false, blocked: true, blockReason: 'unreachable' }
    });
    const document = harness.window.document;

    assert.equal(document.getElementById('blocked-banner').hidden, false);
    assert.match(document.getElementById('blocked-banner-text').textContent, /can't reach it/);
    assert.equal(document.getElementById('power-toggle').disabled, true);
    assert.equal(document.getElementById('reverb-slider').disabled, true);
    assert.equal(document.getElementById('eq-handle-low').getAttribute('tabindex'), '-1');
    assert.equal(audioUpdates(harness).length, 0);

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
      /not granted/
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

    assert.equal(document.getElementById('blocked-banner').hidden, false);
    assert.match(document.getElementById('blocked-banner-text').textContent, /Browser-protected/);
    assert.equal(document.getElementById('power-toggle').checked, false);
    assert.equal(document.getElementById('power-toggle').disabled, true);
    assert.equal(audioUpdates(harness).length, 0);

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
});
