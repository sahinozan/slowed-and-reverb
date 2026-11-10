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

Which checks a change needs is written once, in `checks.json`, and the two
tables below are made from it. The first lists the checks. In the second,
find the first row that matches each file you changed, a removed or renamed
file's old path included: a change needs `repo` and the checks of every file
it touches. CI decides its browser tests from the same map, and the audio and
dependency audit workflows start for the paths it gives them (tests keep
their `paths:` equal to it). To change the rule, change `checks.json`, then
run `npm run checks:tables`.

<!-- Made from checks.json by npm run checks:tables. Don't edit between these two lines. -->
| Check | Run by | What to do |
| --- | --- | --- |
| `repo` | CI's required check | `npm run check`. Lint, the unit tests and Firefox's lint of the build. |
| `extension` | CI's required check | `npm run test:e2e`, `npm run test:firefox`. The real extension in Chromium and in the installed Firefox. |
| `ui` | CI's required check | `npm run test:ui`. The popup's layout in each state and the limiter stage, in Chromium and in Firefox's engine. |
| `site` | CI's required check | `npm run test:ui`. The website and its demo, which the same command checks. |
| `audio-hosted` | its own workflow (`audio-capture-trial.yml`) | Both jobs of the Audio suites workflow passed on the pull request's final commit, none skipped or canceled. GitHub starts it by itself. It isn't a required check, so look. |
| `audio-mac` | by hand | `AUDIO_REGRESSION_MUTE=1 npm run test:audio:chromium`, `npm run test:audio:firefox`. The audio suites on this Mac, on the pull request's final commit, one at a time. Firefox plays the tone aloud, so ask first. |
| `dependency-audit` | its own workflow (`dependency-audit.yml`) | `npm run audit:dependencies -- <folder>`. Read the `summary.md` it writes in the folder. The Dependency audit workflow runs it on the pull request too. It isn't a required check, so look. |
| `listen` | by hand, when a change can affect how the effect sounds (the audio graph's wiring, an effect's code, gains, fades, presets or defaults, what the popup sends to the tab and how often, or a browser change to Web Audio) | Listen to how the effect sounds, with music, in both browsers. Its steps are in `RELEASE-CHECKLIST.md`, "When it applies". |
| `firefox-frame-look` | by hand, when the popup's frame changed in CSS | Look at the real popup in Firefox, with its rounded panel corners. |
| `permission-steps` | by hand, when the permission code changed (the manifest's permissions, or how the extension asks for access or handles it) | The permission and revoking steps, in each browser, also outside a release. Its steps are in `RELEASE-CHECKLIST.md`, "When it applies". |
| `store-art-look` | by hand, when there is new store art | Look at each image at the size the store shows it (`store-assets/README.md`). |
| `site-popup-sync` | by hand | `npm run site:popup`. Copy the popup into the website. The tests fail while the copy is out of date. |

| A change to | Needs, besides `repo` |
| --- | --- |
| `.github/workflows/audio-capture-trial.yml` | `extension`, `ui`, `site`, `audio-hosted` |
| `.github/workflows/dependency-audit.yml` | `extension`, `ui`, `site`, `dependency-audit` |
| `.github/workflows/**`, `checks.json`, `scripts/classify-ci-changes.js` | `extension`, `ui`, `site` |
| `**/*.md`, `LICENSE` | nothing more |
| `.npmrc` | `extension`, `ui`, `site`, `dependency-audit` |
| `.gitattributes` | `extension`, `ui`, `site` |
| `.claude/launch.json`, `.github/**`, `.gitignore`, `eslint.config.js`, `scripts/check-whitespace.js`, `scripts/node-test-results.js`, `scripts/release.js`, `scripts/render-checks-tables.js`, `scripts/render-icons.js`, `scripts/render-store-assets.js`, `scripts/stamp-site-assets.js`, `scripts/sync-site-popup.js`, `tests/**`, `wrangler.jsonc` | nothing more |
| `store-assets/**` | `store-art-look` |
| `extension/spotify-main.js`, `extension/youtube-main.js` | `extension`, `ui`, `audio-hosted`, `audio-mac`, `listen` |
| `extension/background.js`, `extension/content.js`, `extension/spotify-bridge.js` | `extension`, `audio-hosted`, `audio-mac`, `listen`, `permission-steps` |
| `extension/settings.js` | `extension`, `ui`, `site`, `audio-hosted`, `listen`, `site-popup-sync` |
| `extension/manifest.json` | `extension`, `audio-hosted`, `permission-steps` |
| `extension/popup.html`, `extension/popup.js` | `extension`, `ui`, `site`, `listen`, `permission-steps`, `site-popup-sync` |
| `extension/popup.css` | `extension`, `ui`, `site`, `firefox-frame-look`, `site-popup-sync` |
| `extension/assets/*.png`, `extension/assets/*.svg` | `extension` |
| `e2e/audio-capture/**` | `audio-hosted`, `audio-mac` |
| `e2e/extension-copy.js`, `e2e/firefox-launch.js` | `extension`, `audio-hosted` |
| `scripts/request-target.js` | `extension`, `ui`, `site`, `audio-hosted` |
| `.nvmrc`, `package-lock.json`, `package.json` | `extension`, `ui`, `site`, `audio-hosted`, `dependency-audit` |
| `scripts/ci-package-downloads.sh` | `extension`, `ui`, `site`, `audio-hosted` |
| `scripts/ci-install-firefox.sh`, `scripts/firefox-release.js` | `audio-hosted` |
| `e2e/extension.spec.js`, `e2e/firefox-shutdown.js`, `e2e/fixtures.js`, `playwright.config.js` | `extension` |
| `scripts/build-extension.js` | `extension`, `audio-hosted`, `permission-steps` |
| `e2e/popup-geometry.js` | `extension`, `ui` |
| `e2e/limiter-stage.js`, `e2e/ui/**`, `playwright.ui.config.js`, `scripts/popup-preview.js`, `scripts/serve-site.js` | `ui`, `site` |
| `site/demo-audio.js` | `ui`, `site` |
| `site/**` | `site` |
| `audit-exceptions.json`, `scripts/dependency-audit.js` | `dependency-audit` |
| any other path | `extension`, `ui`, `site`, and a rule in `checks.json` |
<!-- The end of the part made from checks.json. -->

- After changing code, tests, the manifest or scripts, run `npm test`.
- Before handing work back, run `npm run check`. If it can't run, say which
  command failed and why.
- `npm run test:e2e` runs the real extension in Chromium, and
  `npm run test:firefox` checks in the installed Firefox that the effects
  stop when the extension is turned off, that Spotify's own speed resets
  don't cause silent gaps, and that an update keeps the previous version's
  audio engines off until the page is reloaded.
- `npm run test:audio:chromium` and `npm run test:audio:firefox` are the
  audio regression suite: they record the engines' real audio through changes
  of settings, Spotify's speed changes, turning the extension off, removing
  and updating it, and put back each audible defect fixed so far to show it
  is caught. Run them as well as listening: they don't replace that yet.
  "What it can replace" in the README below says what would have to be shown
  first. A change the table gives `audio-hosted` and `audio-mac` merges only
  once both suites have passed on the pull request's final commit, with the
  branch up to date with `main` (the workflow tests the branch merged into
  `main`): in the pull request's audio workflow, both jobs, none skipped or
  canceled, and on this Mac, Chromium muted (`AUDIO_REGRESSION_MUTE=1`) and
  Firefox, which plays the tone aloud, so ask first. A commit pushed after
  the runs needs runs of its own. A failure is kept with its evidence and
  explained before anything is run again, then fixed, or accepted in writing
  in the pull request; a run that passes later doesn't cancel it, and an
  accepted failure still needs a passing run before the merge. The audio
  workflow isn't a required check, so this is followed by hand. It doesn't
  start for the popup's files or the icons: the suites drive the background
  script themselves and never open the popup, so a change to its files can't
  change what they record, and the icons are only the pictures on the
  toolbar's button. The listen (`listen` in the table) is for any change
  that can affect how the effect sounds, not only a change of values.
  `npm run test:audio-trial:chromium` and `npm run test:audio-trial:firefox`
  are the experiment the suite is built on. All four are described in
  `e2e/audio-capture/README.md`. They aren't part of `npm run check`, CI's
  required check or releases, and they need a sound device (on Linux, a
  PulseAudio or PipeWire sink). Run them one at a time, with no other browser
  tests. A new audible defect gets a control in
  `e2e/audio-capture/history.js`. One the suite's song (two quiet low tones)
  can't set off gets a silent test with a control of its own instead, as the
  limiter's reaction to treble in Firefox has in `e2e/ui/limiter.spec.js`.
- `npm run audit:dependencies -- <folder>` runs `npm audit` on the lockfile,
  development tools included, and writes a `summary.md` there to read; it
  prints only how the audit ended. It fails for any advisory not reviewed in
  `audit-exceptions.json`, for an entry whose `reviewBy` date has passed and
  for one no longer needed. Add or renew an entry only after checking that
  the project's own use doesn't reach the affected code: a reason of a
  sentence or two, a date at most 90 days ahead, and the fuller analysis in
  the pull request, where the user decides. It isn't part of `npm run check`,
  CI's required check or releases; the Dependency audit workflow runs it
  weekly too. Don't use `npm audit fix`, overrides or downgrades just to make
  it pass.
- `npm run test:ui` renders the popup page in Chromium and in the installed
  Firefox's engine, Gecko, in each state that changes its layout (presets,
  tabs, themes, notices, reload and permission panels), and checks that it
  fits 340px wide without scrolling, with every control on screen. It also
  checks the website from `site/`: the demo plays, pauses and follows the
  popup, the theme carries over, the embedded popup is sized right on a
  desktop and a phone, and no page requests anything from another site.
  Playing the demo in Firefox needs a sound device (on Linux, a PulseAudio or
  PipeWire sink); CI's Windows runners have none, so there the tests tagged
  `@playback` run in Chromium only. It also renders the limiter stage of both
  engines and the website's demo in both browsers, offline and without sound,
  and checks that sound under the limiter's threshold is left alone whatever
  its pitch, and that the defect is heard when it is put back. A new popup
  state that changes the layout gets an entry in `STATES` in
  `e2e/ui/popup-layout.spec.js`; a layout defect fixed gets a control there.
  In Chromium, `npm run test:e2e` also checks the installed extension's popup
  this way and saves a screenshot.
- These are pages, not the browser's popup window, so Firefox's rounded panel
  corners (see the `@supports (-moz-appearance: none)` rule in `popup.css`)
  and the browsers' own permission dialogs aren't drawn. That is why the
  table has `firefox-frame-look`. For other states, render the popup with the
  helpers in `scripts/popup-preview.js`, as the store-art script and the
  tests do.

## Generated files

Never edit these by hand. Change the source, then regenerate:

| Files | Source | Command |
| --- | --- | --- |
| `dist/` | `extension/` | `npm run build:chromium`, `npm run build:firefox`, `npm run package` |
| `site/popup/popup.*`, `site/popup/settings.js` | `extension/popup.*`, `extension/settings.js` | `npm run site:popup` |
| `?v=` stamps in `site/*.html` | `site/styles.css`, `site/*.js` | `npm run site:stamp` |
| The tables under "Checks" above, and the items under "When it applies" in `RELEASE-CHECKLIST.md` | `checks.json` | `npm run checks:tables` |
| `extension/assets/icon*`, `store-assets/chrome/store-icon-128.png`, the popup's header mark | `scripts/render-icons.js` | `npm run icons` |
| `store-assets/screenshots/`, `store-assets/firefox/`, the promo tile and marquee in `store-assets/chrome/`, `site/assets/og-card.png` | `scripts/render-store-assets.js`, the popup, the captures in `store-assets/originals/`, the cassette in `site/index.html`, `site/assets/fonts/fraunces.woff2` | `npm run store:assets` (needs macOS fonts) |

The tests fail when the site's popup copy or stamps, or the tables made from
`checks.json`, are out of date.

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
- **Limiter stage:** the limiter is the same text in `youtube-main.js`,
  `spotify-main.js` and `site/demo-audio.js`, between the "Limiter stage"
  comments, and a test keeps the copies equal. Firefox's compressor reacts to
  treble as if it were louder than it is (it has filters Chromium removed);
  in Firefox the stage puts a filter each side of the limiter to cancel them,
  and checks once that the compressor has them, leaving the limiter as it
  was if not. Change all three together.
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

The checks done by hand for a release are in `RELEASE-CHECKLIST.md`,
including installing from both stores once they publish. Record them in the
draft's "checked by hand" line. Some of its "When it applies" items, which
are made from `checks.json` too, apply outside a release as well:
`permission-steps` and `listen` in the table under "Checks".

## Git

Branch from `main` and open a pull request; don't push to `main`. CI's
required check is "Lint, test, and package". It needs `npm run check` to pass
for every change, and the browser tests too unless the base commit's
`checks.json`, the map of which checks a change needs, says the change can't
affect them (`scripts/classify-ci-changes.js` reads it); changing the
workflows, the classifier or the map always runs them. A new file needs a
rule in `checks.json`: a test fails until it has one, and CI runs every
check for a path the map doesn't know. Every review conversation
must be resolved before merging. Don't merge unless asked. Commit messages
and pull request descriptions are plain prose about what changed and why.

Pull requests are squash-merged, the only method the repository allows: each
becomes one commit on `main` whose message is the pull request's title and
description. So before merging, make sure they describe the final change,
not the first draft, and remove the template's comment.
