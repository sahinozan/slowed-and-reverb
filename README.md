# Slowed & Reverb

A browser extension that applies real-time slowed, reverb, and related audio
effects on YouTube, YouTube Music, and Spotify. Fully local processing, zero
telemetry, and zero runtime dependencies.

## Get the extension

Chrome Web Store and Firefox Add-ons links will be added here after publication.

## Use

Open YouTube, YouTube Music, or Spotify and click the toolbar icon. On a supported
tab the extension has never touched, opening the popup applies **Slowed + Reverb**
straight away. Everything else is one click from there.

Spotify first asks for optional access to `open.spotify.com`. After permission is
granted, the page reloads once so the audio hook can start before Spotify's hidden
player. The permission is not requested during installation and can be revoked at
any time in the browser's extension settings.

Firefox also asks for optional access to the current YouTube or YouTube Music site
on first use. Firefox requires that access to restore processing after a page reload;
Chromium keeps using temporary tab access and does not show this additional prompt.

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

Three commands are declared with **no default keys**. Assign them in
`chrome://extensions/shortcuts` on Chromium browsers or through **Manage Extension
Shortcuts** in Firefox's Add-ons Manager:

- **Toggle last preset:** turns the effect off, or back on with this tab's last
  settings (falling back to Slowed + Reverb).
- **Toggle Slowed + Reverb**
- **Toggle Nightcore**

Each toggles off if that exact preset is already what's playing.

### Themes

Four themes (Terminal, Midnight, Paper, Frost) behind the palette icon. Purely
cosmetic and stored globally, not per tab.

## Behaviour worth knowing

- **The `1.0.0` support list is intentionally small.** YouTube, YouTube Music, and
  Spotify are supported. Other sites, including Twitch and SoundCloud, are left
  untouched and show a clear unsupported-site message.
- **State is per tab and origin.** Two tabs can run different settings. Enabling
  the effect and reloading restores it, as does navigating within the same
  origin.
- **Supported players report their status.** The popup distinguishes active
  processing from a player that is still loading or has not appeared yet. If a
  supported player rejects Web Audio or exposes DRM unexpectedly, processing is
  stopped and explained instead of being presented as active.
- **YouTube live streams ignore Speed.** The player's own latency correction
  fights it every tick. Reverb, EQ, and the rest still work.
- **Embedded players may be unreachable.** Media inside iframes or shadow roots
  is not currently processed. Frame support can require broader permissions,
  and both cases need more complex lifecycle and state handling.

## Development

```sh
npm ci                    # install exactly what package-lock.json records
npm run lint              # ESLint 10, flat config
npm test                  # run service worker, content, popup, and package tests
npm run test:watch        # rerun tests while developing
npx playwright install --no-shell chromium # one-time local browser install
npm run test:e2e          # real Chromium extension smoke test
npm run build:chromium    # emit dist/chromium/
npm run build:firefox     # emit dist/firefox/
npm run package           # build allowlisted ZIPs for both stores
npm run lint:firefox      # build, then validate with web-ext
npm run check             # run every required local and store-package check
```

Publication preparation is tracked in [STORE_RELEASE_PLAN.md](STORE_RELEASE_PLAN.md).

The root manifest targets Chromium. Target builds emit clean, allowlisted
directories under `dist/`; `npm run package` creates one upload ZIP per store in
`dist/packages/`. The Firefox version receives Firefox's MV3 background
configuration and add-on metadata during the build. Its data-collection
declaration and optional YouTube reload permissions target Firefox desktop 142+.
Firefox Android is not declared for `1.0.0` because it has not been tested.

Needs Node >= 24.19 and npm 11.19. Development tools are exact-versioned in
`package.json` and `package-lock.json`; use `npm ci` for normal setup rather
than fetching tools with `npx`. The project `.npmrc` disables dependency install
scripts, rejects Git and remote-tarball dependencies, and excludes releases less
than seven days old when resolving dependency updates. Review lockfile changes
and run `npm audit` before committing any intentional dependency update.

The test suite runs the real extension scripts against deterministic browser,
DOM, and Web Audio mocks. It covers tab state and shortcuts, audio graph values,
blocked and live-media behavior, popup controls and presets, manifest contracts,
and the Firefox build. The Playwright smoke test loads the built Chromium extension
into a real browser, renders its popup at production size, applies settings to a
local audio fixture, checks popup dimensions, and saves a screenshot in the test
report.
GitHub Actions runs that smoke test on disposable Ubuntu and Windows machines in
addition to `npm run check`. A final manual smoke test in current Chromium and
Firefox is still recommended before a store release because browser and media-site
behavior cannot be reproduced completely in an automated environment.

## Privacy

No data collection, no analytics, no external network requests. Core permissions
are `activeTab`, `scripting`, and `storage`. Initial YouTube and YouTube Music access
begins only after the user opens the popup or uses a shortcut on that tab. The
Firefox package declares optional access to `www.youtube.com` and
`music.youtube.com` so it can restore only previously enabled tabs after reload;
each origin is requested separately on first use and neither is granted at
installation. Spotify declares optional access to `open.spotify.com` in both
packages and requests it only when the user chooses **Allow on Spotify** while
visiting the web player. Revoking optional site access neutralizes processing and
prevents later restoration on that site.

Read the full [privacy policy](PRIVACY.md). For questions and bug reports, follow
the [support guide](SUPPORT.md).

## License

Released under the [MIT License](LICENSE). Use of the extension remains subject
to the terms of service of the websites on which it is used.
