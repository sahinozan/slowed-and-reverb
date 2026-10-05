'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describe, test } = require('node:test');

const { loadScript, root } = require('./helpers/load-script');

const settingsSource = fs.readFileSync(path.join(root, 'extension/settings.js'), 'utf8');

function loadSettings() {
  return loadScript('extension/settings.js').SlowedReverbSettings;
}

describe('shared settings', () => {
  test('can be loaded into the same page more than once', () => {
    const context = loadScript('extension/settings.js');
    const first = context.SlowedReverbSettings;
    vm.runInContext(settingsSource, context);
    assert.equal(context.SlowedReverbSettings, first);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.DEFAULTS));
    assert.ok(Object.isFrozen(first.PRESETS.slowed));
  });

  test('defines the built-in presets on top of the defaults', () => {
    const { DEFAULTS, PRESETS, PRESET_NAMES } = loadSettings();
    assert.deepEqual({ ...PRESETS.slowed }, { ...DEFAULTS, speed: 0.8, reverb: 40 });
    assert.deepEqual({ ...PRESETS.nightcore }, { ...DEFAULTS, speed: 1.2 });
    assert.deepEqual(Object.keys(PRESET_NAMES), Object.keys(PRESETS));
  });

  test('clamps numbers to their ranges and fills in missing values', () => {
    const { DEFAULTS, normalize } = loadSettings();
    assert.deepEqual({ ...normalize(null) }, { ...DEFAULTS });
    assert.deepEqual(
      { ...normalize({ speed: 9, reverb: -5, eqLow: Number.NaN, keepPitch: 'yes', extra: 1 }) },
      { ...DEFAULTS, speed: 1.5, reverb: 0 }
    );
    assert.equal(normalize({ keepPitch: true }).keepPitch, true);
  });

  test('compares speeds with a tolerance and everything else exactly', () => {
    const { PRESETS, match } = loadSettings();
    assert.ok(match(PRESETS.slowed, { ...PRESETS.slowed, speed: 0.8000001 }));
    assert.ok(match({ speed: 1 }, {}));
    assert.ok(!match(PRESETS.slowed, PRESETS.nightcore));
    assert.ok(!match(PRESETS.slowed, { ...PRESETS.slowed, reverb: 45 }));
  });

  test('every injection of content.js loads settings.js first', () => {
    const injections = [];
    for (const file of fs.readdirSync(path.join(root, 'extension')).filter((name) => name.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(root, 'extension', file), 'utf8');
      for (const [, list] of source.matchAll(/files:\s*\[([^\]]*)\]/g)) {
        if (list.includes('content.js')) injections.push([file, list.replace(/\s+/g, ' ').trim()]);
      }
    }
    assert.ok(injections.length >= 2, 'expected the popup and the background script to inject content.js');
    for (const [file, list] of injections) {
      assert.equal(list, "'settings.js', 'content.js'", `${file} injects ${list}`);
    }
  });

  test('the Spotify scripts keep exact copies of the defaults and ranges', () => {
    const { DEFAULTS, BOUNDS } = loadSettings();
    // Compared as JSON, so objects from different contexts compare by value.
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const copies = [
      ['spotify-bridge.js', 'NEUTRAL_SETTINGS', DEFAULTS],
      ['spotify-main.js', 'NEUTRAL_SETTINGS', DEFAULTS],
      ['spotify-main.js', 'SETTING_BOUNDS', BOUNDS]
    ];
    for (const [file, name, expected] of copies) {
      const source = fs.readFileSync(path.join(root, 'extension', file), 'utf8');
      const literal = source.match(new RegExp(`const ${name} = Object\\.freeze\\((\\{[\\s\\S]*?\\})\\);`));
      assert.ok(literal, `${file} no longer defines ${name} the expected way`);
      assert.deepEqual(plain(vm.runInNewContext(`(${literal[1]})`)), plain(expected), `${file} ${name}`);
    }
  });

  test('the store-art preview server serves settings.js for the popup', async () => {
    const { startServer } = require('../scripts/popup-preview');
    const server = await startServer();
    try {
      const response = await fetch(`${server.baseUrl}/settings.js`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), settingsSource);
    } finally {
      await server.close();
    }
  });
});
