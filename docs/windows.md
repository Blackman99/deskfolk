# Windows preview (experimental)

[简体中文](windows.zh.md)

The Windows build is a fresh, experimental preview: it installs and runs, but a few features are still Mac-only. This page covers installing it, where things live, and how it differs from the Mac. As of 0.1.0-rc.12 it has run on one Windows Server 2022 machine, and has not yet been checked on Windows 10 or 11.

## Install

1. Download `Deskfolk_<version>_x64-setup.exe` from the [latest release](https://github.com/Blackman99/deskfolk/releases/latest) (x64 only).
2. Run it. It installs for the current user and needs no administrator rights.
3. The installer is not signed, so SmartScreen warns about an unknown publisher: choose **More info** → **Run anyway**.

It also needs the WebView2 runtime: Windows 11 ships with it; on Windows 10, install it first if it is missing.

To upgrade, run the newer installer. When About finds a new version it only opens the download in the browser; installing from inside the app is not there yet. The installer closes an open window first, and the daemon and the terminals it started end with it; if only a daemon from an earlier run is left, the installer stops that too, since a running file cannot be overwritten.

## Where data and keys live

- The data folder is `%LOCALAPPDATA%\real-bot` (`<home>\AppData\Local\real-bot` when `LOCALAPPDATA` is not set); `REAL_BOT_DATA_DIR` still takes precedence.
- Endpoint API keys and MCP credentials go to Windows Credential Manager instead of the macOS Keychain.

The docs and the [glossary](../CONTEXT.en.md) are written for macOS (Dock, Keychain, Finder, Trash); on Windows, Credential Manager stands in for the Keychain.

## What Bots run commands in

A Bot's `shell` tool runs commands in Git Bash when it finds one, and in PowerShell otherwise, so installing [Git for Windows](https://gitforwindows.org/) is recommended. The `REAL_BOT_TOOL_SHELL` environment variable can point at a `bash.exe`, `pwsh.exe` or `powershell.exe` to override that choice.

## Remote access and the remote screen

Remote access works as on the Mac ([remote access](remote-access.md)), with two differences. Approving a device uses Windows Hello — face, fingerprint or PIN — so set a PIN under Windows Settings → Accounts → Sign-in options first. And the remote screen needs a VNC server, since Windows has no screen sharing of its own: install TightVNC as a system service, set its password, and allow loopback connections only; the steps are in [remote access](remote-access.md#on-windows), and the card in Settings lists them while no VNC server answers. Neither has been tried on a real Windows PC yet ([ADR 0059](adr/0059-windows-remote-access-and-screen.md)).

## Not there yet

- The optional independent runtime (off by default on the Mac too).
- Downloading and installing an update inside the app: a new version still means a manual download in the browser.
- Desktop notifications and the icon badge.
- Image thumbnails. Images sent to a model are not affected.

## Running from source

The same `pnpm install` and `pnpm dev` as on the Mac, plus Rust's MSVC toolchain and Visual Studio Build Tools ("Desktop development with C++"), and a one-time build of the terminal helper. Prerequisites and packaging steps are in the [development guide](development.md#windows实验性) (in Chinese).
