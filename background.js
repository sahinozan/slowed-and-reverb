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
const RESTORABLE_URL = /^https?:\/\//i;
const TAB_STATE_PREFIX = 'tabState:';
const tabApplyQueues = new Map();

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
  await api.storage.session.set({ [tabStateKey(tabId)]: { origin, enabled, settings } });
}

async function recallTabState(tabId, url) {
  const key = tabStateKey(tabId);
  const entry = (await api.storage.session.get(key))[key];
  return entry?.origin === getOrigin(url) ? entry : null;
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
  if (!(await ensureContentScript(tabId))) {
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
  await setTabIcon(tabId, enabled);
  return { success: true, enabled };
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
  const senderTabId = sender.tab?.id;

  if (message.type === 'CONTENT_STATE_CHANGED') {
    if (senderTabId === undefined) return;
    setTabIcon(senderTabId, Boolean(message.enabled));
    const url = sender.tab?.url ?? message.origin;
    if (url) rememberTabState(senderTabId, url, message.enabled, message.settings);
    return;
  }

  if (message.type === 'GET_TAB_STATE') {
    const tabId = senderTabId ?? message.tabId;
    const url = sender.tab?.url ?? message.url;
    if (tabId === undefined || !url) return;
    // Content scripts cannot access storage.session or discover their own tab id.
    recallTabState(tabId, url).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }

  if (message.type === 'APPLY_TO_TAB') {
    if (message.tabId === undefined || !message.url) return;
    queueTabApply(message.tabId, message.url, message.settings, Boolean(message.enabled))
      .then(sendResponse)
      .catch(() =>
        sendResponse({ success: false, blocked: true, blockReason: 'unsupported' })
      );
    return true;
  }
});

api.tabs.onRemoved.addListener(forgetTabState);

api.tabs.onActivated.addListener(async ({ tabId }) => {
  const state = await getTabState(tabId);
  await setTabIcon(tabId, Boolean(state?.enabled));
});

api.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    setTabIcon(tabId, false);
    return;
  }

  if (changeInfo.status !== 'complete' || !RESTORABLE_URL.test(tab.url ?? '')) return;

  // Injection asks this worker for remembered state and restores it inside the page.
  const state = await getTabState(tabId);
  await setTabIcon(tabId, Boolean(state?.enabled));
});
