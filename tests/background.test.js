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
  loadScript('extension/background.js', { chrome: harness.api });
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
    // Also hosts named like an object's built-in properties, and the
    // supported hosts without HTTPS.
    for (const url of [
      'https://www.twitch.tv/example',
      'https://studio.youtube.com/',
      'https://constructor/',
      'https://tostring/',
      'http://www.youtube.com/watch?v=one',
      'http://music.youtube.com/'
    ]) {
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

  // A shortcut works while the popup is open, and the popup shows the tab as
  // it was when it last looked (issue #181). So the background script tells
  // it, once the change has been made.
  describe('telling an open popup about a shortcut', () => {
    const freshTab = (updateAnswer) => (_tabId, message) =>
      message.type === 'GET_STATE'
        ? { enabled: false, settings: DEFAULT_SETTINGS, blocked: false }
        : updateAnswer;
    // What the popup would hear, with how many changes the tab had been
    // sent by then.
    const listen = (options) => {
      const heard = [];
      const harness = setup({
        ...options,
        onRuntimeMessage(message) {
          // Copied, as the script's own objects aren't this file's.
          heard.push({ message: { ...message }, changesSent: updates(harness.calls).length });
        }
      });
      return { harness, heard };
    };

    test('says which tab, after the change has been sent', async () => {
      const { harness, heard } = listen({ onTabMessage: freshTab({ success: true }) });

      await harness.events.command.emit('toggle-slowed-reverb');
      assert.deepEqual(heard, [{ message: { type: 'SHORTCUT_APPLIED', tabId: 7 }, changesSent: 1 }]);

      await harness.events.command.emit('toggle-effect');
      assert.equal(heard.length, 2);
      assert.deepEqual(heard[1], { message: { type: 'SHORTCUT_APPLIED', tabId: 7 }, changesSent: 2 });
    });

    // The popup asks the tab when it hears this, so the tab must have the
    // change by then, not only have been sent it.
    test("says nothing until the tab has answered the change", async () => {
      let answerChange;
      const { harness, heard } = listen({
        onTabMessage(_tabId, message) {
          if (message.type === 'GET_STATE') {
            return { enabled: false, settings: DEFAULT_SETTINGS, blocked: false };
          }
          return new Promise((resolve) => {
            answerChange = () => resolve({ success: true });
          });
        }
      });

      const handled = harness.events.command.emit('toggle-slowed-reverb');
      for (let attempt = 0; attempt < 8; attempt++) await flushPromises();
      assert.equal(updates(harness.calls).length, 1);
      assert.deepEqual(heard, []);

      answerChange();
      await handled;
      assert.equal(heard.length, 1);
    });

    test('says so too when the tab refused the change', async () => {
      const { harness, heard } = listen({ onTabMessage: freshTab(null) });

      await harness.events.command.emit('toggle-nightcore');
      assert.deepEqual(heard, [{ message: { type: 'SHORTCUT_APPLIED', tabId: 7 }, changesSent: 1 }]);
    });

    test('says nothing for a shortcut that changed nothing', async () => {
      const { harness, heard } = listen({
        onTabMessage(_tabId, message) {
          return message.type === 'GET_STATE' ? { blocked: true, blockReason: 'drm' } : null;
        }
      });

      await harness.events.command.emit('toggle-nightcore');
      assert.deepEqual(heard, []);
    });

    // With no popup open the browser rejects the message: nothing received it.
    test('changes the tab all the same when no popup is open to hear of it', async () => {
      const harness = setup({
        onTabMessage: freshTab({ success: true }),
        async onRuntimeMessage() {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
      });

      await harness.events.command.emit('toggle-slowed-reverb');
      await flushPromises();
      assert.equal(updates(harness.calls).length, 1);
      assert.equal(harness.session.data['tabState:7'].enabled, true);
    });
  });

  // The popup shows a tab as it was after a certain shortcut, and names that
  // one with each change. A change made on top of settings from before the
  // tab's last shortcut would undo the shortcut, so it is left out, and the
  // popup is told.
  // The tests here that hold an answer back wait for it with no limit of
  // real time, so the group has a deadline, which its tests share.
  describe('a change the popup made on top of settings from before a shortcut', { timeout: 20_000 }, () => {
    const NIGHTCORE = { ...DEFAULT_SETTINGS, speed: 1.2 };
    const popup = { id: 'example', url: 'chrome-extension://example/popup.html' };
    // A tab that keeps what it is set to. The script's own objects aren't
    // this file's, so settings are copied before they are compared.
    const livingTab = () => {
      const tab = { enabled: false, settings: DEFAULT_SETTINGS };
      return {
        tab,
        onTabMessage(_tabId, message) {
          if (message.type === 'GET_STATE') return { ...tab, blocked: false };
          Object.assign(tab, { enabled: message.enabled, settings: message.settings });
          return { success: true };
        }
      };
    };
    const ask = (harness, message) => dispatchRuntimeMessage(
      harness.events.runtimeMessage, message, popup, null
    );
    const change = (harness, fields) => ask(harness, {
      type: 'APPLY_TO_TAB', tabId: 7, url: 'https://www.youtube.com/watch?v=one',
      settings: SLOWED, enabled: true, ...fields
    });
    // The tab's last shortcut, as the popup is given it when it waits.
    const shortcutOf = async (harness, tabId = 7) =>
      (await ask(harness, { type: 'WAIT_FOR_TAB', tabId })).shortcut;
    const settle = async () => {
      for (let attempt = 0; attempt < 8; attempt++) await flushPromises();
    };
    // The answer, if it comes without anything else having to happen first,
    // and otherwise PENDING. A test that waited for an answer that is held
    // back would never end.
    const PENDING = Symbol('no answer yet');
    const atOnce = (answer) => Promise.race([answer, settle().then(() => PENDING)]);
    const withShortcut = async () => {
      const { tab, onTabMessage } = livingTab();
      const harness = setup({ onTabMessage, onRuntimeMessage() {} });
      const before = await shortcutOf(harness);
      await harness.events.command.emit('toggle-nightcore');
      return { harness, tab, before };
    };

    test('names each shortcut that changed a tab, and not one that changed nothing', async () => {
      const { harness, before } = await withShortcut();
      assert.equal(before, null);
      const first = await shortcutOf(harness);
      assert.equal(typeof first, 'string');
      assert.equal(await shortcutOf(harness, 8), null);

      await harness.events.command.emit('toggle-effect');
      const second = await shortcutOf(harness);
      assert.equal(typeof second, 'string');
      assert.notEqual(second, first);

      const blocked = setup({
        onTabMessage: () => ({ blocked: true, blockReason: 'drm' }),
        onRuntimeMessage() {}
      });
      await blocked.events.command.emit('toggle-nightcore');
      assert.equal(await shortcutOf(blocked), null);
    });

    test('is left out, and the popup is told', async () => {
      const { harness, tab, before } = await withShortcut();

      const answer = await change(harness, { shortcut: before });
      assert.deepEqual({ ...answer }, { success: false, superseded: true });
      assert.equal(updates(harness.calls).length, 1);
      assert.deepEqual({ ...tab.settings }, NIGHTCORE);
      assert.deepEqual({ ...harness.session.data['tabState:7'].settings }, NIGHTCORE);
    });

    test('is left out when it was made after an earlier shortcut, not the last', async () => {
      const { harness, tab } = await withShortcut();
      const first = await shortcutOf(harness);
      await harness.events.command.emit('toggle-nightcore');
      assert.equal(tab.enabled, false);

      const answer = await change(harness, { shortcut: first });
      assert.equal(answer.superseded, true);
      assert.equal(tab.enabled, false);
    });

    test('is taken when it was made on top of what the shortcut left', async () => {
      const { harness, tab } = await withShortcut();

      const answer = await change(harness, { shortcut: await shortcutOf(harness) });
      assert.equal(answer.success, true);
      assert.deepEqual({ ...tab.settings }, SLOWED);
    });

    test('is taken on a tab no shortcut has changed', async () => {
      const { harness } = await withShortcut();

      const answer = await change(harness, { tabId: 8, shortcut: null });
      assert.equal(answer.success, true);
      assert.equal(updates(harness.calls).length, 2);
    });

    // The website's popup and the tests' stand-ins name no shortcut.
    test('is taken when it names nothing', async () => {
      const { harness, tab } = await withShortcut();

      const answer = await change(harness, {});
      assert.equal(answer.success, true);
      assert.deepEqual({ ...tab.settings }, SLOWED);
    });

    // The tab's changes are made one after another, so a change of the
    // popup's that comes while the shortcut's is still being made would be
    // made after it. And what the popup reads from the tab meanwhile would
    // be from before the shortcut, so the popup is made to wait.
    test('is left out while the shortcut is still being made, and the popup waits for the shortcut', async () => {
      let answerShortcut;
      const harness = setup({
        onTabMessage(_tabId, message) {
          if (message.type === 'GET_STATE') {
            return { enabled: false, settings: DEFAULT_SETTINGS, blocked: false };
          }
          return new Promise((resolve) => {
            answerShortcut = () => resolve({ success: true });
          });
        },
        onRuntimeMessage() {}
      });
      const before = await shortcutOf(harness);
      const handled = harness.events.command.emit('toggle-nightcore');
      await settle();
      assert.equal(updates(harness.calls).length, 1);

      const answer = await atOnce(change(harness, { shortcut: before }));
      assert.notEqual(answer, PENDING);
      assert.equal(answer.superseded, true);

      const waited = shortcutOf(harness);
      assert.equal(await atOnce(waited), PENDING);

      answerShortcut();
      await handled;
      assert.equal(typeof (await atOnce(waited)), 'string');
      assert.equal(updates(harness.calls).length, 1);
    });

    // A second shortcut begins while the popup waits for the first. What
    // the popup then reads from the tab may be from before the second one,
    // so it is given the first, as when it asked, and a change it makes on
    // top of that is left out.
    test('gives the popup the shortcut that was the last when it began to wait', async () => {
      const answers = [];
      const harness = setup({
        onTabMessage(_tabId, message) {
          if (message.type === 'GET_STATE') {
            return { enabled: false, settings: DEFAULT_SETTINGS, blocked: false };
          }
          return new Promise((resolve) => answers.push(() => resolve({ success: true })));
        },
        onRuntimeMessage() {}
      });
      const first = harness.events.command.emit('toggle-nightcore');
      await settle();

      const waited = shortcutOf(harness);
      await settle();
      const second = harness.events.command.emit('toggle-slowed-reverb');
      assert.equal(await atOnce(waited), PENDING);

      answers.shift()();
      await first;
      const given = await atOnce(waited);
      assert.equal(typeof given, 'string');
      const answer = await atOnce(change(harness, { shortcut: given }));
      assert.notEqual(answer, PENDING);
      assert.equal(answer.superseded, true);

      // The second shortcut's change has reached the tab by now.
      await settle();
      answers.shift()();
      await second;
      assert.notEqual(await shortcutOf(harness), given);
    });

    // The browser stops this script when it has had nothing to do for a
    // while, and starts it again for the next message. Nothing of the
    // shortcuts is stored, so it then remembers none, and a popup that is
    // still open can go on changing the tab.
    test('is taken after the background script has been started again', async () => {
      const { tab, onTabMessage } = livingTab();
      const first = setup({ onTabMessage, onRuntimeMessage() {} });
      await first.events.command.emit('toggle-nightcore');
      const seen = await shortcutOf(first);
      assert.deepEqual(Object.keys(first.session.data), ['tabState:7']);

      const again = setup({ onTabMessage, onRuntimeMessage() {}, session: first.session.data });
      assert.equal(await shortcutOf(again), null);
      const answer = await change(again, { shortcut: seen });
      assert.equal(answer.success, true);
      assert.deepEqual({ ...tab.settings }, SLOWED);
    });

    // After a restart the count begins again. The first shortcut then must
    // not be taken for the first one of the run before, which an open popup
    // has seen.
    test('is left out after a restart when a new shortcut has changed the tab', async () => {
      const { tab, onTabMessage } = livingTab();
      const first = setup({ onTabMessage, onRuntimeMessage() {} });
      await first.events.command.emit('toggle-slowed-reverb');
      const seen = await shortcutOf(first);

      const again = setup({ onTabMessage, onRuntimeMessage() {}, session: first.session.data });
      await again.events.command.emit('toggle-nightcore');
      assert.notEqual(await shortcutOf(again), seen);
      const answer = await change(again, { shortcut: seen });
      assert.equal(answer.superseded, true);
      assert.deepEqual({ ...tab.settings }, NIGHTCORE);
    });

    test('is taken after the tab has closed and its number is used again', async () => {
      const { harness, tab, before } = await withShortcut();

      await harness.events.tabRemoved.emit(7);
      await flushPromises();
      assert.equal(await shortcutOf(harness), null);
      const answer = await change(harness, { shortcut: before });
      assert.equal(answer.success, true);
      assert.deepEqual({ ...tab.settings }, SLOWED);
    });

    test('answers the wait only for the extension\'s own pages', async () => {
      const { harness } = await withShortcut();
      const fromPage = await dispatchRuntimeMessage(
        harness.events.runtimeMessage,
        { type: 'WAIT_FOR_TAB', tabId: 7 },
        { id: 'example', tab: { id: 7, url: 'https://www.youtube.com/watch?v=one' } }
      );
      assert.equal(fromPage, undefined);
    });
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
