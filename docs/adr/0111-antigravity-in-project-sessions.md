# 项目会话里的 Antigravity / Antigravity in project sessions

Status: implemented 2026-11-17. Builds on [ADR 0095](0095-project-sessions.md) (project sessions), [ADR 0099](0099-codex-in-project-sessions.md) (Codex in project sessions) and [ADR 0079](0079-local-agents.md) (local agents).

2026-11-17 你说「项目会话支持导入 agy 以及新开 agy；同时，之前很多功能只做了 Claude 的，对齐一下 codex 跟 agy」。查下来 Bot 早就能跑 Antigravity（`agy acp`，ADR 0079），项目会话还只有 Claude Code 和 Codex。我给了第一版计划，只做 agy 本身和它够得着的几样；你说「要做就一起都做了」，所以 Codex 缺的那几样（账号、计划模式、后台命令、回放、花费估算）也排进了这一串提交，见「以后」。

On 2026-11-17 you said "项目会话支持导入 agy 以及新开 agy；同时，之前很多功能只做了 Claude 的，对齐一下 codex 跟 agy" (project sessions should carry on and start agy; and many features had been built for Claude only, so bring Codex and agy level). Bots had run on Antigravity (`agy acp`, ADR 0079) for a while; project sessions had only Claude Code and Codex. I gave a first plan covering agy itself and the few things within its reach; you said "要做就一起都做了" (if we do it, do it all together), so what Codex lacks (accounts, plan mode, background commands, the replay, a spend estimate) is lined up in this series of commits too; see Later.

查下来（agy 1.5.10，2026-11-17）：

- `agy acp` 的 `initialize`：`loadSession` 为真；`sessionCapabilities` 有 resume、close、load、list、additionalDirectories，没有 fork；`promptCapabilities.image` 为真。
- `session/list` 列出 agy 存着的每一个会话，终端里的和应用里各个 Bot 的都在，每条是 `{sessionId, cwd, title, updatedAt}`；它不理会 cwd 筛选，也不说会话是谁开的；`/tmp` 和 `/private/tmp` 两种写法都有。
- `session/load` 先把历史重放一遍（`user_message_chunk`、`agent_thought_chunk`、`agent_message_chunk`、带 `rawInput`/`rawOutput` 的 `tool_call`、`session_info_update`、`usage_update`），没有时间戳；然后才回 models、modes（default、accept-edits、auto、plan）和 configOptions（model、thought_level、mode）。
- 换一个新进程 `session/resume` 上下文还在（让它记住 PELICAN，它答 PELICAN），而且什么也不重放。
- default 模式下它写文件、跑命令之前什么也不问：每个调用先报 `in_progress`，几毫秒后报 `completed`。
- 计划模式不改项目里的任何文件；agy 把计划写到 `~/.gemini/antigravity-cli/brain/<会话>/<名字>.md`，`ArtifactMetadata.RequestFeedback` 为真，回复里请你审阅。
- 把 `/compact` 当提示词文字发过去，它会压缩（回复是空的）。
- 它送到后台的命令（`run_command` 带 `WaitMsBeforeAsync`）在 `end_turn` 之后还是 `in_progress`；命令结束时 agy 报告它（`completed`，带输出和退出码），也可能不等提示词自己说话。单独结束一条命令做不到。
- `session/set_model` 在提示词进行中也被接受。
- 另一个进程在这个会话被提示时也能 `session/load` 它。
- 经应用实机检查（隔离的运行时，真 agy，`gemini-3.8-flash-low`）：新会话答了；第二句接上了；auto 下改文件通过；先问下 agy 没问就把文件写了，应用在那个调用处停下这一轮（那一行已经写出去了）；计划模式出了计划卡、里面是 agy 自己的计划，批准后计划模式关掉、agy 照做（建了 README.md）；后台 `sleep 8` 显示成运行中的任务、这一轮读作空闲，结束后完成、运行关闭；终端里 `agy -p` 开的会话被列出、接着聊（2 句加那条说明），问它「code word 是什么」答 OSPREY；第二次接着聊回 409。

What was there (agy 1.5.10, 2026-11-17):

- `agy acp` `initialize`: `loadSession` true; `sessionCapabilities` resume, close, load, list, additionalDirectories, no fork; `promptCapabilities.image` true.
- `session/list` lists every session agy keeps, terminal ones and the app's own Bots', each as `{sessionId, cwd, title, updatedAt}`; it ignores a cwd filter and says nothing of where a session came from; both the `/tmp` and `/private/tmp` spellings occur.
- `session/load` replays the history first (`user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, `tool_call` with `rawInput`/`rawOutput`, `session_info_update`, `usage_update`), with no timestamps; only then does it answer models, modes (default, accept-edits, auto, plan) and configOptions (model, thought_level, mode).
- `session/resume` in a new process keeps the context (asked to remember PELICAN, it answered PELICAN) and replays nothing.
- In mode default it asked nothing before writing a file or running a command: each call is reported `in_progress` and `completed` milliseconds later.
- Plan mode changed no project file; agy wrote its plan to `~/.gemini/antigravity-cli/brain/<session>/<name>.md` with `ArtifactMetadata.RequestFeedback` true and replied asking you to review it.
- `/compact` sent as prompt text compacts (an empty reply).
- A command it sends to the background (`run_command` with `WaitMsBeforeAsync`) stays `in_progress` past `end_turn`; when it ends agy reports it (`completed`, its output and exit code) and may speak by itself without a prompt. One command cannot be ended alone.
- `session/set_model` mid-prompt is accepted.
- A second process can `session/load` a session while another is prompting it.
- Live check through the app (isolated runtime, real agy, `gemini-3.8-flash-low`): a new session answered; a second line resumed it; a file edit under auto went through; under ask first agy wrote the file without asking and the app stopped the turn at that call (the line was already written); plan mode put up the plan card with agy's own plan, approving it turned plan mode off and agy carried it out (created README.md); a background `sleep 8` showed as a running task with the run idle, then completed and the run closed; a session started with `agy -p` in a terminal was listed, carried on (2 lines plus the note), and asked "what was the code word" it answered OSPREY; carrying it on a second time answered 409.

## 决定 / Decisions

1. **项目会话的 Agent 可以是 Antigravity / A project session's agent can be Antigravity.** `PROJECT_AGENTS` 多了 `antigravity`（和 Bot 的 runner 同一个键）；标志、名字和模型来自应用对你的 agy 所知的（`GET /v1/runtime/agents`）。`PROJECT_AGENT_CAPS` 里：计划模式有，命令有，账号没有（应用没有 agy 的账号），可导入有，分支没有，回放有（见文末的任务地图回放补记），任务有（后台命令），`stopsTask` 没有，`asksFirst` 没有。新增的 `tasks`、`stopsTask`、`asksFirst` 三项每个 Agent 都有：Claude Code 全是有；Codex 的 `tasks` 暂时没有、`stopsTask` 没有、`asksFirst` 有。 / `PROJECT_AGENTS` gains `antigravity` (the same key as the Bots' runner); its mark, name and models come from what the app knows of your agy (`GET /v1/runtime/agents`). In `PROJECT_AGENT_CAPS`: plan yes, commands yes, accounts no (the app has no agy accounts), importable yes, branches no, replay yes (see the task-map replay addendum at the end), tasks yes (background commands), `stopsTask` no, `asksFirst` no. The new fields `tasks`, `stopsTask` and `asksFirst` exist for every agent: Claude Code all true; Codex `tasks` false for now, `stopsTask` false, `asksFirst` true.

2. **像在 agy 自己的终端里 / As in its terminal.** 每一轮在目录里起一个 `agy acp --sandbox`（它终端的沙箱，和 Bot 的 agy 一样），按 Bot 的 agy 那样找；客户端不提供文件系统和终端，所以 agy 用自己的工具；不加指令、不给应用的工具、不加 MCP 服务器。第一轮 `session/new`（它的 id 记成 `project_agent_session`），之后每一轮 `session/resume`；不能 resume 但能 load 的 agy 用 `session/load`，这一轮不取它的重放。低于 1.5.4 的 agy 不启动（和 Bot 同一条底线）。模型走 `session/set_config_option`（model），agy 那种模型加等级合在一起的 id（如 `gemini-3.8-flash-high`）走 `session/set_model`；思考等级走 `thought_level`；计划模式走 mode 选项；一轮进行中改了就立刻送出（agy 在下一步取用）。 / Each run starts `agy acp --sandbox` (its terminal sandbox, as a Bot's agy runs) in the directory, found as a Bot's is; the client offers no file system and no terminal, so agy uses its own tools; no instructions, none of the app's tools, no MCP server added. The first run calls `session/new` (its id becomes `project_agent_session`), later runs `session/resume`; an agy that cannot resume but can load uses `session/load`, and the replay is not taken for this run. An agy older than 1.5.4 is not started (the same floor as Bots). The model goes by `session/set_config_option` (model), or `session/set_model` for agy's model-and-level ids such as `gemini-3.8-flash-high`; the thinking level by `thought_level`; plan mode by the mode option; a change during a run is sent at once (agy takes it at its next step).

3. **权限：说明白的取舍 / Permissions: the named trade-off.** `agy acp` 不接受设置，而你的 agy 设置可能让它什么都能做，所以应用没法让它先问。它自己问的事（`session/request_permission`）按应用的规则（`decideAction`，项目目录为工作区）回答：`allow_once` / `reject_once`，先问下出批准卡。它不问就做的每个调用，在它边做边报的时候逐个检查；权限模式不让过的（先问下，任何改动或命令；只读下，任何改动或命令）用 `session/cancel` 停下这一轮，并写一行说它做了什么，那一步可能已经执行了。新开面板选 Antigravity 时这样写明（`asksAfter`）。凭据仍然碰不到，唯一的例外是 agy 为这个会话自己的文件夹（`~/.gemini/antigravity-cli/brain/<会话>`），它在那里写计划和笔记：每种模式下都允许写（和 Claude Code 的计划文件一样），读也允许。这经由 Agent 策略上新的 `openDirs`（`decideAction`）：路径在开放文件夹里（以及它的链接指向的地方，只要存在）就不算凭据；命令只有在不可能走出这个文件夹时才可以点名它（没有 `cd`、没有 `..`、没有 `$(…)`、反引号或别的变量；写在那里的每条路径都顺着链接检查），见 `engine/agent/credentials.ts` 的 `withoutOpenDirs`。 / `agy acp` takes no settings and your agy settings may let it do anything, so the app cannot make it ask first. What it does ask about (`session/request_permission`) is answered by the app's rules (`decideAction`, the project directory as the workspace): `allow_once` / `reject_once`, a card under ask first. Every call it makes without asking is checked as it reports it under way; one the permission mode would not let through (under ask first, any change or command; under read-only, any change or command) stops the turn with `session/cancel` and a line saying what it did, and that step may have run already. The new-session sheet says so when Antigravity is picked (`asksAfter`). Credentials stay off limits, except agy's own folder for the session (`~/.gemini/antigravity-cli/brain/<session>`), where it writes its plans and notes: writing there is allowed in every mode, as Claude Code's plan file is, and reading it too. This goes through a new `openDirs` on the agent policy (`decideAction`): a path in an open folder (and, as far as it exists, where its links lead) is no credential; a command may name one only where it cannot leave it (no `cd`, no `..`, no `$(…)`, backquotes or other variables; every path named there checked through its links); see `withoutOpenDirs` in `engine/agent/credentials.ts`.

4. **接着终端里的 agy 会话 / Carrying on a terminal agy session.** 经 `GET /v1/runtime/agents/antigravity/sessions` 列出，来自 agy 的 `session/list`，去掉应用自己的，按应用知道的去（会话本身没有来源字段）：应用持有的会话（每个项目会话自己的和已经接过的）、标题以 Bot 人设开头的（`# 人设`、`# Profile`）、在工作区或临时文件夹下 `deskfolk-call-*` 文件夹里的——这是个启发式；你自己在工作区文件夹里开的 agy 会话也因此被藏起来。读用 `session/load`：你的话和它的回答按顺序（agy 不给时间，所以每句相隔一毫秒，最后一句落在会话最后更新的时间），工具调用只数不导入。agy 不能给会话开分支，所以项目会话就在同一个会话里继续（`project_agent_session` 从一开始就是终端里那个 id）：说明里这样写「接着的是终端里同一个 Antigravity 会话：这里说的话在终端里也看得到，别在两边同时说。」；接过一次的会话不能再接（409）。导入面板和第一次启动向导像列 Claude Code 和 Codex 的那样列 agy 的会话。 / Listed through `GET /v1/runtime/agents/antigravity/sessions` from agy's `session/list`, without the app's own, by what the app knows (a session has no source field): sessions the app holds (every project session's own and those already carried on), titles starting with a Bot's profile (`# 人设`, `# Profile`), sessions in the workspace or in a `deskfolk-call-*` folder under the temporary folder; a heuristic, so your own agy session in the workspace folder is hidden too. Read with `session/load`: your lines and its answers in order (agy gives no times, so each line is a millisecond apart, ending at the session's last update), tool calls counted, not imported. agy cannot branch a session, so the project session goes on in that same session (`project_agent_session` is the terminal's id from the start): the note says so, "接着的是终端里同一个 Antigravity 会话：这里说的话在终端里也看得到，别在两边同时说。" (what you say here shows in the terminal too, so do not talk on both sides at once); and a session carried on once cannot be carried on again (409). The import sheet and the first-launch wizard list agy's sessions as they do Claude Code's and Codex's.

5. **你的话 / Your line.** 图片作为 image 块发出（像 Bot 那样先缩小），别的文件写成「附件：」加路径，批注写全。ACP 没有 steer，所以提示词进行中发的话跟下一个提示词走（两个提示词之间的几句一起走）。`/` 开头的话原样发出，由 agy 执行（它的 `/compact`）；没话回的写一行「已执行 /compact：Antigravity 把之前的对话压成了摘要」；`/` 列表是 agy 上一轮在这个目录里给的（`available_commands_update`，记 10 分钟），第一轮之前是空的。 / Pictures go as image blocks (shrunk as a Bot's are), other files as "附件：" ("Attached:") with their path, annotations spelled out. ACP has no steer, so a line sent during a prompt goes with the next prompt (lines between prompts go together). A `/` command is sent as you wrote it and agy runs it (its `/compact`); one that answers nothing leaves "已执行 /compact：Antigravity 把之前的对话压成了摘要" (Ran /compact: Antigravity condensed the earlier conversation into a summary); the `/` list is what agy offered the last run in that directory (`available_commands_update`, kept 10 minutes), empty before the first run.

6. **回复、失败和 Stop / Reply, failure and Stop.** 它说的话就是回复；回复只有「⚠」几行时是 agy 自己的失败（`agyFailure`），写成「Antigravity 出错停下了：…」加它最后一行。Stop 发 `session/cancel`，再结束进程；它已经说的话留成它的一行。花费：token 取自每个提示词的 usage，供应商记「Antigravity」（暂时没有价格，后面的提交会补估算）。 / Its words are the reply; a reply of only "⚠" lines is agy's own failure (`agyFailure`), shown as "Antigravity 出错停下了：…" (Antigravity stopped with an error) with its last line. Stop sends `session/cancel` and then ends the process; what it had said stays as its line. Spend: tokens from each prompt's usage, provider "Antigravity" (no price yet; a later commit adds an estimate).

7. **计划模式 / Plan mode.** 输入框的计划开关和 Shift+Tab 对 Antigravity 也有；计划模式下，agy 自己文件夹以外的改动被拒绝（这一轮停下）。计划轮结束时写出了供审阅的计划（`RequestFeedback`），就成一张计划卡（和 Claude Code 的同一张）：批准就为这个会话关掉计划模式，并发「计划已批准，现在按计划去做。」（"The plan is approved. Carry it out now."）；不批准就继续计划；它等着时你发的话就是要改的地方。 / The composer's Plan switch and Shift+Tab work for Antigravity; in plan mode a change outside agy's own folder is refused (the turn stops), and when a plan turn ends with a plan written for review (`RequestFeedback`), it is a plan card (the same card as Claude Code's): approving turns plan mode off for the session and sends "计划已批准，现在按计划去做。" ("The plan is approved. Carry it out now."); not approving keeps planning; a line sent while it waits is what to change.

8. **后台命令 / Background commands.** 提示词结束时仍在进行的命令成为这个运行上的一个任务（`AgentTask`，种类 shell），运行保持打开、读作空闲；agy 报告它结束就完成这个任务，输出存在临时文件夹下的一个文件里供任务列表看；agy 之后自己说的话，等它安静一会儿再一起发出；然后运行关闭。Stop 全部结束；单独停一条做不到，所以输入框只给 Stop。 / A command still under way when a prompt ends is a task (`AgentTask`, kind shell) on the run, which stays open and reads idle; its end (reported by agy) completes the task, its output kept in a file under the temporary folder for the tasks list; what agy says by itself afterwards is posted once it has been quiet for a moment; then the run closes. Stop ends them all; one cannot be stopped alone, so the composer offers only Stop.

9. **文案 / Copy.** 原来在计划模式里写 Claude Code 的几句现在写这个会话的 Agent（`planOffHint`、`planOnHint`、`composerPlaceholderPlan`、`planEmpty`、`waitingPlan` 成了 Agent 名字的函数）；计划卡写 Agent 的名字；任务地图只在 Claude Code 会话里标出 Claude Code 自己的文件夹。 / Lines that named Claude Code in plan mode now name the session's agent (`planOffHint`, `planOnHint`, `composerPlaceholderPlan`, `planEmpty` and `waitingPlan` are functions of the agent's name); the plan card names the agent; the task map labels Claude Code's own folder only for Claude Code sessions.

## 取舍 / Trade-offs

- **先问下它可能已经动手了 / Ask first may come after the fact.** 应用管不住 agy 不问就做的事，只能在它报告时停下这一轮；那一行可能已经写出去了、那条命令可能已经跑了。新开面板写明这一点。要真正先问，得 agy 的 ACP 接受权限设置。 / The app cannot hold back what agy does without asking; it can only stop the turn when agy reports it, and the line may be written or the command run already. The new-session sheet says so. A real ask-first needs agy's ACP to take permission settings.
- **两边不能同时说 / Not both sides at once.** 接着终端会话没有分支，在这里说的话终端里也看得到；同一会话也不能再接第二次（409）。 / Carrying on has no branch: what you say here shows in the terminal too, and the session cannot be carried on a second time (409).
- **列表靠启发式 / The list is a heuristic.** agy 的会话没有来源，应用自己的会话按标题和目录猜着去掉；你自己在工作区文件夹里的 agy 会话会被误藏。 / agy's sessions carry no source, so the app's own are removed by title and folder; your own agy session in the workspace folder is hidden by mistake.
- **没有时间 / No times.** 导入的历史没有真实时间，每句相隔一毫秒，只保证顺序和最后更新的时间。 / Imported history has no real times; each line is a millisecond apart, which keeps the order and the last update's time only.
- **单条后台命令停不了 / One background command cannot be stopped alone.** 只能 Stop 全部。 / Only Stop, which ends them all.
- **每一轮一个进程 / A process per run.** 和另外两个一样，接会话要一两秒。 / As for the other two, resuming takes a second or two.

## 以后 / Later

这一串提交里的其他几项，你说「要做就一起都做了」，所以都要做 / The rest of this series of commits, since you asked for all of it:

- **Codex 的账号和额度用完的切换 / Codex accounts and out-of-usage switching.**
- **Codex 的计划模式（2026-11-17 已做，见 [ADR 0099](0099-codex-in-project-sessions.md) 最后一条补记） / Codex plan mode (done 2026-11-17, see the last addendum of [ADR 0099](0099-codex-in-project-sessions.md)).**
- **Codex 的子代理和后台命令（同上） / Codex subagents and background commands (same).**
- **Codex 和 agy 的任务地图回放（2026-11-17 已做，见文末补记） / The task-map replay for Codex and agy (done 2026-11-17, see the addendum at the end).**
- **Codex 和 agy 花费的价格估算（2026-11-17 已做，见文末补记） / A price estimate for Codex and agy spend (done 2026-11-17, see the addendum at the end).**
- **打开 Codex 的记忆和 skill 文件夹（2026-11-17 已做，见 [ADR 0099](0099-codex-in-project-sessions.md) 最后一条补记） / Codex's memory and skills folders opened (done 2026-11-17, see the last addendum of [ADR 0099](0099-codex-in-project-sessions.md)).**

不做 / Not doing: **agy 的账号 / agy accounts**（应用没有 agy 的账号；agy 把会话存在自己的数据文件夹里，ACP 搬不动）和 **Bot 的 Codex、agy 回合的花费估算 / estimates for Bots' Codex and agy turns**（会改变 Bot 每日上限的行为）。你要的话再说。 / (the app has no agy accounts; agy keeps a session in its own data folder and ACP cannot move one; and estimates would change Bots' daily cap behaviour). Say so if you want either.

## 实现 / Implementation

守护进程：`project-runner-agy.ts`（runner、`agyActionOf`、`agyBrainDir`、`createAgyCommandMemory`）、`agents/agy-acp.ts`（启动、initialize、问问题用的短命服务）、`agents/agy-sessions.ts`（列、`isAppsOwn`、读、`agyImported`）、`agents/agent-sessions.ts`（agy 的分支）、`project-runners.ts`、`engine/agent/policy.ts` 和 `engine/agent/credentials.ts`（`openDirs`、`withoutOpenDirs`）、`engine/agent/drivers/acp.ts` 和 `agy.ts`（导出了几个辅助函数）、`local-api/routes/project-sessions.ts`（命令、导入继续）、`store/project-sessions.ts`（那条说明）、`fixtures/agents/fake-agy.ts`；测试在 `project-sessions-agy.test.ts` 和 `engine/agent/policy.test.ts`。协议：`PROJECT_AGENTS`、`PROJECT_AGENT_CAPS`。界面：`copy/project.ts`（`agentNames`、`dirHints`、`asksAfter`、计划模式的几句）、`ProjectDirPicker`（那条提示）、`ProjectChat` 和 NSH 的 `project-chat-*`（计划模式的几句；`stopsTask` 为否时只给 Stop）、`ProjectPlanCard`、`TaskMap`。

Daemon: `project-runner-agy.ts` (the runner, `agyActionOf`, `agyBrainDir`, `createAgyCommandMemory`), `agents/agy-acp.ts` (start, initialize, a short-lived server for questions), `agents/agy-sessions.ts` (list, `isAppsOwn`, load, `agyImported`), `agents/agent-sessions.ts` (agy's branch), `project-runners.ts`, `engine/agent/policy.ts` and `engine/agent/credentials.ts` (`openDirs`, `withoutOpenDirs`), `engine/agent/drivers/acp.ts` and `agy.ts` (helpers exported), `local-api/routes/project-sessions.ts` (commands, import continues), `store/project-sessions.ts` (the note), `fixtures/agents/fake-agy.ts`; tests in `project-sessions-agy.test.ts` and `engine/agent/policy.test.ts`. Protocol: `PROJECT_AGENTS`, `PROJECT_AGENT_CAPS`. Windows: `copy/project.ts` (`agentNames`, `dirHints`, `asksAfter`, the plan-mode lines), `ProjectDirPicker` (the hint), `ProjectChat` and NSH `project-chat-*` (the plan-mode lines; Stop only when `stopsTask` is false), `ProjectPlanCard`, `TaskMap`.

## 2026-11-17 补 / Addendum（任务地图回放）

「以后」里的任务地图回放做完了，Codex 和 agy 都有；`PROJECT_AGENT_CAPS` 里两者的 `replay` 为真。回放照旧是 `GET /v1/project-sessions/:id/replay`，但这两个 Agent 的会话不读它们的文件，而是问它们自己：Codex 经 app-server 的 `thread/read`（会话的线程，再加每个 `spawnAgent` 调用开出的子代理线程），agy 经 `session/load`。问不到（没装、没登录、超时、会话没了）就回空回放，不回错误。

**Codex。** 每个命令、文件改动、MCP 调用、动态工具、网页搜索、看图各算一次调用，命名和落点和实时的工具帧一样（`shell`、`write_file`、`mcp__服务__工具`、`WebSearch`，落点由 `placeOfCall` 定）。Codex 只给每一项的耗时，不给起点：一轮里第一项从这一轮的开始算起，后面每一项接在前一项结束处，不越过这一轮的结束；进行中的一轮读到哪算哪。`ok` 是状态为 completed 且退出码为空或 0。你说的话落在它那一轮的开始。子代理按线程各记一行（描述取派活那句的第一行，类型取线程的昵称），它们的调用带着线程号。Codex 不记录权限决定，所以 `decision` 一律为空。

**agy。** agy 不给任何时间。应用自己记着这个会话里你说的每一句和每条回复的时间，所以：agy 重放里每一句你的话之后的调用算一组，按文字（去掉首尾空白，一方包含另一方也算）对应到应用里你的某一句，不按数量对；对上的一组，调用在你那句的时间和它之后第一条回复的时间之间均匀排开（没有回复就按一分钟）；对不上的几组放在前后两个对上的之间（前面没有对上的，就放在第一组前一分钟里均匀排开）。前台命令的输出里 agy 写着「Created At / Completed At」，有就直接用，起止时间和耗时都照它的。agy 不记权限决定，`decision` 为空；也不记用的模型，`model` 为空。所以 agy 的时间是推算的，只对得上顺序和大致的位置，不是真的时刻。

实现：`agents/codex-replay.ts`（`codexReplayOf` 纯映射、`readCodexReplay`）、`agents/agy-replay.ts`（`agyReplayOf` 纯映射、`readAgyReplay`）、`local-api/routes/project-sessions.ts`（回放那一支）；测试在 `project-sessions-replay.test.ts`。

The task-map replay under Later is done, for Codex and for agy; `replay` is true for both in `PROJECT_AGENT_CAPS`. The replay is still `GET /v1/project-sessions/:id/replay`, but a session of these agents is not read from their files: they are asked. Codex through the app-server's `thread/read` (the session's thread, plus the subagent threads its `spawnAgent` calls started), agy through `session/load`. When they cannot be asked (not installed, signed out, a timeout, the session gone) the replay is empty, not an error.

**Codex.** Each command, file change, MCP call, dynamic tool, web search and image view is one call, named and placed as the live tool frames are (`shell`, `write_file`, `mcp__server__tool`, `WebSearch`; the place by `placeOfCall`). Codex gives each item's duration but not its start: the first item of a turn starts at the turn's start, each later one where the one before ended, never past the turn's end; a turn still going is read as far as it goes. `ok` means status completed and an exit code of none or 0. What you said lands at the start of its turn. Each subagent is a row of its own per thread (the description the first line of the prompt that sent it, the type the thread's nickname), and its calls carry the thread id. Codex records no permission decisions, so `decision` is always null.

**agy.** agy gives no times at all. The app keeps the time of every line you said and every reply in the session, so: the calls after each line of yours in agy's replay form a group, matched to one of your lines in the app by its words (trimmed; one holding the other counts), not by count; a matched group's calls are spread evenly between your line's time and the first reply after it (a minute when there is none); groups that match nothing go between the matched ones around them (or, with none before, evenly in the minute before the first group). A foreground command's output has the "Created At / Completed At" lines agy writes; when present they are used as they are, for the start and the duration. agy records no permission decisions, so `decision` is null, nor the model, so `model` is null. So agy's times are worked out: right in order and roughly in place, not the real moments.

Implementation: `agents/codex-replay.ts` (`codexReplayOf`, the pure mapping, and `readCodexReplay`), `agents/agy-replay.ts` (`agyReplayOf`, the pure mapping, and `readAgyReplay`), `local-api/routes/project-sessions.ts` (the replay branch); tests in `project-sessions-replay.test.ts`.

2026-11-17 补 / Addendum（价格估算）：agy 项目会话的花费也按价格估算了，用的是 [ADR 0099](0099-codex-in-project-sessions.md) 最后一条补记里说的那张内置价目表（`agents/agent-prices.ts`）：agy 的 `gemini-3.8-flash-high`、`-medium`、`-low` 都按 gemini-3.8-flash 算，agy 用 Claude 模型时（含 `-thinking`）按 Anthropic 的价。花费行带 `estimated_cost_usd_ticks`，计入每日上限；不在表里的模型照旧只记 token。Google 把 gemini-3.8-flash 的这个价列到 2026-12-31，2027-01-01 起翻倍，到时要更新表。Spend of an agy project session is now estimated at a price too, by the built-in table named in the last addendum of [ADR 0099](0099-codex-in-project-sessions.md) (`agents/agent-prices.ts`): agy's `gemini-3.8-flash-high`, `-medium` and `-low` all count as gemini-3.8-flash, and an agy run on a Claude model (`-thinking` included) at Anthropic's price. The spend rows carry `estimated_cost_usd_ticks` and count toward the daily cap; a model not in the table still records tokens only. Google lists this rate for gemini-3.8-flash through 2026-12-31 and doubles it on 2027-01-01, when the table needs an update.

2026-11-17 补 / Addendum（问题卡）：握手时应用现在说能填表（`clientCapabilities.elicitation.form`），agy 的 `ask_question` 于是以 `elicitation/create` 发来，每个问题是对话里的一张问题卡，答完它才接着做；Bot 的 agy 照旧不说，仍用 `ask_user`。细节见 [ADR 0095 的 2026-11-17 补记](0095-project-sessions.md)。 / The app now says at the handshake that it fills in forms (`clientCapabilities.elicitation.form`), so agy's `ask_question` arrives as `elicitation/create`, each question a card in the conversation that agy waits on; Bots' agy still does not say so and asks with `ask_user`. Details in [ADR 0095's 2026-11-17 addendum](0095-project-sessions.md).

## 补记 2026-11-23：应用的 consult 工具 / Addendum 2026-11-23: the app's consult tool

决定 2 的「不加 MCP 服务器」不再全对：你的项目会话里，agy 每一轮在 `session/new`、`session/resume` 和 `session/load` 都挂上应用的一个 stdio MCP 服务器（守护进程的 `--agent-mcp`），里面只有 `consult`（[ADR 0116](0116-consultants-in-project-sessions.md)）。实测 1.5.14 三处都挂得上，调用报成 `Run mcp_deskfolk_consult`（kind `other`），应用按标题放行，不当成命令或读文件；agy 把任何 MCP 调用到 3 分钟就掐掉，所以一次请教最多等 150 秒。被请来当参谋的 agy 不挂任何服务器，调 MCP 就停下这一轮。

Decision 2's "no MCP server added" no longer holds whole: in a session of yours, agy gets one stdio MCP server of the app's (the daemon's `--agent-mcp`) on `session/new`, `session/resume` and `session/load`, with only `consult` in it ([ADR 0116](0116-consultants-in-project-sessions.md)). Measured on 1.5.14, all three mount it; a call is reported as `Run mcp_deskfolk_consult` (kind `other`), which the app lets through by title, never taking it for a command or a read; agy cuts any MCP call at 3 minutes, so one consultation call waits 150 seconds at most. An agy asked in as a consultant gets no server, and an MCP call stops its turn.

## 补记 2026-11-23：命令里点名它自己的文件夹 / Addendum 2026-11-23: a command naming its own folder

决定 3 说命令只有在没有 `cd`、`..`、`$(…)`、反引号和别的变量时才能点名开放文件夹，这几条原来是对整条命令说的。实际用起来，agy 一条命令先 `cd` 进项目的工作树、`COMMIT=$(git rev-parse …)` 打包，最后用 `python3 -c` 把一个部署脚本写进 `brain/<会话>/scratch/`；`cd` 和 `$(…)` 都和那个文件夹无关，整条却被当成碰了凭据，这一轮被停下（auto 模式下）。现在 `..` 仍然看整条命令；其余几条只看点名文件夹的地方：点名它的那一段（`&&`、`||`、`;`、`|`、`&`、换行之间）不能换目录；点名它的那个 shell 词（按引号切分，`"<文件夹>/$X"` 是一个词）里不能有 `$…`（`$HOME` 除外）或反引号，所以 `ssh host "V=$V bash -s" < <文件夹>/x` 可以，`<文件夹>/"$(…)"` 不行；文件夹也不能被交出去再拼，比如赋给变量（`D=<文件夹>`）、放进 `for … in` 的列表，或放在 `$(…)`、反引号里面。点名的每条路径照旧顺着链接检查。这对每个用 `openDirs` 的 Agent 都一样（Codex 的记忆和 skill、Grok 的会话文件夹）。这条检查本来只防明着点名凭据，挡不住一段脚本自己去拼路径，所以收窄它不比原来更松多少。停下这一轮的那一行也改了：原因用你的语言说（碰了凭据、权限模式是只读、要先问），不再是写给 Agent 的英文；超过 120 字或有换行的命令放在句子下面另起几行，整条保留，因为工具调用不落库，这一行是它做过什么的唯一记录。项目会话的界面把有换行或超过 160 字的应用行画成横跨对话的一块，第一行是话，下面引的是代码（等宽字），短的照旧是居中的小条。

Decision 3 says a command may name an open folder only with no `cd`, no `..`, no `$(…)`, backquotes or other variables, and those were read over the whole command. In use, an agy command `cd`'d into the project's worktree, packed a build with `COMMIT=$(git rev-parse …)`, and at the end wrote a deploy script into `brain/<session>/scratch/` with `python3 -c`. The `cd` and the `$(…)` had nothing to do with that folder, yet the whole command was taken for touching credentials and the turn stopped (under auto). Now `..` is still read over the whole command; the rest only where the folder is named. The command of the list that names it (between `&&`, `||`, `;`, `|`, `&` and new lines) may not change directory; the shell word that names it (split as the shell splits, so `"<folder>/$X"` is one word) may not hold `$…` (but `$HOME`) or backquotes, so `ssh host "V=$V bash -s" < <folder>/x` passes and `<folder>/"$(…)"` does not; and the folder may not be handed on to be built on: as a variable's value (`D=<folder>`), in a `for … in` list, or inside `$(…)` or backquotes. Every path named there is still checked through its links. This holds for every agent with `openDirs` (Codex's memories and skills, Grok's session folder). The check only ever caught a credential named outright; a script building the path itself was never stopped by it, so narrowing it gives up little. The line the turn stops with changed too: the reason is in your language (a credential, a read-only mode, the mode asks first), not the English written for the agent, and a command over 120 characters or of several lines follows the sentence on lines of its own, whole, since tool calls are not stored and this line is the only record of what ran. The project session draws an app line with a line break or over 160 characters as a block across the conversation, its first line the words and what follows quoted as code (monospace); a short one is still the centred chip.

## 补记 2026-11-23：会话记录 / Addendum 2026-11-23: session records

决定 3 说凭据仍然碰不到、唯一的例外是 agy 自己的 brain 文件夹。现在还多了一处只读的：本机 Agent 的会话记录（Claude Code 的 `projects/`、Grok 的 `sessions/`），起因是 agy 读 Claude Code 的会话文件查上下文用量被停下了一轮。同一天晚上它的脚本把 `~/.claude` 交给 Python 自己拼路径，又被停下；之后规则判断不了位置的路径（交给程序自己展开的 Agent 文件夹、在记录上拼出来的路径）也按权限模式走，只要命令没写出登录或设置文件。细节见 [ADR 0095 的 2026-11-23 补记](0095-project-sessions.md)。

Decision 3 keeps credentials off limits with agy's own brain folder as the one exception. Your agents' session records (Claude Code's `projects/`, Grok's `sessions/`) are now open too, for reading only, after agy reading Claude Code's session files to check context usage had a turn stopped. That evening its script handed `~/.claude` to Python to build the paths on, and was stopped again; since then a path the rules cannot place (an agent's folder handed to a program that expands it, a path built on the records) goes by the permission mode too, unless the command names a sign-in or settings file. Details in [ADR 0095's 2026-11-23 addendum](0095-project-sessions.md).

## 补记 2026-11-23：额度用完，到点接着做 / Addendum 2026-11-23: out of usage, picking up at the reset

一轮因 agy 的失败结束时，应用问一次 agy 自己的 `/quota`；会话的模型那一组有窗口用完，就像 Codex、Grok 会话那样到点自己接着做，引用你还没得到回复的话。agy 没有账号可换（见「以后」的「不做」），所以只有到点这一半。细节见 [ADR 0110 补记第 6 条](0110-out-of-usage-another-account-or-the-reset.md)。实现：`project-runner-agy.ts`（`agyResetOf`、`outOfUsage`、`resumeAfterLimits`）、`agents/usage.ts`（`agyQuotaWindows`）；测试在 `project-sessions-agy.test.ts`。

When a run ends on agy's failure, the app asks agy's own `/quota` once; with a window of the session model's group used up, it picks up at the reset by itself, as Codex and Grok sessions do, quoting your lines it had not answered. agy has no accounts to move to (see Not doing under Later), so only that half applies. Details in [ADR 0110, item 6 of the addendum](0110-out-of-usage-another-account-or-the-reset.md). Implementation: `project-runner-agy.ts` (`agyResetOf`, `outOfUsage`, `resumeAfterLimits`), `agents/usage.ts` (`agyQuotaWindows`); tests in `project-sessions-agy.test.ts`.

## 补记 2026-11-24：它自己的文件夹是它自己的，别家的按文件拦 / Addendum 2026-11-24: its own folder is its own, another agent's is judged file by file

2026-11-23 夜里（23:38）你在 real-bot 的 Antigravity 项目会话里说「用量里看不到 gemini 订阅的级别」「是 antigravity 的级别」。agy 第一步去读它自带的技能说明（`~/.gemini/antigravity-cli/builtin/skills/antigravity_guide/SKILL.md`），这一轮被停下，说本机 Agent 自己的设置和凭据碰不得。一天之内这是第五次。前四次（命令里点名 brain 文件夹，读 Claude Code 的会话记录三次）每次都是在「整个 Agent 文件夹默认关着」上再开一个口子，下一种碰法总会漏。你说要彻底解决，不要再出现。

先看了它实际怎么用这些文件夹，两份材料：

- 这台电脑上最近 79 个 agy 会话（终端里的也算）的 3066 步工具调用，按项目会话、自动模式过了一遍规则。171 步点名了某个 Agent 的文件夹；被拦的 7 步全是 agy 在用它自己的文件夹：读自带的技能和它的参考文件、列自己的目录、`cat` 自己的 `settings.json`、在 `builtin/` 里搜索。
- 把你那两句原话发给隔离运行时里的真 agy（见下面的验证）。第一版改法是「它自己的文件夹放开，登录文件还拦着」：它读完自带的技能、跑了 `agy --help` 和 `/quota`，下一步就是 `cat ~/.gemini/oauth_creds.json`，想从它自己的登录文件里找订阅级别，这一轮又停在同一句话上。所以它自己的登录文件也不能拦，否则你问的这个问题它就查不下去。

决定 3 的「凭据仍然碰不到」改成下面这样。只改 Antigravity：只有它是拦不住、只能事后停下这一轮的，停下也挡不住那一步；Codex、Grok 和 Claude Code 是动手前被拒、接着干，它们的规则不动。

1. **它自己的文件夹是它自己的，和在它终端里一样。** `~/.gemini`（agy 和 Gemini CLI 共用）里的东西，读直接读，改和命令按权限模式走，和项目外任何地方一样：自带的和你装的技能、`settings.json`、MCP 配置、别的会话的笔记、日志，登录文件（`oauth_creds.json`）也在内。这个会话自己的 brain 文件夹照旧每种模式下都能写。
2. **别家 Agent 的文件夹读得到，只有登录文件和设置文件碰不得，按文件名认。** 登录文件：`.credentials.json`、`auth.json`（`mcp-auth.json` 这样的也算）、`oauth_creds.json`、`.env`、`*token*.json`。设置文件：`settings*.json`、`config.toml`、`~/.claude.json` 和它的备份、`user-settings.json`、`google_accounts.json`、MCP 服务器的配置（`mcp_config.json`、`.mcp.json`，密钥就写在里面）、`hooks.json`、`opencode.json`。别的都读得到：技能、指令文件、会话记录、笔记、日志、文件夹本身。Grok 自带的技能（`bundled`）照旧整个读得到。钥匙串照旧谁的都不行。
3. **别家 Agent 的文件夹，文件工具写不进。** 什么模式都拒：那是在改别家怎么工作（它的技能、指令、记录）。命令分不出读写，照旧按权限模式走。
4. **命令怎样算点名了别家的这类文件。** 两种：
   - 命令写出的、落在别家文件夹里的路径，本身就是登录或设置文件：照写出来的算，把 `..` 化简之后算（从它自己的文件夹爬出去的，按落到哪算），顺着链接指到的也算；文件夹名带通配符的（`~/.claude*/settings.json`）也算。
   - 命令在别家的文件夹里面干活、或在它上面自己拼路径（`cd` 进去，放进变量、循环或 `$(…)`，当字符串交给程序），同时整条命令里写了这样的文件名。拼出来的路径看不到落在哪。这里认的文件名是昨天那张表（`namesAgentSettingsFile`），不含 `hooks.json`、`.mcp.json` 这几个项目里也常有的名字。

   只是一条完整的路径不算拼（`ls ~/.claude/skills`、`rg x ~/.claude/skills apps/x/config.json`），命令别处出现的文件名是别的文件。在它自己的文件夹里怎么拼都不算。Windows 上不读引号：点名了别家的文件夹，又写了这类文件名，就算。
5. **文件工具和命令用同一个判断**（`isAgentSecretPath`）。这次被停的是文件工具那一支，前四次修的都是命令那一支。

仍然停下这一轮的：读或写别家 Agent 的登录文件、设置文件；用文件工具往别家的文件夹里写；向钥匙串要密钥；权限模式本来就要先问或不许的（改动先问、只读）。那一行里的「本机 Agent 自己的设置和凭据碰不得」现在说的是别家的登录和设置。

取舍：
- agy 读得到它自己的登录文件和设置，里面的令牌和密钥模型也就看得到，和你在它终端里让它看一样。应用原来也挡不住：它不先问，那一步在停下之前就执行了。它的回复落在应用的库里，它要是把令牌贴进回复，就留在对话里。
- 规则只认写出来的名字。`grep -r token ~/.codex`、`cat ~/.codex/*.json`、`find ~/.codex -name auth.json`、`cd ~/.gemini && cat ../.codex/auth.json` 这样不写全路径的读法拦不住，把整个文件夹拷走（`cp -R ~/.codex /tmp/x`）也拦不住，和 `Path.home() / ".codex"` 一样，原来也拦不住。对 agy 拦下来本来就挡不住那一步，所以这里宁可少拦错。
- 文件名表有猜的成分：ZCode 的登录文件叫什么没查过，靠通用的名字兜着。
- Bot 不变。Codex、Grok、Claude Code 的项目会话不变，它们用的文件名表也是原来那张（`namesAgentSettingsFile`）；要不要也改成这样，等你说。

验证：
- 语料那 3066 步：旧规则拦 7 步，新规则拦 0 步。昨天被停的三条命令和它们的十种变体，按新规则也都放行。
- 隔离运行时（工作树的代码，自己的端口和数据目录）里的真 agy，自动模式：让它读自带的技能、列自己的目录、看自己 `settings.json` 的键，22 秒正常结束；同一句话在旧代码上被拦，那一行和你截图里的一样。
- 你那两句原话（后面加了一句只调查、不改文件、不动进程），在一份单独检出的仓库里，模型 `gemini-3.8-flash-low`：31 步，其中列了 `~/.gemini` 和 `antigravity-cli`、看了自己的 `settings.json` 和 `oauth_creds.json`、跑了两次 `agy -p "/quota"`，160 秒答完，没有被停。你平时用的默认模型没有跑，省着它的额度。

实现：`engine/agent/credentials.ts`（`isAgentSecretPath`、`namesAgentSecret`、`agentFolderMentions` 和文件名表；`homeSpellings`、`dirSpellings` 是先单独抽出来的）、`engine/agent/policy.ts`（`ActionContext.ownAgentDirs`）、`project-runner-agy.ts`（`agyHomeDir`）；测试在 `engine/agent/policy.test.ts`、`engine/agent/credentials.test.ts` 和 `project-sessions-agy.test.ts`。

Late on 2026-11-23 (23:38), in an Antigravity project session on real-bot, you said the usage did not show the Gemini plan's tier, then that you meant Antigravity's. agy's first step was to read the guide it ships with (`~/.gemini/antigravity-cli/builtin/skills/antigravity_guide/SKILL.md`), and the turn was stopped: your agents' own settings and credentials are off limits. That was the fifth time in one day. Each of the four before (a command naming its brain folder, Claude Code's session records three times) opened one more gap in "an agent's whole folder is shut", and the next way of touching it was always missed. You asked for it to be solved for good.

First, how it uses these folders in practice, from two sources:

- The 3066 tool calls of the 79 most recent agy sessions on this computer (its terminal sessions too), run through the rules as a project session in auto mode. 171 named an agent's folder. The 7 that were stopped were all agy using its own folder: reading the skill it ships with and that skill's reference files, listing its own directory, a `cat` of its own `settings.json`, a search in `builtin/`.
- Your own two lines, sent to a real agy in an isolated runtime (see Checked below). The first version of the change opened its own folder and kept its sign-in files shut: it read the skill it ships with, ran `agy --help` and `/quota`, and its next step was `cat ~/.gemini/oauth_creds.json`, looking for the tier in its own sign-in file. The turn stopped on the same line again. So its own sign-in file cannot be shut either, or it cannot follow the very question you asked.

Decision 3's "credentials stay off limits" now reads as below. For Antigravity only: it is the one agent that cannot be held back, only stopped after the fact, and the stop does not undo the step. Codex, Grok and Claude Code are refused before they act and carry on; their rules are as they were.

1. **Its own folder is its own, as in its terminal.** What is in `~/.gemini` (shared by agy and Gemini CLI) is read freely, and changed or named in commands by the permission mode, as anywhere outside the project: the skills it ships with and yours, `settings.json`, its MCP config, other sessions' notes, logs, and the sign-in file too (`oauth_creds.json`). The session's own brain folder can still be written in every mode.
2. **Another agent's folder can be read; only its sign-in and settings files are off limits, known by name.** Sign-in: `.credentials.json`, `auth.json` (`mcp-auth.json` and the like too), `oauth_creds.json`, `.env`, `*token*.json`. Settings: `settings*.json`, `config.toml`, `~/.claude.json` and its backups, `user-settings.json`, `google_accounts.json`, the MCP servers' config (`mcp_config.json`, `.mcp.json`: their keys sit in it), `hooks.json`, `opencode.json`. Everything else is read: skills, instruction files, session records, notes, logs, the folder itself. The skills Grok ships with (`bundled`) are read whole, as before. The keychains stay shut, whoever's secret it is.
3. **Another agent's folder is not written with a file tool.** Refused in every mode: that changes how the other one works (its skills, instructions, records). A command cannot be told apart as a read or a write, so it goes by the permission mode as before.
4. **When a command names such a file of another agent's.** Two ways:
   - A path it writes into another agent's folder is a sign-in or settings file: as written, with `..` resolved (one that climbs out of its own folder is judged where it lands), or where its links lead; so is one through a glob on the folder's name (`~/.claude*/settings.json`).
   - It works from inside another agent's folder or builds its own paths on one (a `cd` there, the folder in a variable, a loop or a `$(…)`, or handed as a string to a program), and writes such a file's name anywhere. What a built path reaches cannot be read off it. The names read here are yesterday's list (`namesAgentSettingsFile`), without `hooks.json`, `.mcp.json` and the few others a project often has too.

   A whole path by itself builds nothing (`ls ~/.claude/skills`, `rg x ~/.claude/skills apps/x/config.json`), and a name elsewhere in the command is some other file's. Nothing built in its own folder counts. On Windows the quoting is not read: another agent's folder named, and such a name written, counts.
5. **File tools and commands share one check** (`isAgentSecretPath`). This stop came from the file-tool side; the four fixes before were all on the command side.

What still stops the turn: reading or writing another agent's sign-in or settings file; writing into another agent's folder with a file tool; asking the keychain for a secret; and what the permission mode asks about or refuses anyway (ask first, read-only). The line's "your agents' own settings and credentials are off limits" is now about the other agents' sign-in and settings.

Trade-offs:
- agy reads its own sign-in file and settings, so the model sees the tokens and keys in them, as when you ask it to look in its terminal. The app never held that back: agy does not ask first, and the step had run before the stop. Its replies are kept in the app's database, so a token it pastes into a reply stays in the conversation.
- The rules know a name only where it is written. `grep -r token ~/.codex`, `cat ~/.codex/*.json`, `find ~/.codex -name auth.json` and `cd ~/.gemini && cat ../.codex/auth.json` are not stopped, nor is a copy of the whole folder (`cp -R ~/.codex /tmp/x`), as `Path.home() / ".codex"` never was. A stop never held agy's step back anyway, so here a missed stop is preferred to a wrong one.
- The name lists are part guess: ZCode's sign-in file was never looked up, and only the common names cover it.
- Bots are unchanged. Codex, Grok and Claude Code project sessions are unchanged, on the same name list as before (`namesAgentSettingsFile`); whether they should go this way too is yours to say.

Checked:
- The 3066 calls: the old rules stop 7, the new ones 0. Yesterday's three stopped commands and ten variants of them pass the new rules too.
- A real agy in an isolated runtime (the worktree's code, its own port and data folder), auto mode: told to read the skill it ships with, list its own directory and name the keys of its own `settings.json`, the run ended by itself in 22 seconds; the same request on the old code was stopped, with the line in your screenshot.
- Your own two lines (with a third asking it only to look, to change no file and touch no process), in a separate checkout of the repository, on `gemini-3.8-flash-low`: 31 calls, among them a listing of `~/.gemini` and `antigravity-cli`, its own `settings.json` and `oauth_creds.json`, and `agy -p "/quota"` twice; it answered in 160 seconds without a stop. The default model you usually run was not used, to spare its quota.

Implementation: `engine/agent/credentials.ts` (`isAgentSecretPath`, `namesAgentSecret`, `agentFolderMentions` and the name lists; `homeSpellings` and `dirSpellings` were pulled out first, by themselves), `engine/agent/policy.ts` (`ActionContext.ownAgentDirs`), `project-runner-agy.ts` (`agyHomeDir`); tests in `engine/agent/policy.test.ts`, `engine/agent/credentials.test.ts` and `project-sessions-agy.test.ts`.

## 补记 2026-11-24（同日）：Bot 也按这条走 / Addendum 2026-11-24 (same day): Bots go by it too

上一条补记的取舍里写着「Bot 不变」。当天跑在 Antigravity 上的 Bot 做长任务，一轮被停了两次，停在 agy `cat` 它自己笔记文件夹里的后台任务日志上（`brain/<会话>/.system_generated/tasks/task-N.log`）。Antigravity 的 Bot 现在也按上面这套规则判，只是没有「这个会话自己的 brain 文件夹每种模式下都能写」那一条；`agyHomeDir`、`agyBrainDir` 搬到了 `engine/agent/drivers/agy.ts`。细节见 [ADR 0079 的 2026-11-24 补记](0079-local-agents.md)。Codex、Grok、Claude Code 的项目会话和别的 Agent 的 Bot 仍然不变。

The addendum above lists "Bots are unchanged" among its trade-offs. That day a Bot run by Antigravity on a long job had a turn stopped twice, on agy's `cat` of a background task's log in its own notes (`brain/<session>/.system_generated/tasks/task-N.log`). A Bot on Antigravity now goes by the rules above too, without "the session's own brain folder can be written in every mode"; `agyHomeDir` and `agyBrainDir` moved to `engine/agent/drivers/agy.ts`. Details in [ADR 0079's addendum of 2026-11-24](0079-local-agents.md). Codex, Grok and Claude Code project sessions, and Bots on the other agents, are still unchanged.

## 补记 2026-11-26：钥匙串按项的名字认；做完的调用不为「怎么做」的提示而停 / Addendum 2026-11-26: the keychain is judged item by item; a call already made is not stopped over advice

2026-11-26 早上两个 Antigravity 项目会话各被停了一次，都写着「本机 Agent 自己的设置和凭据碰不得」：

- 08:32，另一个项目里。你给了它一个测试后台的账号和密码，说「你帮我搞就行，记下来这个账号」。agy 把密码存进了钥匙串（项名是它自己起的），随后用一条 `ADMIN_PASSWORD="$(security find-generic-password -w -s '<它存的那一项>' …)" python3 <它自己笔记里的脚本>` 读回来跑端到端测试，这一轮停在这一步。
- 08:37，real-bot 里。你把那一行发给它，说「不要出现这种情况，修复」。它第一步跑 `security find-generic-password -h` 看这个命令的帮助，又被同一句话停下。

库里核对过：11-24 的两条补记上线（运行时 11-25 05:47 重启）之后，agy 一共只被停过这两次。两次都不是 Agent 的文件夹，是钥匙串那一格：命令里出现 `security find-generic-password`、`find-internet-password`、`dump-keychain` 或 `export`，就算「向钥匙串要密钥」，不看要的是哪一项，`-h` 也算。11-24 的补记把这一格原样留下了（「钥匙串照旧谁的都不行」）。这和前五次是同一种错：按一个宽的表面特征拦（那时是整个文件夹，这次是命令的名字），不是按要护的东西拦。停下时那一行又是同一句话，所以每换一格，看上去都是上次没修好。

所以这次不只改这一格，把 agy 会被停下的每一格都过了一遍，也就是 `project-runner-agy.ts` 的 `decide` 和 `engine/agent/external-runner.ts` 的 `audit` 能给出的每一种不放行：

- 读写别家 Agent 的登录文件、设置文件，用文件工具往别家的文件夹里写：不变（11-24 的补记）。
- 向钥匙串要密钥：改，见 1。
- 权限模式本来就要先问或不许的（改动先问、只读）：不变，这是你设的。
- 计划模式下计划批准前的改动；参谋调用 MCP 工具；Bot 的事被停住时那一轮只读：不变，这是这些模式本来的意思。
- 命令会递归搜整个家目录或整块磁盘（[ADR 0040](0040-agent-kernel-the-job-owns-state.md) 的那道拒绝）：改，见 2。
- 文件路径的顶层目录不存在（多半是把工作区里的路径写成了 `/work/…`），Windows 上没有盘符的路径：改，见 2。
- 要求把命令放到后台跑的调用（输入里带 `is_background` / `run_in_background`）：不变，agy 碰不到这一格。Bot 的轮次不许后台任务（[ADR 0092](0092-permission-modes.md)）；agy 不这样报，它的命令是等久了自己转成后台任务，输入里没有这个标记，项目会话的规则也不看它。

1. **钥匙串按项的名字认。** 碰不得的是签入 Agent 的那几项和应用自己的密钥，按它们的服务名认：应用自己的 `com.real-bot.daemon`（`KEYCHAIN_SERVICE`）；Claude Code 的 `Claude Code-credentials`（账号目录的那几项，名字后面带一段哈希，[ADR 0061](0061-claude-agent-runner.md) 实测过）；Codex 把登录放进钥匙串时用的 `Codex Auth` 和 `Codex MCP Credentials`（它的源码里这样写）。一条命令向钥匙串要一项，并且整条命令里写了这些名字之一（写在要的那一项上，或者写在拼出这次请求的变量里），才算。要别的任何一项都不是谁的登录：你交给它记下的测试账号、项目的签名和公证配置，和别的命令一样按权限模式走；什么都不要的调用（`-h`）也一样。不去解析 `-s`、`-a` 这些参数，那又是在认写法。
   - 把钥匙串里的东西一起要出来的照旧不行，写没写名字都一样：`security dump-keychain`、`security export`；Linux 上是 `secret-tool search`、`kwallet-query` 和直接走 D-Bus 的 Secret Service、KWallet。Linux 上 `secret-tool lookup` 按名字认。
   - 钥匙串的文件本身（`~/Library/Keychains` 这些）照旧碰不得。
   - 停下时那一行有它自己的话：「钥匙串里 Agent 的登录和应用自己的密钥碰不得」，和文件那一格分开，看得出是哪一格。
2. **已经做了的调用，不为「怎么做」的提示而停。** 「别递归搜整个家目录」「这个路径哪儿都不是」是写给动手前被拒的 Agent 的：它听了换个做法接着干。对一步已经做完的调用，这句提示没有用，为它停下一轮也挡不住什么，那一行还会把一段写给 Agent 的英文当成原因摆给你。所以事后才检查的调用（`ActionContext.ran`）不看这几条，按权限模式走；凭据、权限模式、只读轮照旧停。agy 自己先来问的调用（`session/request_permission`）照旧按原规则答，这类拒绝在那里还是「不」。
   - 这一条不只是 agy 的。`external-runner.ts` 的 `audit` 对每个 Agent 都是事后检查（OpenCode、你自己接的 ACP Agent 没问就做了的调用），同样不看这几条；它们动手前来问的调用不变。

钥匙串这条只改 Antigravity（它的项目会话，和跑在它上面的 Bot）。Codex、Grok、Claude Code 的 Bot 和项目会话照旧：任何向钥匙串要密钥的命令都在动手前被拒，它们接着干。那里的拒绝是真挡得住的，改成按名字认就是把规则放宽，等你说。

取舍：
- agy 现在能用 `security` 读出钥匙串里不属于 Agent、也不属于应用的项。应用原来也挡不住这些读，只是事后停下这一轮。macOS 自己还有一道：一项不是 `security` 存进去的，`security` 去读时系统会弹窗问你（钥匙串项自己的访问控制，这次没有另测）；`security` 存进去的项不弹窗就读得到，agy 自己存的、你的脚本用 `security add-generic-password` 存的都在内。
- 名字表只收查实过的：应用自己的、Claude Code 的、Codex 的。Antigravity 自己的登录在它的文件夹里，那是它自己的。Grok、OpenCode、ZCode 的登录在文件里，按文件名认；它们要是另有钥匙串项，这张表认不出。
- 只认写出来的名字。不写服务名的要法（`security find-generic-password -a "$USER" -w`）、把名字拆开写、换一个程序去读钥匙串（Python 的 `keyring`），都拦不住；后两种原来也拦不住。和文件那一格一样，这是减速带，不是沙箱。
- 认的是命令的文字，不是它真的在做什么，所以只是提到这些字眼的命令一样会停：搜索的模式或 heredoc 里写着 `security dump-keychain`，或者一条命令里既有 `security find-generic-password` 又有表里的名字（比如在这个仓库里搜这条规则自己的测试）。停下时那一行会说是钥匙串这一格。
- 做完的全盘搜索不再停下这一轮，它要搜多久是 Agent 自己的事（agy 的命令等久了自己转后台）。应用记下的 Bot 命令里，按今天的规则算这种搜索的有 15 条（`find / -name ffmpeg` 之类），这台电脑上的 agy 会话里也有一条（`find ~ -maxdepth 4 -name '*codex*'`）。跑在 Antigravity 上的 Bot 或它的项目会话哪天再跑一条，按旧规则就是下一次被停。

验证：
- 库里存着的那两行，原样过规则，项目会话和 Bot 两种上下文，自动和全部允许：旧规则 4 次都拒，新规则 4 次都放。改动先问下是「要问」，那是权限模式的事。
- 这台电脑上读得出来的 230 个 agy 会话（终端里的、Bot 的也算，2026-08-31 到 2026-11-26）的 12595 步调用，按项目会话的事后检查过新旧两套规则：旧规则停 3 步：就是这两步，加上更早一个会话里一条搜整个家目录的 `find ~ -maxdepth 4 -name '*codex*'`（放在项目会话里，它就是下一次被停）；新规则停 0 步，没有只被新规则停下的。
- 应用记下的 27042 条 Bot 命令（跑在 Antigravity 上的轮次占 1076 条），按事后检查过新旧两套规则：新规则没有多停任何一条；旧规则会停的 15 条全盘搜索不再停。
- 真 agy 这次没有跑：真机核对花它的额度，这次还要往你的登录钥匙串里临时存、删一条测试项，照 `docs/development.md` 先问你。两个运行器的测试里，是 agy 的替身照原样报出这两条命令（`project-sessions-agy.test.ts`、`agent-runner-agy.test.ts`）。

实现：`keychains.ts`（`asksKeychainForAgentSecret` 和名字表）、`engine/agent/policy.ts`（`ActionContext.ran`；钥匙串单独判）、`engine/agent/credentials.ts`（`AGENT_KEYCHAIN_REFUSAL`；`namesAgentSecret` 不再管钥匙串）、`project-runner-agy.ts`（`decide(tool, ran)`、`stopReason`）、`engine/agent/external-runner.ts`（`audit`）；测试在 `keychains.test.ts`、`engine/agent/policy.test.ts`、`project-sessions-agy.test.ts` 和 `agent-runner-agy.test.ts`。

On the morning of 2026-11-26 two Antigravity project sessions were each stopped once, both with "your agents' own settings and credentials are off limits":

- 08:32, in another project. You gave it an account and password for a test back office and said to take care of it and keep the account. agy stored the password in the keychain (under an item name of its own choosing), then read it back to run an end-to-end test, with one `ADMIN_PASSWORD="$(security find-generic-password -w -s '<the item it stored>' …)" python3 <a script in its own notes>`. The turn stopped at that step.
- 08:37, in real-bot. You sent it that line and said this must not happen, fix it. Its first step was `security find-generic-password -h`, to read the command's help, and the same sentence stopped it again.

Checked against the database: since the two addenda of 11-24 went live (the runtime restarted on 11-25 at 05:47), these are the only two stops of agy. Neither was about an agent's folder. Both hit the keychain: a command with `security find-generic-password`, `find-internet-password`, `dump-keychain` or `export` in it counted as "asking the keychain for a secret", whichever item it asked for, `-h` included. The addendum of 11-24 had left that cell as it was ("the keychains stay shut, whoever's secret it is"). It is the mistake of the five stops before: a rule that goes by a broad surface feature (then a whole folder, now a command's name) and not by what it protects. And the line a stopped turn ends with was the same sentence again, so each new cell read as the last fix not having worked.

So this time every cell that can stop agy was gone through, not that one alone: every answer other than "allow" that `decide` in `project-runner-agy.ts` and `audit` in `engine/agent/external-runner.ts` can give.

- Reading or writing another agent's sign-in or settings file, writing into another agent's folder with a file tool: as they were (addendum of 11-24).
- Asking the keychain for a secret: changed, see 1.
- What the permission mode asks about or refuses anyway (ask first, read-only): as it was; that is your setting.
- A change before the plan is approved in plan mode; an MCP tool called by a consultant; a Bot's read-only turn of work that a stop holds: as they were; that is what those modes mean.
- A command that would search your whole home folder or the whole disk recursively (the refusal of [ADR 0040](0040-agent-kernel-the-job-owns-state.md)): changed, see 2.
- A file path whose top folder does not exist (most often a workspace path written as `/work/…`), and on Windows a path with no drive: changed, see 2.
- A call that asks to run its command in the background (`is_background` / `run_in_background` in its input): as it was, and agy cannot reach it. A Bot's turn runs nothing in the background ([ADR 0092](0092-permission-modes.md)); agy does not report one that way — a command that outlives its wait becomes a background task of agy's own, with no such mark in its input — and a project session's rules do not read the mark.

1. **The keychain is judged by the item's name.** Off limits are the items that sign an agent in and the app's own keys, known by their service names: the app's `com.real-bot.daemon` (`KEYCHAIN_SERVICE`); Claude Code's `Claude Code-credentials` (an account directory's item has a hash after the name, measured in [ADR 0061](0061-claude-agent-runner.md)); and `Codex Auth` and `Codex MCP Credentials`, which Codex uses where it keeps its sign-in in the keyring (as its source names them). A command counts only when it asks the keychain for an item and writes one of those names anywhere in it: as the item asked for, or in a variable the ask is built from. An ask for any other item is nobody's sign-in — a test account you gave it to keep, a project's signing or notarising profile — and goes by the permission mode as any command does; so does a call that asks for nothing (`-h`). The `-s` and `-a` arguments are not parsed: that would be telling spellings apart again.
   - Asking for all the keychain holds is refused as before, with or without a name: `security dump-keychain`, `security export`; on Linux `secret-tool search`, `kwallet-query`, and the Secret Service or KWallet over D-Bus. On Linux `secret-tool lookup` goes by the name.
   - The keychain's own files (`~/Library/Keychains` and the like) stay off limits.
   - The line a stopped turn ends with has words of its own here, "the keychain items that sign your agents in and hold this app's keys are off limits", apart from the files' sentence, so it shows which cell it was.
2. **A call already made is not stopped over advice on how to make it.** "Do not search your whole home folder recursively" and "this path is nowhere" are written for an agent refused before it acts: it takes the hint and carries on another way. To a call that has run the hint is of no use, stopping the turn over it holds nothing back, and the line would hand you a paragraph of English written for the agent as the reason. So a call checked only after the fact (`ActionContext.ran`) is not held to those, and goes by the permission mode; credentials, the permission mode and a read-only turn stop it as before. A call agy asks about first (`session/request_permission`) is answered by the rules as they were, and there such a refusal is still a no.
   - This one is not agy's alone. `audit` in `external-runner.ts` checks after the fact for every agent (a call OpenCode or an ACP agent of your own made without asking), and skips the same; what they ask about before acting is unchanged.

The keychain rule changes for Antigravity only (its project sessions, and Bots run by it). Bots and project sessions on Codex, Grok and Claude Code are as before: any command that asks the keychain for a secret is refused before it runs, and they carry on. There the refusal does hold the read back, so going by the name would loosen the rule; that is yours to say.

Trade-offs:
- agy can now read, with `security`, keychain items that are neither an agent's nor the app's. The app never held those reads back either; it only stopped the turn afterwards. macOS has a guard of its own: when `security` reads an item it did not store itself, the system asks you in a dialog (the item's own access control; not measured again this time). An item `security` did store is read without one, which covers what agy stored and what a script of yours stored with `security add-generic-password`.
- The name list holds only what was confirmed: the app's, Claude Code's, Codex's. Antigravity's own sign-in is in its folder, which is its own. Grok, OpenCode and ZCode keep their sign-in in files, known by file name; a keychain item of theirs, if there is one, is not on this list.
- Only a written name is known. An ask that names no service (`security find-generic-password -a "$USER" -w`), a name written in pieces, or another program reading the keychain (Python's `keyring`) are not stopped; the last two never were. As with the files, this is a speed bump, not a sandbox.
- The rule reads a command's text, not what it does, so a command that only mentions these words is stopped all the same: `security dump-keychain` in a search pattern or a heredoc, or `security find-generic-password` beside a listed name in one command (a search for this rule's own tests in this repository, say). The line then says it was the keychain.
- A search of the whole disk that has already started no longer stops the turn; how long it takes is the agent's own business (agy moves a command that outlives its wait to the background). 15 of the Bot commands on record count as such a search by today's rules (`find / -name ffmpeg` and the like), and so does one in the agy sessions on this computer (`find ~ -maxdepth 4 -name '*codex*'`). The day a Bot on Antigravity or a project session of it ran another, the old rules would have made it the next stop.

Checked:
- The two stored lines, as the database keeps them, through the rules as a project session and as a Bot, in auto and allow-all: refused all 4 times by the old rules, allowed all 4 times by the new. Under ask first the answer is "ask", which is the permission mode's.
- The 12595 calls of the 230 agy sessions on this computer that can be read (its terminal sessions and Bots' too, 2026-08-31 to 2026-11-26), through the old rules and the new as a project session's check after the fact: the old rules stop 3, these two and a `find ~ -maxdepth 4 -name '*codex*'` over the whole home folder from an earlier session (in a project session it would have been the next stop); the new rules stop 0, and nothing is stopped by the new rules alone.
- The 27042 Bot commands the app has on record (1076 of them from turns run by Antigravity), through the old rules and the new as a check after the fact: the new rules stop nothing the old ones let through, and the 15 whole-disk searches the old rules would stop no longer do.
- A real agy was not run this time: a live check spends its quota, and this one would also store and delete a throwaway item in your login keychain, so by `docs/development.md` you are asked first. In both runners' tests a stand-in agy reports the two commands as they were (`project-sessions-agy.test.ts`, `agent-runner-agy.test.ts`).

Implementation: `keychains.ts` (`asksKeychainForAgentSecret` and the name list), `engine/agent/policy.ts` (`ActionContext.ran`; the keychain judged apart), `engine/agent/credentials.ts` (`AGENT_KEYCHAIN_REFUSAL`; `namesAgentSecret` no longer covers the keychain), `project-runner-agy.ts` (`decide(tool, ran)`, `stopReason`), `engine/agent/external-runner.ts` (`audit`); tests in `keychains.test.ts`, `engine/agent/policy.test.ts`, `project-sessions-agy.test.ts` and `agent-runner-agy.test.ts`.
