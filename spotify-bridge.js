(() => {
  if (window.__slowedReverbSpotifyBridge) return;
  window.__slowedReverbSpotifyBridge = true;

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const CHANNEL = 'SLOWED_REVERB_SPOTIFY';
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
  let playerDetected = false;
  let effectsUnavailable = false;
  let stateRevision = 0;

  function applyToEngine() {
    if (!engineReady) return;
    window.postMessage({ channel: CHANNEL, type: 'APPLY', settings, enabled }, '*');
  }

  function state() {
    return {
      enabled,
      settings,
      blocked: false,
      live: false,
      playerDetected,
      effectsUnavailable
    };
  }

  window.addEventListener('message', (event) => {
    if (event.data?.channel !== CHANNEL) return;

    if (event.data.type === 'READY') {
      engineReady = true;
      applyToEngine();
    } else if (event.data.type === 'STATUS') {
      playerDetected = Boolean(event.data.playerDetected);
      effectsUnavailable = Boolean(event.data.effectsUnavailable);
    }
  });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_STATE') {
      sendResponse(state());
    } else if (message.type === 'UPDATE_AUDIO') {
      stateRevision++;
      settings = { ...NEUTRAL_SETTINGS, ...message.settings };
      enabled = Boolean(message.enabled);
      applyToEngine();
      sendResponse({
        success: true,
        enabled,
        pending: !playerDetected,
        effectsUnavailable
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

  api.runtime.sendMessage({ type: 'SPOTIFY_BRIDGE_READY' }).catch(() => {});

  window.postMessage({ channel: CHANNEL, type: 'BRIDGE_READY' }, '*');
})();
