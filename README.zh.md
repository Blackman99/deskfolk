<p align="center">
  <a href="https://blackman99.github.io/deskfolk/media/deskfolk-zh.mp4">
    <img alt="观看 Deskfolk 演示（1:49）：从首次配置到一群 Bot 交出一套发布物料，再到它的流程图、你自己的终端和手机" src="docs/assets/promo-zh.jpg">
  </a>
  <br>
  <sub>另有 <a href="https://blackman99.github.io/deskfolk/media/deskfolk-en.mp4">English</a> 版</sub>
</p>

<h1 align="center">Deskfolk</h1>

<p align="center">组一支你信得过的私人 AI 团队。</p>

<p align="center">工作台自由组合：会话、终端、流程图和工作区，想怎么分屏就怎么摆。</p>

<p align="center">
  <a href="https://blackman99.github.io/deskfolk/zh"><b>官网</b></a> ·
  <a href="https://github.com/Blackman99/deskfolk/releases/latest"><b>下载 Alpha</b></a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/Blackman99/deskfolk/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Blackman99/deskfolk/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-146a7c.svg"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-0f172a.svg">
  <a href="https://github.com/Blackman99/deskfolk/releases/latest"><img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-f0ab3d.svg"></a>
</p>

## 为什么信得过

- **都在你的 Mac 上。** 窗口、守护进程、会话和共享工作区都在本机；任意 OpenAI 兼容端点和 MCP 服务器自己接，密钥进钥匙串。
- **危险动作先问你。** 新建端点或 MCP、工作区外读写和出站网络都要你批准；等你的事标在会话列表上，配合 macOS 横幅和 Dock 角标。私聊里进行中的一轮随时能 Stop。
- **做了什么都看得见。** 一个规划一张流程图：你发的每条消息由应用归到规划和任务，目标、验收和你定的规则记成规划要点；经过按谁叫醒了谁画出来，一轮一张卡片，交出的文件、干的任务、用的模型和理由都挂在卡片上。Bot 之间的私聊你也能打开看。
- **交付前先自查。** Bot 交文件给你之前，先拿规划要点（还没整理出要点时用最初的要求）对一遍已交出的文件和收尾；漏掉的要么补上，要么说清交给谁、为什么不交、什么时候做。说「测试通过」「在浏览器里验证过」的，要在它真正跑过的命令里找得到，找不到就退回去跑，或写明没验证。
- **停在半路有人管。** 流程图上的任务跟着实际进展变；一件事静下来却还有任务没做完，应用先叫一次那个任务上的 Bot，还没动静就告诉你。

## 它做什么

- **持久的队友。** Bot 有名字、职责和边界，可以私聊、进群、被 `@` 点名、彼此交接；正在干活的 Bot 被队友 `@` 时不会被打断，下一步就读到这句话。
- **办公文件预览。** 聊天文件、工作区与流程图产物可直接打开 `.docx`、`.xlsx`、`.pptx`，本地只读查看文档、切换工作表与翻阅幻灯片，支持全屏查看，Esc 或手机返回先退出全屏；[格式支持与限制](docs/development.md#办公文件预览)。
- **在交付物上直接批注。** 文字或代码、Markdown 渲染态、图片或 PDF 上的一块、HTML 元素、音视频的一个时间点都能批；攒一批发出去是一条回复，Bot 逐条改完逐条标掉。
- **每轮现挑模型，并说得出理由。** 开轮前由 agent 挑模型和思考等级、留一句理由；只有判成模型不行的复盘才留成这个 Bot 的经验。
- **可分屏的工作台。** 桌面窗口可以分成多块窗格，放会话、终端、日程图、工作区和花费。沿标签栏拖动标签页可调整顺序；右键标签页可关闭它、其他标签页、右侧标签页或所有标签页。空窗格可点右上角 × 关闭，也可在窗格右键菜单选择「关闭窗格」。搜索行最右边的按钮或 ⌘B 可把会话列表收成只有头像的窄栏；它左边的脉搏按钮（手机上在搜索框右边，窄栏里在搜索按钮下面）让列表只显示有 Bot 在工作的会话，等你批准或回答的也算。
- **全局搜索。** 侧栏或头像窄栏点搜索，或按 ⌘K（Ctrl+K），在弹窗里筛选会话、消息、文件和日程，支持键盘选择；手机上铺满全屏。编辑器和终端里用 ⌘⇧K（Ctrl+Shift+K）。窄栏图标在悬停或键盘聚焦时显示名称和说明。
- **你自己的终端。** 守护进程持有 shell，关窗不停；Bot 跑的命令边跑边在它的消息下面滚动，还没开口时「思考中」那一行也写着它正在读哪个文件、跑哪条命令，点开能看这一轮做过的每一步。
- **按模型、会话和 Bot 看花费。** 轮次、决策和反馈调用分别记录，实报与估算分开统计——[花费与计费单价](docs/spend.zh.md)。
- **每日与每周日程。** Bot 按 Mac 的本地时间定点开工——[日程怎么用](docs/routines.zh.md)。
- **手机上接着用（实验性，默认关闭）。** 经你自己部署的中继连回 Mac，端到端加密——[远程访问](docs/remote-access.zh.md)。

## 获取

macOS 13（Ventura）或更新版本，支持 Apple 芯片与 Intel。

- **下载**：[Releases](https://github.com/Blackman99/deskfolk/releases/latest) 提供未签名的 `.dmg`，不用另装别的。首次打开被 Gatekeeper 拦截时，右键选「打开」，或执行 `xattr -dr com.apple.quarantine "/Applications/Deskfolk.app"`（[Gatekeeper FAQ](docs/gatekeeper.zh.md)）。
- **更新**：有新版本时，桌面侧栏底部带文字的「设置」上出现小红点，在 设置 → 关于 里下载并安装。外观在 设置 → 基础偏好 → 外观。
- **从源码启动**（Node 22+、pnpm 12.3.4、Bun 1.2+、Rust、Xcode Command Line Tools）：

```bash
git clone https://github.com/Blackman99/deskfolk.git
cd deskfolk
pnpm install
pnpm dev
```

首次使用：选一个工作区目录，在设置里填端点和密钥，建第一个 Bot，再让它把其他队友建出来。

## 状态

Alpha，仅 macOS，功能和数据格式仍会变化。远程访问是默认关闭的原型：日常功能和 Web Push 已在 Android Chrome 真机上走通；iOS 主屏幕和 WebAuthn 用户验证还没做真机验收，独立安全复核也没有通过；发布包暂时不能配对，只能从源码启动。

[哪些已接入、哪些不做](https://blackman99.github.io/deskfolk/zh#boundaries) · [路线图](ROADMAP.md) · [领域语言](CONTEXT.md) · [中继部署](docs/deploy-remote.md)

## 参与

[开发说明](docs/development.md) · [参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md)。MIT 协议开源，与 xAI / Grok 无官方附属关系。
