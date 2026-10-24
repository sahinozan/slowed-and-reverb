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

// The most render blocks in a row that may carry a stale frame number (see
// staleFrameLabels below). Chromium's reproducer (chromium-stale-frame.js)
// has shown runs of one and two.
const MAX_STALE_RUN = 2;
// How many stale runs are kept for the page to check the sound across, and
// how many faults of the frame numbers are kept as evidence.
const STALE_LOG_SIZE = 32;
const FAULT_LOG_SIZE = 8;
// How long the native clock (contextClock below) runs: a day, in seconds.
const CLOCK_SPAN_SECONDS = 86_400;
// The shortest block the recorder accepts (see blockFrames below).
const MIN_BLOCK_FRAMES = 128;

class AudioTrialRecorder extends AudioWorkletProcessor {
  // A second clock, kept by the browser rather than by currentFrame: the
  // page ramps this parameter by one per second of context time
  // (capture-observer.js), and the browser computes its value for each
  // sample of the block it is rendering. Only the change from one block to
  // the next is used. Chromium moves an event scheduled in the past to the
  // block where the parameter is first computed and keeps its value
  // (ClampNewEventsToCurrentTime in audio_param_handler.cc), so the ramp's
  // own value can be a few blocks off the context's time, but it still
  // advances with every block rendered: one block's worth between two
  // blocks rendered one after the other, more when blocks were rendered
  // without this node.
  static get parameterDescriptors() {
    return [{ name: 'contextClock', defaultValue: -1, minValue: -1, maxValue: CLOCK_SPAN_SECONDS, automationRate: 'a-rate' }];
  }

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
    // Blocks the rendering thread didn't give this node (a jump forward in
    // currentFrame).
    this.contextFrameGaps = 0;
    this.skippedContextFrames = 0;
    this.gapLog = [];
    // Blocks whose currentFrame ran behind the frame expected. When Chromium
    // connects or disconnects nodes at the destination it sometimes gives
    // this node a block with the previous block's frame number, once or
    // twice in a row, and the next block has exactly the number expected;
    // with no extension involved, a steady tone recorded across them has no
    // click, which a repeated or missing block would make. Only that is a
    // stale label: a block with the same number as the block before, after a
    // block in step, at most MAX_STALE_RUN in a row, followed by a block
    // numbered as expected. Such a block is counted here and taken as the
    // frame expected, and each run is logged (staleLog: the raw and
    // expected numbers, and the block it caught up at) so the page can check
    // that the sound across it is unbroken.
    this.staleFrameLabels = 0;
    this.staleRuns = 0;
    this.staleLog = [];
    this.openStale = null;
    // Any other frame number behind the one expected (a counter that went
    // back, stopped, or stayed behind too long), and a stale run that didn't
    // catch up exactly: the recording can't be placed in time, so it isn't
    // valid data. Kept apart from stale labels, with the first few logged.
    this.frameLabelFaults = 0;
    this.faultLog = [];
    this.lastEnd = null;
    this.lastRaw = null;
    this.lastFrames = 0;
    this.lastClock = null;
    this.blocks = 0;
    this.inStep = false;
    // The context frame the recording began at. When Chromium starts
    // rendering a worklet, the first block's currentFrame can be a block or
    // more behind, as a stale label is later (staleFrameLabels), and the
    // second block's number is then ahead of the one expected. Where the
    // native clock shows that the two blocks were rendered one after the
    // other, the first block is taken as the one before the second, and the
    // raw and corrected numbers are kept (initialFrameLabel). That is the
    // only number the native clock corrects.
    this.firstContextFrame = null;
    this.initialFrameLabel = null;
    // Blocks with no input channels (nothing connected or playing) and with a
    // channel count other than two.
    this.emptyInputBlocks = 0;
    this.nonStereoBlocks = 0;
    this.blockSizes = [];
    // The length of every block, taken from the first. A context renders
    // all its blocks at one length, its render quantum: 128 frames unless
    // it asks for another. The checks against the native clock tell one
    // block from more to within half a block, which can't tell a block of
    // one length from a block of another plus a shorter one left out, or
    // read a block much shorter than 128 frames to that precision. So a
    // block of any other length than the first, or a first block shorter
    // than MIN_BLOCK_FRAMES, is a fault: the recording isn't valid data.
    this.blockFrames = null;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'recycle') this.pool.push(new Float32Array(event.data.buffer));
    };
    this.port.postMessage({ type: 'hello', sampleRate, currentFrame, batchFrames, poolSize });
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] || [];
    const output = outputs[0];
    // The block length is read, not assumed to be 128 frames, and has to
    // stay the same (blockFrames above).
    const frames = output && output[0] ? output[0].length : input[0] ? input[0].length : 0;
    if (frames === 0) return true;
    if (!this.blockSizes.includes(frames) && this.blockSizes.length < 8) this.blockSizes.push(frames);
    if (this.blockFrames === null) this.blockFrames = frames;
    const lengthOk = frames === this.blockFrames && frames >= MIN_BLOCK_FRAMES;

    const raw = currentFrame;
    const clock = this.readClock(parameters, frames);
    // Context frames the native clock advanced since the previous block
    // began, and whether that was exactly the previous block, to within half
    // a block: far more than float32 loses in any context here (the unit
    // tests read it after an hour, and after ten minutes of Chromium's x86
    // ramp, which adds its values up). With every block the same length,
    // a block left out moves it a whole block more.
    const nativeStep = clock !== null && this.lastClock !== null ? (clock - this.lastClock) * sampleRate : null;
    const nextBlock = lengthOk && nativeStep !== null && Math.abs(nativeStep - this.lastFrames) < this.lastFrames / 2;
    const faultsBefore = this.frameLabelFaults;
    if (!lengthOk) this.fault(frames === this.blockFrames ? 'block too short' : 'block length changed', raw, null, frames);
    if (clock === null) this.fault('native clock unreadable', raw);
    let frame = raw;
    let skipped = 0;
    if (this.lastEnd === null) {
      this.firstContextFrame = raw;
      this.inStep = true;
    } else if (this.blocks === 1 && raw > this.lastEnd && nextBlock && this.batchStartFrame === 0 && this.fill === this.lastFrames) {
      // The first block's number was behind: it was the block just before
      // this one. Its batch hasn't been sent, so it is relabelled there.
      const corrected = raw - this.lastFrames;
      this.initialFrameLabel = { raw: this.lastRaw, corrected, frames: this.lastFrames };
      this.firstContextFrame = corrected;
      this.batchContextFrame = corrected;
      this.inStep = true;
    } else if (raw === this.lastEnd) {
      if (this.openStale) this.closeStale(true, raw);
      this.inStep = true;
    } else if (raw > this.lastEnd) {
      skipped = raw - this.lastEnd;
      this.contextFrameGaps++;
      this.skippedContextFrames += skipped;
      // Where the first few happened, by the recorder's own frame count.
      if (this.gapLog.length < 8) {
        this.gapLog.push({ recorderFrame: this.recordedFrames, contextFrame: raw, expected: this.lastEnd, stale: false });
      }
      if (this.openStale) this.closeStale(false, raw);
      this.inStep = true;
    } else if (raw === this.lastRaw && (this.openStale ? this.openStale.blocks < MAX_STALE_RUN : this.inStep)) {
      this.staleFrameLabels++;
      if (this.openStale) {
        this.openStale.blocks++;
        this.openStale.frames += frames;
      } else {
        this.openStale = {
          recorderFrame: this.recordedFrames,
          contextFrame: raw,
          expected: this.lastEnd,
          blocks: 1,
          frames,
          recovered: null,
          recoveredRecorderFrame: null,
          recoveredContextFrame: null
        };
        this.staleRuns++;
        this.staleLog.push(this.openStale);
        if (this.staleLog.length > STALE_LOG_SIZE) this.staleLog.shift();
        if (this.gapLog.length < 8) {
          this.gapLog.push({ recorderFrame: this.recordedFrames, contextFrame: raw, expected: this.lastEnd, stale: true });
        }
      }
      this.inStep = false;
      frame = this.lastEnd;
    } else {
      const kind = raw === this.lastRaw ? 'stale for too long' : this.openStale ? 'went back during a stale run' : 'went back';
      this.fault(kind, raw);
      if (this.openStale) this.closeStale(false, raw, false);
      this.inStep = false;
      frame = this.lastEnd;
    }
    // The frame numbers, as read, must agree with the native clock: one
    // block on from the last for a block in step or a stale label, and as
    // many frames as were skipped more for a gap. A label that jumps ahead
    // while the native clock moved one block, or the native clock skipping
    // blocks the label doesn't, is a fault.
    if (nativeStep !== null && this.frameLabelFaults === faultsBefore) {
      const wanted = this.lastFrames + skipped;
      if (!(Math.abs(nativeStep - wanted) < this.lastFrames / 2)) {
        this.fault(skipped ? 'label skipped frames the native clock did not' : 'native clock skipped frames the label did not', raw, Math.round(nativeStep));
      }
    }
    if (clock !== null) this.lastClock = clock;
    this.lastRaw = raw;
    this.lastFrames = frames;
    this.blocks++;
    this.lastEnd = frame + frames;
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
        this.batchContextFrame = frame + offset;
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

  fault(kind, raw, nativeStep = null, frames = null) {
    this.frameLabelFaults++;
    if (this.faultLog.length < FAULT_LOG_SIZE) {
      const entry = { kind, recorderFrame: this.recordedFrames, contextFrame: raw, expected: this.lastEnd, nativeStep };
      if (frames !== null) Object.assign(entry, { frames, blockFrames: this.blockFrames });
      this.faultLog.push(entry);
    }
  }

  // The native clock at the block's first sample, in seconds, or null if
  // it isn't there for every sample, isn't a number, or doesn't advance one
  // frame per sample across the block (to within half a block).
  readClock(parameters, frames) {
    const values = parameters ? parameters.contextClock : null;
    if (!values || values.length !== frames) return null;
    for (let i = 0; i < frames; i++) {
      if (!Number.isFinite(values[i]) || values[i] < 0 || (i > 0 && values[i] < values[i - 1])) return null;
    }
    const across = (values[frames - 1] - values[0]) * sampleRate;
    return Math.abs(across - (frames - 1)) < frames / 2 ? values[0] : null;
  }

  // Ends the open stale run: caught up at the number expected, or not (a
  // fault, unless the block that ended it is counted as one already).
  closeStale(recovered, raw, count = true) {
    const run = this.openStale;
    run.recovered = recovered;
    run.recoveredRecorderFrame = this.recordedFrames;
    run.recoveredContextFrame = raw;
    if (!recovered && count) this.fault('stale run ended out of step', raw);
    this.openStale = null;
  }

  counters() {
    return {
      firstContextFrame: this.firstContextFrame,
      initialFrameLabel: this.initialFrameLabel,
      overflowFrames: this.overflowFrames,
      overflowEvents: this.overflowEvents,
      contextFrameGaps: this.contextFrameGaps,
      skippedContextFrames: this.skippedContextFrames,
      gapLog: this.gapLog.slice(),
      staleFrameLabels: this.staleFrameLabels,
      staleRuns: this.staleRuns,
      staleRunOpen: this.openStale !== null,
      staleLog: this.staleLog.map((run) => ({ ...run })),
      frameLabelFaults: this.frameLabelFaults,
      faultLog: this.faultLog.slice(),
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
