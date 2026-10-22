(() => {
  if (window.__slowedReverbSpotifyBridge) return;
  window.__slowedReverbSpotifyBridge = true;

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const CHANNEL = 'SLOWED_REVERB_SPOTIFY';
  const BRIDGE_CHECK_EVENT = `${CHANNEL}_CHECK`;
  // The engine answers a change within a task or two; this only guards
  // against an engine that never answers.
  const ENGINE_STATUS_TIMEOUT_MS = 1000;
  // The version this code was released as. The engine reports the version
  // it came with, to compare with this one. A store rolls back to earlier
  // code by putting it out again with only the manifest's version raised, so
  // this is not read from the manifest. tests/settings.test.js keeps it equal
  // to the manifest's version in the repository.
  const VERSION = '1.1.1';
  // A copy of SlowedReverbSettings.DEFAULTS (settings.js). This script stays
  // self-contained because its registration outlives extension updates;
  // tests/settings.test.js keeps the copy equal.
  const NEUTRAL_SETTINGS = Object.freeze({
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
  });

  let settings = { ...NEUTRAL_SETTINGS };
  let enabled = false;
  let engineReady = false;
  // The engine stays in an open tab when the extension is updated, and
  // Firefox puts this bridge next to it when the extension is turned off and
  // on again without reloading the page. An engine from another version
  // works the way that version did (1.1.0's skipped on Spotify), and one
  // from before the bridge check can't be turned off with the extension, so
  // it is kept off until the page is reloaded.
  let engineOutdated = false;
  let playerDetected = false;
  let effectsUnavailable = false;
  let processingActive = false;
  let stateRevision = 0;
  let statusWaiters = [];

  // The engine reports its status after every change it applies. Answering
  // the extension only after that report keeps the answer from describing
  // the state before the change, such as "not started yet" for a song that
  // is already playing with the effect.
  function nextEngineStatus() {
    if (!engineReady || engineOutdated) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        window.clearTimeout(timer);
        statusWaiters = statusWaiters.filter((waiter) => waiter !== finish);
        resolve();
      };
      const timer = window.setTimeout(finish, ENGINE_STATUS_TIMEOUT_MS);
      statusWaiters.push(finish);
    });
  }

  function applyToEngine() {
    if (!engineReady) return;
    if (engineOutdated) enabled = false;
    window.postMessage({ channel: CHANNEL, type: 'APPLY', settings, enabled }, '*');
  }

  function state() {
    if (engineOutdated) return { enabled: false, blocked: true, blockReason: 'outdated' };
    return {
      enabled,
      settings,
      blocked: false,
      live: false,
      playerDetected,
      effectsUnavailable,
      processingActive,
      pending: enabled && !processingActive && !effectsUnavailable
    };
  }

  function handleEngineMessage(event) {
    // Chromium leaves this script running without the extension after it is
    // turned off, and messaging it then throws.
    if (!api.runtime?.id) return;
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    if (event.data.type !== 'READY' && event.data.type !== 'STATUS') return;
    // Engines from 1.1.0 and earlier report no version.
    if (event.data.version !== VERSION) engineOutdated = true;

    if (event.data.type === 'READY') {
      engineReady = true;
      applyToEngine();
    } else if (event.data.type === 'STATUS') {
      playerDetected = Boolean(event.data.playerDetected);
      effectsUnavailable = Boolean(event.data.effectsUnavailable);
      processingActive = Boolean(event.data.processingActive);
      for (const finish of [...statusWaiters]) finish();
      api.runtime
        .sendMessage({
          type: 'CONTENT_STATE_CHANGED',
          enabled,
          settings,
          origin: location.origin,
          playerDetected,
          processingActive
        })
        .catch(() => {});
    }
  }
  window.addEventListener('message', handleEngineMessage);

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_STATE') {
      sendResponse(state());
    } else if (message.type === 'UPDATE_AUDIO') {
      stateRevision++;
      settings = { ...NEUTRAL_SETTINGS, ...message.settings };
      enabled = Boolean(message.enabled);
      const status = nextEngineStatus();
      applyToEngine();
      if (engineOutdated) {
        sendResponse({ success: false, blocked: true, blockReason: 'outdated' });
        return true;
      }
      status.then(() => {
        sendResponse({
          success: true,
          enabled,
          playerDetected,
          processingActive,
          pending: enabled && !processingActive && !effectsUnavailable,
          effectsUnavailable
        });
      });
    } else if (message.type === 'SPOTIFY_PERMISSION_REVOKED') {
      stateRevision++;
      enabled = false;
      applyToEngine();
      sendResponse({ success: true, enabled: false });
    }
    return true;
  });

  const restoreRevision = stateRevision;
  api.runtime
    .sendMessage({ type: 'GET_TAB_STATE', url: location.origin })
    .catch(() => null)
    .then((remembered) => {
      if (stateRevision !== restoreRevision) return;
      if (remembered) {
        settings = { ...NEUTRAL_SETTINGS, ...remembered.settings };
        enabled = Boolean(remembered.enabled);
      }
      applyToEngine();
    });

  api.runtime
    .sendMessage({ type: 'SPOTIFY_BRIDGE_READY', origin: location.origin })
    .catch(() => {});

  // The page's engine checks with this event that the extension is still
  // running, and turns itself off when nothing answers (see spotify-main.js).
  document.addEventListener(BRIDGE_CHECK_EVENT, (event) => {
    if (api.runtime?.id) event.preventDefault();
  });

  window.postMessage({ channel: CHANNEL, type: 'BRIDGE_READY' }, '*');
})();
