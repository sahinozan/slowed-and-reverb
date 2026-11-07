# Dependency advisories

The extension and the website ship none of this project's npm packages. The
build copies only the files listed in `scripts/build-extension.js`, and the
website has no build step. The packages are tools for building, linting and
testing, and their advisories are tracked too:
`npm run audit:dependencies -- <folder>` asks the npm registry about every
version in `package-lock.json`, development tools included, and the
Dependency audit workflow runs it every week and for dependency changes. It
fails for every advisory it finds, including the open ones below, and isn't
one of the checks a pull request needs.

This file lists the advisories that have been looked at but can't be fixed
yet, and why the project's own use doesn't reach them. Listing one here
doesn't silence it: the affected version is still installed, and the audit
keeps reporting it. If you find a way this project's own use reaches one,
report it privately as described in [SECURITY.md](SECURITY.md).

## Open

| Package | Advisory | Brought in by | Fixed version | Checked |
| --- | --- | --- | --- | --- |
| minimatch 10.2.6 (and 10.2.5 inside Playwright) | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | ESLint, Playwright | None compatible | November 6, 2026 |
| deepmerge 4.3.1 | [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) | web-ext | None | October 29, 2026 |

### minimatch: GHSA-g3hv-75wg-m249

CVE-2026-118764.

**The problem.** minimatch 7.0.0 up to 11.0.0 can turn a glob pattern with
`**/../` parts into more and more copies of itself while simplifying it, then
compare every copy with every other, so a crafted pattern can use a great
deal of time and memory.

**Where it's installed.** 10.2.6 is installed through ESLint 10.13.0 and its
@eslint/config-array 0.23.5. Playwright 1.64.1, through @playwright/test,
also bundles an affected minimatch, 10.2.5, inside its own files, where npm's
audit doesn't see it.

**Why there's no fix.** The fix is only in minimatch 11, a new major version,
and the latest versions of both ESLint and @eslint/config-array still ask for
minimatch 10 (ESLint 10.14.0 asks for `^10.2.6`), so no compatible fixed
version exists. The only change npm suggests, ESLint 9.39.5, goes back to the
previous major version just to leave out the affected minimatch.

**Why it doesn't affect this project.** The affected code runs only when a
caller asks for minimatch's most aggressive simplification
(`optimizationLevel` 2 or more), which is meant for walking folders; the
default is 1. None of ESLint, @eslint/config-array and Playwright sets it.
The patterns also come only from this repository and the tools themselves:

- For ESLint, they are `eslint.config.js`, the `eslint .` in `npm run lint`,
  and ESLint's built-in defaults, such as leaving out `node_modules`.
- For Playwright, they are the `testMatch` patterns in `playwright.config.js`
  and `playwright.ui.config.js`, the file names given to `playwright test`,
  and the `.gitignore` files in the repository's test folders.

Nothing in this repository calls minimatch or takes glob patterns from anyone
else.

**Look again when:**

- minimatch publishes a fixed 10 version, or the advisory changes;
- ESLint, @eslint/config-array or Playwright move to a fixed minimatch, or
  their versions or how they call it change, especially if one starts setting
  `optimizationLevel`;
- another package brings in an affected minimatch;
- the project starts taking ESLint's or Playwright's patterns from outside the
  repository, or using minimatch directly; or
- the build starts shipping anything from `node_modules`.

### deepmerge: GHSA-gcqx-w48m-w2h4

**The problem.** deepmerge 4.2.0 to 4.3.1 can copy a `__proto__` key from an
object being merged into the prototype of the object it returns, so
properties the caller didn't set show up when they are read without an
own-property check.

**Where it's installed.** Through web-ext 10.8.0, which depends on
addons-linter 10.14.0, which depends on deepmerge 4.3.1.

**Why there's no fix.** 4.3.1, from March 2023, is deepmerge's latest
version, so no fixed version exists. The only change npm suggests, web-ext
3.2.1, is from 2019, comes with a much older linter and predates the Manifest
V3 and data-collection checks this project relies on.

**Why it doesn't affect this project.** addons-linter uses deepmerge only
when it prepares the schemas it checks `manifest.json` against: it merges the
Firefox schemas bundled in its own code with fixed objects written in that
code, and with the range of manifest versions web-ext sets (2 to 3). Neither
the bundled schemas nor those objects have a `__proto__`, `constructor` or
`prototype` key. Nothing from the extension's own files is merged: the
manifest and the other files are only checked against the result. Nothing in
this repository calls deepmerge or passes addons-linter schemas of its own.

**Look again when:**

- deepmerge, addons-linter or web-ext publishes a fixed version, or the
  advisory changes;
- the versions of web-ext or addons-linter, or how they use deepmerge,
  change;
- the project starts running addons-linter with schemas of its own, or using
  deepmerge directly; or
- the build starts shipping anything from `node_modules`.

## Closed

- **node-forge 1.4.0,
  [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)**,
  installed through web-ext and @devicefarmer/adbkit. Listed until November
  3, 2026. That advisory and eleven more published on October 30, 2026 cover
  node-forge 1.4.0 and earlier. node-forge 1.4.2, which fits adbkit's
  `^1.3.1`, fixes them all, and the project now installs it.
- **minimatch 3.1.5, GHSA-g3hv-75wg-m249**, installed through web-ext 10.8.0
  (in multimatch 6.0.0 and in addons-linter 10.14.0's ESLint 9.39.4,
  @eslint/config-array 0.21.2 and @eslint/eslintrc 3.3.7). Listed until
  November 4, 2026, when the advisory was narrowed to 7.0.0 and later. It
  doesn't have the affected code.

## Adding an entry

Add a row to the table and a section with the same five parts: the problem,
where it's installed (the full chain of dependencies), why there's no fix
(including why npm's suggested change isn't taken), why the project's own use
doesn't reach it, and when to look again. When an advisory is fixed or no
longer applies, move it to "Closed" with the date and the reason.
