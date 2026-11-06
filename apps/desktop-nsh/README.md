# apps/desktop-nsh：NSH 原生客户端（试做）

> **试做，只在 `nsh-spike` 分支。** 用 longbridge 的 [Native Shell（NSH）](https://nsh.dev) 0.4.0 重写客户端：一份 TSX 界面，跑在 macOS、Windows、Linux 的原生窗口里，也编成 web 包给手机和平板；NSH 没有的东西在它上面补，不用 WebView。结论和数字见 [ADR 0107](../../docs/adr/0107-spike-native-desktop-on-nsh.md)。

## 结构

| 位置 | 是什么 |
|---|---|
| `app/` | NSH 的 TSX 界面：会话列表、对话（`TextView` 渲染 Markdown）、输入框、终端和 PDF 面板。`@real-bot/protocol` 经 `nsh.json` 的 `resolve.alias` 直接用 |
| `app/native/` | 应用自己的 Rust crate（`nsh.json` `"rust"`，TSX 里 `import … from "deskfolk/native"`），桌面三家和 web 的 wasm 都编进去：终端（`vt100` 管屏幕，`Canvas` 画）和 PDF（`hayro` 渲染页面） |
| `app/web/host.js` | web 上页面一侧的宿主（`nsh.json` `web.host`）：回答 `runtime.endpoint`。手机的版本以后经中继的加密通道回答 |
| `host/` | 每个桌面自己的外壳（`deskfolk-nsh`）：macOS（AppKit 窗口、侧栏毛玻璃、菜单栏、托盘、通知、Dock 角标）、Windows（Win32 窗口 + 子窗口 `AppView`，骨架）、Linux（GTK 4，骨架）；读开发运行时的地址，不连 17890 |
| `native/terminal/`、`native/pdf/` | macOS 专用的原生组件（NSView 终端、PDFKit），Phase 0 留下的，作对照和以后加密 PDF 的兜底 |
| `scripts/` | 开发实例（`dev-instance.ts`）、开发运行时（`dev-runtime.ts`）、桌面开发版（`dev.ts`）、web 开发版（`web-dev.ts`）、打包（`package.ts`）、检查脚本（`ci-smoke.ts`、`e2e-live.ts`、`terminal-probe.ts`） |

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
bun apps/desktop-nsh/scripts/dev.ts --seed-from-stable   # 空数据目录时从稳定版的库拷一份快照（只读拷贝；Bot 仍指向你真实的工作区）
bun apps/desktop-nsh/scripts/web-dev.ts        # 编 web 包（app/native 编成 wasm）并在 http://127.0.0.1:17991/ 提供，连开发运行时
bun apps/desktop-nsh/scripts/package.ts --sign developer-id [--notarize <notarytool profile>] [--measure 3]
```

测试：

```sh
cd apps/desktop-nsh && bun test scripts                 # 开发实例的隔离
cd apps/desktop-nsh && cargo test --workspace           # 宿主、app/native（终端去重、调色板）、原生组件
cd apps/desktop-nsh/app && nsh check App.tsx && nsh test # 类型检查；无头界面测试（网络打桩）和 app/native 的测试
bun apps/desktop-nsh/scripts/ci-smoke.ts <宿主可执行文件> apps/desktop-nsh/build/app/bundle.js   # 宿主打开、界面跑起来、拿到开发运行时的第一份快照
bun apps/desktop-nsh/scripts/e2e-live.ts                # 无头连真实开发运行时：列表、打开、实时事件
bun apps/desktop-nsh/scripts/terminal-probe.ts          # 终端：颜色、宽字符、吞吐、vim、top（要开发版开着终端面板和截图）
```

Windows 和 Linux 不能在 Mac 上交叉编译，在 GitHub Actions 的 `.github/workflows/nsh-desktop.yml` 上构建、测试和冒烟（Linux 在 Xvfb 下）。

开发版宿主的检查用参数（`dev.ts` 用环境变量传，macOS）：`--background`（不激活、不进台前调度、放到副显示器）、`--snapshots <dir>`（窗口自己渲染成 PNG；往 `<dir>/request` 写空行截图，写 `new-window`、`badge 3`、`notify 文本` 做对应的事）、`--open-session <id>`、`--pane chat|terminal|pdf`、`--pdf <path>`、`--fps`（NSH 帧监视，日志 `nsh::perf`）、`--scroll-probe`、`--terminal native`（换回 NSView 终端作对照）。自动检查不往屏幕注入键鼠事件，也不需要屏幕录制权限。
