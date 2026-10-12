#!/usr/bin/env bash
# Builds the Deskfolk reel (see docs/development.md): apps/landing/scripts/reel/build.sh zh|en
# Work files and results go to apps/landing/film-out/reel/ (REEL_OUT overrides):
#   sprites/                        the cast's moves, rendered once by sprites.py (Blender 5.2), shared by both languages
#   assets/kettle/                  the film the story makes, frames of assets/kettle.mp4 (a Grok Imagine render from a demo take)
#   deskfolk-reel-<lang>.mp4        the film (H.264 CRF 23, AAC, faststart) for the README and the site
#   deskfolk-reel-<lang>-master.mp4 the near-lossless master; -music-only.mp4 the same cut without effects
#   deskfolk-reel-<lang>.jpg        poster frame (POSTER_AT); -sheet.jpg a contact sheet
# Needs macOS (SF Pro, SF Mono and PingFang SC are the system's own), Blender 5.2, ffmpeg, Python 3 with numpy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export REEL_OUT="${REEL_OUT:-$(cd "$here/../.." && pwd)/film-out/reel}"
lang="${1:?zh or en}"; out="$REEL_OUT"; name="deskfolk-reel-$lang"
blender="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
mkdir -p "$out"
LAUNCH_OUT="$out" "$here/../launch/fetch-audio.sh"
[ -s "$out/sprites/sprites.json" ] || "$blender" -b --factory-startup --python "$here/sprites.py" -- "$out/sprites" > "$out/sprites.log"
[ -s "$out/assets/kettle/0181.jpg" ] || { mkdir -p "$out/assets/kettle"; ffmpeg -v error -y -i "$here/assets/kettle.mp4" -q:v 3 "$out/assets/kettle/%04d.jpg"; }
node "$here/render.mjs" --lang "$lang" --workers "${WORKERS:-8}" --out "$out/$lang-silent.mp4"
python3 "$here/mix.py" "$lang" "$out/$lang-silent.mp4" "$out/$name-master.mp4"
python3 "$here/mix.py" "$lang" "$out/$lang-silent.mp4" "$out/$name-music-only.mp4" --music-only
ffmpeg -v error -y -i "$out/$name-master.mp4" -c:v libx264 -preset slow -crf "${CRF:-23}" -pix_fmt yuv420p -profile:v high \
  -c:a aac -b:a 160k -movflags +faststart "$out/$name.mp4"
ffmpeg -v error -y -ss "${POSTER_AT:-22.8}" -i "$out/$name-master.mp4" -frames:v 1 -q:v 2 "$out/$name.jpg"
ffmpeg -v error -y -i "$out/$name.mp4" -vf "fps=2,scale=384:-1,tile=6x11:padding=4:color=white" -frames:v 1 -q:v 3 "$out/$name-sheet.jpg"
ls -la "$out/$name.mp4" "$out/$name-master.mp4" "$out/$name-music-only.mp4" "$out/$name.jpg" "$out/$name-sheet.jpg"
