'use strict';

// Runs inside the embedded popup, before popup.js. It gives the popup the
// extension API it expects, backed by memory, and tells the page what the
// popup does: settings for the audio demo, theme for the page, height for the
// frame. Nothing here touches the network.

(function () {
  const host = window.parent !== window ? window.parent : null;
  const post = (message) => host && host.postMessage({ source: 'sr-popup', ...message }, '*');

  const SLOWED = Object.freeze({
    speed: 0.8, reverb: 40, echo: 0, pan: 0, width: 100,
    keepPitch: false, saturation: 0, eqLow: 0, eqMid: 0, eqHigh: 0
  });
  // The theme chosen in one page's popup carries to the next page of the visit.
  let rememberedTheme = 'pink';
  try { rememberedTheme = sessionStorage.getItem('sr-demo-theme') || 'pink'; } catch { /* storage may be unavailable */ }
  const localData = { uiTheme: rememberedTheme, customPresets: [], ...SLOWED };
  const tab = { id: 1, url: 'https://www.youtube.com/watch?v=site-demo' };
  const tabState = { enabled: true, settings: { ...SLOWED }, blocked: false, live: false };

  function storageGet(defaults) {
    if (typeof defaults === 'string') return { [defaults]: localData[defaults] };
    if (Array.isArray(defaults)) {
      return Object.fromEntries(defaults.map((key) => [key, localData[key]]));
    }
    return Object.fromEntries(
      Object.entries(defaults ?? {}).map(([key, fallback]) => [
        key, Object.hasOwn(localData, key) ? localData[key] : fallback
      ])
    );
  }

  window.chrome = {
    action: { setIcon: async () => {} },
    permissions: { contains: async () => true, request: async () => true },
    runtime: {
      id: 'site-demo',
      getManifest: () => ({}),
      sendMessage: async (message) => {
        if (message.type === 'GET_TAB_STATE') return tabState;
        if (message.type === 'APPLY_TO_TAB') {
          tabState.enabled = message.enabled;
          tabState.settings = { ...message.settings };
          post({ type: 'settings', settings: tabState.settings, enabled: tabState.enabled });
        }
        return { success: true };
      }
    },
    scripting: { executeScript: async () => [] },
    storage: {
      local: {
        get: async (defaults) => storageGet(defaults),
        set: async (values) => {
          Object.assign(localData, values);
          if ('uiTheme' in values) post({ type: 'theme', theme: values.uiTheme });
        }
      }
    },
    tabs: {
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      query: async () => [tab],
      reload: async () => {},
      sendMessage: async (_tabId, message) => (
        message.type === 'GET_STATE' ? tabState : { success: true }
      )
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    for (const link of document.querySelectorAll('a[href^="http"]')) link.target = '_blank';
    const report = () => post({
      type: 'height', height: Math.ceil(document.body.getBoundingClientRect().height)
    });
    new ResizeObserver(report).observe(document.body);
    report();
    post({ type: 'theme', theme: localData.uiTheme });
    post({ type: 'settings', settings: tabState.settings, enabled: tabState.enabled });
  });
}());
