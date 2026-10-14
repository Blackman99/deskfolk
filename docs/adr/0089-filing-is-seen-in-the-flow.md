# 归属只在流程里看 / Where a line is filed is seen in the flow

Status: implemented 2026-10-14. Replaces the tag and dialog of [ADR 0043](0043-work-items-and-attribution.md) (2026-10-02 redesign) and its 2026-10-03 addendum 「用一句话新开一件事」; keeps the reading of [ADR 0057](0057-the-job-a-line-is-about-is-read.md) and the flow steps of [ADR 0083](0083-flow-draws-the-apps-calls.md).

## 背景 / Context

一句话归到哪件事，先看它自己指着的（卡片上选的、批注、引用回复、路径、绑定的工作），没有就由模型读（ADR 0057），读不出的交给 Bot 在桌面段选。结果原来挂在每段话下面：一个归属标签（「EP01 › 剪辑」，没有归属的写「未归属 · 选择归属」），点它或右键「改归属…」打开弹窗，能改到别的事、不归、或「新开一件事」。你说：「归属作为应用内置行为不要展示出来，也不让手动改，只能在流程里查看」。

Which job a line is about is taken from what it points at (a choice on a card, an annotation, a quoted reply, a path, bound work), else read by a model (ADR 0057), else chosen by the Bot at its desk. The result used to hang under every run of lines: a tag ("EP01 › Cut", or "Unfiled · Choose"), which — or the right-click "Change attribution…" — opened a dialog to move the line to another job, to none, or to "A new job". You said: filing is the app's own behaviour; don't show it, don't let it be changed by hand, and let it be seen only in the flow.

## 决定 / Decisions

1. **会话里不显示 / Not shown in the conversation.** 消息下面不再有归属标签，桌面和手机都一样。和 2026-10-14 早些时候拿掉的「已放行」「已转回返工」那行字一样：这是应用替你做的判断，结果照旧生效。 / No tag under any message, on desktop or phone. Like the "Approved" / "Sent back" lines taken out earlier the same day: it is a judgement the app makes for you, and it still takes effect.

2. **不能手动改 / Not changed by hand.** 右键和长按菜单里没有「改归属…」，改归属的弹窗和「新开一件事」都去掉了；`PATCH /v1/messages/:id/attribution` 也去掉，本机和远端（中继白名单）都是 404，所以别的客户端也改不了。`store.newJobFromLine` 只为它而有，一起删除。`store.refileMessage` 留着：旧的「新开：…」卡上的「并入」（ADR 0058 起不再贴新卡，已贴的照样能按）还用它。`GET /v1/messages/:id/attribution` 只读地留着，Bot 关于某件事的提问卡用它写出事和任务的名字；会话只在有这种提问时才请求它。 / The right-click and long-press menus lose "Change attribution…", and the dialog and "A new job" are gone; so is `PATCH /v1/messages/:id/attribution`, a 404 locally and over the relay (it left the remote whitelist), so no other client changes it either. `store.newJobFromLine` existed only for it and is deleted. `store.refileMessage` stays: Merge on an old "New job: …" card (none are posted since ADR 0058; those posted can still be pressed) uses it. `GET /v1/messages/:id/attribution` stays, read-only, for a Bot's question card to name its job and ticket; a conversation asks for it only when it holds such a question.

3. **在流程里看 / Seen in the flow.** 一句话菜单里的「这件事的流程」本来就打开它那件事的流程图并选中这句和它的任务，没有归属的打开它自己的流程（ADR 0083）。流程里「读归属」那一步原来只写「归到一件事」；现在 `traceSteps` 给这类步骤加上 `verdict.titles`（读到的事和任务，按现在的名字，事会在整理时改名），步骤写「归到：宣传片 › 剪辑」，几件时「归到：宣传片、海报」，任务和事同名只写一次，有一件名字查不到时仍写件数。调用自己的记录（`call_runs.verdict`）不变，名字只在画板时查。锁定信号定下的归属没有读归属这一步，这句话就画在那件事的流程里。 / "This job's flow" in a line's menu already opens its job's flow with the line and its ticket picked, or a job-less line's own flow (ADR 0083). The flow's filing step used to say only "Filed under a job"; `traceSteps` now adds `verdict.titles` to such steps (the jobs and tickets read, by their current names — jobs are renamed as they settle), so the step says "Filed under: Promo › Cut", or "Filed under: Promo, Poster" for several, a ticket named as its job only once, and a count when a name cannot be found. The call's own record (`call_runs.verdict`) is unchanged; names are looked up when the board is drawn. A filing set by a locked signal has no reading step: the line is drawn in that job's flow.

4. **桌面段的提示不再叫你选 / The desk's notice no longer asks you to choose.** 桌面段两次没选好归属时那条「这句话需要先选归属，尚未执行有副作用的工具」改成「没分清这句话是哪件事的，还没动手（有副作用的工具一个都没执行）；说一下是哪件事再继续」：没有东西可选了，它说停在哪、怎么接着走。 / When a desk segment spends its two filing bounces, its notice "This line needs a job selected before work can proceed" becomes "Could not tell which job this line is about, so nothing was done (no tool with side effects ran); say which job to go on": there is nothing to pick any more, so it says where it stopped and how to go on.

## 取舍 / Trade-offs

- **归错了只能用话改 / A wrong filing is put right in words.** 引用回复那件事里的一句（引用继承被引消息的全部归属，是锁定信号），或者停下再说一遍；同一种读错反复出现，在分工页调「读归属」的提示词。粘到旧事上的新需求不能再一键拆出来。 / Quote a line of the right job (a quote inherits every filing of the line it quotes, a locked signal), or stop and say it again; when the same misreading keeps coming, tune the filing prompt on the Roles page. A new request glued to an old job can no longer be split off with one click.
- **一眼看不到 / Not at a glance.** 要知道一句话归在哪得打开流程；流程本来就是看「应用替你做了什么」的地方。 / Knowing where a line went takes opening its flow, which is where the app's own doings are looked at.
- **不做的 / Not done.** 流程里改归属，「读归属」步骤之外的归属来源（锁定信号）单独成一步。 / Changing a filing from the flow; a step of its own for filings set by locked signals.

## 实现 / Implementation

信使：删 `chat/MessageAttribution.svelte`、`chat/AttributionDialog.svelte`、`copy/attribution.ts` 和 `chat/attribution.ts` 里只为它们的函数（只留 `AttributionPlan` 类型）；`ChatStage` 只在有提问卡时载入事情列表；`MessageContextMenu` 去掉 `onAttribution`；`runtime`/`api-base`/`message-edits` 去掉 `patchMessageAttribution`、`newJobFromMessage`、`loadAttributionFor`；`copy/trace-steps.ts` 的 `filedUnder` 写名字。守护进程：`local-api/routes/messages.ts` 和 `remote/routes.ts` 去掉 `PATCH`；删 `store/new-job-from-line.ts`；`store/call-runs.ts` 的 `withFilingTitles`；`store/desk.ts` 的提示。协议：`CallRunVerdict` 的 filing 多一个可选的 `titles`，去掉 `PatchMessageAttributionRequest`、`NewJobFromLineRequest`。
