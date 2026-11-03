# Linux 预览版：XDG 数据目录、Rust pty helper 的 forkpty 后端、AppImage 加 deb，远控先关 / A Linux preview: XDG data folder, a forkpty backend for the Rust pty helper, AppImage and deb, remote access off for now

Status: implemented 2026-11-03（第一轮）。Windows 预览版（674ce839、[ADR 0059](0059-windows-remote-access-and-screen.md)）走过的路，Linux 照着走一遍：先能编、能跑、能打包，缺的如实列出。

## 背景

在这之前，Linux 只有守护进程和信使的单元测试在 Ubuntu CI 上跑，而且 pty、终端、缩图这些测试在那里都被跳过。桌面应用编不出来：`build-sidecar` 没有 `bun-linux-*`，`build-native` 遇到 Linux 三元组就抛错，`build.rs` 在非 Windows 上要 macOS 的五个文件。就算编出来，终端也是 503（Swift 的 `PtyHelper` 只认 Darwin），数据落在 `~/Library/Application Support`，更新检查会把 `.dmg` 推给 Linux 用户，打开、显示、剪贴板、废纸篓都报错，远控卡片会给一张批不了的登记表，文案满是 Finder 和钥匙串。

## 决定

1. **数据目录按 XDG。** `$XDG_DATA_HOME/real-bot`（必须是绝对路径，相对的按规范忽略），否则 `~/.local/share/real-bot`；`REAL_BOT_DATA_DIR` 仍然优先。`@real-bot/protocol` 的 `defaultAppDataDir` 和窗的 `local_api.rs` `default_data_dir`（参数从 `windows: bool` 改成 `std::env::consts::OS`）同一条规则。Linux 从没发过版，没有要迁移的数据。
2. **终端用 `apps/conpty-helper` 的 unix 后端。** 新的 `unix_impl.rs` 照 Swift 的 `PtyHelper` 逐行移植：`forkpty` 拿控制终端，信号发给 `tcgetpgrp` 的前台进程组，关会话先 SIGHUP、两秒后 SIGKILL，谁回收子进程谁决定退出码。产物同名 `real-bot-pty`，帧协议不变；macOS 继续用 Swift 版。线上的信号号码仍是 Darwin 的（守护进程不改），helper 按本机重新编号：Linux 的 SIGTSTP 是 20，原样转发的 18 会是 SIGCONT。子进程 exec 前把 SIGPIPE 恢复默认：Rust 运行时在 helper 里忽略了它，而被忽略的信号会穿过 exec。
3. **x86_64 的 AppImage 和 deb，在 Ubuntu 22.04 上构建。** AppImage 不挑发行版，deb 给 Debian 系一个能 `apt install` 的包；22.04 的 glibc 2.35 让较老的发行版也能跑。`build-native` 的 Linux 分支往 `native/` 里放 `real-bot-daemon` 和 `real-bot-pty`，`build.rs` 和 `nativeFilesFor("linux")` 只查这两个。
4. **Bot 的 `shell` 工具有 `/bin/bash` 就用它。** macOS 的 `/bin/sh` 就是 bash，模型写的 bash 语法在那里能跑；Debian 和 Ubuntu 的 `/bin/sh` 是 dash，同样的命令会失败。kind 仍是 `sh`，提示词还是 POSIX 的那份；`bash` 这个 kind 是 Git Bash 的，会说 Windows 路径。
5. **废纸篓自己按 freedesktop 规范写主目录那份。** 独占创建 `.trashinfo`，再 `rename` 进 `files/`，重名加序号；跨盘（`EXDEV`）交给 `gio trash`，没有 `gio` 就逐个说明。不依赖 GNOME，能在 Ubuntu runner 上测，每个路径各给各的结果，和另外两个平台一样。
6. **密钥照旧走 `Bun.secrets`（libsecret）。** 没有 Secret Service 时保存失败，换成 503 `keyring_unavailable`，点名 GNOME Keyring / KWallet；不静默退回到文件存储，那要改 [ADR 0034](0034-one-keychain-entry-on-macos.md) 的口径，不在这一轮。凭据护栏（`keychains.ts`，两个护栏共用）同时拦 Linux 的密钥环目录、`secret-tool lookup|search`、`kwallet-query` 和点名 Secret Service 的 D-Bus 调用。
7. **远控先关。** Linux 的窗还没有确认框（`local_confirm.rs` 答 unavailable），配不了设备。编译态守护进程在 Linux 上保留封口 provider，状态带 `platform_unsupported`，设置卡片写「Linux 版还不支持远程访问」，不给登记表。这个诊断原来是 Windows 预览版起步时用的，0059 之后 Windows 有了远控，现在只有 Linux 会给它。
8. **菜单照 Windows：窗里的菜单栏，快捷键只显示不注册。** 计划里原本想在 Linux 上不装菜单栏，免得 GTK 菜单和页面的快捷键打架；动手时发现「平分」「重置布局」只有菜单里有，去掉就没了入口。Windows 那条分支本来就是只显示、由页面接快捷键，搬到 Linux 上同样不会一个命令跑两次。
9. **剪贴板读 GTK 的。** 终端右键的粘贴走同步命令，Tauri 把它放在主线程上，正是 GTK 要的地方；`wait_for_text` 等剪贴板主人回话时转主循环。没用 arboard：它在 Wayland 上靠 data-control 协议，GNOME 不提供。
10. **打开不等，显示走 D-Bus。** 打开文件和链接用 `xdg-open`，不在主线程上等它（没有桌面助手时它会一直跑着被打开的程序）；显示用 `org.freedesktop.FileManager1.ShowItems`，不行就打开所在文件夹。`.desktop`、带执行位的、脚本、AppImage、`.jar`、`.exe` 这类打开就可能被运行的，一律改成显示，对应 Windows 的 `AssocIsDangerous`。
11. **更新检查按包的来历挑。** 带 `APPIMAGE` 环境变量跑的（AppImage 运行时设的）找 `_amd64.AppImage`，否则找 `_amd64.deb`；没有 Linux 包的 Release 不算新版。产物名照 CI 实际打出的 `Deskfolk_<版本>_amd64.{AppImage,deb}`。应用内安装仍只认 `.dmg`。

## 为什么不是别的

- **Swift 版 `PtyHelper` 加 Glibc 分支。** 能少一份代码，但 Linux 的 CI 和从源码跑的人都得装 Swift 工具链；Rust 已经是这个仓库的必需品，`conpty-helper` 的协议、命令行、信号模块本来就是跨平台的。
- **Bun 自带的 PTY（`Bun.spawn` 的 `terminal`）。** 看不出它会不会给 shell 一个控制终端，而那正是 helper 存在的理由；守护进程也就得为 Linux 另写一套 `Pty`。
- **portable-pty 的 unix 后端。** 它也在 pre_exec 里 setsid + TIOCSCTTY，但退出状态只给一个码加信号名，和 Swift 版「谁回收谁定退出码」的行为对不齐；直接 `forkpty` 和 Swift 版一行对一行，更好核对。
- **`gio trash` 一把梭。** KDE 和精简安装上不一定有，逐个路径的结果也得从它的输出里猜。
- **rpm、arm64、Flatpak、Snap 一起出。** 第一轮先把一种架构、两种包做扎实；GitHub 的 arm64 runner 和 rpm 都留到真机试过之后。

## 代价

- 都还没在真的 Linux 桌面上从头到尾用过：GTK 剪贴板、FileManager1、托盘（GNOME 默认不显示，没有托盘时靠 single-instance 再启动一次拿回窗口）、WebKitGTK 下的语音输入、HTML5 拖放。已做的：pty helper 的集成测试在 macOS 和 Ubuntu 上都对着真 shell 跑，守护进程的终端测试在 Ubuntu CI 上用它跑而不再跳过，Tauri crate 在 Ubuntu 上编译并跑完单测，CI 打出的 deb 里两个原生文件都带执行位。
- Linux 上还没有：远程访问和远程屏幕、桌面通知与角标、应用内下载安装、缩略图和头像缩放、工作时防睡眠、系统代理、独立运行时。发给模型的图片只在装了 ImageMagick 时缩小。
- 密钥依赖一个在跑的 Secret Service；纯窗口管理器或无头机器上要自己起 gnome-keyring。
- macOS 的 Swift helper 现在就会把被忽略的 SIGPIPE 带给终端里的 shell（`yes | head -1` 会多打一行 `Broken pipe`），Linux 这份已经修了，macOS 那份另说。
