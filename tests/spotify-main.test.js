'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const { describe, test } = require('node:test');
const { JSDOM } = require('jsdom');

const { FakeAudioContext } = require('./helpers/content-harness');
const { root } = require('./helpers/load-script');

const SETTINGS = {
  speed: 0.75,
  reverb: 50,
  echo: 40,
  pan: -25,
  width: 150,
  keepPitch: true,
  saturation: 30,
  eqLow: 2,
  eqMid: -3,
  eqHigh: 4
};

function setup(options = {}) {
  FakeAudioContext.instances = [];
  FakeAudioContext.mediaSourceError = options.mediaSourceError ?? null;
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://open.spotify.com/',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  const warnings = [];
  const statusMessages = [];
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;
  window.console.warn = (...args) => warnings.push(args);
  window.postMessage = (message) => statusMessages.push(message);
  window.eval(fs.readFileSync(`${root}/spotify-main.js`, 'utf8'));

  const media = window.document.createElement('audio');
  Object.defineProperties(media, {
    duration: { configurable: true, value: 300 },
    mediaKeys: { configurable: true, value: options.mediaKeys ?? {} },
    readyState: { configurable: true, value: 2 }
  });
  media.playbackRate = 1;

  function apply(enabled, settings = SETTINGS) {
    window.dispatchEvent(
      new window.MessageEvent('message', {
        source: window,
        data: { channel: 'SLOWED_REVERB_SPOTIFY', type: 'APPLY', enabled, settings }
      })
    );
  }

  return { apply, dom, media, statusMessages, warnings, window };
}

describe('Spotify main-world audio engine', () => {
  test('captures dynamically created protected media and applies the full graph', () => {
    const harness = setup();
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));

    const context = FakeAudioContext.instances[0];
    assert.equal(context.sources.length, 1);
    assert.equal(context.sources[0].media, harness.media);
    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(harness.media.preservesPitch, true);
    assert.deepEqual(
      context.filters.map(({ gain }) => gain.value),
      [SETTINGS.eqLow, SETTINGS.eqMid, SETTINGS.eqHigh]
    );
    assert.equal(context.gains[2].gain.value, 0.35);
    assert.equal(context.gains[3].gain.value, 0.2);
    assert.equal(context.gains[4].gain.value, 0.18);
    assert.equal(context.panners[0].pan.value, -0.25);
    assert.equal(
      harness.statusMessages.filter(({ type }) => type === 'STATUS').at(-1).processingActive,
      true
    );

    harness.dom.window.close();
  });

  test('keeps the graph attached and returns it to bypass when disabled', () => {
    const harness = setup();
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));
    harness.apply(false);

    const context = FakeAudioContext.instances[0];
    assert.equal(context.sources.length, 1);
    assert.equal(harness.media.playbackRate, 1);
    const destinationGains = context.gains.filter((node) =>
      node.connections.some(({ target }) => target === context.destination)
    );
    assert.deepEqual(destinationGains.map(({ gain }) => gain.value), [1, 0]);

    harness.dom.window.close();
  });

  test('keeps Spotify speed available when its Web Audio source fails', () => {
    const error = new Error('protected output unavailable');
    const harness = setup({ mediaSourceError: error });
    harness.apply(true);
    harness.media.dispatchEvent(new harness.window.Event('playing'));

    assert.equal(harness.media.playbackRate, SETTINGS.speed);
    assert.equal(harness.warnings.length, 1);

    harness.dom.window.close();
  });

  test('does not touch restored Spotify state until encrypted playback has started', () => {
    const harness = setup();
    harness.apply(true);

    assert.equal(FakeAudioContext.instances.length, 0);
    assert.equal(harness.media.playbackRate, 1);

    harness.media.dispatchEvent(new harness.window.Event('playing'));

    assert.equal(FakeAudioContext.instances.length, 1);
    assert.equal(harness.media.playbackRate, SETTINGS.speed);

    harness.dom.window.close();
  });

  test('normalizes untrusted page-world settings before applying them', () => {
    const harness = setup();
    harness.apply(true, {
      speed: Number.POSITIVE_INFINITY,
      reverb: 200,
      echo: -1,
      pan: -250,
      width: 500,
      keepPitch: 'true',
      saturation: Number.NaN,
      eqLow: -30,
      eqMid: 30,
      eqHigh: '12'
    });
    harness.media.dispatchEvent(new harness.window.Event('playing'));

    const context = FakeAudioContext.instances[0];
    assert.equal(harness.media.playbackRate, 1);
    assert.equal(harness.media.preservesPitch, false);
    assert.deepEqual(
      context.filters.map(({ gain }) => gain.value),
      [-12, 12, 0]
    );
    assert.equal(context.gains[2].gain.value, 0.7);
    assert.equal(context.gains[3].gain.value, 0);
    assert.equal(context.gains[4].gain.value, 0);
    assert.equal(context.panners[0].pan.value, -1);

    harness.dom.window.close();
  });

  test('does not enable processing for non-boolean page-world values', () => {
    const harness = setup();
    harness.apply('true');
    harness.media.dispatchEvent(new harness.window.Event('playing'));

    assert.equal(FakeAudioContext.instances.length, 0);
    assert.equal(harness.media.playbackRate, 1);
    assert.equal(
      harness.statusMessages.filter(({ type }) => type === 'STATUS').at(-1).processingActive,
      false
    );

    harness.dom.window.close();
  });
});
