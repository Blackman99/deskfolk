# 显式委派、事件等待与结束契约 / Explicit delegation, event waits and ending contracts

Status: partially implemented — P4c round-1 checkpoint, not accepted as the full phase. The supervisor (24c) is now [ADR 0045](0045-supervisor.md), at engine level 4; implicit submission and the remaining ending safeguards are still pending.

[ADR 0040](0040-agent-kernel-the-job-owns-state.md) 的 P4c 要让交出去的活由工作项记着，而不是靠两个人私聊最后一句或内存里「静下来十秒」的计时器猜是否交回。09-29 的回执空转证明普通发言不应自动派工；重启丢回报和任务无人接球说明结束不能只看模型是否停笔。本轮先接入显式委派和结束事实，记录剩余缺口，不把部分开关当成完整持续推进。

P4c of ADR 0040 makes work items hold handed-off obligations, rather than guessing from the last private line or a ten-second in-memory quiet timer. Acknowledgment loops show why ordinary speech must not assign work; lost reports and orphaned tasks show why stopping prose is not a completion contract. This checkpoint wires explicit delegation and ending facts while documenting what is still missing.

## 已接入的决定 / Wired decisions

1. **版本边界 / Version boundary.** `ENGINE_LEVELS.delegation = 3`，启用时兼容地板为 3，`SCHEMA_LEVEL=3`。旧二进制会把私聊通知当叫醒、按会话替换等待，因此不是只加几张表就能安全共用；0–2 级保留原私聊、create_direct 和发言结束语义，未物理删除。Level 3 enables the new semantics and raises the floor; levels 0–2 retain legacy private-message/creation/ending paths, not physically removed code.
2. **具名请求 / Named request.** `delegate` 由未被叫停、精确绑定的运行中工作段发起，校验另一个在场 Bot、同规划任务/分件和生效需求。记录发送方、接收方、发起轮和期待 deliverable/review/answer；接收方工作项可复用，受 I1/I1b、名额和叫停。默认结束本段并 waiting，`continue:true` 继续、不开等待。A request persists independently of turns. Its waking inbox is priority 3; it is not an ordinary message disguised as delegation.
3. **协作私聊 / Pair direct.** 精确两个 Bot × 同一规划复用一条未归档私聊，方向无关，不混不同规划，不建新会话种类。你仍只读。普通发言、收尾和点名在场对方都是 `peer_note`、`wakes=0`；点不在场的第三位或未知名先报 `use_delegate`、不落消息。3 级不提供 create_direct，直接调用也拒绝。Ordinary pair-direct chatter never wakes or satisfies a delegation. Group mentions still wake under existing guards.
4. **答案交回 / Answer result.** 当前引擎只把精确接收工作项的 `end_turn({reason:"answered",answer})` 用于 `expects=answer` 的未关闭请求，一次写 replied、解决匹配等待、投 priority=2 结果收件，符合准入的原委派方可醒；叫停仍扣住结果。底层 submission 引用校验不代表 submit/review 路径已上线，deliverable/review 期待仍待结构化交付。Answer results are once-only and auditable; prose closings or ordinary sends are not results, and held recipients never cause holds to be bypassed.
5. **事件等待与连带叫停 / Event waits and cascades.** `delegation_wait` 在各级别的 due 扫描都排除；匹配回复/取消才解决。3 级 timer 去重按精确工作项/键，挂起恢复不让另一 timer 覆盖委派等待。叫停下游来自仍 open、绑定一致的委派边，在建立时捕获为 Bot × 规划目标，不信单个 delegated_by；helper 的其他规划不一起停。Event waits are not periodic polling; cascades capture durable relationships without granting a sender ownership of an entire Bot.
6. **取消和只读视图 / Cancellation and projection.** Bot 归档/删除、相关会话清空/删除取消未完成委派；接收方归档仅给仍符合准入的原发送者一次叫醒取消结果，发送者归档不醒自己，清空/删除会话全是 wakes=0。只读 GET 规划/会话 delegations、实时 delegation.changed 和补拉把请求/交回/等待/held 投影到协作私聊，due_at 是实际可空值、不显示占位时钟。父任务确认了两个浏览器的合成界面验证，不是付费真实模型验收。Cancellation is not completion; read-only views do not introduce user delegation buttons or fabricated due times.

## 已接入的结束事实与缺口 / Ending facts and gaps

非终止的进度消息不丢后续写出的文件：未引用路径跟踪让收尾仍可引用产物，不把引用当真正 implicit submission。真实观察到的任务阶段变化按匹配轮记 ticket.stage_changed，重置当前无进展计数，不用随手改说明充当进展。Bot 归档关闭工作项、结束执行并提交后中止引擎，副作用前核对 Bot 资格和执行权，不能借迟到补全继续写。

Nonterminal progress posts retain later uncited files for closing citation, not real implicit submission. Observed ticket-stage changes record authoritative matching-turn progress instead of counting arbitrary prose edits. Archival closes work, ends/aborts execution and rechecks Bot eligibility/authority before effects, preventing a late completion from writing.

`send_message` 在 3 级不再终止本段；面向有用户的会话、不带 `parent_id` 的进度最多三条。当前 parent_id 是豁免标记，尚无「真正回答用户问题」的语义分类，不把任意引用说成经过确认的豁免。

Level-3 sends are nonterminal, with at most three user-visible non-parented progress lines. The current parent-id exemption is mechanical, not an implemented real-question classification.

`finishWork` 及引擎接入校验 reason（done/answered/nothing_new/blocked/gave_up）、仍运行、精确工作项/规划/任务和叫停；要求已读用户/批注收件逐条处置。desk/readonly 纯文字按 answered，工作纯文字按同一义务契约；done 有义务且没有有效等待先退回一次，再按 nothing_new 收住；真实等待保留 waiting，没有义务可 idle/closed。连续两次无进展且仍有义务可 blocked 并通知，阶段或可信当前工作进展可重置计数；收件未处置/义务未收口的退回加归属退回有界，work_on/end_turn 抛出的非法 reason/缺必需字段等参数错误已计入同一预算，同跳后续副作用被压住；delegate 的直接返回/抛错校验同样计数而不重复，当前已实现 work_on/delegate/end_turn 共用两次预算；未来 submit/review/wait_for 尚待实现并加入同一约束，不借本轮宣称它们已覆盖；结束原因和 work.ended 落库，但不是在工具结果记完之前就把 turn 终态写下。

The domain function and engine integration validate an exact live binding and holds, require read user/annotation dispositions, and treat prose under the same obligations as explicit endings. A valid event/timer wait stays waiting; unfinished work bounces once, then ends as nothing_new. Two no-progress endings with obligations can block and notify. Inbox/unfinished-work bounces and filing refusals are budgeted, as are thrown malformed work_on/end_turn argument errors, suppressing later same-hop effects. Returned/thrown delegate failures count once too: the implemented work_on/delegate/end_turn contracts share the two-refusal budget. Future submit/review/wait_for remain unimplemented and must adopt it when added. Reasons/events persist before the engine makes the turn terminal after tool results; this is not a submission or supervision claim.

**本轮不接受为已完成的项 / Not accepted as complete:**

- **24b / I5**：I5 的 3 级 INSERT/每次 UPDATE 库触发器已接入：绑定工作项的 completed/stopped/interrupted/redirected 必须有非空白 end_reason，不限枚举；0–2 级豁免，历史终态一次以 status 补空缺，不覆盖已有显式原因。3 级 blocked 返回的 needs_from_user 只显示一行文字；持久可回答的提问卡在 4 级（[ADR 0045](0045-supervisor.md) 第 9 条）。旧收尾自检正则仍被调用，claimsVerification 保留与推广到私聊还需按最终接入核对。I5 triggers are implemented at level 3, with nonblank reasons, legacy exemption and one-time historical backfill; the persistent blocked-question card arrives at level 4 (ADR 0045); regex removal remains pending.
- **隐式交付 / Implicit submission**：`implicitSubmission.implemented=false`。只有本段引用、任务目录下非保留产物的候选元数据，没有核对文件存在/新哈希、运行绑定检查、保存 origin=implicit submission 或推进 submitted/approved。这条设计要求不能降成「交了路径就是交付」。Citation metadata is a seam, not implicit submission; the approved existence/hash/check/stored-submission contract remains required.
- **24c / Supervisor**：已在 4 级实现，见 [ADR 0045](0045-supervisor.md)：持球者推导、没人推的任务 2/10 分钟门槛与每个进展周期 2 次叫回、周期 I6 核对、needs_attention 每小时最多 3 次续跑、owner 迁移与读出的负责人、按 clean/crash/dev 续跑和结果不明的外部调用守卫。3 级没有这些。Implemented at level 4 (ADR 0045); level 3 has none of it.
- **旧推进退场 / Legacy retirement**：4 级不再运行 plan-watch/plan_nudge 与 report_back，之前订下未触发的在触发时作废（ADR 0045 第 10 条）；3 级仍有它们。settle、收尾正则及兼容 hear 路径各级都还在，物理删除留给 P6。At level 4 the plan call-back and report-back no longer run; settle, closing regexes and the hear paths remain at every level until P6.
- **后续阶段 / Later phases**：P4d 外部作业轮询/去重，P4e submit/review/approved 与分件返工，P5 模型策略/学习没有交付声明。Existing fields or low-level submission validation do not activate later phases.

## 部分取代与取舍 / Partial supersession and trade-offs

在 **3 级显式委派路径内**，本轮部分取代 [ADR 0020](0020-bot-direct-per-trigger.md) 的每次另开私聊，改为精确 Bot 对 × 规划复用；部分取代 [ADR 0028](0028-job-brief-check-back-and-clarification.md) 的 send_message 必结束本段、只以 timer 等交回。保留用户只读、原话和工作项约束。旧级别兼容仍在。

Within the level-3 explicit-delegation path, this partially supersedes ADR 0020's fresh direct per trigger and ADR 0028's terminal sends/timer-only waiting, retaining user read-only access, quotes and work-item constraints. Legacy levels remain supported.

[ADR 0039](0039-plans-with-work-left-are-called-back.md) 的规划叫回在 3 级**没有**被取代；4 级起由监督器取代（[ADR 0045](0045-supervisor.md)），双方都已注明。[ADR 0043](0043-work-items-and-attribution.md) 的 P4b 是历史边界，当前 3 级是在它上面增量切换，不把历史的未实现句子当当前领域定义。

ADR 0039's plan callbacks are not superseded at level 3; from level 4 the supervisor (ADR 0045) supersedes them, noted on both sides. ADR 0043 records the historical P4b boundary; level 3 is an incremental switch on top of it, not retroactive rewriting of history.

把普通通知与工作请求分开能消掉「收到→收到」的即时叫醒环，代价是 Bot 必须显式声明期待结果，且失败/取消/被叫停也要留持久事实。只接入回答型交回让本轮闭环窄而可验证；其余期待保留为义务，不能凭一句模型收尾自动算交付。剩余监督器和交付工作仍按原 spec 验收，不以这份部分 ADR 代替。

Separating notes from requests stops immediate acknowledgment wake loops at the cost of explicit expected results and durable failure/cancellation/hold facts. Answer-only return is a narrow verifiable slice; other expectations remain obligations, never satisfied by a model's claim. Remaining supervision and submission work still require the approved specification's acceptance.

具体当前行为与未完成项见[行为说明](../behavior.md#delegation) / [Behavior](../behavior.en.md#delegation)，术语见 [CONTEXT](../../CONTEXT.md) / [English glossary](../../CONTEXT.en.md)。

## 2026-10-02 补记：纯文字收尾与无进展通知 / Prose endings and the no-progress notice

纯文字收尾不再因为没逐条处置你的话被退回：这一段读过、没说怎么处理的用户收件都记为被这段文字回答（answered），不会两次退回后变成 needs_attention、再被监督器叫醒；`end_turn` 仍要逐条处置。连续两次无进展、仍有义务时的通知按界面语言写，点出这件事和 Bot（原来是写死的英文）。

群里两个 Bot 互相点名回「收到，已对齐」的也按回执接回执处理：去掉点名后是光秃秃的回执、它那一轮正是被对方同样的回执叫醒、两轮都没跑命令时，不叫醒谁（各级别），审计里这样的对话一次跑了 20 轮。

In a group, two Bots naming each other with 「收到，已对齐」 now fall under the nod-to-a-nod rule too: names aside a bare acknowledgement, its turn woken by the other's, neither turn having run a command — it wakes nobody (every level); the audit saw such an exchange run 20 turns.

A prose ending no longer bounces for undisposed mail: the user mail the segment read and gave no word about is recorded as answered by the prose, rather than bouncing twice into needs_attention and a supervisor wake; `end_turn` still disposes item by item. The notice after two no-progress endings with obligations is in your interface language and names the job and the Bot (it was hard-coded English).
