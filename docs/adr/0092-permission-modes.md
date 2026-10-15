# 权限模式 / Permission modes

Status: implemented 2026-10-16. Replaces the [危险动作矩阵](../../CONTEXT.md)'s workspace line and [ADR 0087](0087-always-allow-covers-the-project.md)'s Always allow; supersedes [ADR 0005](0005-workspace-shell-convention.md) as a permission rule and the "unchanged" line of [ADR 0090](0090-the-workspace-bounds-bots-not-you.md) that a Bot still needs your OK outside the workspace.

原来 Bot 能做什么由工作区划线：区内读、写、删和「工作区壳」直接干，区外读写和越界的壳出批准卡，卡上 Always allow 存一条按项目放行的规则；新增或改 MCP、端点和内置提示词每次都问，没有 Always allow。可工作区从来关不住 Bot（壳不是囚笼，[ADR 0005](0005-workspace-shell-convention.md)），Bot 干的活又常常在工作区外的仓库里——2026-10-11 一个项目三张卡（[ADR 0087](0087-always-allow-covers-the-project.md)），2026-10-15 Bot 在 `~/my-projects/curio` 里做 landing 页（[ADR 0090](0090-the-workspace-bounds-bots-not-you.md)）。你说：「权限模式要重新设计下：支持所有行为全部允许；支持应用默认权限模式；支持 Bot 覆盖应用默认模式；权限模式不要太复杂，最好 3–5 种就搞定。工作区不再是约束权限的一种限制，只是一种约束 Bot 工作产物组织的一种规则，只是为了方便统一管理所有 Bot 的产出。」

What a Bot could do used to be drawn by the workspace: reads, writes, deletes and the "workspace shell" inside it ran, reads and writes outside it and a shell that crossed it put up a card, and Always allow on the card saved a rule letting a project through; adding or changing MCP servers, endpoints and built-in prompts asked every time, with no Always allow. But the workspace never held a Bot in (the shell is no jail, ADR 0005), and a Bot's work is often in a repository outside it — three cards for one project on 2026-10-11 (ADR 0087), a landing page built in `~/my-projects/curio` on 2026-10-15 (ADR 0090). You said: "Redesign the permission modes: allow everything; an app default; a Bot overriding the app default; not too complicated, three to five modes. The workspace stops being a permission limit; it is only a rule for how Bots' work is organized, so every Bot's output is managed in one place."

## 决定 / Decisions

1. **四种模式，按「改不改东西」分 / Four modes, by what a call changes.** 一次调用先归成三类：读（读文件、列目录、搜索、联网查、调已配的 MCP），改（写、改、移动、删文件，跑命令——命令能做写能做的一切，所以和写同一类），改配置（新增或改 MCP、新建或改端点、改或恢复内置提示词）。模式决定后两类：

   | 模式 | 读 | 改 | 改配置 |
   |---|---|---|---|
   | 只读 `read_only` | 直接干 | 拒绝 | 拒绝 |
   | 改动先问 `ask_first` | 直接干 | 出卡 | 出卡 |
   | 自动 `auto`（默认） | 直接干 | 直接干 | 出卡 |
   | 全部允许 `allow_all` | 直接干 | 直接干 | 直接干 |

   路径在不在工作区里不再进判断。只读下被拒的调用不出卡，Bot 拿到一句说明（它的模式是只读，要改的写进回复）；只读也拦删 MCP、改 MCP 备注、改端点模型名这些原来不问的配置改动。

   A call is first one of three things: a read (reading a file, listing, searching, looking things up on the web, calling a configured MCP tool), a change (writing, editing, moving or deleting a file, running a command — a command can do anything a write can, so it is the same class), or a change to the app's setup (adding or changing an MCP server, adding or changing an endpoint, editing or resetting a built-in prompt). The mode decides the last two (table above). Whether a path is in the workspace no longer enters into it. Under read-only a refused call puts up no card; the Bot is told its mode is read-only and to put what it would change in its reply. Read-only also refuses the setup changes that never asked (removing an MCP server, its usage note, an endpoint's model names).

2. **应用一个默认，Bot 可以覆盖 / One mode for the app, which a Bot may override.** 设置 › 通用有「权限模式」，四选一，新装和升级上来都是「自动」。Bot 面板里有「权限模式」：跟随应用，或四种之一。一次调用按这个 Bot 自己的模式判，没有就按应用的。两样都只有你能改：Bot 改不了自己的、也给不了它雇来的 Bot（同 runner，403）。

   Settings › General has the app's permission mode, one of four, auto on a fresh install and after an upgrade. The Bot panel has the Bot's own: follow the app, or one of the four. A call is decided by its Bot's own mode, else the app's. Only you set either: a Bot can set neither its own nor one for a Bot it hires (403, as for the runner).

3. **Always allow 取消，卡上换成「以后都直接干」 / Always allow goes; the card offers "allow from now on".** 批准卡的按钮是「允许一次」「以后都直接干」「拒绝」。按「以后都直接干」放行这一次，并把这个 Bot 改到这类调用不再问的最窄模式：改的卡是「自动」，改配置的卡是「全部允许」；Bot 已经在那个或更宽的模式里就不动。按钮下面一行写明会改成什么。设置里的 Always allow 列表去掉；已存的规则不再生效，表和行留着当记录。

   The card's buttons are Allow once, Allow from now on, Deny. Allow from now on lets this call through and moves the Bot to the narrowest mode in which this kind no longer asks: auto for a change, allow_all for a setup change; a Bot already in that mode or a wider one stays. A line under the buttons says what it moves to. The Always allow list leaves Settings; rules already saved no longer apply, and the table and its rows stay as the record.

4. **要你填密钥的卡照出 / A card that carries your key still comes up.** 全部允许下，新增 HTTP MCP、新建要密钥的端点、改一个还没有密钥的端点的连接，仍然出卡：卡上要的是只有你有的密钥，不是你的同意。本机模型服务不要密钥，全部允许下直接加。

   Under allow_all, adding an HTTP MCP server, adding an endpoint that takes a key, or changing the connection of one that has none still puts up a card: what it asks for is a key only you have, not your consent. A model server on this machine takes none and is added at once.

5. **Bot 知道自己的模式 / A Bot is told its mode where it matters.** 只读和改动先问下，局面块写一行「你的权限模式：……」，告诉它被拒的怎么办、每次都要等卡时别把一条命令拆成几条。自动和全部允许下不写：那几张卡来去不用它绕着走。系统指令和本地 Agent 的前言改成「要不要等批准由权限模式决定，和在不在工作区无关」。

   Under read-only and ask-first the situation block says so in one line, with what to do about it. Under auto and allow_all nothing is said. The System section and the local agents' prefaces now say approvals follow the permission mode, not the workspace.

6. **工作区只管产物放哪 / The workspace only says where work goes.** 工作区仍是所有 Bot 共用的产物目录：工作目录、任务目录、`inbox/`、附件和批注都在里面，命令默认从任务目录跑，`scratch/` 放过程文件，别写 `/tmp`。这些是组织规则，不是权限。设置里工作区卡上「工作区安全边界」那段换成「工作区的用途」。

   The workspace is still where every Bot's work goes: work dirs and ticket dirs, `inbox/`, attachments and annotations live there, commands start in the ticket dir, throwaway files go in `scratch/`, not `/tmp`. These are rules for keeping work together, not permissions. The workspace card's "security boundary" callout becomes "what the workspace is for".

## 不变 / Unchanged

- 拒绝不是批准，任何模式（全部允许也一样）都照旧：本机 Agent 的登录凭据（`~/.claude`、`~/.codex`、钥匙串……）读不到、碰了就停这一轮；递归搜索整个家目录或 `/` 在跑之前就拒；Claude Code 不许后台任务；叫停下的只读轮只能看。 / Refusals are not approvals and hold in every mode, allow_all included: no Bot reads your local agents' sign-ins, a recursive search of your whole home or `/` is refused before it runs, Claude Code runs nothing in the background, and a read-only segment under a stop only looks.
- 「允许一次」「拒绝」和被拒后 Bot 听到的话不变；叫停之下按了允许也不执行（I3）。 / Allow once, Deny and what a Bot hears on a denial are as before; a call under a stop does not run even if you allow it (I3).
- 只有 Agent 自己事后才报的调用（Antigravity 的 print 模式、Agent 没先问就跑的）：按模式本该问或拒的，照旧停下这一轮（`agent_unguarded`）。 / A call the app only hears of after it ran (Antigravity's print mode, or one an agent ran without asking) stops the turn when its mode would have asked or refused, as before (`agent_unguarded`).
- 你自己的终端、从消息里打开工作区外的文件（[ADR 0090](0090-the-workspace-bounds-bots-not-you.md)）不走批准。 / Your own terminal and opening files outside the workspace from a message (ADR 0090) never asked and still do not.
- 验收检查仍只认工作区里的路径和命令（[ADR 0036](0036-acceptance-checks-run-by-the-daemon.md)）：那是守护进程自己不经任何批准跑的，不是 Bot 的调用。 / Acceptance checks still take only workspace paths and commands (ADR 0036): the daemon runs them itself, with no approval at all, and they are no Bot's call.

## 取舍 / Trade-offs

- **默认「自动」比原来宽。** 原来 Bot 写工作区外要你点头，现在自动模式下直接写、命令也不再按路径分。原来那条线本来就拦不住（壳不是囚笼，一条命令就出去了），留着只是让你在每个外面的仓库都点一遍。要原来那种谨慎就选「改动先问」，代价是工作区里的写和命令也每次问。 / **Auto is wider than before.** A Bot used to need your OK to write outside the workspace; under auto it writes there, and commands are no longer told apart by path. That line never held (the shell is no jail; one command was out), and keeping it only meant a card per outside repository. For that caution choose ask-first, which asks for writes and commands inside the workspace too.
- **改动先问没有按目录放行。** 想在一个仓库里放手、别处要问，做不到；要么按卡逐次放，要么把这个 Bot 改成自动。四种模式够用比规则表好懂。 / **Ask-first has no per-folder exception.** Letting a Bot loose in one repository while it asks elsewhere is not possible; allow each card, or move that Bot to auto. Four modes are easier to hold in your head than a rule list.
- **「以后都直接干」改的是整个 Bot。** 在一张写文件的卡上按下去，这个 Bot 以后所有的写和命令都不再问；按钮下面那行就是为了按之前看清楚。 / **"Allow from now on" changes the whole Bot.** Pressed on one write's card, all that Bot's writes and commands stop asking; the line under the button is there so you see that first.
- **命令照样能改模式。** 自动下 Bot 的壳能读到本机 token、调本机 API；这和原来工作区壳能做的一样，不是新口子。只读和改动先问挡得住，因为命令本身被拒或要卡。 / **A command can still reach the app.** Under auto a Bot's shell can read the local token and call the local API, as the workspace shell always could; read-only and ask-first hold, because the command itself is refused or carded.

## 实现 / Implementation

协议：`packages/protocol/src/permissions.ts`（`PERMISSION_MODES`、`permissionVerdict`、`permissionClassOf`、`modeAllowing`）；`Bot.permission_mode`、`Settings.permission_mode`、`ResolveApprovalAction`（`allow_once` / `allow_from_now` / `deny`）；`AllowRule`、`allow_rule.*` 事件、快照的 `allowRules`、`Approval.allow_scope` 去掉。守护进程：`bots.permission_mode` 列（`migrate.ts` 补），`store/permissions.ts`（`permissionModeFor`、应用模式在 settings），`store/bots.ts` 只认你；`permission-gate.ts`（卡种类 `file-write` / `shell`，只读的拒绝说明）；`workspace-tools.ts` 的 `gateChange`、`claude-code/policy.ts` 的 `gateChange`（Claude Agent 和 `engine/agent/policy.ts` 共用）、`agent-runner.ts` 里 Claude Code 自己问的也按模式；`collab-tools/guards.ts` 的 `setupVerdict`（`mutateConfiguration` 里拦只读）用在 `mcp.ts`、`endpoints.ts`、`prompt-tools.ts`；`store/approvals.ts` 的 `allow_from_now`，`turn-engine.ts` 发 `bot.upsert`；`allow-scope.ts` 和 `/v1/allow-rules` 路由删掉，`allow_rules` 表留着；`context/situation.ts` 的模式行；`prompts/system.ts`、`prompts/agent-system.ts`。信使：`settings/PermissionModeCard.svelte`（替 `AllowRulesCard`）、`panels/ProfileBasics.svelte` 的选择、`chat/TranscriptApproval.svelte` 的按钮和说明行、`copy/permissions.ts`、`WORKSPACE_COPY`。

Protocol: `packages/protocol/src/permissions.ts`; `Bot.permission_mode`, `Settings.permission_mode`, `ResolveApprovalAction`; `AllowRule`, the `allow_rule.*` events, the snapshot's `allowRules` and `Approval.allow_scope` are gone. Daemon: the `bots.permission_mode` column, `store/permissions.ts`, the gates in `workspace-tools.ts`, `claude-code/policy.ts` (shared with `engine/agent/policy.ts`), `agent-runner.ts` and `collab-tools/guards.ts`; `allow_from_now` in `store/approvals.ts`; `allow-scope.ts` and the `/v1/allow-rules` routes removed, the `allow_rules` table kept; the situation line and the prompts. Messenger: `PermissionModeCard.svelte`, the Bot panel's select, the card's buttons, `copy/permissions.ts`.
