# 本机和局域网里的模型服务 / Model servers on this computer or network

Status: implemented 2026-10-08, at no engine level. It amends [ADR 0009](0009-turn-context-message-count.md)'s "if it does not fit, let the endpoint refuse it" for servers that do not refuse, and adds `context_window` to an endpoint's model entries.

你问的是（2026-10-08）：「当前对于使用者来说支持本地模型还有什么 gap」，看完答复后说「都做一下」。在这之前，Ollama、LM Studio、llama.cpp 的 `llama-server` 都能当 OpenAI 兼容端点接上，向导里也有一个 Ollama 预设，可接上和能用之间隔着好几件事：端点必须有密钥，没有就整个不用；Bot 一步的提示词常有几万 token，而本地服务装不下时不报错，默默截掉开头（人设、指令、工具定义）照常回答；时限按云端的速度定；后台的短判断打到会思考的本地模型上，256 个 token 全用来思考，一个字也不答。

You asked (2026-10-08) what gaps remain in local-model support for a user, then said to do all of it. Ollama, LM Studio and llama.cpp's `llama-server` could already be added as OpenAI-compatible endpoints, and the wizard had an Ollama preset, but several things stood between connected and usable: an endpoint needed a key or was not used at all; a Bot's step is often tens of thousands of tokens, and a local server that cannot hold it does not refuse — it cuts the start (persona, instructions, tool definitions) and answers anyway; the time limits were set for cloud speeds; and the app's short calls, sent to a local reasoning model, spent all 256 tokens thinking and answered nothing.

## 实测 / Measured

2026-10-08，M4 Pro 48 GB，Ollama 0.40.0 默认设置（按显存给的上下文 32768，`OLLAMA_NUM_PARALLEL=1`），qwen3:8b 和 gpt-oss:20b。/ On an M4 Pro with 48 GB, Ollama 0.40.0 at its defaults (a 32,768 context chosen from VRAM, `OLLAMA_NUM_PARALLEL=1`), qwen3:8b and gpt-oss:20b.

| 请求 / Request | 发出字节 / Bytes sent | 报告读入 / `prompt_tokens` | 结果 / Result |
| --- | --- | --- | --- |
| 19k token，窗口内 / inside the window | 65,468 | 19,037 | 答对 / right |
| 31k token + `max_tokens` 32768 | 106,228 | 31,377 | 答对，`max_tokens` 不占窗口 / right; the cap takes no room |
| 33,717 token，刚超 / just over | 113,788 | 16,386 | 200，答错 / 200, wrong |
| 49,837 token | 165,868 | 16,386 | 200，答错 / 200, wrong |

服务端日志 `truncating input prompt limit=16386 prompt=49837 keep=4 new=16386`：一超过窗口就只留最后一半，HTTP 照样 200，`usage.prompt_tokens` 报的是截断后的数。读入 4.9 万 token 的那次首字用了 57 秒。本机 10 月以来的花费记录里，一轮第一跳的提示词中位数约 2.3 万 token，所有跳的 P90 约 9.3 万。

The server log said `truncating input prompt limit=16386 prompt=49837 keep=4 new=16386`: past the window it keeps the last half, still answers 200, and `usage.prompt_tokens` reports the cut size. The 49k-token request took 57 s to its first byte. In this Mac's spend records since October 1, a turn's first step reads about 23k tokens at the median, and all steps read about 93k at P90.

短判断（`max_tokens` 256，不带思考档）：qwen3:8b 256 个 token 全是思考，正文为空，`finish_reason: length`；带 `reasoning_effort: "none"` 0.3 秒答对。gpt-oss:20b 收 `"none"` 不报错，照样想（它关不掉思考），256 以内答完。流式工具调用在 Ollama 上一块到齐；思考放在 `delta.reasoning`；空的 `Authorization: Bearer ` 也收。

A short call (`max_tokens` 256, no thinking level): qwen3:8b spent all 256 tokens thinking and returned no content (`finish_reason: length`); with `reasoning_effort: "none"` it answered right in 0.3 s. gpt-oss:20b takes `"none"` without an error and thinks anyway (its thinking cannot be turned off), answering inside 256. Ollama streams a tool call in one piece, sends thinking as `delta.reasoning`, and accepts an empty `Authorization: Bearer `.

## 决定 / Decisions

1. **按地址认本地 / Local by address.** `isLocalEndpoint`（`@real-bot/protocol`）：loopback、`localhost` 和 `*.localhost`、`*.local`、10/8、172.16/12、192.168/16、169.254/16、`fc00::/7`、`fe80::/10`。只看地址，不解析域名：一个解析到内网的公网域名不算。应用和守护进程用同一个判断。/ Loopback, `localhost` and `*.localhost`, `*.local`, the private IPv4 ranges, link-local and unique-local IPv6. The address alone decides; a public name resolving to a private address does not count. Both ends use the same function.

2. **本地不用密钥 / No key for a local server.** 设置和向导里本地地址的密钥选填，徽标写「本地，不用密钥」；路由收没有密钥的本地端点，向导有了它就算完成；Bot 的 `add_endpoint` / `update_endpoint` 对本地地址不要求密钥，审批卡上的密钥栏还在、可不填。没有密钥时不发 `Authorization` / `x-api-key` 头，而不是发一个空的。自动拉模型名单在本地地址上不等密钥。/ The key is optional for a local address in Settings and the wizard, whose badge reads "Local, no key"; routing takes a keyless local endpoint and the wizard counts it as done; a Bot's endpoint tools do not require one (the approval card still offers the field). No key means no key header at all. The model list is fetched without waiting for a key.

3. **被截断的提示词算失败 / A cut prompt is a failure.** 新的失败类型 `context_full`，不重试（同一个提示词遇到同一个窗口），失败行写明数字：「这一步约 N token，端点只读进了 M token，窗口是 W」。三条路进来：
   - **事后**：本地请求回来后，发出的字节数除以报告读入的 token 数。没有分词器能把文字压到每 token 6.5 字节以上（实测完整的 3.4，被截的 6.9 和 10.1），所以没校准时超过 6.5 就是被截了；同一个模型之前完整的请求（16 KB 以上的：短调用多是中文和 JSON，读数和 Bot 的一步不一样）会留下它的「字节/token」读数，之后超过这个读数的 1.6 倍（且至少 4）就算。小于 16 KB 的请求不判断；图片不计字节。只对本地端点做：云端点超窗会报 400，而有的代理报的用量本来就不准。截断时去问服务现在的窗口（Ollama 的 `/api/ps`），记进这个模型的条目。
   - **事前**：条目里有窗口、按读数（没有就按每 token 4 字节）估出来超过窗口的 1.1 倍，这一步不发出去。
   - **报错**：400 的原文说提示词超出上下文（「maximum context length」「exceeds the available context size」「prompt is too long」「上下文长度」「超出…上下文」……，只提到「上下文」的不算；上限的修正先做完），记为 `context_full`，所有端点都这样，不再是笼统的「端点拒绝」。
   
   A new failure, `context_full`, never retried, with the numbers in the failure line. After a local request: bytes sent over reported tokens; past 6.5 bytes a token uncalibrated, or 1.6× the model's own reading from its earlier whole requests of 16 KB or more (at least 4), the prompt was cut. Requests under 16 KB are not judged and pictures are not counted; only local endpoints are checked, since a cloud one refuses with a 400 and some proxies report usage loosely. On a cut, the server is asked for the window it runs (Ollama's `/api/ps`), which is recorded on the model. Before a request: a known window that the estimate exceeds by 10% stops it unsent. A 400 that says the prompt is over the context reads as `context_full` on every endpoint.

4. **窗口记在模型条目上 / The window lives on the model entry.** `context_window`（token）和 `max_output`、`stream_tps_p10` 一样存在端点的名单里：从设置再保存时没带就保留，带 `null` 才清掉；设置的模型属性里能看、能改，填的不是正整数不让保存；手机经中继也收这个字段。拉本地端点的模型名单时问服务本身：Ollama 先看 `/api/ps`（已加载的实际窗口），再看 `/api/show` 里 Modelfile 的 `num_ctx`，最后是 `/api/tags` 的模型上限，顺带 `capabilities` 里有没有 `vision`、`tools`；LM Studio 看 `/api/v0/models` 的 `loaded_context_length` / `max_context_length` 和 `type: vlm`；llama.cpp 看 `/props` 的 `n_ctx`。填进窗口和看图两栏，你填过的不覆盖；服务说不支持工具的模型在名单上标「不支持工具」。Ollama 没加载、也没在 Modelfile 设 `num_ctx` 的模型，读到的是模型上限，实际按服务默认（这台是 32768），由第 3 条在第一次截断时纠正。/ Kept like `max_output`; shown and editable in Settings; read from the server when its model list is fetched (Ollama: loaded window, else the Modelfile's `num_ctx`, else the model's limit; LM Studio and llama.cpp likewise), never over a value you typed. A model the server says cannot call tools is tagged in the list. An unloaded Ollama model without `num_ctx` reads as its limit; the first cut corrects it.

5. **本地的时限 / Local time limits.** 首字 15 分钟（加载模型、排在别的请求后面、读几万 token），空闲 5 分钟；同一个本地服务一次只发一条流式请求，排队在应用里等、不计时，而不是在服务里排着把首字时间耗光；应用不等着用的短调用（整理、判断、复盘……）至少等 10 分钟，读句保留自己的 20 秒——那句话等着它，等不到就退回词表。一跳最长写多久：没测过速度的本地模型按每秒 10 token 算（默认上限 32768 就是约 82 分钟），测过的按测出的。/ 15 minutes to the first byte, 5 idle; one streamed request at a time per local server, queued in the app without a clock; short calls nobody waits on get at least 10 minutes, while a reading keeps its 20 s and falls back to the word lists. An unmeasured local model is taken to write 10 tokens a second when sizing a step's time limit.

6. **本地短调用不思考 / Short local calls do not think.** 后台的短调用没指定思考档时，对本地端点发 `reasoning_effort: "none"`；模型 400 拒了就去掉重发，并记住这个模型。调用方指定了档位照发。云端点不变。所有请求只在有档位时才带 `reasoning_effort`，不再发 `null`。/ A short call naming no level sends `"none"` to a local endpoint; a model that refuses it is asked again without, and remembered. A named level goes as named; cloud endpoints are unchanged. `reasoning_effort` is sent only when there is a level.

7. **思考不进回复 / Thinking is not the reply.** 回复正文开头的 `<think>…</think>` 去掉（流式时边收边去，标签拆在几块里也认），只有 `</think>` 没有开标签的，去掉它和它前面的；短调用的正文同样处理，不然判断读不成 JSON。所有端点都这样：开头一段思考从来不是回复。`delta.reasoning` / `reasoning_content` 照旧不进正文；本地模型的思考也过复读检测，但只认同一个长句反复出现：思考里本来就满是「好的」「再看一下」这类短句。/ A leading `<think>` block is taken out of the reply, streaming or not, on every endpoint; a lone `</think>` ends one. A local model's separate thinking also goes through the repeat watch, on the same-long-sentence rule only, since thinking is full of short restated lines.

8. **测速 / Speed test.** `POST /v1/providers/:id/speed-test {model}`：先流式写一段从一数到一百（不思考），量首字时间和之后的每秒 token；再给一个工具、让它调用，看它调不调。速度记六成进 `stream_tps_p10`（短提示词量出来的比读了几万 token 时快），第 5 条的一跳时限就按它算。设置的模型属性里一个「测一下」按钮，结果写在旁边；没调工具的提示换模型。测速走读句的通道：你在等它，不在应用里排在 Bot 的一跳后面（服务一次只处理一个请求时，那边仍要等，首字时间会算上）。没有回执：要几十秒，重来只是再量一次。/ Times one short streamed reply and checks a tool call; 60% of the speed is recorded as `stream_tps_p10`. A button in the model's attributes; it takes the readings' slots rather than queueing behind a Bot's hop in the app; no request receipt, since a repeat only measures again.

9. **向导预设 / Wizard presets.** Ollama（`:11434/v1`）、LM Studio（`:1234/v1`）、llama.cpp（`:8080/v1`），名单留空、选了就去服务那里拉：猜的模型名服务上没有，到第一轮才报错。选了本地预设，提示先启动服务、装好模型，上下文调到 64K 以上，选能调工具的模型。/ Three local presets with an empty list, fetched from the server; the hint says to start it, raise the context to 64K or more and pick a model that calls tools.

10. **测试 / Tests.** 不少测试把假的云端点开在 127.0.0.1 上。运行时、本地接口和引擎多一个 `localEndpoint` 选项（默认 `isLocalEndpoint`），这些测试传 `() => false`；本地的规矩有自己的测试。/ Tests that stand a fake cloud endpoint up on 127.0.0.1 pass `localEndpoint: () => false`; the local rules have tests of their own.

## 没做的 / Not done

- LM Studio 和 llama.cpp 的接口按文档写、有单元测试，没在真服务上跑过；vLLM 没单独处理（它超窗报 400，走第 3 条的报错那条路）。/ LM Studio and llama.cpp are parsed from their documentation and unit-tested, not run against a live server; vLLM refuses with a 400 and needs nothing extra.
- 不替你调大服务的窗口，也不在本地端点上自动裁历史：窗口不够时说清楚、停下，由你调大或换模型。/ The app does not raise the server's window or trim history for it; it says so and stops.
- 一次只发一条：设了 `OLLAMA_NUM_PARALLEL` 的也一样，两个 Bot 同时干活时轮流用。/ One stream at a time even when the server allows more.
- 读句排在本地服务正在写的一跳后面时会超时退回词表；读句、整理用云端模型、Bot 用本地模型的混合配置写在 README 里。/ A reading queued behind a local step times out to the word lists; the README recommends readings on a cloud model and Bots on the local one.
