# Testing

What each test command covers. Which of them a change needs is not on this
page: [checks.md](checks.md) has the map, and `npm run checks:for` prints what
the files you changed need. Setup is in [CONTRIBUTING.md](../CONTRIBUTING.md).

The commands that use Firefox start the installed one; set `FIREFOX_BIN` for a
Firefox somewhere else.

## The unit tests

`npm test` runs the real extension scripts against deterministic browser,
DOM, and Web Audio mocks. It covers tab state and shortcuts, audio graph
values, blocked and live-media behavior, popup controls and presets, manifest
contracts, and the Firefox build. `npm run test:watch` reruns the tests while
developing.

## The extension in Chromium

`npm run test:e2e` is a Playwright smoke test. It loads the built Chromium
extension into a real browser, renders its popup at production size, applies
settings to a local audio fixture, checks that the popup's content fits
without scrolling with every control on screen, and saves a screenshot in the
test report. It also updates an earlier version with a YouTube page open and
checks that the popup asks for a reload and the effect starts after it.

## The extension in Firefox

`npm run test:firefox` runs the Firefox build in the installed Firefox through
puppeteer-core. It turns the effects on for the same fixture, turns the
extension off through Firefox's add-on manager, and checks that each player
is back to normal speed, captured once, and playing only through the
unchanged path; it does the same again after turning the extension back on
and removing it. It checks that Spotify's own speed resets cause no silent
gaps. It also updates an earlier version with a YouTube page open, and with a
Spotify page open before turning the extension off and on, and checks that
each old engine stays off until the page is reloaded. It can't hear the audio.

Before its tests it prints which Firefox it started, how long Firefox took to
open its WebDriver BiDi port and what Firefox printed meanwhile; when Firefox
doesn't start, it adds the browser's processes and how they ended.

## The popup, the website and the limiter

`npm run test:ui` runs three sets of tests in Playwright's Chromium and in the
installed Firefox (Gecko). Playwright drives Firefox through its experimental
WebDriver BiDi support (the `moz-firefox` channel, with a new profile for each
run), which a future Firefox or Playwright may change.

### The popup's layout

It renders the popup page from `extension/` with a stub extension API, in each
state that changes its layout: the built-in and saved presets with long names,
the Advanced tab, themes, the effect on and off, notices for loading, live and
blocked pages, and the reload and permission panels, including after a failed
attempt. For each it checks that the popup shows that state, then that it is
340px wide, needs no scrolling, and shows every control it should, uncovered
and not made transparent by anything around it; the effect controls stay
checked under My Presets, and the saved presets list scrolls on its own and
its last preset is still usable.

It fails on the layout defects fixed in `c3ab8b5` and `46512dc` when they are
put back, and on made-up ones: a popup too wide, a clipped presets list,
effect controls hidden or cut off under My Presets, and a transparent panel or
page. `SLOWED_REVERB_POPUP_HISTORY=1 npm run test:ui -- --grep history` checks
those commits' own files.

It is the popup's page, not the browser's popup window: Firefox's rounded
panel corners and the browsers' permission dialogs aren't drawn, so a change
to the popup's frame in CSS still needs a look in Firefox.

### The website

It serves `site/` as Cloudflare does and checks, on a desktop and two phone
widths (the smaller is 320px), that the demo plays and pauses, that the popup and the page's speed
fader drive it both ways, that the popup's theme colors the page and the next
one, that the embedded popup is sized to fit and keeps the room the page
reserved for it, that no page is wider than the window, and that no page
requests anything from another site, WebSockets included, or reports an error.
The browsers are muted, so this checks that the song's clock moves, not how it
sounds.

Each playing test attaches `demo-playback.json`: each step the demo took to
play (fetching and decoding the song, resuming the audio context, starting the
`<audio>` element), which ones are still waiting, and the audio context's and
element's state and clocks.

### The limiter

It checks the limiter's sound, without playing any
(`e2e/ui/limiter.spec.js`). Firefox's compressor still boosts the treble
before it decides how far to turn the sound down, which Chromium stopped doing
in 2014, so the limiter turned loud, bright music down in Firefox only. Both
engines and the website's demo carry the same limiter stage, which in Firefox
puts a filter each side of the limiter to cancel that. The test renders the
stage from each file offline in both browsers and checks that tones from
100 Hz to 18 kHz, white noise and a bass note under bursts of treble, all
below the limiter's threshold, come out at the same level in both; that the
defect is heard when it is put back; that a compressor without the filters is
left as it was; and that a limiter connected before the stage has checked the
browser limits a loud tone exactly as one connected after.

## The audio suites

The tests above can't hear the audio. The audio regression suite
(`npm run test:audio:chromium` and `npm run test:audio:firefox`) records the
engines' real sound through the changes that have gone wrong before, and the
trial (`npm run test:audio-trial:chromium` and
`npm run test:audio-trial:firefox`) is the experiment it is built on.
[e2e/audio-capture/README.md](../e2e/audio-capture/README.md) says how to run
them, what they check, and why they don't replace a listen yet.

## A sound device

The audio suites and trials need a sound device. So does playing the website's
demo in Firefox under `npm run test:ui`, because Firefox's audio clock starts
only with one. On Linux that is a PulseAudio or PipeWire sink; CI's Ubuntu
jobs start a PulseAudio null sink.

GitHub's Windows runners have no sound device, so CI's Windows job sets
`SLOWED_REVERB_UI_FIREFOX_PLAYBACK=omit` and the two tests tagged `@playback`
(the demo playing, and its control for the popup's choices not reaching the
demo) run there in Chromium only; every other test runs in both engines on
both systems.

## What stays manual

What the automated tests don't check today, the real sites, the browsers' own
windows and prompts, and real sound, is done by hand before each store
release, from [RELEASE-CHECKLIST.md](../RELEASE-CHECKLIST.md).
