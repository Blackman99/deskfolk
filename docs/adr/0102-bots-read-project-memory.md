# Claude Agent Bot 能读 Claude Code 的项目记忆 / A Claude Agent Bot can read Claude Code's project memory

Status: implemented 2026-10-30. Narrows the credentials refusal of [ADR 0061](0061-claude-agent-runner.md) for one folder. Builds on [ADR 0095](0095-project-sessions.md) decision 13, which opened a project session's memory of its own project and left Claude Agent Bots as they were.

2026-10-30 你问开发助手知不知道 trustin 的周报规则。它在项目目录里找不到，猜规则可能在那个项目的 Claude Code 记忆里，但整个 `~/.claude` 对 Bot 都算凭据，读不了。你选了「改规则」，先改了提示词 `agent.preface`；再读时发现拒绝来自 `decideAgentCall`，提示词管不到，你又选了「改 daemon 拦截，只开读」。

On 2026-10-30 you asked the dev assistant whether it knew trustin's weekly-report rules. The project folder had none; it guessed they might be in that project's Claude Code memory, but all of `~/.claude` counted as credentials to a Bot. You chose to change the rule, and the prompt `agent.preface` was edited first; the next read showed the refusal comes from `decideAgentCall`, which no prompt reaches, and you chose to change the daemon's refusal, reads only.

## 决定 / Decisions

1. **读任何项目的记忆，只读 / Any project's memory, reads only.** Claude Agent Bot 的 Read、Glob、Grep 能打开默认配置目录下的 `projects/<任一项目>/memory/`，哪种权限模式都一样；Write、Edit、NotebookEdit 全部允许也照旧拒绝。记忆里没有登录信息，这是 ADR 0095 已有的判断；只开读，是因为 Bot 有应用自己的记忆，没理由往 Claude Code 的记忆里写。 / A Claude Agent Bot's Read, Glob and Grep open `projects/<any project>/memory/` under the default config directory, in every permission mode; Write, Edit and NotebookEdit stay refused even under allow all. The memory holds no sign-in, as ADR 0095 already judged; reads only, because a Bot has the app's own memory and no reason to write in Claude Code's.

2. **只有这个目录 / That folder and nothing else.** 配置目录里的其他东西照旧拒绝，包括目录旁边的会话文件：那里有整段对话，不是记下的结论。在 `projects/` 或配置目录上搜索也拒绝，所以 Bot 列不出有哪些项目；拒绝时告诉它目录的写法，它按项目路径算出来。 / The rest of the config directory stays refused, the session files beside the folder too: those hold whole conversations, not conclusions. A search over `projects/` or the config directory is refused as well, so a Bot cannot list the projects; the refusal tells it how the folder is spelled, and it works the name out from the project's path.

3. **目录本身也要是真的 / The folder must really be that folder.** 名字不是应用给的，是路径里任意一段，所以多查一步：`projects/<项目>/memory` 解开链接后必须还在配置目录的同一位置，它或它的上一层是指到别处的链接就拒绝。里面的文件照 ADR 0095：指到登录文件的、指向不存在的地方的链接都拒绝。配置目录自己是链接（比如放在 dotfiles 里）没关系。 / The name is not one the app gives but any segment of the path, so one more check: `projects/<project>/memory` resolved through links must still be in the same place under the config directory, and it or its parent being a link elsewhere is refused. Files inside go as ADR 0095 has them: a link to a sign-in file or to nothing is refused. A config directory that is itself a link (kept in dotfiles, say) is fine.

4. **命令进不来 / Commands stay out.** 和 ADR 0095 一样，命令一提到 `~/.claude` 就拒绝，进去以后它能 `cd` 到别处。这个判断只看命令文字，不看它要干什么，所以写进文件或 `grep` 里的字面路径也算；Bot 要改源码或文档里提到这个路径的地方，用 Edit。 / As in ADR 0095, a command naming `~/.claude` is refused: once there it could `cd` anywhere. The check reads the command's words, not what it means to do, so a literal path in a heredoc or a `grep` counts too; a Bot changing source or docs that mention the path uses Edit.

5. **提示词跟着改，默认就是这句 / The prompt says so, as the default.** `agent.preface` 的中英文默认都写明这个例外。你先批准过同样的中文，所以开库时那条改动会合并回默认，不留一条多余的「改过」。 / `agent.preface` states the exception by default in both languages. You had already approved the same Chinese, so at open that edit merges back into the default and no stray "edited" stays.

## 不变 / Unchanged

- **其他账号 / Other accounts.** 只开默认配置目录（`CLAUDE_CONFIG_DIR` 或 `~/.claude`）。设置里另列的账号目录整个还是拒绝。 / Only the default config directory (`CLAUDE_CONFIG_DIR` or `~/.claude`) opens. An account directory listed in Settings stays refused whole.
- **其他 Agent 上的 Bot / Bots on other agents.** Codex、Grok 这些跑的 Bot 走 `decideAction`，照 ADR 0079 读不到 `~/.claude`，这次没有改。它们的工具不归 Read、Glob、Grep 这一路，要开得另外决定。 / Bots run by Codex, Grok and the like go through `decideAction` and, per ADR 0079, read nothing of `~/.claude`; this does not change that. Their tools are not this Read, Glob and Grep; opening them is a separate decision.
- **项目会话 / Project sessions.** 还是只开自己项目的记忆，能读能写，ADR 0095 决定 13 不变。 / Still their own project's memory only, read and write, as ADR 0095 decision 13 has it.

## 代价 / Costs

- **Bot 能看到你在别的项目里让 Claude Code 记下的东西 / A Bot sees what Claude Code remembered in your other projects.** 记忆是你自己机器上、你自己项目的结论，但可能写了内部地址、人名或别的不想让所有 Bot 都看到的内容，它们的回复也可能带出来。 / The memory is conclusions from your own projects on your own machine, but it may hold internal addresses, names or other things you would not want every Bot to see, and their replies may repeat them.
- **`autoMemoryDirectory` 设在别处的记忆打不开 / Memory set elsewhere with `autoMemoryDirectory` does not open.** 应用不读设置，和 ADR 0095 一样。 / The app reads no settings, as in ADR 0095.

`claude-code/policy.ts` 的 `readableMemoryRoot`、`inProjectMemory`，`engine/agent-runner.ts`，`prompts/agent-system.ts`。 / `readableMemoryRoot` and `inProjectMemory` in `claude-code/policy.ts`, `engine/agent-runner.ts`, `prompts/agent-system.ts`.
