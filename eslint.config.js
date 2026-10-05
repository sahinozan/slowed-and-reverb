'use strict';

const browserGlobals = {
  document: 'readonly',
  window: 'readonly',
  location: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  requestAnimationFrame: 'readonly',
  HTMLMediaElement: 'readonly',
  MutationObserver: 'readonly',
  Node: 'readonly',
  URL: 'readonly',
  Float32Array: 'readonly',
  chrome: 'readonly',
  browser: 'readonly',
  importScripts: 'readonly',
  SlowedReverbSettings: 'readonly'
};

module.exports = [
  {
    // The site embeds a verbatim copy of the popup, linted at its source.
    ignores: ['dist/**', 'site/popup/popup.js', 'site/popup/settings.js']
  },
  {
    files: [
      'extension/background.js',
      'extension/content.js',
      'extension/settings.js',
      'extension/popup.js',
      'extension/spotify-bridge.js',
      'extension/spotify-main.js'
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: browserGlobals
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'no-console': 'off',
      eqeqeq: 'error',
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  {
    files: ['scripts/**/*.js', 'e2e/**/*.js', 'eslint.config.js', 'playwright.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        Buffer: 'readonly',
        chrome: 'readonly',
        console: 'readonly',
        document: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        window: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'error',
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  {
    // The marketing site ships no build step, so its script is held to the same
    // rules as the extension's own browser scripts.
    files: ['site/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        document: 'readonly',
        window: 'readonly',
        console: 'readonly',
        location: 'readonly',
        requestAnimationFrame: 'readonly',
        ResizeObserver: 'readonly',
        Audio: 'readonly',
        AudioContext: 'readonly',
        OfflineAudioContext: 'readonly',
        fetch: 'readonly',
        Blob: 'readonly',
        Event: 'readonly',
        URL: 'readonly',
        Float32Array: 'readonly',
        DataView: 'readonly',
        ArrayBuffer: 'readonly',
        URLSearchParams: 'readonly',
        IntersectionObserver: 'readonly',
        sessionStorage: 'readonly',
        history: 'readonly',
        SRDemo: 'readonly',
        SRPopupEmbed: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      eqeqeq: 'error',
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setImmediate: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
        URL: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      eqeqeq: 'error',
      'prefer-const': 'error',
      'no-var': 'error'
    }
  }
];
