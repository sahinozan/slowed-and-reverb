# Audio capture

The browser tests check settings, playback speed and the gains the engines
aim for, but never the sound. This folder records the engines' real output
in Chromium and in Firefox:

- **The regression suite** (`*-regression.js`) records the engines without
  a gap through the changes that have gone wrong before, and has to catch
  each defect the project has fixed when it is put back into a copy.
- **The trial** (`*-trial.js`) checks the recorder itself: known native
  signals, controls that must fail, and Chromium's `--mute-audio` check.

Neither is part of `npm test`, `npm run check`, CI's required check or
`npm run release`; when to run them is in `AGENTS.md` ("Checks"). Measured
results and the history of the suite's investigations are on the owner's
Notion page "Slowed & Reverb: audio suite history and results", and in this
README's longer form in git at `c61a674`.

## Run them

```sh
npx playwright install --no-shell chromium   # once, as for npm run test:e2e
npm run test:audio:chromium                  # the suite in Playwright's Chromium, about 5 minutes
npm run test:audio:firefox                   # the suite in the installed Firefox, about 5.5 minutes
npm run test:audio-trial:chromium            # the trial in Chromium, about 1 minute
npm run test:audio-trial:firefox             # the trial in Firefox, about 45 seconds
```

Run one at a time, with no other browser tests, on a sound device (on
Linux, a PulseAudio or PipeWire sink).

- `FIREFOX_BIN` chooses another Firefox, as for `npm run test:firefox`.
- `AUDIO_REGRESSION_MUTE=1` mutes the Chromium suite, which records the
  same samples either way. Firefox can't be muted: turning the effect on
  during a song plays the tone aloud for about a second.
- `AUDIO_REGRESSION_EVIDENCE=compact` keeps only the sound around
  problems; `AUDIO_TRIAL_WINDOWS` (1 to 10) sets the trial's windows.

Three reproducers, with no extension, show browser behavior the suite has
to live with; each file's header lists its options, and
`MOZ_LOG=timestamp,MediaDecoder:5,AudioSink:4 MOZ_LOG_FILE=<path>` adds
Firefox's own media log:

```sh
node e2e/audio-capture/firefox-capture-click.js 6                # Firefox's late frame (see "Limits"); plays aloud unless given quiet
node e2e/audio-capture/chromium-stale-frame.js 4                 # Chromium's stale frame numbers (see "How it records")
node e2e/audio-capture/recorder-first-block.js chromium 12 48000 # where the recorder's first block falls (see "How it records")
```

## In CI, and the evidence

`.github/workflows/audio-capture-trial.yml` ("Audio suites") runs for pull
requests that change what the suites load, and twice a night on `main` for
[BASELINE.md](BASELINE.md). Each browser's job starts a PulseAudio null
sink, runs the suite, then the trial, and uploads the evidence whatever
happened (`tests/audio-workflow.test.js` checks its deadlines and
conditions). Runs on `main` can install a Firefox release from Mozilla's
archive, checked against Mozilla's pinned key.

The suite writes to `test-results/audio-regression/<browser>/` (about
6 MB), the trial to `test-results/audio-trial/<browser>/`:
`environment.json` (commit, versions, engine hashes, thresholds, and
`startupFailure` if the browser didn't start), `summary.json` (each check's
problems and margins, each control's codes), `<check>.json` and
`<check>-<n>.wav` (every action, click and silence, with excerpts),
`<check>-failed.json` for a check that couldn't finish, and
`firefox-launch.txt`.

## How it records

`capture-observer.js` runs in the page before any of its scripts and
replaces the `destination` of each audio context with a gain node that
feeds `recorder-worklet.js`, then a gain of 0, then the real destination.
The engines run unchanged, and almost nothing is heard. The suite's
recorder listens through a 0.25 s delay, so a worklet that loads late still
records the context from its first frame. The test song is a pair of
steady tones (440 Hz left, 660 Hz right, each at 0.25) served from
127.0.0.1 for YouTube and localhost for Spotify, and the page drives a
disposable copy of the extension (`harness.js`) through its background
script, skipping the popup and its prompts.

Every recorded block carries its frame number, and a native clock (an
AudioParam ramp) confirms how far the context moved. Lost, dropped or
skipped frames, a stalled clock or a frame number out of step make a span
invalid data: a measurement failure, never a sound result. Chromium
sometimes repeats a frame number once or twice around a change of
connections (`staleFrameLabels`), and can number a worklet's first block
a block or more behind (`initialFrameLabel`); the recorder accepts exactly
those patterns, where the native clock and the sound confirm them.

## What it checks

`regression.js` defines the checks and `metrics.js` the measurements
(`tests/audio-metrics.test.js` and `tests/audio-continuity.test.js` check
them without a browser). In each browser and engine, the suite checks:
speed, pitch and reverb as heard; turning the effect on while a song plays;
changes while it plays, including overlapping ones; Spotify's own speed
resets, a seek and the next song; turning the extension off and on;
removing it; and an update keeping the previous engine off until a reload.

- **A click** is a third difference above 0.05 in either channel (a step of
  -32 dBFS); **a gap**, 5 ms blocks below -80 dBFS. Each action may cause
  only the engines' own fades and dips.
- After the extension is turned off, removed or updated, the song itself
  has to be back within 1 second, at its exact level, with nothing else.
- Turning the effect on during a song also follows the tones' phase, to
  find a frame of silence that doesn't click.

The historical defects, listed in `history.js`, are each put back into a
copy: the check that should hear one has to fail, with the problems listed,
in every engine it was put back into. A new audible defect gets an entry
there (`AGENTS.md`).

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

- **Firefox's late frame.** About 1 to 4 seconds after a playing player is
  routed into a graph, as the engines do when the effect turns on during a
  song, Firefox puts one frame of silence into the song, often with a click
  (third difference 0.16 to 0.75). It comes from rounding in Firefox's
  `CreateSilenceDataIfGapExists` (`dom/media/mediasink/DecodedStream.cpp`).
  No extension change avoids it safely. In Firefox the suite finds it by the
  tones' phase from 1 second in, reports it as "Firefox's late frame", and
  doesn't fail on it or on a click there; any other slip or click fails.
  `firefox-capture-click.js` reproduces it.
- It records the graph's output inside the browser, not what reached a
  speaker. Background tabs and Windows aren't tried.
- In Chromium the extension removes itself (`uninstallSelf`), because
  Chromium asks before removing an extension and the suite can't answer.
- The overlapping changes depend on the machine's timing: at least 3 of 7
  have to reach the engine 20 to 45 ms apart, or the check fails as a setup
  problem (`not-overlapping`).
- After a change of pitch with reverb on, a tone the effect shouldn't have
  is judged only after the 2-second reverb tail.
