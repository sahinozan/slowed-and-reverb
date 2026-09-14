# Repository checks

After changing source code, tests, manifests, or build scripts, run `npm test`.
Before handing work back, run `npm run check`. Report the exact failing command if
the full check cannot run. Generate `dist/firefox` with `npm run build:firefox`;
do not edit generated files directly.

## Profiling storage

Use `python3 "$HOME/Documents/Codex/tools/profiling-guard/storage_guard.py" record`
for Instruments recordings on this Mac, with a new `--output PATH.trace` and a
bounded `--time-limit` of at most 60 seconds. The shared guard checks free space,
limits new scratch data, and removes only a verified temporary file from that
recording. Preserve saved baselines, reports, failed recordings, and all existing
or ambiguous files. Read the adjacent `*.trace.storage.json` after each run.
Do not use broad temporary-folder cleanup or bypass a storage-limit failure.
