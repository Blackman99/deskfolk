#!/bin/sh
# Rebuilds the app's icon set from assets/icons/app-icon.svg and the phone page's home-screen icons
# from app-icon-bleed.svg (the same art, full bleed). Run from anywhere; macOS only (sips, iconutil).
#
#   assets/icons/icon.icns          the macOS bundle's icon
#   assets/icons/icon.ico           the Windows exe, installer and daemon's icon
#   assets/linux/icons/<n>x<n>.png  the Linux package's hicolor icons (32, 64, 128, 256, 512)
#   assets/phone/                   icon-512.png, icon-192.png, apple-touch-icon.png
#
# The SVG has to be rasterized first, with `rsvg-convert` (brew install librsvg) or `resvg`, which
# both keep the tile's transparent margins and drop shadow.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/../.."
icons="$app/assets/icons"
linux="$app/assets/linux/icons"
static="$app/assets/phone"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# rasterize SVG OUT.png SIZE
rasterize() {
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$3" -h "$3" "$1" -o "$2"
  elif command -v resvg >/dev/null 2>&1; then
    resvg -w "$3" -h "$3" "$1" "$2"
  else
    echo "build.sh: needs rsvg-convert (brew install librsvg) or resvg to draw the SVG" >&2
    exit 1
  fi
}

rasterize "$icons/app-icon.svg" "$tmp/icon.png" 1024

# macOS: an .iconset of every size the system asks for, then iconutil packs it.
set="$tmp/icon.iconset"
mkdir "$set"
for n in 16 32 128 256 512; do
  sips -z "$n" "$n" "$tmp/icon.png" --out "$set/icon_${n}x${n}.png" >/dev/null
  sips -z "$((n * 2))" "$((n * 2))" "$tmp/icon.png" --out "$set/icon_${n}x${n}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o "$icons/icon.icns"

# Windows
python3 "$here/ico.py" "$icons/icon.ico" "$tmp/icon.png"

# Linux
for n in 32 64 128 256 512; do
  sips -z "$n" "$n" "$tmp/icon.png" --out "$linux/${n}x${n}.png" >/dev/null
done

# The phone's home screen: the full-bleed art.
rasterize "$icons/app-icon-bleed.svg" "$tmp/bleed.png" 512
cp "$tmp/bleed.png" "$static/icon-512.png"
sips -z 192 192 "$tmp/bleed.png" --out "$static/icon-192.png" >/dev/null
sips -z 180 180 "$tmp/bleed.png" --out "$static/apple-touch-icon.png" >/dev/null
