'use strict';

// The audio capture trial's observer (README.md in this folder). The browser
// drivers install installAudioTrialObserver in the trial page's own world
// before any of the page's scripts run, so it is serialized and has to stay
// self-contained.
//
// It replaces the `destination` getter of audio contexts. For each real-time
// AudioContext, the getter returns one GainNode, the bus, set up like the
// context's real destination (its actual channel count, mode and
// interpretation are copied and recorded, not assumed). Everything the page
// connects to `destination` is summed into the bus by the browser itself,
// and a plain disconnect() takes it out again, so the engines' own connect
// and disconnect calls work unchanged. The bus feeds the recorder worklet,
// then a gain of 0, then the real destination: the context's clock and the
// recorder keep running, and nothing recorded is heard.
//
// The recorder worklet loads asynchronously; until it is ready, the bus goes
// straight to the gain of 0. Measurements wait for it (waitReady).

function installAudioTrialObserver(options) {
  if (window.__audioTrial) return;

  const {
    workletUrl,
    batchFrames = 2048,
    poolSize = 16,
    retainSeconds = 4,
    monitorGain = 0,
    mediaSelector = '#player'
  } = options;
  const Base = window.BaseAudioContext || window.AudioContext;
  const descriptor = Object.getOwnPropertyDescriptor(Base.prototype, 'destination');
  const nativeConnect = AudioNode.prototype.connect;
  const nativeDisconnect = AudioNode.prototype.disconnect;
  const contexts = [];
  const byContext = new WeakMap();
  const errors = [];
  let recycle = true;

  function enroll(context, destination) {
    const sampleRate = context.sampleRate;
    const retainFrames = Math.ceil(retainSeconds * sampleRate);
    const entry = {
      id: contexts.length,
      context,
      createdAtMs: performance.now(),
      sampleRate,
      destination: {
        channelCount: destination.channelCount,
        channelCountMode: destination.channelCountMode,
        channelInterpretation: destination.channelInterpretation,
        maxChannelCount: destination.maxChannelCount,
        numberOfInputs: destination.numberOfInputs,
        numberOfOutputs: destination.numberOfOutputs
      },
      baseLatency: context.baseLatency ?? null,
      bus: null,
      sink: null,
      recorder: null,
      hello: null,
      error: null,
      ring: [new Float32Array(retainFrames), new Float32Array(retainFrames)],
      retainFrames,
      nextFrame: 0,
      lostFrames: 0,
      batches: 0,
      lastBatch: null,
      worklet: {},
      firstArrivalMs: null,
      lastArrivalMs: null,
      maxArrivalGapMs: 0,
      // Context frame minus recorder frame, from the first batch. It stays
      // the same while every render block reaches the recorder, and maps a
      // context time (a mark) to the recorded frame played then.
      frameOffset: null,
      offsetChanges: 0
    };
    entry.bus = new GainNode(context, {
      channelCount: destination.channelCount,
      channelCountMode: destination.channelCountMode,
      channelInterpretation: destination.channelInterpretation
    });
    entry.sink = new GainNode(context, { gain: monitorGain });
    nativeConnect.call(entry.bus, entry.sink);
    nativeConnect.call(entry.sink, destination);
    contexts.push(entry);

    entry.ready = context.audioWorklet
      .addModule(workletUrl)
      .then(
        () =>
          new Promise((resolve) => {
            const recorder = new AudioWorkletNode(context, 'audio-trial-recorder', {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [2],
              channelCount: 2,
              channelCountMode: 'explicit',
              channelInterpretation: 'speakers',
              processorOptions: { batchFrames, poolSize }
            });
            recorder.port.onmessage = (event) => {
              const message = event.data;
              if (message.type === 'hello') {
                entry.hello = message;
                resolve();
              } else if (message.type === 'batch') {
                receive(entry, message);
              } else if (message.type === 'status') {
                entry.worklet = counters(message);
              }
            };
            recorder.onprocessorerror = () => {
              entry.error = 'the recorder worklet stopped with an error';
            };
            nativeConnect.call(entry.bus, recorder);
            nativeConnect.call(recorder, entry.sink);
            nativeDisconnect.call(entry.bus, entry.sink);
            entry.recorder = recorder;
          })
      )
      .catch((error) => {
        entry.error = `the recorder worklet did not load: ${error && error.name}: ${error && error.message}`;
      });
    return entry;
  }

  function counters(message) {
    return {
      overflowFrames: message.overflowFrames,
      overflowEvents: message.overflowEvents,
      contextFrameGaps: message.contextFrameGaps,
      skippedContextFrames: message.skippedContextFrames,
      emptyInputBlocks: message.emptyInputBlocks,
      nonStereoBlocks: message.nonStereoBlocks,
      blockSizes: message.blockSizes
    };
  }

  function receive(entry, message) {
    const arrival = performance.now();
    if (entry.lastArrivalMs !== null) {
      entry.maxArrivalGapMs = Math.max(entry.maxArrivalGapMs, arrival - entry.lastArrivalMs);
    } else {
      entry.firstArrivalMs = arrival;
    }
    entry.lastArrivalMs = arrival;
    // A batch that starts after the frame the page expected means frames
    // were dropped in between (the worklet counts them as overflow).
    if (message.startFrame !== entry.nextFrame) entry.lostFrames += message.startFrame - entry.nextFrame;
    const offset = message.contextFrame - message.startFrame;
    if (entry.frameOffset === null) entry.frameOffset = offset;
    else if (offset !== entry.frameOffset) entry.offsetChanges++;
    const samples = new Float32Array(message.buffer);
    const [left, right] = entry.ring;
    for (let i = 0; i < message.frames; i++) {
      const position = (message.startFrame + i) % entry.retainFrames;
      left[position] = samples[i];
      right[position] = samples[message.batchFrames + i];
    }
    entry.nextFrame = message.startFrame + message.frames;
    entry.batches++;
    entry.lastBatch = {
      seq: message.seq,
      startFrame: message.startFrame,
      frames: message.frames,
      contextFrame: message.contextFrame,
      arrivalMs: arrival
    };
    entry.worklet = counters(message);
    if (recycle) entry.recorder.port.postMessage({ type: 'recycle', buffer: message.buffer }, [message.buffer]);
  }

  Object.defineProperty(Base.prototype, 'destination', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      const destination = descriptor.get.call(this);
      // Offline rendering has no clock to observe; only real-time contexts.
      if (typeof AudioContext !== 'function' || !(this instanceof AudioContext)) return destination;
      let entry = byContext.get(this);
      if (!entry) {
        try {
          entry = enroll(this, destination);
          byContext.set(this, entry);
        } catch (error) {
          // The capture then has no context to measure and fails.
          errors.push(`could not observe a context: ${error && error.name}: ${error && error.message}`);
          return destination;
        }
      }
      return entry.bus;
    }
  });

  // The player's position, added up while it plays so a loop doesn't wrap it.
  const media = { clock: 0, last: null, samples: 0 };
  window.setInterval(() => {
    const player = document.querySelector(mediaSelector);
    if (!player) return;
    const time = player.currentTime;
    if (media.last !== null) {
      let step = time - media.last;
      if (step < 0 && player.loop && Number.isFinite(player.duration)) step += player.duration;
      if (step > 0) media.clock += step;
    }
    media.last = time;
    media.samples++;
  }, 25);

  function base64(floats) {
    const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }

  window.__audioTrial = {
    options: { batchFrames, poolSize, retainSeconds, monitorGain },
    errors,
    contextCount: () => contexts.length,
    setRecycle(value) {
      recycle = value;
    },
    // Resolves once the context's recorder is loaded and frames have reached
    // the page, or rejects with what is missing.
    async waitReady(id, timeoutMs) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const entry = contexts[id];
        if (entry?.error) throw new Error(`context ${id}: ${entry.error}`);
        if (entry?.hello && entry.batches > 0) return true;
        if (performance.now() > deadline) {
          const state = entry ? entry.context.state : 'never created';
          const reason = !entry
            ? 'no audio context was connected to its destination'
            : !entry.hello
              ? 'the recorder worklet never started'
              : 'the recorder received no frames';
          throw new Error(`context ${id}: ${reason} within ${timeoutMs} ms (context state: ${state})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    snapshot(id) {
      const entry = contexts[id];
      const player = document.querySelector(mediaSelector);
      return {
        wallMs: performance.now(),
        contextCount: contexts.length,
        errors: errors.slice(),
        context: entry
          ? {
              id: entry.id,
              state: entry.context.state,
              currentTime: entry.context.currentTime,
              sampleRate: entry.sampleRate,
              baseLatency: entry.baseLatency,
              outputLatency: entry.context.outputLatency ?? null,
              destination: entry.destination,
              createdAtMs: entry.createdAtMs
            }
          : null,
        recorder: entry
          ? {
              ready: Boolean(entry.hello),
              error: entry.error,
              workletSampleRate: entry.hello ? entry.hello.sampleRate : null,
              firstContextFrame: entry.hello ? entry.hello.currentFrame : null,
              nextFrame: entry.nextFrame,
              batches: entry.batches,
              lostFrames: entry.lostFrames,
              lastBatch: entry.lastBatch,
              firstArrivalMs: entry.firstArrivalMs,
              maxArrivalGapMs: entry.maxArrivalGapMs,
              frameOffset: entry.frameOffset,
              offsetChanges: entry.offsetChanges,
              ...entry.worklet
            }
          : null,
        media: player
          ? {
              clock: media.clock,
              currentTime: player.currentTime,
              duration: player.duration,
              paused: player.paused,
              ended: player.ended,
              muted: player.muted,
              volume: player.volume,
              playbackRate: player.playbackRate,
              readyState: player.readyState
            }
          : null,
        startClicks: window.startClicks ? window.startClicks.slice() : []
      };
    },
    // Where context `id`'s clock is now, as the page reads it, labelled for
    // the evidence: the context frame, and the recorded frame it maps to.
    // Firefox's clock, as a page reads it, can run a little behind the sound
    // being made, so a mark bounds an action rather than timing it exactly.
    mark(id, label) {
      const entry = contexts[id];
      if (!entry) throw new Error(`no context ${id}`);
      const contextFrame = Math.round(entry.context.currentTime * entry.sampleRate);
      const player = document.querySelector(mediaSelector);
      return {
        label,
        wallMs: performance.now(),
        contextFrame,
        recorderFrame: entry.frameOffset === null ? null : contextFrame - entry.frameOffset,
        nextFrame: entry.nextFrame,
        state: entry.context.state,
        media: player
          ? { clock: media.clock, playbackRate: player.playbackRate, paused: player.paused, src: player.currentSrc.split('/').pop() }
          : null
      };
    },
    // The recorded samples from frame `from` up to `to`, if still retained.
    read(id, from, to) {
      const entry = contexts[id];
      if (!entry) throw new Error(`no context ${id}`);
      if (to > entry.nextFrame || from < entry.nextFrame - entry.retainFrames || to - from > entry.retainFrames) {
        throw new Error(`frames ${from} to ${to} are not retained (next ${entry.nextFrame}, keeping ${entry.retainFrames})`);
      }
      const channels = entry.ring.map((ring) => {
        const out = new Float32Array(Math.max(0, to - from));
        for (let frame = from; frame < to; frame++) out[frame - from] = ring[frame % entry.retainFrames];
        return base64(out);
      });
      return { from, to, sampleRate: entry.sampleRate, channels };
    },
    // The page's own contexts, for the observer's checks with known signals.
    context: (id) => contexts[id]?.context
  };
}

module.exports = { installAudioTrialObserver };
