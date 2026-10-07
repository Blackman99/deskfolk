# 应用只在需要你时找你 / The app asks you only when it needs you

Status: implemented 2026-10-04. Each part applies at the engine level its card or line came with; cards already out keep their buttons.

Bot 的守则早就写着：遇到障碍先自己排查、尝试，只有用户独有的权限、凭据、信息或决策才求助。应用自己却没守这一条。到 7、8 级，应用自己发出的卡片、带按钮的行和「等你」通知越来越多，其中不少问的不是要你定的事：它替你定了、你随时能改的，你刚说过的，它自己会接着做的。

A Bot's rule has long been to work through obstacles itself and ask only for what only you can give: a permission, a credential, information, a decision. The app did not hold itself to the same rule. By levels 7 and 8 its own cards, lines with buttons and "waiting on you" notifications had multiplied, and many asked about nothing you had to decide: something it had decided for you and you could change at any time, something you had just said, something it would go on with by itself.

实际用下来的记录（`state.sqlite` 的副本）：

What the live database shows:

- **默认模型卡 / Default-model cards.** 2026-10-03 开 7 级那天，01:00 到 04:30（UTC）四个 Bot 各来一张「之后默认用 X」［就用这个］［用端点默认］，每张带一条「等你回答」通知，撑着 Dock 角标；你答了三张，第四张没答，那个 Bot 也照用推断的模型。确认和推断在代码里没有任何区别（`default_source` 只有「拒绝」会改变行为）。 / On 2026-10-03, the day level 7 went on, four Bots got a card each between 01:00 and 04:30 UTC, each with an ask notification holding up the Dock badge; you answered three, and the fourth Bot ran on the inferred model all the same. Confirmed and inferred defaults behave identically; only a decline changes anything.
- **重启通知 / Restart notices.** 开发版守护进程每次被保存代码重启、打断了一件事，就发一句「点继续 / 点不续」和一条通知，哪怕 4 级起监督器 1 分钟后会自己接着做。2026-10-04 02:31 和 02:44（UTC）《一拳超人》的两句上都按了「不续」，第二次把一件本来 1 分钟后就会自己接着做的活放下了：一句不需要你做什么的通知，带着一个会停下工作的按钮。 / Every development restart that cut a job posted a line with Continue and Leave it, and a notification, even when the supervisor would pick the work up a minute later. On 2026-10-04 at 02:31 and 02:44 UTC Leave it was pressed on both lines of the 《一拳超人》 job, the second time setting aside work due to go on by itself a minute later: a notice that needed nothing from you carried a button that stopped the work.
- **日程的放行卡 / A routine's approval card.** 「每日AI重点新闻简报」 10-03 和 10-04 早上各交一次，各出一张「没有审查者，也没有你确认过的检查替你把关，所以要你来定」，两次都在两分钟内点了放行。日程本来就是你设好、让它无人值守地跑的。 / The daily news brief handed over on 10-03 and 10-04 and got a card each morning, approved within two minutes both times. A routine is set up to run unattended.
- **旧规则卡 / The old-rules card.** 10-03 01:13 一张「这件事有 2 条台账之前的旧规则……这些是你说的吗？」，至今没人按；不按时它们照样只作参考，按了也只是把参考变成要求。 / One "Did you say these?" card on 10-03, never pressed; unpressed, the old rules simply stay for reference.
- **按你的话加的检查 / Checks from your words.** 你在视频的事里每说一次时长、分辨率、画幅或帧率，就出一张「按你的话加检查：时长 108–132 秒？」，再说一次再来一张「你已经说了 N 次」：问你要不要你刚说的话。没确认的提议照样量、结果照样给你和 Bot 看，只是不拦东西；确认只在它该拦的时候才要紧，到那时流程图上能确认，你说过两次的要求没东西撑着时问你的那张卡片上也能。 / Each running time, resolution, aspect or frame rate you gave in a video job made a card, and saying it again made another: asking whether you meant what you just said. An unconfirmed offer is measured and shown all the same, holding nothing back; a confirm matters only once it should hold something back, and then the board offers one, as does the card asking about a requirement you said twice that nothing backs.

## 决定 / Decisions

1. **原则 / The rule.** 应用自己只在三种时候找你：要你放行一个动作或一份成果；要只有你给得了的东西；它停下了、不会再自己往下做。它替你定了、你随时能改的，你刚说过的，它会自己接着做的，都不发卡片、不发「等你」通知。清单在[行为说明·应用找你](../behavior.md#when-the-app-asks)。 / The app asks you only when you have to let an action or a piece of work through, when it needs what only you can give, or when it has stopped and will not go on by itself. What it decided for you, what you just said and what it will go on with get no card and no "waiting on you" notification. The list is in [Behavior · When the app asks you](../behavior.en.md#when-the-app-asks).

2. **默认模型不出卡片 / No default-model card.** `ensureBotDefault` 照旧推断、记成 `inferred`、写工作记录 `model.default_inferred`，不再插卡片、不再建 `ask` 通知。想换就给 Bot 钉一个模型。已经发出的卡片照样能按（`answerModelDefaultCard`）。 / `ensureBotDefault` infers and records as before, with no card and no ask notification; pinning a model changes it. Cards already out still answer.

3. **会自己接着做的重启不说 / No restart notice for work that goes on by itself.** 启动时（`engine/restart.ts`）一件事的每一轮，监督器的安排都是 `now`、`after_stable` 或 `held`（被你的叫停扣着）时，不发那一句、不建 `restart:` 通知，各轮的 `interrupted:` 通知作废并标已读（`goes_on_by_itself`），不弹系统通知、不算角标；只要有一轮是 `dev_burst`、`unknown_effect` 或 `waits`（3 级及以下、没挂在监督器照看的事上），整件照旧发。监督器按 §5.6，开发版重启打断、还没接上的活，在下一次启动之后就不会自己接了；原来那一句会写着「1 分钟后接着做」顶着，现在没有那一句，所以由那次启动补发（`supervisor.workLeftByEarlierRestart`：需要处理、最近的重启记录来自更早的启动、原因是开发版、没被接过、没有哪句重启通知点过它的中断行），安排写成 `restarted_again`。启动日志里的统计只数发了的。 / At boot, a job whose every turn the supervisor arranges as `now`, `after_stable` or `held` gets no line and no `restart:` notification; its turns' `interrupted:` notifications are voided and marked read (`goes_on_by_itself`). A job with any turn `dev_burst`, `unknown_effect` or `waits` is told as before. Under §5.6 work cut by a development restart and not yet picked up never goes on by itself once the daemon starts again; the old notice covered that with its "after a minute" line, so the later boot now tells it (`supervisor.workLeftByEarlierRestart`), arranged as `restarted_again`.

4. **监督器会接着做的失败不另发通知 / No failure notification for work the supervisor retries.** `failTurn` 在这一轮的工作项转成需要处理、规划是监督器照看的（`supervisorTakesUp`）时，不建 `failure:` 通知：监督器下一拍从失败行接着做，每小时 3 次用完或最后一步结果不明时，它自己的 `supervisor:` 行和通知告诉你。别的失败（桌面段、日程的轮、3 级及以下）照旧通知。 / When the failed turn's work item now needs attention on a plan the supervisor watches, `failTurn` creates no `failure:` notification; the supervisor retries from the failure line and tells you itself when its budget runs out or the last step has no known outcome.

5. **按你的话加的检查只为替换出卡片 / Checks from your words get a card only to replace a gate.** `engine/derived-checks.ts` 只在一条提议的数和同一项生效的门禁不一样时出卡片（`replacing`，你又说一次就带次数再发）：不问你，Bot 就一直被旧的数拦着。新的提议、再说一次的同一个数、改回提议的门禁、门禁第一次对上文件，都只在流程图和局面里，确认走流程图（`POST /v1/checks/:id/confirm`），或必查要求卡上的「确认这条检查」。卡片文字只剩替换那一种（`replacementCardBody`）。 / Only an offer that differs from a gate in force on the same dimension gets a card; everything else shows on the board and in the situation, and is confirmed there or on the required-items card.

6. **需求台账不出卡片 / No requirements-ledger cards.** 旧规则卡（`legacy`）和升为常设的建议卡（`standing`）都不再发；`legacyCardDue`、`standingSuggestion`、`recordRequirementCard` 删掉。旧规则在流程图「旧规则」一组里逐条确认；作用于会话的要求，同一个会话里新开的事本来就继承。已经发出的卡片照样能按：「都是」只确认还未核实的，「升为常设」只升此刻还符合条件的（`mayMakeStanding`），旧规则在流程图上处理完的卡片照旧收起（`REQUIREMENT_CARD_TRIGGERS`）。 / Neither the old-rules card nor the standing suggestion is posted; their due lists go. Cards already out keep their buttons and still settle.

7. **日程的交付不等你放行 / A routine's runs are not held for your approval.** `submissions.ts` 里，日程常驻规划（`tasks.routine_id`）的交付门禁都过就放行（`submission.approved`，`by: routine`），不出放行 / 退回卡，也不出必查要求卡；设了审查者时，审查者一判通过就放行（`review.recorded` 带 `by: routine`）。门禁没过照样退回；之前留下、还在等的卡片，下一拍按此刻的检查放行并收起（「已放行。」）。 / A routine's hand-overs are approved once their gates pass, with no approve/reject or required-items card; a reviewer's approve is enough when one is set. A failing gate still sends them back; a card left waiting is approved at the next tick.

## 保留的 / What stays

批准、Bot 的提问和工作提问卡、非日程交付的放行 / 退回卡和必查要求卡、能力天花板卡、投诉返工卡、教训卡、监督器和结束契约的「停下了」那一行、桌面段两次没选好归属的那一行、不会自己接着做的重启通知、没人接的失败通知、模型的一次性提醒，以及回应你自己动作的回执。每一种都是要你放行、要只有你给得了的东西，或它停下了。其中投诉返工卡和教训卡最接近边界：前者问的是你刚说的不满要不要转成返工，后者问要不要采用 Bot 自己写的规则；两者现在仍要你按，以后如果要改成「先做、可撤销」，另记一笔。

Approvals, Bots' questions and work question cards, the approve/reject and required-items cards of jobs that are not routines, the capability ceiling, the complaint card, the lesson card, the supervisor's and the end contract's "it stopped" lines, the desk's "needs a job chosen" line, restart notices for work that will not go on by itself, failures nothing takes up, the one-time notes about models, and receipts of what you did. Each lets something through, needs what only you can give, or says the app stopped. The complaint card and the lesson card are closest to the line — one asks whether your complaint means rework, the other whether to take up a rule a Bot wrote — and both still wait for your press; making either "act first, undo after" would be a decision of its own.

## 后果 / Consequences

- 想换 Bot 的默认模型、想让某个数成为门禁、想用旧规则，都要你自己去 Bot 资料或流程图；应用不再在会话里提醒你可以这么做。 / Changing a default model, making a number a gate or taking up an old rule is now yours to start, on the Bot's profile or the flow board; nothing in the conversation suggests it.
- 「升为常设」没有新的入口：已经常设的条目照常适用，流程图上还没有把会话条目扩到每个视频的按钮。 / Making a requirement standing has no entry point any more; standing entries keep holding, and the board has no button for it yet.
- 日程交出的东西不经你看就算放行；你说它有问题时，投诉返工卡照样问你。规划级的检查不绑每天新开的任务，所以眼下没法给日程的每一次加一道门禁；要的话另记一笔。 / A routine's work counts as approved without your look; a complaint about it still gets the complaint card. A plan-wide check binds no ticket a later run opens, so nothing can gate every run of a routine yet; that would be a decision of its own.
- 开发版接连重启时，被打断的活由后一次启动补发通知；在那之前的一分钟里，界面上只有各轮自己的「中断」行。 / With development restarts in a row, the later boot tells the stranded work; until then only each turn's own "Interrupted" line shows it.

## 补记 / Addendum (2026-10-04, afternoon)

同一天下午你又指出两处：《一拳超人》上视频导演 12:10 以 blocked 停下，问「请确认关键帧板（board.jpg）与设定集是否符合预期，确认后将正式启动视频片段生成与后期剪辑」，卡片等到 14:48 你答「确认」；14:49 你按了 Stop，应用又在会话里回了一张「已停下视频导演在『制作《一拳超人》动画』上的工作……你在这件事上再说话，它就接着往下」。两张都不必要。

The same afternoon you pointed at two more: the video director stopped blocked at 12:10 on 「请确认关键帧板…确认后将正式启动视频片段生成与后期剪辑」, which waited until your 「确认」 at 14:48; and at 14:49 you pressed Stop, and the app posted a receipt saying it had stopped the director's work and that your next word would let it go on. Neither was needed.

8. **只请你点头的提问退回一次 / A question that only asks your OK is sent back once.** 读句给 Bot 的话多读一项 `go_ahead`：问用户的话是不是只在请用户点头才接着做他要的事（确认做到一半的东西、问能不能开始下一步）；要用户给只有他有的东西、在几个方案里拿主意、说清障碍都不算。只有模型读这一项，词表从不说是。3 级起，`end_turn(blocked)` 的 `needs_from_user` 和 `ask_user` 的问句在调用前读一次（`engine/tools.ts` 的 `readForCall`）；读成请示，结束契约退回（`asks_go_ahead`，`goAheadBounce`），`ask_user` 回错误并记 `ask.go_ahead_refused`。一段只退一次（`goAheadRefused`），之后的问题不再读、照常发出；结束契约的两次退回已用完时也照常发出，不会把一个真问题变成「需要处理」。工具说明里同样写明不要停下来请示。 / The reader's reading of a Bot's line gains `go_ahead`, read by a model only. From level 3 a blocked ending's `needs_from_user` and an `ask_user` question are read before the call; a go-ahead is sent back (`asks_go_ahead`), once per segment, and never when the contract's bounces are spent; the tool descriptions say the same.

9. **卡片上的 Stop 不回执 / No receipt for a Stop on a turn's card.** `stopByButton` 照旧建叫停、结束那一轮、挂起回看，把停在哪一步记在叫停的 `effect` 上，只是不再插回执：停的就是你按的那一轮，你下一句话就解除它，回执和「撤销」只是把你刚做的事再说一遍。你说的叫停、群里的停止菜单、「全部停下」这类会波及几个 Bot、你看不全它们停在哪的，回执照留。 / `stopByButton` makes the hold, ends the turn and records its effect as before, with no receipt line. Stops you say, and the stop menus that can reach several Bots, keep theirs.

## 补记 / Addendum (2026-10-06)

你在私聊里对「工作区文件助手」说「根据你的职责，生成图片更新你的头像」。它第一次动手就开了一件事，应用贴出「新开：根据你的职责，生成图片更新你的头像」［撤销］［并入…］，旁边是「没有可并入的同项目规划」；31 秒后它把 avatar.jpg 一次做完交上来，应用又贴出「……没有审查者，也没有你确认过的检查替你把关，所以要你来定。看过之后，放行或者退回。」你按了放行，说这种简单的事情不该反复出现应用自带的提示和确认。同一天前一件「创建一个 Bot，专门用来管理工作区的文件助手」也是这两张卡；两张放行卡分别在贴出后 12 秒和 7 秒被按下。

In your direct with 工作区文件助手 you said 「根据你的职责，生成图片更新你的头像」. Its first effect opened a job and the app posted 「新开：…」 with Undo and a greyed Merge beside "no job of this project to merge into"; 31 seconds later it handed avatar.jpg over, done in one go, and the app posted "Nobody reviews it and no check you confirmed stands behind it, so it is yours to decide. Have a look, then approve it or send it back." You approved it and said something this simple should not keep bringing the app's own prompts and confirmations. The job just before it that day, creating the file-assistant Bot, got the same two cards; the two approval cards were pressed 12 and 7 seconds after they appeared.

实际用下来的记录 / What the live database shows:

- **新开卡 / The new-job card.** 一共贴出过 4 张（10-02 一张、10-04 一张、10-06 两张），没有一张按过。卡上的字就是你那句话前面加「新开：」，你那句话下面的归属标签已经写着它归到哪件事、点它能改。 / Four were ever posted, none ever pressed. Its words are your line with 新开 in front, and the tag under your line already names the job and changes it on a click.
- **放行卡 / The approval card.** 18 张放行或必查要求卡里，你按「退回」并写了意见的 3 张都在《全职猎人》上，分别是这件事的第 4、7、8 段之后，第一次交付前已经跑了 900 多分钟；那时它也只有一张任务、还没认成大活，和头像这件事的形状一样，所以看任务张数和大小分不出来。分得开的是段数：今天这两件事都是开它的那一段一次做完、第一次交付；别的卡片都在做了两段以上之后。 / Of 18 approval and required-items cards, the three you sent back with notes were all on 《全职猎人》, after its 4th, 7th and 8th segments and over 900 minutes in; at that point it too had one ticket and no large-job reading — the avatar's shape — so ticket count and size do not tell them apart. Segments do: today's two jobs were each done and first handed over by the segment that opened them; every other card came after two segments or more.

10. **不贴新开卡 / No new-job card.** `work_on` 开出新事（包括因名额满而排队的）时不再贴「新开：…」卡。归属标签写着这件新事；要改归属点它；要停下或不做了，说一句或按停止。已经贴出的卡片照样能按（`actNewPlanCard`）。 / Opening a job, queued or not, posts no card. The tag names the job; a click on it refiles the line; saying so or Stop stops or drops it. Cards already out still act.

11. **一次做完的交付不等你放行 / Work made in one go is not held for your approval.** 没有审查者、也没有你写的或确认过的检查撑着的文件交付（`submit` 或隐式），在下面三条都成立时，下一拍直接放行（`submission.approved`，`by: one_go`），不出放行 / 退回卡（`submissions.ts` 的 `doneInOneGo`）： / A file hand-over with no reviewer and no check of yours behind it is approved at the next tick, with no card, when all three hold:
    - 这件事只有一张没作废的任务（大活拆好之后总有好几张）；/ the job has one ticket not dropped (a laid-out large job always has several);
    - 这件事从没有一张放行或必查要求卡片问过你；/ no approval or required-items card has ever asked you about the job;
    - 交它的这一段，是这件事开出来（或它上一次放行）以来唯一的一段；交上来之后才开始的段（你等它时说的下一句）不算。 / the segment handing it over is the only one on the job since it opened, or since its last approved hand-over; segments that start after the hand-over do not count.
    放行之后你在同一件事里要它改一下、它一段改完交上来，也照这条放行。一段话的交付和整理跳的读法照旧到卡片上；必查要求没东西撑着的照旧问你；大活的样片和最后一件照旧由你放行（ADR 0060）。 / A change you ask for afterwards, made by one segment, goes the same way. Words handed over and the organizer's readings still come to the card, as do unbacked required items and a large job's sample and last part.

### 后果 / Consequences

- 一次做完的东西不经你看就算交付了；不对就照常说，投诉返工卡会问要不要转回返工，转回后这件事重新打开。 / Work made in one go counts as delivered without your look; say when it is wrong, and the complaint card asks whether to send it back, reopening the job.
- 「撤销」和「并入」没有了入口：把一句话改归到别的事（点归属标签）不会顺带作废它新开的那件事，那件事留着；要作废，说一句「停下，算了」，回执上有「作废这件事」。四张卡没人按过，所以先不补别的入口。 / Undo and Merge have no entry point now: refiling the line through its tag does not abandon the job it opened, which stays; to drop it, say "stop, never mind" and the receipt offers to drop the job. No card was ever pressed, so no other entry point is added yet.
- 「问过你」看的是会话里还在的放行和必查要求卡片：清空历史把它们删了，之后这件事会被当成没问过。 / "Asked you once" counts the approval and required-items cards still in the conversation: clearing its history deletes them, and the job then reads as never asked.
- 完工复盘（[ADR 0062](0062-retrospective-after-delivery.md)）照样看这些自动交付的事：一次做完、什么都没出的本来就跳过（`nothing_to_learn`），投诉返工之后再一次做完交付的，复盘读得到那次投诉。 / The retrospective (ADR 0062) still looks at these deliveries: one made in one go with nothing wrong is skipped as before (`nothing_to_learn`), and one delivered in one go after a complaint's rework has that complaint to read.
- 「一次做完」看的是段数，不读这件事难不难：一段里做了很久、很大的东西也会直接放行。真遇到再加一读。 / "In one go" counts segments and does not read how hard the work was: a long, large piece made in one segment is approved too. A reading can be added if that ever bites.

## 补记 / Addendum (2026-10-07)

12. **放行之后，一段做完的交付也不等你 / After an approval, one segment's hand-over is not held either.** §11 要求这件事「从没有一张放行或必查要求卡片问过你」。10-07 你在和视频导演的私聊里测阿里百炼端点：第一份交付前多了一段（它先停下来要密钥），出了卡，你放行了；之后每个追问它都把佐证文件放进同一张任务的文件夹交上来，半小时 5 张放行卡，你都点了放行。现在这件事有过一份放行的交付时，之后由上次放行以来唯一的一段做完的交付照样直接放行，不看以前出没出过卡（`doneInOneGo`）。上一份被你退回的，做它的那一段算在里面，下一份照旧问你；大活、一段话、必查要求照旧。 / §11 asked that no approval or required-items card had ever asked you about the job. On 10-07, testing the Bailian endpoint in your direct with 视频导演, the first hand-over came after an extra segment (it had stopped to ask for a key), so it was carded and you approved it; after that each follow-up question had its evidence files put in the same ticket's folder and handed over — five approval cards in half an hour, each let through. Now, once a hand-over of the job has been approved, the next one made by the only segment since that approval is approved the same way, cards before or not (`doneInOneGo`). After one you sent back, the segment that made it counts, and the next still asks you; large jobs, words handed over and required items are as before.
