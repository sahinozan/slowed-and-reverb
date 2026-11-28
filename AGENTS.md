# Working in this repository

Slowed & Reverb is a Manifest V3 browser extension (Chromium and Firefox) for
YouTube, YouTube Music and the Spotify web player, plus its static website at
slowedreverbapp.com (`site/`, Cloudflare Workers, no build step) and store
listings (`store-assets/`). `extension/` holds the Chromium manifest; the
Firefox build adds Firefox settings. See `CONTRIBUTING.md`, `docs/testing.md`,
and `docs/checks.md` for commands and test coverage.

## Checks

`checks.json` maps every path to the checks it needs (rendered to
`docs/checks.md`). Run `npm run checks:for` to see what your changed files need
(or pass paths); after editing `checks.json`, run `npm run checks:tables`.

- Run `npm run check` (lint, unit tests, Firefox manifest lint) before handing
  work back. If it can't run, say which command failed and why.
- **Audio suites (`audio-hosted`, `audio-mac`):** changes needing these merge
  only once both pass on the PR's final commit with the branch up to date with
  `main`: both jobs in the hosted Audio suites workflow (it isn't a required
  check, so verify by hand that neither was skipped or canceled) and the Mac
  runs (`mac-audio-run` skill). Run audio suites one at a time with no other
  browser tests, always ask the owner before running the Firefox audio suite on
  Mac (it plays a tone through the Mac's sound output, which the owner sets),
  keep and explain any failure with its evidence before rerunning, and never
  treat them as a substitute for `listen`. New audible defects get a control in
  `e2e/audio-capture/history.js` (or an offline test like
  `e2e/ui/limiter.spec.js`).
- **Dependency audit (`dependency-audit`):** never use `npm audit fix`,
  overrides or downgrades just to make it pass. Adding or renewing
  `audit-exceptions.json` is the owner's decision in a PR (see
  `land-dependabot` skill).
- **Popup layout:** in `e2e/ui/popup-layout.spec.js`, add each new
  layout-affecting popup state to `STATES` and a control for each layout defect
  fixed to `CONTROLS` (see `popup-change` skill).

## Generated files

Never edit these by hand. Change the source, then regenerate:

| Files | Source | Command |
| --- | --- | --- |
| `dist/` | `extension/` | `npm run build:chromium`, `npm run build:firefox`, `npm run package` |
| `site/popup/popup.*`, `site/popup/settings.js` | `extension/popup.*`, `extension/settings.js` | `npm run site:popup` |
| `?v=` stamps in `site/*.html` | `site/styles.css`, `site/*.js` | `npm run site:stamp` |
| `docs/checks.md`, and "When it applies" in `RELEASE-CHECKLIST.md` | `checks.json` | `npm run checks:tables` |
| `extension/assets/icon*`, `store-assets/chrome/store-icon-128.png`, popup header mark | `scripts/render-icons.js` | `npm run icons` |
| `store-assets/screenshots/`, `store-assets/firefox/`, Chrome promo tile/marquee, `site/assets/og-card.png` | `scripts/render-store-assets.js`, popup, `store-assets/originals/`, cassette in `site/index.html`, `site/assets/fonts/fraunces.woff2` | `npm run store:assets` (needs macOS fonts) |

`npm test` fails when `site/popup/`, the `?v=` stamps, or files made from
`checks.json` are out of date.

## Rules

- **Settings:** defaults, ranges and presets live in `extension/settings.js`.
  Keep the copies in `youtube-main.js`, `spotify-main.js` and
  `spotify-bridge.js` in sync (enforced by tests); add new settings across all
  copies, popup controls and both audio graphs.
- **Limiter stage:** keep the block between the "Limiter stage" comments
  identical across `youtube-main.js`, `spotify-main.js` and `site/demo-audio.js`
  (enforced by tests; see `docs/testing.md`).
- **Privacy:** no network requests, analytics, telemetry, remote code or new
  permissions. Optional site permissions are requested only on user action.
  The website loads nothing from other sites.
- **Dependencies:** no runtime dependencies; exact-pinned dev tools; use `npm ci`.
- **Copy & trademarks:** plain non-technical voice for user-facing copy, no
  slogans, no em dashes (tests fail on them), and American spelling everywhere
  (including docs and code comments). Say "for YouTube™" and similar, never
  imply endorsement, and keep attribution lines.

## Releases

Never upload to a store. Use the `release` skill and `RELEASE-CHECKLIST.md` for
version bumps (`npm run version:set -- X.Y.Z`) and store packages
(`npm run release -- <commit>`). Add any new versioned file to `PLACES` in
`scripts/version-set.js`.

## Git

- Branch from `main` and open a PR; never push to `main`.
- Every new file needs a rule in `checks.json` (CI classifies browser tests
  from the base commit's `checks.json`).
- Resolve every review conversation before merging, and don't merge unless asked.
- PRs are squash-merged, so keep the PR title and description as plain prose
  describing the final change and why (with the template's HTML comment removed).
