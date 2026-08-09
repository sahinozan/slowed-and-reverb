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
const TAB_STATE_KEY = 'tabState';

function settingsMatch(a, b) {
  return Object.keys(DEFAULT_SETTINGS).every((key) => {
    const left = a[key] ?? DEFAULT_SETTINGS[key];
    const right = b[key] ?? DEFAULT_SETTINGS[key];
    return key === 'speed' ? Math.abs(left - right) < SPEED_EPSILON : left === right;
  });
}

function sameSite(a, b) {
  try {
    // Recall follows a tab across routes on one site, never across origins.
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

async function readTabStates() {
  const stored = await api.storage.session.get(TAB_STATE_KEY);
  return stored[TAB_STATE_KEY] ?? {};
}

async function rememberTabState(tabId, url, enabled, settings) {
  const tabState = await readTabStates();
  tabState[tabId] = { url, enabled, settings };
  await api.storage.session.set({ [TAB_STATE_KEY]: tabState });
}

async function recallTabState(tabId, url) {
  const entry = (await readTabStates())[tabId];
  return entry && sameSite(entry.url, url) ? entry : null;
}

async function forgetTabState(tabId) {
  const tabState = await readTabStates();
  if (!tabState[tabId]) return;
  delete tabState[tabId];
  await api.storage.session.set({ [TAB_STATE_KEY]: tabState });
}

async function setTabIcon(tabId, enabled) {
  try {
    await api.action.setIcon({ tabId, path: enabled ? ICONS.on : ICONS.off });
  } catch {}
}

async function ensureContentScript(tabId) {
  try {
    await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {}
}

async function getTabState(tabId) {
  await ensureContentScript(tabId);
  try {
    return await api.tabs.sendMessage(tabId, { type: 'GET_STATE' });
  } catch {
    return null;
  }
}

async function applyToTab(tabId, url, settings, enabled) {
  await api.storage.local.set(settings);
  await rememberTabState(tabId, url, enabled, settings);
  await ensureContentScript(tabId);

  try {
    await api.tabs.sendMessage(tabId, { type: 'UPDATE_AUDIO', settings, enabled });
  } catch {}

  await setTabIcon(tabId, enabled);
}

async function getActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

api.commands.onCommand.addListener(async (command) => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  const state = await getTabState(tab.id);
  if (state?.blocked) return;

  const preset = COMMAND_PRESETS[command];
  if (preset) {
    const isActive = Boolean(state?.enabled && settingsMatch(state.settings, preset));
    await applyToTab(tab.id, tab.url, preset, !isActive);
    return;
  }

  if (command !== 'toggle-effect') return;

  if (state?.enabled) {
    await applyToTab(tab.id, tab.url, state.settings, false);
    return;
  }

  const remembered = await recallTabState(tab.id, tab.url);
  await applyToTab(tab.id, tab.url, remembered?.settings ?? PRESETS.slowed, true);
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  if (message.type === 'CONTENT_STATE_CHANGED') {
    setTabIcon(tabId, Boolean(message.enabled));
    if (message.url) {
      rememberTabState(tabId, message.url, message.enabled, message.settings);
    }
    return;
  }

  if (message.type === 'GET_TAB_STATE') {
    // Content scripts cannot access storage.session or discover their own tab id.
    recallTabState(tabId, message.url).then(sendResponse);
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
