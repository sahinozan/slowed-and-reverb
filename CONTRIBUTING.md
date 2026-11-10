# Contributing

How to set the project up, the commands, and how a pull request is checked.
[docs/testing.md](docs/testing.md) says what each test command covers,
[docs/checks.md](docs/checks.md) which checks a change needs, and
[AGENTS.md](AGENTS.md) the rules the code and the words follow.

## Setup

Needs Node >= 24.19 and npm 11.19.

```sh
npm ci                                     # install exactly what package-lock.json records
npx playwright install --no-shell chromium # once, for the browser tests in Chromium
```

Development tools are exact-versioned in `package.json` and
`package-lock.json`; use `npm ci` for normal setup rather than fetching tools
with `npx`. The project `.npmrc` disables dependency install scripts, rejects
Git and remote-tarball dependencies, and excludes releases less than seven
days old when resolving dependency updates. The extension itself has no
runtime dependencies.

## Where things are

The extension source lives in [extension/](extension/). Its manifest targets
Chromium. Target builds emit clean, allowlisted directories under `dist/`;
`npm run package` creates one upload ZIP per store in `dist/packages/`. The
Firefox version receives Firefox's MV3 background configuration and add-on
metadata during the build. Its data-collection declaration and optional
YouTube reload permissions target Firefox desktop 142+. Firefox Android is not
declared because it has not been tested.

The public website lives in [site/](site/README.md): static HTML, CSS, and a
few small scripts, with no build step, served at
[slowedreverbapp.com](https://slowedreverbapp.com). The store images and
listing text are in [store-assets/](store-assets/README.md).

## Commands

```sh
npm run lint              # ESLint 10, flat config, then CI's whitespace check over every tracked file
npm test                  # the unit tests: service worker, content, popup, and package tests
npm run test:watch        # rerun tests while developing
npm run check             # run every required local and store-package check
npm run checks:for        # print which checks the files you changed need (or the paths you give it), from checks.json
npm run checks:tables     # write docs/checks.md and the release checklist's "When it applies" items, from checks.json
npm run build:chromium    # emit dist/chromium/
npm run build:firefox     # emit dist/firefox/
npm run package           # build allowlisted ZIPs for both stores
npm run lint:firefox      # build, then validate with web-ext
npm run site:popup        # copy the current popup into the website after popup changes
npm run site:serve        # preview the website locally, served like Cloudflare
npm run site:stamp        # refresh the website's stylesheet and script version stamps
npm run audit:dependencies -- <folder> # ask the npm registry for advisories, development tools included
npm run version:set -- X.Y.Z # write a release's new version everywhere it goes, and say what is left to do by hand
npm run release -- <commit> # build, check and record a release's store packages from main
```

The tests that run in a browser, and the audio suites, are in
[docs/testing.md](docs/testing.md).

## Dependency updates

Review lockfile changes and run `npm run audit:dependencies -- <folder>`
before committing any intentional dependency update. It runs `npm audit` on
the lockfile with the development tools included, keeps npm's output in the
folder and summarizes each advisory once in `summary.md` there, with the
dependencies that bring it in. It prints only whether it found advisories and
where the summary is, or which file it couldn't write, so nothing from the
registry reaches the console, where GitHub Actions would read lines like
`::add-mask::` as commands.

It fails for any advisory not listed in
[`audit-exceptions.json`](audit-exceptions.json). That file holds the
advisories that have been looked at, have no usable fix yet, and don't reach
this project, each with the package and installed versions it covers, a
reason of a sentence or two, and a `reviewBy` date at most 90 days ahead. An
advisory on the list is let through only while every installed version of the
package is listed and the date hasn't passed, so a new version or a passed
date fails the audit until someone looks again. When the package is installed
at several versions, an entry lists all of them, even one the advisory doesn't
affect, since npm's report doesn't say which copy each advisory is about. An
entry that no longer matches anything installed fails it too, so the list
doesn't keep entries that aren't needed. Add or renew an entry only after
checking how the project uses the affected code, and put the fuller analysis
in the pull request that changes the list.

## Pull requests

Branch from `main` and open a pull request. `npm run checks:for` prints the
checks your change needs; run `npm run check` before asking for a review.

GitHub Actions runs `npm run check` for every change, and the browser tests on
disposable Ubuntu and Windows machines unless the change can't affect them.
The pull request's base commit decides that with its copies of `checks.json`,
the map of which checks a change needs, and of
`scripts/classify-ci-changes.js`, which reads it; changes to the workflows,
the classifier or the map always run them. A separate Dependency audit
workflow runs the audit every week and for dependency changes; it isn't one of
the checks a pull request needs.

Pull requests are squash-merged, so the title and description become the
commit message on `main`: plain prose about what changed and why.
