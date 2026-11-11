# 停下的活不再刷屏，样片不再等你放行 / Stopped work says less, and the sample no longer waits for your approval

Status: implemented 2026-11-11. Amends [ADR 0060](0060-large-jobs-sample-first.md) (the sample's 放行), [ADR 0084](0084-you-let-work-through-by-what-you-say.md) (a sample needs a clear yes), [ADR 0045](0045-supervisor.md) (the supervisor's 「这件事停下了」) and [ADR 0061](0061-claude-agent-runner.md) (failures only you can fix).

2026-11-10，你和视频导演的私聊里做一支古风 MV。第一场样片交上来后，第二场的出图一直被拒（`waits_for`）：你的「继续」读成了叫它接着做，提问卡上的回答不过读句，「第一场放过」没读成放行；Bot 让你在输入框里原样打「第一场样片通过」，第五次才记上，第二场晚开工一个多小时。当晚 Claude 的用量额度用完：之后 20 分钟里监督器把它叫回四个场次各两次，每次一开工就失败，私聊里连着十条「这一轮没写完：Claude 的用量额度用完了（11/11 01:30 重置）」；四个场次叫满两次后，又各贴一条「这件事停下了：…」。你说：样片放行这个逻辑没有存在的必要，整体去掉；重复的提示只要一条；「这件事停下了」这种系统提示不要出现，隐式就可以，也不要重复。

On 2026-11-10 an MV in your direct with the video director: once scene one's sample was handed over, scene two's generating calls were refused (`waits_for`) — your 「继续」 read as "go on", a question card's answer is never read, and 「第一场放过」 did not read as approval; the Bot had you type 「第一场样片通过」 word for word, which took on the fifth try, an hour late. That night Claude's usage ran out: over 20 minutes the supervisor called the Bot back to four scenes twice each, every call failing at once, and the direct got ten 「这一轮没写完：Claude 的用量额度用完了（11/11 01:30 重置）」 in a row, then a 「这件事停下了：…」 per scene. You said the sample's approval has no reason to exist and should go entirely; a repeated notice should show once; and 「这件事停下了」 should not appear at all, nor repeat.

## 决定 / Decisions

1. **额度用完不再叫回，同样的失败只显示一次 / Out of usage: no call-backs, and the same failure shows once.** ADR 0061 说只有你能解决的失败（没找到 Claude Code、没登录、用量用完）不替你重试，但监督器的「没人推的任务」叫回绕过了这一条。现在一个 Bot 最近一次结束的一轮是这几种失败（`AGENT_OUT_FAILS`）时，监督器不叫回它、也不续跑它的工作，直到它有一轮以别的方式结束（你说话、你按继续）。作业结果、回看这类别的叫醒照常；它们又失败、而且失败行和会话里你能看到的最后一行一字不差时，这一行只留给 Bot（`bot_only`），不显示、不推送、不另发通知；那一轮的「继续」用上面那条。
   ADR 0061 does not retry what only you can fix, but the supervisor's call-backs to quiet tickets went round it. A Bot whose last ended turn failed that way (`AGENT_OUT_FAILS`) is no longer called back or picked up until a turn of it ends some other way. Other wakes still run; a failure line identical to the last line you can see there is kept Bot-only, with no publish and no notification, and Continue on the line above still works.

## 取舍 / Trade-offs

- **额度重置后不会自己接着做。** 监督器不知道重置时间（只有失败行里的文字），所以等你一句话；Claude Code 的 `resetsAt` 在 `agent-runner.ts` 里拿得到，要自动接着做可以从那里接。 / **Nothing resumes on its own after the reset**: your word does. `resetsAt` is available in `agent-runner.ts` if that is wanted later.
