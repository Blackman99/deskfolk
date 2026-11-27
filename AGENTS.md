# Deskfolk

本机单人 agent 协作应用，macOS 为主；Windows 和 Linux 是实验性预览，差异和缺口见 [`docs/development.md`](docs/development.md) 的「Windows（实验性）」「Linux（实验性）」。术语见 [`CONTEXT.md`](CONTEXT.md)。

开发态：`pnpm install` 然后 `pnpm dev`（原生桌面应用的开发版，自带一个从源码起的运行时，用独立的端口和数据目录，和装好的版本并存）。`pnpm test` / `pnpm typecheck`。细节见 [`docs/development.md`](docs/development.md)。贡献规范见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 写代码之前

先读 [`docs/agents/code-structure.md`](docs/agents/code-structure.md)。要点：

- 源码文件不超过 2000 行（`scripts/line-budget.ts`，`pnpm test` 第一步）；已经拆开的地方新代码进子模块，入口文件只装配和转发。
- 动手写之前先找现成的共用件（清单在那份文档里），只合并逐字相同的副本。
- 拆文件、抽重复和改行为分开提交；副本之间的差别不要顺手统一，那份文档列了已知的、有意没动的差别。
- `pnpm dev` 跑着时，改 daemon 在 worktree 里改，合入前确认没有活轮。

## 改完之后

先自己验证，再说做完了；验证时不借用户的屏幕、窗口、运行时和数据。做法见 [`docs/agents/verification.md`](docs/agents/verification.md)，包括 worktree 准备、无头界面测试、后台窗口截图（`--snapshots` 拍不出窗口服务器合成的效果）和手机网页。下结论前，以文件和进程的实际状态为准，不以任务通知为准。

## Agent skills

- Issue tracker: [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- Domain glossary: [`CONTEXT.md`](CONTEXT.md)（英文版 [`CONTEXT.en.md`](CONTEXT.en.md) 随改，官网英文页读它；加删词条两边一起）；篇幅较长词条的行为细节见 [`docs/behavior.md`](docs/behavior.md)（英文版 [`docs/behavior.en.md`](docs/behavior.en.md)），随 CONTEXT 一起改
- Public roadmap: [`ROADMAP.md`](ROADMAP.md)（英文版 [`ROADMAP.en.md`](ROADMAP.en.md) 随改）
- Local planning: `.scratch/v1/map.md`（存在时参考；`.scratch/` 不随公开仓库分发）
