# Linux 预览版（实验性）

[English](linux.md)

Linux 版是刚起步的实验性预览：能装、能跑，终端、文件和废纸篓都能用，但有几样功能还只有 Mac 版才有。这一页说清怎么装、东西放在哪、和 Mac 版哪里不一样。它在 GitHub 的 Ubuntu 22.04 上构建和测试，还没在真的 Linux 桌面上从头到尾用过。

## 安装

只有 x86_64 的包，两种任选：

- **AppImage**：从[最新 Release](https://github.com/Blackman99/deskfolk/releases/latest)下载 `Deskfolk_<版本>_amd64.AppImage`，`chmod +x` 之后直接运行。要能挂 FUSE（大多数桌面发行版自带 `libfuse2`）；没有时可以 `--appimage-extract-and-run`。
- **deb**（Debian、Ubuntu 及其衍生版）：下载 `Deskfolk_<版本>_amd64.deb`，`sudo apt install ./Deskfolk_<版本>_amd64.deb`。依赖（WebKitGTK 4.1、GTK 3、托盘用的 AppIndicator）由 apt 一起装上。

两个包都在 Ubuntu 22.04 上构建，glibc 2.35 及更新的发行版能跑。包没有签名。

升级：「关于」里发现新版时，从 AppImage 跑的找新的 AppImage，装了 deb 的找新的 deb；只会打开浏览器去下载，还不能在应用里直接安装。

## 数据和密钥放在哪

- 数据目录是 `$XDG_DATA_HOME/real-bot`，没设时是 `~/.local/share/real-bot`；设了 `REAL_BOT_DATA_DIR` 时以它为准。
- 端点的 API key 和 MCP 凭据存进系统密钥环（Secret Service），也就是 GNOME Keyring 或 KWallet，不是 macOS 钥匙串。密钥环要开着并已解锁；一个都没有时保存会失败，并提示要启动哪一个。
- 移到废纸篓按 freedesktop 的规范进主目录的回收站（`~/.local/share/Trash`），文件管理器里能看到、能还原；不在主目录那块盘上的文件交给 `gio trash`。

文档和[术语表](../CONTEXT.md)按 macOS 写（Dock、钥匙串、访达、废纸篓）；在 Linux 上，钥匙串对应的是系统密钥环，访达对应的是文件管理器。

## Bot 用什么跑命令

Bot 的 `shell` 工具在有 `/bin/bash` 时用它跑命令，没有才用 `/bin/sh`：Debian 和 Ubuntu 的 `/bin/sh` 是 dash，模型写的 bash 语法在那里会出错。终端开的是你的登录 shell（`$SHELL`，没有时用账户自己的那个）。

## 远程访问和远程屏幕

还没有。Linux 的窗还没有确认配对用的系统对话框，所以设置里的远程访问卡片只写「Linux 版还不支持」，不给登记表。

## 让你自己的 Claude Code 跑 Bot

Claude Agent（[怎么用](behavior.md#claude-agent)）在 Linux 上也能选：PATH 上的 `claude`、官方安装脚本放的 `~/.local/bin/claude`、npm / bun / volta / Homebrew（含 Linuxbrew）装的都认，都找不到时问一次你的登录 shell；装在别处可以在 设置 › Agent › Claude Agent 里填完整路径。其他本机 Agent 同理。这些还没在真的 Linux 电脑上试过。

## 还没有的

- 远程访问和远程屏幕。
- 桌面通知与图标角标。
- 在应用里下载并安装更新：发现新版仍要去浏览器手动下载。
- 有活在跑时挡住空闲睡眠（Mac 上插电时有）。
- 系统代理设置：只认环境变量 `HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`。
- 可选的独立运行时（Mac 上也默认关闭）。
- 图片缩略图和头像缩放。发给模型的图片在装了 ImageMagick 时会缩小，没装就原样发。
- 语音输入还没在真机上试过。
- arm64、rpm、Flatpak、Snap 包。

## 遇到问题

- **窗口白屏或黑屏**（常见于 NVIDIA 显卡）：用 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 启动试试。
- **中文显示成方块**：装一套 CJK 字体，比如 `sudo apt install fonts-noto-cjk`。
- **托盘里看不到图标**：GNOME 默认不显示托盘图标，要装 AppIndicator 扩展。没有托盘时，关掉窗口后再启动一次 Deskfolk，就会回到已经开着的那个窗口。
- **选文件夹的对话框打不开**：选择框走 xdg-desktop-portal，装一个后端（`xdg-desktop-portal-gtk`、`-gnome` 或 `-kde`）。

## 从源码运行

和 Mac 一样是 `pnpm install`、`pnpm dev`，另要 WebKitGTK 等系统开发包，并先编一次终端 helper（`cargo build --manifest-path apps/conpty-helper/Cargo.toml`）。前置条件和打包步骤见[开发说明](development.md#linux实验性)（中文）。
