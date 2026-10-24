#!/usr/bin/env bash
# Package downloads for the audio workflow's disposable GitHub-hosted Ubuntu
# runners (.github/workflows/audio-capture-trial.yml). Their Azure mirror,
# azure.archive.ubuntu.com, sent the sound server's packages at 40 to
# 100 kB/s, so installing them outlasted the job. This points only that
# mirror at Ubuntu's own archive, over HTTPS; APT still checks the archive's
# signed indexes and every package's hash against them, as before. It also
# gives up on a stalled download after 30 seconds and tries it twice more:
# downloads are retried, never a test.
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "$(uname -s)" != Linux ]]; then
  echo 'This is only for a disposable Linux runner on GitHub Actions.' >&2
  exit 1
fi

sudo python3 - <<'PY'
from pathlib import Path

paths = [Path('/etc/apt/apt-mirrors.txt'), Path('/etc/apt/sources.list')]
paths += sorted(Path('/etc/apt/sources.list.d').glob('*.sources'))
paths += sorted(Path('/etc/apt/sources.list.d').glob('*.list'))
for path in paths:
    if not path.is_file():
        continue
    before = path.read_text()
    after = before
    for scheme in ('http', 'https'):
        after = after.replace(f'{scheme}://azure.archive.ubuntu.com/ubuntu', 'https://archive.ubuntu.com/ubuntu')
    if after != before:
        path.write_text(after)
        print(f'{path}: azure.archive.ubuntu.com replaced by https://archive.ubuntu.com')
PY

sudo tee /etc/apt/apt.conf.d/80-audio-ci-downloads >/dev/null <<'APT'
Acquire::Retries "2";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT

# What APT will use, for the job's log.
grep -rhs 'archive.ubuntu.com' /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/ || true
