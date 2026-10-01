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
