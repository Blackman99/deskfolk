#!/usr/bin/env bash
# Render Mochi and Pudding for the home page's companions, layer by layer, with the folk avatar's
# own renderer (packages/protocol/scripts/folk-avatar/render.py): Pudding is the folk as the app
# draws it, mustard with its antenna; Mochi is the same body in white, with nothing on its head.
# The 512 px PNGs land in film-out/mascots/<who>/ (gitignored); build.py packs them for the site.
#
#   scripts/mascots/render.sh [pudding|mochi]...   (both when none is named)
#   BLENDER=/path/to/Blender scripts/mascots/render.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
landing="$(cd "$here/../.." && pwd)"
renderer="$(cd "$landing/../../packages/protocol/scripts/folk-avatar" && pwd)/render.py"
blender="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
out="$landing/film-out/mascots"

face='eyes-dot,eyes-happy,eyes-wink,eyes-closed,mouth-smile,mouth-open,mouth-cat'
who=("$@")
[ ${#who[@]} -eq 0 ] && who=(pudding mochi)

for w in "${who[@]}"; do
  case "$w" in
    pudding) body='#ef9f2c'; layers="body,arm-l,arm-r,$face,acc-antenna" ;;
    # The task map's Mochi (apps/messenger/scripts/map-figures) is this white.
    mochi) body='#f6f3ec'; layers="body,arm-l,arm-r,$face" ;;
    *) echo "unknown mascot: $w" >&2; exit 2 ;;
  esac
  mkdir -p "$out/$w"
  FOLK_BODY="$body" "$blender" -b --factory-startup --python "$renderer" -- "$out/$w" "$layers"
done
