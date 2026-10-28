# Audio capture

The browser tests check settings, playback speed and the gains the engines
aim for, but never the sound. This folder records the sound itself, the
engines' real output in Chromium and in Firefox, in two parts:

- **The trial** (`chromium-trial.js`, `firefox-trial.js`) answered whether
  the output can be recorded and measured at all, on a developer's Mac and
  on a hosted Ubuntu runner. It can (see "Trial results").
- **The regression suite** (`chromium-regression.js`,
  `firefox-regression.js`) records the engines without a gap through the
  changes that have gone wrong before: changes of settings while a song
  plays, Spotify's own speed changes, turning the extension off, removing
  and updating it. Each defect the project has fixed is put back into a
  disposable copy, and the suite has to catch it (see "The regression
  suite").

Neither is part of `npm test`, `npm run check`, the browser smoke tests, the
required "Lint, test, and package" check or `npm run release`.

## Run them

```sh
npx playwright install --no-shell chromium   # once, as for npm run test:e2e
npm run test:audio-trial:chromium            # the trial in Playwright's Chromium, about 1 minute
npm run test:audio-trial:firefox             # the trial in the installed Firefox, about 45 seconds
npm run test:audio:chromium                  # the regression suite in Chromium, about 4.5 minutes
npm run test:audio:firefox                   # the regression suite in Firefox, about 4 minutes
```

Run one at a time, and no other browser tests meanwhile. `FIREFOX_BIN`
chooses another Firefox, as for `npm run test:firefox`.
`AUDIO_TRIAL_WINDOWS` (1 to 10, default 3) sets how many one-second windows
each of the trial's engine captures records. `AUDIO_REGRESSION_EVIDENCE=compact`
keeps the suite's sound excerpts to those around a problem, for repeated
runs. `AUDIO_REGRESSION_MUTE=1` runs the Chromium suite with Playwright's
default `--mute-audio`, so nothing at all reaches the speakers, on a
machine someone is listening to; the trial found that the recorder gets
the same samples either way (see "Trial results"), and its evidence goes
to `chromium-mute-audio/`. Firefox has no such switch.

Almost nothing is heard: the recording ends in a gain of 0, and the
YouTube engine captures the player before it starts. A few exceptions
remain. The Spotify engine captures the player only once it plays, so a few
milliseconds can reach the speakers first. The trial's muted-player control
plays nothing audible. The suite's checks of turning the effect on while a
song plays (and the reproducer `firefox-capture-click.js`, unless it is
given `quiet`) play the tone aloud for about a second first, since the
song has to be playing before the effect turns on.

Three reproducers, which aren't tests and need no extension, show browser
behavior the suite has to live with:

```sh
node e2e/audio-capture/firefox-capture-click.js 6               # Firefox's own frame of silence after a playing player is routed into a graph (see "Limits")
node e2e/audio-capture/chromium-stale-frame.js 4                # Chromium's stale frame numbers, and that the sound across them is unbroken (see "How it records")
node e2e/audio-capture/recorder-first-block.js chromium 12 48000 # where the recorder's first block falls, against two known ramps (see "How it records")
```

`firefox-capture-click.js` also takes `playing` (route the player as it
starts), `quiet` (the player at volume 0 until it is routed, so nothing is
heard; a different condition, see "Limits"), `seconds=<n>` (how long it
records, default 6) and `rate=<speed>` (the speed set after routing,
default 0.8; `rate=1` leaves it alone, and Firefox's frame of silence is
then recorded as one frame of exactly 0 in both channels), `control` (the
graph puts in one frame of silence of its own, 4 seconds after the routing,
with the song a frame late after it, which is what Firefox's does at 1x;
its run has to show it) and `save=<folder>` (each run's recording as a
32-bit float WAV, with its results). Each run also lists `slips`: where
the tone's phase moves by a quarter of a sample or more, whether or not it
counts as a click. It needs 50 ms of the tone on each side of a move, so it
doesn't see the first half second, the last 50 ms, or about 50 ms on either
side of a gap, and it counts moves within 50 ms of each other as one. Run it with
`MOZ_LOG=timestamp,MediaDecoder:5,AudioSink:4 MOZ_LOG_FILE=<path>` to get
Firefox's own log of it. `recorder-first-block.js` takes `chromium` or
`firefox`, the runs, the context's sample rate, and a control that has to
fail (`planted`, `clock-stopped`, `clock-fast`); it is silent. Both give a
browser 60 seconds to start. Firefox starts through `e2e/firefox-launch.js`,
which prints how the start went and ends one that runs out of time: it
aborts puppeteer's launch (puppeteer then kills the browser's processes),
closes a browser that starts after all, and kills the process it started
if it is still running after that (each of these waits at most 10
seconds), before the reproducer stops with the deadline's error. Nothing is tried again. Chromium's start is ended by
Playwright's own launch timeout.

On Linux the trial expects a PulseAudio (or PipeWire) sound server. The
workflow `.github/workflows/audio-capture-trial.yml` sets one up with a
null sink:

```sh
sudo apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=audio_trial
pactl set-default-sink audio_trial
```

Every step of the workflow's two jobs has its own deadline, setting up
included (24 minutes at most, against under a minute on a hosted run), and
the deadlines add up to 5 minutes less than the job's own limit, with 5 of
them for the upload. So a step that runs out of time fails as a step and
the evidence is still uploaded, rather than the whole job being cancelled.
`tests/audio-workflow.test.js` checks those sums, with each step in turn
running out of time and GitHub's rules for which steps run after a
failure; it doesn't run the workflow. The Firefox step runs after a
Chromium failure too, once the sink is there.

The trial's evidence goes to `test-results/audio-trial/<run>/`, about 2 MB
in all:

- `environment.json`: the commit, Node, the OS (and runner image on CI), the
  browser and its version, Chromium's actual command line, launch time and
  machine load, the SHA-256 and `VERSION` of each engine script as built and
  as patched in the copy, and on Linux the sound server and its sinks.
- `<case>-w<n>.json` for each recorded window: the measurements, the
  problems found, and both page snapshots.
- `<case>-w<n>.wav`: the first 0.2 seconds of the window, 16-bit stereo.
- `comparison.json` (Chromium): the `--mute-audio` comparison.
- `launch-failure.json`, if the browser didn't start.
- `firefox-launch.txt` (Firefox): how its start went, from
  `e2e/firefox-launch.js` (its version, when its WebDriver BiDi port
  opened, its first lines of output, what its processes were doing if the
  port hadn't opened 15 seconds into the start and, if it failed, what they
  were doing then). The suite writes it too.

The suite's goes to `test-results/audio-regression/<browser>/`, about 6 MB
(under 1 MB with compact evidence):

- `environment.json`, as for the trial, plus the suite's own thresholds and
  the earlier-version copy it updates from.
- `summary.json`: each check's problems, clicks, silent stretches, how long
  the unchanged sound took to come back, and its largest click-free third
  difference (`quietPeak`), and each control's problem codes.
- `<check>.json` for each recorded span: every action with its marks in
  context frames, what it was allowed to do and what came back from the
  extension; every click and silent stretch, and whether an action allowed
  it; each steady stretch's tones, levels and player speed; the RMS of each
  channel every 10 ms; the requests that reached the engine and the
  player's changes of speed; both page snapshots.
- `<check>-<n>.wav`: 0.45 seconds from each action (from 50 ms before it)
  and around each problem, 16-bit stereo. For turning the effect on while a
  song plays, also `<check>-whole.wav`, the whole span (with compact
  evidence, only if the check failed).
- `<check>-failed.json`, for a check that couldn't finish (a page step or
  action that timed out, a setup that failed): the error, and each span's
  actions, marks and a last snapshot, if the page still answered.
- `control-<id>-copy.json`: what each historical control changed, and the
  copy's file hashes.

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
seconds per context (20 for the suite). Each context has its own clock and
recording; nothing adds up different contexts.

For the suite, the page also notes the context frame each batch started
at, less the recorder's own frame number. That stays the same from batch to
batch while every render block reaches the recorder; any change counts as a
skipped block (`offsetChanges`). It also maps a moment on the context's
clock (a mark) to the recorded frame played then.

The suite's recorder hears the bus through a `DelayNode` of 0.25 seconds
(`delaySeconds`), which the bus feeds from the moment the context is
observed. The worklet takes tens of milliseconds to load, and turning the
effect on while a song plays creates the context, whose sound can start
before then. Through the delay, a recorder that loads within a quarter of a
second still records the context's sound from its first frame; what it
records before that is the delay's own silence. A quarter of a second is a
whole number of frames at 44.1 and 48 kHz and exact in the node's 32-bit
parameter, so the delay moves every sample by whole frames and changes
none, and the observer refuses a delay that isn't. The mapping takes the
delay off, so a mark still maps to the recorded frame of the sound made at
that moment, and a span waits for the recorder to reach a moment before
it starts there or ends. A player's pause that isn't one of the check's own
actions counts as an interruption (`interrupted`) if the span before it on
the page hadn't seen it when it was measured (or the page opened since),
up to whenever the page is asked. The delay puts the span's sound earlier than the page's snapshots
around it, by an amount the page's clock can't bound closely enough, so the
suite doesn't try: a pause between two spans, or one whose event comes
late, can make a span invalid that it didn't touch, but none that touched
it is missed. The delay has a fixed channel count, as the bus
does: in the default mode, when everything leaves the bus (a page taking
its player out), Chromium's delay changed its channel count and played the
quarter-second it still held with the two channels averaged. A probe with
known ramps, run outside the repository (Chromium 156 and Firefox 159 on
this Mac, muted, 44.1 and 48 kHz, 20 runs), found every recorded sample
exact, a ramp started with the context recorded from its first sample
when the recorder started up to 512 frames after it, and marks mapped to
the exact frame. Without the delay, the same probe lost the ramp's first
256 to 512 frames. With the default channel mode, Chromium's ramps broke
exactly 0.25 seconds before a disconnect, in 3 of 3 runs, and Firefox's
didn't.

Around a change of connections at the destination, Chromium sometimes gives
the recorder a block with the previous block's frame number, once or twice
in a row, and the next block then has exactly the number expected. A steady
tone recorded across such blocks, with no extension involved, has no click,
which a repeated or missing 128-frame block would make
(`chromium-stale-frame.js`). The recorder takes only that as a stale label
(`staleFrameLabels`), and takes the block as the frame expected: a block
with the same number as the block before, after a block in step, at most
two in a row, followed by the number expected. It logs each such run, with
the raw and expected numbers and where it caught up (`staleLog`). Any other
number behind the one expected (a counter that went back, stopped, or stayed
behind longer) is a fault (`frameLabelFaults`, the first few in `faultLog`).
A jump forward is a skipped block, as before. `gapLog` keeps where the first
few skipped blocks and stale runs happened.

The recorder also has a clock of its own that doesn't come from
`currentFrame`: an AudioParam, `contextClock`, which the page ramps by one
per second of context time from when the recorder is made, and which the
browser computes for every sample of the block it renders. Chromium moves
an automation event scheduled in the past to the first block where the
parameter is computed, keeping its value (`ClampNewEventsToCurrentTime` in
Chromium's `audio_param_handler.cc`), so the ramp's own value can be a few
blocks off the context's time; the recorder uses only how much it moves
from one block to the next, which that doesn't change. Between two blocks
rendered one after the other it moves by one block. Each block's numbers
have to agree with it: a block in step or a stale label one block on, a
skipped block as many frames more as were skipped. A label that jumps
ahead while the clock moved one block, the clock moving more than the
label, and a clock that is missing, stopped, not a number or doesn't move
one frame per sample within the block are faults. It is read to within half
a block, which float32 keeps for far longer than any context here lives.
That tells one block from two only if every block has the same length, as
a context's blocks do (its render quantum, 128 frames unless it asks for
another): a block of 512 frames followed by one of 128 with 128 left out
between them moves the clock 640 frames, within half a block of 512. So
the recorder takes the first block's length as every block's, and a block
of another length, or a first block shorter than 128 frames, is a fault
on every such block; it doesn't try to read a recording whose blocks
change length. Every context so far has had 128-frame blocks.

It corrects one number, and only one. When Chromium starts rendering a
worklet, the recorder's very first block can carry a number one or more
blocks behind, as a stale label does later (Chromium sets the worklet's
`currentFrame` after each block only when it gets the graph's lock, in
`UpdateWorkletGlobalScopeOnRenderingThread`), and the second block then has
the number expected after the real first one: a jump forward. The recorder
can't see that from the numbers alone. Where the native clock shows the two
blocks were rendered one after the other, and the first block's batch
hasn't been sent, the first block is taken as the one just before the
second, and its raw and corrected numbers are kept (`initialFrameLabel`);
`firstContextFrame` is where recording really began. No sample is added,
taken away or assumed silent. A jump forward anywhere else, or one the
clock doesn't confirm, is a skipped block as before.
`recorder-first-block.js` shows it with two known ramps (see "Limits").

`metrics.js` measures each window. `tests/audio-metrics.test.js` checks it
against computed signals, without a browser. A window is healthy only if
all of these hold:

- the context is `running` at both ends;
- the context clock and the recorded frames advance at 0.5 to 1.5 times the
  wall clock;
- the worklet runs at the context's sample rate;
- no frame was lost, dropped or skipped;
- no frame number was out of step other than as a stale label, and across
  each stale run the sound has no step (no third difference above 0.05, the
  suite's click threshold) and doesn't repeat the block before it;
- every block has two channels;
- every sample is finite;
- some channel is above -40 dBFS;
- the expected tones are present at the expected levels;
- the player (if checked) is playing, unmuted and at the expected speed,
  within 15%.

These are coarse feasibility checks, not calibrated tolerances.

The test signal is a 6-second, 48 kHz stereo WAV, generated in
`fixture.js`: 440 Hz on the left and 660 Hz on the right, each at 0.25. The
suite's page (`/long`) plays the same tones for 30 seconds, so a recording
never reaches the loop: Chromium leaves about 5 ms of silence where a
looping player starts again. A second 30-second song, 500 and 750 Hz,
stands in for the next track. Both are served from 127.0.0.1, which stands
in for YouTube, and from localhost, which stands in for Spotify. The page
takes the media session's actions and ignores them: otherwise media keys
and the system's Now Playing controls go to the test's player, the last
page to play, and pause it from outside, as happened once while this Mac
was in use. The suite fails a check whose player paused other than by one
of its own actions as `interrupted`. Players start from a real click on Start. In
both browsers that click is trusted and gives the page user activation, and
the trial sets no autoplay preferences or flags.

## What the trial checks

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
Playwright's defaults. The second run compares levels with the first. The
comparison uses only valid data: every window on both sides must pass the
checks above other than those for the level, the tones and the player.
Silence, with or without anything connected, is valid and counts as a
changed level. Any other problem, such as a stalled clock, lost frames or
a sample that isn't a number, fails the comparison and is listed under
`invalid` in `comparison.json`.

### Driving the engines

The disposable copy starts as the one the browser tests use
(`e2e/extension-copy.js`, where 127.0.0.1 counts as a YouTube host). On top
of that, `background.js` treats localhost as Spotify, and a test-only
content script lets the page ask the background script to call
`queueTabApply`. That's the call the popup's `APPLY_TO_TAB` message makes.
Each request carries its own ID, and the page waits at most 10 seconds for
the reply with that ID. No reply, or one that can't be read, fails the
case with that reason, and the browser is still closed as usual.

**This skips the popup page and its permission prompts.** The background
script, the injection of `youtube-main.js` and `content.js`, Spotify's
registered scripts, the bridges and the engines are the build's own. None
of these changes reach the shipped files.

## Trial results

The results below are measured. Each run records 3 one-second windows per
engine capture. The first Mac run of each browser came before a change
that stopped the observer's own checks from also playing the tone; the
measurements were the same.

| Machine | Browser | Runs | Result |
| --- | --- | --- | --- |
| macOS 27 (Apple silicon), built-in output | Chromium 156 (Playwright 1.64.0), headless, without `--mute-audio` | 3 | All passed |
| Same | Chromium 156, Playwright's defaults (`--mute-audio`) | 3 | Same levels |
| Same | Firefox 158.0.1 (puppeteer-core 25.13.0), headless | 3 | All passed |
| Same, after the level comparison and request deadline changes | Chromium 156 with and without `--mute-audio`, Firefox 158.0.1 | 1 | All passed, same levels |
| Ubuntu (GitHub-hosted, image `ubuntu26` 20261021.171.10), PulseAudio 17.0 null sink | Chromium 156 with and without `--mute-audio`, Firefox 158.0.1 | 1 | All passed, same levels (see below) |
| Ubuntu (GitHub-hosted, image `ubuntu26` 20261012.163.1), PulseAudio 17.0 null sink, after the level comparison and request deadline changes | Chromium 156 with and without `--mute-audio`, Firefox 157.0 | 1 | All passed (12 and 9 tests), same levels |

The first Ubuntu run is [Audio capture trial run 39837845967](https://github.com/sahinozan/slowed-and-reverb/actions/runs/39837845967).
It tested commit `c0dcc13`, GitHub's merge of `9e94e3e` into `main`, so it
came before the level comparison and request deadline changes. The second
is [run 39844500692](https://github.com/sahinozan/slowed-and-reverb/actions/runs/39844500692),
which tested `c398f92`, GitHub's merge of `734c061` into `main` (`4af2dec`),
whose files are those of `734c061`, the trial as merged. Their evidence is
kept for 14 days.

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
  0.78 to 0.84 times the wall clock. Each had one context. Recording began
  at context frame 0 in Firefox, and at frame 0 to 256 (up to 5 ms) in
  Chromium. The level is above 0.25 because of the compressor's automatic
  makeup gain.
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

What the Ubuntu run shows, in both browsers:

- Every context ran at 44.1 kHz, the sound server's default, with
  128-frame blocks and the same destination as on the Mac.
- Context clocks advanced at 0.99 to 1.013 times the wall clock, and
  recorded frames always equaled the context frames they spanned, with no
  lost, dropped or skipped frames.
- The native tones, summing, disconnect and media element recorded at the
  same levels as on the Mac. The engines put 352 and 528 Hz on the left at
  0.287 each, with the right channel exactly 0, and the players advanced
  at 0.79 to 0.82 times the wall clock.
- Recording of the engines began at context frame 0 in Firefox, and at
  1024 to 1536 (23 to 35 ms) in Chromium; in the second run, at 0 to 896
  in Firefox and 1536 to 2048 (up to 46 ms) in Chromium. Some frames were
  skipped before the recorder's first measured window in some captures;
  each window counts only its own frames, and none of the 30 measured
  windows of the second run lost, dropped or skipped a frame. Its clocks
  advanced at 0.989 to 1.015 times the wall clock.
- Every control failed with the codes in the table, and with no clock or
  recorder problem where the table says so. In Firefox the broken engine also reported empty
  blocks (`no-input`), as everything disconnected does.
- `--mute-audio` made no difference (0 dB).
- During the first window the sound server listed the browser's audio
  streams on the null sink (two for Chromium, one for Firefox), as 32-bit
  float stereo at 44.1 kHz.
- Firefox took 39 seconds to start in the first run and 15 in the
  second, against about 1 second for Chromium. The first job took 3
  minutes, with Playwright's Chromium restored from the cache.

## The regression suite

The suite records the engines as built, through the extension in a
disposable copy, driven the trial's way (see "Driving the engines"), in
Playwright's Chromium without `--mute-audio` and in the installed Firefox.
Firefox also runs with both `--remote-allow-system-access` and
`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in its environment, as
`npm run test:firefox` does, so the suite can turn the extension off and on
through Firefox's add-on manager. Firefox 159 needs the variable; the switch
stays for earlier versions.

### What it checks

Each check records one span of a page's audio, without a gap, while it acts
the way a person, the page or the browser would. In both browsers, with
both engines unless the table says otherwise:

| Check | What happens while it records | What has to be heard |
| --- | --- | --- |
| Speed, pitch and reverb as heard | 0.8x with the pitch following, then kept; the song stopped with no reverb, then with reverb 60 | 352 and 528 Hz on the left (440 and 660 Hz with the pitch kept), nothing on the right, the player at 0.8x; silence after a song without reverb, a tail after one with it |
| Turning the effect on while the song plays | The song plays without the effect, then the effect turns on, which creates the audio context; the span goes on for about 6 seconds | The recording starts in silence (so the change was heard from its start), only the engines' own silence before the sound comes in, then the effect, with no click anywhere in the 6 seconds and no slip of the tones' phase, except Firefox's late frame (see "How it measures") |
| Changes while the song plays | Reverb 40, pan to the middle, speed 0.9, eight pan changes paced to reach the engine 30 ms apart, as when a slider is dragged, keeping the pitch and letting it follow again, the effect off and on | No click; silence only where the engine fades out to hide a change of the player; the right tones, channels and speed after each change; the song itself, at its exact level, with the effect off |
| Spotify's own speed changes (Spotify only) | Spotify sets the player back to normal speed three times, holds it at 0 for a seek, asks for normal speed 5 ms into a change that is waiting to fade out, and plays the next song on the same player, then asks for normal speed again | No click or silence during the resets, and the player's speed never changes; the effect's speed after the seek and on the next song; the song itself, playing, once the effect is off |
| Turning the extension off and on in the browser | From the extensions page in Chromium, Firefox's add-on manager in Firefox; on YouTube, with the extension off, the page takes its player out, puts it back and plays it at 1.25x; then the extension and the effect come back on | The song itself, at its exact level, within a second, with no click; the page's own 1.25x afterwards; the effect again once it's turned back on, except Spotify in Chromium, which needs a reload (Chromium doesn't put Spotify's scripts back into an open tab), so it stays unchanged and the reloaded page has the effect |
| Removing the extension | In Firefox, removed through WebDriver BiDi, as from the add-ons page; in Chromium, the extension removes itself (see "Limits") | As when turned off |
| An update keeps the previous engine off | An earlier version's copy (every script's `VERSION` and the manifest at 0.0.1) is updated to this one: in Chromium as a developer's reload from chrome://extensions, in Firefox as a second temporary install. On Spotify in Firefox, the extension is then turned off and on, which puts the new bridge next to the old engine. Then the effect is asked for | The song itself within a second of the update, and still after asking for the effect, which is refused: as `outdated` by the new scripts, or on Spotify in Chromium, which puts no new scripts into an open tab, as `unsupported`; the reloaded page has the effect |

Turning the effect off in the popup, turning the extension off in the
browser and removing it are different actions here: the first is the
extension's own message, the other two the browser's. The suite doesn't
call the engines' internal shutdown directly in place of either.

### How it measures

In the check of turning the effect on while a song plays, the suite also
follows each tone's phase (`phaseSlips` in `metrics.js`, the reproducer's
scan), from half a second in to 50 ms before the end, leaving out any
quiet stretch: every 10 ms, the phase of 20 ms of the song, fitted to both
of the left channel's tones at once so neither leaks into the other, and
every place it moves by a quarter of a sample or more. That finds a frame
of silence, or one added or lost, that leaves no click over the threshold.
Firefox's late frame (see "Limits") delays the whole song by a frame of it
at the effect's speed (1.25 samples at 0.8x for this song in a 48 kHz
context, within 0.2), 1.5 to 5 seconds in. In Firefox, the first slip that
moves both tones by that much is kept as an action of its own, "Firefox's
late frame", and a click there doesn't fail the check. Each tone has to
have slipped, and moved by that much across the whole slip too, from the
200 ms before it to the 200 ms after, so two frames close enough to be
found as one aren't taken for it. It is in the evidence (`phaseSlips` in
the check's JSON and the summary). Any other slip fails the check
(`phase-slip`), in either browser: one of a single tone, a second frame,
or one of another size. So does a click anywhere else. The scan places a
slip only roughly, in a stretch of 10 to 30 ms (from about 10 ms before
the window it was found at to 20 ms after, narrowed by the other tone's),
which can miss the change by a millisecond or so; a click within 5 ms
either side of that stretch counts as the frame's. So a click from the
extension that close to Firefox's frame would be taken as Firefox's; with
these tones, 176 Hz apart, shorter windows can't place it closer.

Every action is marked on the audio context's clock just before it starts
and just after it is done, and each mark is mapped to the recorded frame
played at that moment (see "How it records"). Nothing an action causes can
be heard before its first mark. A span starts once the recorder is running
and has recorded at least 100 ms before every action, so no transition is
cropped. Turning the effect on while a song plays creates the context, so
that span starts with the context's first frame, which the recording
delay keeps (see "How it records"), and has to begin in silence
(`onset-not-observed` otherwise, if the recorder took longer than the
delay to load). A span is valid data only if the
context ran throughout, no frame was lost, dropped or skipped since it
started (or since the recording started, for a span that starts with it),
recorded frames equal the context frames they span, every sample is a
number, the recorder's frame numbers can be trusted (see "How it
records"), every mark falls in order and no more than one batch (2048
frames) before the frames the page already had, plus the recording delay
(`mark-out-of-step`
otherwise; in over 10,000 marks so far, none fell more than 128 frames
before) and nothing outside the check paused the player. Any of those
fails the check as a measurement failure, and says so, never as a sound
problem; a control that fails that way doesn't count as caught.

A check that can't finish fails the same way. The page's own steps that
wait for the player (playing it, the next song, putting it back) give up
after 10 seconds in the page, removing their listeners and timers; the
Node side gives up on any request to the page after 12 seconds, and on any
action after 30. The check then writes `<check>-failed.json`, closes its
pages and fails as a measurement failure; a control is never counted as
caught that way. The extension's own requests keep the trial's deadlines.

Within a span:

- **A click** is a sample whose third difference, in either channel, is
  above 0.05. The third difference of a steady tone is under 0.002 for
  every tone the suite plays, and a step of size d in the wave gives 2d, so
  0.05 is a step of 0.025 (-32 dBFS) or more. The largest where nothing was
  wrong was 0.017, Chromium's own small glitch when a player changes speed;
  the historical defects clicked at up to 1.5 (see "Suite results" for
  their smallest). A step below 0.025 isn't heard by this measure.
- **A gap** is a run of 5 ms blocks below -80 dBFS in both channels.
- Each action may cause only what is expected of it. A change of settings
  that makes the player click (in Firefox any change of speed or pitch
  mode, in Chromium a change of pitch mode) may cause the engine's own dip:
  it fades out over 10 ms, changes the player 40 ms after the request and
  stays silent until 80 ms after that, about 90 ms of silence. 150 ms is
  allowed, the 60 ms extra for a late page timer. The effect's first
  routing may be silent for 335 ms in Firefox (the engines' 250 ms and
  25 ms fade, plus 60) and 205 ms in Chromium (until 80 ms after the change
  of pitch mode 40 ms in, and the 25 ms fade, plus 60), from the context's
  first frame. Only the page's own actions
  that stop the song (pausing it, a seek, taking the player out, the next
  song) may click, and be silent for as long as the action took plus
  150 ms. Clicks and silence count as an action's if they start between
  its first mark and 300 ms after its last (1.5 s for turning the
  extension off, removing or updating it, which the engines notice within
  their 250 ms check). Anything else fails, as `click` or `gap`.
- Steady stretches between actions, from 400 ms after one action for
  600 ms, are checked for the tones expected in each channel (within 3% of
  their frequency), for silence where there should be none, and for the
  player's speed within 15%. After a change of pitch with reverb on, and
  after the effect turns back on with it, the reverb's 2-second tail still
  rings the tones played before (its convolver comes before the pan and
  keeps hearing the song while the effect is off). There a tone the effect
  shouldn't have, if it was there before the change, is measured but not
  judged in that stretch, and a second stretch from 2.4 s after the change
  checks everything again, that tone included (`... : after the reverb
  tail`). Clicks and gaps are still looked for in every frame between. The effect's tones may be 0.1 to 0.5 (the
  compressor raises a tone of 0.25 to 0.287, and reverb adds copies at
  other phases), and the tones it shouldn't have under 0.02; the song
  itself has to be 0.24 to 0.26, with under 0.005 of the other tone.
- After turning the extension off, removing or updating it, the unchanged
  sound has to be back within 1 second of the action's first mark, and stay
  until the end of the steady stretch after it: in every 10 ms from then
  on, each channel carries the song's own tone (440 Hz left, 660 Hz right)
  within 0.01 of its level of 0.25, fitted with its phase free, and less
  than 0.005 RMS (-46 dBFS) of anything else. A partial level, the wrong
  tone or channel, or the effect still mixed in, never counts. When the
  right channel first carried sound for good is kept as `energyOnsetMs`,
  only for comparison; it isn't restoration.

`tests/audio-continuity.test.js` checks these measurements with computed
signals, without a browser: planted steps, a gain set straight away and a
two-sample dropout are clicks; the engines' fades, a crossfade and the
loudest steady tones aren't; silence fails unless an action allows that
much; and a message that reaches the page late isn't missing audio, while
a lost or skipped frame is. It runs `recorder-worklet.js` itself over
computed tones: one or two stale labels that catch up are valid data and
marks still map to the frames played; a counter that goes back by 512 ms
(with the page's clock or without), stops, or stays behind three blocks,
and a stale label over a block of sound played twice or left out, fail as
measurements. A sound that only reaches its exact level 1.1 s after the
extension is turned off, the wrong tone, the wrong channel and the effect
still mixed in are not restored, while the song faded in on time is. A
page step whose `play()` never settles or whose `playing` never comes, and
a page that doesn't answer, fail within their deadlines and leave no
listener or timer behind.

### Historical defects as controls

Each audible defect the project has fixed is put back into a disposable
copy (`history.js`), and the check that should hear it runs against that
copy. The control passes only if, in every engine the defect was put back
into, each on its own, the check fails with each problem listed, at the
action or steady stretch listed, and with no recording or setup problem.
A defect caught in one engine and missed in the other isn't caught. The engines have changed since, and their old files report no
version, so today's extension keeps them off; most defects are therefore
put back narrowly in today's code. "Exact" means the old lines themselves
in place of the fix; "narrow", today's code changed to behave as the old
code did in the way that was heard; "surrogate", a different route to the
same symptom, where the old route no longer exists.

| Commit | Defect | Put back | Browsers | Caught as |
| --- | --- | --- | --- | --- |
| `02ef174` | Clicks when the effect or its settings changed | Narrow: every setting jumps straight to its new value, the player changes at once, no silence while a player is first routed in | Both | `click` during the overlapping changes and when the effect turns off and on (it clicks at other changes too, but a value set straight away clicks only as loudly as the wave is at that instant, so a single change can come out small) |
| `3fbb1c3` | Jumps when changes overlapped | Exact (the first of its two fixes): a change starts from the setting's value now | Both | `click` during the overlapping changes |
| `74032cc` | Spotify skipped every 12 to 13 s in Firefox | Narrow: Spotify's speed writes reach the player again, and the engine puts its speed back with its silent dip | Firefox, where it was heard | `gap` (85 to 90 ms each) during Spotify's resets, and the player changed speed 6 times |
| `9cde26c` | The Spotify player stayed stopped after a speed request during a waiting change | Exact | Both | `gap` (over 1.2 s) during that change, and the player at 0x afterwards |
| `134e1c0` | The effects stayed on after the extension was turned off in Chromium | Surrogate: the content scripts Chromium leaves running keep answering for the extension | Chromium, where it was heard | `not-restored` |
| `1127987` | Spotify's effects stayed on after Firefox turned the extension off | Surrogate: the engine stops checking for its bridge | Firefox, where it was heard | `not-restored` |
| `9a900c4` (two) | After the extension was off, a YouTube player taken out and put back stayed silent; and the engine reset YouTube's own speed to 1x | Narrow, each part on its own | Both | `gap` (about 2.5 s) after the player was put back; the wrong tones (440 Hz instead of 550 Hz) at 1.25x |
| `0cad7f4` | After an update, the new YouTube scripts used the old engine | Narrow: any engine version is accepted | Both | `old-engine-ran`, and the effect's tones where the song itself should be |
| `4565b80` | After an update and turning the extension off and on, Firefox's new Spotify bridge used the old engine | Narrow: any engine version is accepted | Firefox, where it was heard | As for `0cad7f4` |

Two defects are put back only in the browser where they were heard. The
`74032cc` defect would not make the dip in Chromium, which changes speed
without one, and the old Chromium shutdown route `1127987` replaced worked
in Chromium.

### Suite results

Measured on one Mac (macOS 27, Apple silicon, built-in output, 48 kHz), in
Playwright's Chromium 156.0.8078.4 and Firefox 158.0.1, each run of a
browser's whole suite, controls included, one after another with no other
browser tests. The Mac was in use for some of them.

| Commit | Browser | Runs | Passed | Failed | Why they failed |
| --- | --- | --- | --- | --- | --- |
| `8cf89c5` | Chromium | 2 | 0 | 2 | A block out of step (`context-gap`) in the `9a900c4` control; the player paused from outside, by the system's media controls, in a check of changes on Spotify |
| `963b6e4` | Chromium | 3 | 2 | 1 | A block out of step in the `9a900c4` control |
| `963b6e4` | Firefox | 3 | 3 | 0 | (two of them ran with a later change to the test page) |
| `11ac9ea` | Chromium | 23 | 17 | 6 | A block out of step five times (twice in turning the extension off on YouTube, three times in the `9a900c4` controls), and once the context's clock ran at 0.4 times the wall clock (in the `134e1c0` control) |
| `d69226b` | Chromium | 2 | 1 | 1 | The `02ef174` control didn't click at the change of pitch mode, though it clicked at other changes (its expectation changed after this) |
| `b4ca3c6` | Chromium | 23 | 23 | 0 | |
| `b4ca3c6` | Firefox | 23 | 20 | 3 | Once Firefox didn't start (its WebDriver BiDi session wasn't created within 180 s; no audio was measured); twice a single click in a Spotify check (see "Limits") |
| `10665ea` | Chromium | 1 | 1 | 0 | |
| `10665ea` | Firefox | 1 | 0 | 1 | Turning the effect on while a song plays clicked on YouTube (0.50 at 2.13 s) and on Spotify (0.22 at 2.91 s) (see "Limits") |
| `117b822` | Chromium | 1 | 1 | 0 | (AirPods Pro output at 48 kHz) |
| `117b822` | Firefox | 1 | 0 | 1 | Turning the effect on while a song plays clicked on Spotify (0.44 at 2.22 s), with valid recorder data (AirPods Pro output at 48 kHz) |
| `1959850` | Firefox 159.0 | 1 | 0 | 1 | (main `080a4be` with a change to unit tests only) Seven checks couldn't turn the extension off: Firefox 159 needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` (fixed in #106; no sound result). Turning the effect on while a song plays passed in both engines (AirPods Pro) |
| `437fc85` | Firefox 159.0 | 1 | 0 | 1 | After the update check reloaded Spotify, 415 ms of silence and the player at 0.651 times the wall clock (0.8 wanted); not seen in 7 reruns (5 of that check alone at `89bb5e5`, and the two runs below); its cause is unknown, and Firefox's media log wasn't on (AirPods Pro) |
| `89bb5e5` | Firefox 159.0 | 2 | 2 | 0 | (AirPods Pro, Firefox's media log on: no gap logged) |

Until the last Firefox batch, every failure was a measurement failure or a
control that wasn't caught as it should be. In that batch, two Spotify
checks failed on a click each, which is not explained (see "Limits"). One
more `b4ca3c6` Chromium run stopped when the Mac went to sleep for three
hours partway through; it isn't counted, and the run was done again.
Earlier, while the suite was being written, its runs also failed on the
looping fixture's silence in Chromium and on Firefox's own click after
turning the effect on during a song, which led to the 30-second songs and
the short check of that action. The
failures led to the changes between those commits: the test page takes
the media controls, the recorder tells a stale frame number from a missing
block (`chromium-stale-frame.js` reproduces it with no extension, and shows
a planted repeated or missing block clicking at 0.19 to 0.52 where the
stale ones measure 0.000048, a clean tone), and the `02ef174` control asks
for the clicks it always makes.

`10665ea` checks restoration as the exact unchanged sound, frame numbers
and marks more strictly, each control engine by engine, and records turning
the effect on while a song plays for about 6 seconds instead of about 1.
Before `10665ea`, those checks were weaker in the ways "How it measures"
and "Historical defects as controls" now rule out, and that check ended
before Firefox's late click (see "Limits"). The `b4ca3c6` runs below were
measured that way.

With `10665ea`'s code (5 runs of just that check in each browser before it
was committed, and the whole suite once after), turning the effect on while
a song plays failed in Firefox on YouTube in 1 of 6 runs (0.50 at 2.13 s)
and on Spotify in 4 of 6 (0.22 to 0.56, at 2.62 to 3.06 s), every time with
valid recorder data. The Spotify runs that passed still measured 0.026
(under the 0.05 threshold) at about 2.8 s. It passed in all 4 Chromium runs,
with nothing above 0.0003. In the whole-suite runs, the exact unchanged sound
came back 180 to 360 ms after the extension was turned off, removed or
updated (10 to 20 ms after the right channel first carried sound), at
exactly 0.25 with 0.00001 of anything else. The one block where it came
close to the limits was the end of the engines' 25 ms fade-in, in Firefox
(0.247, and 0.0044 of anything else), which at most delays restoration by
one block. No stale label or frame-number fault occurred in these runs;
Chromium's reproducer, with no extension, gave 9 stale labels in 8 runs
(one run of two), each caught up as expected, and no fault.

In the `b4ca3c6` runs:

- The unchanged sound came back 80 to 420 ms after the extension was
  turned off or updated in Chromium (limit 1000), and 150 to 390 ms in
  Firefox, removal included.
- The largest third difference where nothing may click was 0.010 in
  Chromium and 0.0045 in Firefox, outside the two failed spans, against a
  threshold of 0.05.
- The controls clicked, at their smallest in any run: `02ef174` at 0.39
  when the effect turned off, 0.43 when it turned on and 0.76 during the
  overlapping changes in Chromium (0.34, 0.50 and 0.61 in Firefox);
  `3fbb1c3` at 0.44 in Chromium and Firefox. The other controls were caught
  by gaps of 85 ms to 2.5 s, the unchanged sound not coming back, or the
  wrong tones, each far from its limit.
- In a stretch with reverb, a tone the effect shouldn't have measured up to
  0.015 against a limit of 0.02: the previous pitch still rings in the
  2-second reverb tail after a change of pitch mode. That is the closest
  any passing check came to a limit.
- Recording began at context frame 0 or 256.

These runs are enough to show the suite mostly steady on this Mac, not to
give a flake rate below a few percent, and none of them ran on a hosted
runner.

When the native clock and the stretches after the reverb tail were added
(`f1f253e`), one whole-suite Chromium run on this Mac (AirPods at 48 kHz,
with `AUDIO_REGRESSION_MUTE=1`) passed 17 of 17, each control caught as
listed, with nothing of the previous tone above 0.00004 after the tail.
Five more runs of turning the effect on while a song plays, muted, passed;
recording began at context frame 0 in all of them, so none needed the
first-block correction. Firefox's suite wasn't run then: its checks of
turning the effect on during a song play the tone aloud, and the Mac was
in use. It was run once afterwards, at `117b822` (see the table above),
and passed 21 of 22: turning the effect on while a song plays failed on
Spotify, on a click of 0.4354 at 2219.7 ms with valid recorder data. That
failure stands, and its cause is not known. The evidence of every failed
run is kept outside the repository by the run that made it;
`chromium-stale-frame.js` and `firefox-capture-click.js` reproduce the
browser behavior behind them.

### What it can replace, and what stays manual

It doesn't replace the routine listen after an engine change. The suite
hears, in both browsers, the speed and pitch, the effect being there, clicks
and gaps when settings change, Spotify's own speed changes, and the sound
coming back unchanged when the effect or the extension is turned off,
removed or updated, and each defect the project has shipped and fixed is
caught when put back. But turning the effect on while a song plays fails in
Firefox on a click of Firefox's own that hasn't been decided on (see
"Limits"), and the suite hasn't run
often enough on any machine to give it a flake rate. Run it after an engine
change, as well as listening.

Before the suite could replace the listen for clicks, gaps and the sound coming
back (with the same trigger: a change to an engine, the content scripts or the
background script), all of this would have to be shown:

1. A baseline with a fixed plan: full runs of both suites with their controls,
   at least 30 per browser on each setup (this Mac on its own speakers, this
   Mac on AirPods, and the hosted Ubuntu runner), over at least 5 separate
   days, on the current main and Firefox's current and previous versions,
   with each run recorded.
   None may fail on sound without an explanation and a fix, or a written
   acceptance. A Firefox that doesn't start gives no result, and that run is
   done again.
2. Firefox's late click (see "Limits") confirmed gone or present on the
   current Firefox, from saved samples, against a page known to click, or the
   remaining doubt accepted in writing. Done for Firefox 159: it's present,
   and the click detector can miss it. The suite now finds it by the tones'
   phase, and reports it without failing (see "Limits"). It still needs a
   fix in Firefox, or a written decision to accept it, before the suite can
   stand in for the listen in Firefox.
3. The 415 ms dropout in a Spotify update check on Firefox 159 (see "Suite
   results") explained from a failing run with Firefox's media log on, or
   accepted in writing.
4. Removing the extension and Spotify updates in Chromium in the suite.
   Done: both are checked now (see "What it checks").
5. A rule for every such change: both suites and their controls pass on the
   exact commit to merge, here and in the hosted workflow, with no unexplained
   failure and no missing job. Either the audio workflow becomes required for
   those files, or the rule is followed by hand. Written: it's followed by
   hand, as `AGENTS.md` ("Checks") says, and applies to changes to the
   suite too. The audio workflow isn't required.

How the effect sounds isn't part of this: listen after any change that can
affect it (`AGENTS.md`).

It doesn't cover either:

- a listen on the real sites with real songs, since YouTube's and Spotify's
  players (MSE, protected media, their own speed and track handling) are
  stood in for by a local page with steady tones;
- the popup and its permission prompts, which the suite skips;
- how the effect sounds (reverb, echo, EQ, width and saturation beyond a
  reverb tail being there), which nothing here judges;
- anything after the graph: the operating system's mixer and the speakers.

## Limits

- This is the graph's output, recorded inside the browser. It doesn't prove
  that sound reached a speaker, an operating-system mixer or the null sink.
  On Linux, the trial also records which streams the sound server reports
  during the first window (`sinkInputs`).
- A player is recorded only once a graph captures it. Before the effect
  first turns on, the song plays straight from the player, outside any
  graph, and nothing of that is recorded; the change from it to the graph is
  heard only from the graph's side. Once captured, the browser plays the
  player only through the graph, and the suite relies on that: after the
  extension is turned off, removed or updated, the song is recorded at its
  exact level, so none of it is missing, but sound the browser might play
  elsewhere isn't recorded.
- The observer adds nodes to the graph. Its effect on timing hasn't been
  measured against an uninstrumented recording, such as OS loopback.
- The recorder starts once its worklet has loaded, which can be after the
  first frames (up to 58 ms in so far). `firstContextFrame` records where
  recording began (before the native clock, it was the first block's raw
  number, which Chromium could give a block or more behind; see below).
  The suite's spans start after it, except for turning the effect on while
  a song plays, which fails unless the recording began before the sound
  did. Chromium's Spotify engine starts its sound 44 to 67 ms into the
  context, so before the suite recorded through a delay, that check failed
  as a measurement whenever the worklet was slow: on a hosted runner at
  `fb11c86` (recording began at 58 ms, the sound at 58 ms or before, in
  [workflow run 40718039127](https://github.com/sahinozan/slowed-and-reverb/actions/runs/40718039127)),
  and in 10 passing hosted runs the sound began 9 to 20 ms after the
  recording. The suite's recording delay (see "How it records") now covers
  a recorder up to 0.25 s late. One that takes longer misses the context's
  first frames, and the check then passes only if what it recorded begins
  in silence.
- **Firefox puts one frame of silence into the song** about 2 to 4
  seconds after a player that is already playing is routed into a graph,
  and that frame clicks (third difference 0.16 to 0.75). On this Mac, in
  Firefox 158.0.1, the inserted frame is shown by Firefox's own log and the
  recordings; why it is inserted is read from Firefox's source and agrees
  with every logged run, but no Firefox change has been built to confirm
  it. The engines turn the effect on exactly this way, and no change to
  them was found that avoids it safely. `firefox-capture-click.js`
  reproduces it with no extension.

  Firefox 159.0 still does it, on the same Mac with AirPods (2026-10-28,
  `firefox-capture-click.js` with saved recordings). At 0.8x, 7 of 10 runs
  slipped by one frame of the song (1.25 samples) 3.4 to 3.9 seconds in,
  and Firefox logged "insert silence=1" 7 times. At 1x, all 3 runs had a
  frame of exactly 0 about 3.2 seconds in. The `control` runs' own frame of
  silence was found every time, by the phase and as a click. But the click
  detector missed one of the 7 at 0.8x: the slip was there with no click
  over the threshold. So a run with no click isn't proof of no frame of
  silence, and the earlier 159 runs that found none, while Firefox logged
  one, don't show a fix. Firefox 159 didn't change the gap check or the
  rounding in the files read for this.

  While a player plays on its own, Firefox sends its sound to the output
  itself (its AudioSink). When a graph captures the player, Firefox stops
  that and feeds the graph instead (its DecodedStream). The AudioSink hands
  back the sound it hadn't played yet, timed backward from the next packet
  of the song, and the DecodedStream fills the time between where playback
  stood and that sound with silence: the gap of about 0.2 s at the routing
  (with this Mac's AirPods), which the engines' 250 ms of silence hides.
  Then each time more of the song arrives, it checks for a gap again by
  turning the times into whole microseconds and those into frames, rounding
  down both times (`CreateSilenceDataIfGapExists` in
  `dom/media/mediasink/DecodedStream.cpp`). A frame at 48 kHz lasts 20.83
  microseconds, so a time that isn't a whole number of microseconds loses a
  frame on the way. When the sound handed back starts at such a time and a
  later packet doesn't, the check finds a gap of one frame and fills it with
  one frame of silence. That happens in the first packet decoded after the
  routing, about 2 seconds of song past the end of what was queued then,
  which at the effect's speed comes 2 to 4 seconds later. In the modeled
  case, where the song keeps arriving in order after that one change, the
  count is then a frame ahead and the check finds no further gap; this
  doesn't show what happens after later seeks, track changes or other
  changes between the two ways of playing.

  With Firefox's log on (`MOZ_LOG=timestamp,MediaDecoder:5,AudioSink:4`),
  every late click came with "Detect a gap in audio, insert silence=1" from
  the DecodedStream, and the runs without one had no late click. In 9 logged
  sessions on this Mac (the reproducer, a page of its own, and the suite's
  check of turning the effect on, in both engines), the sizes of both
  silences Firefox logged match that arithmetic to the frame. At normal
  speed the recording has one frame of exactly 0 in both channels and the
  tone continues one sample later; at 0.8 it continues 1.25 samples later,
  one frame of the song slowed down, which is the move of about +1.2 the
  reproducer had measured. With `quiet`, the player never played through
  its AudioSink, nothing is handed back and nothing is filled. Whether it
  happens depends on how much of the song the output had taken by the
  routing: on this Mac the sound handed back was always a whole number of
  64-frame steps, and it clicked whenever that wasn't a multiple of 192
  frames (in 6 of the 9 logged sessions; the arithmetic gives 2 in 3).
  Only this Mac, its AirPods at 48 kHz and a 48 kHz WAV song were logged;
  other outputs, sample rates, the real sites' formats and other Firefox
  versions weren't. The hosted Firefox runs (157.0, on a null sink)
  haven't heard it in 8 checks of turning the effect on; why isn't known.

  The suite's check of turning the effect on now follows the tones' phase
  (see "How it measures"), so it finds the frame whether it clicks or not,
  and reports it in Firefox without failing. Run over the 138 recordings of
  that check kept from earlier runs (2026-10-23 to 28: 70 in Chromium, 68
  in Firefox, some kept twice), the scan found one slip in 15 Firefox
  recordings, 8 of them different, all on this Mac at 48 kHz: 1.25 samples
  on both tones, 2.1 to 3.5 seconds in. Each of the 6 different clicks
  those runs had failed on was where it placed the slip. It found nothing
  else, and no move of even 0.02 samples elsewhere, in either browser; none
  of the hosted Linux recordings had the frame. Fitting each tone alone, as
  the reproducer does, the other tone leaked into it and moved its phase by
  a quarter of a sample every 250 ms in a made-up recording, so the suite
  fits both. That the suite reports the frame without failing is the
  owner's choice for the suite's results; it isn't a decision to accept the
  frame in place of the listen (condition 2 under "What it can replace").

  No change to the extension was found that avoids it. Capturing a player
  before it plays would miss the effect being turned on during a song, and
  the Spotify engine waits for Firefox's encrypted-media setup on purpose;
  muting or seeking the page's player first would be seen by the page, and
  a mute would have to last about a second for the sound handed back to
  pass; capturing every player while the effect is off would change what
  turning it off means; hiding the click would take 2 to 4 seconds of
  silence or repairing the sound in a worklet. These are the reasons not to
  change the extension now, not proof that no workaround exists. A fix in
  Firefox looks likelier:
  its check could allow one frame of rounding, as Firefox's AudioSink
  already does (`AUDIO_FUZZ_FRAMES`), or compare the exact times. Neither
  has been built or tried in Firefox; only a model of the arithmetic
  shows them removing the late frame, and allowing one frame could also
  hide a real gap of one frame. The code
  is the same on Firefox's main branch as of 2026-10-24, and no Bugzilla
  report of it was found by its summary; a report has been drafted but not
  sent. Until Firefox changes, turning the effect on during a song in
  Firefox can click once a few seconds later. The suite's check of that
  records about 6 seconds and fails on it (in Firefox, 1 of 6 runs on
  YouTube and 4 of 6 on Spotify, then on Spotify in the whole-suite run at
  `117b822`; see "Suite results"), and it stays a failure, not a looser
  threshold, until Firefox is fixed or a decision accepts it. The suite's
  other checks turn the effect on before the song starts.
- **Two older clicks may be the same.** In 2 of the last 23 Firefox
  runs of `b4ca3c6`, one Spotify check heard a single click (0.32 and 0.35):
  one sample at exactly 0 in both channels, and two samples at about a
  third of their level. Both came about 3 seconds after the Spotify engine
  routed its playing player into its graph, as it does when a song starts.
  Their shape is consistent with the frame of silence above; their cause
  remains unconfirmed, since those runs kept no Firefox log. Routing a
  player as it starts to play, with no extension (`playing`), didn't click
  in 8 tries; one possible reason, not checked, is that the output hadn't
  taken any of the song yet, so whole packets were handed back, which by
  the arithmetic can't click.
  Other late clicks of the browsers' own, which `02ef174` noted (Firefox
  about 0.7 s after a change to 1.25x, Chromium about 1.2 s after keeping
  the pitch), haven't appeared in any recorded span: every frame of a span
  is checked, so they would fail it.
- Chromium asks before it removes an extension
  (`chrome.management.uninstall` and `developerPrivate.removeMultipleExtensions`
  both wait for a confirmation dialog), and the suite can't answer it. So in
  Chromium the extension removes itself, with
  `chrome.management.uninstallSelf({ showConfirmDialog: false })` called in
  its service worker. Chromium uninstalls it the same way, but the dialog and
  the Remove button aren't tested.
- Each page is in front while it is recorded. Firefox slows timers in
  background tabs, where the engines' 250 ms check may run later; that
  isn't measured.
- The local page stands in for YouTube and Spotify. Their real players
  (MSE, protected media, how they change tracks and speed) aren't used;
  Spotify's speed writes and its next song are imitated on the same
  `<audio>` element.
- The suite drives the extension through the background script's
  `queueTabApply`, skipping the popup and its permission prompts, as the
  trial does.
- Steady tones measure speed, pitch, routing and continuity, not how the
  effects sound. A click smaller than a step of 0.025 isn't heard by this
  measure.
- After a change of pitch with reverb on, a tone the effect shouldn't have
  is judged only from 2.4 s on (see "How it measures"). In the hosted
  Chromium run at `aaf240c`, the previous pitch measured 0.0215 at 400 ms
  after keeping the pitch, over the old limit of 0.02, with valid data and
  no click; earlier passing runs reached 0.015. On this Mac, in muted
  Chromium with the engine's random impulse response seeded, the tone
  played before measured 0.005 to 0.022 from 200 to 400 ms after keeping
  the pitch, letting it follow again or turning the effect back on, in 4
  seeds, and fell to 0.00005 or less by 1.6 s; with the same seed and the
  convolver's output disconnected it was 0.00008 or less from 200 ms on; a
  pitch mode that never changes, and a 396 Hz tone at 0.03 left playing
  from the change on, both failed (the second only in the stretch after
  the tail). A previous pitch that fades away by itself within 2 seconds
  for some other reason isn't told apart from the tail.
- The overlapping changes depend on the machine's timing: at least 3 of 7
  have to reach the engine mid-fade (20 to 45 ms after the one before, by
  the page's own log of what reached the engine), or the check fails as
  `not-overlapping`, a setup problem. The page sends them itself
  (`pageSweep` in `actions.js`), each only once the one before has reached
  the engine and timed from that arrival, so a Node side, page or
  background script that runs late delays the changes after it instead of
  sending them together. A page's timer can go off up to about a
  millisecond early by `performance.now()` (Chromium sent up to 0.7 ms and
  Firefox 1 ms early on this Mac, and Node up to 1.2 ms on a hosted
  runner), so the page checks the time again after each timer and waits
  out the rest, and stops sending if 5 timers in a row go off early.
  Until `5cdc0a7`, Node sent them on a fixed
  timetable, and a late Node side sent the overdue ones in a burst: in the
  hosted Firefox run of
  [workflow run 39919586145](https://github.com/sahinozan/slowed-and-reverb/actions/runs/39919586145)
  they reached the engine 116, 33, 10, 15, 11, 11 and 13 ms apart. A delay
  longer than the gaps still costs the gap it falls in; if fewer than 3
  are left, the check still fails as `not-overlapping`. A change that
  doesn't reach the engine within 1 s ends the changes as a `setup`
  problem; a driver that doesn't answer them within 10 s, as a
  measurement failure.
- Thresholds come from this Mac at 48 kHz (and the trial's hosted runs at
  44.1 kHz). The suite has run on a hosted Ubuntu runner at `e0d3f11`,
  before the stricter checks of `10665ea` (all 17 Chromium and 22 Firefox
  checks passed, in
  [workflow run 39910674712](https://github.com/sahinozan/slowed-and-reverb/actions/runs/39910674712)),
  and at `5cdc0a7`, with them (all 17 Chromium checks passed, and 21 of
  22 Firefox checks: the overlapping changes failed as `not-overlapping`,
  above, in
  [workflow run 39919586145](https://github.com/sahinozan/slowed-and-reverb/actions/runs/39919586145)).
  At `39fdb16`, with the paced changes, every sweep in both browsers had
  7 of 7 gaps within 20 to 45 ms. Firefox passed 22 of 22 and Chromium 15
  of 17: turning the effect on while a song plays failed as a measurement
  on both engines, because of the recorder's start (below), in
  [workflow run 39925123684](https://github.com/sahinozan/slowed-and-reverb/actions/runs/39925123684).
- Chromium sometimes gives the recorder a stale frame number around a
  change of connections at the destination (see "How it records"). The
  recorder takes such a block as the frame expected only in the pattern the
  native reproducer has shown (up to two blocks, then exactly the number
  expected), and only where the sound across it is unbroken; that rests on
  the reproducer, not on knowing why Chromium does it. A longer or other
  stale pattern fails as a measurement, even if Chromium could produce it
  harmlessly. A repeated block in a sound that repeats every 128 frames
  fails the same way, since it can't be told apart.
- When an AudioWorklet starts rendering in a Chromium context, the first
  block it is given can carry a frame number 256 frames behind on this Mac
  (512 on the hosted runner), and the next block the number expected after
  the real first one. This was first read as Chromium moving the context's
  frame number on after the first block, with a tone carrying on across the
  jump as if those frames were never rendered. The native clock and two
  known ramps (`recorder-first-block.js`, Chromium 156, muted, on this Mac
  with AirPods at 48 kHz) show what happens: in 10 of 24 runs at 48 and
  44.1 kHz the first block's number was 256 frames behind (once 512), while the native clock
  moved exactly one block between the first two blocks, a ramp playing
  from before the recorder started was unbroken from the first recorded
  sample on, and a ramp started at a known context frame was recorded
  exactly where the corrected numbers put it, in every run. The recorder
  from before the native clock counted the same pattern as a skipped block
  of 256 or 512 frames in 6 of 24 runs, over the same unbroken ramp. In
  Firefox 158 (18 runs, at both rates, with either recorder) the first block was at frame 0 and nothing needed correcting.
  Controls failed as they should: a ramp with a block planted missing and
  one planted twice broke exactly there (by +129 and -127 steps), and a
  native clock that was stopped or ran twice as fast made every block a
  fault. Before this, turning the effect on while a song plays failed in
  Chromium as a measurement whenever the jump came after the first block:
  on YouTube in 1 of 2 whole-suite runs on this Mac with the paced changes,
  on both engines in the hosted run at `39fdb16`, and on Spotify in the
  hosted run at `2878e3f` (512 frames after recording began at 2048). That
  hosted pattern is the one the first-block correction takes, and the
  hosted run at `f1f253e` took it once, on YouTube: the first block, numbered
  2048, was taken as 2560, with 128-frame blocks, no gap, fault or change of
  offset after it, and the check passed. The correction rests on the native clock and
  those reproducer runs, not on knowing every way Chromium can start a
  worklet; any other pattern stays a measurement failure.
- Windows runners weren't tried.

## Recommendation

**Measured:** recording real engine output works in both browsers, on a
Mac and on a hosted Ubuntu runner with a null sink, without new
dependencies or production changes. The regression suite catches each
audible defect the project has fixed when it is put back, in every engine
it was put back into. `b4ca3c6` passed 23 of 23 runs in Chromium and 20 of
23 in Firefox on this Mac, with one Firefox start failure and two
unexplained clicks on Spotify; it didn't record long enough after turning
the effect on during a song to hear Firefox's late click. `10665ea` does,
and fails in Firefox on it in most runs (see "Suite results").

On Firefox 159.0 on this Mac, Firefox's late frame of silence is still
there, and the click detector can miss it. One update check had an
unexplained 415 ms dropout (see "Limits" and "Suite results").

**Next:** meet the conditions still open in "What it can replace, and what
stays manual": a baseline with a fixed plan, Firefox's late click fixed in
Firefox or accepted in writing (it's present on 159), and the 415 ms
dropout explained or accepted. The Chromium gaps are covered, and the rule
for each change is written (`AGENTS.md`). Since the click detector can miss
Firefox's frame of silence, the check of turning the effect on now follows
the tones' phase too, and reports Firefox's frame. Until then the suite
stays out of the required check and the release, and the routine listen
after an engine change stays, with the release checklist
(`RELEASE-CHECKLIST.md`) before a store release.
