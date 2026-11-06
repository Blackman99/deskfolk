# apps/desktop-nsh：NSH 原生桌面端（试做）

> **试做，只在 `nsh-spike` 分支。** 用 longbridge 的 [Native Shell（NSH）](https://nsh.dev) 0.4.0 把桌面端换成原生界面的第一步：Rust 宿主管窗口，NSH 画界面，NSH 没有的东西写成原生组件，不用 WebView。结论和数字见 [ADR 0107](../../docs/adr/0107-spike-native-desktop-on-nsh.md)。

## 结构

| 位置 | 是什么 |
|---|---|
| `host/` | Rust 宿主（`deskfolk-nsh`）：AppKit 窗口（侧栏毛玻璃、隐藏标题栏）、每个窗口一个 NSH `AppView`、菜单栏、托盘、系统通知、Dock 角标、开发运行时的发现和拉起 |
| `native/terminal/` | 原生组件 `deskfolk.terminal`：`alacritty_terminal` 管屏幕状态，自绘 NSView 画字，`NSTextInputClient` 收键盘和输入法；自己连守护进程的事件流和终端接口，字节不经过 JS |
| `native/pdf/` | 原生组件 `deskfolk.pdf`：PDFKit 的 `PDFView` |
| `app/` | NSH 的 TSX 界面：会话列表、对话（`TextView` 渲染 Markdown）、输入框、终端和 PDF 面板；`@real-bot/protocol` 经 `nsh.json` 的 `resolve.alias` 直接用 |
| `scripts/` | 开发实例（`dev-instance.ts`）、开发运行时（`dev-runtime.ts`）、一条命令起开发版（`dev.ts`）、打包（`package.ts`）、检查脚本 |

## 和稳定版并存

开发版有自己的一整套，装好的稳定版照常跑，互不影响：

| | 稳定版 | 开发版 |
|---|---|---|
| 端口 | 17890 | 17990 |
| 数据目录 | `~/Library/Application Support/real-bot` | `~/Library/Application Support/real-bot-nsh-dev`（工作区在它的 `workspace/`） |
| 钥匙串服务 | `com.real-bot.daemon` | `com.real-bot.daemon.nsh-dev` |
| bundle id | `com.real-bot.desktop` | `com.real-bot.desktop.nsh-dev`（「Deskfolk Dev」） |

开发版不退回去连 17890（`dev-instance.test.ts`、宿主的 `endpoint` 测试）；不装登录项和 launchd，不检查更新，定时任务默认关（`--schedule` 打开）。开发期间不要跑根目录的 `pnpm dev`，它的源码守护进程会和稳定版抢 17890。

## 命令

需要：`nsh` 0.4.0（`curl -fsSL https://nsh.dev/install.sh | NSH_VERSION=v0.4.0 sh`）、Rust、Bun、Xcode 命令行工具；终端还要一份 `real-bot-pty`（`apps/runtime-helper` 的 `swift build`）。

```sh
bun apps/desktop-nsh/scripts/dev.ts            # 起开发运行时（没起的话）、编宿主、编界面，打开「Deskfolk Dev」；改 app/ 自动重载
bun apps/desktop-nsh/scripts/dev.ts --seed-from-stable   # 空数据目录时从稳定版的库拷一份快照（只读拷贝；Bot 仍指向你真实的工作区）
bun apps/desktop-nsh/scripts/package.ts --sign developer-id [--notarize <notarytool profile>] [--measure 3]
```

测试：

```sh
cd apps/desktop-nsh && bun test scripts                 # 开发实例的隔离
cd apps/desktop-nsh && cargo test --workspace           # 宿主、终端（按键、调色板、偏移去重、绘制统计）
cd apps/desktop-nsh/app && nsh check App.tsx && nsh test App.test.tsx   # 类型检查；界面无头测试（网络打桩）
bun apps/desktop-nsh/scripts/e2e-live.ts                # 无头连真实开发运行时：列表、打开、实时事件
bun apps/desktop-nsh/scripts/terminal-probe.ts          # 终端：颜色、宽字符、吞吐、vim、top（要开发版开着终端面板和截图）
```

开发版宿主的检查用参数（`dev.ts` 用环境变量传）：`--background`（不激活、不进台前调度、放到副显示器）、`--snapshots <dir>`（窗口自己渲染成 PNG；往 `<dir>/request` 写空行截图，写 `new-window`、`badge 3`、`notify 文本` 做对应的事）、`--open-session <id>`、`--pane chat|terminal|pdf`、`--pdf <path>`、`--fps`（NSH 帧监视，日志 `nsh::perf`）、`--scroll-probe`（打开的对话自己从新滚到旧再回来）。这些都只给检查用：自动检查不往屏幕注入键鼠事件，也不需要屏幕录制权限。
