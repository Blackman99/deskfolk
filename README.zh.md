<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-hero-dark.png">
    <img alt="Real Bot：三个 Bot 的群聊、一张待批准卡和 Markdown 预览" src="docs/assets/readme-hero-light.png">
  </picture>
</p>

<h1 align="center">Real Bot</h1>

<p align="center">在自己的电脑上，用对话组一支持久的 AI 队友。</p>

<p align="center">
  <a href="https://blackman99.github.io/real-bot/zh"><b>官网</b></a> ·
  <a href="https://github.com/Blackman99/real-bot/releases/latest"><b>下载 Alpha</b></a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/Blackman99/real-bot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Blackman99/real-bot/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-146a7c.svg"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-0f172a.svg">
  <a href="https://github.com/Blackman99/real-bot/releases/latest"><img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-f0ab3d.svg"></a>
</p>

## 它做什么

- **是队友，不是用完即弃的对话。** Bot 有名字、职责和边界，可以私聊、进群、被 `@` 点名、彼此交接。一个 Bot 去问另一个 Bot 时单开一条对话，入口挂在引出它的那条消息下面，你只能看不能插话。
- **一切都在你的 Mac 上。** 窗口、守护进程、会话和一个共享工作区目录都在本机，没有项目方的云端。
- **模型和工具自己接。** 任意 OpenAI 兼容端点；stdio 或 Streamable HTTP 的 MCP 服务器，所有 Bot 共用。
- **模型每轮现挑，并且说得出理由。** 每开一轮先由 agent 给这个 Bot 挑模型和思考等级，并留下一句理由。一条纠正告一段落时复盘一次，判出到底是模型不行、事情本身难，还是需求没说清；只有判成模型不行才留成这个 Bot 的经验。每轮选了什么、怎么结束、收到哪些反馈，都能在会话里逐轮回看，信使里的记录可以筛选。
- **危险动作等你放行。** 新建端点或 MCP、工作区外读写、出站网络都停在批准卡上；密钥进钥匙串，不进聊天。
- **Bot 管理应用本身。** 建 Bot、组群、配端点和 MCP，跟它说一句就行。

## 获取

**系统要求：macOS 13.0（Ventura）或更新版本**，支持 Apple 芯片与 Intel。当前构建内置 daemon 与原生 helper，发布包不需要另装 Bun 运行时。

**下载**最新 Alpha：[GitHub Releases](https://github.com/Blackman99/real-bot/releases/latest) 提供 Apple 芯片与 Intel 两种未签名 `.dmg`。首次打开若被 Gatekeeper 拦截，右键选「打开」，或执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Real Bot.app"
```

更多说明：[Gatekeeper FAQ](docs/gatekeeper.zh.md) · 公证路径：[docs/notarization.md](docs/notarization.md)（[#10](https://github.com/Blackman99/real-bot/issues/10)）。

**更新：**应用会在后台检查 GitHub Releases，有新构建时设置齿轮上会出现小红点。设置 → 通用 → 关于 显示当前版本，并在浏览器中打开对应芯片的 `.dmg`；构建未签名期间没有应用内安装器。

**从源码启动**（macOS 13.0+、Node 22+、pnpm 12.3.4、Bun 1.2+、Rust、Xcode Command Line Tools）：

```bash
pnpm install
pnpm dev
```

首次使用：选一个工作区目录（不存在会自动创建），在设置里填 OpenAI 兼容端点和密钥，从侧栏建第一个 Bot，再让它把其他队友建出来。

## 状态

Alpha，仅 macOS。已接入、正在建设与明确不做：[官网](https://blackman99.github.io/real-bot/zh#boundaries) · [路线图](ROADMAP.md) · [CONTEXT.md](CONTEXT.md)（领域语言）。

共享远控密码包是**实验性、默认关闭的原型**，不代表远控已可用。新增默认关闭的 Bun 中继与非 root Compose/Caddy 静态部署模板，供隔离集成测试；daemon 适配器和远控/PWA 客户端尚未完成。见[自托管部署、bootstrap 恢复与路由契约](docs/deploy-remote.md)，含独立 `test:edge` 命令验证本机真实 Caddy HTTP/HTTPS/WSS（需要 Caddy 2.10.2 与 OpenSSL）。测试含官方 Noise 向量和独立 Rust snow 对端（`pnpm test` 需 Cargo）；真机 PWA/WebAuthn 与独立安全审查门仍待验证。见[协议/API 契约](docs/remote-protocol.md)，其中包含条件头与同名附件排序的唯一共享回执摘要，本机 daemon 回执现也通过仅含规范编码的 workspace 导出使用它。daemon 仍保留更严格的路由及强 SHA-256 If-Match 校验。

## 参与

[开发说明](docs/development.md) · [参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md)。MIT 协议开源，与 xAI / Grok 无官方附属关系。
