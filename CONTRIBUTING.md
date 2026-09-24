# Contributing / 参与贡献

Deskfolk 处于 **WIP** 阶段。欢迎中文或英文的问题报告、兼容性反馈、文档改进、测试和小范围代码贡献。提交前请先阅读 [README](README.md)、[路线图](ROADMAP.md) 和[行为准则](CODE_OF_CONDUCT.md)。

## 提问题或建议

- 在项目托管仓库的 Issues 中先查找相同问题，再使用对应模板。
- Bug 报告应包含 macOS 版本、工具链版本、源码版本、最小复现、期望与实际结果。模型或 MCP 相关问题还应说明接口类型和模型 / 工具名称。
- 日志、截图、对话与工具输出在公开前必须脱敏。不要上传 API key、Authorization、本机 token、真实对话数据库或未脱敏的工作区文件。
- 漏洞通过 [SECURITY.md](SECURITY.md) 的私密方式报告，不使用公开 Bug 模板。
- 涉及架构、权限边界、持久化或产品方向的大改动，先讨论问题和方案，避免直接提交大规模重写。

当前重点是本地协作、开放模型 / MCP 接入、agent 决策与反馈、通过对话管理应用。将尚未实现的目标与已验证行为分开说明。

## 开发环境

准备 macOS、Node.js `>=22`、pnpm `12.3.4`、Bun `>=1.2`、Rust / Cargo 和 [Tauri macOS 前置依赖](https://v2.tauri.app/start/prerequisites/#macos)。在仓库根目录执行：

```bash
pnpm install
pnpm dev
```

运行细节见[开发说明](docs/development.md)，领域术语见 [CONTEXT.md](CONTEXT.md)。依赖与脚本以各包的 `package.json`、`Cargo.toml` 和锁文件为准。包中的 `private: true` 用于防止意外发布到 npm，不影响源码采用 MIT 开源。

使用独立、可丢弃的测试工作区；如需隔离本机数据库与接口描述文件，可使用 `REAL_BOT_DATA_DIR`，但它不隔离 macOS 钥匙串中的凭据，也不改变本机 API 端口。避免让多个实例同时争用同一端口或真实数据。

## 验证要求

提交 PR 前运行并报告结果：

```bash
pnpm test
pnpm typecheck
pnpm --filter @real-bot/daemon build:sidecar
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @real-bot/messenger build
```

桌面壳把守护进程当 sidecar 打包（`externalBin`），Tauri 在 crate 编译期就校验该文件存在，所以单独跑 `cargo test` 前先编一次 sidecar（`pnpm dev` 和 `pnpm tauri build` 的钩子已经代劳）。

改信使样式时另跑 `pnpm --filter @real-bot/messenger test:visual`（本机视觉基线，见[开发说明](docs/development.md)）。改落地页时另跑 `pnpm --filter @real-bot/landing build`。GitHub Actions 的 CI 工作流会在 PR 与 `main` 上跑上述检查（含落地页 build 与 macOS `cargo test`），不能代替本机 UI 或原生桌面验证。快照发布与 Pages 见[开发说明](docs/development.md#ci落地页与快照发布)。

- 为行为变更增加相应测试；避免测试依赖个人凭据或付费真实服务。信使的组件也能测，和纯函数同一个 `pnpm test`，写法见[开发说明·信使组件测试](docs/development.md)。
- 修改 UI、客户端状态或页面数据时，在运行中的应用或浏览器中完成实际点击、输入、提交和导航验证，覆盖共享该状态的其他界面、错误态和边界情况。
- 修改布局或样式时检查桌面和窄屏视口；这项检查不代表支持移动端应用。
- 涉及托盘、退出、监督与登录启动时，额外在 macOS 桌面窗口验证，浏览器不能代替原生行为检查。
- 截图只能补充验证，不能代替实际交互。纯文档修改检查链接、命令与事实一致性。
- 明确记录实际通过的检查与未验证的项目；不要把假模型测试写成真实模型端到端验收。

## 提交 Pull Request

1. 保持改动聚焦，说明解决的问题、范围和限制。
2. 遵循现有 TypeScript / Svelte / Rust 风格，注释只解释必要约束。
3. 同步更新受影响的文档。项目范围、用法和限制变化时，保持 `README.md` 与 `README.zh.md` 内容一致。
4. 面向用户的功能、修复或不兼容变更记入 [CHANGELOG.md](CHANGELOG.md) 的 `Unreleased`（并在 [CHANGELOG.zh.md](CHANGELOG.zh.md) 同步记录），不要提前宣称发布。
5. 新引入或改编第三方代码时保留许可证与版权声明，必要时更新 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
6. 提交前检查文件清单，排除密钥、运行数据、日志、个人路径、截图中的隐私和临时产物。
7. PR 中附验证结果及未完成项；建议使用 `docs:`、`fix:`、`feat:` 等清晰的提交前缀，不附自动生成署名。

提交贡献表示你有权提供这些内容，并同意按本项目 [MIT License](LICENSE) 提供贡献；第三方原有声明继续适用。

## 本地规划记录

维护过程可以使用 `.scratch/` 存放本地票据、实验与验证产物，约定见 [issue tracker](docs/agents/issue-tracker.md)。该目录默认不进入公开仓库；公开讨论、验收依据与必须共享的设计应整理到 Issue / PR 或 `docs/`，不能要求贡献者具备某位维护者的本地文件。

## 维护者首次公开前检查

- 核对待发布文件及已有 Git 历史（若有），执行秘密扫描；`.gitignore` 不能清理已提交的历史。
- 检查第三方源码与图片等素材的来源和许可；二进制分发还需核对实际打包的依赖声明。
- 在 GitHub 的 **Settings → Code security** 中启用 **Private vulnerability reporting**，确认 Security 页存在 **Report a vulnerability**；设置位置可能随 GitHub 界面变化。
- 运行上述验证命令，保留 WIP 声明，并检查公开文档链接。
- 初始化 / 推送 Git、创建公开仓库与切换可见性属于单独的发布操作，不因本地文档准备而自动执行。
- 公开后确认 Actions 已跑通、Pages 源为 GitHub Actions，以及 Security 页存在 **Report a vulnerability**。

## English summary

Deskfolk is WIP. Issues and pull requests in Chinese or English are welcome. Keep changes focused, discuss major architectural or security changes first, and provide reproducible, redacted reports. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Run all four verification commands above before submitting a PR; also build the landing page when those files change. GitHub Actions repeats those checks on pull requests and `main`, but does not replace local UI or native macOS verification. Exercise behavior changes end to end, including shared state and edge cases; check desktop and narrow viewports for layout changes and the native macOS app for desktop integration. Documentation-only changes need link, command, and factual checks rather than UI interaction.

Keep both READMEs aligned (`README.md` and `README.zh.md`), document user-facing changes under `Unreleased` in `CHANGELOG.md` (and `CHANGELOG.zh.md`), retain third-party notices, and exclude secrets and local artifacts. Contributions are submitted under MIT. `.scratch/` is local-only; share necessary designs and verification in Issues, PRs, or `docs/`. `REAL_BOT_DATA_DIR` isolates data files, not Keychain secrets or the API port. Before making the repository public, maintainers must review the files and any history, scan for secrets, check asset licenses, and enable GitHub private vulnerability reporting.
