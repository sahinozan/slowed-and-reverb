const api = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SETTINGS = Object.freeze({
  speed: 1.0,
  reverb: 0,
  echo: 0,
  pan: 0,
  width: 100,
  keepPitch: false,
  saturation: 0,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0
});

const PRESETS = Object.freeze({
  slowed: Object.freeze({ ...DEFAULT_SETTINGS, speed: 0.8, reverb: 40 }),
  nightcore: Object.freeze({ ...DEFAULT_SETTINGS, speed: 1.2 })
});

const COMMAND_PRESETS = {
  'toggle-slowed-reverb': PRESETS.slowed,
  'toggle-nightcore': PRESETS.nightcore
};

const ICONS = {
  on: { 16: 'assets/icon16.png', 48: 'assets/icon48.png', 128: 'assets/icon128.png' },
  off: { 16: 'assets/icon16-off.png', 48: 'assets/icon48-off.png', 128: 'assets/icon128-off.png' }
};

const SPEED_EPSILON = 0.001;
const SETTING_BOUNDS = Object.freeze({
  speed: Object.freeze([0.5, 1.5]),
  reverb: Object.freeze([0, 100]),
  echo: Object.freeze([0, 100]),
  pan: Object.freeze([-100, 100]),
  width: Object.freeze([0, 200]),
  saturation: Object.freeze([0, 100]),
  eqLow: Object.freeze([-12, 12]),
  eqMid: Object.freeze([-12, 12]),
  eqHigh: Object.freeze([-12, 12])
});
const RESTORABLE_URL = /^https?:\/\//i;
const TAB_STATE_PREFIX = 'tabState:';
const tabApplyQueues = new Map();
const SPOTIFY_ORIGIN = 'https://open.spotify.com/*';
const SPOTIFY_SCRIPT_IDS = ['spotify-main', 'spotify-bridge'];
const spotifyBridgeTabs = new Set();
const youtubeTabs = new Map();
const YOUTUBE_PERMISSION_ORIGINS = Object.freeze({
  'www.youtube.com': 'https://www.youtube.com/*',
  'music.youtube.com': 'https://music.youtube.com/*'
});
let spotifyRegistrationQueue = Promise.resolve();

function normalizeSettings(settings) {
  const normalized = { ...DEFAULT_SETTINGS };
  if (!settings || typeof settings !== 'object') return normalized;

  for (const [key, [minimum, maximum]] of Object.entries(SETTING_BOUNDS)) {
    const value = settings[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      normalized[key] = Math.min(maximum, Math.max(minimum, value));
    }
  }
  normalized.keepPitch = settings.keepPitch === true;
  return normalized;
}

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

function isSpotifyUrl(url) {
  try {
    return new URL(url).hostname === 'open.spotify.com';
  } catch {
    return false;
  }
}

function isYouTubeUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname in YOUTUBE_PERMISSION_ORIGINS;
  } catch {
    return false;
  }
}

function getYouTubePermissionOrigin(url) {
  try {
    return YOUTUBE_PERMISSION_ORIGINS[new URL(url).hostname] ?? null;
  } catch {
    return null;
  }
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

function settingsMatch(a, b) {
  return Object.keys(DEFAULT_SETTINGS).every((key) => {
    const left = a[key] ?? DEFAULT_SETTINGS[key];
    const right = b[key] ?? DEFAULT_SETTINGS[key];
    return key === 'speed' ? Math.abs(left - right) < SPEED_EPSILON : left === right;
  });
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

async function setTabIcon(tabId, enabled) {
  try {
    await api.action.setIcon({ tabId, path: enabled ? ICONS.on : ICONS.off });
  } catch {}
}

async function ensureContentScript(tabId) {
  try {
    await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
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
  const previous = tabApplyQueues.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => applyToTab(tabId, url, settings, enabled));
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
    await queueTabApply(tab.id, tab.url, preset, !isActive);
    return;
  }

  if (command !== 'toggle-effect') return;

  if (state?.enabled) {
    await queueTabApply(tab.id, tab.url, state.settings, false);
    return;
  }

  const remembered = await recallTabState(tab.id, tab.url);
  await queueTabApply(tab.id, tab.url, remembered?.settings ?? PRESETS.slowed, true);
});

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
  await Promise.all([...spotifyBridgeTabs].map(async (tabId) => {
    try {
      const tab = await api.tabs.get(tabId);
      if (!isSpotifyUrl(tab.url)) {
        spotifyBridgeTabs.delete(tabId);
        return;
      }
      await Promise.allSettled([
        api.tabs.sendMessage(tabId, { type: 'SPOTIFY_PERMISSION_REVOKED' }),
        forgetTabState(tabId),
        setTabIcon(tabId, false)
      ]);
    } catch {
      spotifyBridgeTabs.delete(tabId);
    }
  }));
  await syncSpotifyRegistration();
}

async function cleanupYouTubePermissions(removedOrigins) {
  await Promise.all([...youtubeTabs].map(async ([tabId, origin]) => {
    if (!removedOrigins.has(origin)) return;
    try {
      await Promise.allSettled([
        api.tabs.sendMessage(tabId, { type: 'YOUTUBE_PERMISSION_REVOKED' }),
        forgetTabState(tabId),
        setTabIcon(tabId, false)
      ]);
      youtubeTabs.delete(tabId);
    } catch {
      youtubeTabs.delete(tabId);
    }
  }));
}

api.runtime.onInstalled.addListener(() => {
  syncSpotifyRegistration().catch(() => {});
});

api.runtime.onStartup.addListener(() => {
  syncSpotifyRegistration().catch(() => {});
});

api.tabs.onRemoved.addListener((tabId) => {
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
