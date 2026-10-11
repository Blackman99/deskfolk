# Always allow 放行整个项目 / Always allow covers the project

Status: implemented 2026-10-12. Changes the scope [危险动作矩阵](../../CONTEXT.md) gives an Always allow on a card for a path outside the workspace; nothing else about approval cards changes.

工作区外读写的批准卡上按 Always allow，原来存下的范围就是卡上那个路径。规则按前缀匹配，但卡上从来只是一个文件，所以它只放行那一个文件：2026-10-11 夜里「开发助手」（Claude Code）改 `~/my-projects/sveltepress`，`Navbar.svelte` 出卡、你按 Always allow，`Sidebar.svelte` 又出卡、又按，`.changeset/full-width-section-tabs.md` 再出卡——三张卡，同一个项目。你说：「当前 Bot 想在工作空间外的地方读写文件审批太多了。」

An Always allow on a card to read or write outside the workspace used to save the card's own path as its scope. Rules match by prefix, but a card names one file, so the rule let through that file alone: on the night of 2026-10-11 「开发助手」 (Claude Code) worked in `~/my-projects/sveltepress` — `Navbar.svelte` put up a card and you pressed Always allow, `Sidebar.svelte` put up another and you pressed it again, then `.changeset/full-width-section-tabs.md` — three cards for one project. You said: 「当前 Bot 想在工作空间外的地方读写文件审批太多了。」

## 决定 / Decisions

1. **卡片提出一个文件夹 / The card proposes a folder.** 出卡时守护进程看磁盘，算出 Always allow 要放行的地方（`allow_scope`，存在审批行上）：从这个路径往上，最近一个含 `.git`（目录或文件，worktree 也算）的文件夹就是它的项目；没有就是它所在的文件夹（路径本身是文件夹就是它自己）。家目录、家目录以上、磁盘根和根下一层（`/etc`、`/Users`、`D:\data`）都太宽：碰到就停，落在这里的卡只放行路径本身。三种运行方式（应用自己的循环、Claude Agent、其他本地 Agent）的卡都从 `openApprovalCard` 出，一处算。 / When the card goes up the daemon looks at the disk and works out what Always allow would cover (`allow_scope`, kept on the approval row): from the path upward, the nearest folder holding a `.git` (a folder or a file, so a worktree counts) is its project; with none, the folder it is in (or the path itself when that is a folder). Your home, anything above it, a disk's root and the folders right under one (`/etc`, `/Users`, `D:\data`) are too wide: the walk stops there, and a card that lands on one covers its path alone. Cards from all three runners (the app's own loop, Claude Agent, the other local agents) go up through `openApprovalCard`, so it is worked out in one place.

2. **卡上写明覆盖哪里 / The card says what it covers.** 范围比卡上的路径宽时，按钮下面一行：「Always allow 放行整个 /Users/…/sveltepress：以后所有 Bot 在里面读写都不再问。」按下去不用另选，守护进程存的就是这一个；resolve 请求自己带 `scope` 的，照旧以它为准。 / When the scope is wider than the card's path, a line under the buttons says so: "Always allow covers all of /Users/…/sveltepress: no Bot asks again to read or write in it." Pressing it saves exactly that; a resolve that names its own `scope` still wins.

3. **能写的地方也能读 / Where Bots may write they may read.** `outside-read` 也认同一前缀下的 `outside-write` 规则；反过来不认。 / An `outside-read` call is also covered by an `outside-write` rule over it; not the other way round.

4. **规则看得见、删得掉 / Rules can be seen and removed.** 设置 › 通用的工作区卡下面列出每条 Always allow：做什么（工作区外读 / 读写 / 无约束壳 / 出站网络）、在哪，各带「删除」。删了下一张那里的卡照常出。范围一宽，放行过的地方就得能收回来。 / Settings › General lists every Always allow under the workspace card: what it lets Bots do (read / read and write outside the workspace, unconstrained shell, outbound network) and where, each with Remove. The next card there asks again. Once a press covers a whole project, it has to be easy to take back.

## 不变 / Unchanged

- 「允许一次」只放这一次调用。 / Allow once lets through this one call.
- 无约束壳的 Always allow 仍只能是 `*`；出站网络的范围仍是卡上的目标。必须每次批准的种类（新增 MCP、新建端点、改内置提示词）照旧没有 Always allow。 / An unconstrained shell's Always allow is still `*`; outbound network's scope is still the card's target. Kinds that must be approved each time (adding MCP, new endpoints, built-in prompt edits) still have no Always allow.
- 已经存下的单文件规则照旧生效。 / Rules already saved for single files keep working.

## 取舍 / Trade-offs

- **一次放行一整个项目。** 你在一个文件的卡上按下去，同项目的别的文件以后也不问；卡上那一行就是为了让你按之前看清楚。只想放这一个，按「允许一次」。 / **One press covers a whole project.** Pressed on one file's card, the project's other files stop asking too; the line on the card is there so you see that before pressing. For that one file only, use Allow once.
- **项目按 `.git` 认。** 不是 git 仓库的项目退到文件所在的文件夹，可能还会在它的兄弟文件夹再出一次卡。 / **A project is found by its `.git`.** One that is not a git repository falls back to the file's folder, so a sibling folder may still ask once.

## 实现 / Implementation

`apps/daemon/src/allow-scope.ts`：`proposedAllowScope(kind, target, host)`，只对 `outside-read` / `outside-write` 给值。`engine/tools.ts` 的 `openApprovalCard` 在事务外算，`store.insertApproval` 写进 `approvals.allow_scope`（新列，旧库在 `migrate.ts` 补）。`store/approvals.ts`：`alwaysAllowScope(row, scope)`（你给的 `scope` → `allow_scope` → `target`），`resolveApproval` 和 `turn-engine.ts` 的发布共用；`matchesAllowRule` 让读认写规则，Windows 上按 `isWithinPath` 比。协议 `Approval.allow_scope`。信使：`approval-card.ts` 的 `alwaysAllowFolder`、`TranscriptApproval.svelte` 那一行，`settings/AllowRulesCard.svelte`（`snapshot.allowRules`，`deleteAllowRule` 本机和远程两个客户端都有）。
