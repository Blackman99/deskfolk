# Windows 预览版（实验性）

[English](windows.md)

Windows 版是刚起步的实验性预览：能装、能跑，但有几样功能还只有 Mac 版才有。这一页说清怎么装、东西放在哪、和 Mac 版哪里不一样。到 0.1.0-rc.12 为止，它只在一台 Windows Server 2022 上跑过，还没在 Windows 10 或 11 上验过。

## 安装

1. 从[最新 Release](https://github.com/Blackman99/deskfolk/releases/latest)下载 `Deskfolk_<版本>_x64-setup.exe`（只有 x64 安装包）。
2. 运行它。安装包按当前用户安装，不要管理员权限。
3. 安装包没有签名，SmartScreen 会提示未知发布者：点「更多信息」→「仍要运行」。

还需要 WebView2 运行时：Windows 11 预装；Windows 10 若没有，要先单独装上。

升级也是运行新版安装包。「关于」里发现新版时只会打开浏览器去下载，还不能在应用里直接安装。安装程序会先关掉开着的窗口，守护进程和它起的终端随之一起结束；只剩上次留下的守护进程时，安装程序也会先把它停掉，否则占着的文件覆盖不了。

## 数据和密钥放在哪

- 数据目录是 `%LOCALAPPDATA%\real-bot`（没设 `LOCALAPPDATA` 时退到 `<用户目录>\AppData\Local\real-bot`）；设了 `REAL_BOT_DATA_DIR` 时以它为准。
- 端点的 API key 和 MCP 凭据存进 Windows 凭据管理器（Credential Manager），不是 macOS 钥匙串。

文档和[术语表](../CONTEXT.md)按 macOS 写（Dock、钥匙串、访达、废纸篓）；在 Windows 上，钥匙串对应的是凭据管理器。

## Bot 用什么跑命令

Bot 的 `shell` 工具找得到 Git Bash 时用它跑命令，找不到才退到 PowerShell，所以建议装上 [Git for Windows](https://gitforwindows.org/)。环境变量 `REAL_BOT_TOOL_SHELL` 可以指定一个 `bash.exe`、`pwsh.exe` 或 `powershell.exe`，覆盖这个判断。

## 远程访问和远程屏幕

远程访问和 Mac 上一样（[远程访问](remote-access.zh.md)），差两处。批准设备用 Windows Hello——人脸、指纹或 PIN，所以先在 Windows 设置 → 账户 → 登录选项 里设一个 PIN。远程屏幕要一个 VNC 服务，因为 Windows 没有自带的屏幕共享：把 TightVNC 装成系统服务，设好密码，只允许本机回环连接；步骤见[远程访问](remote-access.zh.md#windows-上)，没有 VNC 服务应答时设置里的卡片也会列出来。这两样都还没在真的 Windows 电脑上试过（[ADR 0059](adr/0059-windows-remote-access-and-screen.md)）。

## 让你自己的 Claude Code 跑 Bot

Claude Agent（[怎么用](behavior.md#claude-agent)）在 Windows 上也能选。用官方安装脚本装的 `claude.exe`、npm 装的 `claude.cmd` 都认，装在别处可以在 设置 › Agent › Claude Agent 里填完整路径（`C:\…` 或 `~\…`）。Claude Code 自己在 Windows 上要 [Git for Windows](https://gitforwindows.org/)。没设代理环境变量时，它走 设置 › 网络和 Internet › 代理 里开着的那个代理。Stop 会结束 Claude Code 和它起的所有命令。这些还没在真的 Windows 电脑上试过（[ADR 0061](adr/0061-claude-agent-runner.md)）。

## 还没有的

- 可选的独立运行时（Mac 上也默认关闭）。
- 在应用里下载并安装更新：发现新版仍要去浏览器手动下载。
- 桌面通知与图标角标。
- 图片缩略图。发给模型的图片不受影响。

## 从源码运行

和 Mac 一样是 `pnpm install`、`pnpm dev`，另要 Rust 的 MSVC 工具链、Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」），并先编一次终端 helper。前置条件和打包步骤见[开发说明](development.md#windows实验性)（中文）。
