# Linux 预览版（实验性）

[English](linux.md)

Linux 版就是原生应用，和 Mac、Windows 上是同一个，目前仍是实验性预览。这一页说清怎么装、东西放在哪、和 Mac 版哪里不一样。它在 GitHub 的 Ubuntu 24.04 上构建，在那里和一个 Linux 容器里验过，但还没在真的 Linux 桌面上从头到尾用过。

## 安装

只有 x86_64 的包，两种任选，在[最新 Release](https://github.com/Blackman99/deskfolk/releases/latest) 里下载：

- **deb**（Debian、Ubuntu 及其衍生版）：下载 `Deskfolk_<版本>_amd64.deb`，运行 `sudo apt install ./Deskfolk_<版本>_amd64.deb`。依赖由 apt 一起装上：GTK 4.14 或更新、WebKitGTK 6.0、GStreamer、ALSA、libsecret 和 polkit。所以要 Ubuntu 24.04、Debian 13 或更新的版本；Ubuntu 22.04 和 Debian 12 太旧，装不上。
- **AppImage**：下载 `Deskfolk_<版本>_amd64.AppImage`，`chmod +x` 之后直接运行。它自带 GTK 4，但在 Ubuntu 24.04 上构建、也只在那上面跑过，所以大概要差不多新的发行版。它靠 FUSE 挂载自己；没有 FUSE 时加 `--appimage-extract-and-run` 运行。AppImage 装不了远程访问用来向你要密码的 polkit 策略（见[下文](#远程访问和远程屏幕)）。

两种包都没有签名。0.5.0 和 0.5.1 没有 Linux 安装包。

**从 0.4.0 升级**（旧应用的最后一个 Linux 预览版）：用同样的 `apt install` 把新的 deb 装上去就行。0.4.0 还开着的话，安装程序会先让它退出，剩下的进程再停掉。会话、设置和密钥都留在原处，「登录时启动」照常生效。应用菜单里的条目换了 id（`com.real-bot.desktop`），启动器或 Dock 上固定过旧条目的，可能要重新固定一次。用 AppImage 的，换成新的 AppImage 运行即可。在 Ubuntu 22.04 和 Debian 12 上，0.4.0 的「关于」仍会提示有新版，但 apt 会拒绝安装：在那里请留在 0.4.0。

**以后升级**：「关于」里发现新版时，会在浏览器里打开对应的下载：以 AppImage 运行的打开 AppImage，其余打开 deb。还不能在应用里直接安装。

## 托盘、窗口和登录时启动

- 关掉窗口只是把它收起来：Deskfolk 留在托盘里，Bot 继续干活。要退出，用托盘菜单里的「Quit Deskfolk」、按 Ctrl+Q，或者运行 `real-bot-desktop --quit`（AppImage 版就是带 `--quit` 运行那个 AppImage 文件）。
- Ctrl+W 关掉眼前的标签；没有标签可关时，把窗口收起来。
- 托盘菜单先列出各个套餐用了多少，再是「Show Deskfolk」「Stop Everything」「Quit Deskfolk」。单击图标显示窗口。
- 托盘图标走 StatusNotifierItem：Plasma、XFCE 和大多数面板都能显示；GNOME 要装 AppIndicator 扩展（`gnome-shell-extension-appindicator`）才显示。没有托盘时，关闭按钮改为最小化窗口。
- 同一时间只跑一份：再启动一次 Deskfolk，会把已经开着的窗口调到前面。
- 「登录时启动」（设置 › 通用）默认开着，除非你关掉。它写的是 `~/.config/autostart/Deskfolk.desktop`，登录后 Deskfolk 只待在托盘里，不开窗口；0.4.0 写的也是这个文件。

## 数据和密钥放在哪

- 数据目录是 `$XDG_DATA_HOME/real-bot`，没设时是 `~/.local/share/real-bot`；设了 `REAL_BOT_DATA_DIR` 时以它为准。
- 端点的 API key 和 MCP 凭据存进系统密钥环（Secret Service），也就是 GNOME Keyring 或 KWallet，不是 macOS 钥匙串。密钥环要开着并已解锁；一个都没有时保存会失败，并提示要启动哪一个。
- 移到废纸篓按 freedesktop 的规范进主目录的回收站（`~/.local/share/Trash`），文件管理器里能看到、能还原；不在主目录那块盘上的文件交给 `gio trash`。

文档和[术语表](../CONTEXT.md)按 macOS 写（Dock、钥匙串、访达、废纸篓）；在 Linux 上，钥匙串对应的是系统密钥环，访达对应的是文件管理器。

## Bot 用什么跑命令

Bot 的 `shell` 工具在有 `/bin/bash` 时用它跑命令，没有才用 `/bin/sh`：Debian 和 Ubuntu 的 `/bin/sh` 是 dash，模型写的 bash 语法在那里会出错。终端开的是你的登录 shell（`$SHELL`，没有时用账户自己的那个）。

## 通知

Deskfolk 的通知走桌面的通知服务。在 设置 › 通知 里给这台电脑打开；你正在看的会话不弹通知。等着你的事有几件，只在会显示这种计数的 Dock 上才标在应用图标上（Plasma、Ubuntu 的 Dock、Dash to Dock）。这两样都还没在真的 Linux 桌面上试过。

## 远程访问和远程屏幕

远程访问和 Mac 上一样（[远程访问](remote-access.zh.md)），差两处。

配对手机、移除手机和其他远程访问的更改，在系统的 polkit 弹框里用你自己的密码批准（PAM 配了指纹的话也可以用指纹），Mac 上这一步是触控 ID。弹框里的文字是固定的，具体是哪台设备、哪项更改，Deskfolk 的窗口里会写。这要有 deb 装上的 polkit 策略（`/usr/share/polkit-1/actions/com.real-bot.desktop.policy`，动作是 `com.real-bot.desktop.remote-confirm`），会话里还要有 polkit 认证代理在跑，完整的桌面环境都有。

AppImage 装不了这个策略，所以用它配对时会说没法向你要密码。要用 AppImage 配对，就手动把策略放进去（这一步还没试过）：

```bash
./Deskfolk_<版本>_amd64.AppImage --appimage-extract    # 解到 ./squashfs-root
sudo cp squashfs-root/usr/share/polkit-1/actions/com.real-bot.desktop.policy /usr/share/polkit-1/actions/
rm -rf squashfs-root
```

远程屏幕要一个 VNC 服务，因为 Linux 没有自带的屏幕共享：一个只听本机 5900 端口的 VNC 服务，比如 X11 会话用 x11vnc，Sway、Hyprland 用 wayvnc（GNOME 的 Wayland 会话没有能用的）。步骤见[远程访问](remote-access.zh.md#linux-上)，没有 VNC 服务应答时设置里的卡片也会列出来。手机在看屏幕期间，Deskfolk 会让屏幕保持常亮，电脑也不会休眠。

这两样都还没在真的 Linux 桌面上试过：密码框的各种结果在容器里验过，但从应用里把一部手机完整配对下来、远程屏幕，都还没有。

## 让你自己的 Claude Code 跑 Bot

Claude Agent（[怎么用](behavior.md#claude-agent)）在 Linux 上也能选：PATH 上的 `claude`、官方安装脚本放的 `~/.local/bin/claude`、npm / bun / volta / Homebrew（含 Linuxbrew）装的都认，都找不到时问一次你的登录 shell；装在别处可以在 设置 › Agent › Claude Agent 里填完整路径。其他本机 Agent 同理。这些还没在真的 Linux 电脑上试过。

## 还没在真的 Linux 桌面上试过的

这些做好了，但还没在真的 Linux 桌面上用过：

- 从应用里把一部手机完整配对下来。
- 经 x11vnc 或 wayvnc 的远程屏幕。
- 从文件管理器把文件拖进输入框。
- 日常从头到尾地用。

## 还没有的

- 在应用里直接安装更新：发现新版要去浏览器下载。
- 有活在跑时挡住空闲睡眠（Mac 上插电时有）。
- 系统代理设置：只认环境变量 `HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`。
- 可选的独立运行时（Mac 上也默认关闭）。
- 图片缩略图和头像缩放。发给模型的图片在装了 ImageMagick 时会缩小，没装就原样发。
- arm64、rpm、Flatpak、Snap 包。

## 遇到问题

- **中文显示成方块**：装一套 CJK 字体，比如 `sudo apt install fonts-noto-cjk`。
- **托盘里看不到图标**：GNOME 不装 AppIndicator 扩展就不显示托盘图标，装上并打开它。没有托盘时，关闭按钮只把窗口最小化，再启动一次 Deskfolk 就会回到那个窗口。
- **选文件夹的对话框打不开**：选择框走 xdg-desktop-portal，装一个后端（`xdg-desktop-portal-gtk`、`-gnome` 或 `-kde`）。
- **配对时说弹不出密码框**：没有 polkit 认证代理在跑。启动你桌面自带的那个（精简的窗口管理器可能不会启动它），再批准一次。
- **配对时说这份 Deskfolk 没法向你要密码**：缺 polkit 策略。装 deb，或者按[上文](#远程访问和远程屏幕)手动放进去。

## 从源码运行

和 Mac 一样是 `pnpm install`、`pnpm dev`（打开的是原生应用的开发版），另要 GTK 4（4.14 或更新）、WebKitGTK 6.0、GStreamer、ALSA、libsecret 的开发包和 cmake，并先编一次终端 helper（`cargo build --manifest-path apps/conpty-helper/Cargo.toml`）。前置条件和打包步骤见[开发说明](development.md#linux实验性)（中文）。
