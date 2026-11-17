# 原生应用补齐 Tauri 版的一切，Linux 也换上原生的 / The native app does all the Tauri app did, and Linux ships native too

Status: implemented 2026-11-17, Windows and Linux awaiting CI and a real machine. Builds on [ADR 0107](0107-spike-native-desktop-on-nsh.md) (the native app on NSH); replaces decisions 3, 7, 8, 9 and 10 of [ADR 0104](0104-linux-preview.md) (the Tauri Linux preview) and extends [ADR 0059](0059-windows-remote-access-and-screen.md) (Windows remote access) to the native app.

2026-11-17 你说「要彻底的移除 Tauri 的相关的所有东西了」，删之前先「全部补齐再删」，并且「nsh 支持 Linux，正好一把支持了」；Linux 上的远程控制也「这次一起做」。这份记录补齐时做的决定；删掉 Tauri 本身另有一份。

On 2026-11-17 you asked to remove everything Tauri, to bring every feature only the Tauri app had over first ("全部补齐再删"), to ship Linux on NSH at the same time, and to add remote control on Linux in this round. This records the decisions of that catching up; removing Tauri itself is recorded separately.

## 补齐了什么 / What was brought over

逐项对照 Tauri 外壳（`apps/desktop/src-tauri/src`）找出来的，每一项都在原生应用里有了：

Found by going through the Tauri shell file by file; each now exists in the native app:

- **三个平台 / All three:** 调用不再 30 秒超时、拒绝时给外壳原话（`tauri-bridge.ts`）；手机停掉的运行时被窗口清掉停止标记（`runtime.rs`）；托盘的「全部停下」（`stop_all.rs`）。Host calls that wait on a person are untimed and reject with the shell's own words; a runtime a phone stopped has its stop latch cleared by the supervising window; the tray's Stop Everything.
- **macOS:** 记住窗口大小（`window_state.rs`，沿用旧版的 `window-size.json`）；⌘W 关标签页、「视图」菜单、关于、隐藏其他；菜单栏图标左键显示窗口；登录启动只留在菜单栏（认 `keyAELaunchedAsLogInItem`），登录项跟随设置；`NSLocalNetworkUsageDescription`。The window's size, ⌘W as Close Tab and the View menu, a left click on the menu bar icon showing the window, a quiet login launch with the login item following the setting, and the local network usage string.
- **Windows:** 远程配对通道（daemon 的 stdin/stdout）、Windows Hello、`remote_native_confirmation`；daemon 放进随应用结束的 Job；关窗缩到托盘；恢复窗口位置；用系统打开、在资源管理器里显示、选文件夹（`AssocIsDangerous` 的类型只显示不打开）；Ctrl+W；语音输入。The setup channel over the daemon's stdin and stdout, Windows Hello, a job that ends the daemon with the app, close to tray, restored bounds, open/reveal/folder picker, Ctrl+W, voice input.
- **Linux:** 外壳换成 NSH 的 `run_app`（单实例、`--hidden`、恢复窗口、Ctrl+Q）；托盘（NSH 的 StatusNotifierItem，用量行、显示、全部停下、退出）；旧版的自启项 `~/.config/autostart/Deskfolk.desktop`；打开、显示、选文件夹；滚轮（NSH 自己的 `onWheel`）；HTML 预览（WebKitGTK 6）；语音输入；deb 和 AppImage。The shell on NSH's runner, the tray, the Tauri app's autostart entry, open/reveal/picker, the wheel, the HTML preview, voice input, the deb and the AppImage.

## 决定 / Decisions

1. **Windows 和 Linux 关窗缩到托盘，和 Tauri 一样。** 0.5 的 Windows 版关窗即退出、连运行时一起停，Bot 的活跟着断。关闭按钮现在由应用接（`window-life.ts`，`closeOnPress: false`）：收起窗口；系统要关（注销、关机）时照常退出；托盘的「退出」或再启动一次带 `--quit` 才真退出。Linux 上没有托盘宿主时（没装 AppIndicator 扩展的 GNOME，看会话总线上有没有 StatusNotifierWatcher）改成最小化，免得窗口藏起来找不回。
   **The close button puts the window away on Windows and Linux, as the Tauri app's did.** A system close still quits; the tray's Quit or a later `--quit` launch ends the app. With no tray host on Linux it minimizes instead.

2. **Linux 用 NSH 的 `run_app`，安装布局沿用 0.4.0。** 程序在 `/usr/lib/Deskfolk/real-bot-desktop`（`/usr/bin/real-bot-desktop` 是它的链接），`app/`、`native/` 在旁边；包名仍是 `deskfolk`，所以 0.4.0 的 deb 能原地升级；自启项沿用旧版的文件名和 `--hidden`。桌面项和图标改用应用 id `com.real-bot.desktop`，因为 NSH 的通知用它找桌面项。取代 0104 的第 3 条：在 ubuntu-24.04 上构建，NSH 要 GTK ≥ 4.14，Ubuntu 22.04 和 Debian 12 不再支持。
   **Linux runs on NSH's runner, installed where 0.4.0 was.** Same package name and autostart entry; the desktop entry and icon go by the app's id. Built on Ubuntu 24.04: NSH needs GTK 4.14, so Ubuntu 22.04 and Debian 12 are left behind.

3. **Linux 打开远程控制，本机确认用 polkit。** 取代 0104 的第 7 条。daemon 在 Linux 上用文件凭据库（和 Windows 一样，ADR 0033 的取舍）。确认走 polkit 的自有 action `com.real-bot.desktop.remote-confirm`：`auth_self`、每次都问、只有本地活动会话能批，deb 装 policy 文件，宿主用 `pkcheck --allow-user-interaction` 问。polkit 不让普通调用方改对话框的字，所以对话框说的是 policy 里固定的话，具体是哪台设备、哪项更改由应用窗口显示（配对卡片本来就写着设备名和指纹）。AppImage 装不了 policy，配对答 `confirm_not_configured`；没有认证代理答 `confirm_agent_missing`，两者都像 `hello_not_configured` 一样保留按钮、给出说明。
   **Remote control on Linux, with polkit as the owner check.** The file credential store as on Windows; polkit's `auth_self`, asked every time, active local sessions only. The prompt carries the policy's fixed words, and the window shows which device or change it is. An AppImage cannot install the policy (`confirm_not_configured`); no agent is `confirm_agent_missing`.

4. **Linux 的远程屏幕用现成的 VNC。** X11 用 x11vnc；wlroots 桌面用 wayvnc；新发行版可用 TigerVNC 的 `w0vncserver`；GNOME 的 Wayland 会话没有可用的 VNC 服务（只剩 RDP），设置卡片请你登录时选「Ubuntu on Xorg」。保持亮屏用 `real-bot-rtc stay-awake`：会话总线的 `ScreenSaver.Inhibit` 加 logind 的 sleep 抑制锁。手机端认得 `host: "linux"`：按键行是 Ctrl、Alt、Super、⇧，没有 Ctrl+Alt+Del 和流畅模式。
   **The Linux remote screen uses an existing VNC server**, with GNOME's Wayland session sent to its Xorg session; stay-awake holds the screensaver and logind inhibitors; phones know a Linux host.

5. **Windows 和 Linux 的「用系统打开」等由应用经 NSH 做。** `pick_paths`、`open_path`、`reveal_path` 只在 Rust 侧，所以放在应用自己的原生 crate（`app/native/src/files.rs`），两边共用一份；会运行的文件只显示不打开的规则照旧（Windows 问 `AssocIsDangerous`，Linux 看执行位和扩展名）。取代 0104 的第 9、10 条。
   **Open, reveal and the folder picker go through NSH from the app's own crate** on Windows and Linux, keeping the reveal-instead rule.

6. **Windows 和 Linux 的「重置布局」等放进窗格右键菜单。** Tauri 在这两个平台的窗口里画了菜单栏，原生应用不画（标题栏是应用自己的），「重置布局」原本就只有菜单这一个入口。取代 0104 的第 8 条。
   **Equalise and Reset Layout join the pane menu on Windows and Linux**, where the Tauri app had an in-window menu bar.

7. **Windows 和 Linux 的语音输入由外壳录 Ogg/Opus。** WebView 的 `MediaRecorder` 没了；宿主用 cpal 录、压成 Opus，一段最长 180 秒仍在远程链路 1 MB 的上限内。
   **Voice input on Windows and Linux is recorded by the shell as Ogg/Opus**, so a take fits the remote link's limit for its full three minutes.

## 代价 / Costs

- Windows 部分只在 CI 上编译和冒烟（这台 Mac 编不了 NSH 的 Windows 宿主）；Windows Hello、托盘、选文件夹、语音要在真机上点一次。The Windows parts are compiled and smoke-tested in CI only; Hello, the tray, the picker and voice need a real PC.
- Linux 部分在本机 Docker（arm64、Xvfb）和 CI（amd64）上验证；GNOME 的 Wayland、真实的 polkit 认证代理、真麦克风在容器里测不到。Linux is checked in a local container and CI; GNOME's Wayland session, a real polkit agent and a real microphone are not.
- Ubuntu 22.04 和 Debian 12 上的 0.4.0 用户升级不了：0.4.0 的关于页仍会提示新版，apt 会拒绝安装。0.4.0 users on Ubuntu 22.04 and Debian 12 cannot upgrade.
- macOS 登录时只留在菜单栏，靠的是 Apple 事件里的 `keyAELaunchedAsLogInItem`，要用签名的正式版注销再登录才能验证；旧版留下的 AppleScript 登录项若还在，会让应用在登录时被启动两次，第二次按「重新打开」处理。The macOS quiet login launch rests on the login item's Apple event, to be checked once with a signed release; a leftover AppleScript login item from the Tauri app launches the app a second time at login, which is read as a reopen.
