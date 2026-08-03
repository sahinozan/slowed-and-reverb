# Architecture & design notes

The source files carry no comments by design. This document holds the reasoning
behind the non-obvious parts — most of it empirical, established by testing
against real sites rather than derived from specs. Read this before changing
anything listed here; several of these look like arbitrary constants but are
load-bearing.

## Layout

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest (Chromium). The Firefox build rewrites `background`. |
| `background.js` | Service worker: keyboard shortcuts, toolbar icon, per-tab state store. |
| `content.js` | Injected on demand. Owns the Web Audio graph for a page's media. |
| `popup.js` / `popup.html` / `popup.css` | The popup UI. |
| `scripts/build-firefox.js` | Emits `dist/firefox/`. |

## Cross-browser API shim

Every script starts with `const api = typeof browser !== 'undefined' ? browser : chrome`.
Firefox's `browser` global is natively promise-based; Chrome has no `browser`
global, but its `chrome.*` APIs already return promises when called without a
callback — true for every API used here. That one line is enough for both, so
there is no polyfill dependency.

## Permissions model

`content.js` is **never registered statically**. It is injected on demand via
`api.scripting.executeScript` under `activeTab`, granted by the user clicking
the toolbar icon or pressing a shortcut. The extension therefore does not run on
pages the user has not acted on.

`youtube.com` briefly carried a standing host permission plus a static content
script registration. Testing showed **neither is needed**, including for
reload-restore: `tab.url` is readable in `tabs.onUpdated` under plain `activeTab`
once the user has used the extension in that tab. Untouched tabs leave `tab.url`
undefined, skip the restore branch, and are never injected — which is the desired
behavior anyway.

Injection can happen more than once per document (popup, shortcut, and
background's post-navigation restore all call `ensureContentScript`), so
`content.js` guards on `window.__slowedReverbInjected`. Without it, re-running
would throw on the top-level `const` redeclarations and would also blow away the
audio graph already attached to the page.

## Per-tab state

`background.js` owns a `tabState` map in `api.storage.session` (cleared when the
browser closes, never synced) keyed by tab id. `popup.js` keeps its own copy of
the read/write helpers rather than sharing a module — these are two independently
loaded scripts with no module system between them. **If the recall rule changes
in one, it must change in the other**, or the popup and the shortcuts will
disagree about whether a tab has state to restore.

This used to be a single `api.storage.local` blob keyed by exact URL. That broke
for two tabs open to the identical URL (e.g. a duplicated tab): they collided on
one storage key, so whichever applied a preset last silently overwrote the
other's, and either tab's reload restored whichever was written last rather than
its own.

### Recall matches origin, not URL

`sameSite()` compares `new URL(a).origin`. Exact-URL matching broke on any app
that drives playback from more than one address: `music.youtube.com` plays from
`/` while you queue from the homepage, from `/watch?v=…&list=…` once the player
page is open, and from `/playlist?list=…`, rewriting the address as tracks
change. The URL remembered when the effect was switched on had usually stopped
being the current one by the time the tab reloaded, and the effect silently
dropped.

This is a deliberate widening: on any origin, enabling the effect on one page and
reloading on another page of the same site now restores. That matches how SPA
navigation already behaves (see `yt-navigate-finish` below); before this, reload
and in-page navigation disagreed with each other.

### Why content.js asks background for its own state

Content scripts cannot read `api.storage.session` directly, and have no way to
learn their own tab id. `sender.tab.id` gives background that for free, so
background does the lookup on the content script's behalf (`GET_TAB_STATE`).

`CONTENT_STATE_CHANGED` is sent **only when something was actually restored**.
Background treats that message as authoritative and writes it straight back into
the per-tab store, so reporting `false` would overwrite the tab's remembered
settings with "off" and break the *next* reload. When nothing was restored, the
icon background already set is correct anyway.

## Blocked sites

`GET_STATE` returns `blocked` plus a `blockReason` that selects the banner
wording. Three distinct causes, deliberately worded differently — calling the
last two "copy-protected" would be a plain lie to the user.

### `drm` — EME-protected media

Protected elements have a `MediaKeys` object attached to negotiate decryption;
browsers refuse to let Web Audio tap that element's output at all. Detected two
ways: the upfront `media.mediaKeys` check, and catching
`InvalidStateError`/`NotSupportedError` from `createMediaElementSource` itself,
since some browsers don't expose `mediaKeys` until playback actually starts.

`DRM_HOSTS` covers sites where even that check can't run: their `<audio>`/
`<video>` element is never attached to the document, so `querySelectorAll` finds
nothing to check. Confirmed on Spotify — created via `document.createElement` and
held only as an in-memory reference by their own player, never inserted into the
DOM, shadow DOM, or any iframe. Catching those would require patching
`document.createElement` before the page's own script runs, which needs a
standing host permission per site. Matched by exact hostname, not scored against
every page, so the list only needs to cover sites confirmed to evade the generic
check.

### `broken` — Twitch clips

Twitch **clips specifically** (not the rest of twitch.tv) go completely silent the
instant the effect is turned on. Confirmed by testing, not inferred. Live and VOD
play from a same-origin `blob:` URL (MSE) where `crossOrigin` is irrelevant; a
clip is a genuine cross-origin `<video src="….mp4">`. This script is only injected
on demand, by which point the clip has usually already started loading without
CORS mode — setting `crossOrigin` that late does not retroactively un-taint it,
and Web Audio silently mutes tainted cross-origin audio rather than passing it
through (a deliberate anti-fingerprinting behavior, not a bug).

**`createPipeline` must bail before `createMediaElementSource`.** That call
permanently reroutes the element away from its native output as soon as it runs —
unconditionally, on every injection, regardless of whether the effect is
"enabled". Disabling the popup toggle alone does not help, because the damage is
already done by the time the popup opens.

### `unreachable` — SoundCloud

Not DRM at all; the audio is unprotected, there is just no element in the page to
attach to. Confirmed by console instrumentation: SoundCloud's player builds
`<audio>` via `document.createElement` and never inserts it, while a pool of four
spare elements sits at `readyState` 0 as a decoy. The one actually playing carries
`src="blob:https://soundcloud.com/…"` and `crossorigin="anonymous"` — which is
the good news for later: MSE means same-origin, so Web Audio would pass it
through rather than muting it the way it does a tainted cross-origin source.
Supporting it needs a `soundcloud.com` host permission plus a `document_start`
script in the MAIN world to catch the element at creation time. Deliberately
deferred.

## Live streams

Live media reports `duration === Infinity` once metadata has loaded. Their
player's own latency management keeps re-correcting `playbackRate` to stay near
the live edge, so setting it loses a fight every tick with no lasting effect —
skip it entirely instead. Reverb/EQ/etc. are pure downstream signal processing
that does not care what rate the source plays at, so they keep working.

**YouTube Live is a confirmed exception.** Its DVR-style rewind window means
`duration` comes back as a large but finite, growing number instead of `Infinity`
(empirically ~26175 for an active stream), so the generic check cannot see it.
Two other markup signals were tried and ruled out first:

- `.ytp-live-badge` — red herring, stays in the DOM as a relic after a stream ends.
- a `ytp-live` class on the player container — never actually appears.

What is reliable is the badge's **`.ytp-live-badge-is-livehead`** modifier class,
present only while genuinely live and gone once the stream ends. This will break
if YouTube changes the markup, but it is the only signal available for this case.

The popup mirrors this: Speed and Keep Original Pitch are disabled and *pinned to
their defaults*, not merely greyed out. Presets set sliders programmatically and
do not care that a control is disabled, so picking Nightcore on a live stream used
to slide the thumb to 1.20x under a label reading "unavailable — live". Pinning
the real value (not just the display) matters because `getCurrentSettings` reads
straight off the controls — faking only the display would save and broadcast a
speed the page will never play at.

## Audio graph

```
source → eqLow → eqMid → eqHigh ─┬→ dry ───────────────┐
                                 ├→ convolver → wet ───┤
                                 ├→ delay ⇄ feedback   ├→ mixed → [width] → pan → limiter → destination
                                 │  delay → echo ──────┤
                                 └→ saturator → sat ───┘
```

- **EQ** — 3 bands, ±12 dB each, at 200 Hz (low shelf) / 1 kHz (peaking, Q 1) /
  4 kHz (high shelf). These split the spectrum the way a simple consumer EQ does,
  not with any precision that would need per-genre tuning.
- **Reverb** — 2.0 s generated impulse response, decay exponent 2.5. Wet scaled
  ×0.7 and dry ducked by ×0.3 of the mix to prevent clipping while keeping some
  dry signal.
- **Echo** — discrete repeats, distinct from reverb's diffuse tail. Delay time
  (350 ms) and feedback (0.35) are fixed rather than exposed; only the wet mix is
  a user control, same "one knob" pattern as the other effects. 350 ms sits in the
  slap-back range that suits the slowed/vaporwave use case; feedback must stay
  under 1.0 to ever die out. Wet scaled ×0.5 — lower than reverb's 0.7 because the
  feedback loop re-enters the graph on every repeat, not just once.
- **Saturation** — `tanh` soft clip, the standard shape: pushes peaks toward ±1
  smoothly (warm harmonics) instead of the brittle hard clipping a bare limiter
  gives. Dividing by `tanh(drive)` renormalizes so the curve still hits exactly ±1
  at the extremes, meaning higher drive changes the *harmonic colour* without also
  changing output level — the wet mix should be the only thing affecting loudness.
  `oversample = '4x'` is the standard fix for the aliasing waveshaping otherwise
  introduces above the curve's bend points.
- **Stereo width** — Web Audio has no "widen stereo image" node, so this is the
  standard mid/side matrix built by hand. A `GainNode` sums whatever connects into
  it, which is what lets plain addition/subtraction be built from gain nodes with
  no dedicated sum node: `mid = (L+R)/2`, `side = (L−R)/2`, scale side by width,
  then `L' = mid + side'` and `R' = mid − side'` (the −1 gain is the subtract
  half). 0 collapses to mono, 1.0 is the original image, >1 exaggerates separation.
- **Pan** — applied *after* widening, so "Pan" always means "where the (possibly
  widened) mix sits", not "widen whatever is left after panning threw the balance
  off".
- **Limiter** — always on, no UI control. Heavy EQ boosts plus a high reverb mix
  can push the summed signal past 0 dB, which clips rather than just getting loud.
  Threshold −3 dB / ratio 20 is tuned to act as a peak limiter, not an audible
  "compressed" sound: at normal settings the signal never reaches −3 dB so this
  passes everything through unchanged, and it only engages at the extreme settings
  that would otherwise distort.

### Pitch

Default (`keepPitch` off) lets pitch shift naturally with speed — that *is* the
slowed/nightcore tape effect. Chrome's own default (`preservesPitch = true`)
time-stretches to keep pitch constant, which sounds robotic at 0.8x/1.2x. All
three vendor-prefixed properties are set, since engines disagree on which they
honour.

### Track changes without navigation

On `music.youtube.com`, switching tracks often loads a new source into the *same*
element with no URL change and no SPA navigation, so `yt-navigate-finish` never
fires. The one thing guaranteed for every track is the element (re)starting
playback — and that is also the exact moment the site's player resets
`playbackRate` for the new track. The per-element `play` listener reapplies
settings right there, undoing that reset regardless of what caused the change.

`yt-navigate-finish` covers the other case: clicking a new video is a History API
route change, so the document never unloads and the script is never re-injected.
The carry-over model is deliberate — whatever was on for the last video keeps
playing on the new one, rather than resetting per-URL the way a real reload does.

## Popup

### The `booting` class — and why the removal needs *two* rAFs

The popup is a fresh document every time it opens; the browser destroys it on
close. The real power state only arrives after a storage read plus a `GET_STATE`
round trip, so the first paint is always the markup default (off) and the
correction to "on" lands 10–50 ms later. Without suppression, that correction is
a real 200 ms knob slide, and an already-enabled tab appears to switch itself on
every single time the popup is opened.

`settlePowerUI()` removes the class inside **nested** `requestAnimationFrame`
calls. A single rAF is not enough: if `init()` completes entirely within the
first frame's microtasks — which it does when the storage APIs resolve fast — the
callback fires *before the first paint*, so the browser coalesces the
`checked = true` and the class removal into one style recalc and transitions
anyway, which is the exact thing the class exists to prevent. The double rAF
guarantees a paint has landed in between, regardless of how many task boundaries
the storage APIs happen to introduce. Removing the class inline is likewise wrong,
for the same coalescing reason.

### Blocking is enforced at the choke point

`saveAndApplySettings` is the single function every button, slider, and preset
(built-in or custom) ultimately calls to turn the effect on, and it refuses when
`blocked` — not just via `disabled` on each individual control. That is what
actually guarantees a blocked tab can never show "On"; custom preset rows are
rendered dynamically, which is what slipped through an earlier per-control
approach.

When blocked, the tab groups are locked and forced back to Presets + Basic, so a
blocked tab cannot be left sitting on a panel whose controls are all dead. The
theme picker is disabled too (it is another part of the app to wander into); the
GitHub link is left alone, being an outbound link rather than an in-app section.

### Preset matching

`findMatchingPresetName` checks built-ins first and returns the first match, so a
custom preset saved with settings identical to a built-in displays under the
built-in's name. `settingsMatch` defaults every missing field via `??` — presets
saved before Echo, the stereo controls, or the EQ existed have no such field, and
absent means "default", not "matches nothing".

### Custom preset edit mode

Editing collapses the list to **only** the edited row. That is not just to save
height: the other rows were actively hostile during edit mode, since clicking one
runs `applyPreset`, which clears the active preset and silently throws away
unsaved changes. Not drawing them is simpler and safer than disabling them.

The revert button is deliberately **not** another `×`. That slot means "delete
this preset" in every other row, and giving the same glyph two destructive-looking
meanings one keystroke apart is how someone loses a preset they only meant to
un-edit.

Leaving the tab calls `setActivePreset(null)`, not `discardPresetEdits()`:
"discard" reloads the preset's saved values and pushes them to the audio graph, so
wiring it there would mean clicking a tab silently changes what you are hearing.

`Save Current` while editing exits edit mode rather than re-rendering in place —
while editing, the list only draws the edited preset, so re-rendering would file
the new preset somewhere invisible with no response to the click.

## CSS

### Theming

`--bg` / `--fg` / `--accent-*` / `--radius` / `--warning` / `--frame` drive
everything, so a theme is one override block. `--accent-hsl` holds the bare
`h s l` triple so alpha variants can be written `hsl(var(--accent-hsl) / 0.35)`;
`--accent` is the opaque form. Muted text and hairlines use
`color-mix(… var(--fg) X%, transparent)` rather than `rgba(255,255,255,X)`, so
they stay legible on the light themes instead of rendering white-on-white.

`--warning` needs its own per-theme value: a vivid amber that reads fine on black
is nearly invisible against the light themes, so those use a darker rust tone.
`--frame` needs spelling out on dark themes because `--fg` is plain white there;
on the light themes `--fg` already *is* a dark tint of the accent hue, so it
doubles as the frame colour.

The `pink` theme id is the original single-look version and is kept for storage
back-compat — existing installs already have `uiTheme: "pink"` saved. Add a theme
to `THEMES` in `popup.js` **and** mirror its palette here.

### Window frame

Chromium renders extension popups as a hard rectangle with no way to round it,
unlike Firefox's panel chrome. Faking rounded corners looked mismatched against
the real square window, so the window stays square and `body` gets a thin coloured
frame instead. The `@supports (-moz-appearance: none)` block adds real rounding on
Firefox only — `-moz-appearance` is Gecko-only, so `@supports` evaluates false in
Chromium, making it a reliable engine branch with no UA sniffing. The inner radius
is deliberately smaller than the outer by roughly the 4 px inset: concentric
rounded corners only nest cleanly when `inner ≈ outer − inset`.

### Scrolling and the scrollbar gutter

Chrome and Firefox cap popup windows around 600 px tall; beyond that the browser
used to scroll itself, via unstyleable popup chrome that turned out to be
unreliable (reported as "can't scroll at all"). `.scroll-area` has its own bounded
`max-height: 592px` + `overflow-y`, making scrolling a real part of the document.
It lives there rather than on `body` so the gutter stays inside the content area
rather than the frame.

`scrollbar-gutter: stable` reserves the scrollbar's space unconditionally, so the
content box width does not change when a scrollbar appears. Without it the whole
popup visibly jumped left the moment content grew past `max-height` (entering
preset edit mode is the usual trigger). Firefox is where that read as broken:
setting `scrollbar-width`/`scrollbar-color` opts a scroller out of macOS's
zero-width overlay scrollbars into classic ones that take real layout space, and
Firefox's "thin" is ~11 px against Chromium's 5 px.

`margin-right: calc(-1 * var(--scrollbar-w, 0px))` then cancels that gutter back
out of the visible layout — the box grows right past `.container`'s edge and
`.container`'s `overflow: hidden` clips it. `--scrollbar-w` is measured at startup
by `publishScrollbarWidth()` in `popup.js`, because there is no CSS-side way to
ask: the value depends on engine, platform, and the OS "show scroll bars" setting.
**The probe carries `.scroll-area`'s own class** so it inherits the exact scrollbar
styling being measured — styling a scroller is itself what opts it out of
zero-width overlay scrollbars, so an unstyled probe would wrongly report 0. The
inline styles only neutralize the layout parts of that class. The `0px` fallback is
the correct answer for real overlay scrollbars and degrades to "gutter is visible"
rather than a broken layout.

An earlier version reserved a hardcoded 8 px strip instead. That kept the right-
hand gap identical across browsers but could not fix the jump, because a fixed
strip is still lost to the scrollbar on top of the reservation.

### Custom presets list

`max-height: 92px` is tuned to 2 full items plus a small deliberate peek of a
third. The peek is the only signal that a newly created 3rd+ preset actually
saved. 75 px produced the accidental "shows nothing in Chromium, a bit more in
Firefox" result, because item height rendering differs slightly between engines —
a value with no intentional peek margin lands right on that inconsistency.

`.has-scrollbar` is toggled from JS only when the list actually overflows, so 1–2
presets are not permanently nudged left for a scrollbar that is not there. The
two engines need different treatments:

- **Chromium** keeps rows at their exact width and grows the box via a more
  negative `margin-right`, so the scrollbar riding its edge ends up further right
  with a real gap. Widening alone is not enough — `.custom-preset-btn` is `flex: 1`
  and re-claims any extra room, which is why a margin-only attempt moved rows and
  scrollbar together with no gap. Pinning `.custom-preset-item` to
  `calc(100% - 6px)` (6 px matching exactly how much wider the margin makes the
  box) stops that re-expansion.
- **Firefox** uses the simpler shrink-the-content approach; it reads fine there.

Chromium widens thin scrollbars on hover on its own, always toward the content and
never toward the outer edge, no matter how wide the track is declared. Redeclaring
width on `:hover` and using a wider base width were both tried and changed nothing
— this is not reachable from author CSS.

### Other load-bearing values

- **`[hidden] { display: none !important }`** — an author `display` rule always
  beats the browser's built-in `[hidden]` rule once both target the same element,
  regardless of specificity. Without this, anything toggled via `hidden` in JS
  shows fine but never hides again.
- **`.power-status { min-width: 3ch }`** — fixed to "Off"'s width so the header
  does not shift between "On"/"Off". `ch` is exact here because the body font is
  monospace. That shift was invisible in Chromium but just large enough in Firefox
  to push `.header-actions` past `.container`'s clipped edge, cutting off part of
  the GitHub icon whenever the toggle read "Off".
- **Slider track colour** uses `color-mix(… 25%, var(--bg))` — an opaque
  pre-mixed colour, not the accent at partial alpha. Firefox rendered the same
  alpha visibly lighter than Chromium, and neither `-moz-appearance` nor styling
  `::-moz-range-progress` changed it (both tried), meaning the mismatch came from
  how each engine composites a semi-transparent layer. `color-mix` computes one
  opaque result ahead of time, leaving nothing to disagree on.
- **`::-moz-range-progress`** paints the filled portion of the track on Firefox.
  Chromium has no equivalent for a plain range input, so without this rule Firefox
  used its own default fill.
- **EQ `viewBox="0 0 300 84"`** — the 84 matches `.eq-curve`'s real rendered
  aspect ratio (~304 × 85 px). The SVG uses `preserveAspectRatio="none"`, and a
  mismatched viewBox ratio is exactly what squashed the round handle dots into
  ovals. **Keep this proportional to `.eq-curve`'s height/width if either changes.**
  `EQ_Y_SWING` in `popup.js` is 40% of the viewBox height.
- **`.control-row` label sizing** — at half width (~146 px), "Saturation (100%)"
  wraps at the default 13/12/18 px sizing, pushing that slider down and breaking
  row alignment with its pair whenever the value's digit count changed. Sized down
  specifically for this two-column context.
- **`.control-header .switch { flex: none }`** — `.control-header label` also
  matches the `<label class="switch">` wrapping a checkbox, and its `flex: 1` would
  override that label's explicit 38 px width and stretch it across the row.
- **`.controls { margin-bottom: 4px }`** — 4, not 6. The footer already
  contributes 10 px of padding above its divider, making this the least
  load-bearing 2 px in the layout, and 2 px is exactly what put the worst-case
  height back inside the 592 px ceiling.
- **`.confirm-preset-btn` / `.revert-preset-btn` must stay after
  `.edit-preset-btn` / `.delete-preset-btn`** — single-class selectors at equal
  specificity, so source order decides. Written earlier, they lose their background
  and border outright.
- **`footer.no-divider`** hides only the divider line on the Advanced tab, where
  Saturation's slider already reads as a stopping point. `padding-top` is left
  alone so Reset Defaults does not jump. Basic's EQ curve lacks that cue, so it
  keeps the line.
- **`.logo` colour is fixed, not themed** — it matches the toolbar icon, which is
  always pink regardless of the popup's theme, keeping the mark recognizable.

## Firefox build

Firefox's MV3 does not support `background.service_worker` (Chrome-only); it wants
`background.scripts`. Those two keys are mutually exclusive, so a single
`manifest.json` cannot serve both. `scripts/build-firefox.js` keeps this repo as
the one source of truth (Chromium loads it unpacked as-is) and rewrites only that
key into `dist/firefox/`.

The `*.svg` sources are dev-time only and are filtered out of the build — leaving
them in trips `web-ext lint`'s "unnecessary file" warning.

The `browser_specific_settings.gecko.id` is a **placeholder**. Fine for temporary
local loading (`about:debugging` assigns a random one anyway), but a real id under
a domain you control is required before submitting to addons.mozilla.org.

`data_collection_permissions: { required: ['none'] }` declares that the extension
collects nothing. Firefox requires this key on all new submissions, and it is what
`strict_min_version` is pinned to **142.0** for — the key was introduced in
Firefox 142, and web-ext errors on the mismatch if the minimum is lower. The
previous minimum was 109.0 (roughly when Firefox MV3 landed); raising it drops
Firefox 109–141, which is acceptable for an unpublished add-on but is the one
thing to reconsider if you ever need that range back. Both constants live at the
top of `scripts/build-firefox.js`.

## Verifying changes

There is no test runner in the repo. Changes were verified by generating a single
HTML file that inlines `popup.css`, `popup.html`'s body, a stub `window.chrome`
(storage/tabs/scripting/action, all returning resolved promises), and then the
**real, unmodified `popup.js`** — followed by an assertion script that runs on
`load` and paints pass/fail rows into the page. Screenshot it and read the
results. The same approach covers `content.js`: stub `chrome.runtime`, capture the
`onMessage` listener, drive it directly against a real `<audio>` carrying a `data:`
WAV. Media elements delay the document `load` event until `readyState >= 2`, so
assertions on `playbackRate`/`preservesPitch` are reliable, and Web Audio graph
construction works headless in both engines.

Run it in **both** engines — the popup ships to Chromium, so Firefox alone is not
enough:

```sh
# Firefox: exits on its own after writing the screenshot
/Applications/Firefox.app/Contents/MacOS/firefox --headless --profile <dir> \
  --window-size=360,620 --screenshot out.png file:///path/to/page.html

# Chromium (Helium): writes the screenshot in ~2s then NEVER exits — background
# it, poll until the PNG stops growing, then kill. Do not pass
# --hide-scrollbars; it zeroes the scrollbar probe the gutter layout depends on.
/Applications/Helium.app/Contents/MacOS/Helium --headless --disable-gpu \
  --user-data-dir=<dir> --window-size=360,620 --screenshot=out.png file://… &
```

Renders are reproducible enough to diff with `md5 -q`. Firefox has a first-run
font-cache artifact, so render twice and compare the stable hash before believing
a difference.
