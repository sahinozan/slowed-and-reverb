---
name: release
description: Steps for releasing a version of the extension. Covers the version bump pull request, building and checking the store packages with npm run release, finishing the draft release record, and what stays with the owner (the checks by hand and the uploads to the stores). Use when asked to prepare, build, check or finish a release, or to bump the version.
---

# Releasing a version

A release is two pieces of work: a pull request that raises the version, and
then the packages built from the commit it became on `main`. The owner
decides what goes into a release, does the checks by hand and uploads to the
stores. Never upload to a store or sign in to one.

## 1. The version bump

Open a pull request that raises the version:

```sh
npm run version:set -- X.Y.Z
```

It writes the new version everywhere it is kept, or nothing if it can't
write them all: the manifest, `package.json` and `package-lock.json`,
`VERSION` in the four scripts that carry one, the footer of every
`site/*.html` page, and a new entry in `site/changelog.html`. The list of
places is `PLACES` in `scripts/version-set.js`, which the release's check
reads too, so a new place goes there. The privacy policy isn't one of them: it changes only when what
the extension stores or sends does. Then the command prints what is left
to do by hand:

- the release notes, in place of the TODO comment in the new changelog
  entry, written for the people who use the extension. The tests fail until
  they are there;
- the Firefox release notes in `store-assets/LISTING.md`.

The Chrome store's summary is the manifest's `description` (132 characters
at most), so this is the only time it can change. If it does, change the
`description` in `extension/manifest.json` and in `package.json`, which a
test keeps equal, and the summary in `store-assets/LISTING.md`.

Then run `npm run checks:for`, do what it lists, and open the pull request as
`AGENTS.md` ("Git") says.

## 2. Build and check the packages

Once the bump is merged:

```sh
git fetch
npm run release -- <the commit on main>
```

Run no other tests on the machine until it ends: it runs `npm run check`,
the packaging and both browser tests one at a time, in a clean worktree of
the commit, and the browser tests are sensitive to timing. It needs macOS or
Linux, Playwright's Chromium and Firefox.

- Before anything else it checks that everything the bump touches shows the
  new version.
- It fails if a test or suite failed, was canceled, skipped or left to do, or
  if a test file stopped early or has no tests or suites of its own. It
  reads this from the results a second reporter
  (`scripts/node-test-results.js`) writes to a file of its own in the logs,
  not from what the tests print.
- When it passes, it writes `dist/packages/<version>/` in the main checkout,
  next to the earlier releases: the two packages, Firefox's source archive,
  `firefox-privacy-policy.txt`, a draft `RELEASE-<version>.txt` and each
  check's log in a `logs` folder. It never replaces a version folder that
  is there, even an empty one.
- When it fails, it names the scratch folder with its logs. Read them and
  explain the failure before running anything again. A fix goes through a
  pull request, and the release is built from the new commit.

`npm test` builds `dist/packages/*.zip` again, so the files to upload are
the ones in the version folder.

When `npm run check`, `npm run test:firefox` or `npm test` change in
`package.json`, change `TEST_SCRIPTS` in `scripts/release.js` to match (a
test checks it).

## 3. Finish the draft

Fill in each line marked TODO in `dist/packages/<version>/RELEASE-<version>.txt`:
the pull requests merged since the last release, why the archives' file
lists changed if they did, and what was checked by hand.

## 4. The checks by hand

These are the owner's, from `RELEASE-CHECKLIST.md`: the real sites, the
browsers' own prompts and real sound. Your part:

- Say which items of `RELEASE-CHECKLIST.md` ("When it applies") apply.
  Look at what changed since the last release and run
  `npm run checks:for -- <those files>`.
- Record what the owner reports in the draft's "checked by hand" line: the
  commit, each browser and its version, the operating system, the sound
  output, and each item as passed, failed or not applicable. A failed
  attempt is recorded too, not only the one that passed after it.

## 5. Hand over for the uploads

Tell the owner where the version folder is and what is in it. The listing
text is in `store-assets/LISTING.md`; the images are in `store-assets/`.

## 6. After both stores publish

The last item of `RELEASE-CHECKLIST.md` ("After publishing") is the owner's
too: installing from each store and playing one song. Add its result to the
record.
