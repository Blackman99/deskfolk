# plan_items：负责人一次拆好任务 / plan_items: the lead lays out the tickets

Status: implemented at engine level 5 (`ENGINE_LEVELS.submissions`), from [ADR 0040](0040-agent-kernel-the-job-owns-state.md) §2.8; issue 26a's remaining part.

ADR 0040 §2.8 把 `plan_items` 列为五个核心契约工具之外、只给负责人的那一个：任务、谁做、谁审、依赖和分件由负责人用一个结构化调用写进看板，而不是靠整理跳从聊天里读出来、或者靠文件名猜。在这之前，Bot 只能用 `work_on` 一次开一张任务；审查者、依赖只能你在看板上设；分件只能从交付文件名认出来。

ADR 0040 §2.8 lists `plan_items` as the lead's own tool: tickets, who makes them, who reviews them, what waits for what and the parts are written to the board by the lead in one structured call, rather than read out of the chat by the organizer or guessed from file names. Before this a Bot could open one ticket at a time with `work_on`; reviewers and dependencies were yours to set on the board; parts came only from delivered file names.

## 决定 / Decisions

1. **只给不会变的负责人 / The lead's only, one that does not shift.** 5 级起所有 Bot 的工具里都有 `plan_items`，但只有这一轮所在规划的负责人调得动，而且只认不会随谁多跑几轮而变的负责人：规划存下的负责人，否则你在群里确认的负责人，否则私聊里的那一个 Bot。监督器叫醒人时用的「执行段最多的 Bot」不算——它会变，第一个调用的 Bot 自己的轮次就算进去了。群里没有这样的负责人时谁也调不动，结果告诉它请你确认一位。别的 Bot 调用得到 `forbidden`，说明要拆活就委派给负责人。规划要是进行中的，这一轮要已经挂在规划上（先 `work_on`）。叫停时它和别的写操作一样被拦下。 / From level 5 every Bot has `plan_items`, but only the lead of the turn's plan can call it, and only a lead that does not shift with who ran most: the plan's stored lead, else the group lead you confirmed, else the one Bot of a direct. The supervisor's "Bot with the most turns" does not count — it moves, and the first caller's own turns would count. A group with no such lead lets nobody call it, and the answer asks for one to be confirmed. Another Bot gets `forbidden`, telling it to delegate to the lead. The plan must be active and the turn on it (`work_on` first). Under a stop it is refused like any other write.
2. **一项一张任务 / One item, one ticket.** 每项写标题、`owner`（规划会话里的 Bot，名字或 id；新任务必填）、可选的 `reviewer`（不能是 owner）、`depends_on`（同一次调用里别的标题，或规划里已有任务的标题、id、编号如「#02」）、`parts`（「Shot 07」「C07」「第七镜」「7」都记成 `shot_07`，和按文件名认出的分件对得上；没有编号的按文字记；两个不同写法归成同一个编号时整次拒绝，同一写法写两遍算一个）。一次最多 20 项，每张最多 60 个分件。 / Each item has a title, an `owner` (a Bot in the plan's conversation, by name or id; required for a new ticket), an optional `reviewer` (never the owner), `depends_on` (another item's title in the call, or an existing ticket's title, id or number such as "#02") and `parts` ("Shot 07", "C07", "第七镜" and "7" all become `shot_07`, matching the parts file names make; one with no number is kept by its words; two different spellings that would make one number are refused, the same one twice counts once). At most 20 items a call and 60 parts a ticket.
3. **同名就是那张，只补不改 / Same title, same ticket, only filled in.** 规划里已有同名（不分大小写）的任务就是它，返工不开第二张；但只补空着的：已经有人做、有人审的不换（不管是你在看板上设的还是别人），结果里用 `kept` 写明哪些没改；依赖和分件只加不减；没写的项保持原样。已完成、已搁置或已通过的任务不动，整次拒绝，让你在看板上重开。交付正在走审查时，审查者也不补（委派来的审查者照旧审）；补上的做的人不能是这张任务的审查者；依赖不能新加已搁置的任务。 / A title the plan already has (case aside) is that ticket, so rework never opens a second one; but it is only filled in: an owner or reviewer already set stays (yours on the board or anyone's), and `kept` in the answer says which; dependencies and parts are only added; anything left out stays as it was. A ticket that is done, parked or approved is not touched, and the call is refused so you reopen it on the board. While a hand-over is on its way to review, no reviewer is filled in (a delegated reviewer goes on); an owner filled in is never the ticket's reviewer; a parked ticket is not a dependency to add.
4. **要么全成要么全不成 / All or nothing.** 任何一项不合法（不在场的 Bot、审查者是 owner、依赖名不到任务、依赖成环、超过上限），整次调用都不生效，看板不变。 / If any item is invalid (a Bot not here, a reviewer who is the owner, a dependency naming no ticket, a loop, a limit passed), the call changes nothing.

## 缺口 / Not done

- **任务类型**（spec 的 `kind`）不记：任务表没有这一列，审查是不是一张单独的任务由负责人自己拆。
- 拆完后派活仍然靠委派；`plan_items` 只写看板，不叫醒任何人。

## 取舍 / Trade-offs

- **按标题认任务**：负责人改标题会开新任务；换来的是返工、补分件不用记任务 id。
