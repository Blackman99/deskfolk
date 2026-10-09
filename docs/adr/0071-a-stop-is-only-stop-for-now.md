# 停止只是先停下 / A stop is only "stop for now"

Status: implemented 2026-10-09, at every engine level with holds. Changes what a hold of yours means in [ADR 0041](0041-control-plane-holds-and-restarts.md) and [ADR 0040](0040-agent-kernel-the-job-owns-state.md) I2, and takes back the 2026-10-03 choice that a stop from a menu, the board or a typed 「停下」 stays until you lift it. Folds in the three fixes of the same day ([ADR 0063](0063-edit-a-line-and-lines-in-order.md) #6 and #7) and sits on [ADR 0070](0070-the-app-stays-out-of-the-conversation.md) (a stop or a go on is carried out only on the reader's reading).

2026-10-09，一天里三次「按了停止，Bot 就不理我了」：停下后改那句话，改动被扣着；补一句再停下，那句被扣着、「直接插入」是灰的；停下后在交付卡上退回，返工被扣着。三处修完之后你说：「停止 Bot 不工作的机制就不该出现。停止永远只是让 Bot 先停下来——会有后续指令，或者先停下来改消息继续，或者就先停下来，我后面再让你继续。」可当时只有回复上的停止按钮是这样：打字的「停下」、「停下所有 Bot」、工具菜单、流程图上的叫停一直扣着，你再对 Bot 说什么，它都只能「只读答复」，答应「等你说继续再做」；回答它的工作提问也不解除。叫停覆盖的 Bot 不在侧栏里，按钮的停止更是从来不显示。

On 2026-10-09 you hit "I pressed Stop and the Bot stopped listening to me" three times in a day: a change to the line after Stop was held; a line sent just before Stop was held, with Insert now off; a send-back on a hand-over's card after Stop left the rework held. Once those were fixed you said: "A stop should never leave the Bot not working. A stop only ever means stop for now — then there is a next instruction, or I stop it to change my line and go on, or I just stop it and tell it to go on later." Yet only the Stop on a reply behaved so: a typed 「停下」, 「停下所有 Bot」, the tools menu and the board kept their hold, and whatever you said to a Bot under one it could only answer read-only, promising to act once you said go on; answering its work question lifted nothing either. And a Stop's hold never showed in the sidebar.

## 决定 / Decisions

1. **叫停只挡自动的事 / A stop holds only what would start the Bot by itself.** 你的每一种叫停——回复上的停止、打字「停下」「停下 X」「停下所有 Bot」、群里和工具菜单的停下、流程图的搁置——都做两件事：现在停下它覆盖的活；在你开口前，挡住会让 Bot 自己重新开工的东西：它约的回看、别的 Bot 的话、生成作业完成的通知、监督器的续跑。F-a（停下之后被自己约的回看叫醒）照旧挡住。应用自己的保持（叫停出现之前搁置的规划）和「新开一件事」时作废旧事的那条不算你的叫停，照旧等你解除。 / Every stop of yours — Stop on a reply, a typed 「停下」/「停下 X」/「停下所有 Bot」, the group and tools menus, parking on the board — does two things: it stops the work it covers now, and until you speak it holds what would start the Bot again by itself: its check-backs, other Bots' lines, job completions, the supervisor's resumes. F-a (woken by its own appointment after a stop) is still held. The app's own holds (plans parked before holds existed) and the one that drops the old job when you open a new one are not stops of yours, and still wait for you.

2. **你的话从来不被挡 / Your word is never held.** 你对一个 Bot 的任何话或操作，它都照做：对它说一句话、改你的话、直接插入、在交付卡上退回、回答它的提问、在重启提示上按继续、说「继续」、在侧栏按解除。只覆盖这个 Bot 的叫停随之解除；覆盖好几个 Bot 的，只放开它（`effect.released_bots`，每个「是否被扣」的判断都读它，包括数据库自己拒绝开轮的触发器），其余的照停，等你对它们开口或解除；覆盖的 Bot 都放开了，这条叫停就解除，搁置的规划回到原样。「停下所有 Bot」也管之后才建的 Bot，所以只靠放开不会解除。不再有「只读答复」：它只剩给应用自己的保持用。 / A Bot does whatever you say or do to it: a line said to it, a change to your line, Insert now, Send back on a hand-over's card, your answer to its question, Continue on a restart notice, 「继续」, Lift in the sidebar. A stop on that Bot alone is lifted; one over more Bots releases that Bot alone (`effect.released_bots`, read by every held check, the database's own refusal to open a turn included), and the rest stay stopped until you speak to them or lift it; once every Bot it covers is released it is lifted, and the plans it parked go back. 「停下所有 Bot」 covers Bots made later too, so releases never lift it. There is no read-only answer to your line any more; that path is left for the app's own holds.

3. **只问进度不算继续 / Asking is not going on.** 读成只问进度的话（「还在做吗」）不放开谁：它照停着回答你（[ADR 0070](0070-the-app-stays-out-of-the-conversation.md) 起由它自己答）。问一句不是让它接着干——「我后面再让你继续」。 / A line read as only asking where the work stands ("still at it?") releases nobody: the Bot answers it, still stopped. Asking is not telling it to go on.

4. **解除就是继续 / Lifting is going on.** 在侧栏按解除、说「继续」，被停下的活带着说明接着做——以前按钮解除一个停止什么都不重开。读成「继续」的话放开一个 Bot 时，它停下的那件事也接着做：这句话自己开出的那一轮就在那件事上，就由它接着；落不到哪件事（它手上有几件，开出的是桌面段）时，那件事在它停下的地方带说明重开。对 Bot 说一句别的话，那句话就是它接着做的事，不另带说明重开。只读答复只剩三种：只问进度、叫停之前发出的话、应用自己的保持；给 Bot 的提示照此说怎么让它接着做（直接说下一步或在侧栏解除；搁置的旧规划到流程图上）。 / Lift in the sidebar, or 「继续」, opens the stopped work again on a note — lifting a Stop by its button used to reopen nothing. A go on that releases a Bot also goes on with the job it stopped: by its own turn when that is on the job, else — landing on no job, at the Bot's desk — the job opens again where it stopped, on a note. Any other line to the Bot is what it goes on from, with no note. A read-only answer is left only for a status question, a line sent before the stop, and the app's own holds, and the Bot is told how you let it go on.

5. **每个叫停都看得见 / Every stop shows.** 侧栏上方列出你每一个还在扣着东西的叫停，回复上的停止也在内，带「解除」；放开过的 Bot 写在后面（「所有 Bot 的工作（已放开 文案）」）。 / The sidebar lists every stop of yours that still holds something, a Stop on a reply included, with Lift; the Bots your word released are named after it.

6. **回执和按钮 / Receipts and buttons.** 叫停的回执最后一行照范围说你接下来怎么让它继续：一个 Bot 的「你再对它说话就解除」；群的「你在这个群里再说话，说到的 Bot 就从你这句接着往下（不点名就是所有人）」；所有 Bot 的「你对哪个 Bot 说话，它就从你这句接着往下，其余的接着停着；说「所有 Bot 继续」全部解除」。工具菜单的「全部停下」下面写「先停下：对哪个 Bot 说话就放开哪个」。在一句可能是控制的话上按「继续」，也只放开话里点到的 Bot（以前在全部叫停下会换来一行「只让 X 继续 / 全部继续」）；回执写明放开了谁。 / A stop's receipt ends with how you let it go on, by scope; the tools menu's Stop everything says it stops for now. Continue on a line that may have meant control releases only the Bots it names (under a stop on everything it used to answer with Only X / All go on), and its receipt says whom.

7. **旧库 / Older databases.** 还在生效的、你做的「等你解除」的叫停，在打开时改成同样的「先停下」（`migrateStopsForNow`）。 / A stop of yours still in force that waited to be lifted becomes a stop for now when the database opens.

## 取舍 / Trade-offs

- **对一个 Bot 开口，它这件事上的自动唤醒也回来了。** 放开的是这个 Bot，不是某一句：它约的回看、作业完成会照常叫醒它。你在和它说话，它就不算停着。 / Speaking to a Bot brings back its own wakes too: what is released is the Bot, not one line — you are talking to it, so it is no longer stopped.
- **群里不点名说的话，放开群里每个 Bot。** 每个 Bot 都听得到它，和以前群菜单的停下一样。 / A line in a group that names nobody releases every Bot there: each of them hears it, as with the group menu's stop before.
- **放行不算你让它继续。** 放行的是交上来的东西，不是一句吩咐；停着的 Bot 照停。 / Approving a hand-over is no word to go on: it is about what was handed over, and a stopped Bot stays stopped.

## 实现 / Implementation

`store/holds.ts`：`createHold` 给你的暂停默认 `lift_on_next_user_message`（作废旧事的 `cancel` 和应用自己的不算）；`heldBy` 多一个条件，`effect.released_bots` 里的 Bot 不再被这条覆盖——这是所有「是否被扣」的判断共用的那一处，数据库的触发器每次打开时按它重建；`releaseHold` 放开 Bot、覆盖的都放开了就 `liftHold`；`goOnForYourWord` 是不是一句新话的那几种「你的话」（改话、直接插入、退回、回答提问、按继续）共用的规则；`refreshHeldInbox` 把不再被扣的收件的工作排进队；`migrateStopsForNow` 管旧库。`engine/stop/reach.ts` 的 `stopsAbout` 多了「全部」和「任务」两种；`engine/stop/go-on.ts` 的 `liftOnYourLine`、`continueByLine` 按「单个 Bot 解除、多个 Bot 放开」办，`lift` 和「只停《…》」解除后重开停下的活。 / See the code paths above.

## 缺口 / Not done

- 一个 Bot 被放开后，它停下时所在的规划仍是搁置状态，直到这条叫停解除。 / A released Bot's plan stays parked until the stop is lifted.
- 你在叫停之前发出、还没被读到的话仍被扣着：那一刻说不清你是要停它还是要它照这句做。它下面有「直接插入」。 / A line you sent before the stop and no Bot has read yet is still held — whether you meant to stop it too is unclear — with Insert now under it.
