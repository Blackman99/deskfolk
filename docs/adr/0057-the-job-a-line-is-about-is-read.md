# 一句话归到哪件事由模型读，不靠规则猜 / Which job a line is about is read by a model, not guessed by rules

Status: implemented, from engine level 2 (work items), where the rows file a line. Below it the organizer's message-time call still files lines, as before.

[ADR 0040](0040-agent-kernel-the-job-owns-state.md) 把一句话归到哪件事交给了确定性的规则（§8.2）：先读这句话自己带的引用（锁定的 1–5），没有引用时再按默认规则 6–9 猜一件——只剩一个候选就归它（6），话里的镜号在候选里唯一对得上就归它（7），群里只有一件进行中的就归它（8），私聊里紧接在 Bot 那句话之后就归到那句话的事（9）。防止新要求被粘到旧事上的，只有一份看开头的词表：「另外 / 再帮我 / 新做 / 顺便」开头才不接旧事。镜号从话里和交付的文件名里按格式认（「前三镜」「Shot 12」「C07」`shot_07.mp4`）。

ADR 0040 §8.2 filed a line by fixed rules: first the references the line itself carries (the locked signals 1–5), and without one a default guess — the only candidate left (6), a shot number in the line that matches uniquely (7), the group's one job in progress (8), the job of the Bot's line it comes right after in a direct (9). The one guard against gluing a new request onto an old job was a word list on how the line opens: 「另外 / 再帮我 / 新做 / 顺便」. Shots were found by number patterns in the line and in delivered file names.

这样归错过好几次，都落在没有锁定信号、靠默认规则猜的地方：

It went wrong where a default had to guess:

- 2026-10-02，你和 zz-stop-A 的私聊：「请写一篇 4000 字的中文长篇科幻小说」「直接回复“收到”两个字」等五句新要求，全被规则 6 归到了那里唯一开着的「请用 shell 工具执行 sleep 120…」上。 / Five new requests in a direct, all filed under the one open job, 「sleep 120」, by rule 6.
- 2026-10-03 01:13：日报交出来三分钟后你说「标题跟 LOGO 没有对齐」，规则 6 把它归到三天前的地址任务上（于是有了规则 9）。 / A complaint three minutes after the morning brief went to a three-day-old address job by rule 6 (rule 9 came of it).
- 2026-10-03 11:03，视频群：「制作《一拳超人》动画」被规则 6 归到「让审片员回复视频导演，说明未回复原因并给出审片意见。」上，「从头再做一遍，之前的作废」跟着也归了过去。 / In the video group, 「制作《一拳超人》动画」 went under 「让审片员回复视频导演…」 by rule 6, and 「从头再做一遍，之前的作废」 after it.

你问规划整理是不是由 agent 自动做的，并说不要用任何文本匹配。一句话说的是哪件事，是理解，不该由开头的几个字、话里的数字格式或「只剩一个」来定（[ADR 0055](0055-lines-read-by-a-model.md) 对叫停、挑毛病、许诺已经这样做了）；读完之后归不归、开不开新事，仍由确定性代码写。

You asked whether plan organizing is done by an agent, and said it must not use any text matching. Which job a line is about is understanding; it was never for an opening word, a number pattern or "there is only one" to decide ([ADR 0055](0055-lines-read-by-a-model.md) did the same for stops, complaints and promises). What follows from the reading — filed or not, a new job or not — is still written by deterministic code.

## 决定 / Decisions

1. **引用照旧锁定 / References stay locked.** 1–5 不变：你在界面上选的、批注的文件或它批的那句、引用回复、附件和话里写出的 `work/…` 路径、这句话绑定的工作。它们是这句话自己指着的东西，不是对它的意思的猜测；话里写的路径和附件一样，是一个确切的位置。 / Signals 1–5 stay: what you chose, an annotation's file or line, a quoted reply, attachments and `work/…` paths written in the line, the work it is bound to. They are what the line points at, not a guess at what it means; a path in the words is an exact place, as an attachment is.

2. **默认规则换成模型读 / The defaults become a reading.** 规则 6–9、开头词提示、话里的镜号都去掉。没有锁定信号时，`reader.ts` 的 `filing` 用一次无工具的短调用读这句话（提示词 `READ_FILING_SYSTEM`，载荷由 `store.lineToFile` 和 `prompts/reader.ts` 的 `filingPayload` 组成）：这句话、在哪说的、之前六句（谁说的、多久以前、各归在哪件事），以及它可能在说的事——会话的候选（`planCandidates`），加上之前那几句所在的事（日程的常驻规划、休眠的也算：你刚看完的日报就在里面），每件带名字、目标、阶段、开在哪、最后动静、任务（状态、谁在做、声明过的分件）、最近交出的文件、你最近对它说的一句。它回答 `about`：`jobs`（是哪几件，可带任务和分件，都用它看到的编号 J1/T1/分件 key）、`new`（不是其中任何一件：一件新事，或和这些事都无关的话）或 `unclear`（看不出是哪件）。回答先对照它看到的编号核对：编号不对的丢掉，一个都不剩就当 `unclear`；归档时目标已经验收、作废或不在了，也丢掉。读出来的归属是 `default`，记成 `filed_by = reader`，你和 Bot 的 `work_on` 都能改。 / Rules 6–9, the opening-word hint and shot numbers in the line are gone. Without a locked signal, `reader.ts`'s `filing` reads the line in one tool-less call (`READ_FILING_SYSTEM`; payload from `store.lineToFile` and `filingPayload`): the line, where it was said, the six lines before it (who, how long ago, which job each was on), and the jobs it may be about — the conversation's candidates plus the jobs of those lines (a routine's standing plan or a dormant job included: the brief you just read is among them), each with its name, goal, stage, home, last move, tickets (state, owner, declared parts), recent files and what you last said about it. It answers `about`: `jobs` (which, with a ticket and parts, by the refs it was shown), `new` (none of them: new work, or nothing to do with them) or `unclear`. The answer is checked against those refs; a target closed or gone by filing time is dropped. A reading files the line as a `default`, `filed_by = reader`, which you and a Bot's `work_on` can change.

3. **读不了就交给 Bot，不退回词表 / No word lists behind it: the Bot's desk.** 没配模型、调用出错、超过 20 秒、回答读不懂，这句话就是未归属（`unread`），由被叫醒的 Bot 在桌面段选：桌面段的候选和读法看到的是同一份（`lineCandidates`），所以读法选得到的，Bot 也选得到。读成 `new` 的也留给桌面段，但记下这个读法（`messages.filing_reading = 'new'`）：桌面提示告诉 Bot 应用读出它不是哪件事，它第一次有副作用的调用就为这句话新开一件事（哪怕有几个候选），除非它先用 `work_on` 选了某件。`unclear` 照旧：一个候选时第一次副作用默认归它（桌面提示里写着），几个时必须先选；退回的提示里也写出可以 `{new}`。读法从不自己开新事：只回答问题、闲聊时不该多出一件事，开事要等真动手。 / No model, a failed call, more than 20 s or an unreadable answer: the line is unplaced (`unread`) and the Bot it wakes chooses at its desk, which captures the same jobs (`lineCandidates`), so what the reading could choose the Bot can. A line read as `new` goes to the desk too, marked (`messages.filing_reading = 'new'`): the desk is told, and its first effect opens a job for the line even beside several candidates, unless the Bot chose one with `work_on` first. `unclear` is as before: one candidate is the first effect's default (the desk says so), several must be chosen, and the refusal now names `{new}` as a choice. A reading never opens a job by itself: answering or chatting should leave no job behind; a job opens when work starts.

4. **分件由 agent 声明 / Parts are declared by agents.** 分件只有负责人用 `plan_items` 声明的（和你在看板上加的）。交付用 `submit` 的 `parts` 写明交的是哪几个；没写的、应用替它交的（隐式交付）算整张任务的。文件名不再造出或认出分件（`registerFilenameParts` 和规则 7 的 `matchParts` 删掉）。一句话的分件来自读法（只记它要改、挑毛病或问到的那几个，夸一句的不算）或它的引用（批注的那个文件正是某个分件当前的文件）；返工卡问的就是这句话归在的那几个分件，不再从挑毛病的分句里找镜号。Bot 的局面里列出本轮任务的分件和阶段。 / Parts are only those the lead declares with `plan_items` (or you add on the board). A hand-over names the ones it covers in `submit`'s `parts`; one that names none, or that the app hands over for the Bot, is the whole ticket's. File names no longer make or pick parts (`registerFilenameParts` and rule 7's `matchParts` are gone). A line's parts come from the reading (only those it asks to change, faults or asks about, not one it praises) or its references (an annotated file that is a part's current file); a rework card asks about the parts the line is filed under, with no shot numbers picked from the complaint's words. A Bot's situation lists its ticket's parts and their stages.

5. **和读句一起读 / Read beside the line reading.** 归属的读法和读句（ADR 0055）同时发出：一句话等两次调用中慢的那个，不是两个相加。同一个「读句用的模型」、同一条并发通道、同样 20 秒；每次读都记 `reader.answer`（`read: "filing"`），花费记作 `organize`、用途 `reader`。 / The reading of where a line belongs goes out together with ADR 0055's reading of the line, so the line waits on the slower of the two. Same 读句 model, same lane, same 20 s; each is logged as `reader.answer` (`read: "filing"`) and billed as `organize` / `reader`.

6. **还按文本对的地方，以及为什么 / What still compares text, and why.** 话里写出的 `work/…` 路径按目录精确查（一个位置，不是意思）；`plan_items` 把负责人写的分件名按镜号定成同一个 key（「Shot 07」和「C07」是同一个分件，`part-numbers.ts`）；外部作业「一个镜头只跑一个渲染」的防重按提示词里的镜号（ADR 0047，不决定任何归属）；整理跳 settle 新提的任务按标题和已有任务对上，免得重复开；ADR 0055 里控制句、进度询问、挑毛病、许诺在模型读不了时退回的词表。这些都不决定一句话归到哪件事、哪个任务或哪个分件。 / A `work/…` path in the line is looked up as a directory (a place, not a meaning); `plan_items` keys the lead's part names by shot number so 「Shot 07」 and 「C07」 are one part (`part-numbers.ts`); the external-job guard keeps one render per shot by the number in its prompt (ADR 0047; it files nothing); the organizer's settle matches a ticket it proposes to an existing one by title rather than open it twice; ADR 0055's fallback word lists for control lines, status questions, complaints and promises. None of them decides which job, ticket or part a line is about.

## 实测 / Measured

2026-10-04，用真实端点逐条读 13 句（上面三次事故的原句，加上回应 Bot 刚交的东西、「另外」开头却在改原来那件、问候、同类的新海报、点名三个镜头、夸一个挑一个），最轻思考档：

On 2026-10-04, one at a time on the real endpoints, 13 lines (the incidents above verbatim, plus a reply to what the Bot just handed over, an 「另外」 line that changes the old job, a greeting, another poster of the same kind, a complaint naming three shots, one praising a shot and faulting another), at the lightest thinking level:

| 模型 / Model | 对 / Right | 每句 / Per line |
|---|---|---|
| deepseek-v4.1-flash（你的读句模型 / your reading model） | 13/13 | 0.55–1.1 s |
| grok-4.7-build-fast（默认 / default） | 13/13 | 1.9–6.6 s |

「制作《一拳超人》动画」、两句接在 sleep 任务后的新要求、「从头再做一遍，之前的作废」都读成新事；「标题跟 LOGO 没有对齐」读成日报那件、落到今天那张任务；「C07 很好，C08 太假」只记 C08。

「制作《一拳超人》动画」, the two new requests after the sleep job and 「从头再做一遍，之前的作废」 read as new; 「标题跟 LOGO 没有对齐」 as the brief's, on today's ticket; 「C07 很好，C08 太假」 names C08 alone.

## 取舍 / Trade-offs

- **多一次调用。** 开着事的会话里，你的每句没有引用的话多一次短调用（和读句并行，读句模型用 deepseek-v4.1-flash 时中位不到 1 秒）。问进度、叫停的话也会读一次归属（两次一起发出），读完不用。 / One more short call per line of yours with jobs open and no reference (beside the line reading). A status question or a stop is read for where it belongs too, and the reading goes unused.
- **模型会读错。** 读错的代价有限：归错的可以改归属或「新开一件事」；读成新事的，Bot 在桌面上还能选回原来那件；读法不会自己开出一件事。 / A misreading is bounded: a wrong filing is moved with 改归属 or 「新开一件事」; one read as new can still be placed on an old job by the Bot; a reading never opens a job by itself.
- **规则 9 的硬边界没了。** 「两小时内、中间没有你别的话」现在由模型判断：它看得到每句话是多久以前说的、中间还有谁说了什么。 / Rule 9's hard limits (two hours, nothing of yours in between) are the model's judgement now; it sees how long ago each line was and what came between.
- **读不了时多一跳。** 没有模型或调用失败时，开着事的会话里每句话都到桌面段，由 Bot 先选再动手。 / Without a model, every such line goes to the desk: one more step for the Bot.
- **隐式交付不再有分件。** 分件要负责人声明、交付时写明；实况库里还没有任何分件（2026-10-04 查，0 行）。 / Implicit hand-overs carry no parts; parts need declaring and naming. The live database had none (0 rows on 2026-10-04).

## 缺口 / Not done

- 群里没有确认负责人、几个 Bot 都接了一句读成新事的话时，各自第一次副作用可能各开一件（0 个候选时本来就会这样）。 / In a group with no confirmed lead, several Bots taking a line read as new may each open a job at their first effect (as with no candidates before).
- 13 句不是系统的准确率测量；群里几件事同时开着、Bot 之间来回说话时的读法还没量过。 / Thirteen lines are no systematic measure; readings in a group with several jobs open and Bots talking among themselves are not measured yet.

## 2026-10-08：改设置不开事 / A settings change opens no job

「开事要等真动手」里，任何有副作用的调用都算动手，改应用自己的设置也算。于是在你的私聊里问「你能根据已经配置的模型补一下它们的上下文大小配置吗」，工作区文件助手的 `update_endpoint` 为这句话开了一件事和一张产出任务。窗口补上了，Bot 也说了，可设置既交不成文件，也不是一段可交的文字，任务一直待做：结束约定退回一次后按 nothing_new 收尾；十分钟后监督把它叫回来（「还没收口……接着做」，只给 Bot 看），它把同样的回答又发了一遍；第二次没有进展的结束让这件事停下，发了「连续两次结束都没有进展……先停下等你」。现在增删改端点和 MCP 服务器、`measure_model`、`update_model_settings` 在桌面段直接执行、不开事（`SETTINGS_TOOLS`，`engine/tools.ts`），也不算用过工作目录；叫停时照样拒绝，要批准卡的照旧出卡。桌面段的情境写明这一点，免得 Bot 先自己 `work_on` 开一件。写文件、跑命令、有效果的 MCP 工具照旧在第一次时开事。 / "A job opens when work starts" counted any call with an effect as work, a change to the app's own settings included. Asked in your direct 「你能根据已经配置的模型补一下它们的上下文大小配置吗」, 工作区文件助手's `update_endpoint` opened a job with a produce ticket for the line. The window was set and the Bot said so, but a setting is neither a file nor words to hand over, so the ticket stayed To do: the end contract sent the ending back once and it closed as nothing_new; ten minutes later the supervisor called the Bot back (a line only it sees) and it posted the same answer again; the second ending with no progress stopped the job with 「连续两次结束都没有进展……先停下等你」. Now adding, changing or deleting an endpoint or an MCP server, `measure_model` and `update_model_settings` run at the desk with no job (`SETTINGS_TOOLS` in `engine/tools.ts`) and do not count as using the work directory; a stop still refuses them and a card still comes where one did. The desk situation says so, so the Bot does not open one itself with `work_on` first. Writing files, running commands and MCP tools with an effect open a job at the first call as before.

未做 / Not done: 记忆、技能、例行、提示词、自己的资料、建 Bot 和群这些同样只改应用记录的工具，从桌面段调用时仍会开事；还没见到它们这样卡住，出现时按同样的理由放开。 / Memories, skills, routines, prompts, a Bot's own profile and creating Bots or groups change only the app's records too, and still open a job from a desk; none has been seen stuck this way yet, and the same reasoning applies when one is.

未做 / Not done: 先用命令查资料（`curl` 一类，不写文件）再改设置，第一次命令照旧开事，结局还是一样：回复被「未完成义务」退回，按 nothing_new 收尾，任务待做，等监督来叫。命令写了文件的，收尾时文件按隐式交付交出，能收口；没写的，只有 `end_turn(done, answer)` 交一段文字、再等你放行。要不要把只查不写的命令也当成不开事，是另一个决定（命令有没有效果事先看不出来，ADR 0046 也不从纯文字回复推断交付）。 / Looking things up with a command first (`curl` and the like, writing nothing), then changing a setting, still opens a job at that command and ends the same way: the reply is sent back for the unfinished ticket, it closes as nothing_new, the ticket stays To do for the supervisor. A command that wrote a file closes, the file handed over implicitly at the end; one that wrote nothing leaves only `end_turn(done, answer)`, words waiting for your approval. Whether a look-up that writes nothing should open no job either is a separate decision: a command's effect cannot be told beforehand, and ADR 0046 infers no hand-over from a reply in words.
