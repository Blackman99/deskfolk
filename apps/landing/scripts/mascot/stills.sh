#!/usr/bin/env bash
# Low-res stills of the film at the given times, for checking a beat without rendering it all:
#   stills.sh OUT_DIR 4.7 10.9 27.4
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$1"; shift
mkdir -p "$out"
for t in "$@"; do
  "${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}" -b --factory-startup --python "$here/scene.py" -- "$out" \
    --still "$t" --res 40 --samples 32 > "$out/still-$t.log" 2>&1 || { echo "failed at $t, see $out/still-$t.log"; exit 1; }
done
