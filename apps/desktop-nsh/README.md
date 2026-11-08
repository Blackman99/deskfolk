# apps/desktop-nsh：NSH 原生客户端（试做）

> **试做，只在 `nsh-spike` 分支。** 用 longbridge 的 [Native Shell（NSH）](https://nsh.dev) 0.4.0 重写客户端：一份 TSX 界面，跑在 macOS、Windows、Linux 的原生窗口里，也编成 web 包给手机和平板；NSH 没有的东西在它上面补，不用 WebView。结论和数字见 [ADR 0107](../../docs/adr/0107-spike-native-desktop-on-nsh.md)。

## 结构

| 位置 | 是什么 |
|---|---|
| `app/` | NSH 的 TSX 界面，读信使的运行时（`src/runtime.ts` 里的 `MessengerRuntime`，每个窗口一个）。窗口是信使的外壳（`src/ui/shell/`：`shell-state.ts` 管层和返回、侧栏宽度、置顶、搜索、抽屉草稿，`Shell.tsx` 摆版面，`shell-keys.ts` 是窗口自己的键）：桌面宽窗是侧栏、工作台（每个标签由 `ui/workbench/PaneContentHost.tsx` 换成对话、日程、花费、用量、分工、地图、终端、工作区、任务看板或文件预览）和预览栏；手机和窄窗是名单铺满、页面盖在上面、底栏导航；平板上的托管页是侧栏加单页。`@real-bot/protocol` 经 `nsh.json` 的 `resolve.alias` 直接用 |
| `app/src/ui/interface/` | 你的界面方案在 NSH 上（[ADR 0108](../../docs/adr/0108-interface-profile-on-nsh.md)）：方案的令牌叠在 `theme.json` 上、重算 NSH 自己的令牌，经 NSH 内部的 `setup()` 运行时换进主题（只有 `theme.ts` 调它）；底线元素用 `floor()` 标出，套用后查字和底的对比度，只算方案造成的；⌥⇧⌘U 让这个窗口回到默认；`ui()` 是钩子，`reduceMotion()` 听方案也听系统。镜像的控制器不碰页面，平台这一侧由 `look.ts` 交给它，外壳在 `shell-state.ts` 接上 |
| `app/.ui/` | 界面测试：`scripts/ui-tests.ts` 起一个隔离的运行时（临时数据目录、空闲端口、内存钥匙串、不跑日程、模型端点立刻拒绝），预置 Bot 和会话，再无头跑这里的测试。隐藏目录，所以普通的 `nsh test` 不跑它们 |
| `app/src/m/` | 信使逻辑的镜像（`apps/messenger/src/lib` 同样的相对路径），见下面「信使逻辑怎么复用」 |
| `app/src/lib/reactive.ts` | Svelte 5 的 rune 在 NSH signal 上的实现：`state`（深层响应，数组 push、改字段都看得见）、`rawState`、`derived`、`effect`、`untrack`、`tick`、`snapshot` |
| `app/src/platform/` | 信使逻辑要读的浏览器全局（桌面上的 QuickJS 没有）：同步的 `localStorage`（存在 NSH 的 `Storage` 里，启动时整个读进来）、`sessionStorage`、`navigator`、`structuredClone`、`matchMedia`；桌面上还有 Tauri 桥（`tauri-bridge.ts`）：信使的 `invoke("<命令>")` 变成 `host.call("tauri.<命令>")`，外壳照 Tauri 时的命令名和参数回答，所以信使跟桌面打交道的逻辑原样能用。打开链接（`open_external_url`）、读剪贴板（`read_clipboard_text`）、窗口明暗（`plugin:window|set_theme`）不经外壳，桥里用 NSH 的 `openUrl`、`Clipboard`、`setColorScheme` 直接做（`APP_COMMANDS`），各平台和 web 都一样。语音输入的录音也由外壳做：`app/src/platform/media.ts` 在桌面补上 `navigator.mediaDevices.getUserMedia` 和 `MediaRecorder`，底下是外壳的 `shell.record.start` / `level` / `stop` / `cancel`（`host/src/recorder.rs`，AVAudioRecorder 录 AAC，交回 `audio/mp4`，和 Safari 的一样），信使的录音逻辑原样跑；第一次录音时系统会问麦克风权限（`.app` 的 Info.plist 带了 `NSMicrophoneUsageDescription`）。外壳还把滚轮、触控板双指滚动和捏合转给应用（`host/src/wheel.rs` → `app/src/platform/wheel.ts` 的 `onWheel`），因为 NSH 0.4 的视图收不到滚轮；终端的回滚已经用上。`app/src/platform/lifecycle.ts` 给出 `lifecycle()`（窗口有焦点、只是看得见、在后台）：桌面上就是 NSH 的；NSH 0.4 的 web 包里 `nsh` 模块没有它（调用就抛错，对话的「已读」效果从来没跑过），web 上改读页面的 `visibilityState` 和 `hasFocus()` 并跟着页面的 `focus` / `blur` / `visibilitychange` 变。macOS 外壳现在答：`local_api_endpoint`、`app_version`、`window_material`、`pick_workspace_folder`（系统的选文件夹面板）、`open_workspace_path`（用默认应用打开或在访达里显示）、`hide_main_window`（`host/src/system.rs`、`host_calls.rs`），还有通知的四个命令：`notification_permission_state`、`request_notification_permission`（系统的通知权限）、`take_notification_intent`（点了横幅后留下的 `clickRef`，取一次就空）、`report_notification_view`（答这扇窗口自己的可见、是否 key、是否最小化，并把出席情况报给运行时，每扇窗口各算一个实例）。投递循环也在外壳里（`host/src/notification_loop.rs`、`notifications.rs`，照 Tauri 外壳的 `notifications.rs` 搬过来，名字和 JSON 形状不变）：每 2 秒轮询运行时，关注数写进 Dock 角标（照设备偏好），清理版本变了就把已送达的横幅分批对账，再认领一条、复核、经 UNUserNotificationCenter 发出并回报；点横幅把最新的窗口提到前面。另外十个命令（照 Tauri 外壳的 `lib.rs`、`updates.rs`、`installer.rs`、`remote_*.rs` 搬过来，名字、参数和 JSON 形状不变；开发版的回答照 Tauri 开发版）：`set_launch_at_login`（`login_item.rs`，系统的 `SMAppService.mainAppService`；开发版答 `false`、什么也不改，打包版首次启动自己加入登录项）；`independent_runtime_status`（`independent.rs`，开发版 `available: false`、`diagnostic: dev_does_not_install_agent`，文件、端口和 launchd 标签都是开发版自己的）、`independent_runtime`（开发版拒绝，`disabled`；`enable`/`wait`/`force` 在打包版也带原因拒绝，`disable` 清掉过期标记，`cancel` 恢复窗口监管）；`remote_local_setup`、`remote_native_confirmation`（`remote_setup.rs`、`remote_native.rs`、`local_confirm.rs`，Touch ID 验证机主，原生助手在 `.app` 的 `Contents/Resources/native/`；开发版拒绝，`disabled`；打包版没有守护进程交来的通道时答 `desktop_channel_unavailable`）；`check_for_update`（`updates.rs`，三个桌面都答，用 `ureq` 取发布源，缓存 30 分钟，用户代理 `real-bot-desktop/<产品版本>`；产品版本和 `app_version` 一样读 Tauri 外壳的 `tauri.conf.json`，即发布时的版本行之一，宿主 crate 自己的 `0.0.0` 不用）、`can_install_update`、`update_install_state`、`cancel_update_install`、`start_update_install`（`update_commands.rs`、`installer.rs`；开发版 `can_install_update` 为 `false`、`start_update_install` 拒绝 `not-installed`，所以关于卡片只给浏览器下载，不会替换任何 bundle）。Windows 和 Linux 外壳在 `launch.rs` 里答这几个命令：登录项 `false`、不能装更新（`not-installed`）、独立运行和远程配对 `disabled`，更新检查照常 |
| `app/native/` | 应用自己的 Rust crate（`nsh.json` `"rust"`，TSX 里 `import … from "deskfolk/native"`），桌面三家和 web 的 wasm 都编进去：终端（`vt100` 管屏幕，`Canvas` 画）、PDF（`hayro` 渲染页面，也读出每页的文字和位置供查找、批注引用，读链接，按页截图给批注草稿，带密码的文件解密后再开；`native/src/pdf/`）和 Office（`office/`：Excel 用 `calamine` 读成信使的表格模型，Word 和 PowerPoint 用 `zip` + `quick-xml` 读成段落块和按比例摆放的形状）。Office 暂时只在桌面：`zip` 9 在 wasm32 上打开 `getrandom` 0.4 的 `wasm_js`，和 NSH 给 web 构建加的 `getrandom_backend="custom"` 一起编不过，web 上是同名的占位模块（`office_web.rs`，答「web 上还没有 Office 预览」） |
| `app/nsh.json` 的能力 | 网络只连 `127.0.0.1`（运行时）；剪贴板；系统的图片选择（`picker`）；读用户目录和 `/Volumes`（`fs.read`：拖进来、从访达复制的文件是 `file:` 地址，`fetch` 不收，经 `fs` 读）；打开 http(s)、mailto 和系统设置的共享面板（`openUrl`）；只显示内联页面的 web view（HTML 产物预览）；外壳的 `shell.*`、`runtime.*`、`tauri.*` |
| `app/web/host.js` | web 上页面一侧的宿主（`nsh.json` `web.host`）：回答 `runtime.endpoint`。`nsh package` 原样复制它、不打包它的导入，所以它必须自成一体。手机版不经它：配对、加密通道和设备存储都在 TSX 自己的 realm 里跑（web 上那是页面里一个隐藏的同源 iframe，浏览器的全局都在），见 ADR 0107「Phase 1c」 |
| `app/Hosted.tsx` | 手机版（托管）的入口：先设信使的托管开关（`src/platform/hosted.ts`，等于 `REAL_BOT_HOSTED=1`），再跑 `App.tsx`。没配对时窗口（`src/Main.tsx`）是配对页（`src/ui/remote/PairingScreen.tsx`），配对后经中继的加密通道连 Mac（信使的 `RemoteApi`，`src/m/remote/*`），窗口就是桌面同一个外壳 `Shell`：手机宽度名单铺满、对话盖上去、底栏导航，平板宽度名单一栏加一页，托管版永远没有工作台（`isWorkbenchSurface(narrow, HOSTED_MESSENGER)`）。`nsh package Hosted.tsx --target web` 打包；桌面和本机 web 版仍从 `App.tsx` 进，不受影响 |
| `host/` | 每个桌面自己的外壳（`deskfolk-nsh`）：macOS（AppKit 窗口、侧栏毛玻璃、菜单栏、托盘、通知、Dock 角标）、Windows（Win32 窗口 + 子窗口 `AppView`，骨架）、Linux（GTK 4，骨架）；读开发运行时的地址，不连 17890 |
| `native/terminal/`、`native/pdf/` | macOS 专用的原生组件（NSView 终端、PDFKit），Phase 0 留下的，作对照和以后加密 PDF 的兜底 |
| `scripts/` | 开发实例（`dev-instance.ts`）、开发运行时（`dev-runtime.ts`）、桌面开发版（`dev.ts`）、web 开发版（`web-dev.ts`）、打包（`package.ts`）、检查脚本（`ci-smoke.ts`、`e2e-live.ts`、`terminal-probe.ts`、手机版端到端 `phone-web-e2e.ts` 和它的 Mac `phone-runtime.ts`、TLS 边缘 `phone-edge.ts`） |

## 信使逻辑怎么复用

信使 `apps/messenger/src/lib` 里不碰 DOM 的逻辑（接口客户端 `local-api.ts`、快照归约 `snapshot.ts`、文案 `copy.ts`、会话分组、工作台布局……）原样用，界面重写。`bun apps/desktop-nsh/scripts/port-messenger.ts` 把它镜像进 `app/src/m/`：

- 不碰 DOM、导入链里没有 rune 的模块：一行转发（`export * from "<原文件>"`），每次运行重写，不要手改。
- rune store（`*.svelte.ts`）和导入链碰到它们的模块：翻译件。codemod 把 class 字段的 `$state` / `$derived` 换成 `reactive.ts` 的 getter/setter，`$effect` 换成 `effect`，`svelte` 的 `untrack` / `tick` 也指过去；模块级的 `$state` 和导入 `.svelte` 组件类型的地方手改。翻译件只生成一次，之后手改；头部的 `// Source:` 记着它是从原文件哪一版翻的。
- 用不上的不镜像：Monaco、pdf.js 的查看器、xterm、DOMPurify 的 Markdown、测试工具。
- `app/mirror.test.ts`（生成的）在 QuickJS 里把镜像的每个模块都加载一遍。
- `--check` 不写文件：转发缺了或旧了、原文件没了、翻译件落后于原文件（`Source` 对不上），都报错退出；`pnpm --filter @real-bot/desktop-nsh test` 和 CI 都跑它。信使改了逻辑，重跑一次脚本；改了被翻译的 store，照着改翻译件再更新 `Source`。

## 和稳定版并存

开发版有自己的一整套，装好的稳定版照常跑，互不影响：

| | 稳定版 | 开发版 |
|---|---|---|
| 端口 | 17890 | 17990（web 开发版页面在 17991） |
| 数据目录 | 各系统的标准位置（macOS `~/Library/Application Support/real-bot`，Windows `%LOCALAPPDATA%\real-bot`，Linux `~/.local/share/real-bot`） | 同一位置旁边的 `real-bot-nsh-dev`（工作区在它的 `workspace/`） |
| 钥匙串服务 | `com.real-bot.daemon` | `com.real-bot.daemon.nsh-dev` |
| 应用 id | `com.real-bot.desktop` | `com.real-bot.desktop.nsh-dev`（「Deskfolk Dev」） |

开发版不退回去连 17890（`dev-instance.test.ts`、宿主的 `endpoint` 测试）；不装登录项和 launchd，不检查更新，定时任务默认关（`--schedule` 打开）。开发期间不要跑根目录的 `pnpm dev`，它的源码守护进程会和稳定版抢 17890。

## 命令

需要：`nsh` 0.4.0（`curl -fsSL https://nsh.dev/install.sh | NSH_VERSION=v0.4.0 sh`）、Rust、Bun、Xcode 命令行工具；web 包还要 `rustup target add wasm32-unknown-unknown` 和 `rustup component add llvm-tools`（`llvm-ar`）；终端要一份 pty helper（macOS `apps/runtime-helper` 的 `swift build`，Linux 和 Windows `apps/conpty-helper`）。跑 `nsh test` / `nsh check` 时 `cargo` 要在 PATH 上（它们会编 `app/native`）。

```sh
bun apps/desktop-nsh/scripts/dev.ts            # 起开发运行时（没起的话）、编宿主、编界面，打开「Deskfolk Dev」；改 app/ 自动重载
                                               # 宿主是调试构建，但依赖（NSH、QuickJS、排版）按 opt-level 3 编（Cargo.toml 的 profile.dev.package."*"），第一次编要几分钟
bun apps/desktop-nsh/scripts/dev.ts --seed-from-stable   # 空数据目录时从稳定版的库拷一份快照（只读拷贝；Bot 仍指向你真实的工作区）
bun apps/desktop-nsh/scripts/web-dev.ts        # 编 web 包（app/native 编成 wasm）并在 http://127.0.0.1:17991/ 提供，连开发运行时
cd apps/desktop-nsh/app && nsh package Hosted.tsx --target web --out ../build/phone   # 手机版（托管）的 web 包，由中继的来源提供
bun apps/desktop-nsh/scripts/package.ts --sign developer-id [--notarize <notarytool profile>] [--measure 3]
```

测试：

```sh
pnpm --filter @real-bot/desktop-nsh test              # 开发实例的隔离；信使镜像是否跟上（--check）
cd apps/desktop-nsh && cargo test --workspace           # 宿主、app/native（终端去重、调色板）、原生组件
cd apps/desktop-nsh/app && nsh check App.tsx && nsh test # 类型检查；无头界面测试（网络打桩）和 app/native 的测试
bun apps/desktop-nsh/scripts/ui-tests.ts [名字]          # 界面测试，连一个隔离的真运行时（不是开发实例，也不是稳定版）
bun apps/desktop-nsh/scripts/ci-smoke.ts <宿主可执行文件> apps/desktop-nsh/build/app/bundle.js   # 宿主打开、界面跑起来、拿到开发运行时的第一份快照
bun apps/desktop-nsh/scripts/e2e-live.ts                # 无头连真实开发运行时：列表、打开、实时事件
bun apps/desktop-nsh/scripts/phone-web-e2e.ts [--no-build] [--browser chromium|webkit] [--shots <目录>]   # 手机版全程，全在本机：自己的中继（TLS 边缘同源提供页面）、隔离的 Mac（REAL_BOT_DEV_REMOTE=1）、无头浏览器配对，再在外壳里走手机宽度的名单、打开、发送、实时更新、返回、重载仍登记，和平板宽度的一栏加一页；截图按浏览器命名
bun apps/desktop-nsh/scripts/terminal-probe.ts          # 终端：颜色、宽字符、吞吐、vim、top（要开发版开着终端面板和截图）
```

Windows 和 Linux 不能在 Mac 上交叉编译，在 GitHub Actions 的 `.github/workflows/nsh-desktop.yml` 上构建、测试和冒烟（Linux 在 Xvfb 下）。

开发版宿主的检查用参数（`dev.ts` 用环境变量传，macOS）：`--background`（不激活、不进台前调度、放到副显示器）、`--snapshots <dir>`（窗口自己渲染成 PNG；往 `<dir>/request` 写空行截图，写 `new-window`、`badge 3`、`notify 文本` 做对应的事，写 `wheel <x> <y> <dy> [ctrl]` 在第一个窗口里模拟一次滚轮，写 `resize <宽> <高> [步数] [间隔毫秒]` 把第一个窗口分几步拉到这个大小，模拟拖窗口边，写 `drag <x0> <y0> <x1> <y1> [步数] [间隔毫秒]` 在第一个窗口里按住左键从一点拖到另一点（坐标从窗口左上角算；分隔条、交汇手柄都走真实的手势；事件只发给这扇窗口，不动人的光标，日志记下每次按下和松开的时刻），配 `--fps` 看每帧花在哪）、`--open-session <id>`（`--story shell` 也认，打开那条对话）、`--pane terminal|pdf`（不开外壳，只开试做期的终端或 PDF 面板，给 `terminal-probe.ts` 和帧率探针用）、`--pdf <path>`、`--fps`（NSH 帧监视，日志 `nsh::perf`）、`--scroll-probe`、`--terminal native`（换回 NSView 终端作对照）、`--story <名字>`（`DESKFOLK_STORY=<名字>`：编 `Story.tsx`，窗口只开 `stories/index.ts` 里那一屏）。自动检查不往屏幕注入键鼠事件，也不需要屏幕录制权限。
