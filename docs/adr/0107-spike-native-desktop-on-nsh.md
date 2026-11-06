# 试做：桌面端换成 NSH 原生界面 / Spike: a native desktop on NSH

Status: proposed 2026-11-06。Phase 0 试做在 `nsh-spike` 分支完成，自动能验的都验了；剩下几项要你亲手看（见「还没验的」），之后定「换」还是「暂不换」。代码在 [`apps/desktop-nsh`](../../apps/desktop-nsh/README.md)。

Status: proposed 2026-11-06. Phase 0 is done on the `nsh-spike` branch and everything that can be checked without you has been; a few things need your own eyes and hands (see "Not yet checked") before the call is go or not yet. The code is in `apps/desktop-nsh`.

## 背景 / Background

2026-11-06 你说「用 nsh 重写应用」，又补了两条：开发期间稳定版要独立运行、开发版单独起来调试；NSH 没有的功能补上基于它的原生实现，最好不出现 WebView。NSH 是 longbridge 的 Native Shell（nsh.dev，Apache-2.0）：界面用 Rust 或 TSX 写，TSX 跑在 QuickJS 上，每个平台画自己的原生控件（macOS 上是 AppKit + Core Animation + CoreText），没有 DOM 和 CSS。0.4.0 发布于 2026-11-04，第一版是 10-17。桌面端现在是 Tauri 2 + Svelte 5（`apps/messenger` 约 17 万行，`apps/desktop/src-tauri` 约 1.15 万行）；守护进程、协议、relay 不在这次范围里。

On 2026-11-06 you asked to rewrite the app with nsh, then added two rules: during development the installed stable build runs on its own and the dev build is started separately; whatever NSH lacks gets a native implementation built on it, preferably with no WebView anywhere. NSH is longbridge's Native Shell: UI in Rust or TSX (QuickJS), each platform's own views (AppKit, Core Animation and CoreText on macOS), no DOM, no CSS; 0.4.0 shipped 2026-11-04, the first release 10-17. Today's desktop is Tauri 2 + Svelte 5; the daemon, the protocol and the relay are out of scope.

## 试做了什么 / What the spike built

- **宿主（Rust，嵌入模式）**：自己建 NSWindow，背后垫 `NSVisualEffectView`（sidebar 材质，和 Tauri 窗口同一种），标题栏透明、内容铺到标题栏下；每个窗口一个 NSH `AppView`，各自连守护进程，内存里不共享，和每个 Tauri 窗口各跑一份页面一样。菜单栏、托盘（`NSStatusItem`）、系统通知（`UNUserNotificationCenter`，照 `notifications_macos.rs` 写）、Dock 角标都在宿主里。守护进程的地址和 token 由宿主读开发数据目录的 `local-api.json`，经 NSH 的 `host.params` 交给界面。 / **The shell (Rust, embedding):** its own NSWindow over the sidebar material, a transparent title bar, one NSH `AppView` per window talking to the runtime on its own; menu bar, tray, notifications and the Dock badge live in the shell; the runtime's address and token reach the UI through `host.params`.
- **原生组件**：`deskfolk.terminal`（`alacritty_terminal` 管屏幕状态，自绘 NSView，`NSTextInputClient` 收键盘和输入法，自己连事件流和终端接口，字节不经过 JS）和 `deskfolk.pdf`（PDFKit 的 `PDFView`）。都按 NSH 的 `NativeComponent` 写、用 `AppView::register_component` 注册，接口只有小数据，可以提给上游。 / **Native components:** a terminal (alacritty_terminal state, an NSView of our own, `NSTextInputClient`, its own socket so bytes never touch JS) and a PDF view (PDFKit), both NSH `NativeComponent`s with data-only interfaces.
- **界面（TSX）**：会话列表、对话（`List` 倒序虚拟化，`TextView` 渲染 Markdown、可跨块选中、代码块自带高亮）、输入框、终端和 PDF 面板。数据层照信使的 `event-sync.ts`：一条 sync-v1 socket，快照做基线，按序号接事件，断档、实例变了或 `resnapshot` 就重拉。`@real-bot/protocol` 经 `nsh.json` 的 `resolve.alias` 直接用，类型和值都行（值导入后 bundle 只多 1.7 KB）。 / **The UI (TSX):** the list, a conversation (inverted virtualised `List`, `TextView` for Markdown with selection and highlighted code), the composer, the terminal and PDF panes; the data layer follows the messenger's `event-sync.ts`; `@real-bot/protocol` is used directly through a `resolve.alias`, types and values alike.
- **开发版和稳定版并存**：开发版用 17990、`real-bot-nsh-dev` 数据目录、钥匙串服务 `com.real-bot.daemon.nsh-dev`、bundle id `com.real-bot.desktop.nsh-dev`。守护进程源码一行没改：`dev-runtime.ts` 用 `startRuntime({ dataDir, bind, endpointKey, supervisor: "none" })` 起，和 `ui-fixture.ts`、`demo-studio.ts` 一样。计划原本写「同一服务另起一项」，试做中发现 `bundledKeyStore` 会读同一服务下旧格式的单项、在改和删时把它们删掉，而那些是稳定版的，所以改成了另一个服务。 / **Side by side with stable:** port 17990, its own data directory, Keychain service and bundle id, and no daemon source changed. The plan said "another entry under the same service"; `bundledKeyStore` reads and deletes the legacy per-name items of its service, which are stable's, so the dev build got a service of its own.

## 过关清单 / The gates

| 条件 / Gate | 结果 / Result | 证据 / Evidence |
|---|---|---|
| 打包的 `.app` 启动、连上 17990 | 过 / pass | `package.ts --measure 3`：第一份快照在启动后 789 / 276 / 307 ms 到 |
| 稳定版和开发版互不影响 | 过 / pass | 前后对照：17890 上一直是 pid 40167；稳定版 `local-api.json` 的哈希和修改时间不变；开发运行时没有一条连 17890 的连接；单测 `dev-instance.test.ts`、宿主 `endpoint`/`runtime` 测试拒绝 17890 |
| 没有 WebView | 过，有一条说明 / pass, with a note | 二进制不链接 WebKit（`otool -L` 只有 AppKit、CoreGraphics、CoreText、Foundation、IOKit、ImageIO、Metal、PDFKit、QuartzCore、UserNotifications、CoreFoundation），依赖树里没有 wry；运行时不创建 WebView：启动后没有新的 WebContent 进程，没有 `~/Library/WebKit/<bundle id>`。但进程里映射着 WebKit 的镜像，NSH 自带的 `nsh-macos-host` 也一样，是系统框架带进来的，不是我们或 NSH 的 WebView（NSH 的 WebView 是首次使用时才 `dlopen`） |
| 毛玻璃、隐藏标题栏、第二个窗口、托盘、通知、Dock 角标 | 做出来了；一半要你看 / built; half need your eyes | 第二个窗口错开 28pt 打开；角标设成「3」读回是「3」；Notification Center 收下了横幅，但「Deskfolk Dev」还没有通知权限；托盘项建出来了（有按钮、有符号、visible）。毛玻璃由窗口服务器画，自绘截图看不到 |
| 列表和对话随事件实时更新 | 过 / pass | `e2e-live.ts`：对话开着时外面写一条，靠事件流出现；无头测试 4 条（列表、打开渲染 Markdown、发送、回车发送） |
| 1000 条消息滚动不卡 | 过 / pass | release、60Hz 屏，一行一帧从最新滚到最旧再回来，翻页一路加载 1003 条：33 s，平均 59.5 帧，最低 58，每秒 p95 最差 4.34 ms，单帧最差 9.49 ms，超预算 0%，新建 1288 行，峰值 154 MB；120Hz 屏上同样的滚动 118–120 帧 |
| 跨块选中复制 | 要你看 / needs you | `TextView selectable` 已开 |
| 中文输入法 | 要你试 / needs you | 输入框：NSH 文档写明组字时回车不提交，macOS 上 `onChange` 带组字文本；终端：`NSTextInputClient` 的 marked text 画在光标处、候选框位置走 `firstRectForCharacterRange` |
| 原生终端：60fps、vim/top、输入法 | 画面过，手感和输入法要你试 / drawing passes; feel and IME need you | 20 万行刷屏时 debug 构建 52 帧/秒、平均 4.1 ms、p95 5.0 ms；16 色、216 色、中英文宽字符对齐、vim（备用屏、语法色）、top（反白表头）都对 |
| 原生 PDF | 读出来了，显示和交互要你看 / opens; display and use need you | 200 页、读出首行；PDFKit 分块绘制，自绘截图抓不到页面 |
| TSX 直接用 `@real-bot/protocol` | 过 / pass | 类型和值都行 |
| Developer ID 签名、公证 | 签名过，公证要你的 profile / signed; notarising needs your profile | Gatekeeper：`Unnotarized Developer ID`，origin 是你的 Developer ID；钥匙串里的 notarytool profile 我不碰 |
| 启动和内存不比 Tauri 差 | 内存过；启动只量了这边 / memory passes; start-up measured on this side only | 开发版单窗口 33–37 MB（`footprint`）；稳定版此刻 909 MB（主进程 58 + WebKit GPU 200 + WebContent 643 + Networking 8，用了 50 分钟、开着 7 个终端，负载不同，只能看量级）。Tauri 版的冷启动没量：要重开你在用的稳定版 |

## 试做里发现的 / Found on the way

- NSH 0.4 的嵌入宿主连 dev server 的函数是 `pub(crate)`，自己的宿主用不了它的热更新；开发版改成 `nsh build`（约 10 ms）后宿主监听 bundle 重新 `load`。 / Embedding hosts cannot use NSH's dev-server client in 0.4; the dev loop rebuilds (`nsh build`, ~10 ms) and the shell reloads.
- NSH 文档（main 分支）写的 `AppOptions::notifications` 在 0.4.0 里没有，通知由宿主自己做。 / `AppOptions::notifications` in NSH's docs is not in 0.4.0; the shell posts notifications itself.
- 翻页：List 每次接近末尾只问一次，加载中再来的请求不能丢（`loadOlder` 记下来，这一页到了再接着拉）。 / The list asks once per approach to its end, so an ask during a load is kept and served.
- 终端组件连本机要关掉环境代理（ureq 默认读 `HTTP_PROXY`）。 / The terminal's HTTP client ignores environment proxies.
- `dev.ts` 被 SIGTERM 停掉时要连带停子进程，不然开发运行时留成孤儿。 / `dev.ts` stops its children on SIGTERM too.
- 这个终端环境没有屏幕录制权限，自动检查改由宿主自己把窗口渲染成 PNG（`--snapshots`），不碰你的屏幕；台前调度会把没激活的窗口收成缩略图，`--background` 的窗口因此不参与台前调度、放在副显示器。 / Checks render the window from inside the shell (no Screen Recording, no input on your screen); background windows stay out of Stage Manager.

## 还没验的 / Not yet checked

都要你在「Deskfolk Dev」里亲手做：`bun apps/desktop-nsh/scripts/dev.ts` 打开后，(1) 输入框和终端里用拼音各打几句，看组字、选词、回车；(2) 终端的手感（打字延迟、滚动回看、粘贴）；(3) PDF 面板打开一份 PDF，滚动、缩放、选字；(4) 对话里拖选几段跨块文字复制；(5) 菜单栏右上角有没有托盘图标（两个人的符号）；(6) 系统设置 › 通知 里允许「Deskfolk Dev」后，Dock 角标和横幅；(7) 窗口的毛玻璃看着和稳定版是否一样。公证：告诉我 notarytool 的 profile 名，或自己跑 `package.ts --sign developer-id --notarize <profile>`。

All in Deskfolk Dev (`bun apps/desktop-nsh/scripts/dev.ts`): pinyin in the composer and the terminal; the terminal's feel; a PDF scrolled, zoomed, selected; a cross-block selection copied; the tray icon; the badge and a banner once notifications are allowed; the glass next to stable's. Notarising needs your notarytool profile.

## 建议 / Recommendation

建议**换**，进 Phase 1，条件是上面七项你看过没有大问题。理由：最担心的几样（终端、长列表、Markdown、实时同步、并存隔离）在原生上都做出来了，性能有余量；NSH 缺的窗口级功能宿主一两百行就补上；不用 WebView 的要求能守住。代价也要说清：NSH 才三周大（0.1 → 0.4 用了 18 天），API 还会动；剩下的补件（Office 预览、远程屏幕、音视频、流程图）和 17 万行界面的逐屏迁移是几个月的活；界面方案（ADR 0106）的自定义 CSS 在原生界面里没有对应物，要另写 ADR 改成「按钩子改样式」；Windows 和 Linux 的原生组件要各写一份。计划里的四个拍板项（自定义 CSS、手机端、Windows/Linux、Office 预览）仍待你定。

Go to Phase 1 if the seven checks above hold. The riskiest pieces (terminal, long lists, Markdown, live sync, side-by-side isolation) work natively with headroom; the window-level gaps took a couple of hundred lines in the shell; no-WebView holds. The costs: NSH is three weeks old and its API will move; the remaining components and the screen-by-screen port of ~170k lines are months of work; ADR 0106's custom CSS has no native counterpart and needs an ADR of its own; Windows and Linux need their own native components. The plan's four open decisions still stand.

## 补记 2026-11-06：四项决定 / Addendum 2026-11-06: the four decisions

你看完试做后定了四件事：自定义界面走 NSH 自己的机制；手机端完整走 NSH（web 输出）；Windows 和 Linux 同步做，用 NSH 编出来的版本；Office 预览先找现成库，没有就自己实现。随之而来的改变：补件不再只写 macOS 的 NSView，要跟着 NSH 出到所有目标。终端改成「纯 Rust 屏幕状态 + NSH `Canvas` 绘制 + 隐藏 `input()` 收输入法」，macOS 的 NSView 版留作快速路径；PDF 用纯 Rust 的 `hayro`（加密文件交给系统兜底）；Word 和 PowerPoint 先用 `office2pdf` 转 PDF 再交给 hayro，和 `rdocx`/`rpptx` 对照后再定；Excel 用 `umya-spreadsheet` 读、NSH 的 `DataTable` 画。手机的加密传输、WebAuthn、IndexedDB、推送放进 NSH 的 `web.host` 页面模块，直接用 `packages/remote`；中继改发 NSH 的 web 包。自定义界面分三层：令牌走 `set_theme_overrides`（web 播放器缺这个接口，给上游提）；自定义 CSS 换成「按钩子挂 Tailwind 类名」；新增 Bot 写的 TSX 界面模块，经检查、签名后在沙箱 view 里运行。Windows 和 Linux 不能在 Mac 上交叉编译，在 CI 上构建。第一步是 Phase 1a 的四项验证：Canvas 终端的帧率、hayro 在原生和 wasm 上、同一份 TSX 出 web 包连开发运行时、Windows 和 Linux 宿主在 CI 上构建。

After the spike you settled the four questions: customisation through NSH's own means; the phone fully on NSH via its web output; Windows and Linux in parallel from NSH's own builds; Office previews from existing libraries where they fit, else our own. So the gap fillers must reach every target: the terminal becomes pure-Rust screen state drawn on NSH's `Canvas` with a hidden `input()` for input methods (the macOS NSView stays as a fast path); PDF uses pure-Rust `hayro` with system fallbacks for encrypted files; Word and PowerPoint go through `office2pdf` to PDF, compared against `rdocx`/`rpptx`; Excel is read with `umya-spreadsheet` and drawn in NSH's `DataTable`. The phone's encrypted transport, WebAuthn, IndexedDB and push live in NSH's `web.host` page module on top of `packages/remote`, and the relay serves NSH's web package. Customisation has three layers: tokens via `set_theme_overrides` (the web player lacks it; to be proposed upstream), custom CSS replaced by Tailwind classes per hook, and Bot-written TSX modules checked, signed and run in a sandboxed view. Windows and Linux build in CI, since NSH does not cross-compile. Next: Phase 1a's four checks.

## 补记 2026-11-06：Phase 1a 跨平台地基 / Addendum 2026-11-06: Phase 1a, the cross-platform groundwork

| 项 / Item | 结果 / Result |
|---|---|
| Canvas 终端（macOS 和 web） | 过。屏幕状态换成 `vt100`（`alacritty_terminal` 编不进 wasm），放进应用自己的 crate `app/native`，用 NSH 的 `Canvas` 画；键盘走隐藏的 `Input`（输入法在里面组字）加 `keymap`。macOS release：每帧主线程画 Canvas 2–4.7 ms，NSH core 每次提交 0.16–0.24 ms；20 万行刷屏约 2 秒追上；vim、top、16/256 色、宽字符都对。web（无头 Chromium）：刷屏时 6 秒 361 帧，帧间隔 p95 16.8 ms，不掉帧。debug 构建慢上千倍（一次提交约 200 ms），性能只看 release。重绘按帧合并（16 ms 一次）。web 上量的字宽和浏览器实际字宽略有出入，粗体段前会多一点空 |
| hayro PDF（原生和 wasm） | 过，有一条要跟进。原生：200 页文档打开 28 ms，一页（约 1700 像素宽）渲染 29–31 ms。wasm：打开 18 ms，一页 272–317 ms，而且在页面主线程上，手机上翻 PDF 会卡，要放进 Worker 或开 wasm SIMD（Phase 1e）。每页 PNG 约 1 MB，以后换更省的格式 |
| 同一份 TSX 出 web 包，连开发运行时 | 过。`scripts/web-dev.ts` 同源提供 web 包和端点；页面宿主 `app/web/host.js` 回答 `runtime.endpoint`。首屏列表 163 ms，1000 条的对话、终端、PDF 都能用，控制台无错。wasm 引擎带上 `app/native`（vt100、hayro 和内嵌字体）后 12.5 MB，brotli 3.38 MB |
| Windows 和 Linux 宿主骨架在 CI 上构建 | 代码和工作流写好（`host/src/win.rs`、`host/src/gtk.rs`、`.github/workflows/nsh-desktop.yml`、`scripts/ci-smoke.ts`）；宿主的跨平台部分（参数、端点、开发运行时、各系统的数据目录）抽了出来，macOS 上冒烟通过。等推到 GitHub 后在 Windows 和 Ubuntu 24.04 上跑。NSH 的 Linux 后端默认不带 WebKit；Windows 后端无条件依赖 `webview2-com-sys`，工作流会列出二进制的依赖 |

| Item | Result |
|---|---|
| Canvas terminal (macOS and web) | Pass. The screen moved to `vt100` (`alacritty_terminal` does not build for wasm) in the app's own crate, drawn on NSH's `Canvas`; keys through a hidden `Input` (where input methods compose) and `keymap`. macOS release: 2–4.7 ms of canvas per frame on the main thread, 0.16–0.24 ms of core per commit; 200,000 lines caught up in about 2 s; vim, top, 16/256 colours and wide characters right. Web (headless Chromium): 361 frames in 6 s while flooding, p95 gap 16.8 ms, none dropped. Debug builds are about a thousand times slower; only release numbers count. Redraws coalesce to one per 16 ms. On the web the measured cell width and the browser's glyphs differ slightly. |
| hayro PDF (native and wasm) | Pass, with a follow-up. Native: a 200-page file opens in 28 ms, a page (~1700 px wide) renders in 29–31 ms. Wasm: opens in 18 ms, a page takes 272–317 ms on the page's main thread — a worker or wasm SIMD is due in Phase 1e. A page's PNG is about 1 MB. |
| One TSX, a web package, the dev runtime | Pass. `scripts/web-dev.ts` serves the package and the endpoint same-origin; the page host `app/web/host.js` answers `runtime.endpoint`. The list shows in 163 ms; the 1000-line conversation, the terminal and PDFs work; no console errors. The wasm engine with `app/native` is 12.5 MB, 3.38 MB brotli. |
| Windows and Linux shells in CI | Code and workflow written; the shell's cross-platform parts extracted; smoke passes on macOS. Runs on Windows and Ubuntu 24.04 once pushed. NSH's Linux backend has no WebKit by default; the Windows one depends on `webview2-com-sys`, and the workflow lists the binary's dependencies. |

## 补记 2026-11-06：HTML 预览用 WebView / Addendum 2026-11-06: HTML previews use a WebView

你定了：生成的 HTML 页面（幻灯片、带交互的页面）可以用 WebView 预览。这是应用里唯一的 WebView：产物预览和 HTML 批注里，NSH 的 `WebView` 以 `html` 直接显示页面源码（和信使的 iframe 一样，从运行时取源码，不让页面拿到本机令牌），批注的选取脚本经 `injectedJavaScript` 注入、`window.nsh.postMessage` 回传。`nsh.json` 加了 `capabilities.webview`，不列任何主机，所以 web view 只能显示内联页面、不能跳去别的网站。其余界面照旧全原生。

You decided that a generated HTML page (slides, interactive pages) may be previewed in a WebView. It is the app's only one: the artifact preview and the HTML annotator show the page's source through NSH's `WebView` `html` (fetched from the runtime as the messenger's iframe does, so the page never sees the local token), with the annotation picker injected through `injectedJavaScript` and talking back through `window.nsh.postMessage`. `nsh.json` grants `capabilities.webview` with no hosts, so a web view shows inline pages and cannot navigate to other sites. Everything else stays native.

## 补记 2026-11-06：Phase 1b 界面移植进行中 / Addendum 2026-11-06: Phase 1b, porting the screens

信使的 335 个 Svelte 组件按依赖分成 37 个移植任务，一个任务一个工作树，叶子先做，每批合入前跑类型检查和界面测试（`apps/desktop-nsh/PORTING.md` 是规矩）。已合入：共用件（表单、弹层、头像、模型选择、Markdown 小标签、弹窗框架）、聊天的卡片、顶栏、输入框零件、图片与附件、批注（HTML 用 WebView）、计划、执行轨迹、任务地图、用量、花费第一批、会话设置面板第一批、侧栏导轨和会话行、设置的骨架、通用、提示词与通知、远程与界面、模型来源。随后是聊天记录、完整输入框、计划总面板、工作台、新建对话框、Agent 与流程设置，最后组装外壳（`Shell.svelte`）。

途中补上的 NSH 缺口，各平台共用的在应用里、窗口层的在外壳里：
- 滚轮：NSH 0.4 的视图收不到滚轮，外壳把滚轮、双指滚动和捏合转给应用，`onWheel` 按视图分发（形状照 DOM 的 `WheelEvent`）。
- 桌面通知：Tauri 外壳的投递循环和四个命令搬进 macOS 外壳，路由和 JSON 不变。
- 语音输入：外壳用 AVAudioRecorder 录 AAC，应用在桌面补上 `getUserMedia` 和 `MediaRecorder`，信使的录音逻辑原样跑。
- 系统命令：选文件夹、打开或在访达显示、隐藏窗口在外壳；打开链接、剪贴板、窗口明暗用 NSH 的 `openUrl`、`Clipboard`、`setColorScheme`。
- 引擎：`Intl.RelativeTimeFormat` 补了中英文；`Intl` 格式化器可以不带 `new` 调用；`derived` 改成和 Svelte 一样惰性；运行时在 `globalThis` 上认出桌面外壳。

两项改了做法：Office 预览不用 `office2pdf`（实测带 Typst 后体积多约 45 MB，Word 表格排版重叠），改为 Rust 直接读文件，Excel 用 `calamine` 进 `DataTable`，Word 读成段落、列表、表格交给 `TextView`，PowerPoint 读出形状按比例摆放；终端等 NSH 自带的 `nsh/base` `Terminal`（longbridge/nsh#1111）合入后换上，期间不再扩展画布终端。

The messenger's 335 Svelte components are ported in 37 dependency-ordered jobs, each in a worktree of its own, leaves first, every batch type-checked and screen-tested before it lands (`apps/desktop-nsh/PORTING.md` holds the rules). Landed so far: the shared pieces (forms, overlays, avatars, the model picker, Markdown chips, the modal frame), the chat's cards, header, composer parts, pictures and attachments, annotations (HTML in a WebView), the plan, the trace, the task map, usage, the first half of spend, the first half of the session drawer, the sidebar's rail and rows, and the settings skeleton, general, prompts and notifications, remote and interface, and providers. Next: the transcript, the full composer, the plan panel, the workbench, the create sheets, the agents and playbooks settings, and last the shell (`Shell.svelte`).

NSH gaps filled on the way, cross-platform ones in the app and window-level ones in the shell: wheel events (NSH 0.4's views hear none; the shell forwards the wheel, two-finger scrolling and pinch, and `onWheel` dispatches them, shaped like the DOM's `WheelEvent`); desktop notifications (the Tauri shell's delivery loop and four commands, routes and JSON unchanged); voice input (the shell records AAC with AVAudioRecorder, the app provides `getUserMedia` and `MediaRecorder` over it); system commands (folder picker, open or reveal, hide window in the shell; links, clipboard and window theme through NSH's `openUrl`, `Clipboard`, `setColorScheme`); and the engine (`Intl.RelativeTimeFormat` for Chinese and English, `Intl` formatters callable without `new`, a lazy `derived` as Svelte's, the desktop shell recognised on `globalThis`).

Two approaches changed. Office previews do not use `office2pdf` (Typst added about 45 MB and overlapped Word tables): Rust reads the files directly, Excel through `calamine` into `DataTable`, Word as paragraphs, lists and tables for `TextView`, PowerPoint as shapes placed to scale. The terminal waits for NSH's own `nsh/base` `Terminal` (longbridge/nsh#1111) and the canvas terminal is not extended meanwhile.

**外壳接上（2026-11-06 晚）。** 聊天记录、完整输入框、Bot↔Bot 弹窗、任务看板、侧栏都已合入，`Shell.svelte` 移成 `src/ui/shell/`：状态和返回顺序（`shell-state.ts`）照搬，四个已拆出的助手类（工作台、预览、会话菜单、危险确认）原样复用；版面改成显式的弹性布局（宽窗：侧栏、工作台、预览栏；窄窗：名单铺满、页面盖上去、底栏），窗口的键改成 `keymap` 绑定，靠「新绑定优先」让打开的层先接 Escape。应用入口现在就是外壳，`--pane terminal|pdf` 只给探针用。没跟过来的：`ImageCopy`（NSH 的图片各自带菜单）、页面滑动动画、从侧栏把会话拖进工作台（行只报按下，不报拖动）、界面方案的应用（ADR 0106）。宿主也补齐了剩下的十个 Tauri 命令（登录项、独立运行、本机远程配对、更新），开发版的回答和 Tauri 开发版一致。

**The shell is in (late 2026-11-06).** With the transcript, the full composer, the Bot↔Bot popup, the job board and the sidebar landed, `Shell.svelte` moved to `src/ui/shell/`: its state and ways back (`shell-state.ts`) carried over as they were, its four helper classes (workbench, preview, session menu, danger confirm) reused unchanged; the layout became explicit flex (wide: sidebar, workbench, preview column; narrow: the roster full-window, pages over it, the bottom bar), and the window's keys became `keymap` bindings, the newest binding winning so an open layer takes Escape first. The app's entry is the shell now; `--pane terminal|pdf` remains for the probes. Not carried over: `ImageCopy` (NSH pictures carry their own menu), page slide transitions, dragging a conversation from the sidebar onto the workbench (rows report a press, not a drag), and applying the interface profile (ADR 0106). The host also answers the last ten Tauri commands (login item, independent runtime, pairing on this Mac, updates), a dev build answering as the Tauri dev build does.
