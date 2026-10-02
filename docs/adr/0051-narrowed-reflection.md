# 收窄的反思：误放行和能力天花板之后，提一条清单或一条检查 / The narrowed reflection

Status: implemented at engine level 8 (`ENGINE_LEVELS.learning`), with [ADR 0050](0050-quality-events-and-lessons.md); the second part of issue 28.

[ADR 0040](0040-agent-kernel-the-job-owns-state.md) §7.3 留了一个模型参与的学习口子，但收得很窄：只在两类事件之后跑，只能提两种东西，都要你一键确认才生效。它要补的是签名教训管不到的那类错：审片员放行了机位接不上的镜头，被你推翻；一个分件同一条要求连着过不了。

ADR 0040 §7.3 keeps one door open for a model in learning, and a narrow one: it runs after two kinds of event only, may propose two kinds of thing, and neither holds before you adopt it. It covers what a signature lesson cannot: a reviewer that passed a cut whose camera did not match and was overturned by you; a part that keeps failing the same requirement.

## 决定 / Decisions

1. **何时跑，由应用定 / When, decided by the app.** 调度器每一拍从质量事件里取最早一条还没反思过的 `review_miss` 或 `ceiling`（七天内）。没有可用端点时什么也不取。有叫停罩着这个 Bot、这个规划或这张任务时它等着，叫停解除后再跑。同一 Bot 在同一张任务上一天只反思一次：当天它的第二件事就此跳过（失败的那次不算数）。Bot 已删除、规划没有会话可问你时也跳过。当天反思已花满 2 美元、或已跑满 20 次时，当天不再跑。取到就先记一行 `reflections`（pending），下一拍不会重跑；重启时还在 pending 的，十分钟后记为失败（interrupted），不重试。调用失败也只记一次失败，不重试。 / On each scheduler tick the oldest `review_miss` or `ceiling` quality event (within seven days) with no reflection yet is taken; with no endpoint configured, nothing is. Under a stop over the Bot, the plan or the ticket it waits, and runs once the stop is lifted. A Bot reflects on a ticket once a day: its second event there that day is skipped (a failed one does not count). A deleted Bot, or a plan with no conversation to ask you in, is skipped too. Once the day's reflections cost $2, or twenty have run, none more run that day. Taking it writes a `reflections` row (pending) first, so no later tick runs it again; one a restart left pending is failed (interrupted) after ten minutes, not retried. A failed call is recorded once, not retried.
2. **谁、用什么 / Who, on what.** 当事的 Bot：误放行是审查者，天花板是生产者；用它自己的模型（你钉的、它的默认、端点默认——7 级没有轮次的那次决定），记成 `organize` 类、`reflect` 用途的花费。输入是这张任务的工作日志（最近 40 条，只带状态、结论、阶段、原因、名称、分件和引用的那句话这类字段，不带文件内容）、仍然有效的要求、审查结论和你那句话，不是对话记录。 / The Bot involved — the reviewer for a miss, the producer for a ceiling — on its own model (its pin, its default, the endpoint's default: the level-7 decision with no turn), billed as `organize` with the `reflect` purpose. It reads the ticket's work log (the latest 40 entries, with states, outcomes, stages, reasons, labels, parts and the quoted line only; never a file's content), the requirements in force, the review verdicts and your line — not the transcript.
3. **只能提两种，或者不提 / Two kinds of proposal, or none.** 回答必须是一个 JSON 对象：一条**清单项**（`before_review` / `before_submit` / `before_generate` 三个时机之一，一句具体的话），或者一条**检查提议**（`exists`、`contains` 或 `matches`，对某个文件的；不提 `command`：它会在每次交付时在你的机器上跑，而它的文字出自模型，模型又读过别的模型写的审查结论），或者 `none`。别的都当成没提。不提换模型、不提「更用心」、不让你去做什么，也不写记忆。 / The answer must be one JSON object: a **checklist item** (for one of `before_review`, `before_submit`, `before_generate`, one concrete sentence), a **check proposal** (`exists`, `contains` or `matches`, on a file; never `command`: it would run on your machine at every hand-over, on words a model wrote after reading what other models wrote), or `none`. Anything else is no proposal. No switching models, no "try harder", nothing for you to do, no memory.
4. **你确认才生效 / Yours to adopt.** 提议记成一条待确认（`candidate`）的教训，在规划所在的会话里出一张卡片「采用 / 不要」；检查提议在卡片上原样写出它查什么（种类，加引号的路径、文字或正则）；采用后它和你在板上加的一样，马上跑一次。采用清单项：它进这个 Bot 的局面块，标明是哪个时机的。采用检查提议：加到这张任务上（`origin = 'reflection'`），没过会把交付打回，但不算你写的——不能替你担保一次没人审的放行，你在板上改过一次才算；加不上就在卡片上说为什么，教训停用。不要：教训停用。设置的「教训」页里它只能停用（还在等的提议会关掉卡片；采用过的检查，你没在板上改过的，会从任务上移走，改过的已是你的，留着），清单项可以再恢复；提议只在卡片上采用。 / The proposal is kept as a candidate lesson, with a card in the plan's conversation: Adopt / No; a check proposal's card spells out what it checks (kind, and the quoted path, text or pattern); adopted, it runs at once, as one added on the board does. An adopted checklist item is read in that Bot's situation, marked with its moment. An adopted check is added to the ticket (`origin = 'reflection'`): failing it sends work back, but it is not yours — it backs no approval nobody reviewed until you edit it on the board; if it cannot be added, the card says why and the lesson is retired. No retires it. In Settings' Lessons page it can only be retired (a waiting proposal's card is closed; an adopted check you have not edited on the board is taken off the ticket, one you edited is yours and stays), and a checklist item brought back; a proposal is adopted on its card.

## 缺口 / Not done

- **度量类检查**（时长、画幅、帧率、冻帧）还不能由反思提议：它们现在只从你的原话里来。
- **清单复犯**（§7.4：同一条清单又出两次同样的错，就告诉你它没管住、建议改成检查）还没做。
- **项目级技能**（`shared_skills`）和**报表界面**：下一步。

## 取舍 / Trade-offs

- **一天一次、两美元封顶。** 反思不是每个错都跑；一张任务一天里反复出错，第一次的反思就够用了。
- **用当事 Bot 自己的模型。** 它最清楚自己怎么做的判断；它判断不好，提议也只是一张你可以不要的卡片。
