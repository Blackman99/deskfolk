# 用量收到一处：一个接口、一个悬浮挂件 / Usage in one place: one route, one floating widget

Status: implemented 2026-10-10. Replaces the sidebar meters of [ADR 0061](0061-claude-agent-runner.md) (the plan usage meter addendum) and [ADR 0079](0079-local-agents.md) (decision 10); what is asked of each agent, and how, is unchanged.

## 背景 / Context

你说（2026-10-10）：「现在支持了这么多 Agent，订阅用量的展示要改一下，统一到一个地方进行。」之前 Claude 和其他 Agent 各走一套：两个接口（`/v1/claude-usage`、`/v1/agent-usage`）、两种窗口结构、侧栏底部叠着两条样式不同的条（一条能展开、有重置时间、能刷新，另一条都没有），设置里只有 Claude 的卡片显示用量，菜单栏每个窗口占一行。问到细处时你选了：侧栏的条不要，做成**能吸附在窗口边缘收起的悬浮挂件**，默认右上角，点开看全部用量；菜单栏**每个账号一行**的简易版；手机上放进**工具菜单里的单独页面**。

You said (2026-10-10): "With this many agents supported, the subscription usage display should change: unify it in one place." Claude and the other agents each had their own: two routes, two window shapes, two differently styled strips stacked at the sidebar's foot (one opened, said when windows reset and refreshed; the other did none of that), usage only on Claude's settings card, and a menu-bar line per window. Asked about the details, you chose: no sidebar strips, but a **floating widget that docks to the window's edge and tucks away**, top right by default, opened to see all usage; **one line per account** in the menu bar; on a phone, **a page of its own from the Tools menu**.

## 决定 / Decisions

1. **一个接口 / One route.** `GET /v1/usage`（`?refresh=1` 要一份 30 秒内的）按 Agent 分组：`{ agents: [{ runner, custom_id, label, today, accounts: [...] }] }`。每个账号 `{ config_dir, email, available, reason, plan, windows, credits, checked_at, error }`，窗口统一成 `{ minutes, model, percent, resets_at }`（Claude 的 5 小时是 `300`，7 天和各模型的周窗口是 `10080`，模型窗口带 `model`）。Claude 排第一，其余按 Agent 的固定顺序，你自己的 ACP Agent 按名字。只报「今天」的 Agent（Grok、OpenCode、Antigravity、ZCode、ACP）`accounts` 为空——仍然不编百分比。旧的两个接口留着，给还没更新的客户端；新客户端遇到 404 才退回去拼。远程白名单同样加上。/ Grouped by agent; accounts carry one window shape. Agents that report no plan windows have no accounts — still no invented percentage. The two old routes stay for older clients; a new client falls back to them only on a 404. Whitelisted for a phone too.

2. **「今天」按 Agent 算，Claude 也有 / "Today" per agent, Claude included.** 花费表没有账号这一列，所以「今天」挂在 Agent 上，不挂在账号上：`spend` 里端点名等于 Agent 名、今天零点以后的行，token 求和，轮数数不同的 `turn_id`（Claude 的轮次不写 `agent_*` 选路记录，原来那种数法对它是 0）。/ Spend records have no account column, so today's numbers belong to the agent; turns are distinct `turn_id`s in today's spend rows under the agent's name, which counts Claude's turns too.

3. **哪些账号算「在用」，一处说了算 / One enumeration of accounts in use.** Bot、模型阶梯上的 Agent 档、内置调用（`<role>_runner`）三处一起列。之前 Claude 的探针漏了内置调用：一个只给内置调用用的 Claude 账号从没被问过。/ Bots, ladder rungs and built-in calls, for every agent; Claude's probe used to miss accounts only a built-in call ran on.

4. **问法不变，问得更省 / Same asking, less waiting.** Claude 仍由你本机的 Claude Code 答（`get_usage`），Codex 仍由它自己的 app-server 答（`account/rateLimits/read`），答案留 5 分钟、刷新最少隔 30 秒。各账号的 Codex 改成并行问，而不是一个等一个。/ Asked as before, kept as long; Codex accounts are asked in parallel now.

5. **悬浮挂件 / The floating widget.** 主窗口（宽于 680px）右上角浮着一颗胶囊：每个有套餐窗口的账号一个「标 + 圆环」，圆环是它最紧的那个窗口剩多少，最多三个，多的写「+N」；有一个到了警戒线，胶囊描上那个颜色。按住拖动（指针事件，过 4px 才算拖），松手离边缘不到 24px 就**吸附**在左边或右边并**收起**——只露出一条窄边，带最紧那个账号的圆环；指针移上去或键盘聚焦时滑出来，移开一会儿再收回去。不贴边就自由浮着。位置记成「哪条边 + 上下比例」，窗口缩放、侧栏收起后不会跑出去；记在本机（`localStorage`），每台设备各自记。点胶囊在旁边宽的那一侧弹出面板：上面是有额度窗口的 Agent（每个账号的所有窗口、重置时间），每个 Agent 带今天的轮数和 token；下面一段灰色的是只有今天记录的 Agent；底部是「几点查的」和刷新。Esc、点外面或再点胶囊关上。右键胶囊可以「隐藏用量挂件」；工具菜单里的「用量」把它找回来并打开面板。没有任何在用的 Agent 时挂件不出现。/ A pill floating top right of the main window: an agent mark and a ring per account with plan windows, the ring as full as what is left of its tightest window, three at most, then "+N"; a warning colour outlines it. Dragged with pointer events (past 4 px), it docks to the left or right edge when dropped within 24 px of it and tucks away to a sliver showing the tightest ring; hovering or focusing slides it out, leaving tucks it back. Its place is kept as an edge and a fraction of the height, per device. A click opens the panel on the roomier side: agents with plan windows first (every window of every account, when each resets, today's turns and tokens), then a muted part for agents with today's records only, then when it was checked and Refresh. Its context menu hides it; Tools › Usage brings it back and opens the panel. No agent in use, no widget.

6. **手机：工具菜单里的单独页面 / Phone: a page from the Tools menu.** 手机上没有挂件。工具菜单加「用量」，打开列表里的一页（像已归档会话那页，顶上有返回），内容和面板一样。/ No widget on a phone; Tools › Usage opens a page in the list, with Back, holding what the panel holds.

7. **菜单栏：每个账号一行 / Menu bar: one line per account.** 每个有套餐窗口的账号一行：圆环是最紧的窗口，文字是「名字　5h 62% · 7d 81%」（只写 5 小时和 7 天，各模型的窗口只在面板里）；只有今天记录的 Agent 合成一行「Grok 12 轮 · OpenCode 3 轮」（今天还没跑过的不列）。最多四行，再下面一行「查看全部用量…」打开主窗口和面板。Claude 还是 Spark 标，别家照旧只写名字。/ One line per account with plan windows (tightest ring; the 5-hour and 7-day numbers only); agents with today's records only share one line (those with no turns today left out); four lines at most, then "Show all usage…", which opens the window and the panel.

8. **设置里不再单独画用量 / Settings no longer draws its own.** Claude 卡片里每个账号下面那一整块用量去掉，换成和其他 Agent 一样的一行简要用量（与菜单栏同一格式）；Codex 的账号下面也有了。看全部还是在挂件里。/ The Claude card's per-account usage block becomes the same one-line summary every agent's accounts now show; the full view is the widget's.

## 后果 / Consequences

- 侧栏底部的 `ClaudeUsageMeter`、`AgentUsageMeter` 去掉，手机上 + 按钮不用再给它们让位。/ The two sidebar meters are gone; the phone's + button no longer lifts for them.
- 文案合并到 `t.usage`。/ Copy moves to one `t.usage` namespace.
- 挂件只在主窗口；手机、窄窗口（≤680px）没有。/ Only the main window has the widget; narrow windows and phones have the page instead.

## 补充：连接上的都展示 / Addendum: every connected agent is shown（2026-10-10）

你看到挂件里只有 Claude，问为什么——你这台 Mac 上只有 Claude 有东西在用。你说：「只要连接上的都要展示用量。」于是决定 3 改成：**在用的，加上连接上的**。连接上 = 设置 › Agent 里找到了程序、没有登出（说不清是否登录的，比如 Grok，找到就算）；每个账号都算，包括你列的其他配置目录。Claude 的用 Claude Code 自己的状态（`claude auth status`，探针有缓存），其他 Agent 用设置 › Agent 那份状态（存着的那份马上给，旧了在后面再看一次）。所以 Codex 装了、登录了，没有 Bot 用它也会去问它的套餐窗口（不经过模型、不花额度，5 分钟最多问一次）；Grok 这类不报套餐的，今天没跑过也列出来（「今天 0 轮」），菜单栏那一行也不再省掉它们。挂件在没有任何连接上的 Agent 时才不出现。

You asked why only Claude showed: only Claude had anything running on it. You said: "every connected one should show its usage." Decision 3 becomes **in use, plus connected**: found and not signed out (an agent that cannot say counts once found), every account including listed config directories; Claude's from Claude Code's own status, the others' from Settings › Agents' status (the kept one at once, re-checked behind it when old). Codex installed and signed in is asked for its windows with no Bot on it (no model, no quota, at most once per five minutes); agents with no plan are listed even with no turns today, in the menu bar too. The widget stays away only when no agent is connected.

