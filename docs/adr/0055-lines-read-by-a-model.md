# 读句：一句话的意思由模型读，状态仍由规则写 / Reading a line: a model says what it means, rules still write the state

Status: implemented. No engine level: every build reads lines this way, and falls back to the old word lists whenever no model can.

2026-10-03 一天里，AI 影视创作组接连两次因为词表没认出一句话而停住：视频导演说「正在编写全新第 1 集设定集与剧本分镜方案」后就结束了这一轮，「正在编写」不在承诺词里；你说「从头再做一遍，之前的作废」，「作废」「从头再做」也不在投诉词里。两次的修法都是往词表里加词，下一种说法照样漏。你说词表匹配不行，必须让模型来读。

On 2026-10-03 the AI video group stalled twice because a word list did not know a line: 视频导演 said it was writing the new EP01 setting and storyboard plan and ended its turn, and 「正在编写」 was no promise word; you said 「从头再做一遍，之前的作废」 (start over, scrap what came before), and neither 作废 nor 从头再做 was a complaint word. Both fixes added words, and the next phrasing would have missed again. You said word lists do not work here and a model has to read the lines.

[ADR 0040](0040-agent-kernel-the-job-owns-state.md) 的原则是「模型负责理解、提议和干活；状态只由确定性代码写入」。一句话是不是叫停、是不是在挑毛病，本来就是理解，不该由词表来做；读完之后建不建叫停、退不退回、出不出卡，仍按原来的规则。

ADR 0040's principle is that models understand, propose and work, and only deterministic code writes state. Whether a line is a stop or a complaint is understanding, which a word list was never fit for; what follows from the reading — a hold, a bounce, a card — is decided by the same rules as before.

## 决定 / Decisions

1. **两种读法 / Two readings.** `reader.ts` 用一次无工具的短调用读一句话，回一个 JSON（提示词在 `prompts/reader.ts`）：
   - **你的话**：`control`（stop / go_on / both / none：是不是要 Bot 现在停下或继续）、`control_only`（除了这个指令就没别的）、`status_only`（只问进度）、`objections`（对已交付成果「现在这样」不满意的分句，原样摘出）。附带它回复的那句和之前三句。
   - **Bot 的话**：`later`（说「还在做 / 马上做 / 稍后给」的那一句，原样摘出）、`claims_verified`（说跑过、测过并且通过）、`no_work`（只说这轮没事可做）、`bare_status`（只有一句应答、完成、在等或「我看看」）。只读这条消息本身。

   每句话只读一次：你的话按消息缓存，Bot 的话按文本缓存，用到它的地方共用一次读法。

   `reader.ts` reads a line with one tool-less short call and a JSON answer (prompts in `prompts/reader.ts`). **Your line**: `control` (stop / go_on / both / none: does it tell the Bots to stop or go on now), `control_only` (nothing else in it), `status_only` (it only asks where the work stands), `objections` (the clauses objecting to delivered work as it stands, quoted), with the line it answers and the three before it. **A Bot's line**: `later` (the sentence saying the work is still going or more will follow, quoted), `claims_verified`, `no_work`, `bare_status`, read on its own. Each line is read once: yours cached by message, a Bot's by text, shared by every place that asks.

2. **读完怎么用 / What each reading drives.**
   - **控制句 / Control lines.** 先按 `control-line.ts` 的固定规则读：纯叫停、纯继续、「没停」、「算了」和问停没停的话当场照办，不等模型，叫停不慢下来。规则判不了的（没有控制词、或控制词旁边还有别的话、或只是一句进度询问）再看读法：读成只是叫停的，按规则同样的范围（@ 名、「你」「你们」「所有 Bot」「这件事」，`controlScopes`）建叫停，回执上照样能撤销；只是继续的，解除能解除的叫停；带着别的话的，只挂按钮，照常交给 Bot；读成不是控制的，按钮也不挂。被你撤销后重新交给 Bot 的那句话不再读控制。 / The fixed rules read first: a pure stop, go on, 「没停」, 「算了」 or question about stopping is carried out at once, never waiting on a model. A line they cannot settle (no control word, one beside other words, or a plain status question) goes by the reading: nothing but a stop makes holds over the same scopes the rules would (`controlScopes`), undoable from the receipt; nothing but a go on lifts what it can; one beside other words only carries the buttons; one read as no control carries none. A line sent on again after you undid its stop is not read for control again.
   - **进度询问 / Status questions.** `status_only` 的话由应用照行回答。引用回复、@ 了 Bot、带附件或批注的话不算，不管模型怎么读（`statusQuestionShape`）。 / A `status_only` line gets the app's status answer; a quote-reply, a line naming a Bot, or one with attachments or annotations never does, whatever the model read.
   - **挑毛病 / Complaints.** `objections` 代替 `clauseObjects` 决定要不要出返工卡、问哪几个分件（分件号仍从摘出的分句里按规则找）；书记员什么都没记时的兜底捕获也看它。 / `objections` replaces `clauseObjects` in deciding whether a rework card is asked and which parts it names (part numbers still found by rule in the quoted clauses); the scribe's fallback capture reads it too.
   - **还在做 / More to come.** 收尾自检用 `later` 判断这条消息是不是许诺了还没交的东西，用 `claims_verified` 判断是不是声称跑过；结束契约用本段最后一句话的 `later` 决定要不要退回（`promised_later`，[ADR 0044](0044-delegation-and-end-contract.md) 补记）。点没点名接手、截多长引用，仍按规则。 / The closing check reads `later` and `claims_verified`; the end contract reads `later` of the segment's last word for `promised_later` (ADR 0044 addendum). Whether someone is named to take it, and how much is quoted, stay rules.
   - **空话与空交付 / No-work and bare status.** `send_message` 和纯文字收尾是不是「无事可做」、`end_turn(done, answer)` 交的一段话是不是只有一句状态，改看 `no_work` / `bare_status` / `later`。形状先筛：空的、太长、带问号、@ 了人、带路径或代码的不用读。 / Whether a `send_message` or closing reply is a no-work closer, and whether `end_turn(done, answer)` words are a bare status, go by `no_work` / `bare_status` / `later`; the shape filters first, so a line that cannot be one costs no call.
   - **手艺类要求 / Craft entries.** 书记员给每条新要求多标一个 `nature`（craft / look / series / other），记在台账的 `nature` 列；会话级默认（[ADR 0042](0042-requirements-ledger.md)）和「升为常设」看它。没标的（旧条目、模型没给）仍按 `craft-words.ts`。这一项不另调模型，书记员本来就在读这句话。 / The scribe marks each new entry's `nature`, kept in the ledger's new `nature` column; the conversation-wide default (ADR 0042) and the standing offer go by it, entries without one by `craft-words.ts`. No extra call: the scribe already reads the line.

3. **读法先核对 / A reading is checked first.** `control` 不是四个值之一、回答不是 JSON、截断了，都不算读法。摘出的分句和句子必须是原话里的字（按 `quote-words.ts` 的比对）：找不到的分句丢掉，一个都找不到就整句算一条；找不到的「还在做」退回词表找到的那句，再不行用整条消息的开头。 / A `control` outside its four values, an answer that is not JSON or was cut off, is no reading. Quoted clauses and sentences must be words of the line (compared as `quote-words.ts` does): a clause not found is dropped, and when none is the whole line stands as one; a `later` not found falls back to the sentence the lists find, else the start of the line.

4. **读不了就用词表 / The word lists when no model can.** 没配默认模型、调用出错、超过 20 秒（排队等名额也算在内）、回答读不懂、守护进程在收尾，都按原来的词表读，工作记录里注明原因。词表保留，但不再为了补漏扩词：漏的是读法的问题。 / No default model, a failed call, more than 20 s (a wait for a slot included), an unreadable answer or a draining daemon: the old word lists read the line, and the work log says why. The lists stay, and are not widened to fix a miss any more: a miss is the reading's to fix.

5. **快 / Fast.** 你的话要等读完才叫醒 Bot，所以：读句走自己的并发名额（`lane: "reading"`），不排在 Bot 长时间流式输出的后面；带上模型目录里最轻的思考档（`lightestThinkingLevelFor`，列了 none 就是 none）；设置 → 模型里多一张「读句用的模型」卡（`settings.reader_model`），可以挑任何端点上列着的模型，不挑就跟默认模型。读的时候，要被叫醒的 Bot 照常显示在想。 / Your line wakes no Bot until it is read, so: readings have their own per-origin slots (`lane: "reading"`) instead of queueing behind the Bots' long streams; they ask for the lightest thinking level the model lists (`lightestThinkingLevelFor`); Settings → Models gains a Model that reads lines card (`settings.reader_model`) to pick any listed model, the default model otherwise. While it reads, the Bots it would wake show as thinking.

6. **记账和留痕 / Billing and the record.** 每次读都记工作记录 `reader.answer`（读的是什么、谁读的、模型、失败原因、读法、原始回答）；花费记作 `organize`，用途是新的 `reader`（花费页单列「读句」；`spend.purpose` 的约束按 SQLite 的办法重建表放宽）。 / Every reading is logged as `reader.answer` (what was read, by whom, the model, why it failed, the reading, the raw answer); spend bills as `organize` with the new purpose `reader`, its own line in the spend view (`spend.purpose`'s CHECK widened by rebuilding the table).

7. **仍按规则的 / What stays rules.** 一句叫停对谁生效（范围）；纯控制句；从你的话里读数（时长、分辨率、画幅、帧率，`quote-dimensions.ts` / `derived-checks.ts`：读错只多一张确认卡）；第一次打开新版本时导入旧规则；叫停这一级之前整理跳的 `asksToStop`；正在干活的 Bot 收到的一句话是提问还是改动（`inbox-record.ts`：分错只晚一跳）；端点的拒答文案（`hop-limits.ts`）。 / Who a stop is for; pure control lines; numbers read from your words (a misread costs a card); the one-time import of old rules; the organizer's `asksToStop` below the holds level; whether a line heard by a working Bot is a question or a change (a mistake costs one hop); an endpoint's canned refusal text.

## 实测 / Measured

2026-10-03，用真实端点逐条读 31 句你的话、20 句 Bot 的话（`control` 判错、只问进度判错、该挑毛病没挑、该许诺没许诺都算错），最轻思考档：

On 2026-10-03, one at a time on the real endpoints, 31 lines of yours and 20 Bot lines, at the lightest thinking level:

| 模型 / Model | 你的话 / Yours | Bot 的话 / Bots' | 中位 / p50 | P90 | 最长 / max |
|---|---|---|---|---|---|
| grok-4.7-build-fast（默认 / default） | 55/55 | 31/32 | 3.1 s | 6.4 s | 12 s |
| gemini-3.8-flash-high | 53/53（1 次超时 / 1 timeout） | 32/32 | 2.4 s | 5.5 s | 20 s |
| deepseek-v4.1-flash | 55/55 | 31/32 | 0.8 s | 1.2 s | 5.4 s |
| mimo-v2.6-pro | 55/55 | 31/32 | 2.0 s | 4.8 s | 10 s |

唯一稳定的分歧是「我看看」：模型读成只是一句状态，不算许诺。默认模型的思考档从不传降到 none 只快了约 0.5 秒，大头在端点本身，所以才有读句模型的设置。

The one steady disagreement is 「我看看」 ("let me look"), read as a bare status rather than a promise. Sending none instead of no level saved about 0.5 s on the default model; most of the wait is the endpoint, hence the setting.

## 取舍 / Trade-offs

- **你的每句话都慢一点。** 规则判不了的话要等读完才叫醒 Bot：默认模型中位 3 秒，换成快模型不到 1 秒。纯叫停不等。 / Every line the rules cannot settle waits for its reading before it wakes anyone: about 3 s on the default model, under 1 s on a fast one. A pure stop never waits.
- **多花钱。** 你的每句话一次，Bot 的每条要发出的消息最多一次（按文本去重，形状筛掉的不读）。 / One call per line of yours, at most one per Bot message about to go out (deduplicated by text, none for a shape that cannot be one).
- **模型读错的代价和以前一样有限。** 读成叫停的，回执上能撤销，撤销后那句话照常交给 Bot；读成挑毛病的，只是一张问你的卡；读成许诺的，只退回一次。 / A misreading costs no more than before: a stop read in is undone from its receipt and the line goes on; a complaint read in is only a card; a promise read in bounces once.
- **ADR 0036 去掉的模型自检没有回来。** 那次是让模型读任务说明、交付和对话来猜缺了什么，占一轮花费的四分之一；这次只读一句话、回几个字段，核对的依据仍是应用自己的记录。 / This is not ADR 0036's dropped model check, which read the brief, the deliveries and the transcript to guess what was missing; a reading looks at one line and answers a few fields, and what it is checked against is still the app's own records.

## 缺口 / Not done

- 读数（时长、分辨率……）还是规则，读错只多一张卡；要换成模型读需要另做。 / Numbers from your words are still rules.
- 「我看看」这类极短的「先看一下」没算许诺。 / A bare 「我看看」 is not read as a promise.
- 读句模型不会自动挑最快的：应用没有各模型的延迟记录可比。 / The reading model is not picked by speed on its own: the app keeps no per-model latency to compare.

## 2026-10-08 补记：Bot 的话连同它在回的话一起读 / A Bot's line is read with what it answers

你在私聊里给专业翻译官一段英文去翻译，它把原文放在译文上面。读句只看这条消息本身，把原文最后那句「The community-site search is still running. Once it's back, I'll compare the two and pick one to build.」读成了翻译官自己的许诺：结束契约退回一次（`promised_later`，它又空转了 3 分钟、20 跳），结束后私聊里多了一行「专业翻译官说「…」，但这一轮已经结束了，没有人接着做。要它继续，@ 专业翻译官。」。

1. 读 Bot 的话时多带一项 `replying_to`：它这一段在回的话（叫醒它的那句，除非是它自己的，加上它这一段读到的来信；`segmentAnswering`）。回答先给 `restates`：这条是不是（大部分）在翻译、转述、改写、润色或总结 `replying_to`；是的话，译文和转述里的句子都是原文作者的，`later` 只摘 Bot 在这些之外另外说的。只在提示词里写「翻译、引用的不算」不够：同一个真实端点上，只有中文译文、没贴原文的那种回复 3 次全读成许诺；先问 `restates` 再问 `later`，9 种情况（贴原文再翻译、只有译文、短句中译英、润色、引用别的 Bot、自己的许诺、视频导演 10-03 那句、译文之外另有许诺、总结之后另说下一步）各 3 次全对，不带 Bot 职责也一样。缓存键带上这份文本，一段里读同一句话的地方（无事可做、收尾自检、结束契约、交话）都带同一份，仍只读一次。
2. 读出的 `later`（模型的、词表的都一样）在 `replying_to` 里一字不差地出现，且按引文核对的折叠方式至少 20 个字时，算那句话自己的，`later` 记为空。模型读错时也兜得住；几个字的共同说法（「结论随后」）不算照搬，仍是 Bot 的许诺。代价：Bot 把你一整句超过 20 个字的话原样复述成自己的许诺（「好的，等社区站点的搜索跑完我再对比两边挑一个做」照抄你的原句）时不再拦，这种复述少见，模型读到 `replying_to` 时也还会读出它说的别的「还在做」。

Your direct with 专业翻译官: you gave it an English paragraph to translate, and it put the paragraph back above its translations. Reading the message alone, the model took the paragraph's last sentence for the translator's own promise: the ending bounced once (`promised_later`; it went on idly for three minutes, 20 hops), and a line after it told you to @ the Bot — in your direct.

1. A Bot's line is read with `replying_to`: what its segment answers (the line that woke it, unless its own, and the mail it read there; `segmentAnswering`). The answer first gives `restates`: whether the line mostly translates, restates, rewrites, polishes or summarises `replying_to`; when it does, the sentences of that are the original author's, and `later` quotes only what the Bot says beside them. Saying in the prompt that translating or quoting is no promise was not enough: on the same real endpoint a reply that was only the Chinese translation, without the original, read as a promise 3 times out of 3; asked for `restates` before `later`, nine cases (original then translation, translation only, a short zh→en line, polishing, quoting another Bot, a promise of its own, the director's 10-03 line, a promise beside a translation, a next step after a summary) came out right 3 times each, with no Bot duties given. The cache key carries that text, and every place in a segment that reads the same line (no-work, the closing check, the ending contract, a handed-over answer) passes the same, so it is still read once.
2. A `later` (a model's or the lists') found word for word in `replying_to`, at least 20 characters as the quote check folds them, is that line's own, and reads as none. This holds when the model misreads; a phrase of a few words both use (「结论随后」) is no repeat and stays the Bot's promise. The cost: a Bot repeating a whole sentence of yours of 20 characters or more as its own promise is no longer caught. That is rare, and with `replying_to` in front of it the model still reads any other "still going" it says.

## 2026-10-08 补记：读句也能用 Claude Agent 的 Claude 模型 / Lines can be read by a Claude model of Claude Agent

你说读句模型应该能选 agent 里的 Claude 模型。你的 Claude 模型只经你本机的 Claude Code 用得上（[ADR 0061](0061-claude-agent-runner.md)），没有 Anthropic 的 API key，端点那条路接不上它们。 / You asked for the reader model to offer the Claude models of Claude Agent. Your Claude models are reachable only through your own Claude Code (ADR 0061); with no Anthropic API key, the endpoint path cannot reach them.

1. **设置 / The setting.** `reader_model` 多一种：`{ runner: "claude_code", model, config_dir }`（模型名或别名，账号是设置里列出的 Claude 账号之一，null 是这台电脑默认的那个），存在 `reader_runner`、`reader_model`、`reader_config_dir` 三个键里；选端点的模型清掉 Claude 的键，反过来也一样。只有你能选：Bot 的 `update_model_settings` 选 Claude 模型得 403（它花的是你的 Claude 套餐），能列出来。有读句在用的账号，不能从列表里移除（409）。 / `reader_model` gains `{ runner: "claude_code", model, config_dir }` (a model name or alias; one of the Claude accounts listed in Settings, null for this computer's default), kept in `reader_runner`, `reader_model` and `reader_config_dir`; choosing an endpoint's model clears the Claude keys and the other way round. Only you choose it: a Bot's `update_model_settings` gets 403 for a Claude model (it spends your plan), though it can list one. An account lines are read on cannot be removed from the list (409).
2. **怎么读 / How it reads.** 每次读是一次 Agent SDK 调用（`claude-code/reading.ts`）：系统提示就是读句的提示词本身（顶替 Claude Code 自己的），用户消息是同一份 JSON，没有工具、只有一轮、不读任何设置和 CLAUDE.md、不存会话，`claude` 起在自己的进程组里，超时或守护进程收尾时连同它起的东西一起停掉。账号和代理与 Claude Agent 的 Bot 一样（`claudeChildEnv`、系统代理）。自己最多同时两次，不占 Bot 的 `AGENT_SLOTS`；20 秒的上限照旧，等名额的时间也算。答案照端点那条路的读法核对。 / Each reading is one Agent SDK call (`claude-code/reading.ts`): the system prompt is the reading's own prompt (replacing Claude Code's), the user message the same JSON, no tools, one turn, no settings or CLAUDE.md read, no session kept; `claude` starts in a process group of its own and is stopped with whatever it started on a timeout or at shutdown. The account and proxy are a Claude Agent Bot's (`claudeChildEnv`, the system proxy). At most two run at once, outside the Bots' `AGENT_SLOTS`; the 20 s limit stands, waiting for a place included. The answer is checked as an endpoint's is.
3. **读不了 / When it cannot read.** Claude Code 没装、那个账号没登录：`claude_unavailable`；出错或答空：`claude_failed`；超时仍是 `timeout`。都按词表读，读归属照旧留给桌面段。 / Claude Code missing or that account signed out: `claude_unavailable`; an error or an empty answer: `claude_failed`; past its time, still `timeout`. All are read by the word lists, and a filing still goes to the desk.
4. **花费 / Spend.** 记作 `organize`、用途 `reader`，端点名「Claude Agent」，价格是 SDK 报的估算，和 Claude Agent 的轮一样：套餐上不按 token 计费，花的是套餐额度。 / Recorded as `organize`, purpose `reader`, under "Claude Agent" with the SDK's estimated price, as a Claude Agent turn is: a plan is not billed per token; it spends the plan's usage.

实测 / Measured (2026-10-08, this Mac, daemon environment, haiku, the user-line prompt): five lines 3.2–5.0 s each, 0.9–1.8 s of it starting `claude`; all five read right (「停」 stop, 「现在做到哪了？」 status only, the rest none). That is grok-4.7-build-fast's range (p50 3 s) and slower than deepseek-v4.1-flash (0.8 s), so it stays a choice, not the default.

缺口 / Not done: 手机看不到本机的 Claude Code（`claudeCode()` 不过中继），所以手机上不会主动列出 Claude 这一组，只能在已经选了 Claude 模型时在几个模型之间换（2026-10-10 补上：手机经中继问得到，见 [ADR 0061](0061-claude-agent-runner.md) 最后的补记）。没有常驻会话：每次读都要起一次 `claude`（约 1–2 秒）。 / The phone cannot see this computer's Claude Code (`claudeCode()` does not cross the relay), so it never offers the Claude group by itself; it can only switch models once one is chosen (closed 2026-10-10: the phone asks over the relay, see [ADR 0061](0061-claude-agent-runner.md)'s last addendum). No standing session: each reading starts `claude` again (about 1–2 s).
