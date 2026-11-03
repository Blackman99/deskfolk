# Linux preview (experimental)

[简体中文](linux.zh.md)

The Linux build is a fresh, experimental preview: it installs and runs, and terminals, files and the Trash work, but a few features are still Mac-only. This page covers installing it, where things live, and how it differs from the Mac. It is built and tested on GitHub's Ubuntu 22.04 and has not yet been used end to end on a real Linux desktop.

## Install

x86_64 only, in either of two forms:

- **AppImage**: download `Deskfolk_<version>_amd64.AppImage` from the [latest release](https://github.com/Blackman99/deskfolk/releases/latest), `chmod +x` it and run it. It needs FUSE to mount itself (most desktop distributions ship `libfuse2`); without it, run it with `--appimage-extract-and-run`.
- **deb** (Debian, Ubuntu and their derivatives): download `Deskfolk_<version>_amd64.deb` and run `sudo apt install ./Deskfolk_<version>_amd64.deb`. apt installs what it needs with it (WebKitGTK 4.1, GTK 3, AppIndicator for the tray).

Both are built on Ubuntu 22.04 and run on distributions with glibc 2.35 or newer. Neither is signed.

To upgrade: when About finds a new version, a copy running as an AppImage is pointed at the new AppImage and one installed from the deb at the new deb. It only opens the download in the browser; installing from inside the app is not there yet.

## Where data and keys live

- The data folder is `$XDG_DATA_HOME/real-bot`, or `~/.local/share/real-bot` when that is not set; `REAL_BOT_DATA_DIR` still takes precedence.
- Endpoint API keys and MCP credentials go to the system keyring (the Secret Service), which is GNOME Keyring or KWallet, instead of the macOS Keychain. The keyring has to be running and unlocked; with neither, saving a key fails and says which one to start.
- Moving to the Trash follows the freedesktop specification and uses your home Trash (`~/.local/share/Trash`), so the file manager shows the items and can put them back. A file on another disk goes through `gio trash`.

The docs and the [glossary](../CONTEXT.en.md) are written for macOS (Dock, Keychain, Finder, Trash); on Linux, the system keyring stands in for the Keychain and the file manager for Finder.

## What Bots run commands in

A Bot's `shell` tool runs commands in `/bin/bash` when there is one, and in `/bin/sh` otherwise: on Debian and Ubuntu `/bin/sh` is dash, where the bash a model writes fails. Terminals open your login shell (`$SHELL`, or your account's own shell when that is not set).

## Remote access and the remote screen

Not yet. The Linux window has no system dialog yet to confirm a pairing with, so the remote access card in Settings says it is not there yet on Linux and offers no form.

## Letting your own Claude Code run a Bot

Claude Agent ([how it works](behavior.en.md#claude-agent)) can be picked on Linux too: `claude` on your PATH, the official install script's `~/.local/bin/claude`, and installs through npm, bun, volta or Homebrew (Linuxbrew included) are all found, and your login shell is asked once when none of those has it. For one installed elsewhere, give its full path under Settings › Agents › Claude Agent. The other local agents work the same way. None of this has been tried on a real Linux machine yet.

## Not there yet

- Remote access and the remote screen.
- Desktop notifications and the icon badge.
- Downloading and installing an update inside the app: a new version still means a manual download in the browser.
- Holding off idle sleep while work runs (the Mac does it on power).
- System proxy settings: only the `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` environment variables are read.
- The optional independent runtime (off by default on the Mac too).
- Image thumbnails and avatar scaling. Images sent to a model are scaled down when ImageMagick is installed and go as they are otherwise.
- Voice input has not been tried on a real machine.
- arm64, rpm, Flatpak and Snap packages.

## Troubleshooting

- **A blank or black window** (common with NVIDIA graphics): try starting it with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
- **Chinese text shows as boxes**: install a CJK font, such as `sudo apt install fonts-noto-cjk`.
- **No tray icon**: GNOME shows no tray icons without the AppIndicator extension. Without a tray, start Deskfolk again after closing its window and the window that is already open comes back.
- **The folder picker does not open**: it goes through xdg-desktop-portal; install a backend (`xdg-desktop-portal-gtk`, `-gnome` or `-kde`).

## Running from source

The same `pnpm install` and `pnpm dev` as on the Mac, plus WebKitGTK and the other system development packages, and a one-time build of the terminal helper (`cargo build --manifest-path apps/conpty-helper/Cargo.toml`). Prerequisites and packaging steps are in the [development guide](development.md#linux实验性) (in Chinese).
