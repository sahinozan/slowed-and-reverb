# Which checks a change needs

<!-- Made from checks.json by npm run checks:tables. Don't edit this page. -->

The rule is written once, in `checks.json`, and this page is made from it. `npm run checks:for` prints what the files you changed need, so you don't have to find the rows yourself. CI decides its browser tests from the same map, and the audio and dependency audit workflows start for the paths it gives them.

## The checks

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

## What a change needs

Find the first row that matches each file you changed, a removed or renamed file's old path included. A change needs `repo` and the checks of every file it touches.

| A change to | What it is | Needs, besides `repo` |
| --- | --- | --- |
| `.github/workflows/audio-capture-trial.yml` | The audio workflow, which is also one of the workflows below. | `extension`, `ui`, `site`, `audio-hosted` |
| `.github/workflows/dependency-audit.yml` | The dependency audit's workflow, which is also one of the workflows below. | `extension`, `ui`, `site`, `dependency-audit` |
| `.github/workflows/**`, `checks.json`, `scripts/classify-ci-changes.js` | What decides and enforces which checks run: the workflows (Dependabot's action updates included), the classifier and this map. A change to them runs every check CI decides. | `extension`, `ui`, `site` |
| `**/*.md`, `LICENSE` | Documentation, wherever it is, the store text and the privacy policy included. A change only to the audio suite's documentation needs none of its runs. | nothing more |
| `.npmrc` | npm's settings, which decide what every job's install and the audit read. | `extension`, `ui`, `site`, `dependency-audit` |
| `.gitattributes` | How git writes files out in a checkout, line endings included. The browser tests also run on Windows, where the repository checks don't. | `extension`, `ui`, `site` |
| `.agents/skills`, `.claude/launch.json`, `.claude/settings.json`, `.codex/hooks.json`, `.github/**`, `.gitignore`, `eslint.config.js`, `scripts/agent-hooks/**`, `scripts/check-whitespace.js`, `scripts/checks-for.js`, `scripts/node-test-results.js`, `scripts/release.js`, `scripts/render-checks-tables.js`, `scripts/render-icons.js`, `scripts/render-store-assets.js`, `scripts/stamp-site-assets.js`, `scripts/sync-site-popup.js`, `scripts/version-set.js`, `tests/**`, `wrangler.jsonc` | Repository, editor and coding-agent settings, the agents' hooks and Codex's link to their skills, the unit tests, and the tools that check, render or release, which no browser test loads. | nothing more |
| `store-assets/**` | The store's images and the captures they are made from. The listing text is documentation. | `store-art-look` |
| `extension/spotify-main.js`, `extension/youtube-main.js` | The audio engines. The limiter stage in them is part of what the popup and limiter tests render. | `extension`, `ui`, `audio-hosted`, `audio-mac`, `listen` |
| `extension/background.js`, `extension/content.js`, `extension/spotify-bridge.js` | The background script and the content scripts. | `extension`, `audio-hosted`, `audio-mac`, `listen`, `permission-steps` |
| `extension/settings.js` | The settings: defaults, ranges and presets. The background script, the content script and the popup load them, and the website has a copy. | `extension`, `ui`, `site`, `audio-hosted`, `listen`, `site-popup-sync` |
| `extension/manifest.json` | The manifest, which decides what is injected where and which access the extension may ask for. | `extension`, `audio-hosted`, `permission-steps` |
| `extension/popup.html`, `extension/popup.js` | The popup's page and script. The audio suites never open the popup, so they don't run for it; what it sends to the tab, and how often, can still change the sound. | `extension`, `ui`, `site`, `listen`, `permission-steps`, `site-popup-sync` |
| `extension/popup.css` | The popup's styles. | `extension`, `ui`, `site`, `firefox-frame-look`, `site-popup-sync` |
| `extension/assets/*.png`, `extension/assets/*.svg` | The icons, which scripts/render-icons.js makes. They are pictures: a script put among them has no rule. | `extension` |
| `e2e/audio-capture/**` | The audio suite. No browser test loads it. | `audio-hosted`, `audio-mac` |
| `e2e/extension-copy.js`, `e2e/firefox-launch.js` | What the audio suites share with the extension's browser tests: the disposable copy of the build and starting Firefox. | `extension`, `audio-hosted` |
| `scripts/request-target.js` | What every local test server reads its request targets with, the audio suites' included. | `extension`, `ui`, `site`, `audio-hosted` |
| `.nvmrc`, `package-lock.json`, `package.json` | Dependencies and the Node.js version. They can change any test's result. | `extension`, `ui`, `site`, `audio-hosted`, `dependency-audit` |
| `scripts/ci-package-downloads.sh` | What the browser and audio jobs set up their package downloads with. | `extension`, `ui`, `site`, `audio-hosted` |
| `scripts/ci-install-firefox.sh`, `scripts/firefox-release.js` | What the audio jobs choose and install a Firefox with. | `audio-hosted` |
| `e2e/extension.spec.js`, `e2e/firefox-shutdown.js`, `e2e/fixtures.js`, `playwright.config.js` | The extension's browser tests. | `extension` |
| `scripts/build-extension.js` | The build of the store packages, which the extension's browser tests and the audio suites load. It adds Firefox's permissions. | `extension`, `audio-hosted`, `permission-steps` |
| `e2e/popup-geometry.js` | What measures the popup for both the extension's browser test and the popup's layout tests. | `extension`, `ui` |
| `e2e/limiter-stage.js`, `e2e/ui/**`, `playwright.ui.config.js`, `scripts/popup-preview.js`, `scripts/serve-site.js` | The popup, limiter and website tests, and what serves the popup and the website to them. | `ui`, `site` |
| `site/demo-audio.js` | The website's demo, which has its own copy of the limiter stage. | `ui`, `site` |
| `site/**` | The website. | `site` |
| `audit-exceptions.json`, `scripts/dependency-audit.js` | The dependency audit and the advisories it lets through. | `dependency-audit` |
| any other path | A path the map doesn't know. | `extension`, `ui`, `site`, and a rule in `checks.json` |
