# Audio capture trial

An experiment, not a regression suite. The browser tests check settings,
playback speed and the gains the engines aim for, but never the sound. This
trial answers one question: can the extension's actual audio output be
recorded and measured, in Chromium and in Firefox, on a developer's Mac and
on a hosted Ubuntu runner?

It isn't part of `npm test`, `npm run check`, the browser smoke tests, the
required "Lint, test, and package" check or `npm run release`.

## Run it

```sh
npx playwright install --no-shell chromium   # once, as for npm run test:e2e
npm run test:audio-trial:chromium            # Playwright's Chromium, about 1 minute
npm run test:audio-trial:firefox             # the installed Firefox, about 45 seconds
```

Run one at a time, and no other browser tests meanwhile. `FIREFOX_BIN`
chooses another Firefox, as for `npm run test:firefox`.
`AUDIO_TRIAL_WINDOWS` (1 to 10, default 3) sets how many one-second windows
each engine capture records.

Nothing is heard: the recording ends in a gain of 0, and the YouTube engine
captures the player before it starts. Two short exceptions remain. The
Spotify engine captures the player only once it plays, so a few milliseconds
can reach the speakers first. The muted-player control plays nothing
audible.

On Linux the trial expects a PulseAudio (or PipeWire) sound server. The
workflow `.github/workflows/audio-capture-trial.yml` sets one up with a
null sink:

```sh
sudo apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=audio_trial
pactl set-default-sink audio_trial
```

Evidence goes to `test-results/audio-trial/<run>/`, about 2 MB in all:

- `environment.json`: the commit, Node, the OS (and runner image on CI), the
  browser and its version, Chromium's actual command line, launch time and
  machine load, the SHA-256 and `VERSION` of each engine script as built and
  as patched in the copy, and on Linux the sound server and its sinks.
- `<case>-w<n>.json` for each recorded window: the measurements, the
  problems found, and both page snapshots.
- `<case>-w<n>.wav`: the first 0.2 seconds of the window, 16-bit stereo.
- `comparison.json` (Chromium): the `--mute-audio` comparison.
- `launch-failure.json`, if the browser didn't start.

## How it records

`capture-observer.js` runs in the page's own world before any of the
page's scripts. It replaces the `destination` getter of audio contexts.
For each real-time `AudioContext`, the getter returns one `GainNode`, the
bus. The bus copies the real destination's channel count, mode and
interpretation, which are recorded as well: 2, `explicit` and `speakers` in
every run so far. The bus feeds `recorder-worklet.js`, an AudioWorklet,
then a gain of 0, then the real destination. Whatever the page connects to
`destination` is summed into the bus by the browser, and the engines' plain
`disconnect()` takes it out again, so the production engines run unchanged.

The worklet copies each block into batches from a pool of 16 buffers of
2048 frames, which the page hands back after reading. If the page stops
handing them back, the worklet drops frames and counts them; it never
allocates more. Each batch carries the recorder's frame number and the
context frame it started at. That's how a message arriving late (reported
as `maxMessageGapMs`, about 45 ms, which is one batch) is kept apart from
missing audio (`lostFrames`, `overflowFrames`, `contextFrameGaps`, and recorded
frames equal to the context frames they span). The page keeps the last 4
seconds per context. Each context has its own clock and recording; nothing
adds up different contexts.

`metrics.js` measures each window. `tests/audio-metrics.test.js` checks it
against computed signals, without a browser. A window is healthy only if
all of these hold:

- the context is `running` at both ends;
- the context clock and the recorded frames advance at 0.5 to 1.5 times the
  wall clock;
- the worklet runs at the context's sample rate;
- no frame was lost, dropped or skipped;
- every block has two channels;
- every sample is finite;
- some channel is above -40 dBFS;
- the expected tones are present at the expected levels;
- the player (if checked) is playing, unmuted and at the expected speed,
  within 15%.

These are coarse feasibility checks, not calibrated tolerances.

The test signal is a 6-second, 48 kHz stereo WAV, generated in
`fixture.js`: 440 Hz on the left and 660 Hz on the right, each at 0.25. It
is served from 127.0.0.1, which stands in for YouTube, and from localhost,
which stands in for Spotify. Players start from a real click on Start. In
both browsers that click is trusted and gives the page user activation, and
the trial sets no autoplay preferences or flags.

## What it checks

The observer, with known native signals and no extension code:

1. Stereo tones from an oscillator per channel: 440 Hz left and 660 Hz
   right, each at 0.25, with no leakage.
2. Two mono branches (440 Hz at 0.2 and 1 kHz at 0.1) summed by the
   browser, each in both channels. Then one disconnected, so only 440 Hz
   is left.
3. An unmuted `<audio>` element through a native `MediaElementAudioSourceNode`,
   at speed 1.

The engines, as built (`dist/`), in a disposable copy (see "Driving the
engines" below). Each runs with speed 0.8, the pitch following and pan
-100. Only the effect's own path can pan, so the trial expects both tones,
slowed to 352 and 528 Hz, on the left, and a silent right channel. It also
expects the player at speed 0.8 and one audio context.

Controls, which must fail, and fail for the right reason:

| Control | Must report | Must not report |
| --- | --- | --- |
| Everything disconnected | `no-signal` | any clock or recorder problem |
| The player muted | `media-muted` | any clock or recorder problem |
| The context suspended | `not-running`, `clock-stalled`, `no-frames` | |
| The page stops returning buffers | `frames-lost` | |
| The worklet URL doesn't exist | an error from `waitReady` | |
| YouTube engine with `processed` not connected to the destination | `no-signal` | any clock or recorder problem |

In Chromium the trial runs twice: the full trial without Playwright's
default `--mute-audio`, then the stereo tones and the YouTube engine with
Playwright's defaults. The second run compares levels with the first.

### Driving the engines

The disposable copy starts as the one the browser tests use
(`e2e/extension-copy.js`, where 127.0.0.1 counts as a YouTube host). On top
of that, `background.js` treats localhost as Spotify, and a test-only
content script lets the page ask the background script to call
`queueTabApply`. That's the call the popup's `APPLY_TO_TAB` message makes.

**This skips the popup page and its permission prompts.** The background
script, the injection of `youtube-main.js` and `content.js`, Spotify's
registered scripts, the bridges and the engines are the build's own. None
of these changes reach the shipped files.

## Results

The results below are measured. Each run records 3 one-second windows per
engine capture. The first Mac run of each browser came before a change
that stopped the observer's own checks from also playing the tone; the
measurements were the same.

| Machine | Browser | Runs | Result |
| --- | --- | --- | --- |
| macOS 27 (Apple silicon), built-in output | Chromium 156 (Playwright 1.64.0), headless, without `--mute-audio` | 3 | All passed |
| Same | Chromium 156, Playwright's defaults (`--mute-audio`) | 3 | Same levels |
| Same | Firefox 158.0.1 (puppeteer-core 25.13.0), headless | 3 | All passed |
| Ubuntu (GitHub-hosted), PulseAudio null sink | Chromium and Firefox | | Pending: the first hosted run of pull request #91 |

What the Mac runs show, in both browsers:

- Every context ran at 48 kHz with 128-frame blocks. Its destination was 2
  channels, `explicit`, `speakers`, with `maxChannelCount` 2.
- Context clocks advanced at 0.997 to 1.004 times the wall clock.
- Recorded frames always equaled the context frames they spanned. There
  were no lost, dropped or skipped frames.
- Native stereo tones and the native media element recorded at 0.25 per
  channel (RMS 0.177), with nothing measurable (below 0.00001) in the
  other channel. Summed branches recorded at 0.2 and 0.1 in both channels, and a
  disconnected branch disappeared completely.
- The YouTube and Spotify engines both put 352 and 528 Hz on the left at
  0.287 each, with the right channel exactly 0. The players advanced at
  0.78 to 0.84 times the wall clock. Each had one context, and the recorder
  was ready before the first frame (context frame 0), so nothing at the
  start was missed. The level is above 0.25 because of the compressor's
  automatic makeup gain.
- Every control failed with the codes in the table, and with no clock or
  recorder problem where the table says so. With everything disconnected,
  the recorder kept receiving frames: they were empty blocks, not a
  stopped clock.
- A muted player gives a native media source exact silence in both
  browsers. So a muted fixture can't pass for engine output here, and the
  trial rejects muted players anyway.
- **`--mute-audio` doesn't change what the recorder receives in Chromium**:
  levels with and without it were identical (0 dB difference) for the
  native tones and the YouTube engine. That fits the flag muting output
  after the graph, where the recorder doesn't look; how Chromium does it
  wasn't examined.

## Limits

- This is the graph's output, recorded inside the browser. It doesn't prove
  that sound reached a speaker, an operating-system mixer or the null sink.
  On Linux, the trial also records which streams the sound server reports
  during the first window (`sinkInputs`).
- The observer adds nodes to the graph. Its effect on timing hasn't been
  measured against an uninstrumented recording, such as OS loopback.
- The recorder starts once its worklet has loaded. For the YouTube engine on
  the Mac that was before the first frame, but the trial doesn't guarantee
  it. `firstContextFrame` in each window records where recording began.
- Only steady tones, two settings and one sample rate (48 kHz) were used.
  Transitions, clicks, gaps, enable and disable, Spotify's speed resets and
  effect accuracy are left for the next stage. So is any historical
  regression as a control. One deliberately broken engine was used.
- The Mac and hosted runs are a handful each, enough to catch obvious
  instability but not to give a flake rate.
- Windows runners weren't tried.

## Recommendation

**Measured so far:** recording real engine output works on a Mac in both
browsers, without new dependencies or production changes, and the
`destination` bus works as intended.

**Pending:** whether a hosted Ubuntu runner with a null sink gives running
clocks and real frames in both browsers. Until its run is read, Linux CI is
not shown to be feasible. If it is, the next stage can build its audio
cases on this harness and gate on Linux. If it isn't, the fallback is to
run the trial on the Mac as part of the release, where it already works.
