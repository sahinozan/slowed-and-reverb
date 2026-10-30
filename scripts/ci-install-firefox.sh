#!/usr/bin/env bash
# Installs one Firefox release from Mozilla's archive on a disposable
# GitHub-hosted Linux runner, for the audio workflow's runs started by hand
# with a `firefox` release (the suite's baseline needs Firefox's current and
# previous releases, and the runner has only one; see
# e2e/audio-capture/BASELINE.md). It checks the archive's list of hashes
# against Mozilla's release key, pinned here by its fingerprint, and the
# download against that list, then points FIREFOX_BIN at it for the later
# steps.
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "$(uname -s)" != Linux ]]; then
  echo 'This is only for a disposable Linux runner on GitHub Actions.' >&2
  exit 1
fi
version=${FIREFOX_VERSION:?no Firefox release given}
if [[ ! "$version" =~ ^[0-9]{2,3}\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "Not a Firefox release number: $version" >&2
  exit 1
fi
# Mozilla Software Releases <release@mozilla.com>, whose subkeys sign the
# releases' SHA512SUMS.
RELEASE_KEY=14F26682D0916CDD81E37B6D61B7B526D98F0353
base="https://archive.mozilla.org/pub/firefox/releases/$version"
file="linux-x86_64/en-US/firefox-$version.tar.xz"
work="$RUNNER_TEMP/firefox-$version"
mkdir -p "$work"
cd "$work"

fetch() {
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 2 --connect-timeout 30 --max-time 120 -o "$2" "$1"
}
fetch "$base/KEY" KEY
fetch "$base/SHA512SUMS" SHA512SUMS
fetch "$base/SHA512SUMS.asc" SHA512SUMS.asc
fetch "$base/$file" firefox.tar.xz

export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --import KEY
gpg --batch --status-fd 1 --verify SHA512SUMS.asc SHA512SUMS > verify.txt 2>&1 || true
# VALIDSIG's last field is the signing subkey's primary key.
if ! grep -qE "^\[GNUPG:\] VALIDSIG [0-9A-F]+ .* $RELEASE_KEY$" verify.txt; then
  cat verify.txt >&2
  echo "SHA512SUMS isn't signed by Mozilla's release key $RELEASE_KEY." >&2
  exit 1
fi
expected=$(awk -v name="$file" '$2 == name { print $1 }' SHA512SUMS)
if [[ ! "$expected" =~ ^[0-9a-f]{128}$ ]]; then
  echo "SHA512SUMS has no single hash for $file." >&2
  exit 1
fi
echo "$expected  firefox.tar.xz" | sha512sum --check --status || {
  echo "The download doesn't match SHA512SUMS." >&2
  exit 1
}
tar -xJf firefox.tar.xz
installed=$(sed -n 's/^Version=//p' firefox/application.ini)
if [[ "$installed" != "$version" ]]; then
  echo "The archive holds Firefox $installed, not $version." >&2
  exit 1
fi
echo "FIREFOX_BIN=$work/firefox/firefox" >> "$GITHUB_ENV"
echo "Firefox $installed from $base/$file (SHA512SUMS signed by $RELEASE_KEY) is in $work/firefox."
