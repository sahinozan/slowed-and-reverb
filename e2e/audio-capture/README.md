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
runs.

Almost nothing is heard: the recording ends in a gain of 0, and the
YouTube engine captures the player before it starts. A few exceptions
remain. The Spotify engine captures the player only once it plays, so a few
milliseconds can reach the speakers first. The trial's muted-player control
plays nothing audible. The suite's checks of turning the effect on while a
song plays (and the reproducer `firefox-capture-click.js`) play the tone
aloud for about a second first, since the song has to be playing before the
effect turns on.

Two reproducers, which aren't tests and need no extension, show browser
behavior the suite has to live with:

```sh
node e2e/audio-capture/firefox-capture-click.js 6   # Firefox's own click after a playing player is routed into a graph (see "Limits")
node e2e/audio-capture/chromium-stale-frame.js 4    # Chromium's stale frame numbers, and that the sound across them is unbroken (see "How it records")
```

On Linux the trial expects a PulseAudio (or PipeWire) sound server. The
workflow `.github/workflows/audio-capture-trial.yml` sets one up with a
null sink:

```sh
sudo apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=audio_trial
pactl set-default-sink audio_trial
```

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
  and around each problem, 16-bit stereo.
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

Around a change of connections at the destination, Chromium sometimes gives
the recorder a block with the previous block's frame number and then
catches up. A steady tone recorded across such blocks, with no extension
involved, has no click, which a repeated or missing 128-frame block would
make, so the recorder counts these separately (`staleFrameLabels`) and
takes each as the frame expected. Only a jump forward is a skipped block.
`gapLog` keeps where the first few of either happened.

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
Firefox also runs with `--remote-allow-system-access`, as
`npm run test:firefox` does, so the suite can turn the extension off and on
through Firefox's add-on manager.

### What it checks

Each check records one span of a page's audio, without a gap, while it acts
the way a person, the page or the browser would. In both browsers, with
both engines unless the table says otherwise:

| Check | What happens while it records | What has to be heard |
| --- | --- | --- |
| Speed, pitch and reverb as heard | 0.8x with the pitch following, then kept; the song stopped with no reverb, then with reverb 60 | 352 and 528 Hz on the left (440 and 660 Hz with the pitch kept), nothing on the right, the player at 0.8x; silence after a song without reverb, a tail after one with it |
| Turning the effect on while the song plays | The song plays without the effect, then the effect turns on, which creates the audio context | The recording starts in silence (so the change was heard from its start), only the engines' own silence before the sound comes in, no click, then the effect |
| Changes while the song plays | Reverb 40, pan to the middle, speed 0.9, eight pan changes sent 30 ms apart as when a slider is dragged, keeping the pitch and letting it follow again, the effect off and on | No click; silence only where the engine fades out to hide a change of the player; the right tones, channels and speed after each change; the song itself, at its exact level, with the effect off |
| Spotify's own speed changes (Spotify only) | Spotify sets the player back to normal speed three times, holds it at 0 for a seek, asks for normal speed 5 ms into a change that is waiting to fade out, and plays the next song on the same player, then asks for normal speed again | No click or silence during the resets, and the player's speed never changes; the effect's speed after the seek and on the next song; the song itself, playing, once the effect is off |
| Turning the extension off and on in the browser | From the extensions page in Chromium, Firefox's add-on manager in Firefox; on YouTube, with the extension off, the page takes its player out, puts it back and plays it at 1.25x; then the extension and the effect come back on | The song itself, at its exact level, within a second, with no click; the page's own 1.25x afterwards; the effect again once it's turned back on, except Spotify in Chromium, which needs a reload (Chromium doesn't put Spotify's scripts back into an open tab), so it stays unchanged and the reloaded page has the effect |
| Removing the extension (Firefox only) | Removed through WebDriver BiDi, as from the add-ons page | As when turned off |
| An update keeps the previous engine off (YouTube in both, Spotify in Firefox) | An earlier version's copy (every script's `VERSION` and the manifest at 0.0.1) is updated to this one: in Chromium as a developer's reload from chrome://extensions, in Firefox as a second temporary install. On Spotify, the extension is then turned off and on, which puts the new bridge next to the old engine. Then the effect is asked for | The song itself within a second of the update, and still after asking for the effect, which is refused as `outdated`; the reloaded page has the effect |

Turning the effect off in the popup, turning the extension off in the
browser and removing it are different actions here: the first is the
extension's own message, the other two the browser's. The suite doesn't
call the engines' internal shutdown directly in place of either.

### How it measures

Every action is marked on the audio context's clock just before it starts
and just after it is done, and each mark is mapped to the recorded frame
played at that moment (see "How it records"). Nothing an action causes can
be heard before its first mark. A span starts once the recorder is running
and has recorded at least 100 ms before every action, so no transition is
cropped. Turning the effect on while a song plays creates the context, so
that span starts with the recording itself, which has to begin in silence
(`onset-not-observed` otherwise). A span is valid data only if the
context ran throughout, no frame was lost, dropped or skipped since it
started (or since the recording started, for a span that starts with it),
recorded frames equal the context frames they span, every sample is a
number and nothing outside the check paused the player. Any of those fails
the check as a measurement failure, and says so, never as a sound
problem; a control that fails that way doesn't count as caught.

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
  25 ms fade, plus 60) and 150 ms in Chromium. Only the page's own actions
  that stop the song (pausing it, a seek, taking the player out, the next
  song) may click, and be silent for as long as the action took plus
  150 ms. Clicks and silence count as an action's if they start between
  its first mark and 300 ms after its last (1.5 s for turning the
  extension off, removing or updating it, which the engines notice within
  their 250 ms check). Anything else fails, as `click` or `gap`.
- Steady stretches between actions, from 400 ms after one action for
  600 ms, are checked for the tones expected in each channel (within 3% of
  their frequency), for silence where there should be none, and for the
  player's speed within 15%. The effect's tones may be 0.1 to 0.5 (the
  compressor raises a tone of 0.25 to 0.287, and reverb adds copies at
  other phases), and the tones it shouldn't have under 0.02; the song
  itself has to be 0.24 to 0.26, with under 0.005 of the other tone.
- After turning the extension off, removing or updating it, the unchanged
  sound has to be back within 1 second: every 10 ms of the right channel
  from then on carries the song's own tone, which the effect, panned left,
  doesn't.

`tests/audio-continuity.test.js` checks these measurements with computed
signals, without a browser: planted steps, a gain set straight away and a
two-sample dropout are clicks; the engines' fades, a crossfade and the
loudest steady tones aren't; silence fails unless an action allows that
much; and a message that reaches the page late isn't missing audio, while
a lost or skipped frame is.

### Historical defects as controls

Each audible defect the project has fixed is put back into a disposable
copy (`history.js`), and the check that should hear it runs against that
copy. The control passes only if the check fails with the problem listed,
at the action or steady stretch listed, and with no recording or setup
problem. The engines have changed since, and their old files report no
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
runner. The evidence of every failed run is kept outside the repository by
the run that made it; `chromium-stale-frame.js` and
`firefox-capture-click.js` reproduce the browser behavior behind them.

### What it can replace, and what stays manual

The suite now hears, in both browsers, what the final listen after an
engine change was for: the speed and pitch, the effect being there, clicks
and gaps when settings change, Spotify's own speed changes, and the sound
coming back unchanged when the effect or the extension is turned off,
removed or updated. Each of the defects the project has shipped and fixed
is caught when put back.

It doesn't replace:

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
  first frames (up to 46 ms in so far). `firstContextFrame` records where
  recording began. The suite's spans start after it, except for turning
  the effect on while a song plays, which fails unless the recording began
  before the sound did.
- **Firefox clicks on its own** (third difference 0.16 to 0.36) 3 to 4
  seconds after a player that is already playing is routed into a graph and
  its speed or pitch mode changes, in a third to a half of tries. (It also
  clicks about 0.2 s after the routing, which the engines' 250 ms of
  silence hides.)
  `firefox-capture-click.js` reproduces it with no extension. Turning the
  effect on while a song plays does exactly this, so a person may hear it;
  the engines don't hide it. The suite's check of that action ends about
  1.4 seconds after it, and its other checks turn the effect on before the
  song starts, so the suite doesn't hear this click. It needs a decision,
  not a looser threshold.
- **Two clicks are unexplained.** In 2 of the last 23 Firefox runs, one
  Spotify check heard a single click (0.32 and 0.35): one sample at
  exactly 0 in both channels, and two samples at about a third of their
  level. Both came about 3 seconds after the Spotify engine routed its
  playing player into its graph, as it does when a song starts. Their shape
  can't come from the engines' own changes, which fade over 10 to 25 ms,
  and resembles Firefox's click above, but routing a player as it starts
  to play, with no extension, didn't click in 8 tries. They count as
  failures; their cause is open. Other late clicks of the browsers' own, which
  `02ef174` noted (Firefox about 0.7 s after a change to 1.25x, Chromium
  about 1.2 s after keeping the pitch), haven't appeared in any recorded
  span: every frame of a span is checked, so they would fail it.
- Chromium can't remove an extension without a confirmation dialog
  (`chrome.management.uninstall` and `developerPrivate.removeMultipleExtensions`
  both wait for one), so removal is checked only in Firefox. Spotify after
  an update is checked only in Firefox; in Chromium it needs a reload, as
  after turning the extension back on, which is checked.
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
- The overlapping changes depend on the machine's timing: at least 3 of 7
  have to reach the engine mid-fade, or the check fails as
  `not-overlapping`, a setup problem.
- Thresholds come from this Mac at 48 kHz (and the trial's hosted runs at
  44.1 kHz). The suite hasn't yet run on a hosted runner at the time of
  writing.
- Chromium sometimes gives the recorder a stale frame number around a
  change of connections at the destination (see "How it records"). The
  recorder takes such a block as the frame expected; that rests on the
  native reproducer, where a steady tone across those blocks is unbroken,
  not on knowing why Chromium does it.
- Before a span, a recorder can already have skipped a block as it
  started (one in each of the reproducer's runs). A span counts only what
  happens from its start, or from the recording's start for a span that
  starts with it.
- Windows runners weren't tried.

## Recommendation

**Measured:** recording real engine output works in both browsers, on a
Mac and on a hosted Ubuntu runner with a null sink, without new
dependencies or production changes. The regression suite catches each
audible defect the project has fixed when it is put back. Its final
version passed 23 of 23 runs in Chromium and 20 of 23 in Firefox on this
Mac, with one Firefox start failure and two unexplained clicks on Spotify
(see "Suite results").

**Next:** run the suite on the hosted runner enough times to show it is
steady there. Until then it stays out of the required check and the
release; it can replace the routine listen after an engine change on the
Mac now, with the real-site listen kept before a store release.
