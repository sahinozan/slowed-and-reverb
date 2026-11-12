const api = typeof browser !== 'undefined' ? browser : chrome;

// Chromium runs this file as a service worker, which loads settings.js here;
// the Firefox build lists settings.js before this file instead.
if (typeof importScripts === 'function') importScripts('settings.js');

const { PRESETS, normalize: normalizeSettings, match: settingsMatch } = SlowedReverbSettings;

const COMMAND_PRESETS = {
  'toggle-slowed-reverb': PRESETS.slowed,
  'toggle-nightcore': PRESETS.nightcore
};

const ICONS = {
  on: { 16: 'assets/icon16.png', 48: 'assets/icon48.png', 128: 'assets/icon128.png' },
  off: { 16: 'assets/icon16-off.png', 48: 'assets/icon48-off.png', 128: 'assets/icon128-off.png' }
};

const RESTORABLE_URL = /^https?:\/\//i;
const TAB_STATE_PREFIX = 'tabState:';
const tabApplyQueues = new Map();
// How many shortcuts have changed each tab since this script started. An
// open popup shows a tab as it was after a certain one of them, and names
// that one with each change it sends (shortcutMark); a change made on top
// of settings from before the tab's last shortcut is left out
// (APPLY_TO_TAB).
//
// Nothing of this is stored. The browser stops this script when it has had
// nothing to do for a while, or has been kept busy for minutes, and starts
// it again; then no shortcut is remembered and every change is taken. A
// change is on its way for a moment, so one from before a shortcut is not
// expected to outlast the script. The marks carry a name for this run of
// the script, so that a shortcut after a restart isn't taken for one a
// popup saw before it.
const RUN = Math.random().toString(36).slice(2);
const shortcutCounts = new Map();
const SPOTIFY_ORIGIN = 'https://open.spotify.com/*';
const SPOTIFY_PAGE_ORIGIN = 'https://open.spotify.com';
const SPOTIFY_SCRIPT_IDS = ['spotify-main', 'spotify-bridge'];
const spotifyBridgeTabs = new Set();
const youtubeTabs = new Map();
const YOUTUBE_PERMISSION_ORIGINS = Object.freeze({
  'www.youtube.com': 'https://www.youtube.com/*',
  'music.youtube.com': 'https://music.youtube.com/*'
});
let spotifyRegistrationQueue = Promise.resolve();

function isExtensionPageSender(sender) {
  if (sender.id !== api.runtime.id) return false;
  const senderUrl = sender.url ?? sender.origin;
  if (typeof senderUrl !== 'string') return false;

  try {
    const url = new URL(senderUrl);
    return (
      (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') &&
      url.pathname === '/popup.html'
    );
  } catch {
    return false;
  }
}

// The supported sites are HTTPS only. Hosts are looked up as the table's own
// keys, so a host named like a built-in property, such as "constructor",
// isn't one.
function isSpotifyUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname === 'open.spotify.com';
  } catch {
    return false;
  }
}

function getYouTubePermissionOrigin(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && Object.hasOwn(YOUTUBE_PERMISSION_ORIGINS, hostname)
      ? YOUTUBE_PERMISSION_ORIGINS[hostname]
      : null;
  } catch {
    return null;
  }
}

function isYouTubeUrl(url) {
  return getYouTubePermissionOrigin(url) !== null;
}

async function hasSpotifyPermission() {
  return api.permissions.contains({ origins: [SPOTIFY_ORIGIN] });
}

async function syncSpotifyRegistrationNow() {
  const registered = await api.scripting.getRegisteredContentScripts({ ids: SPOTIFY_SCRIPT_IDS });
  const registeredIds = new Set(registered.map(({ id }) => id));

  if (!(await hasSpotifyPermission())) {
    const staleIds = SPOTIFY_SCRIPT_IDS.filter((id) => registeredIds.has(id));
    if (staleIds.length > 0) await api.scripting.unregisterContentScripts({ ids: staleIds });
    return { granted: false };
  }

  const scripts = [
    {
      id: 'spotify-main',
      matches: [SPOTIFY_ORIGIN],
      js: ['spotify-main.js'],
      runAt: 'document_start',
      world: 'MAIN'
    },
    {
      id: 'spotify-bridge',
      matches: [SPOTIFY_ORIGIN],
      js: ['spotify-bridge.js'],
      runAt: 'document_start',
      world: 'ISOLATED'
    }
  ].filter(({ id }) => !registeredIds.has(id));

  if (scripts.length > 0) await api.scripting.registerContentScripts(scripts);
  return { granted: true };
}

function syncSpotifyRegistration() {
  spotifyRegistrationQueue = spotifyRegistrationQueue
    .catch(() => {})
    .then(syncSpotifyRegistrationNow);
  return spotifyRegistrationQueue;
}

async function enableSpotifyForActiveTab() {
  const registration = await syncSpotifyRegistration();
  if (!registration.granted) return;

  const tab = await getActiveTab();
  if (tab?.id !== undefined && isSpotifyUrl(tab.url)) await api.tabs.reload(tab.id);
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function tabStateKey(tabId) {
  return `${TAB_STATE_PREFIX}${tabId}`;
}

async function rememberTabState(tabId, url, enabled, settings) {
  const origin = getOrigin(url);
  if (!origin) return;
  await api.storage.session.set({
    [tabStateKey(tabId)]: { origin, enabled: Boolean(enabled), settings: normalizeSettings(settings) }
  });
}

async function recallTabState(tabId, url) {
  const key = tabStateKey(tabId);
  const entry = (await api.storage.session.get(key))[key];
  if (entry?.origin !== getOrigin(url)) return null;
  return {
    origin: entry.origin,
    enabled: Boolean(entry.enabled),
    settings: normalizeSettings(entry.settings)
  };
}

async function forgetTabState(tabId) {
  await api.storage.session.remove(tabStateKey(tabId));
}

// The tab's last shortcut in this run of the script, or null when there
// has been none.
function shortcutMark(tabId) {
  const count = shortcutCounts.get(tabId);
  return count ? `${RUN}:${count}` : null;
}

async function storedTabStatesForOrigins(origins) {
  const stored = await api.storage.session.get(null);
  const matches = new Map();

  for (const [key, entry] of Object.entries(stored)) {
    if (!key.startsWith(TAB_STATE_PREFIX) || !origins.has(entry?.origin)) continue;
    const tabId = Number(key.slice(TAB_STATE_PREFIX.length));
    if (Number.isInteger(tabId) && tabId >= 0) matches.set(tabId, entry);
  }

  return matches;
}

async function setTabIcon(tabId, enabled) {
  try {
    await api.action.setIcon({ tabId, path: enabled ? ICONS.on : ICONS.off });
  } catch {}
}

async function ensureContentScript(tabId) {
  try {
    // The audio engine goes into the page's world first, so it is listening
    // when content.js starts.
    await api.scripting.executeScript({ target: { tabId }, files: ['youtube-main.js'], world: 'MAIN' });
    await api.scripting.executeScript({ target: { tabId }, files: ['settings.js', 'content.js'] });
    return true;
  } catch {
    return false;
  }
}

async function getTabState(tabId) {
  let tabUrl = null;
  try {
    tabUrl = (await api.tabs.get(tabId)).url;
  } catch {}

  if (isSpotifyUrl(tabUrl)) {
    if (!(await hasSpotifyPermission())) {
      return { enabled: false, blocked: true, blockReason: 'permission' };
    }
    try {
      return await api.tabs.sendMessage(tabId, { type: 'GET_STATE' });
    } catch {
      return { enabled: false, blocked: true, blockReason: 'reload' };
    }
  }

  if (!isYouTubeUrl(tabUrl)) {
    return { enabled: false, blocked: true, blockReason: 'unsupportedSite' };
  }

  if (!(await ensureContentScript(tabId))) {
    return { enabled: false, blocked: true, blockReason: 'unsupported' };
  }
  try {
    return await api.tabs.sendMessage(tabId, { type: 'GET_STATE' });
  } catch {
    return { enabled: false, blocked: true, blockReason: 'unsupported' };
  }
}

async function applyToTab(tabId, url, settings, enabled) {
  settings = normalizeSettings(settings);
  const spotify = isSpotifyUrl(url);

  if (spotify && !(await hasSpotifyPermission())) {
    return { success: false, blocked: true, blockReason: 'permission' };
  }

  if (!spotify && !isYouTubeUrl(url)) {
    await forgetTabState(tabId);
    await setTabIcon(tabId, false);
    return { success: false, blocked: true, blockReason: 'unsupportedSite' };
  }

  if (!spotify && !(await ensureContentScript(tabId))) {
    await forgetTabState(tabId);
    await setTabIcon(tabId, false);
    return { success: false, blocked: true, blockReason: 'unsupported' };
  }

  let response;
  try {
    response = await api.tabs.sendMessage(tabId, { type: 'UPDATE_AUDIO', settings, enabled });
  } catch {
    response = null;
  }

  if (!response?.success) {
    await forgetTabState(tabId);
    await setTabIcon(tabId, false);
    return {
      success: false,
      blocked: Boolean(response?.blocked),
      blockReason: response?.blockReason ?? 'unsupported'
    };
  }

  await api.storage.local.set(settings);
  await rememberTabState(tabId, url, enabled, settings);
  if (!spotify) youtubeTabs.set(tabId, getYouTubePermissionOrigin(url));
  const iconEnabled = Boolean(enabled && (response.processingActive ?? true));
  await setTabIcon(tabId, iconEnabled);
  return {
    success: true,
    enabled,
    playerDetected: response.playerDetected,
    processingActive: response.processingActive,
    pending: response.pending,
    effectsUnavailable: response.effectsUnavailable
  };
}

function queueTabApply(tabId, url, settings, enabled) {
  return queueForTab(tabId, () => applyToTab(tabId, url, settings, enabled));
}

// One thing at a time is done to a tab, in the order asked for.
function queueForTab(tabId, task) {
  const previous = tabApplyQueues.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  tabApplyQueues.set(tabId, next);
  const clearQueue = () => {
    if (tabApplyQueues.get(tabId) === next) tabApplyQueues.delete(tabId);
  };
  next.then(clearQueue, clearQueue);
  return next;
}

async function getActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

api.commands.onCommand.addListener(async (command) => {
  const tab = await getActiveTab();
  if (tab?.id === undefined) return;

  const state = await getTabState(tab.id);
  if (state?.blocked) return;

  const preset = COMMAND_PRESETS[command];
  if (preset) {
    const isActive = Boolean(state?.enabled && settingsMatch(state.settings, preset));
    await applyShortcut(tab, preset, !isActive);
    return;
  }

  if (command !== 'toggle-effect') return;

  if (state?.enabled) {
    await applyShortcut(tab, state.settings, false);
    return;
  }

  const remembered = await recallTabState(tab.id, tab.url);
  await applyShortcut(tab, remembered?.settings ?? PRESETS.slowed, true);
});

// Does what a shortcut asks for. A shortcut works while the popup is open,
// and the popup shows the tab as it was when it last looked, so it is told
// to look again (handleShortcutReport in popup.js). Nothing hears this when
// no popup is open.
//
// The tab's count of shortcuts is raised in the same step as the change is
// put in the tab's queue. So whatever is asked for the tab after this comes
// after the shortcut's change, and with the new mark.
async function applyShortcut(tab, settings, enabled) {
  shortcutCounts.set(tab.id, (shortcutCounts.get(tab.id) ?? 0) + 1);
  try {
    await queueTabApply(tab.id, tab.url, settings, enabled);
  } finally {
    api.runtime.sendMessage({ type: 'SHORTCUT_APPLIED', tabId: tab.id }).catch(() => {});
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  const extensionPageSender = isExtensionPageSender(sender);
  const senderTabId = sender.tab?.id;
  const senderTabUrl = sender.tab?.url;

  if (message.type === 'CONTENT_STATE_CHANGED') {
    const contentUrl = senderTabUrl ?? message.origin;
    if (
      extensionPageSender ||
      senderTabId === undefined ||
      (!isYouTubeUrl(contentUrl) && !isSpotifyUrl(contentUrl))
    ) return;
    const youtubeOrigin = getYouTubePermissionOrigin(contentUrl);
    if (youtubeOrigin) youtubeTabs.set(senderTabId, youtubeOrigin);
    const iconEnabled = Boolean(message.enabled && (message.processingActive ?? true));
    setTabIcon(senderTabId, iconEnabled);
    rememberTabState(
      senderTabId,
      contentUrl,
      message.enabled,
      normalizeSettings(message.settings)
    );
    return;
  }

  if (message.type === 'SPOTIFY_BRIDGE_READY') {
    const contentUrl = senderTabUrl ?? message.origin;
    if (!extensionPageSender && senderTabId !== undefined && isSpotifyUrl(contentUrl)) {
      spotifyBridgeTabs.add(senderTabId);
    }
    return;
  }

  if (message.type === 'GET_TAB_STATE') {
    const tabId = extensionPageSender ? message.tabId : senderTabId;
    const url = extensionPageSender ? message.url : (senderTabUrl ?? message.url);
    if (tabId === undefined || !url) return;
    if (!extensionPageSender && !isYouTubeUrl(url) && !isSpotifyUrl(url)) return;
    // Content scripts cannot access storage.session or discover their own tab id.
    recallTabState(tabId, url).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }

  if (message.type === 'APPLY_TO_TAB') {
    if (!extensionPageSender) return;
    if (message.tabId === undefined || !message.url) return;
    // The popup names the tab's last shortcut as of when it read the
    // settings this change was made on top of. If a shortcut has changed the
    // tab since, the change would undo it, so it is left out and the popup
    // is told. The popup then looks at the tab again. A change that names
    // nothing, as the website's popup sends, is taken.
    const mark = shortcutMark(message.tabId);
    if (mark !== null && message.shortcut !== undefined && message.shortcut !== mark) {
      sendResponse({ success: false, superseded: true });
      return;
    }
    queueTabApply(
      message.tabId,
      message.url,
      normalizeSettings(message.settings),
      Boolean(message.enabled)
    )
      .then(sendResponse)
      .catch(() =>
        sendResponse({ success: false, blocked: true, blockReason: 'unsupported' })
      );
    return true;
  }

  if (message.type === 'WAIT_FOR_TAB') {
    if (!extensionPageSender || message.tabId === undefined) return;
    // Answers once everything asked of the tab so far has been done, with
    // the tab's last shortcut as it was when this was asked. What the popup
    // then reads from the tab is from after that shortcut.
    const shortcut = shortcutMark(message.tabId);
    queueForTab(message.tabId, () => ({ shortcut }))
      .then(sendResponse)
      .catch(() => sendResponse({}));
    return true;
  }

  if (message.type === 'SYNC_SPOTIFY_REGISTRATION') {
    if (!extensionPageSender) return;
    syncSpotifyRegistration()
      .then(sendResponse)
      .catch(() => sendResponse({ granted: false, error: true }));
    return true;
  }
});

api.permissions.onAdded.addListener((added) => {
  const setup = added.origins?.includes(SPOTIFY_ORIGIN)
    ? enableSpotifyForActiveTab()
    : syncSpotifyRegistration();
  setup.catch(() => {});
});

api.permissions.onRemoved.addListener((removed) => {
  const removedOrigins = new Set(removed.origins ?? []);
  const tasks = [];

  if (removedOrigins.has(SPOTIFY_ORIGIN)) tasks.push(cleanupSpotifyPermission());

  const removedYouTubeOrigins = new Set(
    Object.values(YOUTUBE_PERMISSION_ORIGINS).filter((origin) => removedOrigins.has(origin))
  );
  if (removedYouTubeOrigins.size > 0) {
    tasks.push(cleanupYouTubePermissions(removedYouTubeOrigins));
  }

  Promise.allSettled(tasks).catch(() => {});
});

async function cleanupSpotifyPermission() {
  const storedTabs = await storedTabStatesForOrigins(new Set([SPOTIFY_PAGE_ORIGIN]));
  const tabIds = new Set([...spotifyBridgeTabs, ...storedTabs.keys()]);

  await Promise.all([...tabIds].map(async (tabId) => {
    let shouldNeutralize = storedTabs.has(tabId);
    if (!shouldNeutralize) {
      try {
        shouldNeutralize = isSpotifyUrl((await api.tabs.get(tabId)).url);
      } catch {}
    }

    if (shouldNeutralize) {
      const tasks = [
        api.tabs.sendMessage(tabId, { type: 'SPOTIFY_PERMISSION_REVOKED' }),
        setTabIcon(tabId, false)
      ];
      if (storedTabs.has(tabId)) tasks.push(forgetTabState(tabId));
      await Promise.allSettled(tasks);
    }
    spotifyBridgeTabs.delete(tabId);
  }));
  await syncSpotifyRegistration();
}

async function cleanupYouTubePermissions(removedOrigins) {
  const pageOrigins = new Set(
    [...removedOrigins]
      .map((origin) => getOrigin(origin.replaceAll('*', '')))
      .filter(Boolean)
  );
  const storedTabs = await storedTabStatesForOrigins(pageOrigins);
  const trackedTabs = [...youtubeTabs]
    .filter(([, origin]) => removedOrigins.has(origin))
    .map(([tabId]) => tabId);
  const tabIds = new Set([...trackedTabs, ...storedTabs.keys()]);

  await Promise.all([...tabIds].map(async (tabId) => {
    const tasks = [
      api.tabs.sendMessage(tabId, { type: 'YOUTUBE_PERMISSION_REVOKED' }),
      setTabIcon(tabId, false)
    ];
    if (storedTabs.has(tabId)) tasks.push(forgetTabState(tabId));
    await Promise.allSettled(tasks);
    youtubeTabs.delete(tabId);
  }));
}

api.runtime.onInstalled.addListener(() => {
  syncSpotifyRegistration().catch(() => {});
});

api.runtime.onStartup.addListener(() => {
  syncSpotifyRegistration().catch(() => {});
});

api.tabs.onRemoved.addListener((tabId) => {
  shortcutCounts.delete(tabId);
  spotifyBridgeTabs.delete(tabId);
  youtubeTabs.delete(tabId);
  forgetTabState(tabId).catch(() => {});
});

api.tabs.onActivated.addListener(async ({ tabId }) => {
  let tabUrl = null;
  try {
    tabUrl = (await api.tabs.get(tabId)).url;
  } catch {}
  const remembered = tabUrl ? await recallTabState(tabId, tabUrl) : null;
  if (!remembered?.enabled) {
    await setTabIcon(tabId, false);
    return;
  }
  const state = await getTabState(tabId);
  await setTabIcon(tabId, Boolean(state?.enabled));
});

api.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    const trackedOrigin = youtubeTabs.get(tabId);
    if (trackedOrigin && trackedOrigin !== getYouTubePermissionOrigin(tab.url)) {
      youtubeTabs.delete(tabId);
    }
    setTabIcon(tabId, false);
    return;
  }

  if (changeInfo.status !== 'complete' || !RESTORABLE_URL.test(tab.url ?? '')) return;

  const remembered = await recallTabState(tabId, tab.url);
  if (!remembered?.enabled) {
    await setTabIcon(tabId, false);
    return;
  }

  // Injection asks this worker for remembered state and restores it inside the page.
  const state = await getTabState(tabId);
  await setTabIcon(tabId, Boolean(state?.enabled));
});
