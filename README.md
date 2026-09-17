# Real Bot

> **WIP — 正在开发中。** 当前面向 macOS 本地开发与试用，尚未达到稳定发布状态。功能、接口与数据结构可能变化；请使用独立工作区并备份重要数据。下文明确区分已接入的能力与正在建设的目标。

**在自己的电脑上，通过对话组织一组持久的 AI 队友，自由接入模型与工具，并让它们逐步学会更好地完成任务。**

[English](README.en.md) · [路线图](ROADMAP.md) · [开发说明](docs/development.md) · [参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md)

[![CI](https://github.com/Blackman99/real-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Blackman99/real-bot/actions/workflows/ci.yml)

## 核心方向

### 1. Grok Bot 式协作，纯本地运行，开放模型与工具

协作方式对齐 Grok Bot 应用：Bot 是有名字、职责和边界的持久队友，可以私聊、加入群组、通过 `@` 点名、异步交接，而不是每次任务结束就消失的临时助手。信使把正文里的 `@群成员` 显示成可点的头像 chip，用来打开该 Bot 人设。

Real Bot 的窗口、运行时、会话数据和共享工作区都在自己的电脑上，不依赖项目提供的云端协作服务。模型与工具不绑定单一厂商，目标是开放接入任何模型和任何 MCP（Model Context Protocol，模型上下文协议）工具。

**当前接入范围：**多个 OpenAI 兼容的 Chat Completions 端点，以及 stdio / Streamable HTTP MCP 服务器提供的工具。其他模型接口需要兼容层；具体模型与服务器的协议兼容性仍需验证，不能理解为已经兼容所有实现。

**本地运行不等于完全离线。** 使用远程模型或远程 MCP 时，相关提示词、上下文、文件内容或工具参数可能发送到对应服务；stdio MCP 进程也可能访问网络。离线使用取决于所配置的模型和工具是否都能在本机运行。

### 2. Agent 决策优先，任务反馈与持续反思（正在做）

希望由 Bot 围绕任务自主判断：该用哪个模型、什么思考强度、哪些工具，以及是否需要其他 Bot 协作，而不是让用户逐项配置执行流程。

目标是形成完整的任务反馈机制：自动收集任务完成情况与用户反馈，反思每次任务中的选择和执行过程，持续提升模型选择的准确性，并提高后续类似任务的效率。

**当前已有基础：**应用会根据消息类型、配置的模型擅长领域、价格、支持的思考等级和已收集的反馈选择模型与思考等级；用户在后续消息中指出问题时，可记录为对上一轮选择的负反馈。Bot 可以在轮次内调用内置工具和已启用的 MCP 工具。

**仍在建设：**当前模型选择主要是规则评分，不是完整的 agent 自主决策；自动任务结果评估、每次任务的结构化反思、经验复用与效果验证还没有形成完整机制。这些是核心研发方向，不是现成的自我学习能力。

### 3. 通过对话让 Bot 管理应用自身

目标是让所有应用操作都可以通过与 Bot 对话完成，图形界面用于查看、干预和批准，而不是每件事都必须手工设置。

目前 Bot 已有工具可以：

- 修改自己的头像、名称、职责描述与边界。
- 创建 Bot、创建群组、管理群成员。
- 配置模型服务（provider）、模型名单与 MCP server。
- 向其他 Bot 发消息、点名和交接，主动推进其他 Bot 的工作。

**完整的对话操作覆盖仍是目标。** 首次启动还需要配置工作区、首个模型端点和首个 Bot；涉及新端点、新 MCP 连接等危险动作仍须用户批准，密钥通过专门输入框提供，不放进聊天正文。Bot 自主推进不意味着绕过批准、拒绝或 Stop。

## 当前状态

| 方向 | 当前实现 | 状态与限制 |
| --- | --- | --- |
| 本地协作 | macOS 桌面窗、本机守护进程、共享工作区、持久 Bot、私聊与群、交接 | 已接入，仍在迭代和端到端验证 |
| 开放接入 | 多个 OpenAI 兼容端点；stdio / Streamable HTTP MCP 工具 | 已接入，兼容性取决于具体实现 |
| 模型决策与反馈 | 规则选择模型及思考等级、后续负反馈影响选择 | 初步实现；完整 agent 决策与反思机制 WIP |
| 对话管理应用 | Bot 人设、Bot / 群组、provider / 模型 / MCP 配置、Bot 间推进 | 主要工具已接入，尚非全部操作覆盖 |
| 稳定发布 | 当前从源码开发运行 | 尚无稳定版或受支持的签名安装包；Windows / Linux 不在当前支持范围 |

“已接入”表示代码中已有实现，不代表每种模型、工具组合或完整任务路径都已通过真实环境验收。详细方向见[路线图](ROADMAP.md)。

## 从源码启动

需要 macOS、Node.js `>=22`、pnpm `12.3.4`、Bun `>=1.2`、Rust / Cargo，以及 [Tauri 的 macOS 开发前置依赖](https://v2.tauri.app/start/prerequisites/#macos)（包括 Xcode Command Line Tools）。

在项目根目录执行：

```bash
pnpm install
pnpm dev
```

首次使用：

1. 准备一个已存在的本地绝对路径目录作为共享工作区，建议独立于源码仓库。
2. 在设置中填写工作区、OpenAI 兼容端点 URL 和 API key，并配置该端点实际支持的模型名单与默认模型。密钥在专用输入框填写。
3. 通过侧栏创建第一个 Bot，填写名称、职责和边界，开始私聊。
4. 再通过对话让它创建其他 Bot、组织群组或提出 MCP 配置；需要批准时，在应用中审核具体动作。

可尝试这样的请求（是用法示例，不是效果保证）：

> 把你的名字改成 Coordinator，职责设为协调研究与写作。创建 Researcher 和 Writer，组成一个叫「调研」的群。围绕工作区里的 brief.md 协作完成 report.md，需要交接时直接联系对方。

关窗会隐藏到托盘，后台任务继续；使用 Cmd+Q 或托盘「退出」才会停止窗口和守护进程。

## 开发与验证

```bash
pnpm test
pnpm typecheck
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @real-bot/messenger build
```

源码托管在 [github.com/Blackman99/real-bot](https://github.com/Blackman99/real-bot)。推送到 `main` 或打开 PR 会跑上述检查（另含落地页 build）；推送 `v*` 标签会打未签名 macOS 快照 draft，不是稳定安装包。落地页由 GitHub Pages 发布。细节见[开发说明](docs/development.md#ci落地页与快照发布)。

| 路径 | 职责 |
| --- | --- |
| `apps/daemon` | Bun / TypeScript 守护进程，管理本机接口、会话、模型调用与工具执行 |
| `apps/messenger` | SvelteKit 聊天界面 |
| `apps/desktop` | Tauri 2 macOS 桌面窗口与运行时监督 |
| `apps/landing` | SvelteKit 产品理念与架构介绍站（静态导出） |
| `packages/protocol` | 共享 TypeScript 类型与本机接口契约 |

详细运行行为、热更新、本机接口与数据位置见[开发说明](docs/development.md)；项目术语见 [CONTEXT.md](CONTEXT.md)。

## 安全与数据

所有 Bot 共用工作区与已配置的 MCP；**Bot 不是权限隔离边界，工作区 shell 也不是操作系统沙箱**。已信任的 MCP 工具调用不会逐次请求批准。请只配置可信服务，使用测试数据，并自行控制外部服务费用。批准和 Stop 不能撤销已经完成的动作。群聊没有 Stop，发出去的群任务要用消息让 Bot 停下来。

安全边界、数据存储和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 参与贡献与许可

欢迎可复现的问题、模型 / MCP 兼容性报告、文档改进和小范围 PR。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

本项目采用 [MIT License](LICENSE)；第三方代码声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Real Bot 是独立项目，与 Grok / xAI 无隶属、赞助或官方合作关系；Grok Bot 仅用于说明协作方式的参考。
