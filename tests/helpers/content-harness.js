'use strict';

const fs = require('fs');
const { JSDOM } = require('jsdom');

const { createEvent, flushPromises } = (() => {
  const browserApi = require('./browser-api');
  return {
    createEvent() {
      const listeners = [];
      return {
        listeners,
        addListener(listener) {
          listeners.push(listener);
        }
      };
    },
    flushPromises: browserApi.flushPromises
  };
})();
const { root } = require('./load-script');

class FakeAudioNode {
  constructor(type) {
    this.type = type;
    this.connections = [];
    this.gain = { value: 0 };
    this.frequency = { value: 0 };
    this.Q = { value: 0 };
    this.delayTime = { value: 0 };
    this.pan = { value: 0 };
    this.threshold = { value: 0 };
    this.knee = { value: 0 };
    this.ratio = { value: 0 };
    this.attack = { value: 0 };
    this.release = { value: 0 };
  }

  connect(target, ...ports) {
    this.connections.push({ target, ports });
    return target;
  }

  disconnect(target) {
    this.connections = target
      ? this.connections.filter((connection) => connection.target !== target)
      : [];
  }
}

class FakeAudioContext {
  static instances = [];
  static mediaSourceError = null;

  constructor() {
    this.sampleRate = 20;
    this.state = 'running';
    this.destination = new FakeAudioNode('destination');
    this.filters = [];
    this.gains = [];
    this.sources = [];
    this.compressors = [];
    this.panners = [];
    this.waveShapers = [];
    this.buffers = [];
    FakeAudioContext.instances.push(this);
  }

  async resume() {
    this.state = 'running';
  }

  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    const buffer = {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData(channel) {
        return data[channel];
      }
    };
    this.buffers.push(buffer);
    return buffer;
  }

  createMediaElementSource(media) {
    if (FakeAudioContext.mediaSourceError) throw FakeAudioContext.mediaSourceError;
    const node = new FakeAudioNode('source');
    node.media = media;
    this.sources.push(node);
    return node;
  }

  createBiquadFilter() {
    const node = new FakeAudioNode('filter');
    this.filters.push(node);
    return node;
  }

  createConvolver() {
    return new FakeAudioNode('convolver');
  }

  createDelay() {
    return new FakeAudioNode('delay');
  }

  createWaveShaper() {
    const node = new FakeAudioNode('wave-shaper');
    this.waveShapers.push(node);
    return node;
  }

  createDynamicsCompressor() {
    const node = new FakeAudioNode('compressor');
    this.compressors.push(node);
    return node;
  }

  createStereoPanner() {
    const node = new FakeAudioNode('panner');
    this.panners.push(node);
    return node;
  }

  createGain() {
    const node = new FakeAudioNode('gain');
    this.gains.push(node);
    return node;
  }

  createChannelSplitter() {
    return new FakeAudioNode('splitter');
  }

  createChannelMerger() {
    return new FakeAudioNode('merger');
  }
}

async function createContentHarness(options = {}) {
  FakeAudioContext.instances = [];
  FakeAudioContext.mediaSourceError = options.mediaSourceError ?? null;
  const html = options.withMedia === false ? '<body></body>' : '<body><audio id="media"></audio></body>';
  const dom = new JSDOM(`<!doctype html>${html}`, {
    url: options.url ?? 'https://www.youtube.com/watch?v=example',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  const runtimeMessage = createEvent();
  const runtimeMessages = [];
  const warnings = [];

  Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' });
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;
  window.console.warn = (...args) => warnings.push(args);

  if (options.withoutBody) window.document.body.remove();

  const media = window.document.getElementById('media');
  if (media) {
    Object.defineProperties(media, {
      duration: { configurable: true, value: options.duration ?? 300 },
      mediaKeys: { configurable: true, value: options.mediaKeys ?? null },
      readyState: { configurable: true, value: options.readyState ?? 2 }
    });
    media.playbackRate = 1;
  }

  window.chrome = {
    runtime: {
      onMessage: runtimeMessage,
      async sendMessage(message) {
        runtimeMessages.push(structuredClone(message));
        if (message.type === 'GET_TAB_STATE') return options.remembered ?? null;
        return null;
      }
    }
  };

  const source = fs.readFileSync(`${root}/extension/content.js`, 'utf8');
  window.eval(source);
  await flushPromises();
  await flushPromises();

  function dispatch(message) {
    let response;
    for (const listener of runtimeMessage.listeners) {
      listener(message, {}, (value) => {
        response = value;
      });
    }
    return response;
  }

  return {
    get context() {
      return FakeAudioContext.instances[0];
    },
    dispatch,
    dom,
    media,
    runtimeMessage,
    runtimeMessages,
    source,
    warnings,
    getContext: () => FakeAudioContext.instances[0],
    window
  };
}

module.exports = { FakeAudioContext, FakeAudioNode, createContentHarness };
