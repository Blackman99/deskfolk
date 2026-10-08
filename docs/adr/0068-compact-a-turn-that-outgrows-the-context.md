# 一轮放不下时压缩它的回路 / Compacting a turn that outgrows the context

Status: implemented 2026-10-08, at no engine level. It amends [ADR 0009](0009-turn-context-message-count.md)'s "if it does not fit, let the endpoint refuse it" and [ADR 0067](0067-local-model-servers.md)'s "a prompt over the window fails the turn" for a turn whose own tool loop outgrew the window, and gives ADR 0067 §3 a second rule for a cut prompt; it adds the built-in prompt `call.compact` ([ADR 0064](0064-built-in-prompts-you-and-your-bots-can-edit.md)) and the spend purpose `compact`.

你问的是（2026-10-08）：「当前应用层如果撞上了 context 会怎么样」。答复是：每一跳都把这一轮的整个工具回路重发一遍，回路从不裁剪；撞上了这一轮就失败，回路里的活全丢，Anthropic 格式的端点还认不出这是上下文满了。你说：「应用内自动压缩，把提示词也要暴露出来可以改」。

You asked (2026-10-08) what happens when the app runs into the context limit. The answer: every hop sends the turn's whole tool loop again and nothing ever trims it; when it no longer fits the turn fails and the work in the loop is lost, and an Anthropic-format endpoint's refusal is not even read as a full context. You said to compact inside the app, with the prompt exposed so it can be edited.

## 之前 / Before

一轮的提示词由几块组成：人设、指令、技能、记忆、局面块、最近 40 条转录（每条 4000 码点），以及这一轮的回路。前几块都有上限；回路没有：单个工具结果最多 8000 码点（再多的存到 `tool-results/`），一轮最多 160 跳，160 × 8000 ≈ 130 万码点，远超 200k token 的窗口。撞上时：

- OpenAI 兼容端点 400 说超了上下文、本地服务截断或发前估超（ADR 0067）：`context_full`，这一轮以「提示词超出了模型的上下文窗口」失败，不重试；4 级起监督器把活当成一轮新的接着做（回路是空的，每小时最多 3 次），回路里读过的、试过的都没了。
- Anthropic 格式端点 400「prompt is too long」：认成「端点拒绝了这次补全」（`refused`）。
- 流里停在 `model_context_window_exceeded`：当成写到输出上限，带着更长的提示词「接着写」再走一跳，最后多半 `refused` 或 `truncated`。

A turn's prompt is the persona, instructions, skills, memories, the situation block, the last 40 transcript lines (4,000 code points each) and the turn's loop. Everything but the loop is bounded: a tool result keeps at most 8,000 code points (the rest spills to `tool-results/`) and a turn makes at most 160 hops, so the loop can reach about 1.3 million code points against a 200k-token window. On overflow, a Chat Completions 400 about the context, or a local server's cut (ADR 0067), failed the turn as `context_full`; from level 4 the supervisor picked the work up as a fresh turn with an empty loop, at most three times an hour. An Anthropic-format 400 "prompt is too long" read as a bare refusal, and a stream stopped at `model_context_window_exceeded` was taken for the output cap and carried on with an even longer prompt.

## 决定 / Decisions

1. **什么时候压 / When.** 两条路，都只压这一轮自己的回路，转录窗、局面块不动。
   - **撞上之后**：一跳以 `context_full` 失败（任何端点的 400、本地的截断或发前拦下、流停在上下文满），回路里有可压的就压，这一跳再走一次。压完到下一跳成功之前又撞上，这一轮照旧失败——同一个窗口不撞第三次。
   - **快满之前**：模型条目里有 `context_window`（本地服务自动填，云端模型可以在模型属性里填），且这一轮已有跳报了用量时，下一跳按这一轮的「字节/token」读数估出来到了窗口的 75%，先压再发。没有窗口的云端模型不估 token（ADR 0009 照旧），只走第一条路。

   Two paths, both on the turn's own loop only. **After a refusal:** a hop failing as `context_full` (any endpoint's 400, a local cut or pre-send stop, a stream stopped at a full context) compacts the loop and goes again; over the context again before a hop goes through, the turn fails as before. **Before the window:** when the model's entry names a `context_window` and this turn's hops reported usage, a next hop estimated at 75% of the window by this turn's bytes per token compacts first. A cloud model without a window gets no token estimate (ADR 0009 stands) and only the first path.

2. **压什么 / What.** 回路在 Bot 自己的一行处切开：最近几跳原样留着（工具调用和它的结果、Anthropic 模型的思考块都在一起），上一跳之后读进来的提示和消息也留着；其余的写成一份记录（每行标明是 Bot 说的、调了什么、哪个工具的结果、提示或收到的消息；工具结果从 8000 码点（也就是整条）起一档档截短到 200，截的时候留开头也留结尾，再放不下就从最早的略去，之前的摘要放最前面、最多 24000 码点），连同这一轮的起因发给这一轮自己的模型，不带工具，上限 16000 token，最多 5 分钟。回答就是摘要，装在一条固定的应用提示里，替换被压的那几跳。

   The loop splits at one of the Bot's own lines: the newest hops stay word for word (a call with its results, an Anthropic model's thinking with its call), as do the notes and messages read in after the last hop. The rest is written out — each entry labelled as the Bot's words, a call, a tool's result, or a note or message; results cut tier by tier from 8,000 code points (that is, whole) to 200, keeping both their start and their end, then the oldest left out, an earlier summary kept first up to 24,000 — and sent with the line that started the turn to the turn's own model, without tools, capped at 16,000 tokens and five minutes. The answer is the summary; it replaces the condensed hops inside a fixed app note.

3. **放得下多少 / Sizing.** 「放得下」= 窗口 × 这一轮的字节/token 读数；不知道窗口时，用这一轮成功过的最大请求的字节数（一个下限）。压完之后，其余部分加留下的几跳不超过它的一半；留下的几跳不超过它的五分之一；写出来的记录不超过它的 60%。其余部分（指令、转录、工具定义）加上摘要的预留（4000 token）已经到了 75%，或者能压的不到 8000 字节，就不压——压了也腾不出地方，照旧失败。

   What fits is the window at this turn's bytes per token, or, without a window, the largest request this turn got through (a floor). After compacting, the rest of the prompt and the kept hops come to at most half of it, the kept hops to at most a fifth, and the written-out record to at most 60%. When the rest plus room for the summary (4,000 tokens) is already at 75%, or less than 8,000 bytes could be condensed, nothing is compacted: it could not make room, and the turn fails as before.

4. **提示词能改 / The prompt is yours.** 新槽位 `call.compact`（设置「提示词」页签里叫「上下文压缩」，中英两版），你和 Bot（经批准卡）都能改。它没有 `{format}`：回答就是摘要本身，代码不解析。包着摘要的那条应用提示是应用的话，和别的应用提示一样不在槽位里。注册表的约定改成：应用自己的调用里，代码要解析回答的才有固定格式。

   A new slot, `call.compact` ("Context compaction" in Settings › Prompts, in both languages), editable by you and, through an approval card, by a Bot. It has no `{format}`: the answer is the summary itself and no code parses it. The app note around the summary is the app's own words, like its other notes, and not a slot. The registry's rule becomes: among the app's own calls, those whose answer code parses have a fixed format.

5. **记账和记录 / Billing and the log.** 摘要调用记在花费的「轮次补全」类下、用途 `compact`（单列「上下文压缩」），挂在这一轮上；旧库开库时把这个用途加进账本的约束。8 级起工作记录写一条 `turn.compacted`（为什么压、压了几跳、留了几跳、压之前多少字节、摘要多长）。v1 不在聊天里发行。

   The summary call bills as the turn it belongs to, purpose `compact` (its own line, "Context compaction"); an older ledger is widened to take it on open. From level 8 the work log gets a `turn.compacted` (why, hops condensed, hops kept, bytes before, summary length). Nothing is posted in the chat in v1.

6. **认出上下文满 / Reading a full context.** Anthropic 格式的一跳被 400 拒、原文说提示词超出上下文的，记 `context_full`（ADR 0067 说「所有端点都这样」，这条路之前漏了）；其他 400 仍是 `refused`。`model_context_window_exceeded`、Mistral 的 `model_length`（以及 OpenAI 兼容转发原样透传的这两个）读作 `context_window`，这一跳是 `context_full`，不再当成写到输出上限去「接着写」；短调用停在这里的，回答算被截断。

   An Anthropic-format hop refused with a 400 saying the prompt is over the context is `context_full` (ADR 0067 said every endpoint; this path had been missed); any other 400 stays `refused`. `model_context_window_exceeded` and Mistral's `model_length`, also when an OpenAI-compatible proxy passes them through, read as `context_window`: the hop is `context_full` and no longer carries on as if cut at the output cap; a short call's answer stopped there counts as truncated.

7. **不变的 / Unchanged.** 转录窗（40 条、4000 码点）、8000 码点的工具结果预算和存盘、160 跳上限（压缩不重置跳数；撞上之后重走的那一跳算一跳）、Claude Agent 的轮（Claude Code 自己压缩）、短调用各自的预算，以及压缩也腾不出地方时的失败和监督器接手。

   The transcript window, the tool-result budget and spill, the 160-hop limit (compacting does not reset it; the hop sent again after a refusal counts), Claude Agent turns (Claude Code compacts its own), the short calls' own budgets, and the failure and supervisor pick-up when compacting cannot make room.

8. **认出悄悄丢掉开头消息的本地服务 / A local server that drops the oldest messages.** 同一个对话（同一个会话里同一个 Bot，按请求的 affinity）里，提示词比上一次长、报告读入的 token 却比上一次少，就是被截断了（ADR 0067 §3「事后」的第二条），这一跳记 `context_full`，问服务要窗口记进模型条目，然后照第 1 条压缩。带的图片数和上一次不同时不比：一张图让出去，token 少了、字节不少。

   Within one conversation (one Bot in one session, by the request's affinity), a prompt longer than the one before read as fewer tokens was cut (a second rule for ADR 0067 §3's "after"): the hop is `context_full`, the server's window is asked for and recorded on the model, and the loop is compacted as in 1. Not judged when the request carries a different number of pictures than the one before: a picture let go of takes tokens and no bytes.

## 实测 / Measured

2026-10-08，M4 Pro 48 GB，Ollama 0.40.0（窗口 32768），qwen3:8b，思考档 none；隔离的运行时，一个 Bot 用 `read_file` 一个一个读 6–7 KB 的笔记，最后列出每份的标题和末行的编号。指令、工具定义和转录约 14k token，每读一份涨约 1.2k。/ On an M4 Pro, Ollama 0.40.0 (window 32,768), qwen3:8b at thinking level none, an isolated runtime: one Bot reads 6–7 KB notes one by one with `read_file`, then lists each one's title and the code on its last line. Instructions, tools and transcript come to about 14k tokens; each read adds about 1.2k.

| 跑法 / Run | 结果 / Result |
| --- | --- |
| 8 份，条目窗口 28000，只截开头 / 8 notes, window 28,000, results cut from the end | 第 7 跳前到 75%，压缩（读 7,547，写 344），下一跳 20,366 → 14,614；摘要漏了标题和编号（编号在文件末行，被截掉），回复里 1–6 份「未找到」 / compacted before hop 7; the summary lost the titles and codes (the code is on the last line, which was cut); the reply said "not found" for notes 1–6 |
| 同上，截时留头尾、提示词要求逐项照录 / same, cut keeping both ends, prompt asks for every item | 摘要 6 份全对；回复只列了 7、8 / the summary had all six; the reply listed only 7 and 8 |
| 同上，应用提示加一句「摘要里的是你已经做完的，回复时算上」 / same, the note says to count the summary in | 8 份全对 / all 8 right |
| 16 份，条目不填窗口 / 16 notes, no window on the entry | 32,680 之后 Ollama 读入 32,581：它丢掉最早的几条消息（连同起因那句）凑进窗口，字节/token 只变了 4%，ADR 0067 的 1.6 倍规则没认出来；Bot 去读不存在的 note-17 / after 32,680, Ollama read 32,581: it dropped the oldest messages (the request among them) to fit, the bytes per token moved 4%, ADR 0067's 1.6× rule missed it, and the Bot went looking for a note-17 |
| 同上，加第 8 条 / same, with decision 8 | 认出截断，压缩（读 7,456，写 743），下一跳 15,043，窗口 32,768 记进条目；摘要 16 份全对，但 Bot 两次调 `end_turn` 没说话，这一轮以「没有回复你就结束了」收尾 / the cut was caught, compacted, the window recorded; the summary had all 16, but the Bot called `end_turn` twice without a word |
| 同上，应用提示末尾改成「做完了就照常直接回复结果；这条提示本身不用回应」 / same, the note now ends "once done, reply with the result as usual; do not answer this note itself" | 16 份全对 / all 16 right |

## 后果 / Consequences

- 长的一轮能越过窗口接着做，代价是一次摘要调用；摘要里没写的细节，Bot 要重新读文件（大的工具结果在 `tool-results/` 里有全文）。
- 摘要好不好看模型和提示词；提示词能改，回答不解析，所以改坏了不会让代码读不懂，只会让 Bot 少记东西。
- 压缩之后提示词的前缀变了，下一跳读不到之前的缓存。
- 云端模型不填窗口时，每次压缩前都要先被拒一次；400 不收费，但多一个来回。

- A long turn carries on past the window at the cost of one summary call; what the summary leaves out, the Bot reads again (large tool results are whole under `tool-results/`).
- The summary is as good as the model and the prompt; since the answer is not parsed, an edit can make the Bot remember less but cannot break a parser.
- After a compaction the prompt's prefix changed, so the next hop misses the cache.
- A cloud model without a window is refused once before each compaction; a 400 costs nothing but a round trip.
