'use strict';

const browserGlobals = {
  document: 'readonly',
  window: 'readonly',
  location: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  requestAnimationFrame: 'readonly',
  MutationObserver: 'readonly',
  Node: 'readonly',
  URL: 'readonly',
  Float32Array: 'readonly',
  chrome: 'readonly',
  browser: 'readonly'
};

module.exports = [
  {
    ignores: ['dist/**']
  },
  {
    files: ['background.js', 'content.js', 'popup.js'],
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
    files: ['scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly', console: 'readonly' }
    },
    rules: {
      'no-unused-vars': 'error',
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
