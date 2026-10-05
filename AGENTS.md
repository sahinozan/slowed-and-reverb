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
- `tests/`: unit tests (`node --test`); `e2e/`: a Playwright smoke test.

## Checks

- After changing code, tests, the manifest or scripts, run `npm test`.
- Before handing work back, run `npm run check`. If it can't run, say which
  command failed and why.
- For changes that touch the extension at runtime, `npm run test:e2e` runs the
  real extension in Chromium.
- Check popup changes in both engines. Firefox draws the popup inside rounded
  panel corners (see the `@supports (-moz-appearance: none)` rule in
  `popup.css`) and needs a manual look. In Chromium, `npm run test:e2e` opens
  the real popup, checks its size and saves a screenshot; for other states,
  render it with the helpers in `scripts/popup-preview.js`, as the store-art
  script does.

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
  it (a test checks this). `spotify-bridge.js` keeps its own copy of the
  defaults, because Spotify's registered scripts are kept across updates; a
  test keeps the copy equal. A new setting goes in `settings.js`, the bridge's
  copy, the popup's controls and `content.js`'s audio graph.
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
entries of `package-lock.json`, the footer of every `site/*.html` page, a new
entry in `site/changelog.html`, and the version line in `PRIVACY.md` and
`site/privacy.html`. The Chrome store summary is the manifest's `description`
(132 characters at most), so it only changes with a release.

Build the upload packages from a clean checkout of `main`, check them, and
record the commit, checksums and checks in `dist/packages/<version>/`, as for
1.0.0 and 1.0.1. `npm test` rebuilds `dist/packages/*.zip`, so keep the
verified files in the version folder.

## Git

Branch from `main` and open a pull request; don't push to `main`. CI's
required check is "Lint, test, and package", and every review conversation
must be resolved before merging. Don't merge unless asked. Commit messages
and pull request descriptions are plain prose about what changed and why.
