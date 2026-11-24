#!/usr/bin/env bash
# Shared Debian/Ubuntu system libraries required to build and test `apps/desktop-nsh` on Linux
# (GTK 4, WebKitGTK 6 for HTML preview, GStreamer for media, ALSA, clang/pkg-config).
# Workflows pass any job-specific extras (e.g. `xvfb dbus-x11` for smoke, or packaging tools).
#
#   bash scripts/linux-desktop-deps.sh [extra apt packages...]
#   bash scripts/linux-desktop-deps.sh --print
set -euo pipefail

PACKAGES=(
  libgtk-4-dev
  clang
  pkg-config
  libgstreamer1.0-dev
  libgstreamer-plugins-base1.0-dev
  gstreamer1.0-plugins-base
  gstreamer1.0-plugins-good
  libasound2-dev
  libwebkitgtk-6.0-dev
)

if [[ "${1:-}" == "--print" ]]; then
  printf '%s\n' "${PACKAGES[@]}"
  exit 0
fi

sudo apt-get update
sudo apt-get install -y "${PACKAGES[@]}" "$@"
