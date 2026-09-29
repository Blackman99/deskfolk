<p align="center">
  <a href="https://blackman99.github.io/deskfolk/media/deskfolk-zh.mp4">
    <img alt="观看 Deskfolk 演示（1:49）：从首次配置到一群 Bot 交出一套发布物料，再到它的流程图、你自己的终端和手机" src="docs/assets/promo-zh.jpg">
  </a>
  <br>
  <sub>另有 <a href="https://blackman99.github.io/deskfolk/media/deskfolk-en.mp4">English</a> 版</sub>
</p>

<h1 align="center">Deskfolk</h1>

<p align="center">交给一组 Bot，盯到交付。</p>

<p align="center">几个 Bot 分工交接，应用盯着验收：停在半路会追，没验证过会直说，每一步都查得到。</p>

<p align="center">
  <a href="https://blackman99.github.io/deskfolk/zh"><b>官网</b></a> ·
  <a href="https://github.com/Blackman99/deskfolk/releases/latest"><b>下载 Alpha</b></a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/Blackman99/deskfolk/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Blackman99/deskfolk/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-146a7c.svg"></a>
  <img alt="Platform: macOS, Windows (preview)" src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20(preview)-0f172a.svg">
  <a href="https://github.com/Blackman99/deskfolk/releases/latest"><img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-f0ab3d.svg"></a>
</p>

## 为什么放心交给它

- **交付前先自查。** Bot 交文件给你之前，应用先看三件确定的事：这件事的验收检查过没过（见下一条），说了「随后给」有没有约回看或点名交给谁，说了「测试通过」「验证过」这一轮有没有真跑过命令；有一件不满足就退回去，补上、说明去向，或写明没验证。
- **验收可以交给应用自己跑。** 验收里能机器判定的那几条（文件在不在、写没写到、正则对不对、一条命令跑不跑得通）可以挂一条检查，由守护进程在本机自己跑，结果标在流程图上。有检查没过，整理跳就不会把这件事标成做完，停下来时应用会带着没过的检查叫回一次。检查由你加，整理跳也能把这件事里真跑成功过的命令变成检查；Bot 自己写不了。
- **停在半路有人管。** 流程图上的任务跟着实际进展变；一件事静下来却还有任务没做完，应用先叫一次那个任务上的 Bot，还没动静就告诉你。
- **做了什么都看得见。** 一个规划一张流程图：你发的每条消息由应用归到规划和任务，目标、验收和你定的规则记成规划要点；经过按谁叫醒了谁画出来，一轮一张卡片，交出的文件、干的任务、用的模型和理由都挂在卡片上。Bot 之间的私聊你也能打开看。
- **危险动作先问你。** 新建端点或 MCP、工作区外读写和出站网络都要你批准；等你的事标在会话列表上，配合 macOS 横幅和 Dock 角标。私聊里进行中的一轮随时能 Stop。
- **执行和文件在你的 Mac 上。** 窗口、守护进程、会话和共享工作区都在本机，密钥进钥匙串。模型和 MCP 服务器由你接：任意 OpenAI 兼容端点都行，每一轮的上下文发给你配置的那个端点。

## 适合谁

- **适合**：会自己配模型端点和 API key 的独立开发者、技术型个人和小工作室，手上有一件要几个角色分工、分几步交出文件的活，比如一份调研报告、一套发布物料、一个带测试和启动说明的小工具。
- **暂不适合**：几个人共用一套、要 Linux、要 Mac 睡眠时也接着干活，或者不想自己接模型端点。Windows 有一条刚起步的实验性预览：从源码构建，或用 CI 打出的未签名安装包——见下方「获取」。

## 实测

2026-09-29 在当前代码上用黄金路径基准跑的结果。三件固定的事：一份调研报告、一套上线文案加单文件落地页、一个带测试的命令行小工具。每件事无人值守跑到静下来，批准一律拒绝；按任务集里固定的验收，让评判模型（claude-sonnet-4-6）逐条判，外加交付文件、内容和命令的确定性检查，覆盖率到 80% 且检查全过才算做完。

| 模型 | 组队 | 做完 | 每次花费 | 每次批准卡 |
|---|---|---|---|---|
| gemini-3.8-flash-high | 三个角色 Bot 开群 | 9/9 | $0.55 | 0.3 |
| gemini-3.8-flash-high | 一个 Bot 单干 | 9/9 | $0.37 | 0.4 |
| grk-4.7-build-fast | 三个角色 Bot 开群 | 6/6 | $2.31 | 2.8 |
| grk-4.7-build-fast | 一个 Bot 单干 | 4/6 | $0.74 | 0.8 |

grk 单干没做完的两次：一次为了在浏览器里核对落地页而超时（Bot 没有浏览器工具），一次是评判的答案没能解析，而交付检查其实全过了。

读法：
- 这三类活一个 Bot 就能做完，三人团队没有更常做完，花费却是它的 1.5–3 倍。
- 2026-09-28 的基线（45 次）里，gemini 的团队只做完 7/9，原因是模型有时回一条空回复，这一轮就悄悄结束了；这个问题已经修掉。
- 关掉轮次里的旁路调用（整理跳、收尾自检、选路、复盘、参与判断、叫回），78 次消融里没有一种让做完的次数变少，全关反而最快、最便宜，见 [ADR 0037](docs/adr/0037-cut-the-core-loop-by-the-benchmark.md)。
- 样本很小，每格 6–9 次，只能看出大的差别，而且只说明这三类小活；会在半路停下的长活、大群、多模型挑选，这个基准还没覆盖。

跑法和怎么读结果见[开发说明·黄金路径基准](docs/development.md#黄金路径基准)。

## 它做什么

- **持久的队友。** Bot 有名字、职责和边界，可以私聊、进群、被 `@` 点名、彼此交接；正在干活的 Bot 被队友 `@` 时不会被打断，下一步就读到这句话。
- **办公文件预览。** 聊天文件、工作区与流程图产物可直接打开 `.docx`、`.xlsx`、`.pptx`，本地只读查看文档、切换工作表与翻阅幻灯片，支持全屏查看，Esc 或手机返回先退出全屏；[格式支持与限制](docs/development.md#办公文件预览)。
- **在交付物上直接批注。** 文字或代码、Markdown 渲染态、图片或 PDF 上的一块、HTML 元素、音视频的一个时间点都能批；攒一批发出去是一条回复，Bot 逐条改完逐条标掉。
- **每轮现挑模型，并说得出理由。** 开轮前由 agent 挑模型和思考等级、留一句理由；只有判成模型不行的复盘才留成这个 Bot 的经验。
- **可分屏的工作台。** 桌面窗口可以分成多块窗格，放会话、终端、日程图、工作区和花费。沿标签栏拖动标签页可调整顺序；右键标签页可关闭它、其他标签页、右侧标签页或所有标签页。空窗格可点右上角 × 关闭，也可在窗格右键菜单选择「关闭窗格」。工作区文件树里 ⌘ 点击或 Shift 点击可多选文件和文件夹，右键即可移到 Mac 的废纸篓，在 Finder 里还能放回。搜索行最右边的按钮或 ⌘B 可把会话列表收成只有头像的窄栏；它左边的脉搏按钮（手机上在搜索框右边，窄栏里在搜索按钮下面）让列表只显示有 Bot 在工作的会话，等你批准或回答的也算。
- **全局搜索。** 侧栏或头像窄栏点搜索，或按 ⌘K（Ctrl+K），在弹窗里筛选会话、消息、文件和日程，支持键盘选择；手机上铺满全屏。编辑器和终端里用 ⌘⇧K（Ctrl+Shift+K）。窄栏图标在悬停或键盘聚焦时显示名称和说明。
- **你自己的终端。** 守护进程持有 shell，关窗不停；Bot 跑的命令边跑边在它的消息下面滚动，还没开口时「思考中」那一行也写着它正在读哪个文件、跑哪条命令，点开能看这一轮做过的每一步。
- **按模型、会话和 Bot 看花费。** 轮次、决策和反馈调用分别记录，实报与估算分开统计——[花费与计费单价](docs/spend.zh.md)。
- **每日与每周日程。** Bot 按 Mac 的本地时间定点开工——[日程怎么用](docs/routines.zh.md)。
- **手机上接着用（实验性，默认关闭）。** 经你自己部署的中继连回 Mac，端到端加密——[远程访问](docs/remote-access.zh.md)。

## 获取

macOS 13（Ventura）或更新版本，支持 Apple 芯片与 Intel。Windows 有一条刚起步的实验性预览（从源码构建，或用 CI 打出的安装包，见下文）；Linux 暂不支持。

- **下载**：[Releases](https://github.com/Blackman99/deskfolk/releases/latest) 提供未签名的 `.dmg`，不用另装别的。首次打开被 Gatekeeper 拦截时，右键选「打开」，或执行 `xattr -dr com.apple.quarantine "/Applications/Deskfolk.app"`（[Gatekeeper FAQ](docs/gatekeeper.zh.md)）。
- **更新**：有新版本时，桌面侧栏底部带文字的「设置」上出现小红点，在 设置 → 关于 里下载并安装。外观在 设置 → 基础偏好 → 外观。
- **从源码启动**（Node 22+、pnpm 12.3.4、Bun 1.2+、Rust、Xcode Command Line Tools）：

```bash
git clone https://github.com/Blackman99/deskfolk.git
cd deskfolk
pnpm install
pnpm dev
```

- **Windows（实验性预览）：** 同样 `git clone` / `pnpm install` / `pnpm dev`，用 Rust 的 MSVC 工具链加 Visual Studio Build Tools（勾选 "Desktop development with C++"）代替 Xcode，另外先跑一次 `cargo build --manifest-path apps/conpty-helper/Cargo.toml` 编终端 helper。本地打安装包用 `pnpm --filter @real-bot/desktop tauri build --bundles nsis`；[`windows.yml`](.github/workflows/windows.yml) 这条 GitHub Actions 工作流也会把一份未签名的 NSIS 安装包传成 artifact（没签名，SmartScreen 会提示未知发布者）。远控/手机配对、独立运行时、应用内下载安装更新、桌面通知和图片缩略图这些还没有——完整清单和前置条件见[开发说明](docs/development.md)。

拿源码版干要跑几个小时的活（比如多镜头视频）时，用 `pnpm dev:steady` 代替 `pnpm dev`：守护进程不会因为改代码或 `git pull` 重启，进行中的轮次不会被打断。

首次使用：启动向导会带你选一个工作区目录、填端点和密钥、建第一个 Bot；之后再让它把其他队友建出来。

## 状态

Alpha，macOS 是主要目标，功能和数据格式在那边也仍会变化。Windows 是刚起步的实验性预览，还有不少毛边和缺失功能（见上文「获取」）。Linux 暂不支持。远程访问是默认关闭的原型：日常功能和 Web Push 已在 Android Chrome 真机上走通；iOS 主屏幕和 WebAuthn 用户验证还没做真机验收，独立安全复核也没有通过；安装的应用就能配对：Mac 的远控身份存在一个私有文件里而不是钥匙串，每台设备用触控 ID 批准（[ADR 0033](docs/adr/0033-remote-credentials-in-a-file.md)）。

[哪些已接入、哪些不做](https://blackman99.github.io/deskfolk/zh#boundaries) · [路线图](ROADMAP.md) · [领域语言](CONTEXT.md) · [中继部署](docs/deploy-remote.md)

## 参与

[开发说明](docs/development.md) · [参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md)。MIT 协议开源，与 xAI / Grok 无官方附属关系。
