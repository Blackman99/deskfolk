# 私聊只从你在场的会话开，谈完回那里交代 / Directs open from your conversations and report back there

Status: implemented 2026-10-17. Narrows [ADR 0091](0091-bot-directs-are-back-and-open-in-a-popup.md) decision 1 (`create_direct` at every level, from any session). Takes the report-back of a direct a Bot opened with `create_direct` out of [ADR 0045](0045-supervisor.md) decision 10, which retired report_back at level 4; a delegation thread stays retired there.

2026-10-17 你说 Bot 与 Bot 的私聊里还能再开私聊，这样不对：一轮私聊结束要汇总到原会话，要开私聊只能从真实会话开。查下来两件事都成立。`create_direct` 在哪个会话都能调，私聊里开出的私聊挂在上一层私聊下面，层层只读。私聊谈完也没人回原会话：0–3 级靠 `direct-report` 在私聊静下来后叫回开启方，ADR 0045 在 4 级起把它退了，理由是委派的回复和监督器会把发起方带回来；可那是委派线程的事，ADR 0091 把 `create_direct` 加回每个级别时没有接上任何东西。你在 8 级，2026-10-15 以后的 Bot 私聊在原会话里一次叫回都没有。

On 2026-10-17 you said a Bot↔Bot direct should not be able to open another: once a direct's round is over it should be summed up in the conversation it came from, and a direct should only open from a real conversation. Both held. `create_direct` worked from any session, so a direct opened inside a direct hung under the one above, read-only all the way down. And nothing brought a direct's outcome back: below level 4 `direct-report` called the opener back once the direct went quiet, ADR 0045 retired that from level 4 because a delegation's answer and the supervisor bring the delegator back, but that covers delegation threads, and ADR 0091 brought `create_direct` back at every level with nothing to report. You run level 8; no Bot direct since 2026-10-15 had reported back.

## 决定 / Decisions

1. **只从你在场的会话开 / Only from a session you are in.** `create_direct` 在你不在场的会话里（Bot 与 Bot 的私聊、委派线程）回 `not_a_member`，告诉 Bot 在这里谈完，结果会带回原会话。这一调用什么也不开，所以不经过「先选归属」那道闸（`beforeEffect` 放它过去，和 `ask_user` 一样落到自己的拒绝）。工具说明写明这一条，以及静下来后会叫回。工具单不按会话过滤：拒绝和 `ask_user` 在私聊里的做法一致。 / In a session you are not in (a Bot↔Bot direct, a delegation thread) `create_direct` answers `not_a_member`, telling the Bot to finish there since the outcome goes back. The call opens nothing, so the filing gate lets it through to its own refusal, as with `ask_user`. The tool's description says so, and that the opener is called back once the direct goes quiet. The tool list is not filtered per session; the refusal matches `ask_user`'s in a direct.

2. **`create_direct` 开的私聊每个级别都汇报 / A `create_direct` direct reports back at every level.** `direct-report` 的 4 级门只挡委派线程（`isPairThread`）；`voidRetiredCallBack` 不再作废挂在这种私聊上、回它来源会话的那张回看。提示词沿用 0–3 级的那句：「你和 X 的私聊静下来了，最后一条是…。在这里交代这次私聊的结果。」 / The level-4 gate in `direct-report` now stops only delegation threads (`isPairThread`), and `voidRetiredCallBack` no longer voids a report-back hung in such a direct for the session it came from. The cue is the one levels 0–3 used: "Your direct with X has gone quiet; the last word was …. Report here how it came out."

3. **挂在开启方自己的一轮上 / Hung on the opener's own turn.** 3 级起回看必须挂在被叫的 Bot 自己的一轮上（`insertCheckBack`），以前挂在私聊最后一轮，多半是对方的，3 级时就会悄悄订不上。现在挂在开启方在这条私聊里最新的一轮（`quietDirect().openerTurnId`）；它一轮都没跑过就不叫回：对方的话已经进了它在别处正跑着的那一轮，或者对方根本没说话。0–2 级照旧挂在最后一轮。 / From level 3 a check-back must hang on a turn of the Bot it calls (`insertCheckBack`); hanging it on the direct's last turn, usually the other Bot's, silently failed there. It now hangs on the opener's newest turn in the direct (`quietDirect().openerTurnId`); with none, there is no call-back: the other Bot's words reached a turn of the opener's at work elsewhere, or nothing was said. Levels 0–2 still hang it on the last turn.

4. **叫回时带上这条私聊 / The direct rides with the call-back.** 原会话的转录窗口里看不到私聊，叫回那句只引了最后一条的 200 字，开启方能交代的只有这一句。现在叫回那一行（系统行，挂在私聊里那一轮上）在转录里下面附上这条私聊最近 20 条话，每条截到 1000 字（`context/transcript.ts` 的 `reportedDirect`），内置模型和外部代理的轮都一样。 / The origin's transcript window never shows the direct, and the cue quoted 200 characters of its last line, so that line was all the opener could report. The call-back's line (a system line hung on the turn in the direct) now carries the direct's latest 20 lines under it, each clipped to 1000 characters (`reportedDirect` in `context/transcript.ts`), for built-in and external-agent turns alike.

## 取舍 / Trade-offs

- **计时器又回到进程里 / A timer in the process again.** ADR 0045 想让推进靠库里的事实，不靠进程里的计时器；这里在 8 级重新用上 `direct-report` 的 10 秒计时器，重启落在窗口里就丢掉那一次汇报。换成监督器按库里的事实叫回是以后的事。 / ADR 0045 wanted progress to rest on database facts, not in-process timers; this brings `direct-report`'s 10-second timer back at level 8, and a restart inside the window drops that one report. Moving it onto the supervisor's facts is later work.
- **旧的嵌套私聊留着 / Old nested directs stay.** 以前从私聊里开出的私聊照旧能打开，弹窗的「来自 …」照旧回上一层；只是不再有新的。 / Directs opened from directs before this still open, and the popup's "From …" still goes back up one; no new ones are made.
- **没汇报的情形 / When no report comes.** 开启方没在私聊里跑过一轮就不叫回（见 3）；委派线程照旧由委派的回复和监督器负责。 / No call-back when the opener never ran in the direct (see 3); delegation threads stay with the delegation's answer and the supervisor.

## 实现 / Implementation

守护进程：`collab-tools/conversation.ts`（`createDirect` 拒绝）、`engine/tools.ts`（`beforeEffect` 放行这次拒绝）、`prompts/tools/collab.ts`（说明）、`engine/direct-report.ts`（4 级门只挡委派线程，挂在开启方的一轮上）、`store/check-backs.ts`（`quietDirect().openerTurnId`，`voidRetiredCallBack` 放过这种回看）、`context/transcript.ts`（`reportedDirect`）。测试：`bot-direct-wakes.test.ts`。
