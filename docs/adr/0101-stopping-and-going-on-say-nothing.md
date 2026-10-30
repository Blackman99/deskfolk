# 叫停和接着做什么都不说 / Stopping and going on say nothing

Status: implemented 2026-10-30. Takes back [ADR 0081](0081-a-stop-is-just-a-stop.md) #4 (the receipt's one line) and the receipt [ADR 0040](0040-agent-kernel-the-job-owns-state.md) P2 put in the conversation for every stop you say or choose; [ADR 0058](0058-the-app-asks-only-when-it-needs-you.md) already took it off a Stop pressed on a turn.

ADR 0081 之后，叫停已经是「你再说话就接着」，侧栏、会话行、头像都不再显示它，可你说的「停」、停止菜单和按钮叫的停仍在会话里回一张回执。12:28 你在开发助手的私聊里说「停」，应用回了一张：

> 已停下开发助手的全部工作（你 12:28 说的「停」）。
> - 当时没有在跑的，新的也不会再开。
> - 挂起 1 个回看，继续时恢复。
> - 此刻在跑：无。
> 你再对它说话，它就从你这句接着往下。

下面写着「已解除」。你说：「Bot 停止跟恢复以及内置的行为不要展示这种提示，是隐式的。」

After ADR 0081 a stop already went on with your next word and showed nowhere in the sidebar, the rows or the avatar, but a stop you said, chose from a stop menu or pressed on a button still put a receipt in the conversation. At 12:28 you said 「停」 in 开发助手's direct, and the app answered with the card above — "Stopped all of 开发助手's work (you said at 12:28: 「停」). Nothing was running; nothing new starts. 1 check-back set aside; it comes back when you lift the stop. Running now: nothing. Say anything more to it and it goes on from what you say." — with 「已解除」 ("Lifted") under it. You said: "Stopping and resuming a Bot are built-in behaviour; don't show this kind of notice. They are implicit."

## 决定 / Decisions

1. **叫停不回执 / A stop gets no receipt.** 你说的「停下」（读句读成只是叫停的）、群的停止菜单、流程图和菜单栏的叫停、话上和状态行上的「停下」按钮，都只建叫停、停掉它覆盖的在跑的轮，会话里一行都不写。在跑的停住就是回答，跟卡片上的 Stop（ADR 0058）和别的工具一样。停了哪几段、各停在哪一步、挂起的回看、搁置的规划、旁边还在做的 Bot，照旧记在叫停的 `effect` 上，流程图读它；菜单所在的会话记在工作记录的 `control.hold` 上。 / A stop you say (read as nothing but a stop), a group's stop menu, the flow board's and the menu bar's stops, and Stop on a line or a status line make the holds and end the turns they cover, and write nothing in the conversation. What was running stopping is the answer, as with a Stop on a turn (ADR 0058) and in any other tool. What it ended, the check-backs set aside, the plans parked and the Bots still working beside it are on the hold's `effect` as before, for the flow board; the menu's conversation is on the work log's `control.hold`.

2. **按钮解除也不回执 / A lift by button gets none either.** 话上的「继续」、旧回执和状态行上的「只停《…》」「只让 X 继续」「全部继续」解除叫停、让停下的活带说明重新开始，只在按钮上显示做过了（`control.acted`）。话上的「继续」按下时已经没有能解除的叫停，就什么都不做，不再回「没有被叫停。此刻在跑：无」。你说的「继续」从 ADR 0070 起就没有回执。 / "Continue" on a line, and "Only “…”", "Only X goes on" and "All go on" on an older receipt or a status line, lift and open the stopped work again on a note, and show it on the button alone (`control.acted`). "Continue" pressed with nothing left to lift does nothing, instead of answering "not stopped; running now: nothing". A go on you say has had no receipt since ADR 0070.

3. **回执的按钮跟着没了 / The receipt's buttons go with it.** 「撤销」不需要：你接着说就是。「扩大到所有 Bot」「一起停下《…》」：再说一句或用停止菜单。「只停《…》」：对 Bot 说清楚停哪件。「作废这件事」：「算了，停吧」只停下，作废在流程图上做。 / Undo is not needed: say what comes next. "Stop every Bot" and "Stop “…” too": say so, or use a stop menu. "Only “…”": tell the Bot which job to stop. "Drop this job": 「算了，停吧」 only stops; dropping the job is on the flow board.

## 不变 / Unchanged

- 叫停本身：范围、它挡住的叫醒和工具、你下一句话整条结束、只有说到的 Bot 接着做（ADR 0071、0081）。 / The stop itself: its scope, the wakes and tools it holds back, your next word ending it whole, only the Bots you speak to going on (ADRs 0071, 0081).
- 以前写下的回执照旧显示成应用的话，按钮照样能按；`MessageControl` 的 `receipt` 留着读它们。 / Receipts already written still show as the app's lines and their buttons still work; `MessageControl`'s `receipt` stays to read them.
- 有更大的、不随你的话结束的叫停挡着时，话上的「继续」仍回一条状态行，带「只让 X 继续」「全部继续」：那是要你决定的事（ADR 0058）。 / When a wider hold that no line ends is in the way, "Continue" on a line still answers with a status line offering "Only X goes on" and "All go on": that is yours to decide (ADR 0058).
- 花费上限的叫停、重启通知、监督器的那几行不在这里：它们是要你来接手的事。 / The spend cap's stop, the restart notice and the supervisor's lines are not this: they ask you to take over.

## 取舍 / Trade-offs

- **会话里看不到停了哪几段。** 回执是唯一一处列出它的地方（ADR 0081 的取舍）。现在要看就打开流程图；被停下的那一轮在它自己的会话里标着停下。 / Nothing in the conversation lists what a stop ended; the receipt was the one place that did (ADR 0081's trade-off). The flow board shows it, and a stopped turn is marked stopped where it ran.
- **说「停」时什么都没在跑，就什么都看不到。** 叫停照样建了，挡住之后会自己开的轮（回看、别的 Bot 的话），直到你开口。 / A 「停」 with nothing running shows nothing at all. The stop is made all the same and holds back what would start by itself (check-backs, other Bots' lines) until you speak.
- **「算了，停吧」不再顺手给「作废这件事」。** 那个按钮来自词表，以前也只是提议；作废要在流程图上做。 / 「算了，停吧」 no longer offers "Drop this job" on the side. The offer came from a word list and was only an offer; dropping a job is done on the flow board.

## 实现 / Implementation

`engine/stop/carry-out.ts`：`carryOut` 只建叫停、结束覆盖的轮、记 `effect` 和 `control.hold`，删去 `stopReceiptLine`、`planOffers`、`stopReceipt`；`stopByLine` 不再带 `offerCancel`。`engine/stop/go-on.ts`：`continueByLine` 只解除和重开，删去 `continueReceiptLine`。`engine/stop/buttons.ts`：`onlyPlan`、`goOnByButton` 不再回执，话上的「继续」解除不了也不再 `answerStatus`。`prompts/control-copy.ts`：删去 `stopReceiptBody`、`continueReceiptBody`。信使不改：旧回执照旧显示。
