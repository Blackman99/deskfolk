# 停下就是停下 / A stop is just a stop

Status: implemented 2026-10-10. Takes back [ADR 0071](0071-a-stop-is-only-stop-for-now.md) #2 (a stop over more Bots releases one Bot at a time), #5 (every stop listed in the sidebar with Lift) and #6 (receipts saying the rest stay stopped); the rest of 0071 stands.

ADR 0071 之后，叫停已经「你再说话就接着」，可它还看得见、还要按：侧栏上方一条「叫停中」列着每条叫停，各带「解除」；被叫停的群和私聊在列表里标「已叫停」；工具菜单的「全部停下」按过之后变成「全部继续」；「停下所有 Bot」或停下一个群之后，你对一个 Bot 说话只放开它，其余的一直停着，回执叫你去说「所有 Bot 继续」。你说：「当前叫停的实现很别扭，其他的工具停止就是直接停止了，没有还需要额外点击按钮恢复这一说，这应该是内置行为，用户再发送消息意思就是重启恢复了。」

After ADR 0071 a stop already went on with your next word, but it still showed and still asked to be pressed: a 「叫停中」 bar above the list with a Lift on each stop, 「已叫停」 on the rows, the tools menu's Stop everything turning into All go on, and after 「停下所有 Bot」 or a group's stop, a line to one Bot released only that Bot while the rest stayed stopped until you said 「所有 Bot 继续」. You said: "Stopping here is awkward. In other tools a stop just stops; nothing needs another button to resume. That should be built in: sending another message is what resumes."

## 决定 / Decisions

1. **你一开口，叫停整条结束 / Your next word ends the stop whole.** 你的话所关于的叫停——你说一句话、改你的话、直接插入、退回、回答提问、说「继续」——不论覆盖几个 Bot，都整条解除：「停下所有 Bot」之后对任何一个 Bot 说话；停下一个群之后在这个群里说话；停下一件事之后说到这件事。覆盖的 Bot 的回看、别的 Bot 的话、作业完成的通知都恢复，搁置的规划回到原样。不再写 `effect.released_bots`。 / Every stop your word is about — a line, a change to your line, Insert now, Send back, your answer to its question, 「继续」 — is lifted whole however many Bots it covers: any line to any Bot after 「停下所有 Bot」, any line in a group after its stop, any line about a job after its stop. Every covered Bot's check-backs, other Bots' lines and job completions wake again; parked plans go back. `effect.released_bots` is no longer written.

2. **只有你说到的 Bot 接着做 / Only the Bot you speak to goes on.** 结束叫停不等于把被停下的活全部重开：你说到的 Bot 从你这句接着往下（说的是「继续」，它停下的那件事接着做，和 0071 #4 一样）；别的 Bot 停下的那一轮不带说明重开，等它们被别的东西叫醒或你对它们开口。这和别的工具一样：停下就是停下，下一句话是新的开始。 / Ending a stop does not reopen everything it ended: the Bot you speak to goes on from your line (for 「继续」, with the job it stopped, as 0071 #4); the other Bots' stopped turns are not reopened on a note — they wait for whatever wakes them next. As elsewhere: a stop is a stop, and your next line is a fresh start.

3. **叫停不再显示成状态 / A stop is no state on screen.** 侧栏不列先停下的叫停，会话行不标「已叫停」，Bot 头像不睡觉，工具菜单永远是「全部停下」（下面一行「先停下：你再说话就接着」）。流程图上只列这件事自己的搁置和等你解除的叫停。侧栏上方那一条只剩你按「作废」按钮建的、不随你的话结束的叫停，它们还带「解除」。 / The sidebar lists no stop for now, rows carry no 「已叫停」, the avatar no longer sleeps, and the tools menu always reads Stop everything ("Stops for now: say anything and it goes on"). The flow board lists only the job's own parking and stops that wait to be lifted. The bar above the list is left for stops you dropped a job with by a button, which no line ends; they keep their Lift.

4. **回执一句话 / One line on the receipt.** 回执最后一行只说「你再对它说话，它就从你这句接着往下」「你在这个群里再说话，叫停就结束，说到的 Bot 从你这句接着往下」「你再对哪个 Bot 说话，叫停就结束，它从你这句接着往下」。Bot 被只读回答时的提示不再提「在侧栏按解除」。 / The receipt's last line says only that your next word ends it; a read-only Bot is no longer told about Lift in the sidebar.

## 不变 / Unchanged

- 0071 #1 叫停挡住自动的事，直到你开口；#3 只问进度不算继续——照停着回答。 / A stop holds what would start a Bot by itself until you speak; a status question goes on with nothing.
- 应用自己的保持（叫停之前搁置的旧规划）、作废旧事的那条，照旧等你解除。 / The app's own holds, and a stop that drops a job, still wait for you.
- 已有 `released_bots` 的旧叫停仍被所有「是否被扣」的判断读到，直到它被你的下一句话整条解除；不迁移。 / A hold an older build partly released is still read that way until your next word lifts it whole; no migration.

## 取舍 / Trade-offs

- **「停下所有 Bot」之后对一个 Bot 说一句话，别的 Bot 也不再被挡。** 它们约的回看和彼此的话会照常叫醒它们。你要的是一个停止键，不是一个要记着去关的开关；想让其他 Bot 继续停着，再按一次「全部停下」。 / After 「停下所有 Bot」, one line to one Bot lets the others' own wakes through again. You asked for a stop button, not a switch to remember to turn off; press Stop everything again to keep them stopped.
- **看不到哪些 Bot 刚被停过。** 叫停的回执留在会话里；侧栏不另做一份。 / Nothing in the sidebar says which Bots were stopped; the receipt in the conversation does.

## 实现 / Implementation

`engine/stop/go-on.ts`：`liftOnYourLine`、`continueByLine` 一律 `liftHold`；`goOnFromYourLine` 多一个 `onlySaidTo`，`turn-engine.ts` 对读成继续、结束了多 Bot 叫停的话用它，只重开说到的 Bot 的活。`store/holds.ts`：`goOnForYourWord` 一律 `liftHold`，删去 `releaseHold`、`onOneBot`、`coveredBots`。`prompts/control-copy.ts`：`nextLineLifts`、`readOnlyLine`。客户端：`sidebar/holds-list.ts` 的 `listedHolds` 只留不随下一句结束的，删去 `sessionHeld` 和行上的 `held`；`ToolsMenu` 删去「全部继续」；`TraceView` 的 `boardHolds` 跳过先停下的（这件事自己的搁置除外）。

## 补充：工具菜单不再有「全部停下」 / Addendum: no "Stop everything" in the tools menu（2026-10-11）

你问：「全部停下的按钮已经没有用了吧，可以去掉吗。」停下不再留状态之后，工具菜单那一项按了看不出变化，又和会话停止菜单、流程图上的「停下所有 Bot」重复，去掉。决定 3 里「工具菜单永远是『全部停下』」作废；菜单栏图标里的「全部停下」留着，当桌面上不用先进会话的急停。代价：手机上 Bot 在你没开的会话里做事时，要先进一个在做事的会话，再用它的停止菜单。/ You asked whether the tools menu's "Stop everything" still did anything. With stops leaving no state it showed no change and repeated "Stop every Bot" in the stop menus, so it is gone; decision 3's "the tools menu always reads Stop everything" no longer holds. The menu bar icon's "Stop everything" stays as the desktop's one-press stop. The cost: on a phone, with Bots at work in conversations you have not opened, you open one of them and use its stop menu.

