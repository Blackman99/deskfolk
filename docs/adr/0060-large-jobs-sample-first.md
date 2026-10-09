# 大活：先拆，先做样片，再铺开 / Large jobs: laid out first, a sample first, then the rest

Status: implemented 2026-10-04, at engine level 5 (`ENGINE_LEVELS.submissions`, where tickets have stages and `plan_items` exists). Builds on [ADR 0053](0053-plan-items.md) (plan_items), [ADR 0046](0046-submissions-and-reviews.md) (submissions) and [ADR 0036](0036-acceptance-checks-run-by-the-daemon.md) (checks); one exception to ADR 0046's "pictures are only a reference".

2026-10-04，你让视频导演做一整集 20 分钟的动画。它把整集当一张任务，一个人跑了 9 段、308 次模型调用，交上来一份 1200 秒的成片：339 刀里只有 40 个素材，1076 秒（90%）是静态图片加推拉摇移，8 段真视频各被反复剪进去 5–7 次，同一张图出现 23 次；25 句配音被写死在 95、125、170 秒这样的整数时间点上，和画面对不上。唯一的验收检查（黑场、冻帧、响度、镜长）全过。你打了 3 分，说「这不是视频，是 PPT」。

On 2026-10-04 you asked the video director for a whole 20-minute episode. It made the episode as one ticket, alone, over 9 segments and 308 model calls, and handed in a 1200-second cut: 339 cuts of only 40 sources, 1076 s (90%) still pictures under zooms and pans, its 8 real clips each cut in 5–7 times, one picture shown 23 times; 25 voice lines pinned to round timestamps (95, 125, 170 s) with no tie to the picture. Its only check (black, frozen frames, loudness, shot length) passed. You scored it 3 out of 100: "this is not a video, it is a slideshow".

问题不在这一个 Bot。任何大的东西（一整集、一本书、多章报告、多页网站）当一件事一口气做，都会这样：上下文越滚越大，能被量的（时长、响度）做满，量不到的（是不是动画、配音对不对得上）塌掉；降级方案由干活的人自己提、自己写说明、自己标推荐；直到最后才让你看到第一眼。

The trouble was not this one Bot. Anything big — an episode, a book, a many-chapter report, a many-page site — made as one thing in one go goes the same way: the context grows, what can be measured (length, loudness) is met and what cannot (is it animation, does the voice match) falls apart, the cheaper form is proposed, described and recommended by whoever does the work, and the first thing you see is the end.

## 决定 / Decisions

1. **大活 / A large job.** 一件事的大小是任务上的一个读数（`tasks.scale`：`large` 或 `single`，`scale_by` 写是谁认的：`reader`、`signal`、`user`；`scale_why` 是依据，`scale_unit` 是一件多大，如「一场」）。两条路认出大活： / A job's size is a reading on the plan (`tasks.scale`, with who read it, what it stood on and what one unit is). Two ways in:
   - **读句**（ADR 0055 的读句模型，`READ_SCALE_SYSTEM`）：你的一句话归到一件还没读过的事上，就带着你对这件事说过的所有话读一次「是不是要拆成几件、先做样片才做得好」。看要的东西本身，不看措辞；说不清就不算。没有词表：读不出就不标。 / **The reader**: a line of yours filed under a job not read yet is read, with all your words about the job, for whether it needs laying out in units with a sample first. It goes by what is asked for, not wording; unsure is no. There is no word list; an unread job stays unread.
   - **运行信号**（`signalFacts`）：一件没读过、没拆过、没有一张任务通过的事，做完 3 段以上，监督器每拍带着这些事实再请读句模型读一次（同样的段数只读一次）；读句模型读不了时，信号自己标大活。 / **The signal**: a job not read, not laid out and with nothing approved, after 3 or more ended segments, is read again each supervisor tick with those facts (once per segment count); when no model can read it, the signal marks it itself.
   读句和信号只会把没读过的事标成大活，一次，永远不覆盖你的。你在看板上说「不用拆」（`PATCH /v1/tasks/:id {scale: "single"}`）之后，什么都不会再把它读成大活；你也可以把一件事标成大活。 / A reading only ever marks an unread job large, once, and never overrides yours. Once you say "no need" on the board nothing reads it as large again; you can also mark a job large yourself.

2. **先拆后做 / Laid out first.** 大活在拆好之前（`layoutMissing`：没有样片，或者没有任务在等样片），一段在它上面的执行： / Until a large job is laid out (no sample, or nothing waiting for it), a segment on it:
   - 有副作用的 MCP 调用（出图、出视频这类；只读的和查已有作业的不算）被拒，`layout_first`；
   - `submit` 被拒；收尾时留下的文件和话不交付（`prepareSubmission` 返回空，不报错）；
   - 读文件、写笔记和脚本、跑本地命令照常；
   - 局面里写着「这是件大活，先拆再做」，以及读到的依据和一件多大。
   - Side-effect MCP calls (generating images or video; read-only calls and checks on running jobs aside) are refused (`layout_first`); `submit` is refused, and files or words left at an ending are simply not handed over; reading, notes, scripts and local commands go on; its situation says so.
   拆的是负责人：`plan_items` 加了 `sample: true`。一件事一个样片；大活的拆分必须有样片、并且有任务在等它，否则整次调用不生效。 / The lead lays it out: `plan_items` items take `sample: true`, one per job; a large job's layout stands only with a sample and something waiting for it.

3. **其余各件等样片 / The rest wait for the sample.** 标了样片，规划里除了样片和样片自己依赖的（设定集、提纲，往前一路都算），还没通过的任务都加上依赖它（`waitOnSample`）；之后再拆出来的也一样。 / Once a sample is set, every ticket but the sample and what it depends on (however far back), not through, waits for it; so do tickets laid out later.

4. **依赖从此是真的 / Dependencies now hold.** 5 级起，`depends_on` 不再只是看板上的说明（之前只在叫停时看）。一张任务等的那张没过，它就不开工（`waitingOn`）：监督器不叫醒（球在应用：`waits`），`work_on` 拒绝挂到它上面，委派它的成果被拒，它上面有副作用的 MCP 调用和交付被拒。「过了」对样片是你放行（已通过）；对别的任务是交出去过（已交付、审查中、已通过，或交过之后返工）——要等每一张都通过，下一张就得等你的卡片。作废或搁置的不拦任何人。一张没人开工过的任务，等的都过了，监督器下一拍就叫它的负责人，不等平常的安静期（`readyToStart`）：拆好的活在前一件交上来时就往下走。 / A ticket nobody has started, all it waits for through, has its owner called at the next supervisor tick rather than after the quiet window. From level 5 `depends_on` holds. A ticket whose dependency is not through does not start: the supervisor wakes nobody for it (the ball is the app's, `waits`), `work_on` refuses it, a deliverable delegation of it is refused, and side-effect MCP calls and hand-overs on it are refused. Through means approved for the sample; for any other ticket, handed over at least once — waiting for every approval would put each next ticket behind your card. A dropped or parked ticket holds nobody.

5. **样片和最后一件由你放行 / The sample and the last one are yours.** 样片的交付总是到你的放行卡上，有审查者也一样（审查者先审，审完到你）；有你确认过的检查撑着也一样。卡上写这是样片、它定下其余各件的水准，以及它实际花了多少：几段、约几分钟、模型费、出图出视频这类外部调用几次（费用以各服务为准），再按样片的规模粗算剩下 N 件（`sampleSums`）。大活拆好之后，最后一张没通过的任务（放行它整件事就交付）也到你的卡上。这两张是 ADR 0058 说的「要你放行」：水准只有你定得了。中间各件按原来的规则走，有检查撑着就不问你。 / The sample's hand-over always comes to your approve/reject card, reviewer or not and whatever checks back it. The card says it is the sample, that it sets the standard for the rest, and what it took — segments, minutes, model spend, generating calls — with a rough sum for the remaining N. The last ticket of a laid-out large job (approving it delivers the job) comes to you too. Both are ADR 0058's "let it through": only you set the bar. The units in between go by the usual rules.

6. **照样片 / Held to the sample.** 你放行样片，等它的每张任务各得一条检查（`acceptance_checks.standard_of` = 样片，`origin = 'sample'`，`source = 'user'`，存成 `continuity` 让旧版本读成一条没东西可比的衔接检查）。每次交付时应用自己取证、请默认模型对照：视频取最长那条的时长、分辨率、有没有声音、关键帧里不同画面的数量和同一画面最多出现几次，再均匀取 5 帧；图片取前几张缩略图；文字取开头、中间、结尾。提示词写明内容不同是正常的，只比做工和形式（样片画面在动、这次是静图推拉，就是没达到），拿不准就判达到。 / When you approve the sample, each ticket waiting for it gets a standard check. At every hand-over the app gathers the evidence itself — for video the longest file's length, size, sound, how many different pictures its keyframes show and how often one comes back, plus 5 evenly spaced frames; thumbnails for pictures; opening, middle and end for text — and the default model compares it with the sample's approved hand-over, told that content differs and only craft and form count, and to pass what it is unsure of.
   - 它是门禁：判了「没达到」就把交付退回，写明差在哪；判了「达到」，它和你确认过的检查一样撑得起无人审查的放行。 / It is a gate: a fail sends the hand-over back with what falls short; a pass backs an approval with no reviewer like a check of yours.
   - 判不了（还没交东西、没有模型、你的叫停、当天看图预算用完）不算过也不算没过，什么都不拦，交付回到你的卡片。 / A judgement it could not make holds nothing and backs nothing; the hand-over comes to your card.
   - 它只在交付和放行时按 id 跑，整理的全量重跑跳过它；任务通过或作废之后，它也不再把规划拦在进行中。真跑时，第 5 章交付时判「达到」并放行，交付后的整理把它重跑一遍判成「没达到」，已交付的事被顶回进行中；视频的话每次整理还要为每张任务重新付一遍看图的钱。 / It runs only when a hand-over is made or decided, by id, never on a settle's plan-wide pass, and holds no plan open once its ticket is through: on the real run a settle reran chapter 5's check after its approval, the judge flipped, and the delivered job read in progress.

## 取舍 / Trade-offs

- **看图判定在这里是门禁。** ADR 0046 让看图判定只作参考，等量出翻转率再说。这里破例：标准是你放行的样片定的，比的是相对差距而不是绝对好坏，提示词要求拿不准就判达到，误判的代价是一次返工（能力天花板照旧兜底），而不拦的代价就是这次的 3 分。 / **A picture judgement gates here.** ADR 0046 keeps them a reference until measured. The exception: the bar is the sample you approved, the comparison is relative, unsure passes, a false fail costs one rework (the capability ceiling still applies), and not gating cost the 3/100.
- **普通依赖到「交出去」就算过。** 等每张都通过，群里的流水线（文案 → 海报）就要等你一张张放行；样片不同，它就是要你看过。 / **An ordinary dependency is through once handed over**; the sample is different on purpose.
- **只拦花钱的，不拦写东西。** 拆分之前要先读材料、写剧本和镜头表，拦了就没法拆；出图出视频是花钱又最容易白花的。 / **Only spending is held**, since laying out needs reading and writing.
- **信号读不了就自己标。** 你选的是「读句 + 运行信号」；没有模型可读时，3 段还没一件通过的事按大活处理，误标的代价是先拆一下，你一句「不用拆」就解除。 / **The signal stands alone** when nothing can read: a wrong mark costs a layout, and "no need" undoes it.

## 视频专属的部分 / What is specific to video

不在应用里，在视频导演的职责、「关键帧出片」技能和工作区的 film-kit 里（2026-10-04 同步改）：开工先算账，钱或时间不够就把片子做短，不提拿图片凑时长的方案；大活拆成设定集（含配音语言和每个角色的声音）、样片（第一场）、其余每场一件（60–120 秒）、组装；只用 `cut.py` 剪，台词和字幕挂在镜头上（`shot` + `offset`），超出镜头末尾直接报错；`check.py` 新增「静态图片当镜头」「静图推拉」（一镜首尾两帧在缩放平移对齐后几乎一样，占全片超过 25% 判 FAIL；这次的成片 43%，两部真动画试点片 0%）「画面多少」（同一画面出现 6 次以上 FAIL）「台词挂镜头」和「是不是 cut.py 剪的」。

Not in the app: in the video director's duties, its 「关键帧出片」 skill and the workspace film-kit, changed the same day — budget first and shorten rather than fill with stills; lay out a large film as style sheet (with the voice language and each character's voice), sample (scene one), one ticket per scene and an assembly; cut only with `cut.py`, voice lines and subtitles tied to shots; `check.py` now fails still images used as shots, stills under camera moves over 25% of the film (this cut: 43%; two real animated pilots: 0%), a picture shown 6 or more times, and a master not cut by `cut.py`.

## 真模型走查 / The real-model walkthrough

2026-10-04，隔离运行时（8 级，grok-4.7-build-fast，读句同模型）里一个两 Bot 的群（编辑为负责人、写手），一句「写一本原创童话书……一共 5 章，每章 1200 字左右……最后合成一本完整的书」：读句认出大活（依据「一共 5 章」，每件「一章」）；编辑拆成大纲、第 1 章（样片，依赖大纲）、第 2–5 章（自动等样片）、合成（等每一章）；大纲交出后写手立刻开工样片，编辑审时以字数超出退回一次，再交通过后到你的放行卡（样片头、花了多少、剩下 5 件）；放行后 5 秒写手就开工第 2 章，各章照样片检查都判达到、编辑审过就放行，没有再问你；合成稿到你的卡上（「最后一件……放行后整件事就交付了」），放行后交付。全程找你 4 次。另用一部原创小短片和用它的两帧做成的推拉幻灯片，在真模型上各判两次照样片：幻灯片两次都判没达到（没有声音、18 秒里 2 个画面反复出现、两张静止图来回切换），短片本身两次都判达到。

On 2026-10-04 an isolated level-8 runtime ran a two-Bot group through a five-chapter original book: the reader marked it large, the lead laid it out with the first chapter as the sample, the sample came to your card with its sums, the rest went through on standard checks and reviews without asking you, and the assembled book came to you last. Separately, a real model judged a still-picture slideshow made from an original short against the short itself: it failed the slideshow twice and passed the short twice.

走查里修掉的两处 / Fixed on the way:
- 负责人把任务的 id 填在 `work_on` 的 `plan` 里时，就当作这件事的这张任务；填了别的，拒绝时写明这一段已经在哪件事上、怎么写任务。原来只说「从本轮候选里选一件事」，编辑卡住、停下来问你。 / `work_on` with a ticket of the segment's job named as `plan` goes to that ticket; any other refusal names the job the segment is on.
- 上面说的「轮到它了就立刻叫」和「照样片检查不在整理时重跑」。 / The next-tick call and the standard check kept out of settles, above.

## 缺口 / Not done

- 读句模型读规模的准确率还没在真模型上成批量过；运行信号的 3 段是拍的。 / The scale reading has not been measured in bulk on real models; the signal's 3 segments is a guess.
- 外部服务的花费应用不知道，样片卡上只写调用次数；视频秒数和单价在 Bot 的交付说明里。 / The app does not know external services' prices; the sample card shows call counts.
- 拆分的单位大小靠提示词和技能，应用不量「一件是不是一段能做完」。 / Unit size is left to prompts and skills.
- 照样片的文字取证只取开头、中间和结尾：走查里交付后的整理读出第 5 章开头在复述第 1 章，交付时的照样片检查和编辑的审查都放过了。 / Text evidence is the opening, middle and end only: a settle noticed chapter 5 opening by retelling chapter 1, which its check and review had passed.

## 2026-10-10 补记：方向换了，样片也换 / A new direction, a new sample

「一件事只有一个样片」让方向换了之后没有路可走：IG MV 那件事从 2D 改成 3D，负责人想把 3D 样镜标成样片，`plan_items` 以「已经有样片」拒绝，还让它「请用户在看板上改」——看板上并没有这个操作。结果 3D 任务全按 2D 样片对照，那几条照样片检查对你退回的四版都判「通过」。现在同一时间仍只有一个样片，但可以换：负责人在 `plan_items` 里把新方向的一项标 `sample: true`（可带 `resample_reason`），或你在看板上「设为样片」。旧样片的交付正在检查或等你放行时不能换。换的时候旧样片不再是样片，照它的检查撤下（`removed_by = 'resample'`，运行记录保留；换回来时这些检查重新生成），其余没通过的任务不再等它、改等新样片；新样片照旧由你放行，放行后才按它生成照样片检查（`plan.resampled`）。

"A job has one sample" left a job whose direction changed nowhere to go: when the IG MV job went from 2D to 3D, the lead marking the 3D sample shot as the sample was refused by `plan_items` ("this job's sample is already…"), and told to have the user change it on the board, where there was no such control. Every 3D ticket stayed held to the 2D sample, and those standard checks passed four versions you sent back. A job still has one sample at a time, but it can move: the lead marks the new direction's item `sample: true` in `plan_items` (with an optional `resample_reason`), or you pick "make it the sample" on the board. Not while the old sample has a hand-over being checked or waiting on your card. The old one stops being the sample, the checks held to it come down (`removed_by = 'resample'`, runs kept; made again if it moves back), the tickets not through stop waiting for it and wait for the new one; you approve the new sample as before, and the standard checks against it are made once you do (`plan.resampled`).
