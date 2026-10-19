#!/usr/bin/env bash
# Builds the Deskfolk 0.1.0 release film: apps/landing/scripts/release/build.sh zh|en
# Work files and results go to apps/landing/film-out/release/ (RELEASE_OUT overrides). The cast and the library audio
# are the reel's (apps/landing/film-out/reel, REEL_OUT overrides): its sprites are rendered once by ../reel/sprites.py.
#   deskfolk-release-<lang>.mp4        the film (H.264 CRF 23, AAC, faststart)
#   deskfolk-release-<lang>-master.mp4 the near-lossless master; -music-only.mp4 the same cut without effects
#   deskfolk-release-<lang>.jpg        poster frame (POSTER_AT); -sheet.jpg a contact sheet
# Needs macOS (SF Pro, SF Mono and PingFang SC are the system's own), Blender 5.2 (sprites only), ffmpeg, Python 3 with numpy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export RELEASE_OUT="${RELEASE_OUT:-$(cd "$here/../.." && pwd)/film-out/release}"
export REEL_OUT="${REEL_OUT:-$(cd "$here/../.." && pwd)/film-out/reel}"
lang="${1:?zh or en}"; out="$RELEASE_OUT"; name="deskfolk-release-$lang"
blender="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
mkdir -p "$out"
LAUNCH_OUT="$REEL_OUT" "$here/../launch/fetch-audio.sh"
[ -s "$REEL_OUT/sprites/sprites.json" ] || "$blender" -b --factory-startup --python "$here/../reel/sprites.py" -- "$REEL_OUT/sprites" > "$REEL_OUT/sprites.log"
node "$here/render.mjs" --lang "$lang" --workers "${WORKERS:-8}" --out "$out/$lang-silent.mp4"
python3 "$here/mix.py" "$lang" "$out/$lang-silent.mp4" "$out/$name-master.mp4"
python3 "$here/mix.py" "$lang" "$out/$lang-silent.mp4" "$out/$name-music-only.mp4" --music-only
ffmpeg -v error -y -i "$out/$name-master.mp4" -c:v libx264 -preset slow -crf "${CRF:-23}" -pix_fmt yuv420p -profile:v high \
  -c:a aac -b:a 160k -movflags +faststart "$out/$name.mp4"
ffmpeg -v error -y -ss "${POSTER_AT:-2.9}" -i "$out/$name-master.mp4" -frames:v 1 -q:v 2 "$out/$name.jpg"
ffmpeg -v error -y -i "$out/$name.mp4" -vf "fps=2,scale=384:-1,tile=6x11:padding=4:color=white" -frames:v 1 -q:v 3 "$out/$name-sheet.jpg"
ls -la "$out/$name.mp4" "$out/$name-master.mp4" "$out/$name-music-only.mp4" "$out/$name.jpg" "$out/$name-sheet.jpg"
