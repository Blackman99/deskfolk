#!/usr/bin/env bash
# Builds the Deskfolk launch film (see docs/development.md): apps/landing/scripts/launch/build.sh zh|en
# Work files and results go to apps/landing/film-out/launch/ (LAUNCH_OUT overrides):
#   deskfolk-launch-<lang>.mp4        the film (H.264 CRF 21, AAC, faststart) for the web
#   deskfolk-launch-<lang>-master.mp4 the near-lossless master; -music-only.mp4 the same cut without effects
#   deskfolk-launch-<lang>.jpg        poster frame (POSTER_AT, default the end card); -sheet.jpg a contact sheet
# Needs macOS (SF Pro, SF Mono and PingFang SC are the system's own), ffmpeg, and Python 3 with numpy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export LAUNCH_OUT="${LAUNCH_OUT:-$(cd "$here/../.." && pwd)/film-out/launch}"
lang="${1:?zh or en}"; out="$LAUNCH_OUT"; name="deskfolk-launch-$lang"
mkdir -p "$out"
"$here/fetch-audio.sh"
node "$here/render.mjs" --lang "$lang" --workers "${WORKERS:-8}" --out "$out/$lang-silent.mp4"
python3 "$here/mix.py" "$lang" "$out/$lang-silent.mp4" "$out/$name-master.mp4"
python3 "$here/mix.py" "$lang" "$out/$lang-silent.mp4" "$out/$name-music-only.mp4" --music-only
ffmpeg -v error -y -i "$out/$name-master.mp4" -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -profile:v high \
  -c:a copy -movflags +faststart "$out/$name.mp4"
ffmpeg -v error -y -ss "${POSTER_AT:-29.6}" -i "$out/$name-master.mp4" -frames:v 1 -q:v 2 "$out/$name.jpg"
ffmpeg -v error -y -i "$out/$name.mp4" -vf "fps=2,scale=384:-1,tile=6x11:padding=4:color=white" -frames:v 1 -q:v 3 "$out/$name-sheet.jpg"
ls -la "$out/$name.mp4" "$out/$name-master.mp4" "$out/$name-music-only.mp4" "$out/$name.jpg" "$out/$name-sheet.jpg"
