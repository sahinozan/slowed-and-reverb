'use strict';

const fs = require('fs');
const { JSDOM } = require('jsdom');

const { waitFor } = require('./browser-api');

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}
const { root } = require('./load-script');

const { version: VERSION } = JSON.parse(fs.readFileSync(`${root}/extension/manifest.json`, 'utf8'));

// Follows Web Audio's automation rules closely enough to hear a jump: each
// setting keeps its scheduled events and reports its value at its context's
// current time. Tests move that clock themselves. `ramps` records each ramp's
// target and end time.
class FakeAudioParam {
  constructor(context) {
    this.context = context;
    this.intrinsic = 0;
    this.events = [];
    this.ramps = [];
  }

  get value() {
    return this.valueAt(this.context?.currentTime ?? 0);
  }

  set value(value) {
    this.intrinsic = value;
    this.events = [];
  }

  valueAt(time) {
    let previous = { time: 0, value: this.intrinsic };
    for (const event of this.events) {
      if (event.time <= time) {
        previous = event;
        continue;
      }
      if (event.type !== 'ramp' || event.time <= previous.time) return previous.value;
      const progress = (time - previous.time) / (event.time - previous.time);
      return previous.value + (event.value - previous.value) * progress;
    }
    return previous.value;
  }

  insert(event) {
    const index = this.events.findIndex(({ time }) => time > event.time);
    if (index < 0) this.events.push(event);
    else this.events.splice(index, 0, event);
  }

  cancelScheduledValues(time) {
    this.events = this.events.filter((event) => event.time < time);
  }

  setValueAtTime(value, time) {
    this.insert({ type: 'set', value, time });
  }

  linearRampToValueAtTime(value, endTime) {
    this.ramps.push({ to: value, endTime });
    this.insert({ type: 'ramp', value, time: endTime });
  }
}

class FakeAudioNode {
  constructor(type, context) {
    this.type = type;
    this.connections = [];
    this.gain = new FakeAudioParam(context);
    this.frequency = new FakeAudioParam(context);
    this.Q = new FakeAudioParam(context);
    this.delayTime = new FakeAudioParam(context);
    this.pan = new FakeAudioParam(context);
    this.threshold = new FakeAudioParam(context);
    this.knee = new FakeAudioParam(context);
    this.ratio = new FakeAudioParam(context);
    this.attack = new FakeAudioParam(context);
    this.release = new FakeAudioParam(context);
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

  // Lets time pass on every audio clock, so scheduled changes complete.
  static advance(seconds) {
    for (const context of FakeAudioContext.instances) context.currentTime += seconds;
  }

  constructor() {
    this.sampleRate = 20;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new FakeAudioNode('destination', this);
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
    const node = new FakeAudioNode('source', this);
    node.media = media;
    this.sources.push(node);
    return node;
  }

  createBiquadFilter() {
    const node = new FakeAudioNode('filter', this);
    this.filters.push(node);
    return node;
  }

  createConvolver() {
    return new FakeAudioNode('convolver', this);
  }

  createDelay() {
    return new FakeAudioNode('delay', this);
  }

  createWaveShaper() {
    const node = new FakeAudioNode('wave-shaper', this);
    this.waveShapers.push(node);
    return node;
  }

  createDynamicsCompressor() {
    const node = new FakeAudioNode('compressor', this);
    this.compressors.push(node);
    return node;
  }

  createStereoPanner() {
    const node = new FakeAudioNode('panner', this);
    this.panners.push(node);
    return node;
  }

  createGain() {
    const node = new FakeAudioNode('gain', this);
    this.gains.push(node);
    return node;
  }

  createChannelSplitter() {
    return new FakeAudioNode('splitter', this);
  }

  createChannelMerger() {
    return new FakeAudioNode('merger', this);
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
  if (options.userAgent) {
    Object.defineProperty(window.navigator, 'userAgent', { value: options.userAgent });
  }
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
    // jsdom has no default; browsers keep the original pitch unless told not to.
    media.preservesPitch = true;
  }

  // jsdom leaves event.source unset, which both scripts check. Keeps the
  // messages between the two scripts and counts those that haven't arrived yet.
  const pageMessages = [];
  let messagesOnTheWay = 0;
  window.postMessage = (data) => {
    pageMessages.push(data);
    messagesOnTheWay++;
    setTimeout(() => {
      messagesOnTheWay--;
      window.dispatchEvent(new window.MessageEvent('message', { data, source: window }));
    }, 0);
  };

  // The engine checks every 250 ms that the extension is still running (see
  // youtube-main.js). Whether content.js answered a check is known once the
  // check is over.
  const bridgeChecks = [];
  window.document.addEventListener('SLOWED_REVERB_YOUTUBE_CHECK', (event) => bridgeChecks.push(event));

  // A new copy of the extension's messaging, as each extension instance has.
  function connectExtension(version) {
    const runtimeMessage = createEvent();
    window.chrome = {
      runtime: {
        id: 'example',
        getManifest: () => ({ version }),
        onMessage: runtimeMessage,
        async sendMessage(message) {
          runtimeMessages.push(structuredClone(message));
          if (message.type === 'GET_TAB_STATE') return options.remembered ?? null;
          return null;
        }
      }
    };
    return runtimeMessage;
  }

  // The background script injects the page-world engine, then settings.js and
  // content.js. `engineVersion` stands for an engine from another version,
  // and undefined for one from 1.1.1 or earlier, which reports none.
  let engineSource = fs.readFileSync(`${root}/extension/youtube-main.js`, 'utf8');
  if (Object.hasOwn(options, 'engineVersion')) {
    engineSource = engineSource.replace(
      /const VERSION = '[^']*';/,
      `const VERSION = ${JSON.stringify(options.engineVersion) ?? 'undefined'};`
    );
  }
  const settingsSource = fs.readFileSync(`${root}/extension/settings.js`, 'utf8');
  const source = fs.readFileSync(`${root}/extension/content.js`, 'utf8');
  let runtimeMessage;
  let extensionVersion = options.extensionVersion ?? VERSION;

  async function inject() {
    runtimeMessage = connectExtension(extensionVersion);
    window.eval(engineSource);
    window.eval(settingsSource);
    window.eval(source);
    // Lets content.js and the engine finish their first exchange.
    if (options.settle !== false) await waitFor(() => messagesOnTheWay === 0);
  }

  // Turns the extension off as Chromium does: content.js stays in the page
  // without the extension. Resolves once the engine's next check has gone
  // unanswered, which turns the engine off.
  async function turnOff() {
    delete window.chrome.runtime.id;
    const checked = bridgeChecks.length;
    await waitFor(() => bridgeChecks.slice(checked).some((event) => !event.defaultPrevented));
  }

  try {
    await inject();
  } catch (error) {
    // The test never gets the harness to close, and the engine's timers
    // would keep the test file running.
    window.close();
    throw error;
  }

  // Resolves with the content script's answer to a message from the extension.
  // A change of pitch mode reaches the player 40 ms after the answer, once
  // the output has faded out (see youtube-main.js), so wait for it too.
  const PLAYER_CHANGE_SETTLE_MS = 60;

  // Resolves once the change has played out: a second passes on the audio
  // clock afterward unless the test keeps it still (advance: 0).
  function dispatch(message, { advance = 1 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer to ${message.type}`)), 3000);
      for (const listener of runtimeMessage.listeners) {
        listener(message, {}, (value) => {
          clearTimeout(timer);
          setTimeout(() => {
            FakeAudioContext.advance(advance);
            resolve(value);
          }, PLAYER_CHANGE_SETTLE_MS);
        });
      }
    });
  }

  return {
    get context() {
      return FakeAudioContext.instances[0];
    },
    dispatch,
    dom,
    // Turns the extension off and on again without reloading the page, or
    // updates it to `version`: the old content script stays without the
    // extension, as in Chromium, and a new one is injected, as both browsers
    // do when the popup opens. The engine already in the page stays, and
    // the new copy stops at its guard.
    async reinject(version = extensionVersion) {
      await turnOff();
      window.__slowedReverbInjected = false;
      extensionVersion = version;
      await inject();
    },
    media,
    pageMessages,
    get runtimeMessage() {
      return runtimeMessage;
    },
    runtimeMessages,
    source,
    turnOff,
    warnings,
    getContext: () => FakeAudioContext.instances[0],
    window
  };
}

module.exports = { FakeAudioContext, FakeAudioNode, createContentHarness };
