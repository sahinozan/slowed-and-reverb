# Slowed & Reverb

A browser extension that applies real-time slowed, reverb, and related audio
effects to any HTML5 `<video>`/`<audio>` element. Fully local processing, zero
telemetry, and zero runtime dependencies.

## Get the extension

Chrome Web Store and Firefox Add-ons links will be added here after publication.

## Use

Click the toolbar icon on any page with media. On a tab the extension has never
touched, opening the popup applies **Slowed + Reverb** straight away. That is the
point of installing it. Everything else is one click from there.

### Controls

**Basic**

| Control | Range | Notes |
| --- | --- | --- |
| Speed | 0.5x – 1.5x | Pitch shifts with speed by default (the actual tape effect) |
| Reverb | 0 – 100% | Generated impulse response, no external files |
| EQ | ±12 dB × 3 bands | Draggable curve; also keyboard-accessible (arrows, Home, End) |

**Advanced**

| Control | Range | Notes |
| --- | --- | --- |
| Keep Original Pitch | on/off | Time-stretches instead of pitch-shifting; can sound robotic below 1.0x |
| Echo | 0 – 100% | Discrete repeats, distinct from reverb's tail |
| Pan | 100% L – 100% R | Applied after widening |
| Width | 0 – 200% | Mid/side; 0 is mono, 100 untouched |
| Saturation | 0 – 100% | Tape/vinyl-style soft clip |

A limiter is always on and has no control. It only engages at extreme settings
that would otherwise clip.

### Presets

Two built-ins (Slowed + Reverb, Nightcore). **My Presets** saves the current
settings under a name; the pencil enters edit mode, where ✓ commits both the
rename and any slider changes and ↺ discards them. Custom presets live only in
`storage.local` and never leave the machine.

### Keyboard shortcuts

Three commands are declared with **no default keys**. Assign them yourself at
`chrome://extensions/shortcuts`:

- **Toggle last preset:** turns the effect off, or back on with this tab's last
  settings (falling back to Slowed + Reverb).
- **Toggle Slowed + Reverb**
- **Toggle Nightcore**

Each toggles off if that exact preset is already what's playing.

### Themes

Four themes (Terminal, Midnight, Paper, Frost) behind the palette icon. Purely
cosmetic and stored globally, not per tab.

## Behaviour worth knowing

- **State is per tab.** Two tabs can run different settings; a fresh tab starts
  off. Enabling the effect and reloading restores it, as does navigating within
  the same site.
- **Some sites are blocked, with an explanation.** DRM-protected media (Spotify,
  Netflix, Apple Music…) genuinely cannot be tapped by Web Audio; Twitch *clips*
  would be silenced outright; SoundCloud keeps its audio element out of the page.
  The popup says which of the three applies rather than guessing.
- **Live streams ignore Speed.** The player's own latency correction fights it
  every tick. Reverb, EQ, and the rest still work.

## Development

```sh
npm ci                    # install exactly what package-lock.json records
npm run lint              # ESLint 9, flat config
npm test                  # run service worker, content, popup, and package tests
npm run test:watch        # rerun tests while developing
npm run build:firefox     # emit dist/firefox/
npm run lint:firefox      # build, then validate with web-ext
npm run check             # run every required local and store-package check
```

The root manifest targets Chromium. The Firefox build emits `dist/firefox/`
with Firefox's MV3 background configuration and add-on metadata.

Needs Node >= 18.18. Development tools are exact-versioned in `package.json` and
`package-lock.json`; use `npm ci` for normal setup rather than fetching tools
with `npx`. The project `.npmrc` disables dependency install scripts, rejects
Git and remote-tarball dependencies, and excludes releases less than seven days
old when resolving dependency updates. Review lockfile changes and run
`npm audit` before committing any intentional dependency update.

The test suite runs the real extension scripts against deterministic browser,
DOM, and Web Audio mocks. It covers tab state and shortcuts, audio graph values,
blocked and live-media behavior, popup controls and presets, manifest contracts,
and the Firefox build. GitHub Actions runs `npm run check` for every push and pull
request. A final manual smoke test in current Chromium and Firefox is still
recommended before a store release because browser and media-site behavior cannot
be reproduced completely in a unit-test environment.

## Privacy

No data collection, no analytics, no external network requests. Permissions are
`activeTab`, `scripting`, and `storage` only: there are no host permissions, so
the content script is injected on demand into the tab you act on and never runs
on pages you haven't touched.

## License

Educational and personal use. Respect platform terms of service.
