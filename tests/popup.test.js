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

// A tab that keeps what it is set to, as content.js does, and whose answers
// a test can hold back. A held answer says what the tab was set to when it
// was asked, so it can be older than a change made since.
function fakeTab(start = {}) {
  const state = { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false, ...start };
  const held = [];
  let holding = null;
  const tab = {
    state,
    held,
    // What the tab answers to a change.
    changeAnswer: { success: true },
    // Holds the answers to messages of this type from now on; null for none.
    hold(type) {
      holding = type;
    },
    // Lets held answers go, the oldest first: all of them, and no more are
    // held, or just `count` of them.
    letGo(count) {
      if (count === undefined) holding = null;
      for (const { answer } of held.splice(0, count ?? held.length)) answer();
    },
    // The held answers never come: the page they were asked of is gone.
    drop() {
      holding = null;
      for (const { fail } of held.splice(0)) fail();
    },
    onTabMessage(_tabId, message) {
      let result = { success: true };
      if (message.type === 'UPDATE_AUDIO') {
        result = this.changeAnswer;
        if (result.success) {
          state.enabled = message.enabled;
          state.settings = message.settings;
        }
      } else if (message.type === 'GET_STATE') {
        result = structuredClone(state);
      }
      if (holding !== message.type) return result;
      return new Promise((resolve, reject) => {
        held.push({
          answer: () => resolve(result),
          fail: () => reject(new Error('The page went away'))
        });
      });
    }
  };
  tab.onTabMessage = tab.onTabMessage.bind(tab);
  return tab;
}

// Holds the answers to the changes the popup sends (APPLY_TO_TAB) on their
// way back to it, until the test lets them go. The tab has each change at
// once, and so has the background script: the tab's queue goes on, which
// an answer held in the tab itself would stop.
function heldApplies(window) {
  const { runtime } = window.chrome;
  const send = runtime.sendMessage.bind(runtime);
  const held = [];
  let holding = false;
  runtime.sendMessage = async (message, ...rest) => {
    const answer = await send(message, ...rest);
    if (holding && message?.type === 'APPLY_TO_TAB') {
      await new Promise((resolve) => held.push(resolve));
    }
    return answer;
  };
  return {
    held,
    hold() {
      holding = true;
    },
    letGo() {
      holding = false;
      for (const answer of held.splice(0)) answer();
    }
  };
}

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

    test('turns the effect on when the slider is moved to the speed it already had', async (t) => {
      const harness = await createPopupHarness({
        session: {
          'tabState:9': { origin: 'https://www.youtube.com', enabled: false, settings: SLOWED }
        },
        contentState: { enabled: false, settings: DEFAULT_SETTINGS, blocked: false, live: false }
      });
      t.after(() => close(harness));
      const { slider } = speedControls(harness);
      const power = harness.window.document.getElementById('power-toggle');
      assert.equal(power.checked, false);
      assert.deepEqual(shown(harness), ['0.8', '0.80', '0.80x']);

      // As the website's fader does: the same speed, given to the slider again.
      slider.value = '0.8';
      slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
      await settle();
      assert.equal(power.checked, true);
      assert.deepEqual(appliesSent(harness), [[0.8, true]]);

      // With the effect on, the same speed again is nothing to send.
      slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
      await settle();
      assert.deepEqual(appliesSent(harness), [[0.8, true]]);
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

  // Until the tab has answered, the popup shows the settings used last in
  // any tab, and a change made then would be shown wrongly once the older
  // answer came (issue #175). So the parts that set the effect are held.
  // jsdom doesn't act on `inert`, so these tests check that the parts are
  // marked, and that what a held control reports all the same is dropped;
  // that a marked part takes no click or key is checked in the browsers
  // (e2e/ui/popup-layout.spec.js).
  describe("holding the controls until the tab's first answer", () => {
    const settle = async () => {
      for (let attempt = 0; attempt < 8; attempt++) await flushPromises();
    };
    const answer = (state) => ({ settings: DEFAULT_SETTINGS, blocked: false, live: false, ...state });
    // Everything that changes the effect or saves what the popup shows.
    const EFFECT_CONTROLS = [
      '#power-toggle', '.preset-btn', '#tab-presets', '#tab-custom', '#preset-name-input',
      '#save-preset-btn', '#speed-slider', '#speed-input', '#speed-down-btn', '#speed-up-btn',
      '#reverb-slider', '.eq-handle', '#echo-slider', '#keep-pitch-toggle', '#pan-slider',
      '#width-slider', '#saturation-slider', '#effect-tab-basic', '#effect-tab-advanced',
      '#reset-btn'
    ];
    const held = (harness) => {
      const document = harness.window.document;
      const all = EFFECT_CONTROLS.flatMap((selector) => [...document.querySelectorAll(selector)]);
      assert.ok(all.length >= EFFECT_CONTROLS.length, 'a selector matched nothing');
      const count = all.filter((control) => control.closest('[inert]')).length;
      if (count !== 0 && count !== all.length) {
        const free = all.filter((control) => !control.closest('[inert]')).map((control) => control.id);
        assert.fail(`only some controls are held; free: ${free.join(', ')}`);
      }
      return count > 0;
    };
    const dimmed = (harness) => harness.window.document.body.classList.contains('tab-slow');
    const marked = (harness) => harness.window.document.querySelectorAll('[inert]').length;

    test('holds every effect control until a tab with the effect on has answered', async (t) => {
      const tabState = deferredTabState();
      const harness = await createPopupHarness({ onTabMessage: tabState.onTabMessage });
      t.after(() => close(harness));
      const document = harness.window.document;

      assert.equal(held(harness), true);
      assert.equal(dimmed(harness), false);
      // The themes and the links are not the effect's, and stay usable.
      assert.equal(document.getElementById('theme-picker-btn').closest('[inert]'), null);
      assert.equal(document.querySelector('#app-footer a').closest('[inert]'), null);
      // Held controls are not disabled, so they look as they always do.
      assert.equal(document.getElementById('speed-up-btn').disabled, false);

      tabState.release(answer({ enabled: true, settings: SLOWED }));
      await settle();

      assert.equal(held(harness), false);
      assert.equal(marked(harness), 0);
      assert.equal(document.getElementById('speed-input').value, '0.80');
    });

    // `inert` stops a new click or key, but not what was under way when the
    // hold began, such as a slider being dragged in Chromium. jsdom stops
    // nothing, so here every control reports as one under way would.
    test('drops what a held control reports, and hears it again after the answer', async (t) => {
      const tabState = deferredTabState();
      const harness = await createPopupHarness({ onTabMessage: tabState.onTabMessage });
      t.after(() => close(harness));
      const { window } = harness;
      const document = window.document;
      const id = (name) => document.getElementById(name);
      const fire = (element, type, init) => element.dispatchEvent(new window.Event(type, { bubbles: true, ...init }));
      // What the popup itself has written, not what a control was given.
      const reports = () => ({
        speed: id('speed-input').getAttribute('aria-valuetext'),
        reverbLabel: id('reverb-value').textContent,
        status: id('power-status').textContent,
        preset: presetBar(harness),
        pitchWarning: id('pitch-warning-banner').hidden
      });
      const before = reports();
      assert.equal(before.speed, '1.00x');

      const actions = {
        'the + button': () => id('speed-up-btn').click(),
        // Held for longer than the button waits before it repeats.
        'the + button held down': async () => {
          id('speed-up-btn').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
          await new Promise((resolve) => setTimeout(resolve, 480));
          id('speed-up-btn').dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
        },
        'the speed slider': () => {
          id('speed-slider').value = '1.3';
          fire(id('speed-slider'), 'input');
          fire(id('speed-slider'), 'change');
        },
        'the speed field': () => {
          id('speed-input').value = '1.2';
          id('speed-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          fire(id('speed-input'), 'blur', { bubbles: false });
        },
        'the reverb slider': () => {
          id('reverb-slider').value = '70';
          fire(id('reverb-slider'), 'input');
        },
        'a preset': () => document.querySelector('[data-preset="nightcore"]').click(),
        'the switch': () => {
          id('power-toggle').checked = !id('power-toggle').checked;
          fire(id('power-toggle'), 'change');
        },
        'Keep Original Pitch': () => {
          id('keep-pitch-toggle').checked = true;
          fire(id('keep-pitch-toggle'), 'change');
        },
        'an EQ handle': () =>
          id('eq-handle-low').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
        'Reset Defaults': () => id('reset-btn').click(),
        'Save Current': () => {
          id('preset-name-input').value = 'Mine';
          id('save-preset-btn').click();
        }
      };
      for (const [name, act] of Object.entries(actions)) {
        await act();
        await settle();
        assert.equal(audioUpdates(harness).length, 0, `${name} sent a change to the tab`);
        assert.deepEqual(reports(), before, `${name} changed what the popup shows`);
        assert.equal(harness.local.data.customPresets, undefined, `${name} saved a preset`);
        // As the tab's answer will: put back what the control itself shows.
        id('speed-slider').value = '1';
        id('speed-input').value = '1.00';
        id('reverb-slider').value = '0';
        id('keep-pitch-toggle').checked = false;
        id('power-toggle').checked = false;
        id('preset-name-input').value = '';
      }

      tabState.release(answer({ enabled: true }));
      await settle();
      id('speed-up-btn').click();
      await settle();
      assert.equal(id('speed-input').value, '1.01');
      assert.equal(audioUpdates(harness).at(-1).message.settings.speed, 1.01);
    });

    test('puts a slider that moved while held back when there is no tab to ask', async (t) => {
      let letQueryAnswer;
      const queried = new Promise((resolve) => {
        letQueryAnswer = resolve;
      });
      const harness = await createPopupHarness({
        activeTab: null,
        local: { ...SLOWED },
        localStorage: { [PRESET_BAR_KEY]: 'Current Preset: Slowed + Reverb' },
        beforeLoad(window) {
          const { tabs } = window.chrome;
          const query = tabs.query.bind(tabs);
          tabs.query = async (...args) => {
            await queried;
            return query(...args);
          };
        }
      });
      t.after(() => close(harness));
      const document = harness.window.document;
      const slider = document.getElementById('speed-slider');
      const reverb = document.getElementById('reverb-slider');
      assert.equal(held(harness), true);
      assert.equal(slider.value, '0.8');

      // As a drag that began before the hold does in Chromium: the sliders
      // move, and what they report is dropped.
      slider.value = '1.31';
      slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
      reverb.value = '90';
      reverb.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
      await settle();
      assert.equal(document.getElementById('speed-input').getAttribute('aria-valuetext'), '0.80x');

      letQueryAnswer();
      await settle();
      assert.equal(held(harness), false);
      assert.equal(slider.value, '0.8');
      assert.equal(reverb.value, '40');
      assert.equal(document.getElementById('speed-input').value, '0.80');
      assert.equal(document.getElementById('reverb-value').textContent, '(40%)');
      // The bar is named from the sliders as they were put back.
      assert.deepEqual(presetBar(harness), { hidden: false, label: 'Current Preset: Slowed + Reverb' });
      assert.equal(harness.window.localStorage.getItem(PRESET_BAR_KEY), 'Current Preset: Slowed + Reverb');
    });

    test('names the preset a new tab starts with, though a slider moved while it was sent', async (t) => {
      const first = deferredTabState();
      const changes = [];
      const harness = await createPopupHarness({
        onTabMessage(tabId, message) {
          if (message.type !== 'UPDATE_AUDIO') return first.onTabMessage(tabId, message);
          return new Promise((resolve) => changes.push(() => resolve({ success: true })));
        }
      });
      t.after(() => close(harness));
      const document = harness.window.document;
      const slider = document.getElementById('speed-slider');

      first.release(answer({ enabled: false }));
      await settle();
      assert.equal(changes.length, 1);
      assert.equal(slider.value, '0.8');

      // The preset is on its way; the slider moves as a drag from before the
      // hold moves it.
      slider.value = '1.31';
      slider.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
      changes.shift()();
      await settle();

      assert.equal(held(harness), false);
      assert.equal(slider.value, '0.8');
      assert.deepEqual(presetBar(harness), { hidden: false, label: 'Current Preset: Slowed + Reverb' });
      assert.equal(harness.window.localStorage.getItem(PRESET_BAR_KEY), 'Current Preset: Slowed + Reverb');
      assert.equal(audioUpdates(harness).length, 1);
    });

    // After a reload or a permission the popup asks the tab again. The
    // controls are disabled then, and are enabled only once the popup has
    // this tab's settings to show, so there is no moment to change them in.
    test('keeps the controls disabled after a reload until it has what the tab was set to', async (t) => {
      let reachable = false;
      let holding = false;
      let asked = false;
      let letRecall;
      const recalled = new Promise((resolve) => {
        letRecall = resolve;
      });
      const harness = await createPopupHarness({
        session: {
          'tabState:9': { origin: 'https://www.youtube.com', enabled: false, settings: SLOWED }
        },
        onTabMessage(_tabId, message) {
          if (message.type !== 'GET_STATE') return { success: true };
          return reachable
            ? answer({ enabled: false })
            : { enabled: false, blocked: true, blockReason: 'unsupported' };
        },
        beforeLoad(window) {
          const { runtime } = window.chrome;
          const send = runtime.sendMessage.bind(runtime);
          runtime.sendMessage = async (message, ...rest) => {
            if (holding && message?.type === 'GET_TAB_STATE') {
              asked = true;
              await recalled;
            }
            return send(message, ...rest);
          };
        }
      });
      t.after(() => close(harness));
      const document = harness.window.document;
      assert.equal(document.getElementById('reload-panel').hidden, false);

      reachable = true;
      holding = true;
      document.getElementById('reload-btn').click();
      await settle();

      // The tab has answered, and the popup is waiting for what is remembered.
      assert.equal(asked, true);
      assert.equal(document.getElementById('power-toggle').disabled, true);
      assert.equal(document.getElementById('speed-up-btn').disabled, true);

      letRecall();
      await settle();
      assert.equal(document.getElementById('speed-up-btn').disabled, false);
      assert.equal(document.getElementById('speed-input').value, '0.80');
      assert.equal(document.getElementById('power-toggle').checked, false);
    });

    test('holds them from the start, while what is stored is still being read', async (t) => {
      let letStorageAnswer;
      const stored = new Promise((resolve) => {
        letStorageAnswer = resolve;
      });
      const harness = await createPopupHarness({
        contentState: answer({ enabled: true, settings: SLOWED }),
        beforeLoad(window) {
          const { local } = window.chrome.storage;
          const get = local.get.bind(local);
          local.get = async (...keys) => {
            await stored;
            return get(...keys);
          };
        }
      });
      t.after(() => close(harness));

      // The tab hasn't been asked anything yet.
      assert.equal(harness.calls.tabMessages.length, 0);
      assert.equal(held(harness), true);

      letStorageAnswer();
      await settle();
      assert.equal(held(harness), false);
      assert.equal(harness.window.document.getElementById('speed-input').value, '0.80');
    });

    test('holds them on a new tab until the preset it starts with has reached the tab', async (t) => {
      const first = deferredTabState();
      const changes = [];
      const harness = await createPopupHarness({
        onTabMessage(tabId, message) {
          if (message.type !== 'UPDATE_AUDIO') return first.onTabMessage(tabId, message);
          return new Promise((resolve) => changes.push(() => resolve({ success: true })));
        }
      });
      t.after(() => close(harness));

      first.release(answer({ enabled: false }));
      await settle();
      // The answer has come, and the popup's own first change is on its way.
      assert.equal(changes.length, 1);
      assert.equal(held(harness), true);

      changes.shift()();
      await settle();
      assert.equal(held(harness), false);
      assert.equal(harness.window.document.getElementById('speed-input').value, '0.80');
    });

    for (const [name, options, check] of [
      [
        'a page that answers that it is blocked',
        { contentState: { enabled: false, blocked: true, blockReason: 'unsupportedSite' } },
        (document) => assert.equal(document.getElementById('blocked-banner').hidden, false)
      ],
      [
        'a page where nothing answers',
        {
          onTabMessage(_tabId, message) {
            if (message.type === 'GET_STATE') throw new Error('nothing answered');
            return { success: true };
          }
        },
        (document) => assert.equal(document.getElementById('power-toggle').disabled, true)
      ],
      [
        'a site the extension does not work on',
        { activeTab: { id: 9, url: 'https://example.com/' } },
        (document) => assert.equal(document.getElementById('blocked-banner').hidden, false)
      ],
      [
        'Spotify before it is allowed',
        { activeTab: { id: 9, url: 'https://open.spotify.com/' } },
        (document) => assert.equal(document.getElementById('spotify-permission-panel').hidden, false)
      ],
      [
        'a window with no tab to ask',
        { activeTab: null },
        (document) => assert.equal(document.getElementById('power-toggle').disabled, false)
      ]
    ]) {
      test(`lets go of them for ${name}`, async (t) => {
        const harness = await createPopupHarness(options);
        t.after(() => close(harness));
        await settle();

        assert.equal(marked(harness), 0);
        assert.equal(dimmed(harness), false);
        check(harness.window.document);
      });
    }

    test('dims them only when the answer takes long, and not after it has come', async (t) => {
      const tabState = deferredTabState();
      let timers;
      const harness = await createPopupHarness({
        onTabMessage: tabState.onTabMessage,
        beforeLoad(window) {
          timers = fakeTimers(window);
        }
      });
      t.after(() => close(harness));

      timers.advance(299);
      assert.equal(dimmed(harness), false);
      timers.advance(1);
      assert.equal(dimmed(harness), true);
      assert.equal(held(harness), true);

      tabState.release(answer({ enabled: true }));
      await settle();
      assert.equal(dimmed(harness), false);
      assert.equal(held(harness), false);
    });

    test('never dims them when the answer comes soon', async (t) => {
      let timers;
      const harness = await createPopupHarness({
        contentState: answer({ enabled: true }),
        beforeLoad(window) {
          timers = fakeTimers(window);
        }
      });
      t.after(() => close(harness));

      timers.advance(5000);
      assert.equal(dimmed(harness), false);
      assert.equal(marked(harness), 0);
    });
  });

  // A page that has stopped responding never answers the popup, and since
  // the controls are held until the answer, they stayed held and dimmed with
  // nothing to say why (issue #180). The popup now stops waiting after five
  // seconds and offers to reload the page.
  // These tests hold answers back with no limit of real time, so the group
  // has a deadline, which its tests share: one that waits for an answer
  // that never comes fails when it is reached.
  describe("a tab that doesn't answer", { timeout: 20_000 }, () => {
    const NOT_RESPONDING = "This page isn't responding. Reloading it usually fixes this.";
    const settle = async () => {
      for (let attempt = 0; attempt < 8; attempt++) await flushPromises();
    };
    const shown = (harness) => {
      const id = (name) => harness.window.document.getElementById(name);
      return {
        panel: id('reload-panel').hidden ? null : id('reload-text').textContent,
        button: id('reload-btn').textContent,
        status: id('reload-status').textContent,
        on: id('power-toggle').checked,
        usable: !id('power-toggle').disabled && !id('speed-up-btn').disabled,
        speed: id('speed-input').value,
        inert: harness.window.document.querySelectorAll('[inert]').length,
        dimmed: harness.window.document.body.classList.contains('tab-slow')
      };
    };
    const open = async (t, tab, options = {}) => {
      let timers;
      const harness = await createPopupHarness({
        onTabMessage: tab.onTabMessage,
        // An answer the test holds back is waited for, however long.
        runtimeResponseTimeoutMs: null,
        ...options,
        beforeLoad(window) {
          timers = fakeTimers(window);
          options.beforeLoad?.(window);
        }
      });
      t.after(() => close(harness));
      return { harness, timers };
    };

    test('stops waiting after five seconds, says so and offers to reload the page', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      tab.hold('GET_STATE');
      const { harness, timers } = await open(t, tab, {
        localStorage: { [PRESET_BAR_KEY]: 'Current Preset: Slowed + Reverb' }
      });

      timers.advance(4999);
      await settle();
      assert.equal(shown(harness).panel, null);
      assert.equal(shown(harness).dimmed, true);
      assert.equal(shown(harness).inert, 4);

      timers.advance(1);
      await settle();
      assert.deepEqual(shown(harness), {
        panel: NOT_RESPONDING,
        button: 'Reload page',
        status: '',
        on: false,
        usable: false,
        speed: '1.00',
        inert: 0,
        dimmed: false
      });
      // The bar shown from the last time the popup was open goes too, and
      // the popup's first paint is over.
      assert.equal(presetBar(harness).hidden, true);
      assert.equal(harness.window.document.body.classList.contains('booting'), false);
      assert.equal(audioUpdates(harness).length, 0);
    });

    test("shows the tab's settings when its answer comes after all", async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      tab.hold('GET_STATE');
      const { harness, timers } = await open(t, tab);

      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      tab.letGo();
      await settle();
      assert.deepEqual(shown(harness), {
        panel: null,
        button: 'Reload page',
        status: '',
        on: true,
        usable: true,
        speed: '0.80',
        inert: 0,
        dimmed: false
      });
      assert.deepEqual(presetBar(harness), { hidden: false, label: 'Current Preset: Slowed + Reverb' });
    });

    // Here the tab has answered and the popup has shown its settings; what
    // never came back is the preset a new tab starts with. The notice has
    // replaced what was shown, so the popup asks again once that has come.
    test('shows the tab again when what it waited for was the preset a new tab starts with', async (t) => {
      const tab = fakeTab({ enabled: false });
      let applies;
      const { harness, timers } = await open(t, tab, {
        beforeLoad(window) {
          applies = heldApplies(window);
          applies.hold();
        }
      });
      assert.equal(audioUpdates(harness).length, 1);
      assert.equal(applies.held.length, 1);

      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);
      assert.equal(shown(harness).usable, false);

      applies.letGo();
      await settle();
      assert.equal(shown(harness).panel, null);
      assert.equal(shown(harness).usable, true);
      assert.equal(shown(harness).on, true);
      assert.equal(shown(harness).speed, '0.80');
      assert.deepEqual(presetBar(harness), { hidden: false, label: 'Current Preset: Slowed + Reverb' });
      assert.equal(audioUpdates(harness).length, 1);
    });

    test('leaves the popup alone when the answer came in time', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      const { harness, timers } = await open(t, tab);

      timers.advance(60_000);
      await settle();
      assert.equal(shown(harness).panel, null);
      assert.equal(shown(harness).usable, true);
      assert.equal(shown(harness).speed, '0.80');
    });

    // The reload starts a new look at the tab. The first look is still
    // waiting, and its answer, which is the older one, must not be shown
    // over what the new look found.
    for (const [name, firstAnswer] of [
      ['when that comes late', (tab) => tab.letGo()],
      ['when that fails late', (tab) => tab.drop()]
    ]) {
      test(`shows the reloaded page, and not the first answer ${name}`, async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const { harness, timers } = await open(t, tab);
        timers.advance(5000);
        await settle();
        assert.equal(shown(harness).panel, NOT_RESPONDING);

        // The reloaded page answers, with other settings; the first answer
        // stays held.
        tab.hold(null);
        tab.state.settings = { ...DEFAULT_SETTINGS, speed: 1.2 };
        harness.window.document.getElementById('reload-btn').click();
        await settle();
        assert.deepEqual(harness.calls.reloadedTabs, [9]);
        assert.equal(shown(harness).panel, null);
        assert.equal(shown(harness).speed, '1.20');

        firstAnswer(tab);
        await settle();
        assert.equal(shown(harness).panel, null);
        assert.equal(shown(harness).speed, '1.20');
        assert.equal(shown(harness).usable, true);
      });
    }

    // The first look has the tab's answer and is waiting for what the
    // background script remembers of the tab when the popup stops waiting.
    test('shows the reloaded page, and not what the first look was told is remembered', async (t) => {
      const tab = fakeTab({ enabled: false });
      let holding = true;
      let letRecall;
      const recalled = new Promise((resolve) => {
        letRecall = resolve;
      });
      const { harness, timers } = await open(t, tab, {
        session: {
          'tabState:9': { origin: 'https://www.youtube.com', enabled: false, settings: SLOWED }
        },
        beforeLoad(window) {
          const { runtime } = window.chrome;
          const send = runtime.sendMessage.bind(runtime);
          runtime.sendMessage = async (message, ...rest) => {
            const answer = await send(message, ...rest);
            if (holding && message?.type === 'GET_TAB_STATE') await recalled;
            return answer;
          };
        }
      });
      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      holding = false;
      tab.state.enabled = true;
      tab.state.settings = { ...DEFAULT_SETTINGS, speed: 1.2 };
      harness.window.document.getElementById('reload-btn').click();
      await settle();
      assert.equal(shown(harness).speed, '1.20');
      assert.equal(shown(harness).on, true);

      letRecall();
      await settle();
      assert.equal(shown(harness).speed, '1.20');
      assert.equal(shown(harness).on, true);
    });

    // The first answer comes after the notice, and the look made then is
    // still waiting, with its own time limit running, when the reload starts
    // another. Neither that limit nor that look's answer may be shown over
    // the reloaded page.
    test('leaves the reloaded page shown when the time of a look before it is up', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      tab.hold('GET_STATE');
      const { harness, timers } = await open(t, tab);
      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      // The first answer comes after all, and the popup looks again; that
      // question is held too.
      tab.letGo(1);
      await settle();
      assert.equal(tab.held.length, 1);
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      tab.hold(null);
      tab.state.settings = { ...DEFAULT_SETTINGS, speed: 1.2 };
      harness.window.document.getElementById('reload-btn').click();
      await settle();
      assert.equal(shown(harness).panel, null);
      assert.equal(shown(harness).speed, '1.20');

      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, null);
      assert.equal(shown(harness).speed, '1.20');
      assert.equal(shown(harness).usable, true);
    });

    // Once the popup has stopped waiting, a shortcut starts a look of its
    // own. The first look's answer is then the older one twice over, and
    // must not enable the controls while the new look is still waiting.
    test('a shortcut then starts a new look, which the first answer, coming late, does not cut short', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      tab.hold('GET_STATE');
      const { harness, timers } = await open(t, tab);
      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      // The shortcut is answered; the popup's new question is held.
      tab.hold(null);
      await harness.events.command.emit('toggle-nightcore');
      tab.hold('GET_STATE');
      await settle();
      assert.equal(tab.state.settings.speed, 1.2);
      assert.equal(tab.held.length, 2);

      // The first answer, 0.80x and from before the shortcut.
      tab.letGo(1);
      await settle();
      assert.equal(shown(harness).usable, false);
      assert.equal(shown(harness).panel, NOT_RESPONDING);
      assert.equal(audioUpdates(harness).length, 1);

      // The new look has a time limit of its own.
      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).usable, false);
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      tab.letGo();
      await settle();
      assert.equal(shown(harness).panel, null);
      assert.equal(shown(harness).usable, true);
      assert.equal(shown(harness).on, true);
      assert.equal(shown(harness).speed, '1.20');
    });

    test('a shortcut the page does answer takes the notice away', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      tab.hold('GET_STATE');
      const { harness, timers } = await open(t, tab);
      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      // From here on the page answers; the first question stays unanswered.
      tab.hold(null);
      await harness.events.command.emit('toggle-nightcore');
      await settle();
      assert.equal(shown(harness).panel, null);
      assert.equal(shown(harness).usable, true);
      assert.equal(shown(harness).speed, '1.20');

      tab.letGo();
      await settle();
      assert.equal(shown(harness).speed, '1.20');
      assert.equal(shown(harness).on, true);
    });

    // While the page reloads, the first look's question fails: the page it
    // asked is gone. That is no answer to look again for.
    test("doesn't look at the page again while it is reloading", async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      tab.hold('GET_STATE');
      let reloads = 0;
      const { harness, timers } = await open(t, tab, {
        beforeLoad(window) {
          // A reload that takes its time: the test says when it is done.
          window.chrome.tabs.reload = async () => {
            reloads++;
          };
        }
      });
      const asks = () =>
        harness.calls.tabMessages.filter(({ message }) => message.type === 'GET_STATE').length;
      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      harness.window.document.getElementById('reload-btn').click();
      await settle();
      assert.equal(reloads, 1);
      assert.equal(shown(harness).status, 'Reloading the page…');

      tab.drop();
      await settle();
      assert.equal(asks(), 1);
      assert.equal(shown(harness).status, 'Reloading the page…');
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      await harness.events.tabUpdated.emit(
        9, { status: 'complete' }, { id: 9, url: 'https://www.youtube.com/watch?v=example' }
      );
      await settle();
      assert.equal(asks(), 2);
      assert.equal(shown(harness).panel, null);
      assert.equal(shown(harness).speed, '0.80');
    });

    // The answer to the preset a new tab starts with comes after the popup
    // has stopped waiting and the page has been reloaded. It is about the
    // page as it was, and the look at the reloaded page is still under way.
    test("doesn't show the late answer to a new tab's preset over the look at the reloaded page", async (t) => {
      const tab = fakeTab({ enabled: false });
      tab.changeAnswer = { success: false, blocked: true, blockReason: 'outdated' };
      let applies;
      const { harness, timers } = await open(t, tab, {
        beforeLoad(window) {
          applies = heldApplies(window);
          applies.hold();
        }
      });
      assert.equal(applies.held.length, 1);
      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      // The new look lets the change that is on its way be answered first.
      tab.hold('GET_STATE');
      harness.window.document.getElementById('reload-btn').click();
      await settle();
      assert.equal(tab.held.length, 0);
      assert.equal(shown(harness).inert, 4);

      // The old answer: the page was of the previous version. It is not
      // shown, and the new look asks the reloaded page.
      applies.letGo();
      await settle();
      assert.equal(tab.held.length, 1);
      assert.equal(shown(harness).panel, NOT_RESPONDING);
      assert.equal(shown(harness).inert, 4);

      // The reloaded page says the same of its own preset, and that is shown.
      tab.letGo();
      await settle();
      assert.equal(shown(harness).panel, 'Reload the page to finish updating the extension.');
      assert.equal(shown(harness).inert, 0);
    });

    // While the popup waits for the tab to reload, nothing else looks at
    // the tab: the page is going or coming, and the look after the reload
    // shows it. Here a shortcut's change was still on its way to the old
    // page, and fails as that page goes; the background script's word of the
    // shortcut then reaches the popup in the middle of the reload.
    test("doesn't look at the tab for a shortcut's report that comes during a reload", async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      const { harness, timers } = await open(t, tab, {
        beforeLoad(window) {
          // A reload that takes its time: the test says when it is done.
          window.chrome.tabs.reload = async () => {};
        }
      });
      const document = harness.window.document;
      const asks = () =>
        harness.calls.tabMessages.filter(({ message }) => message.type === 'GET_STATE').length;

      // The shortcut's change reaches the page and is not answered. A change
      // in the popup is left out for it, and the look that follows waits
      // behind the shortcut until its time is up.
      tab.hold('UPDATE_AUDIO');
      const handled = harness.events.command.emit('toggle-nightcore');
      await settle();
      assert.equal(tab.held.length, 1);
      document.getElementById('speed-up-btn').click();
      await settle();
      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);
      const asksBefore = asks();

      document.getElementById('reload-btn').click();
      await settle();
      assert.equal(shown(harness).status, 'Reloading the page…');

      tab.drop();
      await handled;
      await settle();
      assert.equal(asks(), asksBefore);
      assert.equal(shown(harness).status, 'Reloading the page…');
      assert.equal(shown(harness).panel, NOT_RESPONDING);
      assert.equal(shown(harness).usable, false);

      await harness.events.tabUpdated.emit(
        9, { status: 'complete' }, { id: 9, url: 'https://www.youtube.com/watch?v=example' }
      );
      await settle();
      assert.equal(shown(harness).panel, null);
      assert.equal(shown(harness).usable, true);
    });

    // The background script's answer that a change was left out comes late,
    // after the popup has given up on the tab and begun to reload it.
    test("doesn't look at the tab for a late answer that a change was left out, during a reload", async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      const reports = [];
      let applies;
      const { harness, timers } = await open(t, tab, {
        beforeLoad(window) {
          window.chrome.tabs.reload = async () => {};
          applies = heldApplies(window);
          // The word of the shortcut is kept back too, until the test
          // lets it go.
          const { runtime } = window.chrome;
          const send = runtime.sendMessage.bind(runtime);
          runtime.sendMessage = async (message, ...rest) => {
            if (message?.type === 'SHORTCUT_APPLIED') await new Promise((resolve) => reports.push(resolve));
            return send(message, ...rest);
          };
        }
      });
      const document = harness.window.document;
      const asks = () =>
        harness.calls.tabMessages.filter(({ message }) => message.type === 'GET_STATE').length;

      // A shortcut, and a change in the popup before it has heard of it.
      // The change is left out; the answer saying so is held.
      await harness.events.command.emit('toggle-nightcore');
      await settle();
      applies.hold();
      document.getElementById('speed-up-btn').click();
      await settle();
      assert.equal(applies.held.length, 1);
      assert.equal(tab.state.settings.speed, 1.2);

      // The word of the shortcut starts a look, which waits for that
      // answer until its time is up.
      reports.shift()();
      await settle();
      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);
      const asksBefore = asks();

      document.getElementById('reload-btn').click();
      await settle();
      assert.equal(shown(harness).status, 'Reloading the page…');

      applies.letGo();
      await settle();
      assert.equal(asks(), asksBefore);
      assert.equal(shown(harness).status, 'Reloading the page…');
      assert.equal(shown(harness).panel, NOT_RESPONDING);

      await harness.events.tabUpdated.emit(
        9, { status: 'complete' }, { id: 9, url: 'https://www.youtube.com/watch?v=example' }
      );
      await settle();
      assert.equal(shown(harness).panel, null);
      assert.equal(shown(harness).speed, '1.20');
    });

    // On Spotify the popup's reload buttons name it.
    test('names Spotify on the reload button there', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      tab.hold('GET_STATE');
      const { harness, timers } = await open(t, tab, {
        activeTab: { id: 9, url: 'https://open.spotify.com/track/example' },
        grantedOrigins: ['https://open.spotify.com/*'],
        beforeLoad(window) {
          // A reload that takes its time, so that its progress line stays.
          window.chrome.tabs.reload = async () => {};
        }
      });
      assert.equal(tab.held.length, 1);

      timers.advance(5000);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);
      assert.equal(shown(harness).button, 'Reload Spotify');

      harness.window.document.getElementById('reload-btn').click();
      await settle();
      assert.equal(shown(harness).status, 'Reloading Spotify…');
    });

    // A page that is still loading has not stopped responding: the scripts
    // wait for it. Reloading it would only start the loading again.
    describe('on a page that is still loading', () => {
      const LOADING = 'This page is still loading.';
      const banner = (harness) => {
        const document = harness.window.document;
        return document.getElementById('blocked-banner').hidden
          ? null
          : document.getElementById('blocked-banner-text').textContent;
      };
      const asks = (harness) =>
        harness.calls.tabMessages.filter(({ message }) => message.type === 'GET_STATE').length;
      const openOnLoadingPage = async (t, tab) => {
        const activeTab = { id: 9, url: 'https://www.youtube.com/watch?v=example', status: 'loading' };
        const opened = await open(t, tab, { activeTab });
        const loaded = async () => {
          activeTab.status = 'complete';
          await opened.harness.events.tabUpdated.emit(9, { status: 'complete' }, { ...activeTab });
        };
        return { ...opened, activeTab, loaded };
      };

      test('says that it is loading, with no reload button, and shows the tab once it has loaded', async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const { harness, timers, loaded } = await openOnLoadingPage(t, tab);

        // At once, with no moment in which it offers a reload.
        timers.advance(5000);
        assert.equal(banner(harness), LOADING);
        assert.equal(shown(harness).panel, null);
        await settle();
        assert.equal(banner(harness), LOADING);
        assert.deepEqual(
          { ...shown(harness), button: null, status: null },
          { panel: null, button: null, status: null, on: false, usable: false, speed: '1.00', inert: 0, dimmed: false }
        );
        assert.equal(asks(harness), 1);

        // The page has loaded, and answers from now on.
        tab.hold(null);
        await loaded();
        await settle();
        assert.equal(asks(harness), 2);
        assert.equal(banner(harness), null);
        assert.equal(shown(harness).usable, true);
        assert.equal(shown(harness).speed, '0.80');

        // The first question's answer comes last, and nothing looks again.
        tab.letGo();
        await settle();
        assert.equal(asks(harness), 2);
        assert.equal(shown(harness).speed, '0.80');
      });

      test('shows the tab when its first answer comes after all', async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const { harness, timers } = await openOnLoadingPage(t, tab);
        timers.advance(5000);
        await settle();
        assert.equal(banner(harness), LOADING);

        tab.letGo();
        await settle();
        assert.equal(banner(harness), null);
        assert.equal(shown(harness).usable, true);
        assert.equal(shown(harness).speed, '0.80');
      });

      // The page was loading when the look began and has loaded since,
      // with nothing to say so. The popup looks again, and that look has
      // five seconds of its own.
      test("says the page isn't responding when it has loaded and still doesn't answer", async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const { harness, timers, activeTab } = await openOnLoadingPage(t, tab);
        activeTab.status = 'complete';

        timers.advance(5000);
        await settle();
        assert.equal(asks(harness), 2);
        assert.equal(shown(harness).panel, null);
        assert.equal(shown(harness).inert, 4);

        timers.advance(5000);
        await settle();
        assert.equal(banner(harness), null);
        assert.equal(shown(harness).panel, NOT_RESPONDING);
        assert.equal(shown(harness).inert, 0);
      });

      // Something else has looked at the tab since the notice; the page's
      // having loaded then starts nothing more.
      test('leaves it to a newer look when the page has loaded', async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const { harness, timers, loaded } = await openOnLoadingPage(t, tab);
        timers.advance(5000);
        await settle();
        assert.equal(banner(harness), LOADING);

        tab.hold(null);
        await dispatchRuntimeMessage(
          harness.events.runtimeMessage, { type: 'SHORTCUT_APPLIED', tabId: 9 }, { id: 'example' }
        );
        await settle();
        assert.equal(asks(harness), 2);
        assert.equal(banner(harness), null);

        await loaded();
        await settle();
        assert.equal(asks(harness), 2);
        assert.equal(shown(harness).speed, '0.80');
      });

      // The popup follows the tab's loading while it is open, so when the
      // look's time is up it knows that the page has loaded meanwhile.
      test("says at once that the page isn't responding when it loaded during the look", async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const { harness, timers, loaded } = await openOnLoadingPage(t, tab);
        timers.advance(3000);
        await loaded();
        await settle();

        timers.advance(2000);
        assert.equal(banner(harness), null);
        assert.equal(shown(harness).panel, NOT_RESPONDING);
        await settle();
        assert.equal(shown(harness).panel, NOT_RESPONDING);
        assert.equal(asks(harness), 1);
      });

      // The browser's word that the page has loaded can be missed. The
      // popup asks it every second while the notice is up.
      test('finds within a second that the page has loaded, without being told', async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const { harness, timers, activeTab } = await openOnLoadingPage(t, tab);
        timers.advance(5000);
        await settle();
        assert.equal(banner(harness), LOADING);

        // Still loading: asking changes nothing.
        timers.advance(3000);
        await settle();
        assert.equal(banner(harness), LOADING);
        assert.equal(asks(harness), 1);

        tab.hold(null);
        activeTab.status = 'complete';
        timers.advance(999);
        await settle();
        assert.equal(asks(harness), 1);
        timers.advance(1);
        await settle();
        assert.equal(asks(harness), 2);
        assert.equal(banner(harness), null);
        assert.equal(shown(harness).speed, '0.80');
      });

      // A screen reader reads a notice out when the text of an element
      // that was already on the page changes.
      test('tells a screen reader of each notice as it comes, and again if it comes back', async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const { harness, timers, loaded } = await openOnLoadingPage(t, tab);
        const announcer = harness.window.document.getElementById('notice-announcer');
        assert.equal(announcer.getAttribute('role'), 'status');
        assert.equal(announcer.hidden, false);
        assert.equal(announcer.textContent, '');

        timers.advance(5000);
        await settle();
        assert.equal(announcer.textContent, LOADING);

        // The page has loaded; the popup asks again, and that look's time
        // runs out too.
        await loaded();
        await settle();
        assert.equal(announcer.textContent, '');
        timers.advance(5000);
        await settle();
        assert.equal(announcer.textContent, NOT_RESPONDING);

        tab.letGo();
        await settle();
        assert.equal(announcer.textContent, '');
        assert.equal(shown(harness).usable, true);
      });

      // The page had loaded when the look began, and began to load again
      // while the look waited: a reload made in the browser, or a link.
      test('says that it is loading when it began to load during the look', async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const activeTab = { id: 9, url: 'https://www.youtube.com/watch?v=example', status: 'complete' };
        const { harness, timers } = await open(t, tab, { activeTab });
        activeTab.status = 'loading';
        await harness.events.tabUpdated.emit(9, { status: 'loading' }, { ...activeTab });

        timers.advance(5000);
        await settle();
        assert.equal(banner(harness), LOADING);
        assert.equal(shown(harness).panel, null);
        assert.equal(shown(harness).usable, false);

        tab.hold(null);
        activeTab.status = 'complete';
        await harness.events.tabUpdated.emit(9, { status: 'complete' }, { ...activeTab });
        await settle();
        assert.equal(asks(harness), 2);
        assert.equal(banner(harness), null);
        assert.equal(shown(harness).usable, true);
        assert.equal(shown(harness).speed, '0.80');
      });

      // The page is reloaded in the browser, not with the popup's button.
      test("follows a page that wasn't responding when it loads again", async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const activeTab = { id: 9, url: 'https://www.youtube.com/watch?v=example', status: 'complete' };
        const { harness, timers } = await open(t, tab, { activeTab });
        timers.advance(5000);
        await settle();
        assert.equal(shown(harness).panel, NOT_RESPONDING);

        activeTab.status = 'loading';
        await harness.events.tabUpdated.emit(9, { status: 'loading' }, { ...activeTab });
        await settle();
        assert.equal(banner(harness), LOADING);
        assert.equal(shown(harness).panel, null);
        assert.equal(asks(harness), 1);

        // Another tab's loading is not this one's.
        await harness.events.tabUpdated.emit(4, { status: 'complete' }, { id: 4 });
        await settle();
        assert.equal(asks(harness), 1);

        tab.hold(null);
        activeTab.status = 'complete';
        await harness.events.tabUpdated.emit(9, { status: 'complete' }, { ...activeTab });
        await settle();
        assert.equal(asks(harness), 2);
        assert.equal(banner(harness), null);
        assert.equal(shown(harness).speed, '0.80');
      });

      // The tab is watched only from a look's time being up until
      // something looks at it again.
      test('stops watching the tab when something looks at it again', async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        const { harness, timers } = await openOnLoadingPage(t, tab);
        const watching = () => harness.events.tabUpdated.listeners.length;
        const notWatching = watching();
        const report = () => dispatchRuntimeMessage(
          harness.events.runtimeMessage, { type: 'SHORTCUT_APPLIED', tabId: 9 }, { id: 'example' }
        );

        for (let round = 1; round <= 3; round++) {
          tab.hold('GET_STATE');
          await report();
          await settle();
          timers.advance(5000);
          await settle();
          assert.equal(banner(harness), LOADING, `round ${round}`);
          assert.equal(watching(), notWatching + 1, `round ${round}`);

          // A shortcut the page answers: the look after it shows the tab.
          tab.hold(null);
          await report();
          await settle();
          assert.equal(banner(harness), null, `round ${round}`);
          assert.equal(watching(), notWatching, `round ${round}`);
          tab.letGo();
          await settle();

          // The browser is no longer asked about the tab either.
          const asked = () => harness.calls.order.filter((call) => call === 'tabs.query').length;
          const askedBefore = asked();
          timers.advance(3000);
          await settle();
          assert.equal(asked(), askedBefore, `round ${round}`);
        }
      });

      // The page begins to load again, and the browser's word of it is
      // missed.
      test('finds within a second that a page that was not responding has begun to load', async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const activeTab = { id: 9, url: 'https://www.youtube.com/watch?v=example', status: 'complete' };
        const { harness, timers } = await open(t, tab, { activeTab });
        timers.advance(5000);
        await settle();
        assert.equal(shown(harness).panel, NOT_RESPONDING);

        activeTab.status = 'loading';
        timers.advance(1000);
        await settle();
        assert.equal(banner(harness), LOADING);
        assert.equal(shown(harness).panel, null);
        assert.equal(asks(harness), 1);
      });

      test('stops watching the tab when a reload begins', async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const { harness, timers } = await open(t, tab, {
          beforeLoad(window) {
            // A reload that takes its time: it is still under way at the end.
            window.chrome.tabs.reload = async () => {};
          }
        });
        const watching = () => harness.events.tabUpdated.listeners.length;
        const notWatching = watching();
        timers.advance(5000);
        await settle();
        assert.equal(shown(harness).panel, NOT_RESPONDING);
        assert.equal(watching(), notWatching + 1);

        harness.window.document.getElementById('reload-btn').click();
        await settle();
        assert.equal(shown(harness).status, 'Reloading the page…');
        // One listener still: the reload's own, which waits for the page.
        assert.equal(watching(), notWatching + 1);
        timers.advance(15_000);
        await settle();
        assert.equal(watching(), notWatching);
      });

      test("says the page isn't responding when it had loaded before the look began", async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        tab.hold('GET_STATE');
        const { harness, timers } = await open(t, tab, {
          activeTab: { id: 9, url: 'https://www.youtube.com/watch?v=example', status: 'complete' }
        });
        timers.advance(5000);
        await settle();
        assert.equal(banner(harness), null);
        assert.equal(shown(harness).panel, NOT_RESPONDING);
      });
    });

    // Any look can meet a page that doesn't answer, not only the first.
    // Without this the reload button would stay disabled for good.
    test('stops waiting for a look made after a reload too', async (t) => {
      const tab = fakeTab({ enabled: false, blocked: true, blockReason: 'unsupported' });
      const { harness, timers } = await open(t, tab);
      const button = harness.window.document.getElementById('reload-btn');
      assert.equal(shown(harness).panel, "The effects can't start on this page. Reloading it usually fixes this.");

      tab.hold('GET_STATE');
      button.click();
      await settle();
      assert.equal(button.disabled, true);
      assert.equal(shown(harness).status, 'Reloading the page…');

      // The controls are disabled already, so they don't dim as well.
      timers.advance(300);
      assert.equal(shown(harness).dimmed, false);
      assert.equal(shown(harness).inert, 4);

      timers.advance(4700);
      await settle();
      assert.equal(shown(harness).panel, NOT_RESPONDING);
      assert.equal(shown(harness).status, '');
      assert.equal(button.disabled, false);
    });
  });

  // The keyboard shortcuts are handled by the background script and work
  // while the popup is open. The popup went on showing the tab as it was
  // before the shortcut (issue #181), so the background script now tells it,
  // and it looks at the tab again.
  describe('a shortcut pressed while the popup is open', { timeout: 20_000 }, () => {
    const settle = async () => {
      for (let attempt = 0; attempt < 8; attempt++) await flushPromises();
    };
    const shown = (harness) => {
      const id = (name) => harness.window.document.getElementById(name);
      return {
        on: id('power-toggle').checked,
        status: id('power-status').textContent,
        speed: id('speed-input').value,
        reverb: id('reverb-slider').value,
        bar: presetBar(harness).hidden ? null : presetBar(harness).label
      };
    };
    const asks = (harness) =>
      harness.calls.tabMessages.filter(({ message }) => message.type === 'GET_STATE').length;
    // What the background script sends an open popup after a shortcut.
    const report = (harness, tabId = 9, sender = { id: 'example' }) =>
      dispatchRuntimeMessage(harness.events.runtimeMessage, { type: 'SHORTCUT_APPLIED', tabId }, sender);
    const inert = (harness) => harness.window.document.querySelectorAll('[inert]').length;
    const notice = (harness) => !harness.window.document.getElementById('reload-panel').hidden;
    // With the popup's timers in the test's hands, so that an answer the
    // test holds back never meets the popup's real time limit.
    const open = async (t, tab, options = {}) => {
      let timers;
      const harness = await createPopupHarness({
        onTabMessage: tab.onTabMessage,
        // An answer the test holds back is waited for, however long.
        runtimeResponseTimeoutMs: null,
        ...options,
        beforeLoad(window) {
          timers = fakeTimers(window);
          options.beforeLoad?.(window);
        }
      });
      t.after(() => close(harness));
      return { harness, timers };
    };

    test('shows what each shortcut did, and the next change is made on top of it', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      const harness = await createPopupHarness({ onTabMessage: tab.onTabMessage });
      t.after(() => close(harness));
      const document = harness.window.document;
      assert.deepEqual(shown(harness), {
        on: true, status: 'On', speed: '0.80', reverb: '40', bar: 'Current Preset: Slowed + Reverb'
      });

      await harness.events.command.emit('toggle-effect');
      await settle();
      assert.equal(tab.state.enabled, false);
      assert.deepEqual(shown(harness), { on: false, status: 'Off', speed: '0.80', reverb: '40', bar: null });

      await harness.events.command.emit('toggle-nightcore');
      await settle();
      assert.deepEqual(shown(harness), {
        on: true, status: 'On', speed: '1.20', reverb: '0', bar: 'Current Preset: Nightcore'
      });

      document.getElementById('speed-up-btn').click();
      await settle();
      assert.equal(tab.state.settings.speed, 1.21);
      assert.equal(tab.state.settings.reverb, 0);
      assert.equal(shown(harness).bar, 'Current Preset: Custom');
    });

    // Reports are left alone while the popup waits for a reload, and only
    // then.
    test('shows what a shortcut did after a reload is over', async (t) => {
      const tab = fakeTab({ enabled: false, blocked: true, blockReason: 'unsupported' });
      const { harness } = await open(t, tab);
      assert.equal(notice(harness), true);

      Object.assign(tab.state, { enabled: true, settings: SLOWED, blocked: false });
      harness.window.document.getElementById('reload-btn').click();
      await settle();
      assert.deepEqual(harness.calls.reloadedTabs, [9]);
      assert.equal(notice(harness), false);
      assert.equal(shown(harness).speed, '0.80');

      await harness.events.command.emit('toggle-nightcore');
      await settle();
      assert.deepEqual(shown(harness), {
        on: true, status: 'On', speed: '1.20', reverb: '0', bar: 'Current Preset: Nightcore'
      });
    });

    // The first answer was asked for before the shortcut's change, so it is
    // the older state. A new look takes over at once, and the controls stay
    // held until that one is answered.
    test('pressed before the first answer: asks the tab anew, and holds the controls until that answer', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      tab.hold('GET_STATE');
      const { harness } = await open(t, tab);
      assert.equal(asks(harness), 1);

      // The shortcut turns the effect off, and the popup asks again. Both of
      // the popup's questions are now unanswered.
      tab.hold(null);
      await harness.events.command.emit('toggle-effect');
      tab.hold('GET_STATE');
      await settle();
      assert.equal(tab.state.enabled, false);
      assert.equal(asks(harness), 3);
      assert.equal(tab.held.length, 2);
      assert.equal(inert(harness), 4);

      // The first answer comes, from before the shortcut. It is not shown,
      // and the controls stay held.
      tab.letGo(1);
      await settle();
      assert.equal(inert(harness), 4);
      assert.equal(shown(harness).speed, '1.00');

      tab.letGo();
      await settle();
      assert.equal(inert(harness), 0);
      assert.deepEqual(shown(harness), { on: false, status: 'Off', speed: '0.80', reverb: '40', bar: null });
      assert.equal(asks(harness), 3);
    });

    // The new look doesn't wait for the first one's answer.
    test('pressed before a first answer that never comes: shows what the shortcut did', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      tab.hold('GET_STATE');
      const { harness, timers } = await open(t, tab);

      // From here on the page answers; the first question stays unanswered.
      tab.hold(null);
      await harness.events.command.emit('toggle-nightcore');
      await settle();
      const nightcore = {
        on: true, status: 'On', speed: '1.20', reverb: '0', bar: 'Current Preset: Nightcore'
      };
      assert.deepEqual(shown(harness), nightcore);
      assert.equal(inert(harness), 0);

      timers.advance(60_000);
      await settle();
      assert.equal(notice(harness), false);
      assert.deepEqual(shown(harness), nightcore);

      const asksBefore = asks(harness);
      tab.letGo();
      await settle();
      assert.deepEqual(shown(harness), nightcore);
      assert.equal(asks(harness), asksBefore);
    });

    // Until the tab has answered, the popup still shows the settings from
    // before the shortcut. A change made then would be made on top of them.
    test('holds the controls from the report until the tab has answered, and dims them if that is slow', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      const { harness, timers } = await open(t, tab);
      const document = harness.window.document;
      const dimmed = () => document.body.classList.contains('tab-slow');

      // What a shortcut for Nightcore leaves in the tab.
      tab.state.settings = { ...DEFAULT_SETTINGS, speed: 1.2 };
      tab.hold('GET_STATE');
      await report(harness);
      await settle();
      assert.equal(inert(harness), 4);
      assert.equal(dimmed(), false);
      assert.equal(shown(harness).speed, '0.80');

      // jsdom doesn't act on `inert`, so the click arrives, and is dropped.
      document.getElementById('speed-up-btn').click();
      await settle();
      assert.equal(audioUpdates(harness).length, 0);
      assert.equal(shown(harness).speed, '0.80');

      timers.advance(300);
      assert.equal(dimmed(), true);

      tab.letGo();
      await settle();
      assert.equal(inert(harness), 0);
      assert.equal(dimmed(), false);
      assert.equal(shown(harness).speed, '1.20');

      document.getElementById('speed-up-btn').click();
      await settle();
      assert.equal(tab.state.settings.speed, 1.21);
      assert.equal(tab.state.settings.reverb, 0);
    });

    // A look can end without showing settings, as when the window has no
    // tab any more. Letting go then puts back what the popup showed when the
    // hold began, which is what the tab has, and not what it showed earlier.
    test('keeps the settings it had when the look began if the look shows none', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      const { harness } = await open(t, tab);
      const { window } = harness;
      const reverb = window.document.getElementById('reverb-slider');

      reverb.value = '55';
      reverb.dispatchEvent(new window.Event('input', { bubbles: true }));
      await settle();
      assert.equal(tab.state.settings.reverb, 55);

      window.chrome.tabs.query = async () => [];
      await report(harness);
      await settle();
      assert.equal(inert(harness), 0);
      assert.equal(reverb.value, '55');
      assert.equal(shown(harness).bar, 'Current Preset: Custom');
    });

    // A button held down steps by a timer, with no event to drop.
    test('sends nothing for a button that has been held down since before the report', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      const { harness, timers } = await open(t, tab);
      const { window } = harness;
      const button = window.document.getElementById('speed-up-btn');

      button.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      timers.advance(400);
      await settle();
      assert.equal(tab.state.settings.speed, 0.81);
      const sentBefore = audioUpdates(harness).length;

      tab.state.settings = { ...DEFAULT_SETTINGS, speed: 1.2 };
      tab.hold('GET_STATE');
      await report(harness);
      await settle();
      // Five more steps of the held button.
      timers.advance(300);
      await settle();
      assert.equal(audioUpdates(harness).length, sentBefore);
      assert.equal(tab.state.settings.speed, 1.2);

      tab.letGo();
      await settle();
      assert.equal(shown(harness).speed, '1.20');
      assert.equal(audioUpdates(harness).length, sentBefore);
      button.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
    });

    // The new look has five seconds of its own, counted from when it began,
    // and the first look's limit is gone with the first look.
    test('gives the look after a shortcut a time limit of its own', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      tab.hold('GET_STATE');
      const { harness, timers } = await open(t, tab);
      const document = harness.window.document;

      timers.advance(3000);
      await report(harness);
      await settle();
      assert.equal(asks(harness), 2);

      timers.advance(4999);
      await settle();
      assert.equal(notice(harness), false);
      assert.equal(inert(harness), 4);

      timers.advance(1);
      await settle();
      assert.equal(notice(harness), true);
      assert.equal(inert(harness), 0);
      assert.equal(document.getElementById('power-toggle').disabled, true);

      // Both answers come after all, and the popup looks once more.
      tab.letGo();
      await settle();
      assert.equal(notice(harness), false);
      assert.equal(asks(harness), 3);
      assert.deepEqual(shown(harness), {
        on: true, status: 'On', speed: '0.80', reverb: '40', bar: 'Current Preset: Slowed + Reverb'
      });
    });

    // The first look hasn't begun then. It comes after the shortcut's
    // change, so it needs no second one.
    test('leaves a report that comes while the popup is still reading what is stored to the first look', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      let letStorageAnswer;
      const stored = new Promise((resolve) => {
        letStorageAnswer = resolve;
      });
      const { harness } = await open(t, tab, {
        beforeLoad(window) {
          const { local } = window.chrome.storage;
          const get = local.get.bind(local);
          local.get = async (...keys) => {
            await stored;
            return get(...keys);
          };
        }
      });

      await report(harness);
      await settle();
      assert.equal(asks(harness), 0);
      assert.equal(inert(harness), 4);

      letStorageAnswer();
      await settle();
      assert.equal(asks(harness), 1);
      assert.equal(inert(harness), 0);
      assert.equal(shown(harness).speed, '0.80');
    });

    // The popup's first question was answered before the shortcut, and the
    // shortcut's change is still being made when that answer arrives. What
    // the popup then does on top of the old answer is left out, and it
    // waits for the shortcut's change before it reads the tab again.
    for (const [name, start, onOldAnswer] of [
      [
        'a new tab is not sent its starting preset',
        { enabled: false },
        (harness) => assert.equal(inert(harness), 4)
      ],
      [
        "a change made on top of the tab's old settings is dropped",
        { enabled: true, settings: SLOWED },
        async (harness) => {
          // The first look is over, and showed the tab as it was.
          assert.equal(inert(harness), 0);
          assert.equal(shown(harness).speed, '0.80');
          harness.window.document.getElementById('speed-up-btn').click();
          await settle();
          assert.equal(inert(harness), 4);
        }
      ]
    ]) {
      test(`with a shortcut still being made, ${name}`, async (t) => {
        const tab = fakeTab(start);
        tab.hold('GET_STATE');
        const { harness } = await open(t, tab);
        assert.equal(tab.held.length, 1);

        // The shortcut's change reaches the tab and is not answered yet.
        tab.hold('UPDATE_AUDIO');
        const handled = harness.events.command.emit('toggle-nightcore');
        await settle();
        assert.equal(tab.held.length, 2);
        assert.equal(audioUpdates(harness).length, 1);

        // The popup's first answer, from before the shortcut.
        tab.letGo(1);
        await settle();
        await onOldAnswer(harness);
        assert.equal(audioUpdates(harness).length, 1);
        assert.equal(asks(harness), 2);

        tab.letGo();
        await handled;
        await settle();
        assert.equal(audioUpdates(harness).length, 1);
        assert.equal(tab.state.settings.speed, 1.2);
        assert.equal(inert(harness), 0);
        assert.deepEqual(shown(harness), {
          on: true, status: 'On', speed: '1.20', reverb: '0', bar: 'Current Preset: Nightcore'
        });
      });
    }

    // The popup sends one change at a time. A second one, waiting for the
    // first one's answer, is older than a shortcut pressed meanwhile, and
    // sent after it would undo it. The background script leaves it out.
    test("doesn't undo a shortcut with a change that was waiting to be sent before it", async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      let applies;
      const { harness } = await open(t, tab, {
        beforeLoad(window) {
          applies = heldApplies(window);
        }
      });
      const { window } = harness;
      const reverb = window.document.getElementById('reverb-slider');

      // 0.81x is with the tab and its answer is on its way; reverb 55 waits.
      applies.hold();
      window.document.getElementById('speed-up-btn').click();
      await settle();
      reverb.value = '55';
      reverb.dispatchEvent(new window.Event('input', { bubbles: true }));
      await settle();
      assert.equal(applies.held.length, 1);
      assert.equal(tab.state.settings.speed, 0.81);
      assert.equal(tab.state.settings.reverb, 40);

      await harness.events.command.emit('toggle-nightcore');
      await settle();
      assert.equal(tab.state.settings.speed, 1.2);
      assert.equal(inert(harness), 4);

      applies.letGo();
      await settle();
      assert.equal(tab.state.settings.speed, 1.2);
      assert.equal(tab.state.settings.reverb, 0);
      assert.equal(audioUpdates(harness).length, 2);
      assert.equal(inert(harness), 0);
      assert.deepEqual(shown(harness), {
        on: true, status: 'On', speed: '1.20', reverb: '0', bar: 'Current Preset: Nightcore'
      });
    });

    // Between a shortcut and the background script's word of it, the popup
    // still shows the settings from before, and its controls work. A change
    // made then is left out as well, and the popup shows what the shortcut
    // did without waiting for that word.
    test('drops a change made after a shortcut that the popup had not yet heard of', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      const reports = [];
      let holdingReports = true;
      const { harness } = await open(t, tab, {
        beforeLoad(window) {
          const { runtime } = window.chrome;
          const send = runtime.sendMessage.bind(runtime);
          runtime.sendMessage = async (message, ...rest) => {
            if (holdingReports && message?.type === 'SHORTCUT_APPLIED') {
              await new Promise((resolve) => reports.push(resolve));
            }
            return send(message, ...rest);
          };
        }
      });
      const document = harness.window.document;

      await harness.events.command.emit('toggle-nightcore');
      await settle();
      assert.equal(reports.length, 1);
      assert.equal(tab.state.settings.speed, 1.2);
      assert.equal(shown(harness).speed, '0.80');

      document.getElementById('speed-up-btn').click();
      await settle();
      assert.equal(tab.state.settings.speed, 1.2);
      assert.equal(audioUpdates(harness).length, 1);
      const nightcore = {
        on: true, status: 'On', speed: '1.20', reverb: '0', bar: 'Current Preset: Nightcore'
      };
      assert.deepEqual(shown(harness), nightcore);
      assert.equal(notice(harness), false);
      assert.equal(document.getElementById('speed-up-btn').disabled, false);

      // The next change is made knowing of the shortcut, and is taken.
      document.getElementById('speed-up-btn').click();
      await settle();
      assert.equal(tab.state.settings.speed, 1.21);
      assert.equal(tab.state.settings.reverb, 0);

      // The word of the shortcut comes last, and changes nothing.
      holdingReports = false;
      reports.shift()();
      await settle();
      assert.equal(shown(harness).speed, '1.21');
      assert.equal(tab.state.settings.speed, 1.21);
    });

    // The popup's change goes by way of the background script, and a
    // question sent meanwhile could reach the tab first and be answered
    // with the state from before the change.
    test("asks the tab only once the popup's own change has been answered", async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      let applies;
      const { harness } = await open(t, tab, {
        beforeLoad(window) {
          applies = heldApplies(window);
        }
      });
      const document = harness.window.document;
      const asksBefore = asks(harness);

      applies.hold();
      document.getElementById('speed-up-btn').click();
      await settle();
      assert.equal(applies.held.length, 1);

      await report(harness);
      await settle();
      assert.equal(asks(harness), asksBefore);

      applies.letGo();
      await settle();
      assert.equal(asks(harness), asksBefore + 1);
      assert.equal(shown(harness).speed, '0.81');
    });

    test('ends the edit of a saved preset, whose settings the shortcut replaced', async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      const harness = await createPopupHarness({
        onTabMessage: tab.onTabMessage,
        local: { customPresets: [{ ...DEFAULT_SETTINGS, id: 'fine', name: 'Fine', speed: 0.97 }] }
      });
      t.after(() => close(harness));
      const document = harness.window.document;
      document.querySelector('.edit-preset-btn').click();
      await settle();
      assert.ok(document.querySelector('.custom-preset-name-input'));
      assert.equal(shown(harness).bar, 'Editing: Fine');

      await harness.events.command.emit('toggle-nightcore');
      await settle();
      assert.equal(document.querySelector('.custom-preset-name-input'), null);
      assert.equal(shown(harness).bar, 'Current Preset: Nightcore');
      assert.equal(harness.local.data.customPresets[0].speed, 0.97);
    });

    test("stops waiting when the page doesn't answer the look that follows a shortcut", async (t) => {
      const tab = fakeTab({ enabled: true, settings: SLOWED });
      const { harness, timers } = await open(t, tab);
      const document = harness.window.document;

      tab.hold('GET_STATE');
      await report(harness);
      await settle();
      timers.advance(5000);
      await settle();
      assert.equal(notice(harness), true);
      assert.equal(inert(harness), 0);
      assert.equal(document.getElementById('power-toggle').disabled, true);
    });

    for (const [name, tabId, sender] of [
      ['about another tab', 4, { id: 'example' }],
      ["from a page's script", 9, { id: 'example', tab: { id: 9 } }],
      ['from another extension', 9, { id: 'another' }]
    ]) {
      test(`ignores a report ${name}`, async (t) => {
        const tab = fakeTab({ enabled: true, settings: SLOWED });
        const harness = await createPopupHarness({ onTabMessage: tab.onTabMessage });
        t.after(() => close(harness));
        const asksBefore = asks(harness);

        tab.state.enabled = false;
        await report(harness, tabId, sender);
        await settle();
        assert.equal(asks(harness), asksBefore);
        assert.equal(shown(harness).on, true);
      });
    }
  });
});
