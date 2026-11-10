---
name: mac-audio-run
description: Steps for running the audio regression suites on the owner's Mac for a pull request, which is the audio-mac check. Chromium runs muted. Firefox plays a tone aloud, so the owner is asked first. Use when npm run checks:for lists audio-mac, when asked for the Mac audio runs, or before asking to merge a change to the audio engines, the content scripts or the audio suite.
---

# The audio suites on the Mac

`npm run checks:for` says whether a change needs `audio-mac`. The rule for
merging is in `AGENTS.md` ("Checks"); how the suites record and what they
check is in `e2e/audio-capture/README.md`. These are the steps.

## Before the runs

1. The pull request is on its final commit, with the branch up to date with
   `main`. A commit pushed after the runs needs runs of its own, so finish
   the review's changes first.
2. Look at the pull request's "Audio suites" workflow: both jobs passed on
   that commit, none skipped or canceled. It isn't a required check, so it
   doesn't show in the merge box by itself.
3. Nothing else is running browser tests on the Mac, in this session or in
   another. The suites run one at a time.
4. Playwright's Chromium is installed
   (`npx playwright install --no-shell chromium`, once).

## Chromium, muted

```sh
AUDIO_REGRESSION_MUTE=1 npm run test:audio:chromium
```

About 5 minutes. Muted, it records the same samples and plays nothing, so
it needs no question first. Never run it without `AUDIO_REGRESSION_MUTE=1`
unless the owner asked for the sound.

## Firefox, after the owner says yes

Firefox can't be muted: turning the effect on during a song plays the tone
aloud for about a second.

1. Read which sound output the Mac is using
   (`system_profiler SPAudioDataType`, the device marked as the default
   output).
2. Ask the owner, with the question tool, whether to start now. Say that
   the run takes about 5.5 minutes and plays a tone aloud, and name the
   output. An earlier yes doesn't count for a later run.
3. After the yes:

```sh
npm run test:audio:firefox
```

`FIREFOX_BIN` chooses another Firefox.

## After each run

- The evidence is in `test-results/audio-regression/<label>/`, the label
  being `chromium-mute-audio` or `firefox`: `summary.json` has each check's
  problems, and `environment.json` the versions.
- A failure is kept with its evidence and explained before anything runs
  again. Then it is fixed, or accepted in writing in the pull request. A run
  that passes later doesn't cancel it, and an accepted failure still needs a
  passing run before the merge.
- Firefox's late frame in `e2e/audio-capture/README.md` ("Limits") is
  reported without failing the run. Note it; it isn't a failure.

## Record it

In the pull request's "Audio and listening" part: the commit, each
browser's version, the output Firefox played through, and each run's
result, failed ones included. The suites don't replace the listen: if
`npm run checks:for` also lists `listen`, that is the owner's, with music.
