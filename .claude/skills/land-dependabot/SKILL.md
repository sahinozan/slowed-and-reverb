---
name: land-dependabot
description: Steps for checking and landing one of Dependabot's pull requests (updates to the development tools in package.json and package-lock.json, or to the GitHub Actions in the workflows). They are merged by hand, one at a time, after the runs their files need. Use when asked to look at, check, rebase or merge a Dependabot pull request or a dependency update.
---

# Landing a Dependabot pull request

Dependabot opens grouped pull requests each week: the browser drivers
(`@playwright/test`, `puppeteer-core`), the other development tools, and the
GitHub Actions (`.github/dependabot.yml`). Nothing merges them by itself.
Take one at a time: each merge changes `main` under the others.

1. **Read it.** `gh pr view <number>` and `gh pr diff <number>`. For npm it
   should change only `package.json` and `package-lock.json`, with exact
   versions; for Actions, only the pinned actions in `.github/workflows/`.
   Read the release notes it quotes for anything that changes how the tests
   or the build behave.
2. **See what it needs.** `npm run checks:for -- <the files it changes>`
   lists the checks. For the lockfile that includes the hosted audio suites
   and the dependency audit; for a workflow, every check CI decides.
3. **Bring it up to date with `main`.** If it is behind, comment
   `@dependabot rebase` on it and wait for the new commit. The runs count
   only on the final commit.
4. **Check the runs on that commit.**
   - CI's required check, "Lint, test, and package".
   - The "Audio suites" workflow when the map asks for `audio-hosted`: both
     jobs passed, none skipped or canceled. It isn't a required check, so
     look.
   - The "Dependency audit" workflow when the map asks for
     `dependency-audit`: it passed. If not, run
     `npm run audit:dependencies -- <folder>` on the branch and read the
     `summary.md` it writes.
   - If the map asks for `audio-mac`, use the `mac-audio-run` skill.
5. **If the audit finds an advisory**, stop and tell the owner what it is
   and whether the project's own use reaches the affected code. Adding or
   renewing an entry in `audit-exceptions.json` is the owner's decision,
   made in a pull request with the analysis in it. Don't use
   `npm audit fix`, overrides or downgrades to make it pass.
6. **If a run fails**, keep its evidence and explain it before running
   anything again, and tell the owner what the update changed.
7. **Ask the owner** for permission to merge, with what ran and on which
   commit. Merge only after a yes in this session, with every review
   conversation resolved. Pull requests are squash-merged, so its title and
   description become the commit message: make sure they still say what the
   final change is.
8. **After the merge**, the next Dependabot pull request needs its own
   rebase and runs.

When a browser driver's version changes, the browsers it downloads change
with it: `npx playwright install --no-shell chromium` before running the
browser tests locally.
