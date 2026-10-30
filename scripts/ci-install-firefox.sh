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
# Mozilla Software Releases <release@mozilla.com>, and the subkey that has
# signed the releases' SHA512SUMS since Mozilla replaced and revoked the
# previous one in August 2026 (first used for 156.0). Both are pinned: a
# signature by any other key, or one that GnuPG reports as revoked,
# expired or bad, is refused, and a new signing subkey needs a change here.
RELEASE_KEY=14F26682D0916CDD81E37B6D61B7B526D98F0353
SIGNING_SUBKEY=827E658608679618CD349F93678E455D76767AA3
base="https://archive.mozilla.org/pub/firefox/releases/$version"
file="linux-x86_64/en-US/firefox-$version.tar.xz"
work="$RUNNER_TEMP/firefox-$version"
mkdir -p "$work"
cd "$work"

fetch() {
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 2 --connect-timeout 30 --max-time 120 -o "$2" "$1" || {
    echo "Couldn't download $1." >&2
    exit 1
  }
}
fetch "$base/KEY" KEY
fetch "$base/SHA512SUMS" SHA512SUMS
fetch "$base/SHA512SUMS.asc" SHA512SUMS.asc
fetch "$base/$file" firefox.tar.xz

export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --import KEY
# GnuPG's machine-readable status goes to its own file, apart from its
# messages. It has to exit 0 and report exactly one good signature, made
# by the pinned subkey of the pinned key (VALIDSIG's first and last
# fields), and no signature or signing key revoked, expired, bad or
# unchecked. KEYEXPIRED alone isn't refused: GnuPG reports it for every
# expired subkey in Mozilla's KEY, five of them, beside a good signature.
set +e
gpg --batch --status-file status.txt --verify SHA512SUMS.asc SHA512SUMS 2> gpg.txt
verified=$?
set -e
good=$(grep -c '^\[GNUPG:\] GOODSIG ' status.txt || true)
valid=$(grep -cE "^\[GNUPG:\] VALIDSIG $SIGNING_SUBKEY .* $RELEASE_KEY$" status.txt || true)
others=$(grep -cE '^\[GNUPG:\] (VALIDSIG|BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|KEYREVOKED|NO_PUBKEY|SIGEXPIRED)( |$)' status.txt || true)
if (( verified != 0 || good != 1 || valid != 1 || others != 1 )); then
  cat status.txt gpg.txt >&2
  echo "SHA512SUMS isn't signed by Mozilla's release subkey $SIGNING_SUBKEY of $RELEASE_KEY, or GnuPG refused it." >&2
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
# Its version is read from the archive before anything is unpacked.
installed=$(tar -xJOf firefox.tar.xz firefox/application.ini | sed -n 's/^Version=//p')
if [[ "$installed" != "$version" ]]; then
  echo "The archive holds Firefox $installed, not $version." >&2
  exit 1
fi
tar -xJf firefox.tar.xz
# And again as unpacked, in case the archive held more than one.
if [[ "$(sed -n 's/^Version=//p' firefox/application.ini)" != "$version" ]]; then
  echo "The unpacked Firefox isn't $version." >&2
  exit 1
fi
echo "FIREFOX_BIN=$work/firefox/firefox" >> "$GITHUB_ENV"
echo "Firefox $installed from $base/$file (SHA512SUMS signed by $SIGNING_SUBKEY of $RELEASE_KEY) is in $work/firefox."
