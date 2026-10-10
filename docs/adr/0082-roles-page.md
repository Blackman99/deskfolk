# 分工页 / The Roles page

Status: implemented 2026-10-11, at every engine level. Moves the built-in models of [ADR 0077](0077-built-in-models.md) and the app's own calls' prompts of [ADR 0064](0064-built-in-prompts-you-and-your-bots-can-edit.md) onto one page of Settings; how the calls run, what they spend and how their prompts are edited do not change.

## 背景 / Context

你说（2026-10-11）：「当前的内置模型跟提示词设置是分开散落在两个地方的。实际上这两个是非常相关的，而且是一种模型 + 擅长任务的定义。要想一种新的设置方式能够在同一个区域进行设置，并且最好是能体现路由 + 任务可视化 UI 配置。」问到细处时你定了两条：新开一页，收这九个调用和它们的提示词，Bot 自己的一轮在图上只是一个节点；用一张按时机排的路由图，点一个节点展开它的模型和提示词。

在这之前，整理器的模型在 设置 → 模型服务 → 内置模型，它的提示词在 设置 → 提示词 →「应用自己的调用」；两边谁也不提谁，提示词页上也看不出哪几段属于同一个调用（读句有四段，看图判定有四段）。

You said (2026-10-11): the built-in models and the prompt settings sit in two places, yet they belong together — a model plus the task it is good at — so there should be one place to set them, ideally one that shows the routing and the tasks visually. Asked about the details, you settled two things: a new page with the nine calls and their prompts, the Bot's own turn only a node on the map; and a routing map laid out by when things run, a node opening its model and prompts.

Until now the organizer's model was under Settings → Models → Built-in models and its prompt under Settings → Prompts → "The app's own calls"; neither pointed to the other, and nothing told which prompts belong to one call (reading has four, the picture judge four).

## 决定 / Decisions

1. **哪段提示词属于哪个调用，由守护进程说 / The daemon says which call a prompt belongs to.** 提示词登记表里每个 `call.*` 槽位带上 `role`（ADR 0077 的九个调用之一），`/v1/prompts` 的每条照发：读句四段（`read_user_line`、`read_bot_line`、`read_filing`、`read_scale`），看图判定四段（三种衔接检查和照样片），其余一个调用一段。测试保证每个调用槽位都有、每个内置调用至少有一段。界面不自己维护这张表。/ Each `call.*` slot of the prompt registry carries its `role` (one of ADR 0077's nine calls), sent on every `/v1/prompts` item: four for reading, four for the picture judge (three seams checks and the sample check), one each for the rest. A test holds every call slot to having one and every built-in call to having at least one prompt. The UI keeps no copy of this table.

2. **「分工」页 / The Roles page.** 设置侧栏在「模型服务」后面多一页「分工」（Roles）。上方是一张图，一条一件引出调用的事：你的一句话（读句 → 读完才叫醒 Bot 一轮 → 交上来时看图判定；读句旁书记员同时记下，Bot 一轮旁上下文快满时压缩上下文、活停下来后整理器）；群里没点名的一句（判断下场，要接就进 Bot 一轮）；你接受一件交付（完工复盘）；你推翻一次放行（反思）；你按 ✨（输入建议）。每条线和每个分支都对得上引擎里调用的地方。节点写着调用名和现在的模型（没设写跟默认模型或跟 Bot 的模型），提示词改过的带点，冲突或回答读不懂的带警示色的点。点一个节点，下面是它做什么、它的模型（ADR 0077 的选择器，照旧）和它的提示词（同提示词页的编辑页）。宽窗图从左到右，选中的详情在图下，点了就滚进视野；手机上图从上到下，点节点进到它自己的一页。/ Settings gets a Roles page after Models. At the top is a map, one lane per thing that sets calls off: a line of yours (reading → a Bot's turn once read → the picture judge when a part is handed in; the scribe beside reading, compaction near the context window and the organizer once the work goes quiet beside the turn); a group line naming nobody (joining in, then the turn for a Bot that takes it up); you accept a delivery (retrospective); you overturn an approval (reflection); you press ✨ (the composer). Every lane and branch matches where the engine makes the call. A node names the call and its model (or what it follows), with a dot when a prompt is edited and a warning-coloured one for a conflict or unreadable answers. Picking a node shows below what the call does, its model (ADR 0077's picker, unchanged) and its prompts (the Prompts page's editor). A wide window lays the map left to right, the picked call's page under it, scrolled into view; a phone lays it top to bottom and opens a node as a page of its own.

3. **Bot 一轮只是节点 / A Bot's turn is only a node.** 它跑在 Bot 自己的模型上、按模型阶梯往上换，带每一轮的提示词；这些不搬过来，节点里写着阶梯上的模型，链到 模型服务 › 模型阶梯 和提示词页。/ It runs on the Bot's own model, moves up the model ladder and carries every turn's prompts; none of that moves here. The node names the ladder's models and links to Models › Model ladder and to the Prompts page.

4. **两边各剩什么 / What stays where.** 模型服务只剩端点、模型阶梯、语音识别。提示词页只列没有 `role` 的（每一轮、Claude Agent、工具说明），上面一行指向「分工」；连着还没标 `role` 的旧版守护进程时，「应用自己的调用」那组照旧留在提示词页。侧栏上「提示词」的数只算它自己列的；「分工」的数是改过的调用有几个（选了模型或改了提示词，每个调用算一次），提示词有冲突时用警示色，所以冲突不会从侧栏上消失。卡片的「在设置里看」指向带 `role` 的提示词时，打开「分工」、选中那个调用、在修改记录上打开它。/ Models keeps the endpoints, the ladder and speech recognition. Prompts lists only the prompts with no `role` (every turn, Claude Agent, tool descriptions) under a line pointing to Roles; with an older daemon that sends no `role`, the app's own calls stay on Prompts as before. Prompts' number in the sidebar counts only what it lists; Roles' counts the calls you changed (a model chosen or a prompt edited, each call once), warning-coloured for a prompt conflict, so a conflict never drops out of the sidebar. A card's "View in Settings" about a prompt with a `role` opens Roles at that call, with the prompt's history open.

## 后果 / Consequences

- **不改行为 / No change in behaviour.** 存法、补丁、校验、思考档、花费都是 ADR 0077 和 ADR 0064 的；只是在哪设换了地方。/ Storage, patches, checks, thinking levels and spend are ADR 0077's and ADR 0064's; only where they are set moved.
- **图要跟着引擎改 / The map follows the engine.** 加一个内置调用，要在 `routing-map.ts` 的 `ROUTING_LANES` 里给它一个位置，在登记表里给它的提示词一个 `role`；单测会拦住漏掉的。/ A new built-in call needs a place in `ROUTING_LANES` (`routing-map.ts`) and a `role` on its prompts in the registry; the unit tests catch a missing one.
- **没做的 / Not done.** 每个调用近 7 天跑了几次、花了多少还没上节点：花费的用途（`purpose`）只分出读句、书记员、看图、反思、复盘、压缩，整理器、输入建议、判断下场没有自己的一项。/ How often each call ran and what it spent in the last 7 days is not on the nodes yet: spend purposes split out reading, the scribe, pictures, reflection, retrospective and compaction, not the organizer, the composer or judgements.
- **取代 / Supersedes.** ADR 0077 第 6 条（模型服务里的一页「内置模型」、手机列表上的「全部照旧 / 单独设了 N 项」）和 ADR 0064 第 10 条里应用自己的调用那一组在提示词页上的部分，由这里取代；两份里其余的照旧。/ ADR 0077's decision 6 (a Built-in models page under Models, "All as before / N set apart" on the phone's list) and, in ADR 0064's decision 10, the app's own calls as a group of the Prompts tab, are superseded here; the rest of both stands.
