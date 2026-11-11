# 停下的活不再刷屏，样片不再等你放行 / Stopped work says less, and the sample no longer waits for your approval

Status: implemented 2026-11-11. Amends [ADR 0060](0060-large-jobs-sample-first.md) (the sample's 放行), [ADR 0084](0084-you-let-work-through-by-what-you-say.md) (a sample needs a clear yes), [ADR 0045](0045-supervisor.md) (the supervisor's 「这件事停下了」) and [ADR 0061](0061-claude-agent-runner.md) (failures only you can fix).

2026-11-10，你和视频导演的私聊里做一支古风 MV。第一场样片交上来后，第二场的出图一直被拒（`waits_for`）：你的「继续」读成了叫它接着做，提问卡上的回答不过读句，「第一场放过」没读成放行；Bot 让你在输入框里原样打「第一场样片通过」，第五次才记上，第二场晚开工一个多小时。当晚 Claude 的用量额度用完：之后 20 分钟里监督器把它叫回四个场次各两次，每次一开工就失败，私聊里连着十条「这一轮没写完：Claude 的用量额度用完了（11/11 01:30 重置）」；四个场次叫满两次后，又各贴一条「这件事停下了：…」。你说：样片放行这个逻辑没有存在的必要，整体去掉；重复的提示只要一条；「这件事停下了」这种系统提示不要出现，隐式就可以，也不要重复。

On 2026-11-10 an MV in your direct with the video director: once scene one's sample was handed over, scene two's generating calls were refused (`waits_for`) — your 「继续」 read as "go on", a question card's answer is never read, and 「第一场放过」 did not read as approval; the Bot had you type 「第一场样片通过」 word for word, which took on the fifth try, an hour late. That night Claude's usage ran out: over 20 minutes the supervisor called the Bot back to four scenes twice each, every call failing at once, and the direct got ten 「这一轮没写完：Claude 的用量额度用完了（11/11 01:30 重置）」 in a row, then a 「这件事停下了：…」 per scene. You said the sample's approval has no reason to exist and should go entirely; a repeated notice should show once; and 「这件事停下了」 should not appear at all, nor repeat.

## 决定 / Decisions

1. **额度用完不再叫回，同样的失败只显示一次 / Out of usage: no call-backs, and the same failure shows once.** ADR 0061 说只有你能解决的失败（没找到 Claude Code、没登录、用量用完）不替你重试，但监督器的「没人推的任务」叫回绕过了这一条。现在一个 Bot 最近一次结束的一轮是这几种失败（`AGENT_OUT_FAILS`）时，监督器不叫回它、也不续跑它的工作，直到它有一轮以别的方式结束（你说话、你按继续）。作业结果、回看这类别的叫醒照常；它们又失败、失败行和会话里你能看到的最后一行一字不差、而那一行的「继续」还没用过时，这一行只留给 Bot（`bot_only`），不显示、不推送、不另发通知，要接着做就按上面那条的「继续」。按了「继续」（你按的或监督器续跑的）又同样失败时照常显示，带它自己的「继续」：那条已经用过了。
   ADR 0061 does not retry what only you can fix, but the supervisor's call-backs to quiet tickets went round it. A Bot whose last ended turn failed that way (`AGENT_OUT_FAILS`) is no longer called back or picked up until a turn of it ends some other way. Other wakes still run; a failure line identical to the last line you can see there, while that line's Continue is unused, is kept Bot-only, with no publish and no notification, and Continue on the line above still works. A Continue (yours or the supervisor's) that fails the same way always shows, with a Continue of its own.

2. **「这件事停下了」不再出现 / No more 「这件事停下了」.** 监督器叫回两次没进展时照旧停下不再叫，但只记在工作记录里（`supervisor.notice`，`message_id` 为空），不贴行、不发通知，每个进展周期一次。你对这个 Bot 说话就接着做，和 ADR 0101 的叫停一样是隐式的。要你做点什么的两种照旧：一小时续跑用完（`retry_budget`）、最后一步结果不明（`unknown_effect`，防重复提交）。0–3 级的规划叫回（`plan-watch`）本来就不贴行，没动。
   The supervisor still stops after two call-backs that moved nothing, but records it only (`supervisor.notice` with no message): no line, no notification, once per progress cycle. Your next word to the Bot goes on, as implicitly as a stop (ADR 0101). The two notices that ask something of you stay: `retry_budget` and `unknown_effect`. The level 0–3 plan watch posts no line already and is unchanged.

3. **样片不再等你放行 / The sample no longer waits for your approval.** 样片还是大活里先做、按整件事的水准做足的那一件，其余各件还是等它，但只等到它**交出去**（已交付、审查中、已通过，或交过之后返工），和等别的任务一样（`waitingOn`）。样片自己的交付照普通规则走：有审查者就审，有你确认过的检查撑着就直接放行，都没有才等你一句话——而这时其余各件已经在做了。读句不再被告知哪份是样片，也没有「样片要明确认可」那一条；`submit` 不再返回样片花了多少（`sampleReport`、`sampleSums` 删掉）。照样片检查保留：样片通过（不论是谁放行的）后，其余各件交上来时照它对照。大活的最后一件仍然等你的话。局面里写明：样片往下做不用等用户表态，不要请用户放行。
   The sample is still the unit made first to the whole job's standard and the rest still wait for it, but only until it is **handed over**, like any dependency. Its own hand-over goes by the usual rules (reviewer, a check of yours, else your word — by then the rest are under way). The reader is no longer told which hand-over is the sample, and the clear-yes rule is gone; `submit` no longer reports what the sample took. Standard checks stay, made once the sample is approved by whoever approves it. The job's last part still waits on your word. The situation tells the Bot not to ask you to approve the sample.

## 取舍 / Trade-offs

- **额度重置后不会自己接着做。** 监督器不知道重置时间（只有失败行里的文字），所以等你一句话；Claude Code 的 `resetsAt` 在 `agent-runner.ts` 里拿得到，要自动接着做可以从那里接。 / **Nothing resumes on its own after the reset**: your word does. `resetsAt` is available in `agent-runner.ts` if that is wanted later.（2026-11-12 起由 [ADR 0110](0110-out-of-usage-another-account-or-the-reset.md) 改掉：先换你的另一个账号，都用完就到重置时间自己接着做。 / Changed on 2026-11-12 by [ADR 0110](0110-out-of-usage-another-account-or-the-reset.md): another of your accounts goes on first, and with none left the work picks up at the reset by itself.）
- **黄金路径评测**把监督器的静默停下（工作记录里没有行的那种）也算作一次需要你的介入。 / The golden-path eval counts the silent stall as an intervention.
- **样片的水准不再由你亲自定。** 照样片检查对照的是通过了的样片，可能是审查者或检查放行的；你不认可样片时，照常说哪里不好，它就返工，或让负责人换样片。 / **The bar is no longer set by you in person**; say what is wrong with the sample and it is reworked, or the sample moves.

## 数据 / Your data

视频导演的职责、「关键帧出片」技能、一条记忆（「样片放行只认用户在输入框发的普通消息…」）和工作区 `film-kit/README.md` 里也写着样片交你放行，同日按这条改掉或停用（职责和技能的修改有修订记录，可撤销）。
The video director's duties, its 关键帧出片 skill, a memory about how to get the sample approved, and the workspace's `film-kit/README.md` said the same; they were changed or disabled the same day, with revisions kept.
