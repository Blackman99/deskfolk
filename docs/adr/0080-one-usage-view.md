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

## 补充：Grok 和 Antigravity 也报额度 / Addendum: Grok and Antigravity report their plans too（2026-10-10）

你问 Grok 跟 Antigravity 为什么拿不到用量。ADR 0079 第 10 条当时以为它们不报套餐，其实都能问，而且都不经过模型、不花额度：
- **Grok**：`grok agent stdio` 握手后调 ACP 扩展方法 `_x.ai/billing`（不开会话），答的就是它 TUI 里 `/usage` 那份：套餐档（`subscription_tier`，如 SuperGrok Heavy）、本期额度用了百分之几（`creditUsagePercent`）、本期起止（`currentPeriod`，按周）、预付余额。显示成一个窗口：本期长度、用了多少、期末重置。这个方法 Grok 的公开文档里没有，换了形状那个账号就写「没查到」。
- **Antigravity**：`agy -p "/quota"` 和 `agy -p "/credits"`。agy 从 1.1.11 起在 print 模式下自己回答这几个只读的斜杠命令（每行一条，制表符分隔）；**更早的版本会把它当提示词交给模型**，所以先看 `agy --version`，低于 1.1.11 的不问，账号写明要更新。`/quota` 按模型组给窗口（「Gemini Models」「Claude and GPT models」各有 5 小时和每周的剩余和重置时间），显示成按模型组的窗口，和 Claude 的 Fable 周额度一样；`/credits` 有余额时写在账号名后面。
挂件、菜单栏和设置里它们都和 Codex 一样有圆环和剩余；只有模型组窗口的账号，摘要按组写（「Gemini Models 97% · Claude and GPT models 87%」）。OpenCode、ZCode 和你自己的 ACP Agent 仍只列今天的记录。

You asked why Grok and Antigravity had no usage. ADR 0079 decision 10 took them for agents with no plan to report; both report one, with no model call and nothing spent. Grok answers the ACP extension `_x.ai/billing` right after `initialize` (no session): its tier, the share of this period's credits used and the period's ends — one window. It is not in Grok's public docs; another shape makes the account say it could not be read. Antigravity answers `agy -p "/quota"` and `/credits` itself from 1.1.11 (before that the line went to the model as a prompt, so an older `agy` is not asked and the account says to update): a 5-hour and a weekly window per model group, shown as model windows, and credits when there are any. A summary of an account with model-group windows only goes by group. OpenCode, ZCode and your own ACP agents still show today's records only.

## 补充：一个球，悬停展开 / Addendum: a ball that opens on hover（2026-10-11）

你说胶囊太占位置、账号多了不好看：「改成默认一个球，上浮展开每个种类 Agent 的排列，再浮动对应的 Agent 展开这个 Agent 对应的所有账号用量」，变化过程要有 morph 动画。决定 5 改成：默认只有一个小球（圆环是所有账号里最紧的窗口）；指针移上去，球变形长成一列 Agent 圆标（同一个形状，clip-path 从球过渡到整列，圆标依次淡入），每个圆标的外圈是这个 Agent 最紧的窗口，只有今天记录的是虚线；指针移到某个 Agent，从它的圆标长出一张卡片（圆形 inset 过渡成圆角矩形），列这个 Agent 的所有账号。点击固定（触屏用），Esc 或点外面收起；系统要求减少动态时不播动画。吸边、拖动、隐藏、工具菜单入口不变；手机页不变。

You found the pill too big and hard to read with many accounts: a ball by default, opening on hover into a row of agent kinds, each opening on hover into all its accounts, with morphing in between. Decision 5 becomes: a small ball (ringed by the tightest window of all); pointed at, it morphs into a column of agent bubbles (one shape, clip-path from the ball to the whole column, bubbles fading in in turn), each ringed by that agent's tightest window, dashed for today's records only; pointing at one grows a card out of its bubble (a circle inset opening into a rounded box) with all its accounts. Clicks pin it (touch), Escape or a click outside folds it; reduced motion turns the animation off. Docking, dragging, hiding and the Tools entry are unchanged, and so is the phone's page.

## 补充：菜单栏也带上各家的标 / Addendum: the menu bar wears each agent's mark（2026-10-11）

你说：「菜单里也要加上 LOGO。」决定 7 里「Claude 还是 Spark 标，别家照旧只写名字」改成：每个账号那一行的图标是它那家 Agent 的标（和挂件里同一套，`AgentLogo.svelte` 按 2 倍渲染一次、裁成圆形，存成 `src-tauri/src/agent-logos/<runner>.rgba`，菜单图标只收像素），外面一圈细环按最紧的窗口剩多少画、颜色同前；没登录、没查到的账号只有标没有环；不报套餐的那一行合在一起，仍没有图标。标只用来指明是哪家，和 ADR 0061、0072、0079 的商标说明一样。

You asked for the marks in the menu too. Decision 7's "the Spark for Claude, names only for the others" becomes: each account's line wears its agent's mark (the widget's own, rendered once from `AgentLogo.svelte` at twice its size, cut round, kept as raw RGBA since menu icons take pixels) inside a thin ring as full as what is left of its tightest window; a signed-out or unreadable account shows the mark alone; the shared line for agents with no plan still has no icon. Marks only name the agent, as ADRs 0061, 0072 and 0079 say.


## 补充：用量是一个标签页 / Addendum: usage is a tab（2026-10-11）

你说：「工具里的用量跟菜单里的查看全部用量都要打开新的标签页，注意这里的行为控制要跟设置里已有的结合。」工具菜单的「用量」和菜单栏的「查看全部用量…」不再展开挂件，改成在工作台打开一个「用量」标签页（内容同卡片，所有 Agent 排在一起）。它像花费一样只有一个，开着就切过去；没开着时放在哪由 设置 › 行为 ›「窗口打开方式」新加的「用量」一行决定（ADR 0074，默认新标签页）。挂件被隐藏后原来靠工具菜单找回，现在靠用量标签页底部的「显示用量挂件」。没有工作台的宽窗口（远程连上的平板）照旧展开挂件；手机照旧是一页。

You asked for Tools › Usage and the menu bar's "Show all usage…" to open a new tab, following the existing Behavior settings. Both now open a single Usage tab on the workbench, placed by a new Usage row in Where windows open (ADR 0074; a new tab by default) and only brought forward when open. A hidden widget comes back from that tab's "Show the usage widget". A wide window with no workbench still opens the widget; a phone still gets its page.
