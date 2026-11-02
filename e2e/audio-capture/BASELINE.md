# Baseline of the audio regression suite

This is the plan for the baseline that condition 1 of "What it can replace,
and what stays manual" in [README.md](README.md) asks for, and its results.
The plan was fixed on October 30, 2026, and takes effect with the merge
that adds it: only runs after that merge, on its commit or later ones,
count. A change to the plan is made here, with the reason, and doesn't
count runs made before it under rules they didn't have.

## A run

A run is one full run of the Chromium suite followed by one of the Firefox
suite (`npm run test:audio:chromium`, then `npm run test:audio:firefox`),
controls included, with no other browser tests meanwhile.

- **Hosted:** the "Audio regression suite" job of one start of the "Audio
  capture trial" workflow by hand (`workflow_dispatch`) on `main`, with the
  Firefox release it is to run (see below). Only a run's first attempt
  counts: a rerun is recorded, not counted. The trial job runs too; its
  result is recorded but not counted. Runs are started one at a time and
  each is recorded before the next starts, because GitHub keeps only one
  waiting run in the workflow's concurrency group.
- **This Mac:** the two commands one after the other, from a clean checkout
  of `main`'s latest commit when the run starts, with the Mac kept awake
  (`caffeinate -i`). Chromium runs muted (`AUDIO_REGRESSION_MUTE=1`): the
  trial found that the recorder gets the same samples either way. Firefox
  plays the tone aloud, so the owner is asked first, each time. Firefox
  runs with its media log on (`MOZ_LOG=timestamp,MediaDecoder:5,AudioSink:4`,
  with `MOZ_LOG_FILE` in the run's folder), so that a repeat of the 415 ms
  dropout (condition 3) is logged.

A browser's suite is complete when Node's test runner reports its totals
with no test cancelled, skipped or left to do, and the suite's files
(`environment.json`, `summary.json` and each check's own file) are there,
from the run's commit and a checkout with no changes. A suite that isn't
complete, or whose files disagree with its result (a pass with problems
outside the controls, or with a check that couldn't finish), gives no
result.

## Setups and counts

| Setup | Output | Browsers |
| --- | --- | --- |
| Hosted | GitHub's `ubuntu-latest` runner, PulseAudio null sink | Playwright's Chromium, the runner's Firefox |
| Mac, speakers | this Mac's built-in output ("MacBook Pro Speakers") | Playwright's Chromium, Firefox |
| Mac, AirPods | AirPods Pro | Playwright's Chromium, Firefox |

- Each setup needs 30 counted runs, which gives 30 per browser, over at
  least 5 separate days, with no more than 8 counted runs on one setup on
  any day. A run's day is the date in Berlin when its Chromium suite
  started. Runs over the 8 are recorded, not counted.
- Firefox's versions are its major releases (158.0.1 is 158). When a setup
  reaches 30, at least 10 of its Firefox runs must be on the newest major
  release then and at least 10 on the one before. Runs on an older one still
  count among the 30, but not toward either 10. On October 30, 2026 the two
  were 159 and 158, and Mozilla planned 160 for November 6. Hosted runs
  choose their release with the workflow's `firefox` input, which installs
  it from Mozilla's archive (the runner's own was 158.0.1, on image
  `ubuntu26` 20261026.180.1). On this Mac, a release other than the
  installed one comes from Mozilla's archive into a folder of its own and
  runs through `FIREFOX_BIN`. The installed Firefox and its profiles aren't
  touched.
- The hosted runner's image versions are pooled and recorded. A new Ubuntu
  release under `ubuntu-latest` starts the hosted count again.
- The Mac's output device and its sample rate are read before and after
  each Mac run (`system_profiler SPAudioDataType`) and saved with it. A run
  doesn't start on another device than its setup's, and one that played on
  another isn't counted.

## Which commits count

A merge that changes anything the audio workflow runs for (its `paths`)
starts every setup's count again for the runs after it. A change to
documentation only doesn't. The runs before are kept and reported with
their commit. A run on a commit that isn't on `main` (a branch, or a pull
request's runs) isn't counted, even if the commit is merged later.

## Results and failures

- A run passes when both suites are complete and pass.
- A run with a failure, or a suite that gives no result, needs an
  explanation before that setup runs again, and is kept with its evidence.
  The explanation is recorded with what follows from it:
  - **fixed:** the run isn't counted, and a fix that changes what the
    workflow runs for starts the count again (see above);
  - **accepted:** the failure is accepted in writing here. A run whose
    suites were both complete then counts among the 30, as a failure.
  - **explained:** a suite that gave no result, explained (a runner's
    fault, say). It isn't counted.
- A run that passes later doesn't cancel a failure.
- A Firefox that doesn't start (`startupFailure` in its `environment.json`)
  gives no result for Firefox. The run isn't counted, and is done again.
  The Chromium suite's result in it stands: if Chromium failed, that needs
  an explanation first, like any failure.
- Firefox's late frame (see "Limits" in the README) is reported, not failed.
  Each run records it for condition 2: in which checks, when, which tones
  moved by how much, and whether the click there was the frame's.

## Records

Each run records:
- its setup and day, when each suite started and ended, its commit, and,
  when hosted, its workflow run and attempt;
- the versions of Chromium, Firefox, Node and the system, and the runner's
  image (`environment.json`);
- on this Mac, the output device and its sample rate, and the media log;
- each suite's test totals and result, and every failing test, check with
  problems, and check that couldn't finish;
- Firefox's late frame, as above;
- anything else unusual, such as the Mac being in use.

Hosted evidence is kept for 14 days by GitHub, so each run's files and log
are downloaded when it ends. Every run's evidence is kept by the owner,
with the tools that record and count the runs under these rules. The table
below is brought up to date at least for each failure and when a setup is
done.

| Setup | Commit | Firefox | Runs | Passed | Failed | Not counted | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hosted | `4c8f568` | 159.0 | 6 | 6 | 0 | 0 | October 30, 2026; no late frame |
| Hosted | `4c8f568` | 158.0.1 | 6 | 6 | 0 | 0 | October 31; no late frame |
| Mac, AirPods | `4c8f568` | 159.0 | 1 | 0 | 1 | 1 | October 31. Chromium (muted) passed. In Firefox, the `02ef174` control wasn't caught as it should be: on YouTube, turning the effect off didn't click, because the switch fell where the wave crossed 0 (a step of 0.023, under the 0.05 threshold); it clicked 14 times elsewhere there, and 13 times on Spotify, turning off included. Fixed: the control now asks for a click when the effect turns off or when it turns on, not both. The fix changes what the workflow runs for, so every setup's count starts again after it; these 13 runs stay on record under `4c8f568`. Videos were playing in another browser on the Mac. |
