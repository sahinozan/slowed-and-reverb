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
fails for every advisory it finds, including the one below, and isn't one of
the checks a pull request needs.

### Known advisory with no fix yet

**node-forge 1.4.0:
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
(CVE-2026-85393).** Checked on October 23, 2026. node-forge up to 1.4.0
accepts RSA PKCS#1 v1.5 signatures with extra elements nested in their digest
algorithm, which can let a forged signature pass for some keys. It is
installed through
web-ext 10.8.0, which depends on @devicefarmer/adbkit 3.3.9, which depends on
node-forge 1.4.0. No fixed node-forge had been published. The only change npm
suggests, web-ext 5.1.0, is from 2020, comes with a much older linter and
predates the Manifest V3 and data-collection checks this project relies on.

The project's own use doesn't reach the affected check. adbkit verifies these
signatures only in its TCP-to-USB bridge, which listens for ADB connections
once a program creates and starts it (`createTcpUsbBridge`, or adbkit's
`usb-device-to-tcp` command). This project runs web-ext only to build and lint
the store packages, which doesn't use ADB. web-ext's Firefox for Android
runner, which this project doesn't use, uses adbkit only as a client and
doesn't start the bridge. Nothing in this repository calls adbkit.

The affected version is still installed, so this isn't a fix, and the audit
keeps reporting it. Look again when node-forge, adbkit or web-ext publishes a
fixed version or the advisory changes; when the versions of web-ext or adbkit,
or how they depend on node-forge, change; when the project starts using
web-ext's Android runner, adbkit directly, or anything that starts the bridge
or checks signatures or keys from somewhere else; or when the build starts
shipping anything from `node_modules`. If you find a way this project's own
use reaches it, report it privately as described above.
