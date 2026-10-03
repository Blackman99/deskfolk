# 工作项与确定性归属 / Work items and deterministic attribution

Status: accepted for the P4b level-2 boundary, including scoped new-job action-card verification. Full P4b phase verification remains separate; this is not acceptance of P4c–P5.

本 ADR 记录 [ADR 0040](0040-agent-kernel-the-job-owns-state.md) 的 P4b：同一 Bot 的两条私聊曾把 C07/C08 各做一遍，投诉又曾被整理员挂到旧规划。让模型在开轮前猜归属、再按会话或 worker 继承执行身份，既慢，也不能给出唯一执行的保证。选择以工作项持有执行身份，用确定性证据和受限的桌面选择分开「知道这句属于哪里」与「允许在这里动手」。

This records P4b of [ADR 0040](0040-agent-kernel-the-job-owns-state.md): two directs of one Bot duplicated C07/C08, and an organizer filed a complaint under an older plan. A pre-turn model guess followed by conversation/worker inheritance was both slow and unable to guarantee unique execution. Work items now own execution identity; deterministic evidence and a restricted desk separate knowing where a line belongs from permission to act there.

## 决定 / Decision

- **身份 / Identity.** 工作项是 Bot × 规划 × 可选任务；没有规划的桌面工作项是 Bot × 会话。I1 限一个工作项最多一段活执行，I1b 限同一 Bot 在同一规划上最多一段，含等批准/提问；同规划新消息进入已有段的持久收件，不改道、不重做。Work items are Bot × plan × optional ticket, or Bot × conversation for a desk. I1/I1b cover live segments including approval/ask waits. Later lines about the same plan enter the existing durable inbox instead of redirecting it or duplicating work.
- **归属 / Attribution.** `message_filings` 是消息全部归属的事实来源，旧标量列只投影主目标。显式选择、批注、引用、已知目录路径和已有工作绑定是锁定来源，指向不同目标时累积；单候选、唯一分件编号、群的唯一 active 规划是可改默认。拿不准是 undetermined，不静默新开规划。A message may concern several jobs/parts. Locked sources accumulate; defaults are correctable and choose one plan. Undetermined is not a fallback plan opening.
- **桌面 / Desk.** 未定消息开被叫 Bot 自己的第一段，只读和回答/询问，`work_on` 只能选择捕获的候选，或引用真实用户原话新开；桌面显示固定候选 id/标题、最后活动、最多 3 个产物路径和最近用户原话（显示截到 300 字符），证据可逐跳刷新但不扩充候选身份；第一次副作用前，0 候选的用户请求建规划和产出任务，1 候选按已经展示的默认绑定，多个候选拒绝。归属退回预算两次，耗尽 needs_attention。I8 是每段最多一次目录变化，必须在副作用前完成；默认错误可在首次动作前拆出，不是随时换工作目录的许可。The desk is the called Bot's first segment, not a side model call. Candidate ids are captured; their displayed title, activity, up to 3 artifact paths and latest user words (clipped to 300 display characters) may refresh each hop without widening that set. Effects wait for binding, and a held `readonly` answer cannot take work on. Continue preserves desk mode, candidates and directory-change count rather than bypassing the guards.
- **名额与冷队列 / Slots and cold queue.** 当前每 Bot 全局默认最多两段工作，读取有效的正整数 `parallel_limit`、缺省/无效则回到 2，本次没有新界面设置；每 Bot × 会话最多一个活桌面，桌面不占工作名额，不承诺全局只有一个桌面。收件和工作项持久排队，空闲后可从无活段的冷目标开段；叫停和休眠仍阻挡。桌面转工作与继续都不能越过工作名额；清空后须用户明确恢复，才可从正文快照重建只给 Bot 的触发，不自动继续。The default is two work segments per Bot globally, honoring a valid positive stored `parallel_limit` without a new interface setting, and one live desk per Bot × conversation, with no global desk uniqueness. Queues persist and dispatch when slots/holds/dormancy allow; desk conversion and Continue cannot exceed work slots. Cleared sources can be rebuilt from snapshots only after your explicit resume, not automatic P4c supervision.
- **纠正和原话 / Corrections and quotes.** 用户改归可替换锁定来源，未读收件移动、已读历史不改而另投纠正，叫停不解除，旧段/文件不迁移。持久 `user_quote_filings` 保住每个目标的原话关联，清空转录不丢副目标；需求条目仍按当前单一作用域重挂到主目标，不声称多目标审查义务已实现。User corrections preserve execution audit and holds. Quote relationships are plural and durable; requirement scope fan-out is not claimed.
- **负责人 / Lead.** 群里未点名用户消息先给在场的规划负责人，再给用户确认的群负责人。近 7 天真实交接仅作建议，无证据/并列不自动选；只有用户确认写 lead。两者都没有的旧群保留现有参与判断，并未改成一次判全体。Unaddressed lines prefer the present plan lead, then the user-confirmed group lead. Seven-day evidence suggests, never appoints. Legacy per-Bot judgement remains with no lead.
- **新开卡片 / New-job card.** 新事有持久撤销/并入卡，运行中、排队中或快速交完仍在 active/delivered 的新事可操作。撤销先叫停并停止，再记 abandoned，保留文件、执行和原话/需求，不逆转过去副作用或自动清理；解除叫停不自动复活 abandoned。并入另把卡片引用的那条用户消息改归到卡上提供的同项目 active/delivered 规划，其他消息归属保留，不改旧轮、搬产物、合并整个规划或解除目标叫停。普通归属「改」不作废原规划，与卡片并入不同。已接受/作废的来源、已改归的引用有过期保护，成功动作只执行一次。Cards explicitly stop/abandon the new job while retaining past effects and evidence. Merge changes only the quoted message's new-job filing into an offered eligible plan of the same project, not old turns or whole plans, and never lifts target holds. Ordinary attribution Edit does not abandon a plan. Accepted/abandoned jobs and changed quotes are protected; repeats are idempotent. Scoped store/API/interface checks are confirmed, not full phase acceptance.

## 版本边界与取代 / Version boundary and supersession

`ENGINE_LEVELS.work_items = 2`，开始使用时同时提高 `schema_min_compatible` 到 2；只补表列不等于已经切换语义。2 级消息不调用开轮前 organizer，执行不依赖 `resolveTurnTask` 的唤醒方继承、兜底 openTask 或 `ownOpenTicket`。0/1 级因共用数据目录和版本闸保留旧路径；消息模式函数/提示词/运行记录没有物理删除。settle 仍保留交接整理，现有 route_pick/复盘/学习也没有被 P5 替代。

Work-item semantics start at engine level 2, raising the compatibility floor to 2. Level 2 bypasses pre-turn organizer attribution and inherited/fallback work identity. Levels 0/1 retain those paths for shared-data/gate compatibility: retained code is not described as physically deleted. Settle and current model routing/review/learning remain.

本阶段在 **2 级作用域内部分取代**：

- [ADR 0030](0030-plans-tickets-and-organizer.md)：消息必须先整理、由整理员盖章归属及单一当前槽位决定新执行；不取代目前仍保留的 settle、目录/镜像约定。
- [ADR 0031](0031-heard-in-the-live-turn-and-plans-closed-on-evidence.md)：不让 Bot 声明任务 id、靠 worker 继承，以及用户群消息默认改道。`work_on` 声明受代码校验；旧观察推进和交接检查不冒充 P4e 审查。
- [ADR 0016](0016-group-one-live-turn-per-bot.md)：同 Bot 全群只许一轮，改为同 Bot × 规划唯一执行，不同规划可受限并行。
- [ADR 0032](0032-every-line-says-which-job-and-reaches-its-turns.md)：organizer 的 resume/join 候选选择和「本地回应段 + 别处工作段」是旧路径；新归属/收件按工作项处理。跨会话标注仍保留，不要求同一 Bot 为同一规划再开本地工作副本。

Partial supersession applies only to the level-2 contexts above: organizer filing/current-slot identity (0030), no Bot ticket ids and default user-group redirect (0031), one Bot turn per entire group (0016), and organizer resume/join plus duplicate local/elsewhere execution (0032). Directory/mirror conventions, existing evidence checks and cross-conversation labels remain. Existing ADRs are not edited by this change; their reciprocal supersession notices and final removal of old paths remain cleanup work.

## 取舍与验收边界 / Trade-offs and acceptance boundary

确定性证据不能理解每一句，所以宁可留未定并让桌面问/选；用户纠正是最后权威。锁定证据允许多值，代价是显示和持久收件/原话不能只看主列。I1b 防同规划重复，不保证错误规划归属时仍不重复付费；外部作业参数去重属于 P4d。保留兼容代码不是公称「所有开轮前模型已删除」：无负责人旧群仍参与判断，模型策略待 P5。

Deterministic evidence deliberately leaves ambiguity for a desk rather than pretending to understand every sentence. Multi-attribution requires full labels, inbox and quote relationships, not scalar-only projections. I1b prevents same-plan duplicates, not duplicate paid effects after a wrong plan filing; job deduplication is P4d. Keeping old-level code is a deliberate migration trade-off, with final cutover still outstanding.

协议依从真实探针在 grk-4.7-build-fast 和 gemini-3.8-flash-high 各 6 用例首次依从，退回率 0%（`dry_run:false`，父任务提供的记录），满足 <10% 的工具面门槛；这是提示契约依从，不是完整引擎验收。工作项/归属/桌面、API/界面和文档验证分开记录；新卡片已完成专项验证；本 ADR 不宣称完整场景、长活基准或全量阶段测试均已验收。

The parent-reported live protocol probe (`dry_run:false`) had 6 cases per model on grk-4.7-build-fast and gemini-3.8-flash-high, all first-attempt compliant, a 0% bounce rate against the <10% gate. That checks prompt-contract compliance, not complete engine behavior. Work-item/attribution/desk, API/interface and docs checks are separate; new-card scoped verification is confirmed, while this ADR does not certify full-phase suites or long-job benchmark acceptance.

不声称已实现 P4c 的结构化 delegate/线程复用/监督器与完整结束契约，P4d 的作业轮询，P4e 的 submit/review、approved 提交与分件审查返工，或 P5 的确定性模型选择和新学习。新增 stage/part 身份列不等于这些行为上线。[ADR 0041](0041-control-plane-holds-and-restarts.md) 的用户叫停及重启回执、[ADR 0042](0042-requirements-ledger.md) 的只提议数值替代/用户确认检查继续成立。

No implementation claim is made for structured delegate/thread reuse/supervision/full ending contracts (P4c), polling (P4d), submit/review/approved submissions/part review-rework (P4e), or deterministic model selection/new learning (P5). Stage/part identity columns do not activate those behaviors. ADR 0041's user holds/restart receipts and ADR 0042's proposed numeric replacements and user-confirmed checks remain in force.

具体接口、信号顺序、冷队列与继续保护见[行为说明](../behavior.md#work-item) / [Behavior](../behavior.en.md#work-item)；术语见 [CONTEXT](../../CONTEXT.md) / [English glossary](../../CONTEXT.en.md)。

## 2026-10-02 补记：2–4 级审计的修正 / Level 2–4 audit fixes

在把你的库升到 1 级以上之前做的一次审计找出几处会丢话或挂错的地方，本 ADR 范围内的修正如下：候选集按 spec §8.4 收窄，别的会话的规划只经被叫 Bot 的未关工作项或 24 小时内的执行段进来，Bot 只是群成员不算（私聊里的一句话曾被挂到它从没碰过的群规划）；只是「可能是」叫停或继续的话（`possible_control`）照常归属，只有应用的控制行不参加；会话里这个 Bot 的桌面段还开着时，下一句没归属的话由它听进，不再开第二段同一工作项而被唯一约束拒掉；段结束时工作项离开 running（2 级没有结束契约来改它，启动时也补上上一进程留下的）；「继续」在 2 级起按同一件事而不是同一会话限一段；Bot 等你回答提问时你打的话就是回答（spec §3.3）；新开规划和升到 2 级时按 §2.6 休眠旧事（含旧的 parked 规划）；新事标题去掉点名；一份放弃的 P4d 草稿留下的 `external_jobs` 表（缺 `task_id`/`state`）在打开时挪开，读它的地方按列判断。

An audit before raising the user's database above level 1 found these within this ADR's scope, now fixed: candidates narrowed to spec §8.4, so another conversation's plan enters only through the called Bot's open work item or a segment in the last 24 hours, never group membership alone (a direct line had been filed under a group plan the Bot never touched); a line that only *might* be a stop or a go on (`possible_control`) is filed like any line, only app control lines staying out; with the Bot's desk segment open in the conversation, the next unfiled line is heard there instead of opening a second segment on the same work item and being refused by I1; work items leave `running` when their segment ends (level 2 has no end contract to move them, and boot settles what a dead process left); Continue is limited per job rather than per conversation from level 2; a line you type while the Bot waits on its question is the answer (spec §3.3); opening a plan and going up to level 2 apply §2.6 dormancy (old parked plans included); new jobs are titled without the names a line mentions; an abandoned P4d draft's `external_jobs` table (without `task_id`/`state`) is set aside at open, and its reader checks columns, not the name.

## 2026-10-03 补记：紧接 Bot 那句话的话 / A line right after the Bot's line

默认来源多了一条，先于 6–8 读（规则 9）：你和 Bot 的私聊里，紧接在 Bot 那句话之后、中间没有你别的话、两小时内、不是引用回复的一句，归到那句话所在的事，像隐式的引用回复；日程的常驻规划和这一次的日期任务也算，这是唯一能默认到日程规划的一条。那件事已被验收或作废时不用。起因：2026-10-03 01:10 日报交出，01:13 你说「标题跟 LOGO 没有对齐，而且太小」，日程规划不进候选，规则 6 把它归到了这个私聊里唯一另一件开着的、三天前的地址任务上，书记员把修改要求记进了那件事，两轮修改改的是日程的文件。只在私聊里读：群里最后说话的 Bot 常不是你在对它说话的那个，群仍按 8 和负责人。手动改归属的列表也列出日程规划（最新一次的任务排第一），标签因此写得出它的名字。

One more default, read before 6–8 (rule 9): in your direct with a Bot, a line right after the Bot's line — nothing of yours in between, within two hours, not a quoted reply — goes where that line went, as an implicit quoted reply; a routine's standing plan and this run's dated ticket included, the one default that reaches a routine plan. A job since accepted or abandoned is skipped. Why: on 2026-10-03 the brief was handed over at 01:10 and at 01:13 you said 「标题跟 LOGO 没有对齐，而且太小」; routine plans are no candidates, so rule 6 filed it under the only other job open in that direct, a three-day-old address job, the scribe wrote the fix into that job's ledger, and two turns on it rewrote the routine's files. Directs only: in a group the last Bot to speak is often not the one you are talking to, and groups keep rule 8 and the lead. The manual attribution list now includes routine plans (latest run's ticket first), so their tag can name them.

## 2026-10-03 补记：用一句话新开一件事 / A new job from a line

你手动改归属原来只能选已有的事：一句新需求被默认归到旧事上（规则 6），你只能叫停再说一遍。现在你的话可以「新开一件事」：用这句话开一件新事（名字照这句话、去掉点名，带一张同名产出任务，私聊里交给那个 Bot），再按你的纠正改归过去；`PATCH /v1/messages/:id/attribution {new_plan:{title?}}`，只收你自己的话。另外，任何纠正之后，还在跑、读过这句话、却在别的事上（或还在桌面上）的那一段会收到一条应用提示，说这句改归到了哪里、别再按它动手；原来纠正只送到新目标，旧的那一段照旧在错的事里做完。读过它的 Bot 在新目标上另开一段，规则不变。

Your manual correction could only pick a job that existed, so a new request filed under an old job by default (rule 6) could only be stopped and said again. A line of yours can now be made "a new job": a job opened from it (named after it without the Bots it names, with a ticket of the same name, the direct's Bot on it) and the line filed there as your correction; `PATCH /v1/messages/:id/attribution {new_plan:{title?}}`, for your own lines only. And after any correction, a segment still running that read the line on another job (or at its desk) gets an app note saying where the line went and not to act on it there; before, the correction only reached the new target and the old segment finished the line in the wrong job. The Bots that read it still start on it in a segment of their own on the new target.

## 2026-10-03 补记：同一件事里换任务 / Moving to another ticket of the same job

I8 只允许一段的目录在动手之前变一次。原来这只用于「拆出新事」：一段绑到某张任务（或整件事）后，就算什么都没做，也换不到同一件事的另一张任务。负责人被叫醒得知宣传语已通过，想接着做自己的海报，`work_on` 被拒，只能等监督器几分钟后另开一段。现在同一件事里的另一张任务，对还没写过文件、没跑过命令、目录没用过的一段开放，判断和拆出新事一样；换到别的事仍然不行。

I8 lets a segment's directory change once, before any effect. That was only used to split a new job off: a segment bound to one ticket (or to the whole job) could not move to another ticket of the same job, even having done nothing. A lead woken with the slogans approved was refused `work_on` for its own poster and waited minutes for the supervisor to open a segment on it. Now another ticket of the same job is open to a segment that has written no file, run no command and not used its directory, judged as a split is; another job is still refused.
