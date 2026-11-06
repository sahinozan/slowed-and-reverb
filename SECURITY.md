# Security Policy

## Supported versions

Security fixes are provided for the latest version available through the Chrome
Web Store and Firefox Add-ons. Update to the latest store version before reporting
a problem that may already have been resolved.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Email
[slowedandreverbsupport@proton.me](mailto:slowedandreverbsupport@proton.me) with:

- the affected browser and extension version;
- a concise description of the impact;
- the shortest reliable reproduction steps; and
- any proof of concept with secrets and personal data removed.

Please allow time to investigate before disclosing the issue publicly. You will
receive an acknowledgment, followed by an assessment or a request for additional
information. This project does not currently operate a paid bug-bounty program.

For ordinary bugs and feature requests, use the public issue tracker described in
[SUPPORT.md](SUPPORT.md).

## Development dependencies

The extension and the website ship none of this project's npm packages. The
build copies only the files listed in `scripts/build-extension.js`, and the
website has no build step. The packages are tools for building, linting and
testing, and their advisories are tracked too:
`npm run audit:dependencies -- <folder>` asks the npm registry about every
version in `package-lock.json`, development tools included, and the
Dependency audit workflow runs it every week and for dependency changes. It
fails for every advisory it finds, including the ones below, and isn't one of
the checks a pull request needs.

node-forge, installed through web-ext and @devicefarmer/adbkit, was listed
below until November 3, 2026, for
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
That advisory and eleven more published on October 30, 2026 cover node-forge
1.4.0 and earlier. node-forge 1.4.2, which fits adbkit's `^1.3.1`, fixes them
all, and the project now installs it.

### Known advisories with no fix yet

**minimatch 10.2.6, and 10.2.5 inside Playwright:
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
(CVE-2026-118764).** Checked on November 6, 2026. minimatch 7.0.0 up to
11.0.0 can turn a glob pattern with `**/../` parts into more and more copies
of itself while simplifying it, then compare every copy with every other, so
a crafted pattern can use a great deal of time and memory. 10.2.6 is
installed through ESLint 10.13.0 and its @eslint/config-array 0.23.5. The fix
is only in minimatch 11, a new major version, and the latest versions of both
still ask for minimatch 10 (ESLint 10.14.0 asks for `^10.2.6`), so no
compatible fixed version exists. The only change npm suggests, ESLint 9.39.5,
goes back to the previous major version just to leave out the affected
minimatch. Playwright 1.64.1, through @playwright/test, also bundles an
affected minimatch, 10.2.5, inside its own files, where npm's audit doesn't
see it.

minimatch 3.1.5, installed through web-ext 10.8.0 (in multimatch 6.0.0 and
in addons-linter 10.14.0's ESLint 9.39.4, @eslint/config-array 0.21.2 and
@eslint/eslintrc 3.3.7), was listed too until November 4, 2026, when the
advisory was narrowed to 7.0.0 and later. It doesn't have the affected code.

The project's own use doesn't reach it. The affected code runs only when a
caller asks for minimatch's most aggressive simplification
(`optimizationLevel` 2 or more), which is meant for walking folders; the
default is 1. None of ESLint, @eslint/config-array and Playwright sets it.
The patterns also come only from this repository and the tools themselves.
For ESLint, they are `eslint.config.js`, the `eslint .` in `npm run lint`,
and ESLint's built-in defaults, such as leaving out `node_modules`. For
Playwright, they are the `testMatch` patterns in `playwright.config.js` and
`playwright.ui.config.js`, the file names given to `playwright test`, and
the `.gitignore` files in the repository's test folders. Nothing in
this repository calls minimatch or takes glob patterns from anyone else.

The affected versions are still installed, so this isn't a fix, and the audit
keeps reporting ESLint's copy. Look again when minimatch publishes a fixed 10
version or the advisory changes; when ESLint, @eslint/config-array or
Playwright move to a fixed minimatch, or their versions or how they call it
change, especially if one starts setting `optimizationLevel`; when another
package brings in an affected minimatch; when the project starts taking
ESLint's or Playwright's patterns from outside the repository, or using
minimatch directly; or when the build starts shipping anything from
`node_modules`. If you find a way this project's own use reaches it, report
it privately as described above.

**deepmerge 4.3.1:
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).**
Checked on October 29, 2026. deepmerge 4.2.0 to 4.3.1 can copy a
`__proto__` key from an object being merged into the prototype of the
object it returns, so properties the caller didn't set show up when they are
read without an own-property check. It is installed through web-ext 10.8.0,
which depends on addons-linter 10.14.0, which depends on deepmerge 4.3.1.
4.3.1, from March 2023, is deepmerge's latest version, so no fixed version
exists. The only change npm suggests, web-ext 3.2.1, is from 2019, comes with
a much older linter and predates the Manifest V3 and data-collection checks
this project relies on.

The project's own use doesn't reach it. addons-linter uses deepmerge only
when it prepares the schemas it checks `manifest.json` against: it merges
the Firefox schemas bundled in its own code with fixed objects written in
that code, and with the range of manifest versions web-ext sets (2 to 3).
Neither the bundled schemas nor those objects have a `__proto__`,
`constructor` or `prototype` key. Nothing from the extension's own files is
merged: the manifest and the other files are only checked against the result.
Nothing in this repository calls deepmerge or passes addons-linter schemas of
its own.

The affected version is still installed, so this isn't a fix, and the audit
keeps reporting it. Look again when deepmerge, addons-linter or web-ext
publishes a fixed version or the advisory changes; when the versions of
web-ext or addons-linter, or how they use deepmerge, change; when the project
starts running addons-linter with schemas of its own, or using deepmerge
directly; or when the build starts shipping anything from `node_modules`. If
you find a way this project's own use reaches it, report it privately as
described above.
