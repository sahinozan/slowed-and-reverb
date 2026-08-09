# Repository checks

After changing source code, tests, manifests, or build scripts, run `npm test`.
Before handing work back, run `npm run check`. Report the exact failing command if
the full check cannot run. Generate `dist/firefox` with `npm run build:firefox`;
do not edit generated files directly.
