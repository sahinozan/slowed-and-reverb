'use strict';

// The effect settings in one place: their defaults (which also mean "effect
// off"), the range each one is clamped to, the two built-in presets, and how two
// settings are compared. The background script, the popup and content.js load
// this file first. The two Spotify scripts keep their own copies (spotify-bridge.js
// of the defaults, spotify-main.js of the defaults and ranges), because Spotify's
// registered content scripts are kept across extension updates; a test keeps
// those copies equal to this file.
//
// content.js can be injected into the same page more than once, so this file
// declares nothing at the top level and defines its global only once.
(() => {
  if (globalThis.SlowedReverbSettings) return;

  const DEFAULTS = Object.freeze({
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

  const BOUNDS = Object.freeze({
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

  const PRESETS = Object.freeze({
    slowed: Object.freeze({ ...DEFAULTS, speed: 0.8, reverb: 40 }),
    nightcore: Object.freeze({ ...DEFAULTS, speed: 1.2 })
  });

  const PRESET_NAMES = Object.freeze({
    slowed: 'Slowed + Reverb',
    nightcore: 'Nightcore'
  });

  // Speeds come from a slider with 0.05 steps, so compare them with a tolerance.
  const SPEED_EPSILON = 0.001;

  // A complete settings object, with every number clamped to its range and
  // anything missing or invalid replaced by its default.
  function normalize(settings) {
    const normalized = { ...DEFAULTS };
    if (!settings || typeof settings !== 'object') return normalized;

    for (const [key, [minimum, maximum]] of Object.entries(BOUNDS)) {
      const value = settings[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        normalized[key] = Math.min(maximum, Math.max(minimum, value));
      }
    }
    normalized.keepPitch = settings.keepPitch === true;
    return normalized;
  }

  function match(a, b) {
    return Object.keys(DEFAULTS).every((key) => {
      const left = a[key] ?? DEFAULTS[key];
      const right = b[key] ?? DEFAULTS[key];
      return key === 'speed' ? Math.abs(left - right) < SPEED_EPSILON : left === right;
    });
  }

  globalThis.SlowedReverbSettings = Object.freeze({
    DEFAULTS,
    BOUNDS,
    PRESETS,
    PRESET_NAMES,
    normalize,
    match
  });
})();
