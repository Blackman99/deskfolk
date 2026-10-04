#!/usr/bin/env bash
# Downloads the library audio the mix uses into apps/landing/film-out/launch/assets (LAUNCH_OUT overrides).
# Mixkit Stock Music / Sound Effects Free License: the files may be used in the film but not redistributed,
# so they stay out of the repo.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${LAUNCH_OUT:-$here/../../film-out/launch}"
mkdir -p "$out/assets/music" "$out/assets/sfx"
get() { [ -s "$2" ] || curl -fsS -m 60 -o "$2" "$1"; }
# "Better Times are Coming" by Alejandro Magaña (A. M.), synthpop, 120 BPM
get https://assets.mixkit.co/music/173/173.mp3 "$out/assets/music/173.mp3"
for id in 1468 1485 2568 2841 3005 2925 216 2866 2867 2357 2870 2585 2364; do
  get "https://assets.mixkit.co/active_storage/sfx/$id/$id-preview.mp3" "$out/assets/sfx/$id.mp3"
done
