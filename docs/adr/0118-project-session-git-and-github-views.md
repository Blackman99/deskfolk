# 项目会话的 Git 与 GitHub 视图 / Git and GitHub views for project sessions

Status: accepted 2026-11-25. Builds on [ADR 0095](0095-project-sessions.md) (project sessions) and [ADR 0086](0086-a-job-is-one-tab.md) (one tab for linked views).

## 背景 / Context

项目会话让你在本地项目目录里直接与本机 Agent 对话，但在多步骤改动、多工作树并行、以及结合 GitHub Issue/PR 推进开发时，仅靠对话转录无法直观查看当前目录的改动、提交图、同一仓库下的全部工作树及各工作树正在跑的会话，也难以快速看到当前分支对应的 PR 状态与关联 Issue。

Project sessions let you work directly with a local agent in a directory, yet reviewing uncommitted changes, inspecting commit history, tracking sibling worktrees and their active sessions, and checking associated GitHub PRs and issues still required leaving the app for a terminal or browser.

## 决定 / Decisions

1. **一个按项目目录绑定的 `git` 工作台窗格 / One project-scoped `git` workbench pane.** 新增窗格种类 `git`，绑定键为 `project:<dir>`（与项目预览相同，同目录下多个会话共享一个标签页），默认打开位置为 `side-right`。窗格明确拆分「层级作用域」与「内容视角」：顶栏左侧是持久的**单面包屑选择器**（`[仓库 ›] [分支·改动数 ▾]`）加**单分组浮层**（按仓库分组列出各仓库下的工作树、关联项目会话与快捷动作，跨仓库切换工作树一次点击直达），顶栏右侧是三个平级内容视角：**改动（Changes）**、**历史（Graph）**、**GitHub**，外加当前工作树的快捷操作。标签页参数作为唯一数据源，切换仓库或工作树原地留在当前视角并重挂载内容区，不跳 Tab。
2. **第一版只读，会话目录不可变 / Read-only v1; a project session's directory never mutates.** 改动、暂存、提交、推送和建删工作树仍交给 Agent 或终端。项目会话的 `project_dir` 始终固定；所有仓库与工作树发现均以单一规范的**项目边界根**为界（项目目录在工作树内取其顶层，多仓父目录取项目目录本身），不混入边界之外的兄弟工作树。当查看非项目目录所在工作树时，面包屑高亮并提供一键返回，标签页标题附带目标名。
3. **Daemon 只读 `GET` 路由与安全进程执行 / Read-only daemon GET routes with hardened process execution.** 新增 `local-api/routes/project-git.ts` 与 `project-github.ts`。所有 `git` / `gh` 命令均通过纯 argv 执行（不经过 shell），从 `store.projectOf(id).dir` 推导目录，纯读 `.git` 区分独立仓库与链接工作树并按 common dir 去重，严格校验 `worktree`（必须命中 `git worktree list`、未失效且位于项目边界根内）；提供零 `git status` 的 `GET /git/tree` 层级接口（浮层内可见行按需懒拉状态，避免轮询阻塞用户 diff）；清空继承环境中的 `GIT_DIR`/`GIT_WORK_TREE` 等变量，统一注入 `GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0` 及禁用外部 diff/textconv/fsmonitor/credential helper 的 `-c` 参数，不自动执行 `git fetch`，并实行同键单飞合并、并发限流、超时和字节上限。
4. **复用现有事件刷新，不新增 WS 帧 / Refresh via existing frames, no new WebSocket frame types.** 界面按项目目录订阅现有 `ToolFrame`（`write`/`git` 动作）、`agent_run.upsert` 终态、窗口回前台（`lifecycle()`）及空闲 15 秒轻量摘要轮询，不引入 `fs.watch`，也不破坏旧窗口和手机端的事件流兼容。
5. **原生渲染 Diff 与提交图 / Native DiffView and virtualised Canvas commit graph.** 改动与提交详情的差异复用 `nsh/base` 的 `DiffView`；提交历史图采用虚拟化 `List` 加每行定宽轻量化 `Canvas` 绘制泳道线段与分叉/合并贝塞尔曲线，泳道算法为独立纯函数并附单元测试。
6. **GitHub 仅经本机 `gh` CLI，不触碰凭据 / GitHub exclusively via local `gh` CLI; never store tokens.** 通过 `git remote get-url` 识别 GitHub / Enterprise 仓库，用 `gh api graphql` 聚合查询当前分支 PR（含检查汇总、评审决定、closing issues）、commit/分支号引用的 Issue、会话中提及的本仓库 Issue/PR 链接，以及仓库列表筛选；支持 60 秒内存缓存与断网/未装 `gh`/未登录/非 GitHub 仓库的清晰降级；「引用到输入框」只填充当前会话草稿，不自动发送。
7. **术语、手机/远程支持与后续期次 / Terminology, mobile/remote support, and follow-ups.** 遵循 `CONTEXT.md`：git worktree 称「工作树」（不称「工作区」），PR review 称「评审」（不称「审查」）。桌面宽屏以工作台窗格交付；手机与托管平板以会话全屏页（`?s=<id>&o=git`，复用于 `MainPages` 并接入 `stepIn`/`holdLevels` 分层返回）交付，daemon 远程白名单放行全部 10 条只读 Git/GitHub `GET` 路由并对 diff 响应实施 UTF-8 序列化字节封顶（远端预览默认 200 KiB、可按需加载完整 diff 且严格低于 1 MiB Noise 帧上限），远端链路关闭 15 秒轮询与浮层内批量状态扇出。Diff 行级批注留待后续期次。
