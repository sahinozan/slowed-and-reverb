# Audio capture

The browser tests check settings, playback speed and the gains the engines
aim for, but never the sound. This folder records the engines' real output
in Chromium and in Firefox:

- **The regression suite** (`*-regression.js`) records the engines without
  a gap through the changes that have gone wrong before, and has to catch
  each defect the project has fixed when it is put back into a copy.
- **The trial** (`*-trial.js`) checks the recorder itself: known native
  signals, controls that must fail, and Chromium's `--mute-audio` check.

Neither is part of `npm test`, CI's required check or releases; when to
run them is in `AGENTS.md`. Measured results and the investigations behind
them are on the owner's Notion page "Slowed & Reverb: audio suite history
and results", and in this README's longer form at `c61a674`.

## Run them

```sh
npx playwright install --no-shell chromium   # once, as for npm run test:e2e
npm run test:audio:chromium                  # the suite in Playwright's Chromium, about 5 minutes
npm run test:audio:firefox                   # the suite in the installed Firefox, about 5.5 minutes
npm run test:audio-trial:chromium            # the trial in Chromium, about 1 minute
npm run test:audio-trial:firefox             # the trial in Firefox, about 45 seconds
```

Run one at a time, with no other browser tests, on a sound device
([docs/testing.md](../../docs/testing.md#a-sound-device)).

- `FIREFOX_BIN` chooses another Firefox, as for `npm run test:firefox`.
- `AUDIO_REGRESSION_MUTE=1` mutes the Chromium suite, which records the
  same samples either way. Firefox can't be muted: turning the effect on
  during a song plays the tone for about a second through the machine's
  sound output. On the owner's Mac it runs through the muted speakers with
  Bluetooth off (the `mac-audio-run` skill, and "Limits" for why).
- `AUDIO_REGRESSION_EVIDENCE=compact` keeps only the sound around
  problems; `AUDIO_TRIAL_WINDOWS` (1 to 10) sets the trial's windows.

Three reproducers, with no extension, show browser behavior the suite has
to live with; each file's header lists its options:

```sh
node e2e/audio-capture/firefox-capture-click.js 6                # Firefox's late frame (see "Limits"); plays aloud unless given quiet
node e2e/audio-capture/chromium-stale-frame.js 4                 # Chromium's stale frame numbers (see "How it records")
node e2e/audio-capture/recorder-first-block.js chromium 12 48000 # where the recorder's first block falls (see "How it records")
MOZ_LOG=timestamp,MediaDecoder:5,AudioSink:4 MOZ_LOG_FILE=media.log node e2e/audio-capture/firefox-capture-click.js 6  # with Firefox's media log
```

## In CI, and the evidence

`.github/workflows/audio-capture-trial.yml` ("Audio suites") runs for pull
requests that change what the suites load, and twice a night on `main` for
[BASELINE.md](BASELINE.md). Each browser's job starts a PulseAudio null
sink, runs the suite, then the trial, and uploads the evidence whatever
happened (`tests/audio-workflow.test.js` checks its deadlines). Runs on
`main` can install a Firefox release from Mozilla's archive, checked
against Mozilla's pinned key.

Evidence goes to `test-results/audio-regression/<label>/` (the suite) and
`test-results/audio-trial/<label>/` (the trial), the label being
`chromium`, `chromium-mute-audio` or `firefox`: `environment.json`
(versions, engine hashes, thresholds, `startupFailure`), and for Firefox
`firefox-launch.txt`. The suite adds `summary.json` (each check's problems
and margins, each control's codes), `<check>.json` and `<check>-<n>.wav`
(every action, click and silence, with excerpts) and `<check>-failed.json`
for a check that couldn't finish; the trial, `<case>-w<n>.json` and `.wav`
per window and, in Chromium, `comparison.json` for `--mute-audio`.

## How it records

`capture-observer.js` runs in the page before any of its scripts and
replaces the `destination` of each audio context with a gain node that
feeds `recorder-worklet.js`, then a gain of 0, then the real destination.
The engines run unchanged, and almost nothing is heard. The suite's
recorder listens through a 0.25 s delay, so a worklet that loads within
that delay still records the context from its first frame; a check that
must start in silence fails as `onset-not-observed` otherwise. The test
song is a pair of steady tones (440 Hz left, 660 Hz right, each at 0.25)
served from 127.0.0.1 for YouTube and localhost for Spotify, and the page
drives a disposable copy of the extension (`harness.js`) through its
background script, skipping the popup and its prompts.

The observer also stands in for the two members of an audio context that
give its output latency (the latency itself, and the output timestamp,
which reads it in Firefox). In Firefox 160.0 on Linux with PulseAudio that
read can stop the page for good (issue 186). A read of the latency, or a
call for the timestamp, is recorded as an error, which fails the check as
`observer-error`, and never reaches the browser's own; taking the method
without calling it reads nothing. `tests/output-latency.test.js` keeps both
names out of the files; this is for a read that never writes the name, such
as a loop over every property of a context.

Every recorded block carries its frame number, and a native clock (an
AudioParam ramp) confirms how far the context moved. Lost, dropped or
skipped frames, a stalled clock or a frame number out of step make a span
invalid data: a measurement failure, never a sound result. Chromium
sometimes repeats a frame number once or twice around a change of
connections (`staleFrameLabels`), accepted only where the sound across
them has no step and doesn't repeat a block. It can also number a
worklet's first block a block or more behind; the recorder corrects that
one number (`initialFrameLabel`) where the native clock confirms it.

## What it checks

`regression.js` defines the checks and `metrics.js` the measurements
(tested without a browser in `tests/audio-*.test.js`): speed, pitch and
reverb; turning the effect on during a song; changes while it plays;
Spotify's speed resets, a seek and the next song; and turning the
extension off, removing and updating it.

- **A click** is a third difference above 0.05 in either channel (a step of
  -32 dBFS); **a gap**, 5 ms blocks below -80 dBFS. An action may cause only
  the engines' own fades and dips. Turning the effect on during a song also
  follows the tones' phase, to find a frame of silence that doesn't click.
- After the extension is turned off, removed or updated, the song itself
  has to be back within 1 second, at its exact level, with nothing else.

Each historical defect in `history.js` is put back into a copy, and the
check that should hear it has to fail as listed, in every engine it was put
back into. A new audible defect gets an entry there. One this song can't set
off gets a silent test of its own with a control: the limiter turning loud
treble down in Firefox is checked by `e2e/ui/limiter.spec.js`, which renders
the limiter offline in both browsers, and so is the limiter turning a loud
song down at every kick drum when Bass was turned up.

### What it can replace, and what stays manual

It never covers how the effect sounds (reverb, echo, EQ, width and
saturation), the real sites' players or the popup: those stay a listen.
It can replace the listen for clicks, gaps and the sound coming back only
once all of these hold; until then, run it and listen too:

1. The baseline in [BASELINE.md](BASELINE.md): 30 full runs per browser on
   each setup, every failure explained.
2. Firefox's late frame fixed in Firefox, or accepted in writing. The suite
   reports it without failing (see "Limits").
3. The 415 ms dropout once seen in a Spotify update check on Firefox 159
   explained from a run with Firefox's media log on, or accepted in writing.
4. Removing the extension and Spotify updates checked in Chromium. Done.
5. A rule that both suites pass on a pull request's final commit. Written:
   followed by hand (`AGENTS.md`); the audio workflow isn't required.

## Limits

- **Firefox's late frame.** About 2 to 4 seconds after a playing player is
  routed into a graph, as the engines do when the effect turns on during a
  song, Firefox puts one frame of silence into the song, often with a click
  (third difference 0.05 to 0.79). It comes from rounding in Firefox's
  `CreateSilenceDataIfGapExists` (`dom/media/mediasink/DecodedStream.cpp`).
  No safe extension workaround has been found. In Firefox the suite takes
  the first slip between 0.335 and 5 seconds in where every tone moves by
  one frame of the song (within 0.2 samples), reports it as "Firefox's late
  frame", and doesn't fail on it or on a click within that slip's stretch
  and 5 ms either side, so an extension click that close passes too. Any
  other slip or click fails. `firefox-capture-click.js` reproduces it.

  The frame is early in a recording when the sound output is slow to
  start. While the output starts, Firefox runs the graph on a clock of its
  own and the song goes through it, and the recording begins with the
  output's first sound, so the frame comes that much sooner in it. On this
  Mac in Firefox 160.0 (November 16, 2026, 104 checks), the speakers took
  0.08 to 0.14 seconds and the frame was 2.4 to 3.8 seconds in; AirPods Pro
  took 1.1 to 1.8 seconds and it was 1.5 to 2.2 seconds in, and once, on
  November 13, 0.79 seconds in. A check's record has how long its output
  took: `firstArrivalMs` less `createdAtMs` in `snapshots.start`. The scan
  starts at 0.3 seconds and takes a frame from about 0.4 seconds in, where
  it has enough of the tones before it. A frame between 0.25 and 0.4
  seconds in, which an output slower than about 1.7 seconds could give,
  can still fail the check: when it clicks, or when the scan finds a slip
  it can't take as the frame. Before 0.25 seconds the frame is in the
  engine's silence, and nothing is heard or found.

  No scan tried closes that gap. Each kept frame was put at these places in
  made-up recordings (the real sound, started later, with the engine's
  silence and fade) and scanned (November 16, 2026). Starting the scan at
  0.25 seconds, letting a slip count as the frame from 0.25 or 0.275
  seconds, and taking a slip with one or two windows of the tones before
  it, not five, takes every frame from 0.32 to 0.34 seconds, but a frame
  in the fade or the first 45 ms of the tones has nothing before it to
  measure. It would also let a slip in the engine's own start pass as the
  frame, and let one odd window decide, in every run. So the scan is
  left as it is, and the Mac's Firefox run goes through the muted speakers
  with Bluetooth off (the `mac-audio-run` skill), where no start-up
  measured has brought the frame within 2 seconds of the gap.
- It records the graph's output inside the browser, not what reached a
  speaker; the song before the effect first turns on isn't recorded, and
  the observer's nodes haven't been compared with an uninstrumented
  recording. Background tabs and Windows aren't tried.
- In Chromium the extension removes itself (`uninstallSelf`), because
  Chromium asks before removing an extension and the suite can't answer.
- At least 3 of the 7 overlapping changes have to reach the engine 20 to
  45 ms apart, or the check fails as a setup problem (`not-overlapping`).
- After a change of pitch with reverb on, a tone the effect shouldn't have
  is judged only after the 2-second reverb tail.
