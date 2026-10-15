#!/bin/sh
# Rebuilds the desktop app icon set from src-tauri/icons/app-icon.svg and the messenger's
# home-screen icons from app-icon-bleed.svg (the same art, full bleed). Run from anywhere.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
desktop="$here/../.."
static="$desktop/../messenger/static"
tmp="$(mktemp -d)"
cd "$desktop"
./node_modules/.bin/tauri icon src-tauri/icons/app-icon.svg --output src-tauri/icons
rm -rf src-tauri/icons/android src-tauri/icons/ios
./node_modules/.bin/tauri icon src-tauri/icons/app-icon-bleed.svg --output "$tmp"
cp "$tmp/icon.png" "$static/icon-512.png"
sips -z 192 192 "$tmp/icon.png" --out "$static/icon-192.png" >/dev/null
sips -z 180 180 "$tmp/icon.png" --out "$static/apple-touch-icon.png" >/dev/null
rm -rf "$tmp"
