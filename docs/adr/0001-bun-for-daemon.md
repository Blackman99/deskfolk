# 守护进程用 Bun，不用 Node

Real Bot 的守护进程是独立 TypeScript 进程，清场要能打进本机 `.app`、以后给 launchd，用户机器上没有 Node。Node 官方 SEA 仍是 Stability 1.1 且 CI 只测 macOS arm64；`node:sqlite` 在 Node 22 LTS 仍实验。Bun 的 `bun build --compile` 和 `bun:sqlite` 是一等路径。pnpm 仍管 workspace；信使和 Tauri 壳继续用 Node。换回 Node 等于换 SQLite 驱动和打包方式。
