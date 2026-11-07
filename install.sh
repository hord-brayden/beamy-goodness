#!/bin/bash
# Beam installer — downloads the latest Beam.dmg from GitHub Releases and copies Beam.app into /Applications.
#   curl -fsSL https://raw.githubusercontent.com/hord-brayden/beamy-goodness/main/install.sh | bash
# Read it first if you like (you should, it's a pipe-to-bash). It's ~30 lines and only touches /Applications/Beam.app.
set -euo pipefail

REPO="hord-brayden/beamy-goodness"
DEST="${BEAM_INSTALL_DIR:-/Applications}"
URL="https://github.com/$REPO/releases/latest/download/Beam.dmg"

[ "$(uname -s)" = "Darwin" ] || { echo "Beam is a macOS app. Nice try though."; exit 1; }

TMP=$(mktemp -d)
MNT="$TMP/mnt"
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "→ Downloading Beam…"
curl -fL --progress-bar "$URL" -o "$TMP/Beam.dmg"

echo "→ Installing to $DEST…"
mkdir -p "$MNT"
hdiutil attach "$TMP/Beam.dmg" -nobrowse -readonly -quiet -mountpoint "$MNT"
pkill -x Beam 2>/dev/null || true
rm -rf "$DEST/Beam.app"
ditto "$MNT/Beam.app" "$DEST/Beam.app"
xattr -dr com.apple.quarantine "$DEST/Beam.app" 2>/dev/null || true

echo "✓ Beam installed. Plug in a projector and go make something glow."
[ -n "${BEAM_NO_OPEN:-}" ] || open "$DEST/Beam.app"
