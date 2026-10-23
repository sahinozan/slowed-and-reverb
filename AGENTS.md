# Working in this repository

Slowed & Reverb is a browser extension (Manifest V3, Chromium and Firefox) that
changes how songs sound on YouTube, YouTube Music and the Spotify web player,
plus its website at slowedreverbapp.com and its store listings. README.md
covers the features and development commands in full.

## Layout

- `extension/`: the extension. The manifest targets Chromium; the Firefox
  build adds Firefox's settings.
- `site/`: the website. Static files with no build step, served by Cloudflare
  Workers (`wrangler.jsonc`). See `site/README.md`.
- `store-assets/`: store images and listing text (`LISTING.md`). See
  `store-assets/README.md`.
- `scripts/`: build, render and site tools, run through `npm run`.
- `tests/`: unit tests (`node --test`); `e2e/`: a Playwright smoke test for
  Chromium and a puppeteer-core test for Firefox.

## Checks

- After changing code, tests, the manifest or scripts, run `npm test`.
- Before handing work back, run `npm run check`. If it can't run, say which
  command failed and why.
- For changes that touch the extension at runtime, `npm run test:e2e` runs the
  real extension in Chromium, and `npm run test:firefox` checks in the
  installed Firefox that the effects stop when the extension is turned off,
  that Spotify's own speed resets don't cause silent gaps, and that an
  update keeps the previous version's audio engines off until the page is
  reloaded.
- `npm run test:audio:chromium` and `npm run test:audio:firefox` are the
  audio regression suite: they record the engines' real audio through
  changes of settings, Spotify's speed changes, turning the extension off,
  removing and updating it, and put back each audible defect fixed so far
  to show it is caught. Run them after changing an engine, the content
  scripts or the background script, as well as listening: they don't
  replace that yet (see "What it can replace" in the README below). `npm run test:audio-trial:chromium` and
  `npm run test:audio-trial:firefox` are the experiment the suite is built
  on. All four are described in `e2e/audio-capture/README.md`. They aren't
  part of `npm run check`, CI's required check or releases, and they need a
  sound device (on Linux, a PulseAudio or PipeWire sink). Run them one at a
  time, with no other browser tests. A new audible defect gets a control in
  `e2e/audio-capture/history.js`.
- After changing dependencies, run `npm run audit:dependencies -- <folder>`
  (`npm audit` on the lockfile, development tools included) and read its
  summary. It fails for any advisory, including the node-forge one described
  under "Development dependencies" in SECURITY.md. It isn't part of
  `npm run check`, CI's required check or releases; the Dependency audit
  workflow runs it weekly and for dependency changes. Don't use
  `npm audit fix`, overrides or downgrades just to make it pass.
- After changing the popup, the website, `scripts/popup-preview.js` or
  `scripts/serve-site.js`, run `npm run test:ui`. It renders the popup page
  in Chromium and in the installed Firefox's engine, Gecko, in each state that
  changes its layout (presets, tabs, themes, notices, reload and permission
  panels), and checks that it fits 340px wide without scrolling, with every
  control on screen. It also checks the website from `site/`: the demo plays,
  pauses and follows the popup, the theme carries over, the embedded popup is
  sized right on a desktop and a phone, and no page requests anything from
  another site. Playing the demo in Firefox needs a sound device (on Linux, a
  PulseAudio or PipeWire sink); CI's Windows runners have none, so there the
  tests tagged `@playback` run in Chromium only. A new popup state that changes the layout gets an entry in
  `STATES` in `e2e/ui/popup-layout.spec.js`; a layout defect fixed gets a
  control there. In Chromium, `npm run test:e2e` also checks the installed
  extension's popup this way and saves a screenshot.
- These are pages, not the browser's popup window, so Firefox's rounded panel
  corners (see the `@supports (-moz-appearance: none)` rule in `popup.css`)
  and the browsers' own permission dialogs aren't drawn. A change to the
  popup's frame in CSS still needs a look at the real popup in Firefox. For
  other states, render the popup with the helpers in
  `scripts/popup-preview.js`, as the store-art script and the tests do.

## Generated files

Never edit these by hand. Change the source, then regenerate:

| Files | Source | Command |
| --- | --- | --- |
| `dist/` | `extension/` | `npm run build:chromium`, `npm run build:firefox`, `npm run package` |
| `site/popup/popup.*`, `site/popup/settings.js` | `extension/popup.*`, `extension/settings.js` | `npm run site:popup` |
| `?v=` stamps in `site/*.html` | `site/styles.css`, `site/*.js` | `npm run site:stamp` |
| `extension/assets/icon*`, `store-assets/chrome/store-icon-128.png`, the popup's header mark | `scripts/render-icons.js` | `npm run icons` |
| `store-assets/screenshots/`, `store-assets/firefox/`, the promo tile and marquee in `store-assets/chrome/`, `site/assets/og-card.png` | `scripts/render-store-assets.js`, the popup, the captures in `store-assets/originals/`, the cassette in `site/index.html`, `site/assets/fonts/fraunces.woff2` | `npm run store:assets` (needs macOS fonts) |

The tests fail when the site's popup copy or stamps are out of date.

## Rules

- **Settings:** the defaults, ranges and built-in presets live in
  `extension/settings.js`. The background script, the popup and `content.js`
  load it first, so every injection of `content.js` lists `settings.js` before
  it (a test checks this). The audio engines run in the page's own world,
  where `settings.js` isn't loaded, so `youtube-main.js` and
  `spotify-main.js` keep copies of the defaults and ranges, and
  `spotify-bridge.js` of the defaults, because Spotify's registered scripts
  are kept across updates. A test keeps those copies equal. A new setting
  goes in `settings.js`, the three copies, the popup's controls, and the
  audio graphs in `youtube-main.js` and `spotify-main.js`.
- **Privacy:** the extension makes no network requests and has no analytics,
  telemetry or remote code. Don't add permissions; the optional site
  permissions are requested only when the user asks. The website loads
  nothing from other websites (`tests/site.test.js` checks this).
- **Dependencies:** no runtime dependencies. Development tools are pinned
  exactly; `.npmrc` disables install scripts and delays brand-new releases.
  Use `npm ci`.
- **Words people read** (the popup, the website, store text, release notes):
  American spelling, plain words for people who aren't technical, no slogans
  or marketing tics, the same voice as the website. Developer docs and code
  comments use American spelling too.
- **Trademarks:** say "for YouTube™" and similar, never imply endorsement, and
  keep the attribution lines.
- **Store text:** `store-assets/LISTING.md` holds the approved text. Chrome's
  description is plain text; Firefox's description, release notes and privacy
  policy are Markdown, which escapes HTML and drops headings, so section
  titles are bold lines.

## Releases

A version bump touches `extension/manifest.json`, `package.json`, the root
entries of `package-lock.json`, `VERSION` in `extension/content.js`,
`extension/spotify-bridge.js`, `extension/spotify-main.js` and
`extension/youtube-main.js`, the footer of every `site/*.html` page, a new
entry in `site/changelog.html`, and the version line in `PRIVACY.md` and
`site/privacy.html`. The scripts compare their own `VERSION`s rather than the
manifest's, because a store's rollback puts earlier code out again with only
the manifest's version raised. The Chrome store summary is the manifest's
`description` (132 characters at most), so it only changes with a release.

Build the upload packages with `npm run release -- <commit>`, given the
commit on `main` to release (`git fetch` first). It checks that everything the
version bump touches shows the new version, works in a clean worktree of the
commit, runs `npm run check`, the packaging and both browser tests one at a
time (run no other tests meanwhile), and checks that the packages are exactly
what the commit builds. Then it writes the packages, the Firefox Add-ons copy
of the privacy policy, a draft `RELEASE-<version>.txt` and each check's log
(in `logs/`) to `dist/packages/<version>/` in the main checkout, next to the
earlier releases; fill in the draft's TODO lines. It never replaces an
existing version folder, even an empty one, or leaves a partial one. It
fails if any Node test or suite failed, was cancelled, skipped or left to do
(the only skips are for Windows, where it doesn't run), or if a test file
stopped before its tests finished. A test file with no tests or suites of its
own, such as an empty one or one with only hooks, fails the same way, though
`node --test` passes it. It judges these from the results a second reporter
(`scripts/node-test-results.js`) writes to its own file in `logs/`, not from
the printed output. To add that reporter it runs
the parts of `npm run check` and `npm run test:firefox` itself, so when those
scripts or `npm test` change, change `TEST_SCRIPTS` in `scripts/release.js`
too (a test checks they match). A failed run leaves its logs in the scratch
folder it names.
`npm test` rebuilds `dist/packages/*.zip`, so keep the verified files in the
version folder.

## Git

Branch from `main` and open a pull request; don't push to `main`. CI's
required check is "Lint, test, and package". It needs `npm run check` to pass
for every change, and the browser tests too unless the base commit's
`scripts/classify-ci-changes.js` says the change can't affect them; changing
the workflows or the classifier always runs them. Every review conversation
must be resolved before merging. Don't merge unless asked. Commit messages
and pull request descriptions are plain prose about what changed and why.
