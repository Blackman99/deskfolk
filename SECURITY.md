# Security policy / 安全说明

## 状态与支持范围

Real Bot 当前是 **WIP**，只面向 macOS 本地开发与试用，没有稳定版本的安全维护承诺、独立安全审计声明或响应时限保证。安全修复优先面向最新开发代码。请使用可丢弃数据和可信模型 / 工具，不要把它当作隔离不可信代码的执行环境。

## 实验性远控密码原型 / Experimental remote cryptography

`packages/remote` 提供真实 Noise IK、配对 AEAD、签名授权与 COSE/WebAuthn 验证的纯接口，但**不启用远控**。远控运输、公网配对仍默认关闭；协议契约、host 必须承担的原子重放/挑战消费、首次 UV 登记与替换权限见 [docs/remote-protocol.md](docs/remote-protocol.md)。官方协议向量和独立 Rust snow 对打不是独立安全审计；桌面浏览器软件密钥测试不是真机 PWA/WebAuthn UV。L1 真机、S-rev 独立审查及 G-uv 门尚未通过，不能据此开公网或启用高危动作。

The shared remote cryptography is a **default-off security prototype**, not a released remote-access feature. Noble primitives have audit history; the exact pinned versions and our Noise/pairing/WebAuthn integration are not independently audited. Physical-device PWA/WebAuthn and external-review gates remain unverified. The host must atomically own trust checks, replay claims, challenge consumption and credential replacement; a stolen device key must not create or replace an existing UV credential. None attestation does not prove authenticator hardware provenance. The trusted web origin can replace client code; E2EE does not solve origin compromise or XSS. Never place pairing secrets, keys or application plaintext in URLs, queries, logs or service-worker caches.

## 私密报告漏洞

仓库托管在 GitHub 且启用私密漏洞报告后，请从 **Security → Report a vulnerability** 提交。维护者应在首次公开前启用该功能；文档本身不会开启 GitHub 设置。

若看不到该入口，可发一个仅包含「请求私密安全联系渠道」的普通 Issue，等待维护者提供私密方式。不要在公开 Issue / PR 中发布漏洞细节、可利用代码、凭据、数据库或真实用户数据。本项目目前没有另行指定的安全邮箱，也不提供奖励或固定处理时限承诺。

私密报告请包含：

- 受影响的源码版本、macOS 与工具链版本。
- 影响范围、最小复现步骤和预期安全边界。
- 已脱敏的证据、可行的缓解办法（若有）。

如已经泄露凭据，请先撤销或轮换相应凭据；仅删掉帖子或文件不能撤回泄露。

## 本地运行与数据流

- 桌面窗口、本机守护进程、会话数据库与共享工作区在本机运行和存储，不依赖项目提供的云端协作服务。
- 调用远程模型时，上下文、消息和相关附件内容会按请求发送给该端点；MCP 工具收到调用参数，也可能读取或向外发送数据。stdio 进程不等于离线进程。
- 使用者需要审查模型提供商、MCP 服务及其数据保留政策。只有所有模型与工具均能本地运行时，才可能离线使用。

## 信任与执行边界

- **Bot 之间不隔离。** 所有 Bot 共用工作区和已启用的 MCP 工具；Bot 人设不是权限边界。
- **工作区 shell 不是操作系统沙箱。** 路径检查和批准是应用层约束，不能保证任意子进程无法访问区外资源。
- 工作区内文件操作可直接执行；区外文件访问、无约束 shell、新端点 / 端点 URL 变更、新 MCP / 连接变更等动作按应用规则请求批准。
- **信任 MCP 是安装 / 配置时的决定。** 已配置、启用且连接成功的工具对所有 Bot 可用，调用不再逐次批准。只安装可信程序和服务，使用最小权限的凭据。
- 模型输出、工具结果和外部内容可能包含错误或提示注入；检查结果和危险动作仍然重要。
- **HTML 预览会跑脚本。** 工作区单文件 HTML 在侧栏 iframe 里以 `allow-scripts`、无 `allow-same-origin` 执行，便于设计稿动效；脚本不能读信使页面或本机 token，外链仍受窗口 CSP 限制。不要把不可信 HTML 当隔离执行环境。
- 拒绝和 Stop 应被尊重，但不能撤销已经发生的文件修改、外部请求或费用。本项目没有自动预算熔断保证。

## 数据与凭据位置

| 内容 | 当前存储方式 |
| --- | --- |
| 会话与应用状态 | `~/Library/Application Support/real-bot/state.sqlite` |
| 本机接口描述与 token | 同目录的 `local-api.json`；每次守护进程启动生成新 token，目录权限 `0700`、文件 `0600` |
| 模型 API key 与 HTTP MCP Authorization | macOS 钥匙串，由守护进程管理，不通过聊天正文配置 |
| 附件与产物 | 用户选择的共享工作区；上传附件位于 `inbox/` |
| 超长工具结果 | 工作区 `tool-results/` 中的完整 JSON；可能含敏感信息，使用后按需清理 |

SQLite、附件与工具结果没有应用层加密承诺；依赖本机账户、系统权限、磁盘与备份保护。`REAL_BOT_DATA_DIR` 可替换数据库和接口描述文件的默认目录，不改变钥匙串服务、执行权限或本机 API 端口，不构成安全隔离。

本机 API 绑定 `127.0.0.1:17890`。健康检查不鉴权；其他 HTTP 请求使用 Bearer token，WebSocket 在首条消息认证。浏览器开发服务器提供同源 `/__local-api` 以读取该 token；保持开发服务仅供本机使用，不把开发服务器或本机 API 暴露到公网。

## 公开代码和诊断信息前

- `.gitignore` 只是减少误提交，不是秘密扫描或历史清理工具。
- 不提交 `.env`、API key、token、私钥、数据库、真实对话、工作区产物或完整工具返回。
- 日志与截图也可能包含密钥、账号、内部 URL 或私人路径，公开前逐项脱敏。
- 保留贡献和第三方代码所需的授权声明。

## English summary

Real Bot is WIP for local macOS experimentation, with no stable-version security support or response-time guarantee. Report vulnerabilities through GitHub **Security → Report a vulnerability** when enabled. If unavailable, open an Issue requesting a private contact channel **without disclosing vulnerability details**. Maintainers must enable private reporting before public release; no dedicated security email is currently designated.

Local execution does not mean offline or sandboxed execution. Remote model and MCP requests may transmit data, local MCP processes may access the network, all Bots share tools and files, and configured MCP calls are not individually approved. The workspace shell is not an OS sandbox. Single-file HTML preview runs scripts in an opaque-origin iframe (`allow-scripts`, no `allow-same-origin`) and is not an isolated execution environment. Stop and approval cannot undo completed effects or costs.

State and local tokens live in the application support directory, provider and HTTP MCP credentials use macOS Keychain, and attachments and full tool results live in the selected workspace. There is no application-level encryption guarantee for these data files. `REAL_BOT_DATA_DIR` does not isolate Keychain credentials or change the API port. Keep development services local, redact diagnostics, and rotate any exposed credentials immediately.
