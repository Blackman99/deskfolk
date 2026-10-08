#!/usr/bin/env bash
# Builds the mascot film for one language into apps/landing/film-out/mascot (MASCOT_OUT overrides):
# Blender frames (shared by both languages; RERENDER=1 renders them again) -> words laid over ->
# H.264 -> score and effects -> the film, a music-only cut, a poster and a contact sheet.
# Needs Blender 5.2 at /Applications/Blender.app (BLENDER overrides), ffmpeg, and Python 3 with Pillow and numpy.
set -euo pipefail
lang="${1:?usage: build.sh zh|en}"
here="$(cd "$(dirname "$0")" && pwd)"
out="${MASCOT_OUT:-$here/../../film-out/mascot}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
blender="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
frames="$out/frames"
last="$(python3 -c "import sys; sys.path.insert(0, '$here'); import beats; print(f'f{round(beats.DUR * 30) + 1:04d}.png')")"
frames_n="$(python3 -c "import sys; sys.path.insert(0, '$here'); import beats; print(round(beats.DUR * 30))")"  # 30.5 s is 915 frames

# the music and effects are the launch film's library files (not redistributable, so not in the repo)
"$here/../launch/fetch-audio.sh"
export MASCOT_OUT="$out" MASCOT_ASSETS="$here/../../film-out/launch/assets"

if [ -n "${RERENDER:-}" ] || [ ! -s "$frames/$last" ]; then
  mkdir -p "$frames"
  "$blender" -b --factory-startup --python "$here/scene.py" -- "$frames" --engine eevee --samples 64 > "$out/render.log" 2>&1
  grep '^rendered' "$out/render.log"
fi

python3 "$here/overlay.py" "$lang" "$frames" "$out/frames-$lang"
ffmpeg -v error -y -framerate 30 -i "$out/frames-$lang/f%04d.png" -frames:v "$frames_n" -c:v libx264 -preset slow -crf 18 \
  -pix_fmt yuv420p -movflags +faststart "$out/_pic-$lang.mp4"
python3 "$here/mix.py" "$lang" "$out/_pic-$lang.mp4" "$out/deskfolk-mascots-$lang.mp4"
python3 "$here/mix.py" "$lang" "$out/_pic-$lang.mp4" "$out/deskfolk-mascots-$lang-music-only.mp4" --music-only
# poster: the two standing in the mark, eyes open, before the end card
ffmpeg -v error -y -ss 27.4 -i "$out/deskfolk-mascots-$lang.mp4" -frames:v 1 -q:v 2 "$out/deskfolk-mascots-$lang.jpg"
python3 "$here/sheet.py" "$out/deskfolk-mascots-$lang.mp4" "$out/deskfolk-mascots-$lang-sheet.jpg"
rm -f "$out/_pic-$lang.mp4" "$out"/_mix-*.wav "$out/_lufs.wav"
echo "built $out/deskfolk-mascots-$lang.mp4"
# SHIP=1: the film goes to the site (README links there) and, from zh, the README cover (no words in it)
if [ -n "${SHIP:-}" ]; then
  cp "$out/deskfolk-mascots-$lang.mp4" "$here/../../static/media/"
  if [ "$lang" = zh ]; then python3 "$here/cover.py" "$out/deskfolk-mascots-zh.mp4" "$here/../../../../docs/assets/mascots.jpg"; fi
fi
