// The audio capture trial's recorder (README.md in this folder). It runs on
// the browser's audio rendering thread, in an AudioWorklet, and is served to
// the trial page by fixture.js; it isn't Node code.
//
// It copies every block it is given into batches of `batchFrames` stereo
// frames and sends each full batch to the page. The batches come from a pool
// allocated up front, and the page sends each one back once it has read it.
// When the pool runs dry (the page stopped reading), the recorder drops
// frames instead of allocating, and counts them, so a lost frame is never
// mistaken for silence and memory stays bounded. Each batch carries the
// recorder's own frame number and the context frame it started at, so the
// page can tell a late message from a missing sample.

class AudioTrialRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { batchFrames, poolSize } = options.processorOptions;
    this.batchFrames = batchFrames;
    this.pool = [];
    for (let i = 0; i < poolSize; i++) this.pool.push(new Float32Array(batchFrames * 2));
    this.current = null;
    this.fill = 0;
    this.batchStartFrame = 0;
    this.batchContextFrame = 0;
    this.seq = 0;
    // Frames the recorder has been given, including any it dropped.
    this.recordedFrames = 0;
    this.overflowFrames = 0;
    this.overflowEvents = 0;
    this.dropping = false;
    this.droppedBlocks = 0;
    // Blocks the rendering thread didn't give this node (a jump in currentFrame).
    this.contextFrameGaps = 0;
    this.skippedContextFrames = 0;
    this.lastEnd = null;
    // Blocks with no input channels (nothing connected or playing) and with a
    // channel count other than two.
    this.emptyInputBlocks = 0;
    this.nonStereoBlocks = 0;
    this.blockSizes = [];
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'recycle') this.pool.push(new Float32Array(event.data.buffer));
    };
    this.port.postMessage({ type: 'hello', sampleRate, currentFrame, batchFrames, poolSize });
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0];
    // The block length isn't assumed to be 128 frames.
    const frames = output && output[0] ? output[0].length : input[0] ? input[0].length : 0;
    if (frames === 0) return true;
    if (!this.blockSizes.includes(frames) && this.blockSizes.length < 8) this.blockSizes.push(frames);

    if (this.lastEnd !== null && currentFrame !== this.lastEnd) {
      this.contextFrameGaps++;
      this.skippedContextFrames += currentFrame - this.lastEnd;
    }
    this.lastEnd = currentFrame + frames;
    if (input.length === 0) this.emptyInputBlocks++;
    else if (input.length !== 2) this.nonStereoBlocks++;

    // Passes the input through, so a monitor gain after this node can be
    // turned up to listen; the trial keeps it at 0.
    for (let channel = 0; channel < output.length; channel++) {
      if (input[channel]) output[channel].set(input[channel]);
      else output[channel].fill(0);
    }

    let offset = 0;
    while (offset < frames) {
      if (this.current === null) {
        this.current = this.pool.pop() || null;
        if (this.current === null) {
          const dropped = frames - offset;
          const starting = !this.dropping;
          if (starting) {
            this.overflowEvents++;
            this.droppedBlocks = 0;
          }
          this.dropping = true;
          this.overflowFrames += dropped;
          this.recordedFrames += dropped;
          // No batch can carry the news, so say so now and then.
          if (starting || ++this.droppedBlocks % 32 === 0) this.postStatus('overflow');
          break;
        }
        this.dropping = false;
        this.fill = 0;
      }
      if (this.fill === 0) {
        this.batchStartFrame = this.recordedFrames;
        this.batchContextFrame = currentFrame + offset;
      }
      const count = Math.min(frames - offset, this.batchFrames - this.fill);
      for (let channel = 0; channel < 2; channel++) {
        const start = channel * this.batchFrames + this.fill;
        const target = this.current.subarray(start, start + count);
        if (input[channel]) target.set(input[channel].subarray(offset, offset + count));
        else target.fill(0);
      }
      this.fill += count;
      offset += count;
      this.recordedFrames += count;
      if (this.fill === this.batchFrames) this.flush();
    }
    return true;
  }

  counters() {
    return {
      overflowFrames: this.overflowFrames,
      overflowEvents: this.overflowEvents,
      contextFrameGaps: this.contextFrameGaps,
      skippedContextFrames: this.skippedContextFrames,
      emptyInputBlocks: this.emptyInputBlocks,
      nonStereoBlocks: this.nonStereoBlocks,
      blockSizes: this.blockSizes
    };
  }

  postStatus(reason) {
    this.port.postMessage({ type: 'status', reason, ...this.counters() });
  }

  flush() {
    const buffer = this.current.buffer;
    this.port.postMessage(
      {
        type: 'batch',
        seq: this.seq++,
        startFrame: this.batchStartFrame,
        frames: this.fill,
        batchFrames: this.batchFrames,
        contextFrame: this.batchContextFrame,
        ...this.counters(),
        buffer
      },
      [buffer]
    );
    this.current = null;
    this.fill = 0;
  }
}

registerProcessor('audio-trial-recorder', AudioTrialRecorder);
