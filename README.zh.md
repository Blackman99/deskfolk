<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-hero-dark.png">
    <img alt="Deskfolk：群聊与它的流程图、一张待批准卡和 Markdown 预览" src="docs/assets/readme-hero-light.png">
  </picture>
</p>

<h1 align="center">Deskfolk</h1>

<p align="center">在自己的电脑上，用对话组一支持久的 AI 队友。</p>

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

## 它做什么

- **持久的队友。** Bot 有名字、职责和边界，可以私聊、进群、被 `@` 点名、彼此交接。
- **一切都在你的 Mac 上。** 窗口、守护进程、会话和共享工作区都在本机；任意 OpenAI 兼容端点和 MCP 服务器自己接。
- **一件事一张流程图。** 按谁叫醒了谁画出来，一轮一张卡片，交出的文件挂在卡片上。
- **每轮现挑模型，并说得出理由。** 开轮前由 agent 挑模型和思考等级、留一句理由；只有判成模型不行的复盘才留成这个 Bot 的经验。
- **可分屏的工作台。** 桌面窗口可以分成多块窗格，放会话、终端、日程图、工作区和花费。空窗格可点右上角 × 关闭，也可在窗格右键菜单选择「关闭窗格」。搜索框右边的按钮或 ⌘B 可把会话列表收成只有头像的窄栏。
- **你自己的终端。** 守护进程持有 shell，关窗不停；Bot 跑的命令边跑边在它的消息下面滚动。
- **按模型、会话和 Bot 看花费。** 轮次、决策和反馈调用分别记录，实报与估算分开统计——[花费与计费单价](docs/spend.zh.md)。
- **每日与每周日程。** Bot 按 Mac 的本地时间定点开工——[日程怎么用](docs/routines.zh.md)。
- **你说了算。** 新建端点或 MCP、工作区外读写和出站网络都要你批准，密钥进钥匙串；等你的事标在会话列表上，配合 macOS 横幅和 Dock 角标。
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

Alpha，仅 macOS，功能和数据格式仍会变化。远程访问是默认关闭的原型，独立安全复核和真机验收都还没有通过。

[哪些已接入、哪些不做](https://blackman99.github.io/deskfolk/zh#boundaries) · [路线图](ROADMAP.md) · [领域语言](CONTEXT.md) · [中继部署](docs/deploy-remote.md)

## 参与

[开发说明](docs/development.md) · [参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md)。MIT 协议开源，与 xAI / Grok 无官方附属关系。
