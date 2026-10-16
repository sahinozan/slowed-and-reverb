// The YouTube side of the extension in the isolated world. It passes the
// extension's settings to the audio engine in the page's world
// (youtube-main.js, injected first) and reports the engine's state back.
(() => {
  // Popup, shortcuts, and navigation recovery may all inject into the same document.
  if (window.__slowedReverbInjected) return;
  window.__slowedReverbInjected = true;

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const CHANNEL = 'SLOWED_REVERB_YOUTUBE';
  const BRIDGE_CHECK_EVENT = `${CHANNEL}_CHECK`;
  // The engine answers within a task or two; no answer means it never loaded.
  const ENGINE_TIMEOUT_MS = 2000;

  // The defaults from settings.js, which is injected before this file; they also
  // mean "effect off".
  const NEUTRAL_SETTINGS = SlowedReverbSettings.DEFAULTS;

  const isSupportedHost =
    location.hostname === 'www.youtube.com' || location.hostname === 'music.youtube.com';

  let currentSettings = { ...NEUTRAL_SETTINGS };
  let effectEnabled = false;
  let stateRevision = 0;
  let nextRequestId = 1;
  const pendingRequests = new Map();

  function extensionRunning() {
    return Boolean(api.runtime?.id);
  }

  function notifyStateChanged(engineState) {
    if (!extensionRunning()) return;
    api.runtime
      .sendMessage({
        type: 'CONTENT_STATE_CHANGED',
        enabled: effectEnabled,
        settings: currentSettings,
        origin: location.origin,
        playerDetected: engineState.playerDetected,
        processingActive: engineState.processingActive
      })
      .catch(() => {});
  }

  // Sends a request to the engine and resolves with its state, or with null
  // if the engine never answers.
  function askEngine(message) {
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve(null);
      }, ENGINE_TIMEOUT_MS);
      pendingRequests.set(requestId, (state) => {
        window.clearTimeout(timer);
        resolve(state);
      });
      window.postMessage({ channel: CHANNEL, ...message, requestId }, '*');
    });
  }

  function adoptEngineState(state) {
    // The engine turns the effect off on media it cannot change.
    if (state && !state.enabled) effectEnabled = false;
  }

  function applyToEngine(restoring = false) {
    return askEngine({
      type: 'APPLY',
      settings: currentSettings,
      enabled: effectEnabled,
      restoring
    }).then((state) => {
      adoptEngineState(state);
      return state;
    });
  }

  function blockReasonOf(state) {
    if (!isSupportedHost) return 'unsupportedSite';
    return state ? state.blockReason : 'unsupported';
  }

  function describeState(state) {
    const reason = blockReasonOf(state);
    const playerDetected = Boolean(state?.playerDetected);
    const processingActive = Boolean(state?.processingActive);
    return {
      blocked: reason !== null,
      blockReason: reason,
      playerDetected,
      processingActive,
      pending: reason === null && effectEnabled && !processingActive
    };
  }

  function handleEngineMessage(event) {
    // Chromium leaves this script running without the extension after it is
    // turned off, and messaging it then throws.
    if (!extensionRunning()) return;
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    if (event.data.type !== 'STATE') return;

    const state = {
      enabled: event.data.enabled === true,
      blockReason: event.data.blockReason ?? null,
      live: event.data.live === true,
      playerDetected: event.data.playerDetected === true,
      processingActive: event.data.processingActive === true
    };
    const resolve = pendingRequests.get(event.data.requestId);
    if (resolve) {
      pendingRequests.delete(event.data.requestId);
      resolve(state);
    }
    if (event.data.notify) {
      adoptEngineState(state);
      notifyStateChanged(state);
    }
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_AUDIO') {
      stateRevision++;
      currentSettings = message.settings;
      effectEnabled = Boolean(message.enabled);
      if (!isSupportedHost) {
        effectEnabled = false;
        sendResponse({ success: false, ...describeState(null) });
        return true;
      }
      applyToEngine().then((state) => {
        const description = describeState(state);
        if (description.blocked) effectEnabled = false;
        sendResponse({ success: !description.blocked, ...description });
      });
    } else if (message.type === 'GET_STATE') {
      const answer = isSupportedHost ? askEngine({ type: 'GET_STATE' }) : Promise.resolve(null);
      answer.then((state) => {
        sendResponse({
          enabled: effectEnabled,
          settings: currentSettings,
          live: Boolean(state?.live),
          ...describeState(state)
        });
      });
    } else if (message.type === 'YOUTUBE_PERMISSION_REVOKED') {
      stateRevision++;
      effectEnabled = false;
      const done = isSupportedHost ? applyToEngine() : Promise.resolve();
      done.then(() => sendResponse({ success: true, enabled: false }));
    }
    return true;
  });

  // The engine checks with this event that the extension is still running,
  // and turns itself off when nothing answers (see youtube-main.js).
  document.addEventListener(BRIDGE_CHECK_EVENT, (event) => {
    if (extensionRunning()) event.preventDefault();
  });

  if (!isSupportedHost) return;

  window.addEventListener('message', handleEngineMessage);
  window.postMessage({ channel: CHANNEL, type: 'BRIDGE_READY' }, '*');

  const restoreRevision = stateRevision;
  api.runtime
    .sendMessage({ type: 'GET_TAB_STATE', url: location.origin })
    .catch(() => null)
    .then((remembered) => {
      // A newer change from the popup wins over the remembered state.
      if (stateRevision !== restoreRevision) return;
      const restored = Boolean(remembered?.enabled);
      if (restored) {
        currentSettings = remembered.settings;
        effectEnabled = true;
      }

      return applyToEngine(true).then((state) => {
        // Reporting "off" here would overwrite the remembered state for the next reload.
        if (restored && state) notifyStateChanged(state);
      });
    });
})();
