#!/bin/bash
# Builds Beam.app (universal: Apple Silicon + Intel) into ./build.
# Usage: ./build.sh        then: open build/Beam.app
set -euo pipefail
cd "$(dirname "$0")"
# Assemble + sign outside iCloud Drive: iCloud keeps adding Finder metadata that breaks codesign.
WORK="$HOME/Library/Caches/BeamBuild"
APP="$WORK/Beam.app"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$WORK" build

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "• Compiling (arm64 + x86_64)…"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" \
    -o "$TMP/Beam-$arch" Sources/main.swift -framework Cocoa -framework WebKit -framework IOKit
done
lipo -create "$TMP/Beam-arm64" "$TMP/Beam-x86_64" -output "$APP/Contents/MacOS/Beam"

echo "• Icon…"
[ -f assets/icon-1024.png ] || swift tools/make_icon.swift assets/icon-1024.png
ICONSET="$TMP/Beam.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) assets/icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Beam.icns"
sips -z 256 256 assets/icon-1024.png --out web/logo.png >/dev/null

cp -R web "$APP/Contents/Resources/web"
cp Info.plist "$APP/Contents/Info.plist"
xattr -cr "$APP"                      # iCloud/Finder metadata breaks codesign
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
rm -rf build/Beam.app
ditto --noextattr --norsrc "$APP" build/Beam.app
echo "✓ Built build/Beam.app"
