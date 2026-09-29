# Deskfolk

本机单人 agent 协作应用，macOS 为主；Windows 是实验性预览，差异和缺口见 [`docs/development.md`](docs/development.md) 的「Windows（实验性）」。术语见 [`CONTEXT.md`](CONTEXT.md)。

开发态：`pnpm install` 然后 `pnpm dev`（并行守护进程 + Tauri 窗；信使由窗拉起）。`pnpm test` / `pnpm typecheck`。细节见 [`docs/development.md`](docs/development.md)。贡献规范见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## Agent skills

- Issue tracker: [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- Domain glossary: [`CONTEXT.md`](CONTEXT.md)（英文版 [`CONTEXT.en.md`](CONTEXT.en.md) 随改，官网英文页读它；加删词条两边一起）；篇幅较长词条的行为细节见 [`docs/behavior.md`](docs/behavior.md)（英文版 [`docs/behavior.en.md`](docs/behavior.en.md)），随 CONTEXT 一起改
- Public roadmap: [`ROADMAP.md`](ROADMAP.md)（英文版 [`ROADMAP.en.md`](ROADMAP.en.md) 随改）
- Local planning: `.scratch/v1/map.md`（存在时参考；`.scratch/` 不随公开仓库分发）
