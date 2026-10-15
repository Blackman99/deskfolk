#!/bin/sh
# Renders Mochi and Pudding (Blender 5.2, Cycles) and rebuilds the desktop app icon set and the
# messenger's home-screen icons from them. Run from anywhere; takes a few minutes on the GPU.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
desktop="$here/../.."
static="$desktop/../messenger/static"
tmp="$(mktemp -d)"
blender -b --python "$here/render.py" -- "$tmp/mascots.png" --res 1800 --samples 256
python3 "$here/compose.py" "$tmp/mascots.png" "$desktop/src-tauri/icons/app-icon.png"
python3 "$here/compose.py" "$tmp/mascots.png" "$tmp/bleed.png" --bleed
sips -z 512 512 "$tmp/bleed.png" --out "$static/icon-512.png" >/dev/null
sips -z 192 192 "$tmp/bleed.png" --out "$static/icon-192.png" >/dev/null
sips -z 180 180 "$tmp/bleed.png" --out "$static/apple-touch-icon.png" >/dev/null
cd "$desktop" && ./node_modules/.bin/tauri icon src-tauri/icons/app-icon.png --output src-tauri/icons
rm -rf "$tmp"
