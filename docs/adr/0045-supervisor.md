# 监督器：持球者、没人推的任务、需要处理的工作与重启续跑 / Supervisor: ball holder, tickets nobody moves, attention and restart resume

Status: implemented at engine level 4 (`ENGINE_LEVELS.supervision`), part of ADR 0040's P4c. External jobs (P4d) and the board's ball display are not part of it; reviewer assignment, submitted → approved and implicit submission came at level 5 with [ADR 0046](0046-submissions-and-reviews.md). See the gaps below.

[ADR 0040](0040-agent-kernel-the-job-owns-state.md) §5 要让「没做完不停下」由库里的事实保证，而不是进程里的计时器。在这之前推进兜底有三条：[ADR 0039](0039-plans-with-work-left-are-called-back.md) 的规划叫回（`plan_nudge`，按第一个未完成任务的 worker 或最后说话的 Bot 挑人，「任务都交出、记录说还有活」时等 10 分钟的计时器在进程里）、Bot↔Bot 私聊静下来后的 report_back（10 秒计时器在进程里），以及 [ADR 0041](0041-control-plane-holds-and-restarts.md) 的重启通知（一律等你按「继续」）。重启会丢掉计时器；叫回不看谁真正持球；重启后每次都要你手动续跑，09-26 那次停了 7.6 小时。

ADR 0040 §5 wants "not stopping before done" to rest on facts in the database, not timers in a process. Before this, three things nudged work along: ADR 0039's plan call-back (in-memory timers, picking the worker of the first open ticket or whoever spoke last), the report-back after a quiet Bot↔Bot direct (an in-memory 10-second timer), and ADR 0041's restart notice (always waiting for your button). A restart lost the timers, the call-back did not look at who really held the ball, and after a restart you resumed every job by hand.

## 决定 / Decisions

1. **版本边界 / Version boundary.** `ENGINE_LEVELS.supervision = 4`，`SCHEMA_LEVEL = 4`，启用时兼容地板抬到 4。3 级的二进制会在监督器的记录之外再跑一遍已退场的规划叫回和 report_back（一次停滞两次叫醒），blocked 的工作没有可答的地方，重启后也不查最后一次外部调用就续跑——这些是旧版本会读错的语义（ADR 0040 的 B 类）。开发者的放行（ADR 0041）只覆盖它接受时的那一级：库停在 3 级、放行记着 3 时，这一版要再接受一次才会到 4。Level 4 raises the floor to 4; a level-3 build would run the retired call-backs on top of the supervisor's records, leave blocked work with nothing to answer, and resume without checking the last external call. A developer's opt-in covers only the level it accepted.

2. **持球者 / Ball holder** (`store/supervisor.ts` `ballHolder`)，对每张没收口的任务按顺序推导：未关闭的委派 → 接收方的工作项；有待回答的提问（活轮的 ask，或 blocked 工作项的持久提问）或 blocked → 你；叫停覆盖它、或覆盖它依赖的任务 → 你（已暂停）；待验收（`review`，没有绑在它上面、上次跑失败的检查）→ 你（审查者是 P4e 的）；否则任务 owner → 规划负责人 → 没人认领（你）。外部作业（交给轮询器）在 P4d。Owner 是 `tickets.owner_bot_id`，与 `worker` 同写；升级时一次性从仍能接活的 worker 导入，没有就取这张任务上执行段最多、仍能接活的 Bot。规划负责人**读出来、不写回**：存了 `lead_bot_id` 用它，否则开出规划的 Bot、群里你确认的负责人、规划里执行段最多的 Bot——写回会改变你的话被谁接（ADR 0043 的路由读存下的负责人）。任务依赖 `tickets.depends_on` 只来自你（`PATCH /v1/tickets/:id { depends_on }`，本机和远端），只能是同一规划的其他任务，不能成环。

3. **一个 tick / One tick.** 调度器每 15 秒一拍里，在到期回看之前跑 `supervisorTick`：一次写入里依次做 I6 修复、「需要处理」的续跑、没人推的任务的叫回。每个决定都是库里的一行：叫回和续跑各记一条已触发的 `check_backs`（`kind = supervisor`，`wait_spec` 写明原因、尝试次数、进展周期或重启），修复、重启和通知记 `work_events`（`supervisor.*`）。时钟是参数，重启不丢期限、不重复叫醒。库升到 4 级时记一条 `engine.level_raised`；在那之前就已静下来的任务、在那之前就在等待或需要处理的工作，监督器不在第一拍里一起叫醒，等它们里有了新动静再管——否则升级时开着的几十件旧规划会同时被叫回。事件驱动的推进不等 tick：委派的回复和取消、你对提问的回答、排进收件的话在同一次写入里排队，并立即派发；定时回看由调度器到点触发。Every decision is a row; the clock is a parameter; work already quiet before the level-4 raise (`engine.level_raised`) is left until something happens in it; event-driven transitions (delegation replies and cancellations, your answers, queued mail) queue in their own write and dispatch at once.

4. **没人推的任务 / Tickets nobody moves.** 持球者是 owner、负责人或未回复委派的接收方，并且它在这件事上没有活段、没有有效等待（未触发的回看、等待中/排队/运行/需要处理/blocked 的工作项）、没有排着的收件；规划 active、没休眠、不是日程的、没被扣住；依赖都已完成。静默门槛默认 **2 分钟**，从这件事最后的动静（归到它的话、它的执行段活动、它的工作记录）算起；在你在场的会话里，这件事的最后一条是 Bot 说的、而且晚于你在这件事里的最后一句时，改为 **10 分钟**，从这件事最后的动静和你在那个会话的最后一句两者中较晚的算起——不判断是不是问句。叫醒是一条只给它看的事实说明，排进它的工作项（`source = system`，优先级 3）。**每个进展周期最多 2 次**；之后在你在场的会话里留一行「这件事停下了」（应用的行，`control.kind = supervisor`，不带按钮），外加一条通知，每个周期一次。进展只认工作记录里的事件：任务阶段变化（看板、整理和观察到的工作都记 `ticket.stage_changed`）、交付与审查（P4e 写入后）、检查第一次通过（模型判的衔接检查要连续两次通过，`check.first_passed`）、任务目录下内容哈希新的产物（执行段结束时对写过的文件流式算 SHA-256，`artifact.changed`）。不看 `updated_at`，不看说明文字。比 spec 多一条：未回复委派的接收方空闲时也算持球、会被叫回（叫醒里带上那项请求），否则等它的一方永远在等。

5. **需要处理 / Needs attention.** 执行段被中断（重启、排空）、失败（重试一次仍失败、卡住超时）、结束契约的退回预算用尽、等待失效（I6），或运行中却没有活段且最后一段是中断的，工作项转 `needs_attention`（中断和失败在写下终态的同一次写入里）。监督器带着「上次断在哪」续跑：有那一段自己的「中断」或失败行时，照它自己的「继续」做（同一个会话、同样受叫停、那一行记为已接着做、通知随之解决）；没有时排一条只给 Bot 看的说明。**每个工作项每小时最多 3 次**，之后告诉你一次。持球者在别人（另一个委派接收方）、任务已收口、叫停覆盖时不续。

6. **I6.** waiting 却没有打开的等待记录（委派被取消、对方工作项关闭、回看不在了）的，转 `needs_attention`，同一拍里按第 5 条排上「这一等不再成立」的说明。被叫停覆盖的等待算有效等待。

7. **重启 / Restarts** (§5.6)。启动时 `restart.announce` 每次都记 `daemon.restart`（原因、被打断的轮、这次运行的 id），并为被打断、绑着规划的每一段记 `supervisor.restart`；通知照 ADR 0041 发，最后一句换成续跑安排：

   | 原因 | 续跑 |
   |---|---|
   | clean | 下一拍立即续跑 |
   | crash | 守护进程稳定运行 60 秒后续跑一次 |
   | dev | 稳定 60 秒、且这次启动前 5 分钟内没有别的启动、之后也没有再重启，才续跑；否则等你按「继续」 |
   | 通用 | 最后一步是结果不明的外部调用，不自动续跑；被叫停覆盖的等解除；你按了「不续」的不续；每小时最多 3 次 |

   每段续跑走它的「中断」行，所以重启通知的每一行都被接着做之后，通知记为已继续、通知解决。一段在这次启动之前被中断、却没有记录点名（上一次的记录丢了）的，按这次启动的原因处理。续跑一次之后，同一段再出问题就是普通的「需要处理」。

8. **副作用记录 / Effect ledger** (`tool_executions`)。4 级起，`write_file`、`delete_file`、`shell` 和非只读的 MCP 调用在动手之前记一行开始（同一个调用 id 只开始一次，重复的不再执行），结束时记结果：成功、被拒（没发出去）、失败，或**不明**（中止时、MCP 调用发出后报错、超时；执行段结束时还没结束的也记成不明）。监督器只把 shell 和 MCP 的不明当作「结果不明的外部副作用」；更早的段没有记录、只有 `turn_runs` 里的 shell/MCP 运行，续跑中断的段时也按不明处理。The ledger is evidence, never a replay queue.

9. **blocked 的持久提问 / Durable blocked questions.** 4 级起 `end_turn({reason:"blocked", needs_from_user})` 留下一张提问卡（`control.kind = work_question`，在这件事的会话，否则规划的会话，否则你和这个 Bot 的私聊），附一条 `ask` 通知；工作项 `waiting_on = {kind:"user"}`。`POST /v1/messages/:id/work-answer { body }`（本机和远端白名单）写下你的原话：一次，带请求 id，同一请求重发不重复；作为你的一行进这件事的收件，工作项排队、立即派发；叫停覆盖时只被扣住，不解除任何叫停。答过、过时（之后又有新的提问）、来源段还没结束、工作关闭、Bot 归档、会话归档的，一律拒绝。3 级以下照旧只发一行文字。

10. **退场 / Retired at level 4.** 规划叫回（`plan-watch` 的对账和 10 分钟计时器）与 report_back（`direct-report` 的 10 秒计时器）在 4 级不再运行；之前订下、还没触发的 `plan_nudge` 和 report-back 回看在触发时作废。观察任务进展（`observeTicket`）各级都保留。0–3 级的路径原样保留。

11. **排队顺序 / Queue order.** 排队派发按收件优先级：你的话 1 → 委派结果 2 → 监督器叫醒和委派请求 3 → Bot 自己约的回看和日程 4，同级按先后。

## 缺口 / Not done

- **外部作业**（P4d）：持球者不会落到轮询器；`tick.unsupported` 列出 `external_jobs`。
- **审查者指派与 submitted → approved**（P4e，§5.3.7）：4 级时待验收的任务球在你，`reviewer_assignment` 同样列为不支持。5 级由 [ADR 0046](0046-submissions-and-reviews.md) 接上：审查中的球在审查者，没有审查者的交付下一拍由应用按检查放行。
- **隐式交付**（24b）：4 级时产物哈希只算进展，不生成交付；5 级起由 ADR 0046 生成。
- **规划级的检查**：没绑任何任务的检查失败时，0–3 级的规划叫回会叫人，4 级的监督器按任务看，不会；绑在任务上的会让球回到 owner。规划级的放行和返工在 P4e。
- **看板上的「球在：…」** 和依赖的编辑界面还没有；`ballHolder` 和 `depends_on` 目前只在库和 API 里。
- **旧路径的物理删除**：settle、收尾正则、`hearOrStart`/`hearAcross`/`reopenForUnheard` 仍在，按 ADR 0040 的 P6 收缩阶段处理。
- 开发版连续重启时，第一次的通知说「1 分钟后会自动接着做」，第二次没有新的打断就不另发通知；那一行的「继续」仍可用。
- 「说测过却没跑命令」（`claimsVerification`）在 Bot 之间线程的推广不在本 ADR。

## 取代 / Supersedes

- 4 级起取代 [ADR 0039](0039-plans-with-work-left-are-called-back.md) 的规划叫回：挑人看持球者，不看第一个未完成任务的 worker 或最后说话的人；10 分钟门槛推广成「你在场的会话里 Bot 说了最后一句」；进度看工作记录，不看要点里的进展文字；叫回记在库里。
- 4 级起取代 [ADR 0041](0041-control-plane-holds-and-restarts.md) 的「重启一律等你按」：按原因续跑，见上表；通知和按钮照旧。
- 3 级的 [ADR 0044](0044-delegation-and-end-contract.md) 把 blocked 的需要记成一行通知、把监督器列为待做；4 级由本文接上。

## 取舍 / Trade-offs

- **负责人读出、不写回。** 写回能让板面更稳定，但会悄悄改变群里没点名的话交给谁；读出的规则和 spec 的迁移规则一样，代价是「执行段最多」这一档会随工作变化。
- **接收方也算持球。** spec 只写 owner 和负责人；不叫回接收方，等它的委派方就永远在等。它受同样的门槛和预算管。
- **续跑走「继续」。** 同一段的「中断」行、同一个会话、同样的叫停和名额，和你按「继续」完全一样；代价是续跑的那一段在原来的会话里，而不是这件事的主会话。
- **不明就不续。** 记录不到结果的外部调用宁可停下问你，也不冒重复付费的险；本地文件写入重做无害，不算。

具体行为见[行为说明](../behavior.md#supervisor) / [Behavior](../behavior.en.md#supervisor)，术语见 [CONTEXT](../../CONTEXT.md) / [English glossary](../../CONTEXT.en.md)。

## 2026-10-02 补记：拒绝的续跑与结束后的工作项 / Refused pick-ups and work left running

续跑先记一条已触发的 `check_backs` 再让引擎照「继续」做；引擎做不成时（会话已归档、这件事已在别处做着）这条记录作废、记 `supervisor.pickup_refused`，不算尝试、不占每小时 3 次，下一拍改为排一条说明叫醒，不再从同一行续。原先同一会话里这个 Bot 在做另一件事也会被拒、白耗预算，现在 2 级起「继续」本就不按会话限（[ADR 0043](0043-work-items-and-attribution.md) 补记）。另外，I6 的那一拍也修运行中却没有活段的工作项：最后一段中断或失败的转 needs_attention，别的结束（Stop 后用按钮解除叫停、契约没看到的收尾）且没被叫停的转 idle，叫回才找得到它——之前 Stop 再按按钮解除后没人再推这件事。

A pick-up records its fired `check_backs` row before the engine continues the line; when the engine cannot (conversation archived, job already under way elsewhere) the row is voided and `supervisor.pickup_refused` recorded — no attempt, none of the three an hour — and the next tick wakes the work by a queued line rather than retrying that line. Before, the same Bot working on another job in the same conversation was refused too and burned the budget; from level 2 Continue is no longer limited per conversation (ADR 0043's note). The tick's repair now also covers running work with no live segment: a last segment interrupted or failed needs attention, any other ending (a Stop lifted with its button, a closing the contract did not see) not under a stop goes idle, where the call-backs find it — before, nothing pushed such a job again.
