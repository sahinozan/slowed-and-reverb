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
  notResponding: "This page isn't responding. Reloading it usually fixes this.",
  notRespondingSpotify: "This page isn't responding. Reloading it usually fixes this.",
  noPlayer: 'Play a song to start the effects.',
  loadingPlayer: 'The effects start once the song loads.',
  loadingPage: 'This page is still loading.',
  spotifyEffects: 'Only speed works on Spotify here.'
};

// The reasons a reload fixes, with the reload panel's button and progress.
const RELOAD_ACTIONS = {
  unsupported: { button: 'Reload page', progress: 'Reloading the page…' },
  outdated: { button: 'Reload page', progress: 'Reloading the page…' },
  notResponding: { button: 'Reload page', progress: 'Reloading the page…' },
  notRespondingSpotify: { button: 'Reload Spotify', progress: 'Reloading Spotify…' },
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

// The background script makes a tab's changes one after another, the
// popup's and the shortcuts'. This waits until those it had taken when it
// was asked have been made, and gives the tab's last shortcut as of when it
// was asked, or null for none. With no answer there is nothing to name, and
// the popup's changes then name nothing.
async function waitForTab(tabId) {
  const answer = await api.runtime.sendMessage({ type: 'WAIT_FOR_TAB', tabId }).catch(() => null);
  return answer?.shortcut;
}

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
  noticeAnnouncer: el('notice-announcer'),
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

// The parts of the popup that set the effect. They are held while the popup
// asks the tab what it is playing with (holdControlsForTab).
const heldForTab = [
  document.querySelector('.header-power'),
  document.querySelector('.presets-tabs-section'),
  document.querySelector('.controls'),
  els.resetBtn
];
// How long the tab may take to answer before the held parts dim.
const TAB_SLOW_MS = 300;
// How long a look at the tab may take before the popup stops waiting for it
// (syncWithActiveTab). A look waits for the popup's own change that is on
// its way, for the scripts to be put into the page, for what the background
// script is still doing to the tab, for the tab's answer, and on a new tab
// for the answer to its starting preset. On a page that is well each takes
// a small part of a second; the page's engine is given two seconds for its
// answer (ENGINE_TIMEOUT_MS in content.js). A page that is still loading
// can take longer, since the scripts wait for it.
const TAB_GIVE_UP_MS = 5000;
// How often the browser is asked about a tab the popup has stopped waiting
// for (showTabNotAnswering).
const TAB_WATCH_MS = 1000;
// What a held part's controls report is dropped before their own listeners
// hear it. `inert` already keeps new clicks and keys away from them, but not
// what was under way when the hold began: Chromium lets a slider that is
// being dragged go on moving.
const HELD_EVENTS = ['pointerdown', 'click', 'keydown', 'input', 'change', 'blur'];
let controlsHeld = false;
// The settings the popup showed last (applySettingsToUI), or had when the
// hold began, to put a slider that moved while it was held back where it was.
let settingsShown = null;
// The held control that had the keyboard when the hold began. `inert` takes
// the keyboard away from it, and letting go gives it back. A saved preset's
// row is built again when a look shows the tab, so for a button in one,
// `row` is the preset's id and `place` the button's place in the row.
let heldFocus = null;
for (const part of heldForTab) {
  for (const type of HELD_EVENTS) {
    // Added before any other listener, and for the way down, so it comes
    // first on the part itself too.
    part.addEventListener(type, (event) => {
      if (!controlsHeld) return;
      event.stopImmediatePropagation();
      if (event.cancelable) event.preventDefault();
    }, true);
  }
}

const eqState = { low: 0, mid: 0, high: 0 };

let customPresets = [];
let activePresetId = null;
let blocked = false;
let liveBlocked = false;
let applyRevision = 0;
let applyBusy = false;
// The tab's last shortcut when the popup read the settings it shows, as the
// background script names it (waitForTab). Each change the popup sends says
// so, and the background script leaves out a change made on top of settings
// from before the tab's last shortcut (APPLY_TO_TAB in background.js).
let shortcutSeen;
let unsentApply = null;
// Settles when the changes now on their way have all been sent and answered.
let appliesSent = Promise.resolve();
let shownSpeed = DEFAULT_SETTINGS.speed;
let presetWriteQueue = Promise.resolve();
let spotifyPermissionTabId = null;
let tabOnSpotify = false;
let youtubePermission = null;
let tabSynced = false;
let tabSlowTimer = null;
// Which view of the tab the popup has. It is counted on when a look at the
// tab begins (syncWithActiveTab), when a look's time is up, and when a
// reload begins (forgetTabLook). A look shows what it finds, and the answer
// to a change is taken, only while the count is still what it was when the
// look began or the change was made. Zero until the first look.
let tabLook = 0;
// Settles when the newest look is over: it has shown the tab, has run out of
// time, or has been given up for a reload.
let tabLookOver = Promise.resolve();
// Ends the wait for the newest look, when a newer one takes over from it.
let endTabLook = null;
// Ends the watch on the tab that a look whose time was up has left
// (showTabNotAnswering).
let endTabWatch = null;
// How many reloads of the tab the popup is waiting for (watchForTabReload).
// The page is going or coming meanwhile, and the look that follows the
// reload shows the tab; nothing else starts one before that.
let tabReloads = 0;
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
    tabReloads--;
    window.clearTimeout(timeoutId);
    api.tabs.onUpdated.removeListener(onUpdated);
    resolveReload();
  };
  const onUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
  };

  tabReloads++;
  api.tabs.onUpdated.addListener(onUpdated);
  timeoutId = window.setTimeout(finish, 15_000);
  return { cancel: finish, promise };
}

async function reloadTab(tab, statusElement, statusText) {
  // A look still waiting for this page will not be answered by it now.
  forgetTabLook();
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
  settingsShown = settings;
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
// sends it.
function changeSpeed(speed) {
  const next = validSpeed(speed);
  const changed = toHundredths(next) !== toHundredths(shownSpeed);
  speedSlider.value = String(next);
  updateValueDisplays();
  if (changed) saveAndApplySettings(true);
  return changed;
}

function stepSpeed(direction) {
  return changeSpeed((toHundredths(shownSpeed) + direction) / 100);
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

// Saves the settings the popup shows and sends them to the tab.
//
// The newest change that hasn't been sent is kept in one place, `unsentApply`,
// and a newer change takes its place there. One change is on its way at a
// time, and the next is sent when its answer has come. So holding a button or
// a key gives the tab the newest settings, always including the last, without
// a message for every step before them.
function saveAndApplySettings(enabled) {
  // While the controls are held, nothing they do is sent. Their events are
  // dropped already (HELD_EVENTS); this is for what was under way when the
  // hold began and needs no further event, such as a button held down.
  if (controlsHeld) return Promise.resolve(null);
  return sendSettings(enabled);
}

function sendSettings(enabled) {
  // Enforce blocking here because every preset and control funnels through this path.
  const active = blocked ? false : enabled;
  const request = {
    settings: getCurrentSettings(),
    enabled: active,
    revision: ++applyRevision,
    shortcut: shortcutSeen,
    // The look the popup's view of the tab is from (syncWithActiveTab).
    look: tabLook
  };

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

  if (!applyBusy) appliesSent = sendUnsentApplies();
  return result;
}

// Sends what is waiting, one change at a time. A change stays in
// `unsentApply` until the moment it is handed to the browser, so that closing
// the popup can still send it (sendOnClose).
async function sendUnsentApplies() {
  applyBusy = true;
  try {
    while (unsentApply) {
      let apply = null;
      try {
        const tab = await getActiveTab();
        // The newest change by now: one made during the lookup has taken
        // the place of the one the lookup began for.
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
  return apply;
}

function applyMessage(tab, { settings, enabled, shortcut }) {
  return { type: 'APPLY_TO_TAB', tabId: tab.id, url: tab.url, settings, enabled, shortcut };
}

async function sendApply(tab, request) {
  const reportsBefore = tabReports;
  const result = await api.runtime
    .sendMessage(applyMessage(tab, request))
    .catch(() => ({ success: false, blocked: true, blockReason: 'unsupported' }));

  // The answer to a change is about the tab as the popup saw it then. Once
  // the popup has looked at the tab again, or has given up on that look,
  // what it shows and does comes from there.
  if (request.look !== tabLook) return result;

  // A shortcut has changed the tab since the popup read the settings this
  // change was made on top of, so the background script left the change
  // out. The popup looks at the tab again, which waits for the shortcut's
  // change to be made and then shows it. The background script's word of
  // the shortcut is usually on its way too; this doesn't wait for it.
  if (result?.superseded) {
    syncWithActiveTab().catch(() => {});
    return result;
  }

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
  api.runtime.sendMessage(applyMessage(lastActiveTab, apply.request)).catch(() => {});
  apply.resolve(null);
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
  if (reason === 'notResponding' && tabOnSpotify) reason = 'notRespondingSpotify';

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
  row.dataset.presetId = preset.id;

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
  button.addEventListener('click', (event) => {
    // A click made with the keyboard (its detail is 0) has no hold before it.
    const endsHold = held && event.detail !== 0;
    held = false;
    if (!endsHold) stepSpeed(direction);
  });
}

function bindSpeedControls() {
  // The slider's step is 0.01 so that it can show any speed, and a drag, a
  // click on its track or Page Up moves it by that. Its own moves stay on the
  // 0.05x marks: each goes to the nearest one.
  // Moving the slider turns the effect on, as moving any slider does, also
  // when it ends on the speed it had: the website's fader shows 1.00x while
  // the effect is off, and moved to the speed the popup still holds, it
  // gives the slider that same speed again.
  speedSlider.addEventListener('input', () => {
    const changed = changeSpeed(sliderMark(Number.parseFloat(speedSlider.value)));
    if (!changed && !els.power.checked) saveAndApplySettings(true);
  });
  // Its arrow keys would move it by 0.01 and be put straight back, so they
  // go to the next mark here.
  speedSlider.addEventListener('keydown', (event) => {
    if (!Object.hasOwn(SPEED_SLIDER_KEYS, event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    changeSpeed(sliderMark(shownSpeed, SPEED_SLIDER_KEYS[event.key]));
  });

  els.speedInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      commitSpeedField();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      // From what is typed, if that is a speed.
      const from = validSpeed(parseSpeed(els.speedInput.value) ?? shownSpeed);
      const direction = event.key === 'ArrowUp' ? 1 : -1;
      changeSpeed((toHundredths(from) + direction) / 100);
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
  // The tab's loading is followed for as long as the popup is open, so that
  // a look whose time is up knows whether the page is still loading
  // (showTabNotAnswering).
  api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status && tabId === lastActiveTab?.id) {
      lastActiveTab = { ...lastActiveTab, status: changeInfo.status };
    }
  });
  // Returns nothing, so the background script still answers these messages.
  api.runtime.onMessage.addListener((message, sender) => {
    handleTabReport(message, sender);
    handleShortcutReport(message, sender);
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

// While the popup is asking the tab what it is playing with, what it shows
// may not be the tab's: when it opens it shows the settings used last in
// any tab, and after a shortcut the settings from before it. A change made
// then would be made on top of the wrong settings, and the tab's answer,
// which is older than the change, would then be shown over it. So the parts
// that set the effect are held for as long as a look at the tab is under
// way (syncWithActiveTab), and from the start of init: they take no clicks
// or keys (`inert`, and HELD_EVENTS for what was already under way), and
// nothing is sent for them (saveAndApplySettings). They look as they always
// do, since the answer usually comes at once. Only when it takes longer
// than TAB_SLOW_MS do they dim, to show that the popup is waiting. Controls
// that are disabled anyway, as after a reload, don't dim.
function holdControlsForTab() {
  if (controlsHeld) return;
  controlsHeld = true;
  settingsShown = getCurrentSettings();
  const focused = document.activeElement;
  const row = focused?.closest?.('.custom-preset-item');
  heldFocus = heldForTab.some((part) => part.contains(focused))
    ? { control: focused, row: row?.dataset.presetId, place: row ? [...row.children].indexOf(focused) : -1 }
    : null;
  for (const part of heldForTab) part.setAttribute('inert', '');
  tabSlowTimer = window.setTimeout(() => {
    if (!blocked) document.body.classList.add('tab-slow');
  }, TAB_SLOW_MS);
}

function releaseControlsForTab() {
  window.clearTimeout(tabSlowTimer);
  tabSlowTimer = null;
  document.body.classList.remove('tab-slow');
  for (const part of heldForTab) part.removeAttribute('inert');
  const wasHeld = controlsHeld;
  controlsHeld = false;
  if (!wasHeld) return;

  // A slider dragged through the hold has moved, though the popup took none
  // of it. Most ways a look ends show settings again and so put it back;
  // this does it for those that don't, such as a window with no tab. The
  // bar is named from the sliders, so it comes after.
  if (settingsShown) applySettingsToUI(settingsShown);
  updateCurrentPresetBar();

  // Only if the keyboard is where `inert` left it, with no control.
  const had = heldFocus;
  heldFocus = null;
  if (!had || document.activeElement !== document.body) return;
  let { control } = had;
  if (!control.isConnected && had.row !== undefined) {
    const row = [...els.customPresetsList.children].find((item) => item.dataset.presetId === had.row);
    control = row?.children[had.place];
  }
  if (control?.isConnected && !control.disabled) control.focus({ preventScroll: true });
}

// Looks at the active tab and shows what it is playing with. The popup does
// this when it opens, after a reload or a permission, and when a shortcut
// has changed the tab (handleShortcutReport). The controls are held
// meanwhile, and this returns when no look is under way any more.
//
// A newer look takes over from an older one, at once: the older one shows
// nothing more, since what it is told is from before, and whoever waited for
// it waits for the newer one instead.
//
// A look waits on the browser and on the page, and a page that has stopped
// responding never answers. So after TAB_GIVE_UP_MS the look is over: the
// popup says that the page isn't responding and offers to reload it, or,
// for a page that is still loading, says that (showTabNotAnswering). What
// the look is told after that is not shown either, but if it is told
// anything at all the page is answering again, and a new look is made.
async function syncWithActiveTab() {
  holdControlsForTab();
  const own = lookAtTab();
  let over = own.then(() => {}, () => {});
  tabLookOver = over;
  try {
    await own;
  } finally {
    while (over !== tabLookOver) {
      over = tabLookOver;
      await over;
    }
    releaseControlsForTab();
  }
}

// One look. Resolves when it is over, and rejects if it fails before that.
function lookAtTab() {
  const look = ++tabLook;
  // Whether what the look has learned may still be shown.
  const current = () => look === tabLook;
  // What `tabLook` was left at when the look's time was up.
  let timeUpAt = 0;
  endTabLook?.();
  endTabWatch?.();
  announceNotice('');

  return new Promise((resolve, reject) => {
    // Ended with the look, also when a newer one takes over (endTabLook).
    const timer = window.setTimeout(() => {
      // Counted on, as a newer look would: this one shows nothing more,
      // and neither does the answer to a change it has sent.
      timeUpAt = ++tabLook;
      showTabNotAnswering(timeUpAt);
      resolve();
    }, TAB_GIVE_UP_MS);
    endTabLook = () => {
      window.clearTimeout(timer);
      resolve();
    };

    const ended = (error) => {
      window.clearTimeout(timer);
      if (timeUpAt && timeUpAt === tabLook) {
        // Something answered after all, and nothing has looked since.
        syncWithActiveTab().catch(() => {});
      } else if (current() && error) {
        reject(error.reason);
        return;
      }
      resolve();
    };
    showActiveTab(current).then(() => ended(null), (reason) => ended({ reason }));
  });
}

// Gives up the look under way, for a reload: the page it asked is going.
function forgetTabLook() {
  tabLook++;
  endTabLook?.();
  endTabLook = null;
  endTabWatch?.();
}

// What the popup shows when a look's time is up. `view` is what `tabLook`
// was left at.
//
// A page that has stopped responding gets the reload panel. A page that is
// still loading has not stopped responding: the scripts wait for it, and
// reloading it would only start the loading again. So the popup says that
// it is loading, and offers no reload.
//
// From then on the tab is watched, until something looks at it again or a
// reload begins (endTabWatch). When it has loaded, the popup looks again;
// that look has a time limit of its own, for a page that has loaded and
// then doesn't answer. When it begins to load, as after a reload made in
// the browser, the notice becomes the one for a page that is loading. The
// browser says both as they happen, and is asked every TAB_WATCH_MS as
// well, in case its word was missed.
function showTabNotAnswering(view) {
  hideSpotifyPermissionPanel();
  hideYouTubePermissionPanel();
  setPowerUI(false);
  const tab = lastActiveTab;
  let loading = null;
  const show = (isLoading) => {
    if (isLoading === loading) return;
    loading = isLoading;
    const reason = loading ? 'loadingPage' : 'notResponding';
    setBlocked(true, reason);
    announceNotice(BLOCKED_TEXT[reason]);
  };
  show(tab?.status === 'loading');
  if (!tab) return;

  const lookAgain = () => {
    if (view === tabLook) syncWithActiveTab().catch(() => {});
  };
  const onUpdated = (tabId, changeInfo) => {
    if (tabId !== tab.id || view !== tabLook) return;
    if (changeInfo.status === 'complete') lookAgain();
    else if (changeInfo.status === 'loading') show(true);
  };
  let askTimer = null;
  const ask = async () => {
    const now = await getActiveTab().catch(() => null);
    if (view !== tabLook) return;
    if (now?.id === tab.id) {
      if (now.status === 'loading') {
        show(true);
      } else if (loading) {
        lookAgain();
        return;
      }
    }
    askTimer = window.setTimeout(ask, TAB_WATCH_MS);
  };

  api.tabs.onUpdated.addListener(onUpdated);
  endTabWatch = () => {
    api.tabs.onUpdated.removeListener(onUpdated);
    window.clearTimeout(askTimer);
    endTabWatch = null;
  };
  ask();
}

// Tells a screen reader of a notice that comes while the popup is open
// (showTabNotAnswering). The notice's own element appears together with
// its text, which screen readers don't read out; this one is always on the
// page, and it is its text changing that they read. It is emptied when the
// popup looks at the tab again, so that the same notice is read again if
// it comes back.
function announceNotice(text) {
  if (els.noticeAnnouncer.textContent !== text) els.noticeAnnouncer.textContent = text;
}

// What a look does. Two rules keep it right, and anything added here has to
// keep them:
// - After each wait, `current()` says whether what the look has learned may
//   still be shown. If not, the look ends there.
// - From the last of those checks to the end, nothing is waited for before
//   a change is sent (sendSettings): the change is counted as made in the
//   view the popup has at that moment (`tabLook`), which must be this look.
//   So whatever a new tab's start needs is read before that check.
async function showActiveTab(current) {
  // What the popup has changed already reaches the tab first, so that the
  // tab's answer is not from before it.
  while (applyBusy) {
    await appliesSent;
    if (!current()) return;
  }

  const tab = await getActiveTab();
  if (!current()) return;
  tabOnSpotify = isSpotifyUrl(tab?.url);
  spotifyPermissionTabId = tab?.id !== undefined && tabOnSpotify ? tab.id : null;
  if (tab?.id === undefined) return;

  const spotify = isSpotifyUrl(tab.url);
  const firefoxYouTubePermission = getFirefoxYouTubePermission(tab.url);
  if (spotify) {
    const allowed = await api.permissions.contains({ origins: [SPOTIFY_ORIGIN] });
    if (!current()) return;
    if (!allowed) {
      hideYouTubePermissionPanel();
      setBlocked(true, 'drm');
      els.blockedBanner.hidden = true;
      showSpotifyPermissionPanel('enable');
      setPowerUI(false);
      setTabIcon(tab.id, false);
      return;
    }

    hideYouTubePermissionPanel();
    await api.runtime.sendMessage({ type: 'SYNC_SPOTIFY_REGISTRATION' });
    if (!current()) return;
  } else if (!isYouTubeUrl(tab.url)) {
    hideSpotifyPermissionPanel();
    hideYouTubePermissionPanel();
    setBlocked(true, 'unsupportedSite');
    setPowerUI(false);
    setTabIcon(tab.id, false);
    return;
  } else {
    if (firefoxYouTubePermission) {
      const allowed = await api.permissions.contains({ origins: [firefoxYouTubePermission.origin] });
      if (!current()) return;
      if (!allowed) {
        hideSpotifyPermissionPanel();
        setBlocked(true, 'unsupported');
        els.blockedBanner.hidden = true;
        els.reloadPanel.hidden = true;
        showYouTubePermissionPanel(firefoxYouTubePermission);
        setPowerUI(false);
        setTabIcon(tab.id, false);
        return;
      }
    }

    const injected = await ensureContentScript(tab.id);
    if (!current()) return;
    if (!injected) {
      hideSpotifyPermissionPanel();
      hideYouTubePermissionPanel();
      setBlocked(true, 'unsupported');
      setPowerUI(false);
      setTabIcon(tab.id, false);
      return;
    }
  }

  // The tab's answer must not be from before a shortcut whose change is
  // still being made.
  const shortcut = await waitForTab(tab.id);
  if (!current()) return;

  let state;
  let answered = true;
  const reportsBefore = tabReports;
  try {
    state = await api.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
  } catch {
    answered = false;
  }
  if (!current()) return;

  if (!answered) {
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

  // The last wait before the tab is shown. Nothing is shown before it, so
  // that the tab's settings are shown and its controls enabled in one step.
  const remembered = state?.enabled ? null : await recallTabState(tab.id, tab.url);
  if (!current()) return;

  shortcutSeen = shortcut;
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

  if (remembered) {
    applySettingsToUI(remembered.settings);
    if (remembered.enabled) {
      await sendSettings(true);
    } else {
      setPowerUI(false);
      setTabIcon(tab.id, false);
    }
    return;
  }

  // A tab with no prior state starts with the extension's primary preset enabled.
  applySettingsToUI(PRESETS.slowed);
  await sendSettings(true);
}

// A keyboard shortcut is handled by the background script, and works while
// the popup is open. The background script says when one has had its turn
// with a tab (its onCommand listener), and the popup then looks at the tab
// again, so that it shows what the shortcut did and the next change made
// here is made on top of it. The new look takes over from one under way,
// which may have asked before the shortcut's change.
function handleShortcutReport(message, sender) {
  if (message?.type !== 'SHORTCUT_APPLIED') return;
  // From the extension's own background script, not from a page's script.
  if (sender.id !== api.runtime.id || sender.tab) return;
  if (lastActiveTab && message.tabId !== lastActiveTab.id) return;
  // The popup is still reading what is stored, or is waiting for the tab
  // to reload. The look that follows comes after the shortcut's change.
  if (tabLook === 0 || tabReloads > 0) return;

  // A saved preset being edited is compared with the settings shown, which
  // are about to be the shortcut's, so the edit ends, as it does when
  // another preset is chosen.
  if (activePresetId) setActivePreset(null);
  syncWithActiveTab().catch(() => {});
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

  // Held from here, not from the first question to the tab: what is stored
  // is read first, and the controls could be reached meanwhile.
  holdControlsForTab();
  try {
    await loadCustomPresets();
    applySettingsToUI(await api.storage.local.get(DEFAULT_SETTINGS));

    try {
      await syncWithActiveTab();
    } finally {
      // The look has let go of the controls, which put back a slider that
      // moved while it was held. The bar is named from the sliders, so it
      // is worked out only now.
      tabSynced = true;
      updateCurrentPresetBar();
      settlePowerUI();
    }
  } finally {
    // For a failure before the tab was asked. A second call changes nothing.
    releaseControlsForTab();
  }
  await countDayOfUse().catch(() => {});
}

init();
