const api = typeof browser !== 'undefined' ? browser : chrome;

// Defaults, presets and comparison come from settings.js, loaded before this file.
const { DEFAULTS: DEFAULT_SETTINGS, match: settingsMatch } = SlowedReverbSettings;
const SPOTIFY_HOST = 'open.spotify.com';
const SPOTIFY_ORIGIN = 'https://open.spotify.com/*';
const IS_FIREFOX = Boolean(api.runtime.getManifest?.().browser_specific_settings?.gecko);
// Where the star and the rating reminder lead: the review page of the store
// this copy came from. Edge and Brave install from the Chrome Web Store.
const STORE_REVIEW_URL = IS_FIREFOX
  ? 'https://addons.mozilla.org/firefox/addon/slowed-reverb/'
  : 'https://chromewebstore.google.com/detail/slowed-reverb/nhndfhonlljbmkpnblndjfdefjoecpoa/reviews';
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

// The built-in presets, with the names the popup shows.
const PRESETS = Object.freeze(Object.fromEntries(
  Object.entries(SlowedReverbSettings.PRESETS).map(([id, settings]) => [
    id,
    Object.freeze({ name: SlowedReverbSettings.PRESET_NAMES[id], ...settings })
  ])
));

const ICONS = {
  on: { 16: 'assets/icon16.png', 48: 'assets/icon48.png', 128: 'assets/icon128.png' },
  off: { 16: 'assets/icon16-off.png', 48: 'assets/icon48-off.png', 128: 'assets/icon128-off.png' }
};

const BLOCKED_TEXT = {
  drm: "This site protects its audio, so the effects can't change it.",
  unsupportedSite:
    "This site isn't supported. It works on YouTube, YouTube Music and Spotify.",
  unsupported: "The effects can't start on this page. Reloading it usually fixes this.",
  outdated: 'Reload the page to finish updating the extension.',
  outdatedSpotify: 'Reload Spotify to finish updating the extension.',
  noPlayer: 'Play a song to start the effects.',
  loadingPlayer: 'The effects start once the song loads.',
  spotifyEffects: 'Only speed works on Spotify here.'
};

// The reasons a reload fixes, with the reload panel's button and progress.
const RELOAD_ACTIONS = {
  unsupported: { button: 'Reload page', progress: 'Reloading the page…' },
  outdated: { button: 'Reload page', progress: 'Reloading the page…' },
  outdatedSpotify: { button: 'Reload Spotify', progress: 'Reloading Spotify…' }
};

const THEMES = [
  {
    id: 'glow',
    name: 'Glow',
    bg: 'radial-gradient(120% 90% at 15% 0%, rgba(232,89,127,.2), transparent 60%), radial-gradient(110% 90% at 95% 100%, rgba(150,40,140,.2), transparent 65%), #0f0308',
    fg: '#ffffff',
    accent: 'hsl(343 66% 63%)'
  },
  { id: 'pink', name: 'Terminal', bg: '#000000', fg: '#ffffff', accent: 'hsl(343 66% 63%)' },
  { id: 'midnight', name: 'Midnight', bg: '#241b38', fg: '#ffffff', accent: 'hsl(150 45% 68%)' },
  { id: 'paper', name: 'Paper', bg: '#f5f1eb', fg: '#241b2e', accent: 'hsl(259 48% 38%)' },
  { id: 'frost', name: 'Frost', bg: '#eef2f7', fg: '#16202c', accent: 'hsl(205 75% 36%)' }
];
const DEFAULT_THEME = 'glow';

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

const [SPEED_MIN, SPEED_MAX] = SlowedReverbSettings.BOUNDS.speed;
// The field and the − and + buttons change the speed by 0.01x. The slider's
// own moves (a drag, a click on its track, its keys) stay on the 0.05x marks.
// Both are counted in hundredths, so 0.83 + 0.01 is 0.84 and not
// 0.8400000000000001.
const SPEED_SLIDER_MARK = 5;
const SPEED_SLIDER_KEYS = Object.freeze({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 });
// How long a − or + button is held before it starts to repeat, and how fast.
const STEP_HOLD_DELAY_MS = 400;
const STEP_REPEAT_MS = 60;
// In Firefox the player clicks when its speed changes, so the audio engines
// fade the sound out and back in around every change (PLAYER_CHANGE_DELAY_MS
// in youtube-main.js and spotify-main.js). A run of steps sent one by one
// would be heard as a run of gaps. So there the first step is sent at once,
// the steps after it wait, and when they have stopped for this long the speed
// they ended on is sent. Chromium's player doesn't click when its speed
// changes, so there every step is sent as it is made.
const SPEED_SETTLE_MS = IS_FIREFOX ? 300 : 0;

const el = (id) => document.getElementById(id);
const toInt = (value) => Number.parseInt(value, 10);
const percent = (value) => `(${value}%)`;
// A speed as whole hundredths. 0.575 is stored as a little less than that,
// and times 100 it is 57.49999999999999, which would round down; rounding
// the product to 12 digits first makes it the 57.5 that was meant.
const toHundredths = (speed) => Math.round(Number((speed * 100).toPrecision(12)));

async function recallTabState(tabId, url) {
  return api.runtime
    .sendMessage({ type: 'GET_TAB_STATE', tabId, url })
    .catch(() => null);
}

// The tab the popup was opened on. The last one found is kept for the moment
// the popup closes, when there is no time to ask again (sendOnClose).
let lastActiveTab = null;

async function getActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) lastActiveTab = tab;
  return tab;
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
  youtubePermissionBtn: el('youtube-permission-btn'),
  youtubePermissionStatus: el('youtube-permission-status'),
  reloadPanel: el('reload-panel'),
  reloadText: el('reload-text'),
  reloadBtn: el('reload-btn'),
  reloadStatus: el('reload-status'),
  presetBar: el('current-preset-bar'),
  presetLabel: el('current-preset-label'),
  presetNameInput: el('preset-name-input'),
  savePresetBtn: el('save-preset-btn'),
  customPresetsList: el('custom-presets-list'),
  speedStepper: el('speed-stepper'),
  speedInput: el('speed-input'),
  speedDown: el('speed-down-btn'),
  speedUp: el('speed-up-btn'),
  keepPitch: el('keep-pitch-toggle'),
  pitchWarning: el('pitch-warning-banner'),
  advancedBadge: el('advanced-badge'),
  eqCurve: el('eq-curve'),
  eqPath: el('eq-curve-path'),
  footer: el('app-footer'),
  resetBtn: el('reset-btn'),
  rateLink: el('rate-link'),
  ratePrompt: el('rate-prompt'),
  ratePromptLink: el('rate-prompt-link'),
  ratePromptDismiss: el('rate-prompt-dismiss')
};

const SLIDERS = [
  {
    key: 'speed',
    parse: Number.parseFloat,
    // The field next to the label shows the speed, so the label has nothing
    // to add to it except on a live stream.
    format: () => '',
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

// The slider holds the speed. The field and the buttons read it and set it.
const speedSlider = el('speed-slider');
const speedStepControls = [els.speedInput, els.speedDown, els.speedUp];

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
  ...speedStepControls,
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
let applyBusy = false;
let unsentApply = null;
let unsentApplyHeld = false;
let shownSpeed = DEFAULT_SETTINGS.speed;
let speedSettleTimer = null;
let presetWriteQueue = Promise.resolve();
let spotifyPermissionTabId = null;
let tabOnSpotify = false;
let youtubePermission = null;
let tabSynced = false;
let processingPending = false;
let tabReports = 0;
let reloadReason = 'unsupported';

// The supported sites are HTTPS only. Hosts are looked up as the table's own
// keys, so a host named like a built-in property, such as "constructor",
// isn't one.
function isSpotifyUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname === SPOTIFY_HOST;
  } catch {
    return false;
  }
}

function youTubePermissionFor(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && Object.hasOwn(FIREFOX_YOUTUBE_PERMISSIONS, hostname)
      ? FIREFOX_YOUTUBE_PERMISSIONS[hostname]
      : null;
  } catch {
    return null;
  }
}

function isYouTubeUrl(url) {
  return youTubePermissionFor(url) !== null;
}

function getFirefoxYouTubePermission(url) {
  return IS_FIREFOX ? youTubePermissionFor(url) : null;
}

function showProcessingStatus(state) {
  processingPending = false;

  if (state?.effectsUnavailable) {
    els.blockedBannerText.textContent = BLOCKED_TEXT.spotifyEffects;
    els.blockedBanner.hidden = false;
    return;
  }

  if (state?.pending) {
    processingPending = true;
    els.blockedBannerText.textContent = state.playerDetected
      ? BLOCKED_TEXT.loadingPlayer
      : BLOCKED_TEXT.noPlayer;
    els.blockedBanner.hidden = false;
    return;
  }

  els.blockedBanner.hidden = true;
}

async function recheckProcessingStatus(tabId) {
  const state = await api.tabs.sendMessage(tabId, { type: 'GET_STATE' }).catch(() => null);
  if (!state || state.blocked || !processingPending || blocked) return;
  showProcessingStatus(state);
}

// The tab reports when its effect starts, which is often after the popup
// opened (a page still loading, a song not yet playing). While the popup says
// it's waiting, ask the tab again on each report.
async function handleTabReport(message, sender) {
  if (message?.type !== 'CONTENT_STATE_CHANGED') return;
  if (sender.id !== api.runtime.id || sender.tab?.id === undefined) return;
  tabReports++;
  if (!processingPending || blocked) return;

  const tab = await getActiveTab();
  if (tab?.id === sender.tab.id) await recheckProcessingStatus(tab.id);
}

// A report can arrive while the tab's answer is still on its way to the
// popup, before the popup knows to wait for one. If any did, ask again
// rather than trust that answer's "waiting".
function showTabStatus(tabId, state, reportsBefore) {
  showProcessingStatus(state);
  if (processingPending && tabReports !== reportsBefore) recheckProcessingStatus(tabId);
}

function showSpotifyPermissionPanel(mode) {
  els.spotifyPermissionPanel.hidden = false;
  els.spotifyPermissionBtn.dataset.mode = mode;
  els.spotifyPermissionStatus.textContent = '';

  if (mode === 'reload') {
    els.spotifyPermissionText.textContent =
      "Allowed. Reload Spotify once and it's ready.";
    els.spotifyPermissionBtn.textContent = 'Reload Spotify';
  } else {
    els.spotifyPermissionText.textContent =
      'Your browser asks once before the extension can work on Spotify.';
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
      els.youtubePermissionStatus.textContent = 'You can allow it any time.';
      return;
    }

    await syncWithActiveTab();
  } catch {
    els.youtubePermissionStatus.textContent =
      `That didn't work. You can also allow ${permission.name} in your browser's extension settings.`;
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

async function reloadTab(tab, statusElement, statusText) {
  statusElement.textContent = statusText;
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
        els.spotifyPermissionStatus.textContent = 'You can allow it any time.';
        return;
      }

      els.spotifyPermissionStatus.textContent = 'Reloading Spotify…';
      if (permissionReloadWatcher) await permissionReloadWatcher.promise;
      await syncWithActiveTab();
      return;
    }

    const tab = await getActiveTab();
    if (tab?.id === undefined || !isSpotifyUrl(tab.url)) {
      els.spotifyPermissionStatus.textContent = 'Return to Spotify and try again.';
      return;
    }

    await reloadTab(tab, els.spotifyPermissionStatus, 'Reloading Spotify…');
    await syncWithActiveTab();
  } catch {
    permissionReloadWatcher?.cancel();
    els.spotifyPermissionStatus.textContent =
      "That didn't work. You can also allow Spotify in your browser's extension settings.";
  } finally {
    els.spotifyPermissionBtn.disabled = false;
  }
}

async function handleReloadAction() {
  els.reloadBtn.disabled = true;
  try {
    const tab = await getActiveTab();
    if (tab?.id === undefined) return;

    await reloadTab(tab, els.reloadStatus, RELOAD_ACTIONS[reloadReason].progress);
    await syncWithActiveTab();
  } catch {
    els.reloadStatus.textContent = "That didn't work. Reload the page yourself and try again.";
  } finally {
    els.reloadBtn.disabled = false;
  }
}

function getCurrentSettings() {
  const settings = { keepPitch: els.keepPitch.checked };
  for (const slider of SLIDERS) settings[slider.key] = slider.parse(slider.input.value);
  for (const { band, key } of EQ_BANDS) settings[key] = eqState[band];
  return settings;
}

function applySettingsToUI(settings) {
  // A speed step kept back for the end of its run was made on what the
  // controls showed before. Sent later, it would put that back, on top of
  // what they show from here on.
  dropHeldApply();

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
  showSpeed();
  updateAdvancedBadge();
}

// The field follows the slider, and both are read out as the speed with its x.
function showSpeed() {
  shownSpeed = Number.parseFloat(speedSlider.value);
  const text = shownSpeed.toFixed(2);
  els.speedInput.value = text;
  els.speedInput.setAttribute('aria-valuenow', String(shownSpeed));
  els.speedInput.setAttribute('aria-valuetext', `${text}x`);
  speedSlider.setAttribute('aria-valuetext', `${text}x`);
}

// What typed text means as a speed: a plain number, with a point or a comma,
// with or without an x after it. Anything else isn't a speed.
function parseSpeed(text) {
  const typed = /^([+-]?(?:\d+[.,]?\d*|[.,]\d+))\s*[x×]?$/i.exec(text.trim());
  return typed ? Number(typed[1].replace(',', '.')) : null;
}

// The nearest speed the popup can show: two decimals, inside the range.
function validSpeed(speed) {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, toHundredths(speed) / 100));
}

// The slider's 0.05x mark nearest to a speed, or the next one up or down.
function sliderMark(speed, direction = 0) {
  const marks = toHundredths(speed) / SPEED_SLIDER_MARK;
  const mark = direction > 0 ? Math.floor(marks) + 1
    : direction < 0 ? Math.ceil(marks) - 1
    : Math.round(marks);
  return (mark * SPEED_SLIDER_MARK) / 100;
}

// Moves the slider and the field to a speed and, if that changed the speed,
// sends it. `heldDown` says the change came from a key being held down.
function changeSpeed(speed, heldDown = false) {
  const next = validSpeed(speed);
  const changed = toHundredths(next) !== toHundredths(shownSpeed);
  speedSlider.value = String(next);
  updateValueDisplays();
  if (changed) applySpeedChange(heldDown);
  return changed;
}

function stepSpeed(direction, heldDown = false) {
  return changeSpeed((toHundredths(shownSpeed) + direction) / 100, heldDown);
}

// Takes what was typed in the field. Text that isn't a speed is dropped, and
// the field goes back to the speed in use.
function commitSpeedField() {
  if (els.speedInput.disabled) return;
  const typed = parseSpeed(els.speedInput.value);
  if (typed === null) showSpeed();
  else changeSpeed(typed);
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

// Sends a change of speed: at once, or in Firefox after a run of them has
// stopped (see SPEED_SETTLE_MS). `heldDown` says the change came from a key
// being held down.
function applySpeedChange(heldDown) {
  if (SPEED_SETTLE_MS === 0) {
    saveAndApplySettings(true);
    return;
  }

  // A key's repeats begin a while after its first press, often later than
  // the wait, and still belong to the run that press began.
  const inRun = speedSettleTimer !== null || heldDown;
  saveAndApplySettings(true, inRun);
  speedSettleTimer = window.setTimeout(settleSpeed, SPEED_SETTLE_MS);
}

function settleSpeed() {
  speedSettleTimer = null;
  if (!unsentApplyHeld) return;
  unsentApplyHeld = false;
  if (!applyBusy) sendUnsentApplies();
}

// Saves the settings the popup shows and sends them to the tab.
//
// The newest change that hasn't been sent is kept in one place, `unsentApply`,
// and a newer change takes its place there. One change is on its way at a
// time, and the next is sent when its answer has come. So holding a button or
// a key gives the tab the newest settings, always including the last, without
// a message for every step before them. `hold` keeps this change back until
// a run of speed changes has stopped; any change after it sends it at once.
function saveAndApplySettings(enabled, hold = false) {
  // Enforce blocking here because every preset and control funnels through this path.
  const active = blocked ? false : enabled;
  const request = { settings: getCurrentSettings(), enabled: active, revision: ++applyRevision };

  setPowerUI(active);

  if (!unsentApply) {
    unsentApply = {};
    unsentApply.result = new Promise((resolve, reject) => {
      unsentApply.resolve = resolve;
      unsentApply.reject = reject;
    });
  }
  unsentApply.request = request;
  const { result } = unsentApply;

  window.clearTimeout(speedSettleTimer);
  speedSettleTimer = null;
  unsentApplyHeld = hold;
  if (!hold && !applyBusy) sendUnsentApplies();
  return result;
}

// Sends what is waiting, one change at a time. A change stays in
// `unsentApply` until the moment it is handed to the browser, so that closing
// the popup can still send it (sendOnClose).
async function sendUnsentApplies() {
  applyBusy = true;
  try {
    while (unsentApply && !unsentApplyHeld) {
      let apply = null;
      try {
        const tab = await getActiveTab();
        // A change made during the lookup has taken this one's place. If it
        // is being kept back, it waits for its run to stop.
        if (unsentApplyHeld) continue;
        apply = takeUnsentApply();
        if (!apply) continue;
        if (tab?.id === undefined) {
          apply.resolve(null);
          continue;
        }
        apply.resolve(await sendApply(tab, apply.request));
      } catch (error) {
        (apply ?? takeUnsentApply())?.reject(error);
      }
    }
  } finally {
    applyBusy = false;
  }
}

function takeUnsentApply() {
  const apply = unsentApply;
  unsentApply = null;
  unsentApplyHeld = false;
  return apply;
}

function applyMessage(tab, { settings, enabled }) {
  return { type: 'APPLY_TO_TAB', tabId: tab.id, url: tab.url, settings, enabled };
}

async function sendApply(tab, request) {
  const reportsBefore = tabReports;
  const result = await api.runtime
    .sendMessage(applyMessage(tab, request))
    .catch(() => ({ success: false, blocked: true, blockReason: 'unsupported' }));

  if (request.revision !== applyRevision) return result;

  if (!result?.success) {
    setBlocked(true, result?.blockReason ?? 'unsupported');
    setPowerUI(false);
    setTabIcon(tab.id, false);
  } else {
    showTabStatus(tab.id, result, reportsBefore);
  }

  return result;
}

// Closing the popup ends its timers and its waits, so a change that hasn't
// been sent yet goes now, without them, to the tab the popup last found.
function sendOnClose() {
  if (!unsentApply || !lastActiveTab) return;
  const apply = takeUnsentApply();
  window.clearTimeout(speedSettleTimer);
  speedSettleTimer = null;
  api.runtime.sendMessage(applyMessage(lastActiveTab, apply.request)).catch(() => {});
  apply.resolve(null);
}

// Gives up a change that was being kept back (see applySettingsToUI).
function dropHeldApply() {
  window.clearTimeout(speedSettleTimer);
  speedSettleTimer = null;
  if (unsentApplyHeld) takeUnsentApply().resolve(null);
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
  // The label says why, so the field and the buttons make way for it.
  els.speedStepper.hidden = live;
  for (const control of speedStepControls) control.disabled = live || blocked;
  els.keepPitch.disabled = live || blocked;

  updateValueDisplays();
}

function setBlocked(isBlocked, reason) {
  blocked = isBlocked;
  // An update is finished the same way on every site, but on Spotify the
  // reload panel names it.
  if (reason === 'outdated' && tabOnSpotify) reason = 'outdatedSpotify';

  if (isBlocked) {
    els.blockedBannerText.textContent = BLOCKED_TEXT[reason] ?? BLOCKED_TEXT.drm;
  }
  // A reloaded page has a fresh player, which usually clears this, and after
  // an update it has the new version's audio engine, so offer the reload in
  // place of the warning.
  const offerReload = isBlocked && Object.hasOwn(RELOAD_ACTIONS, reason);
  els.blockedBanner.hidden = !isBlocked || offerReload;
  els.reloadPanel.hidden = !offerReload;
  els.reloadStatus.textContent = '';
  if (offerReload) {
    reloadReason = reason;
    els.reloadText.textContent = BLOCKED_TEXT[reason];
    els.reloadBtn.textContent = RELOAD_ACTIONS[reason].button;
  }

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

// What the bar calls the current settings: a preset's name, Default for the
// settings Reset Defaults gives, or Custom.
function currentPresetName(settings) {
  return findMatchingPresetName(settings)
    ?? (settingsMatch(DEFAULT_SETTINGS, settings) ? 'Default' : 'Custom');
}

function findMatchingPresetName(settings) {
  const candidates = [...Object.values(PRESETS), ...customPresets];
  return candidates.find((preset) => settingsMatch(preset, settings))?.name ?? null;
}

// The tab's state arrives after a few round trips to the page, often after the
// popup's first paint. Opening with the bar and the power switch as they were
// last shown keeps the bar from popping in and the switch from flipping on
// after the popup appears; the first sync corrects both. The bar is shown
// exactly when the effect is on, so its label also stands for the switch.
const PRESET_BAR_KEY = 'presetBarLabel';

function restorePresetBar() {
  let label = null;
  try {
    label = window.localStorage.getItem(PRESET_BAR_KEY);
  } catch {}
  if (!label) return;
  els.presetLabel.textContent = label;
  els.presetBar.hidden = false;
  setPowerUI(true);
}

function rememberPresetBar() {
  try {
    if (els.presetBar.hidden) {
      window.localStorage.removeItem(PRESET_BAR_KEY);
    } else {
      window.localStorage.setItem(PRESET_BAR_KEY, els.presetLabel.textContent);
    }
  } catch {}
}

function updateCurrentPresetBar() {
  if (!tabSynced) return;

  if (!els.power.checked) {
    els.presetBar.hidden = true;
    rememberPresetBar();
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
    els.presetLabel.textContent = `Current Preset: ${currentPresetName(getCurrentSettings())}`;
    els.presetBar.title = '';
  }

  els.presetBar.hidden = false;
  rememberPresetBar();
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

// A − or + button steps once for a click, and keeps stepping while it is
// held down.
function bindSpeedStepButton(button, direction) {
  let timer = null;
  // Set once a hold has stepped, so the click that ends it doesn't step again.
  let held = false;

  const stop = () => {
    window.clearTimeout(timer);
    timer = null;
  };
  const repeat = () => {
    timer = null;
    if (button.disabled) return;
    held = true;
    // At the end of the range there is nothing left to repeat.
    if (stepSpeed(direction)) timer = window.setTimeout(repeat, STEP_REPEAT_MS);
  };

  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || button.disabled) return;
    stop();
    held = false;
    timer = window.setTimeout(repeat, STEP_HOLD_DELAY_MS);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) {
    button.addEventListener(type, stop);
  }
  // Enter held down on the button clicks it again and again.
  let keyHeldDown = false;
  button.addEventListener('keydown', (event) => {
    keyHeldDown = event.repeat;
  });
  button.addEventListener('keyup', () => {
    keyHeldDown = false;
  });
  button.addEventListener('click', (event) => {
    // A click made with the keyboard (its detail is 0) has no hold before it.
    const fromKeyboard = event.detail === 0;
    const endsHold = held && !fromKeyboard;
    held = false;
    if (!endsHold) stepSpeed(direction, fromKeyboard && keyHeldDown);
  });
}

function bindSpeedControls() {
  // The slider's step is 0.01 so that it can show any speed, and a drag, a
  // click on its track or Page Up moves it by that. Its own moves stay on the
  // 0.05x marks: each goes to the nearest one.
  speedSlider.addEventListener('input', () => {
    changeSpeed(sliderMark(Number.parseFloat(speedSlider.value)));
  });
  // Its arrow keys would move it by 0.01 and be put straight back, so they
  // go to the next mark here.
  speedSlider.addEventListener('keydown', (event) => {
    if (!Object.hasOwn(SPEED_SLIDER_KEYS, event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    changeSpeed(sliderMark(shownSpeed, SPEED_SLIDER_KEYS[event.key]), event.repeat);
  });

  els.speedInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      commitSpeedField();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      // From what is typed, if that is a speed.
      const from = validSpeed(parseSpeed(els.speedInput.value) ?? shownSpeed);
      const direction = event.key === 'ArrowUp' ? 1 : -1;
      changeSpeed((toHundredths(from) + direction) / 100, event.repeat);
    }
  });
  els.speedInput.addEventListener('blur', commitSpeedField);

  bindSpeedStepButton(els.speedDown, -1);
  bindSpeedStepButton(els.speedUp, 1);

  window.addEventListener('pagehide', sendOnClose);
}

function bindControls() {
  for (const slider of SLIDERS) {
    if (slider.input === speedSlider) continue;
    slider.input.addEventListener('input', () => {
      updateValueDisplays();
      saveAndApplySettings(true);
    });
  }
  bindSpeedControls();

  els.keepPitch.addEventListener('change', () => {
    els.pitchWarning.hidden = !els.keepPitch.checked;
    updateAdvancedBadge();
    saveAndApplySettings(true);
  });

  els.power.addEventListener('change', () => saveAndApplySettings(els.power.checked));
  els.spotifyPermissionBtn.addEventListener('click', handleSpotifyPermissionAction);
  els.youtubePermissionBtn.addEventListener('click', handleYouTubePermissionAction);
  els.reloadBtn.addEventListener('click', handleReloadAction);
  // A notice shortens the list (see popup.css), so check its scrollbar again.
  new ResizeObserver(updateCustomPresetsScrollGap).observe(els.customPresetsList);
  // Returns nothing, so the background script still answers these messages.
  api.runtime.onMessage.addListener((message, sender) => {
    handleTabReport(message, sender);
  });

  // Reset only the settings, so a song that is playing with the effect on
  // keeps it on and the next slider change is heard straight away.
  els.resetBtn.addEventListener('click', () => {
    applySettingsToUI(DEFAULT_SETTINGS);
    saveAndApplySettings(els.power.checked);
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
  tabOnSpotify = isSpotifyUrl(tab?.url);
  spotifyPermissionTabId = tab?.id !== undefined && tabOnSpotify ? tab.id : null;
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
    els.reloadPanel.hidden = true;
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
  const reportsBefore = tabReports;
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
  showTabStatus(tab.id, state, reportsBefore);
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

// The rating reminder shows once, after the panel has been opened with the
// effect on during RATING_DAYS different days. The count stays in local
// storage and is never sent anywhere, and private windows never add to it,
// since nothing from private browsing may be stored. Rating, the Rate link, or
// "No thanks" ends it.
const RATING_KEY = 'ratingPrompt';
const RATING_DAYS = 5;
let rating = null;
// Set by an answer, which can come while the day count is still loading.
let ratingAnswered = false;

function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function countDayOfUse() {
  if (!els.power.checked || blocked) return;
  if ((await getActiveTab())?.incognito) return;
  const { [RATING_KEY]: stored } = await api.storage.local.get(RATING_KEY);
  if (ratingAnswered) return;
  rating = { days: 0, lastDay: null, done: false, ...stored };
  if (rating.done) return;

  const today = localDay();
  if (rating.lastDay !== today) {
    rating.days += 1;
    rating.lastDay = today;
    await api.storage.local.set({ [RATING_KEY]: rating });
  }
  if (ratingAnswered) return;
  els.ratePrompt.hidden = rating.days < RATING_DAYS;
}

// One write, started on the click itself: opening the store closes the popup.
function finishRatingPrompt() {
  ratingAnswered = true;
  els.ratePrompt.hidden = true;
  rating = { days: 0, lastDay: null, ...rating, done: true };
  api.storage.local.set({ [RATING_KEY]: rating }).catch(() => {});
}

function bindRating() {
  for (const link of [els.rateLink, els.ratePromptLink]) {
    link.href = STORE_REVIEW_URL;
    link.addEventListener('click', finishRatingPrompt);
  }
  els.ratePromptDismiss.addEventListener('click', finishRatingPrompt);
}

async function init() {
  restorePresetBar();
  buildThemePicker();
  publishScrollbarWidth();
  bindEqHandles();
  bindControls();
  bindRating();

  await loadCustomPresets();
  applySettingsToUI(await api.storage.local.get(DEFAULT_SETTINGS));

  try {
    await syncWithActiveTab();
  } finally {
    tabSynced = true;
    updateCurrentPresetBar();
    settlePowerUI();
  }
  await countDayOfUse().catch(() => {});
}

init();
