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

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
const SPEED_EPSILON = 0.001;
const SPOTIFY_HOST = 'open.spotify.com';
const SPOTIFY_ORIGIN = 'https://open.spotify.com/*';
const IS_FIREFOX = Boolean(api.runtime.getManifest?.().browser_specific_settings?.gecko);
const FIREFOX_YOUTUBE_PERMISSIONS = Object.freeze({
  'www.youtube.com': {
    name: 'YouTube',
    origin: 'https://www.youtube.com/*'
  },
  'music.youtube.com': {
    name: 'YouTube Music',
    origin: 'https://music.youtube.com/*'
  }
});

const PRESETS = Object.freeze({
  slowed: Object.freeze({ name: 'Slowed + Reverb', ...DEFAULT_SETTINGS, speed: 0.8, reverb: 40 }),
  nightcore: Object.freeze({ name: 'Nightcore', ...DEFAULT_SETTINGS, speed: 1.2 })
});

const ICONS = {
  on: { 16: 'assets/icon16.png', 48: 'assets/icon48.png', 128: 'assets/icon128.png' },
  off: { 16: 'assets/icon16-off.png', 48: 'assets/icon48-off.png', 128: 'assets/icon128-off.png' }
};

const BLOCKED_TEXT = {
  drm: "This page's audio looks copy-protected (DRM), so effects can't be applied here.",
  unsupportedSite:
    'This website is not officially supported yet. Try YouTube, YouTube Music, or Spotify.',
  unsupported: "This page's player is not available to the extension.",
  noPlayer: "Waiting for this site's supported audio player...",
  loadingPlayer: 'The audio player is still loading. Effects will start when it is ready.',
  spotifyEffects:
    'Spotify speed is available, but this browser did not expose its audio to the filters.'
};

const THEMES = [
  { id: 'pink', name: 'Terminal', bg: '#000000', fg: '#ffffff', accent: 'hsl(343 66% 63%)' },
  { id: 'midnight', name: 'Midnight', bg: '#241b38', fg: '#ffffff', accent: 'hsl(150 45% 68%)' },
  { id: 'paper', name: 'Paper', bg: '#f5f1eb', fg: '#241b2e', accent: 'hsl(259 48% 38%)' },
  { id: 'frost', name: 'Frost', bg: '#eef2f7', fg: '#16202c', accent: 'hsl(205 75% 36%)' }
];
const DEFAULT_THEME = 'pink';

const THEME_KEY = 'uiTheme';
const CUSTOM_PRESETS_KEY = 'customPresets';

const PRESET_NAME_MAX_LENGTH = 24;

const EQ_DB_MAX = 12;
const EQ_VIEWBOX_WIDTH = 300;
const EQ_Y_ZERO = 42;
const EQ_Y_SWING = 33.6;
const EQ_BANDS = [
  { band: 'low', key: 'eqLow', x: 40 },
  { band: 'mid', key: 'eqMid', x: 150 },
  { band: 'high', key: 'eqHigh', x: 260 }
];

const el = (id) => document.getElementById(id);
const toInt = (value) => Number.parseInt(value, 10);
const percent = (value) => `(${value}%)`;

function settingsMatch(a, b) {
  return SETTING_KEYS.every((key) => {
    const left = a[key] ?? DEFAULT_SETTINGS[key];
    const right = b[key] ?? DEFAULT_SETTINGS[key];
    return key === 'speed' ? Math.abs(left - right) < SPEED_EPSILON : left === right;
  });
}

async function recallTabState(tabId, url) {
  return api.runtime
    .sendMessage({ type: 'GET_TAB_STATE', tabId, url })
    .catch(() => null);
}

async function getActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch {
    return false;
  }
}

function setTabIcon(tabId, enabled) {
  api.action.setIcon({ tabId, path: enabled ? ICONS.on : ICONS.off }).catch(() => {});
}

const themeGrid = el('theme-grid');
const themePickerBtn = el('theme-picker-btn');
const themePanel = el('theme-panel');

function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
  for (const button of themeGrid.children) {
    button.classList.toggle('active', button.dataset.theme === themeId);
  }
}

function closeThemePanel() {
  themePanel.hidden = true;
  themePickerBtn.classList.remove('active');
  themePickerBtn.setAttribute('aria-expanded', 'false');
}

function buildThemePicker() {
  for (const theme of THEMES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-option';
    button.dataset.theme = theme.id;
    button.title = theme.name;
    button.style.setProperty('--card-bg', theme.bg);
    button.style.setProperty('--card-fg', theme.fg);
    button.style.setProperty('--card-accent', theme.accent);

    const preview = document.createElement('span');
    preview.className = 'theme-option-preview';
    const name = document.createElement('span');
    name.className = 'theme-option-name';
    name.textContent = theme.name;
    button.append(preview, name);

    button.addEventListener('click', () => {
      applyTheme(theme.id);
      api.storage.local.set({ [THEME_KEY]: theme.id });
    });

    themeGrid.appendChild(button);
  }

  themePickerBtn.addEventListener('click', () => {
    const willShow = themePanel.hidden;
    themePanel.hidden = !willShow;
    themePickerBtn.classList.toggle('active', willShow);
    themePickerBtn.setAttribute('aria-expanded', String(willShow));
  });

  document.addEventListener('click', (event) => {
    if (themePanel.hidden) return;
    if (themePanel.contains(event.target) || themePickerBtn.contains(event.target)) return;
    closeThemePanel();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !themePanel.hidden) closeThemePanel();
  });

  api.storage.local.get({ [THEME_KEY]: DEFAULT_THEME }).then((stored) => {
    const themeId = stored[THEME_KEY];
    applyTheme(THEMES.some((theme) => theme.id === themeId) ? themeId : DEFAULT_THEME);
  });
}

function publishScrollbarWidth() {
  const probe = document.createElement('div');
  // Reuse the real class because scrollbar styling can change its measured width.
  probe.className = 'scroll-area';
  probe.style.cssText =
    'position:absolute;top:0;left:0;visibility:hidden;' +
    'width:100px;height:100px;max-height:none;padding:0;margin:0;overflow-y:scroll';

  document.body.appendChild(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();

  document.documentElement.style.setProperty('--scrollbar-w', `${width}px`);
}

const els = {
  power: el('power-toggle'),
  powerStatus: el('power-status'),
  blockedBanner: el('blocked-banner'),
  blockedBannerText: el('blocked-banner-text'),
  spotifyPermissionPanel: el('spotify-permission-panel'),
  spotifyPermissionText: el('spotify-permission-text'),
  spotifyPermissionBtn: el('spotify-permission-btn'),
  spotifyPermissionStatus: el('spotify-permission-status'),
  youtubePermissionPanel: el('youtube-permission-panel'),
  youtubePermissionTitle: el('youtube-permission-title'),
  youtubePermissionBtn: el('youtube-permission-btn'),
  youtubePermissionStatus: el('youtube-permission-status'),
  presetBar: el('current-preset-bar'),
  presetLabel: el('current-preset-label'),
  presetNameInput: el('preset-name-input'),
  savePresetBtn: el('save-preset-btn'),
  customPresetsList: el('custom-presets-list'),
  keepPitch: el('keep-pitch-toggle'),
  pitchWarning: el('pitch-warning-banner'),
  advancedBadge: el('advanced-badge'),
  eqCurve: el('eq-curve'),
  eqPath: el('eq-curve-path'),
  footer: el('app-footer'),
  resetBtn: el('reset-btn')
};

const SLIDERS = [
  {
    key: 'speed',
    parse: Number.parseFloat,
    format: (value) => `(${value.toFixed(2)}x)`,
    liveLabel: '(unavailable while live)',
    pinnedWhenLive: true
  },
  { key: 'reverb', parse: toInt, format: percent },
  { key: 'echo', parse: toInt, format: percent },
  {
    key: 'pan',
    parse: toInt,
    format: (value) =>
      value === 0 ? '(Center)' : `(${Math.abs(value)}% ${value < 0 ? 'L' : 'R'})`
  },
  { key: 'width', parse: toInt, format: percent },
  { key: 'saturation', parse: toInt, format: percent }
].map((slider) => ({
  ...slider,
  input: el(`${slider.key}-slider`),
  output: el(`${slider.key}-value`)
}));

const eqHandles = new Map(EQ_BANDS.map(({ band }) => [band, el(`eq-handle-${band}`)]));
const eqValueLabels = new Map(EQ_BANDS.map(({ band }) => [band, el(`eq-${band}-value`)]));

const presetButtons = [...document.querySelectorAll('[data-preset]')];
const tabButtons = [...document.querySelectorAll('.tab-btn')];
const tabPanels = { presets: el('panel-presets'), custom: el('panel-custom') };
const effectTabButtons = [...document.querySelectorAll('.effect-tab-btn')];
const effectTabPanels = { basic: el('effect-panel-basic'), advanced: el('effect-panel-advanced') };

const blockableControls = [
  els.power,
  els.keepPitch,
  els.resetBtn,
  els.presetNameInput,
  els.savePresetBtn,
  themePickerBtn,
  ...SLIDERS.map((slider) => slider.input),
  ...presetButtons,
  ...tabButtons,
  ...effectTabButtons
];

const eqState = { low: 0, mid: 0, high: 0 };

let customPresets = [];
let activePresetId = null;
let blocked = false;
let liveBlocked = false;
let applyRevision = 0;
let presetWriteQueue = Promise.resolve();
let spotifyPermissionTabId = null;
let youtubePermission = null;

function isSpotifyUrl(url) {
  try {
    return new URL(url).hostname === SPOTIFY_HOST;
  } catch {
    return false;
  }
}

function isYouTubeUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname in FIREFOX_YOUTUBE_PERMISSIONS;
  } catch {
    return false;
  }
}

function getFirefoxYouTubePermission(url) {
  if (!IS_FIREFOX) return null;
  try {
    return FIREFOX_YOUTUBE_PERMISSIONS[new URL(url).hostname] ?? null;
  } catch {
    return null;
  }
}

function showProcessingStatus(state) {
  if (state?.effectsUnavailable) {
    els.blockedBannerText.textContent = BLOCKED_TEXT.spotifyEffects;
    els.blockedBanner.hidden = false;
    return;
  }

  if (state?.pending) {
    els.blockedBannerText.textContent = state.playerDetected
      ? BLOCKED_TEXT.loadingPlayer
      : BLOCKED_TEXT.noPlayer;
    els.blockedBanner.hidden = false;
    return;
  }

  els.blockedBanner.hidden = true;
}

function showSpotifyPermissionPanel(mode) {
  els.spotifyPermissionPanel.hidden = false;
  els.spotifyPermissionBtn.dataset.mode = mode;
  els.spotifyPermissionStatus.textContent = '';

  if (mode === 'reload') {
    els.spotifyPermissionText.textContent =
      'Spotify access is enabled. Reload the page so the audio hook can start before its player.';
    els.spotifyPermissionBtn.textContent = 'Reload Spotify';
  } else {
    els.spotifyPermissionText.textContent =
      'Spotify needs optional site access so the audio hook can start before its hidden player. Processing stays on this device.';
    els.spotifyPermissionBtn.textContent = 'Allow on Spotify';
  }
}

function hideSpotifyPermissionPanel() {
  els.spotifyPermissionPanel.hidden = true;
  els.spotifyPermissionStatus.textContent = '';
}

function showYouTubePermissionPanel(permission) {
  youtubePermission = permission;
  els.youtubePermissionPanel.hidden = false;
  els.youtubePermissionTitle.textContent = `Enable ${permission.name} support?`;
  els.youtubePermissionBtn.textContent = `Allow on ${permission.name}`;
  els.youtubePermissionStatus.textContent = '';
}

function hideYouTubePermissionPanel() {
  youtubePermission = null;
  els.youtubePermissionPanel.hidden = true;
  els.youtubePermissionStatus.textContent = '';
}

async function handleYouTubePermissionAction() {
  const permission = youtubePermission;
  if (!permission) return;

  els.youtubePermissionBtn.disabled = true;
  try {
    // Keep this as the first await so Firefox still considers the call part of
    // the button's user action.
    const granted = await api.permissions.request({ origins: [permission.origin] });
    if (!granted) {
      els.youtubePermissionStatus.textContent = 'Permission was not granted.';
      return;
    }

    await syncWithActiveTab();
  } catch {
    els.youtubePermissionStatus.textContent =
      `Permission request failed. You can also enable ${permission.name} in the browser extension settings.`;
  } finally {
    els.youtubePermissionBtn.disabled = false;
  }
}

function watchForTabReload(tabId) {
  let resolveReload;
  let settled = false;
  let timeoutId = null;
  const promise = new Promise((resolve) => {
    resolveReload = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeoutId);
    api.tabs.onUpdated.removeListener(onUpdated);
    resolveReload();
  };
  const onUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
  };

  api.tabs.onUpdated.addListener(onUpdated);
  timeoutId = window.setTimeout(finish, 15_000);
  return { cancel: finish, promise };
}

async function reloadSpotifyTab(tab) {
  els.spotifyPermissionStatus.textContent = 'Reloading Spotify...';
  const reloadWatcher = watchForTabReload(tab.id);
  try {
    await api.tabs.reload(tab.id);
    await reloadWatcher.promise;
  } catch (error) {
    reloadWatcher.cancel();
    throw error;
  }
}

async function handleSpotifyPermissionAction() {
  const reloadOnly = els.spotifyPermissionBtn.dataset.mode === 'reload';
  const permissionReloadWatcher =
    !reloadOnly && spotifyPermissionTabId !== null
      ? watchForTabReload(spotifyPermissionTabId)
      : null;
  els.spotifyPermissionBtn.disabled = true;
  try {
    // Firefox loses user-action status after the first await, so this permission
    // request must happen before looking up the active tab or doing any other work.
    if (!reloadOnly) {
      const granted = await api.permissions.request({ origins: [SPOTIFY_ORIGIN] });
      if (!granted) {
        permissionReloadWatcher?.cancel();
        els.spotifyPermissionStatus.textContent = 'Permission was not granted.';
        return;
      }

      els.spotifyPermissionStatus.textContent = 'Reloading Spotify...';
      if (permissionReloadWatcher) await permissionReloadWatcher.promise;
      await syncWithActiveTab();
      return;
    }

    const tab = await getActiveTab();
    if (tab?.id === undefined || !isSpotifyUrl(tab.url)) {
      els.spotifyPermissionStatus.textContent = 'Return to Spotify and try again.';
      return;
    }

    await reloadSpotifyTab(tab);
    await syncWithActiveTab();
  } catch {
    permissionReloadWatcher?.cancel();
    els.spotifyPermissionStatus.textContent =
      'Permission request failed. You can also enable Spotify in the browser extension settings.';
  } finally {
    els.spotifyPermissionBtn.disabled = false;
  }
}

function getCurrentSettings() {
  const settings = { keepPitch: els.keepPitch.checked };
  for (const slider of SLIDERS) settings[slider.key] = slider.parse(slider.input.value);
  for (const { band, key } of EQ_BANDS) settings[key] = eqState[band];
  return settings;
}

function applySettingsToUI(settings) {
  for (const slider of SLIDERS) {
    const value = settings[slider.key] ?? DEFAULT_SETTINGS[slider.key];
    slider.input.value =
      slider.pinnedWhenLive && liveBlocked ? DEFAULT_SETTINGS[slider.key] : value;
  }

  els.keepPitch.checked = liveBlocked
    ? DEFAULT_SETTINGS.keepPitch
    : (settings.keepPitch ?? DEFAULT_SETTINGS.keepPitch);
  els.pitchWarning.hidden = !els.keepPitch.checked;

  for (const { band, key } of EQ_BANDS) eqState[band] = settings[key] ?? DEFAULT_SETTINGS[key];
  renderEq();

  updateValueDisplays();
}

function updateValueDisplays() {
  for (const slider of SLIDERS) {
    slider.output.textContent =
      slider.pinnedWhenLive && liveBlocked
        ? slider.liveLabel
        : slider.format(slider.parse(slider.input.value));
  }
  updateAdvancedBadge();
}

function updateAdvancedBadge() {
  const settings = getCurrentSettings();
  els.advancedBadge.hidden = !(
    settings.echo > 0 ||
    settings.pan !== 0 ||
    settings.width !== DEFAULT_SETTINGS.width ||
    settings.saturation > 0 ||
    settings.keepPitch
  );
}

async function saveAndApplySettings(enabled) {
  // Enforce blocking here because every preset and control funnels through this path.
  const active = blocked ? false : enabled;
  const settings = getCurrentSettings();
  const revision = ++applyRevision;

  setPowerUI(active);

  const tab = await getActiveTab();
  if (tab?.id === undefined) return null;

  const result = await api.runtime
    .sendMessage({ type: 'APPLY_TO_TAB', tabId: tab.id, url: tab.url, settings, enabled: active })
    .catch(() => ({ success: false, blocked: true, blockReason: 'unsupported' }));

  if (revision !== applyRevision) return result;

  if (!result?.success) {
    setBlocked(true, result?.blockReason ?? 'unsupported');
    setPowerUI(false);
    setTabIcon(tab.id, false);
  } else {
    showProcessingStatus(result);
  }

  return result;
}

function dbToY(db) {
  return EQ_Y_ZERO - (db / EQ_DB_MAX) * EQ_Y_SWING;
}

function yToDb(y) {
  const db = ((EQ_Y_ZERO - y) / EQ_Y_SWING) * EQ_DB_MAX;
  return Math.max(-EQ_DB_MAX, Math.min(EQ_DB_MAX, Math.round(db)));
}

function formatDb(db) {
  return db > 0 ? `+${db}dB` : `${db}dB`;
}

function eqSmoothSegment(x0, y0, x1, y1) {
  const midX = (x0 + x1) / 2;
  return ` C ${midX},${y0} ${midX},${y1} ${x1},${y1}`;
}

function renderEq() {
  const points = EQ_BANDS.map(({ band, x }) => ({ x, y: dbToY(eqState[band]) }));
  const [low, mid, high] = points;

  els.eqPath.setAttribute(
    'd',
    `M 0,${low.y} L ${low.x},${low.y}` +
      eqSmoothSegment(low.x, low.y, mid.x, mid.y) +
      eqSmoothSegment(mid.x, mid.y, high.x, high.y) +
      ` L ${EQ_VIEWBOX_WIDTH},${high.y}`
  );

  EQ_BANDS.forEach(({ band }, index) => {
    const handle = eqHandles.get(band);
    handle.setAttribute('cy', points[index].y);
    handle.setAttribute('aria-valuenow', eqState[band]);
    eqValueLabels.get(band).textContent = formatDb(eqState[band]);
  });
}

function setEqDisabled(disabled) {
  els.eqCurve.classList.toggle('disabled', disabled);
  for (const handle of eqHandles.values()) {
    handle.setAttribute('tabindex', disabled ? '-1' : '0');
  }
}

function eqClientYToDb(clientY) {
  const point = els.eqCurve.createSVGPoint();
  point.x = 0;
  point.y = clientY;
  return yToDb(point.matrixTransform(els.eqCurve.getScreenCTM().inverse()).y);
}

function setEqBand(band, db) {
  eqState[band] = Math.max(-EQ_DB_MAX, Math.min(EQ_DB_MAX, db));
  renderEq();
  saveAndApplySettings(true);
}

function bindEqHandles() {
  let dragBand = null;

  const startDrag = (event) => {
    if (els.eqCurve.classList.contains('disabled')) return;
    dragBand = event.currentTarget.dataset.band;
    event.currentTarget.setPointerCapture(event.pointerId);
    moveDrag(event);
  };

  const moveDrag = (event) => {
    if (!dragBand) return;
    setEqBand(dragBand, eqClientYToDb(event.clientY));
  };

  const endDrag = () => {
    dragBand = null;
  };

  const EQ_KEY_DELTAS = {
    ArrowUp: 1,
    ArrowRight: 1,
    ArrowDown: -1,
    ArrowLeft: -1
  };

  const onKeydown = (event) => {
    if (els.eqCurve.classList.contains('disabled')) return;
    const band = event.currentTarget.dataset.band;

    if (event.key === 'Home') {
      setEqBand(band, -EQ_DB_MAX);
    } else if (event.key === 'End') {
      setEqBand(band, EQ_DB_MAX);
    } else if (event.key in EQ_KEY_DELTAS) {
      setEqBand(band, eqState[band] + EQ_KEY_DELTAS[event.key]);
    } else {
      return;
    }

    event.preventDefault();
  };

  for (const handle of eqHandles.values()) {
    handle.addEventListener('pointerdown', startDrag);
    handle.addEventListener('pointermove', moveDrag);
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('keydown', onKeydown);
  }
}

function setPowerUI(enabled) {
  els.power.checked = enabled;
  els.powerStatus.textContent = enabled ? 'On' : 'Off';
  els.powerStatus.classList.toggle('on', enabled);
  updateCurrentPresetBar();
}

function settlePowerUI() {
  // Two frames guarantee the initial state paints before transitions are re-enabled.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.body.classList.remove('booting'))
  );
}

function setActiveTab(buttons, panels, activeKey) {
  for (const button of buttons) {
    const key = button.dataset.tab ?? button.dataset.effectTab;
    const active = key === activeKey;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const [key, panel] of Object.entries(panels)) {
    panel.hidden = key !== activeKey;
  }
}

function moveTabFocus(event, buttons) {
  const current = buttons.indexOf(event.currentTarget);
  let next = null;

  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = buttons.length - 1;
  if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
  if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
  if (next === null) return;

  event.preventDefault();
  buttons[next].focus();
  buttons[next].click();
}

function setLiveState(live) {
  liveBlocked = live;

  if (live) {
    // Pin values as well as disabling controls so presets cannot save unusable speed.
    for (const slider of SLIDERS) {
      if (slider.pinnedWhenLive) slider.input.value = DEFAULT_SETTINGS[slider.key];
    }
    els.keepPitch.checked = DEFAULT_SETTINGS.keepPitch;
    els.pitchWarning.hidden = true;
  }

  for (const slider of SLIDERS) {
    if (slider.pinnedWhenLive) slider.input.disabled = live || blocked;
  }
  els.keepPitch.disabled = live || blocked;

  updateValueDisplays();
}

function setBlocked(isBlocked, reason) {
  blocked = isBlocked;

  if (isBlocked) {
    els.blockedBannerText.textContent = BLOCKED_TEXT[reason] ?? BLOCKED_TEXT.drm;
  }
  els.blockedBanner.hidden = !isBlocked;

  for (const control of blockableControls) control.disabled = isBlocked;
  setEqDisabled(isBlocked);

  if (isBlocked) {
    setActiveTab(tabButtons, tabPanels, 'presets');
    setActiveTab(effectTabButtons, effectTabPanels, 'basic');
    els.footer.classList.remove('no-divider');
    closeThemePanel();
    applySettingsToUI(DEFAULT_SETTINGS);
  }

  els.pitchWarning.hidden = isBlocked || !els.keepPitch.checked;
  renderCustomPresets();
}

function findMatchingPresetName(settings) {
  const candidates = [...Object.values(PRESETS), ...customPresets];
  return candidates.find((preset) => settingsMatch(preset, settings))?.name ?? null;
}

function updateCurrentPresetBar() {
  if (!els.power.checked) {
    els.presetBar.hidden = true;
    return;
  }

  const editing = customPresets.find((preset) => preset.id === activePresetId);

  if (editing) {
    const nameInput = els.customPresetsList.querySelector('.custom-preset-name-input');
    const name = nameInput?.value.trim() || editing.name;
    const dirty = name !== editing.name || !settingsMatch(editing, getCurrentSettings());

    els.presetLabel.textContent = `Editing: ${name}${dirty ? ' *' : ''}`;
    els.presetBar.title = dirty ? 'Unsaved changes' : '';
  } else {
    els.presetLabel.textContent = `Current Preset: ${findMatchingPresetName(getCurrentSettings()) ?? 'Custom'}`;
    els.presetBar.title = '';
  }

  els.presetBar.hidden = false;
}

function persistCustomPresets() {
  const snapshot = customPresets.map((preset) => ({ ...preset }));
  presetWriteQueue = presetWriteQueue
    .catch(() => {})
    .then(() => api.storage.local.set({ [CUSTOM_PRESETS_KEY]: snapshot }));
  return presetWriteQueue;
}

async function loadCustomPresets() {
  const stored = await api.storage.local.get({ [CUSTOM_PRESETS_KEY]: [] });
  customPresets = stored[CUSTOM_PRESETS_KEY];
  renderCustomPresets();
}

function setActivePreset(id) {
  activePresetId = id;
  renderCustomPresets();
}

function applyPreset(preset, enabled) {
  applySettingsToUI(preset);
  saveAndApplySettings(enabled);
  setActivePreset(null);
}

function editCustomPreset(preset) {
  applySettingsToUI(preset);
  saveAndApplySettings(true);
  setActivePreset(preset.id);

  const nameInput = els.customPresetsList.querySelector('.custom-preset-name-input');
  nameInput?.focus();
  nameInput?.setSelectionRange(nameInput.value.length, nameInput.value.length);
}

function updateActivePreset() {
  const preset = customPresets.find((candidate) => candidate.id === activePresetId);
  if (!preset) return;

  const name = els.customPresetsList.querySelector('.custom-preset-name-input')?.value.trim();
  Object.assign(preset, getCurrentSettings(), name ? { name } : null);

  persistCustomPresets();
  setActivePreset(null);
}

function discardPresetEdits() {
  const preset = customPresets.find((candidate) => candidate.id === activePresetId);
  if (!preset) return;

  applySettingsToUI(preset);
  saveAndApplySettings(true);
  setActivePreset(null);
}

function saveCustomPreset() {
  const name = els.presetNameInput.value.trim();
  if (!name) return;

  customPresets.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    ...getCurrentSettings()
  });

  persistCustomPresets();
  els.presetNameInput.value = '';
  setActivePreset(null);
}

function deleteCustomPreset(id) {
  customPresets = customPresets.filter((preset) => preset.id !== id);
  persistCustomPresets();
  setActivePreset(activePresetId === id ? null : activePresetId);
}

function createIconButton(className, glyph, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = glyph;
  button.title = title;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function buildPresetRow(preset) {
  const row = document.createElement('div');
  row.className = 'custom-preset-item';

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'preset-btn custom-preset-btn';
  apply.textContent = preset.name;
  apply.addEventListener('click', () => applyPreset(preset, true));

  const edit = createIconButton('edit-preset-btn', '✎', 'Edit preset', () =>
    editCustomPreset(preset)
  );
  const remove = createIconButton('delete-preset-btn', '×', 'Delete preset', () =>
    deleteCustomPreset(preset.id)
  );

  for (const control of [apply, edit, remove]) control.disabled = blocked;

  row.append(apply, edit, remove);
  return row;
}

function buildEditingRow(preset) {
  const row = document.createElement('div');
  row.className = 'custom-preset-item editing';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'preset-btn custom-preset-btn custom-preset-name-input';
  nameInput.value = preset.name;
  nameInput.maxLength = PRESET_NAME_MAX_LENGTH;
  nameInput.setAttribute('aria-label', `Rename ${preset.name}`);
  nameInput.addEventListener('input', updateCurrentPresetBar);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      updateActivePreset();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      discardPresetEdits();
    }
  });

  const confirm = createIconButton(
    'edit-preset-btn confirm-preset-btn',
    '✓',
    'Save changes to this preset',
    updateActivePreset
  );
  const revert = createIconButton(
    'delete-preset-btn revert-preset-btn',
    '↺',
    'Discard changes',
    discardPresetEdits
  );

  row.append(nameInput, confirm, revert);
  return row;
}

function updateCustomPresetsScrollGap() {
  els.customPresetsList.classList.toggle(
    'has-scrollbar',
    els.customPresetsList.scrollHeight > els.customPresetsList.clientHeight
  );
}

function renderCustomPresets() {
  els.customPresetsList.replaceChildren();
  updateCurrentPresetBar();

  const editing = customPresets.find((preset) => preset.id === activePresetId);

  if (customPresets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'custom-presets-empty';
    empty.textContent = 'No saved presets yet.';
    els.customPresetsList.appendChild(empty);
  } else if (editing) {
    // Hide other rows while editing; applying one would discard unsaved changes.
    els.customPresetsList.appendChild(buildEditingRow(editing));
  } else {
    els.customPresetsList.append(...customPresets.map(buildPresetRow));
  }

  els.customPresetsList.classList.toggle('is-editing', Boolean(editing));
  updateCustomPresetsScrollGap();
}

function bindControls() {
  for (const slider of SLIDERS) {
    slider.input.addEventListener('input', () => {
      updateValueDisplays();
      saveAndApplySettings(true);
    });
  }

  els.keepPitch.addEventListener('change', () => {
    els.pitchWarning.hidden = !els.keepPitch.checked;
    updateAdvancedBadge();
    saveAndApplySettings(true);
  });

  els.power.addEventListener('change', () => saveAndApplySettings(els.power.checked));
  els.spotifyPermissionBtn.addEventListener('click', handleSpotifyPermissionAction);
  els.youtubePermissionBtn.addEventListener('click', handleYouTubePermissionAction);

  els.resetBtn.addEventListener('click', () => {
    applySettingsToUI(DEFAULT_SETTINGS);
    saveAndApplySettings(false);
    setActivePreset(null);
  });

  for (const button of presetButtons) {
    button.addEventListener('click', () => applyPreset(PRESETS[button.dataset.preset], true));
  }

  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      setActiveTab(tabButtons, tabPanels, button.dataset.tab);
      if (activePresetId) setActivePreset(null);
      if (button.dataset.tab === 'custom') updateCustomPresetsScrollGap();
    });
    button.addEventListener('keydown', (event) => moveTabFocus(event, tabButtons));
  }

  for (const button of effectTabButtons) {
    button.addEventListener('click', () => {
      setActiveTab(effectTabButtons, effectTabPanels, button.dataset.effectTab);
      els.footer.classList.toggle('no-divider', button.dataset.effectTab === 'advanced');
    });
    button.addEventListener('keydown', (event) => moveTabFocus(event, effectTabButtons));
  }

  els.savePresetBtn.addEventListener('click', saveCustomPreset);
  els.presetNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveCustomPreset();
  });
}

async function syncWithActiveTab() {
  const tab = await getActiveTab();
  spotifyPermissionTabId =
    tab?.id !== undefined && isSpotifyUrl(tab.url) ? tab.id : null;
  if (tab?.id === undefined) return;

  const spotify = isSpotifyUrl(tab.url);
  const firefoxYouTubePermission = getFirefoxYouTubePermission(tab.url);
  if (spotify && !(await api.permissions.contains({ origins: [SPOTIFY_ORIGIN] }))) {
    hideYouTubePermissionPanel();
    setBlocked(true, 'drm');
    els.blockedBanner.hidden = true;
    showSpotifyPermissionPanel('enable');
    setPowerUI(false);
    setTabIcon(tab.id, false);
    return;
  }

  if (spotify) {
    hideYouTubePermissionPanel();
    await api.runtime.sendMessage({ type: 'SYNC_SPOTIFY_REGISTRATION' });
  } else if (!isYouTubeUrl(tab.url)) {
    hideSpotifyPermissionPanel();
    hideYouTubePermissionPanel();
    setBlocked(true, 'unsupportedSite');
    setPowerUI(false);
    setTabIcon(tab.id, false);
    return;
  } else if (
    firefoxYouTubePermission &&
    !(await api.permissions.contains({ origins: [firefoxYouTubePermission.origin] }))
  ) {
    hideSpotifyPermissionPanel();
    setBlocked(true, 'unsupported');
    els.blockedBanner.hidden = true;
    showYouTubePermissionPanel(firefoxYouTubePermission);
    setPowerUI(false);
    setTabIcon(tab.id, false);
    return;
  } else if (!(await ensureContentScript(tab.id))) {
    hideSpotifyPermissionPanel();
    hideYouTubePermissionPanel();
    setBlocked(true, 'unsupported');
    setPowerUI(false);
    setTabIcon(tab.id, false);
    return;
  }

  let state;
  try {
    state = await api.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
  } catch {
    setBlocked(true, spotify ? 'drm' : 'unsupported');
    if (spotify) {
      els.blockedBanner.hidden = true;
      showSpotifyPermissionPanel('reload');
    }
    setPowerUI(false);
    setTabIcon(tab.id, false);
    return;
  }

  if (state?.blocked) {
    setBlocked(true, state.blockReason);
    setPowerUI(false);
    setTabIcon(tab.id, false);
    return;
  }

  setBlocked(false);
  hideSpotifyPermissionPanel();
  hideYouTubePermissionPanel();
  showProcessingStatus(state);
  setLiveState(Boolean(state?.live));

  if (state?.enabled) {
    applySettingsToUI(state.settings);
    setPowerUI(true);
    setTabIcon(tab.id, true);
    return;
  }

  const remembered = await recallTabState(tab.id, tab.url);

  if (remembered) {
    applySettingsToUI(remembered.settings);
    if (remembered.enabled) {
      await saveAndApplySettings(true);
    } else {
      setPowerUI(false);
      setTabIcon(tab.id, false);
    }
    return;
  }

  // A tab with no prior state starts with the extension's primary preset enabled.
  applySettingsToUI(PRESETS.slowed);
  await saveAndApplySettings(true);
}

async function init() {
  buildThemePicker();
  publishScrollbarWidth();
  bindEqHandles();
  bindControls();

  await loadCustomPresets();
  applySettingsToUI(await api.storage.local.get(DEFAULT_SETTINGS));

  try {
    await syncWithActiveTab();
  } finally {
    settlePowerUI();
  }
}

init();
