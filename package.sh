#!/bin/bash
# Builds Beam and wraps it in an installable disk image: build/Beam.dmg
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
ditto "$HOME/Library/Caches/BeamBuild/Beam.app" "$STAGE/Beam.app"
ln -s /Applications "$STAGE/Applications"
cp "dist/Read Me First.html" "$STAGE/"
cp "$HOME/Library/Caches/BeamBuild/Beam.app/Contents/Resources/Beam.icns" "$STAGE/.VolumeIcon.icns"
SetFile -a C "$STAGE" 2>/dev/null || true     # use the custom volume icon
DMG="$HOME/Library/Caches/BeamBuild/Beam.dmg"
rm -f "$DMG"
hdiutil create -volname "Beam" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
cp "$DMG" build/Beam.dmg
echo "✓ Packaged build/Beam.dmg ($(du -h build/Beam.dmg | cut -f1))"
