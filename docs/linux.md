# Linux preview (experimental)

[简体中文](linux.zh.md)

The Linux build is the native app, the same one as on the Mac and Windows, and still an experimental preview. This page covers installing it, where things live, and how it differs from the Mac. It is built on GitHub's Ubuntu 24.04 and checked there and in a Linux container, but it has not yet been used end to end on a real Linux desktop.

## Install

x86_64 only, in either of two forms, from the [latest release](https://github.com/Blackman99/deskfolk/releases/latest):

- **deb** (Debian, Ubuntu and their derivatives): download `Deskfolk_<version>_amd64.deb` and run `sudo apt install ./Deskfolk_<version>_amd64.deb`. apt installs what it needs with it: GTK 4.14 or newer, WebKitGTK 6.0, GStreamer, ALSA, libsecret and polkit. That means Ubuntu 24.04, Debian 13 or newer; Ubuntu 22.04 and Debian 12 are too old.
- **AppImage**: download `Deskfolk_<version>_amd64.AppImage`, `chmod +x` it and run it. It carries its own GTK 4, but it is built on Ubuntu 24.04 and has only been run there, so expect it to need a distribution about as recent. It mounts itself with FUSE; where FUSE is not available, run it with `--appimage-extract-and-run`. An AppImage cannot install the polkit policy that remote access asks for your password with (see [below](#remote-access-and-the-remote-screen)).

Neither is signed. 0.5.0 and 0.5.1 had no Linux package.

**Upgrading from 0.4.0** (the last Linux preview of the old app): install the new deb over it with the same `apt install`. If 0.4.0 is still running, the installer asks it to quit and stops whatever is left. Conversations, settings and keys stay where they were, and launch at login keeps working. The applications menu entry has a new id (`com.real-bot.desktop`), so a launcher or dock that pinned the old entry may need it pinned again. With an AppImage, run the new AppImage in place of the old one. On Ubuntu 22.04 and Debian 12, 0.4.0's About still offers the new version, but apt refuses to install it: stay on 0.4.0 there.

**Later upgrades:** when About finds a new version, it opens the matching download in the browser: the AppImage for a copy running as an AppImage, the deb otherwise. Installing from inside the app is not there yet.

## The tray, the window and starting at login

- Closing the window puts it away: Deskfolk keeps running in the tray, and your Bots keep working. To quit, choose Quit Deskfolk in the tray's menu, press Ctrl+Q, or run `real-bot-desktop --quit` (for an AppImage, the AppImage file with `--quit`).
- Ctrl+W closes the tab in front of you, and puts the window away once no tab is left.
- The tray's menu shows what is used of your plans, then Show Deskfolk, Stop Everything and Quit Deskfolk. A click on the icon shows the window.
- The tray icon is a StatusNotifierItem: Plasma, XFCE and most panels show it; GNOME shows it only with the AppIndicator extension (`gnome-shell-extension-appindicator`). Without a tray, the close button minimizes the window instead.
- One copy runs at a time: starting Deskfolk again brings the open window forward.
- Launch at login (Settings › General) is on unless you turn it off. It writes `~/.config/autostart/Deskfolk.desktop`, which starts Deskfolk in the tray without a window; 0.4.0 wrote the same file.

## Where data and keys live

- The data folder is `$XDG_DATA_HOME/real-bot`, or `~/.local/share/real-bot` when that is not set; `REAL_BOT_DATA_DIR` still takes precedence.
- Endpoint API keys and MCP credentials go to the system keyring (the Secret Service), which is GNOME Keyring or KWallet, instead of the macOS Keychain. The keyring has to be running and unlocked; with neither, saving a key fails and says which one to start.
- Moving to the Trash follows the freedesktop specification and uses your home Trash (`~/.local/share/Trash`), so the file manager shows the items and can put them back. A file on another disk goes through `gio trash`.

The docs and the [glossary](../CONTEXT.en.md) are written for macOS (Dock, Keychain, Finder, Trash); on Linux, the system keyring stands in for the Keychain and the file manager for Finder.

## What Bots run commands in

A Bot's `shell` tool runs commands in `/bin/bash` when there is one, and in `/bin/sh` otherwise: on Debian and Ubuntu `/bin/sh` is dash, where the bash a model writes fails. Terminals open your login shell (`$SHELL`, or your account's own shell when that is not set).

## Notifications

Deskfolk's notifications go through the desktop's notification service. Settings › Notifications turns them on for this computer, and the conversation you are looking at gets none. The count of what waits on you shows on the app's icon only where the dock shows such counts (Plasma, Ubuntu's dock, Dash to Dock). Neither has been tried on a real Linux desktop yet.

## Remote access and the remote screen

Remote access works as on the Mac ([remote access](remote-access.md)), with two differences.

Pairing a phone, removing one and the other remote access changes are approved in the system's polkit prompt, with your own password (or a fingerprint, where your PAM setup has one), where the Mac uses Touch ID. The prompt's words are fixed; Deskfolk's window says which device or change it is about. This needs the polkit policy the deb installs (`/usr/share/polkit-1/actions/com.real-bot.desktop.policy`, action `com.real-bot.desktop.remote-confirm`) and a polkit authentication agent running in your session, which every full desktop has.

An AppImage cannot install the policy, so pairing from one says it can't ask for your password. To pair from an AppImage, put the policy in place by hand (this has not been tried yet):

```bash
./Deskfolk_<version>_amd64.AppImage --appimage-extract    # unpacks into ./squashfs-root
sudo cp squashfs-root/usr/share/polkit-1/actions/com.real-bot.desktop.policy /usr/share/polkit-1/actions/
rm -rf squashfs-root
```

The remote screen needs a VNC server, since Linux has no screen sharing of its own: one listening on port 5900 of this computer only, such as x11vnc on an X11 session or wayvnc on Sway and Hyprland (GNOME's Wayland session has none that works). The steps are in [remote access](remote-access.md#on-linux), and the card in Settings lists them while no VNC server answers. While a phone is looking, Deskfolk keeps the screen awake and the computer from sleeping.

Neither has been tried on a real Linux desktop yet: the password prompt's answers were checked in a container, but pairing a phone from the app end to end and the remote screen have not been.

## Letting your own Claude Code run a Bot

Claude Agent ([how it works](behavior.en.md#claude-agent)) can be picked on Linux too: `claude` on your PATH, the official install script's `~/.local/bin/claude`, and installs through npm, bun, volta or Homebrew (Linuxbrew included) are all found, and your login shell is asked once when none of those has it. For one installed elsewhere, give its full path under Settings › Agents › Claude Agent. The other local agents work the same way. None of this has been tried on a real Linux machine yet.

## Not tried on a real Linux desktop yet

These have been built but not yet used on a real Linux desktop:

- Pairing a phone from the app, end to end.
- The remote screen through x11vnc or wayvnc.
- Dropping files from the file manager into the message box.
- Everyday use from start to finish.

## Not there yet

- Installing an update from inside the app: a new version is a download in the browser.
- Holding off idle sleep while work runs (the Mac does it on power).
- System proxy settings: only the `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` environment variables are read.
- The optional independent runtime (off by default on the Mac too).
- Image thumbnails and avatar scaling. Images sent to a model are scaled down when ImageMagick is installed and go as they are otherwise.
- arm64, rpm, Flatpak and Snap packages.

## Troubleshooting

- **Chinese text shows as boxes**: install a CJK font, such as `sudo apt install fonts-noto-cjk`.
- **No tray icon**: GNOME shows no tray icons without the AppIndicator extension; install and turn it on. Without a tray, the close button minimizes the window, and starting Deskfolk again brings it back.
- **The folder picker does not open**: it goes through xdg-desktop-portal; install a backend (`xdg-desktop-portal-gtk`, `-gnome` or `-kde`).
- **Pairing says no password prompt could open**: no polkit authentication agent is running. Start your desktop's own (a minimal window manager may not start one), then approve again.
- **Pairing says this copy of Deskfolk can't ask for your password**: the polkit policy is missing. Install the deb, or put the policy in place as [above](#remote-access-and-the-remote-screen).

## Running from source

The same `pnpm install` and `pnpm dev` as on the Mac (it opens the native app's development build), plus the GTK 4 (4.14 or newer), WebKitGTK 6.0, GStreamer, ALSA and libsecret development packages, cmake, and a one-time build of the terminal helper (`cargo build --manifest-path apps/conpty-helper/Cargo.toml`). Prerequisites and packaging steps are in the [development guide](development.md#linux实验性) (in Chinese).
