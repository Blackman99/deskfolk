# 兼容 Anthropic 格式的模型端点 / Endpoints in Anthropic's format

Status: implemented 2026-10-08, at no engine level. It amends the CONTEXT entries on the model endpoint (no longer only OpenAI-compatible) and the completion (no longer only Chat Completions).

你说的是（2026-10-08）：「兼容 Anthropic 格式的模型端点。」在这之前，端点只能是 OpenAI 兼容的：每次补全都是 `POST …/chat/completions`，密钥放 `Authorization: Bearer`。可越来越多的模型是按 Anthropic 的 Messages 接口给的：Anthropic 自己，DeepSeek、百炼、智谱、Kimi、MiniMax 为 Claude Code 开的 `…/anthropic` 地址，还有 CLIProxyAPI 这类转发。它们要么没有 OpenAI 兼容的那一套，要么那一套少了东西（思考档、缓存）。Claude Agent（[ADR 0061](0061-claude-agent-runner.md)）解决的是另一件事：让你本机的 Claude Code 跑一个 Bot；应用自己的循环和判断仍然只认 OpenAI 兼容端点。

You put it this way (2026-10-08): endpoints compatible with Anthropic's format. Until now an endpoint could only be OpenAI-compatible: every completion was `POST …/chat/completions` with the key as `Authorization: Bearer`. More and more models are offered through Anthropic's Messages API instead: Anthropic itself, the `…/anthropic` addresses DeepSeek, Bailian, Zhipu, Kimi and MiniMax open for Claude Code, and proxies such as CLIProxyAPI. They either have no OpenAI-compatible route or one that lacks things (thinking levels, caching). Claude Agent ([ADR 0061](0061-claude-agent-runner.md)) solves something else — your own Claude Code running a Bot; the app's own loop and judgements still spoke only to OpenAI-compatible endpoints.

## 决定 / Decisions

1. **格式是端点的一个属性 / The format is a property of the endpoint.** `providers.api_format` 是 `openai` 或 `anthropic`，旧库迁移时都是 `openai`。设置里的端点表单和首次向导多一组「接口格式」（向导多一个 Anthropic 预设）；Bot 的 `add_endpoint` / `update_endpoint` 多一个 `api_format`。改格式和改 URL 一样要批准，默认端点改不了：同一把密钥换了格式，就换了路径和发法。不另立一种「供应商」，也不碰 Claude Agent：选路、模型阶梯、看图、花费、批准都不知道格式。/ `providers.api_format` is `openai` or `anthropic`; existing rows migrate as `openai`. The endpoint form and the first-run wizard gain an API format choice (the wizard an Anthropic preset); Bots' `add_endpoint` / `update_endpoint` gain `api_format`. Changing the format needs approval like changing the URL, and the default endpoint's cannot be changed: the same key in another format goes to another path in another shape. No new kind of provider, and Claude Agent is untouched: routing, the model ladder, pictures, spend and approvals do not know the format.

2. **在边上转换 / Converted at the edge.** 回路、工具定义、结束原因和用量在应用里仍是 Chat Completions 的样子；`anthropic-messages.ts` 只在发出前把请求转成 Messages、把回来的流读回同样的状态，`completions.ts` 的重试、计时、睡眠恢复、按源限流、复读检测和上限修正两种格式共用一套。轮次里宣布工具调用读的是 Chat Completions 形状的流块，Anthropic 那边就合成同样形状的块交给它。用的是 `fetch` 而不是 Anthropic SDK：两种格式要走同一套计时和重试，SDK 自己的超时和重试会和它打架，而且对面多半不是 Anthropic。/ The loop, tool definitions, finish reasons and usage stay in Chat Completions' shape inside the app; `anthropic-messages.ts` converts a request into Messages on the way out and reads the stream back into the same state, so `completions.ts` keeps one set of retries, timers, sleep recovery, per-origin gating, repeat detection and cap refits for both. The turn announces tool calls from Chat Completions-shaped chunks, so the Anthropic side hands it chunks of that shape. Plain `fetch`, not the Anthropic SDK: both formats must run under the same timers and retries, which the SDK's own timeouts and retries would fight, and the other end is mostly not Anthropic.

3. **地址照 Claude Code 的填法 / The address as Claude Code takes it.** 填的是 `ANTHROPIC_BASE_URL` 那种不带 `/v1` 的地址，请求发到 `…/v1/messages`；已经以 `/v1` 结尾的（CLIProxyAPI 常这么填）只补 `/messages`。各家文档给的都是前一种，复制过来就能用。/ The address is the kind given as `ANTHROPIC_BASE_URL`, without `/v1`, and requests go to `…/v1/messages`; one already ending in `/v1` (as CLIProxyAPI is often given) gets only `/messages`. Every vendor documents the former, so it can be pasted as is.

4. **密钥两种放法 / Two ways to send the key.** 先 `x-api-key`（Anthropic 的），401/403 了换 `Authorization: Bearer` 再发一次（Claude Code 的 `ANTHROPIC_AUTH_TOKEN` 就是这么发的，有些厂商只认它），成了就按端点记住；探模型名单也一样。不同时发两个头：服务端先认哪一个，各家不一样。/ `x-api-key` first (Anthropic's); after a 401/403, once more as `Authorization: Bearer` (what Claude Code sends for `ANTHROPIC_AUTH_TOKEN`, and all some vendors take), remembered per endpoint when it works; the model-list probe does the same. Never both headers at once: which one a server reads first varies.

5. **思考档逐级退 / Thinking steps down.** 先发新形式（`thinking: {type: "adaptive"}` + `output_config.effort`），400 点名这些字段就退到 `budget_tokens`，再拒就不带，按端点和模型记住；和 Chat Completions 那边上限字段的修正同一个思路。退到的那一档要发成功过才记；说回路里思考块不对的 400（「Expected `thinking` …」、签名）不算，不退。`none` 在新形式里发 `effort: low`：Anthropic 最新的模型关不掉思考，送 `disabled` 会被拒。上限小到放不下思考的判断调用只发 `effort`。/ The new form first (`thinking: {type: "adaptive"}` with `output_config.effort`); a 400 naming those fields steps down to `budget_tokens`, then to none, remembered per endpoint and model once a request in that form gets through — the same idea as the cap-field refits on the Chat Completions side. A 400 about thinking blocks in the history ("Expected `thinking` …", a signature) is not about the fields and steps nothing down. A judgement call whose cap has no room for thinking sends the effort alone. `none` sends `effort: low` in the new form: Anthropic's newest models cannot turn thinking off, and `disabled` is refused.

6. **思考块跟着调用回去 / Thinking blocks go back with the calls.** 开着思考的模型，调工具的那条回复要连同思考块（带签名）原样发回，下一跳才收。`ChatMessage` 多一个不透明的 `carry`，记着写它的端点和模型；只在发给同一个端点和模型时带上。它只活在这一轮的内存回路里，不进库。/ With thinking on, the reply that called tools must come back with its thinking blocks (signatures included), unchanged, or the next hop is refused. `ChatMessage` gains an opaque `carry` naming the endpoint and model that wrote it, and it goes only to that same one. It lives in the turn's in-memory loop and is never stored.

7. **上限、采样、缓存、用量 / Cap, sampling, cache, usage.** Messages 必须带 `max_tokens`，所以「不带上限重发」变成按报错里剩下的上下文重发这一次。判断调用不带 `temperature: 0`（新模型拒一切采样参数）。系统提示词末尾和一跳的回路末尾各一个缓存标记——Anthropic 不标就不缓存，一轮几十跳每跳全价重读一遍，输入要贵到十倍上下。用量把读、写缓存的 token 都算进输入，读的记为缓存命中，和 `prompt_tokens` 的口径一样，花费估算不用改。结束原因 `refusal` 算拒答，流里的 `error` 事件算没写完、再试。/ Messages requires `max_tokens`, so "send again without a cap" becomes sending once more with the room the error says is left. Judgement calls carry no `temperature: 0` (the newer models refuse any sampling setting). One cache mark at the end of the system prompt and one at the end of a hop's loop — Anthropic caches nothing unmarked, and a turn of dozens of hops would pay full price to read it all again on each, up to some ten times the input cost. Usage counts tokens read from and written to the cache as input, and those read as cached, as `prompt_tokens` does, so spend estimates need no change. Finish reason `refusal` is a refusal, and an `error` event in the stream makes the attempt unfinished, tried again.

## 实测 / Measured

2026-10-08，一个独立的运行时（自己的数据目录和端口，没碰正在跑的开发版）接 CPA（CLIProxyAPI）的 Messages 地址 `https://cpa.westlakedata.xyz`，格式选 Anthropic 兼容：

- 模型名单从 `/v1/models?limit=1000` 拉到 43 个。
- gemini-3.8-flash-high（思考 low）：「新建 zz-hello.txt 写一行，再读出来告诉我」，6 跳完成，文件内容对，回复原样引用了读到的内容。第 2 跳起回路里带着上一跳的思考块（签名 228、404 字节），CPA 照收。每跳 50–150 秒：同一份 9.6k token 的请求直发对比，Chat Completions 83 秒、Messages 加 adaptive 31 秒、加 budget 81 秒、不带思考 27 秒——慢在 gemini 和 CPA 那一侧，不在格式；CPA 这条路给 gemini 的流是一次吐完的。
- grok-4.7-build-fast（思考 low）：「读文件、追加一行、再读、说有几行」，10 跳 108 秒完成，每跳 1.5–4.5 秒；从第 2 跳起缓存命中（17,202 输入里 17,024 读自缓存）。
- grok 每跳的缓存命中一路涨，说明跳与跳之间系统提示词、局面块和历史一字不差，只在末尾追加——Anthropic 新模型的「历史不许改」检查要的正是这个。但这是 CPA 和 grok 上的证据，不是 Anthropic 自己的检查。
- 读句、整理跳（带规划文档的长回答）都走 Messages 正常返回；首轮里两次读句超时退回了词表，是因为当时 gemini 那一跳占着连接、而 gemini 又慢。
- 设置界面（WebKit）：端点卡片显示「cpa.westlakedata.xyz · Anthropic」；编辑时选中 Anthropic 兼容，地址提示和占位跟着变；新建一个、切到 Anthropic 兼容、填完自动保存，存下来的是 `api_format: anthropic`；页面没有报错。

On 2026-10-08 an isolated runtime (its own data folder and port; the running dev instance untouched) was pointed at CPA's (CLIProxyAPI) Messages address `https://cpa.westlakedata.xyz` with the format set to Anthropic-compatible:

- The model list came from `/v1/models?limit=1000`: 43 models.
- gemini-3.8-flash-high (thinking low), asked to create zz-hello.txt with one line, read it back and report it: done in 6 hops, file correct, the reply quoting what was read. From hop 2 on the loop carried the previous hops' thinking blocks (signatures of 228 and 404 bytes), and CPA took them. Each hop took 50–150 s; the same 9.6k-token request sent directly took 83 s over Chat Completions, 31 s over Messages with adaptive, 81 s with a budget, 27 s with no thinking fields — the time is gemini's and CPA's, not the format's; CPA hands gemini's stream over in one burst.
- grok-4.7-build-fast (thinking low), asked to read the file, append a line, read it again and count the lines: done in 10 hops and 108 s, 1.5–4.5 s a hop, with cache hits from hop 2 (17,024 of 17,202 input tokens read from the cache).
- grok's cache hits grew hop by hop, so the system prompt, the situation block and the history stayed byte for byte the same between hops, only appended to — what the history-editing check of Anthropic's newer models needs. That is evidence from CPA and grok, not from Anthropic's own check.
- Readings and the organizer (a long answer carrying a plan document) came back over Messages; two readings in the first turn timed out to the word lists, while a slow gemini hop held the connection.
- Settings (WebKit): the endpoint's card reads "cpa.westlakedata.xyz · Anthropic"; editing it shows Anthropic-compatible selected, with the address hint and placeholder to match; a new one switched to Anthropic-compatible and filled in saved itself with `api_format: anthropic`; no page errors.

## 没测的 / Not tested

- Anthropic 自己的 `api.anthropic.com`：这台机器上没有它的 API key。/ Anthropic's own `api.anthropic.com`: there is no API key for it on this machine.
- 百炼的 Token Plan：条款只许交互式编码工具用，不许指给 Deskfolk 的 Bot。/ Bailian's Token Plan: its terms allow interactive coding tools only, not Deskfolk's Bots.

## 没做的 / Not done

- 让 Claude Agent 跑在 Anthropic 兼容端点上（给 Claude Code 设 `ANTHROPIC_BASE_URL`）：那是运行方式的事，ADR 0061 写明应用不碰 Claude Code 的凭据。/ Running Claude Agent on an Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL` for Claude Code): that belongs to the runner, and ADR 0061 keeps the app away from Claude Code's credentials.
- Anthropic 的服务端工具、1 小时缓存、按消息调 effort、拒答后自动换模型（`fallbacks`）：应用的工具都在本机跑，其余的等有需要再说。/ Anthropic's server tools, one-hour caching, per-message effort, and refusal fallbacks: the app's tools run locally, and the rest can wait for a need.
- 按 URL 猜格式：同一个 base URL（CLIProxyAPI）两种格式都给，猜不准，所以让你选。/ Guessing the format from the URL: one base URL (CLIProxyAPI) serves both, so the choice is yours.
