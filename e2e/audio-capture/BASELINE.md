# Baseline of the audio regression suite

This is the plan for the baseline that condition 1 of "What it can replace,
and what stays manual" in [README.md](README.md) asks for, and its results.
The plan was fixed on October 30, 2026, before the first run it counts. A
change to it is made here, with the reason, and doesn't count runs made
before it under rules they didn't have.

## A run

A run is one full run of the Chromium suite followed by one of the Firefox
suite (`npm run test:audio:chromium`, then `npm run test:audio:firefox`),
controls included, with no other browser tests meanwhile.

- **Hosted:** one start of the "Audio capture trial" workflow by hand
  (`workflow_dispatch`) on `main`. Its "Audio regression suite" job is the
  run. The trial job runs too; its result is recorded but not counted.
- **This Mac:** the two commands one after the other, from a clean checkout
  of the commit, with the Mac kept awake (`caffeinate -i`). Chromium runs
  muted (`AUDIO_REGRESSION_MUTE=1`): the trial found that the recorder gets
  the same samples either way. Firefox plays the tone aloud, so the owner is
  asked first, each time. Firefox runs with its media log on
  (`MOZ_LOG=timestamp,MediaDecoder:5,AudioSink:4`, with `MOZ_LOG_FILE` in
  the run's folder), so that a repeat of the 415 ms dropout (condition 3)
  is logged.

## Setups and counts

| Setup | Output | Browsers |
| --- | --- | --- |
| Hosted | GitHub's `ubuntu-latest` runner, PulseAudio null sink | Playwright's Chromium, the runner's Firefox |
| Mac, speakers | this Mac's built-in output | Playwright's Chromium, Firefox |
| Mac, AirPods | AirPods Pro | Playwright's Chromium, Firefox |

- Each setup needs 30 counted runs, which gives 30 per browser, over at
  least 5 separate days (Berlin time), with no more than 8 counted runs on
  one setup on any day.
- Of each setup's 30 Firefox runs, at least 10 are on Firefox's current
  version and at least 10 on its previous version, as they were on the day
  of the run. On October 30, 2026 those were 159.0 and 158.0.1. The hosted
  runner then had 158.0.1 (image `ubuntu26` 20261026.180.1). If its image
  doesn't move to the current version in time, the workflow gets a change
  to install that version. On this Mac, the version not installed comes from
  Mozilla's archive into a folder of its own and runs through `FIREFOX_BIN`.
  The installed Firefox and its profiles aren't touched.
- The output device and its sample rate are read before each Mac run
  (`system_profiler SPAudioDataType`). A run on another device than its
  setup's isn't counted.

## Which commits count

Runs are on `main`. A merge that changes anything the audio workflow runs
for (its `paths` list) starts every setup's count again for the runs after
it. A change to documentation only doesn't. The runs before are kept and
reported with their commit.

## Results and failures

- A run passes when both suites pass. On the hosted runner, that means
  both suite steps of the job succeed.
- Every failure is kept with its evidence and explained before that setup
  runs again. Then it is fixed, or accepted in writing here. A fix that
  changes what the workflow runs for starts the count again (see above).
  A run that passes later doesn't cancel a failure.
- A Firefox that doesn't start (`startupFailure` in its `environment.json`,
  no audio measured) gives no result. It is recorded, isn't counted either
  way, and the run is done again.
- Firefox's late frame (see "Limits" in the README) is reported, not failed.
  Each run records it for condition 2: in which checks, when, by how many
  samples, and whether it clicked.

## Records

Each run records:
- its setup, date and time, commit and, when hosted, its workflow run;
- the versions of Chromium, Firefox, Node and the system, and the runner's
  image (`environment.json`);
- the output device and sample rate;
- each suite's result, and every failing check with its problems;
- Firefox's late frame, as above;
- anything else unusual, such as the Mac being in use.

Hosted evidence is kept for 14 days by GitHub, so each run's files are
downloaded when it ends. Every run's evidence is kept by the owner. The
table below is brought up to date at least for each failure and when a
setup is done.

| Setup | Commit | Firefox | Runs | Passed | Failed | Not counted | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
