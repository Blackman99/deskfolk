import { describe, expect, test } from "bun:test";
import { anthropicUrl, thinkingFields, toAnthropicMessages, toAnthropicTools } from "./anthropic-messages";
import { createCompletionsClient, type ChatMessage, type CompletionRequest, type JudgeRequest } from "./completions";
import { probeEndpointModels } from "./probe-models";

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function event(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function stream(events: string[]): Response {
  return new Response(events.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

/** A Messages stream: thinking, a sentence, then a tool call whose arguments come in two parts. */
const TOOL_STREAM = [
  event("message_start", { message: { id: "msg_1", role: "assistant", content: [], usage: { input_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 60, output_tokens: 1 } } }),
  event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
  event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Read the file " } }),
  event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "first." } }),
  event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig-abc" } }),
  event("content_block_stop", { index: 0 }),
  event("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
  event("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Let me look." } }),
  event("content_block_stop", { index: 1 }),
  event("content_block_start", { index: 2, content_block: { type: "tool_use", id: "toolu_01", name: "read_file", input: {} } }),
  event("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } }),
  event("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "\"a.md\"}" } }),
  event("content_block_stop", { index: 2 }),
  event("ping"),
  event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 75 } }),
  event("message_stop"),
];

function textStream(text: string, stop = "end_turn"): string[] {
  return [
    event("message_start", { message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: 5 } }),
    event("message_stop"),
  ];
}

function recorder(answer: (sent: Sent, n: number) => Response) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const one = { url, headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    sent.push(one);
    return answer(one, sent.length);
  };
  return { sent, fetch };
}

function hop(baseUrl: string, over: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    baseUrl,
    apiKey: "sk-ant-test",
    apiFormat: "anthropic",
    model: "claude-test",
    thinkingLevel: "high",
    messages: [
      { role: "system", content: "You are a Bot." },
      { role: "user", content: "Read a.md" },
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
    signal: new AbortController().signal,
    maxTokens: 32_768,
    ...over,
  };
}

const quick = { sleep: async () => {} };

describe("Anthropic Messages: the request", () => {
  test("the URL takes the base as Claude Code does, with or without /v1", () => {
    expect(anthropicUrl("https://api.anthropic.com/", "messages")).toBe("https://api.anthropic.com/v1/messages");
    expect(anthropicUrl("https://api.deepseek.com/anthropic", "messages")).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(anthropicUrl("http://127.0.0.1:8317/v1", "messages")).toBe("http://127.0.0.1:8317/v1/messages");
    expect(anthropicUrl("http://127.0.0.1:8317/v1/", "models")).toBe("http://127.0.0.1:8317/v1/models");
  });

  test("the loop becomes alternating turns: system on top, tool results in one user turn, results first", () => {
    const loop: ChatMessage[] = [
      { role: "system", content: "Rules." },
      { role: "assistant", content: "Earlier I said hello." },
      { role: "user", content: "Read both files" },
      {
        role: "assistant",
        content: "  ",
        tool_calls: [
          { id: "call:1", name: "read_file", arguments: "{\"path\":\"a.md\"}" },
          { id: "call_2", name: "read_file", arguments: "not json" },
        ],
        carry: { key: "http://x m", blocks: [{ type: "thinking", thinking: "plan", signature: "s" }] },
      },
      { role: "tool", tool_call_id: "call:1", content: "A" },
      { role: "user", content: "(a note that came in meanwhile)" },
      { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "B" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }] },
    ];
    const { system, messages } = toAnthropicMessages(loop, "http://x m");
    expect(system).toBe("Rules.");
    expect(messages.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    // A history that opens with the Bot's own line gets a user turn before it.
    expect(messages[0]!.content).toEqual([{ type: "text", text: "…" }]);
    expect(messages[3]!.content).toEqual([
      { type: "thinking", thinking: "plan", signature: "s" },
      { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.md" } },
      { type: "tool_use", id: "call_2", name: "read_file", input: {} },
    ]);
    expect(messages[4]!.content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "A" }] },
      {
        type: "tool_result",
        tool_use_id: "call_2",
        content: [{ type: "text", text: "B" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }],
      },
      { type: "text", text: "(a note that came in meanwhile)" },
    ]);
  });

  test("thinking blocks go back only to the endpoint and model that wrote them", () => {
    const loop: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", name: "x", arguments: "{}" }], carry: { key: "http://a m1", blocks: [{ type: "thinking", thinking: "", signature: "s" }] } },
      { role: "tool", tool_call_id: "t1", content: "" },
    ];
    const other = toAnthropicMessages(loop, "http://a m2").messages[1]!.content;
    expect(other).toEqual([{ type: "tool_use", id: "t1", name: "x", input: {} }]);
    // An empty tool result goes with no content rather than an empty text block.
    expect(toAnthropicMessages(loop, "http://a m1").messages[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "t1" }]);
  });

  test("function tools become Messages tools", () => {
    expect(toAnthropicTools([
      { type: "function", function: { name: "end_turn", description: "End.", parameters: { properties: {} } } },
      { type: "function", function: { name: "" } },
    ])).toEqual([{ name: "end_turn", description: "End.", input_schema: { properties: {}, type: "object" } }]);
  });

  test("thinking levels per form", () => {
    expect(thinkingFields("adaptive", "high", 32_768)).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
    expect(thinkingFields("adaptive", "none", 32_768)).toEqual({ output_config: { effort: "low" } });
    expect(thinkingFields("adaptive", null, 32_768)).toEqual({});
    expect(thinkingFields("budget", "medium", 32_768)).toEqual({ thinking: { type: "enabled", budget_tokens: 8_192 } });
    // The budget stays under the cap, and a cap with no room for the smallest budget sends none.
    expect(thinkingFields("budget", "max", 20_000)).toEqual({ thinking: { type: "enabled", budget_tokens: 10_000 } });
    expect(thinkingFields("budget", "low", 512)).toEqual({});
    expect(thinkingFields("budget", "none", 32_768)).toEqual({});
    expect(thinkingFields("off", "high", 32_768)).toEqual({});
    // A verdict's cap has no room for thinking: the effort alone.
    expect(thinkingFields("adaptive", "low", 256)).toEqual({ output_config: { effort: "low" } });
  });
});

describe("Anthropic Messages: a hop", () => {
  test("a streamed reply with thinking and a tool call reads like a Chat Completions one", async () => {
    const { sent, fetch } = recorder(() => stream(TOOL_STREAM));
    const announced: unknown[] = [];
    const tokens: string[] = [];
    const client = createCompletionsClient({ fetch, clock: quick });
    const result = await client.complete(hop("https://api.example.com/anthropic", {
      affinity: "deskfolk-s-b",
      onEvent: (chunk) => announced.push(chunk),
      onToken: (text) => tokens.push(text),
    }));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.example.com/anthropic/v1/messages");
    expect(sent[0]!.headers["x-api-key"]).toBe("sk-ant-test");
    expect(sent[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent[0]!.headers.Authorization).toBeUndefined();
    expect(sent[0]!.headers["X-Session-ID"]).toBe("deskfolk-s-b");
    const body = sent[0]!.body;
    expect(body.model).toBe("claude-test");
    expect(body.max_tokens).toBe(32_768);
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.temperature).toBeUndefined();
    expect(body.system).toEqual([{ type: "text", text: "You are a Bot.", cache_control: { type: "ephemeral" } }]);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Read a.md", cache_control: { type: "ephemeral" } }] }]);
    expect(body.tools).toEqual([{ name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe("Let me look.");
    expect(tokens).toEqual(["Let me look."]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([{ id: "toolu_01", name: "read_file", arguments: "{\"path\":\"a.md\"}" }]);
    expect(result.carry).toEqual({
      key: "https://api.example.com/anthropic claude-test",
      blocks: [{ type: "thinking", thinking: "Read the file first.", signature: "sig-abc" }],
    });
    // Input counts what was read from and written to the cache too, as prompt_tokens does.
    expect(result.usage).toEqual({ input_tokens: 1000, output_tokens: 75, total_tokens: 1075, cached_tokens: 900, reasoning_tokens: null, cost_usd_ticks: null });
    // The turn announces the call from a Chat Completions-shaped delta that carries its id.
    expect(announced[0]).toEqual({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "toolu_01", type: "function", function: { name: "read_file", arguments: "" } }] } }] });
  });

  test("a call with no arguments streams none and still runs with {}", async () => {
    const { fetch } = recorder(() => stream([
      event("message_start", { message: { usage: { input_tokens: 5 } } }),
      event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_9", name: "end_turn", input: {} } }),
      event("content_block_stop", { index: 0 }),
      event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }),
      event("message_stop"),
    ]));
    const result = await createCompletionsClient({ fetch, clock: quick }).complete(hop("https://api.anthropic.com"));
    expect(result.ok && result.toolCalls).toEqual([{ id: "toolu_9", name: "end_turn", arguments: "{}" }]);
    expect(result.ok && result.carry).toBeUndefined();
  });

  test("stop reasons: max_tokens is the cap, refusal is declined", async () => {
    const capped = await createCompletionsClient({ fetch: recorder(() => stream(textStream("half", "max_tokens"))).fetch, clock: quick })
      .complete(hop("https://api.anthropic.com"));
    expect(capped.ok && capped.finishReason).toBe("length");
    const refused = await createCompletionsClient({ fetch: recorder(() => stream(textStream("", "refusal"))).fetch, clock: quick })
      .complete(hop("https://api.anthropic.com"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.failKind).toBe("declined");
  });

  test("an error event mid-stream fails the attempt, and the hop is asked for again", async () => {
    const { sent, fetch } = recorder((_, n) => n === 1
      ? stream([
        event("message_start", { message: { usage: { input_tokens: 10 } } }),
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "half a" } }),
        event("error", { error: { type: "overloaded_error", message: "Overloaded" } }),
      ])
      : stream(textStream("the whole reply")));
    const result = await createCompletionsClient({ fetch, clock: quick }).complete(hop("https://api.anthropic.com"));
    expect(sent).toHaveLength(2);
    expect(result.ok && result.content).toBe("the whole reply");
  });

  test("a stream that ends before message_stop and without a stop reason is incomplete", async () => {
    const { sent, fetch } = recorder(() => stream(TOOL_STREAM.slice(0, 9)));
    const result = await createCompletionsClient({ fetch, clock: quick }).complete(hop("https://api.anthropic.com"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("incomplete");
    expect(sent.length).toBe(3);
  });

  test("an endpoint that refuses adaptive thinking is asked with a budget, and then by default", async () => {
    const { sent, fetch } = recorder((one) => one.body.thinking && (one.body.thinking as { type: string }).type === "adaptive"
      ? new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "thinking.type: Input should be 'enabled' or 'disabled'" } }), { status: 400 })
      : stream(textStream("ok")));
    const client = createCompletionsClient({ fetch, clock: quick });
    const first = await client.complete(hop("https://open.example.cn/api/anthropic"));
    expect(first.ok).toBe(true);
    expect(sent.map((one) => one.body.thinking)).toEqual([{ type: "adaptive" }, { type: "enabled", budget_tokens: 16_384 }]);
    expect(sent[1]!.body.output_config).toBeUndefined();
    await client.complete(hop("https://open.example.cn/api/anthropic"));
    expect(sent[2]!.body.thinking).toEqual({ type: "enabled", budget_tokens: 16_384 });
  });

  test("a 400 about thinking blocks in the history is no reason to change the thinking form", async () => {
    const { sent, fetch } = recorder(() => new Response(JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`. When `thinking` is enabled, a final `assistant` message must start with a thinking block." },
    }), { status: 400 }));
    const client = createCompletionsClient({ fetch, clock: quick });
    const result = await client.complete(hop("https://api.anthropic.com"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("refused");
    expect(sent).toHaveLength(1);
    await client.complete(hop("https://api.anthropic.com"));
    expect(sent[1]!.body.thinking).toEqual({ type: "adaptive" });
  });

  test("a stepped-down form is kept only once a request in it gets through", async () => {
    // Refuses the adaptive form for the thinking field, then refuses everything else for another reason.
    const { sent, fetch } = recorder((one) => (one.body.thinking as { type?: string } | undefined)?.type === "adaptive"
      ? new Response(JSON.stringify({ error: { message: "thinking.type: Input should be 'enabled' or 'disabled'" } }), { status: 400 })
      : new Response(JSON.stringify({ error: { message: "messages: roles must alternate" } }), { status: 400 }));
    const client = createCompletionsClient({ fetch, clock: quick });
    expect((await client.complete(hop("https://open.example.cn/api/anthropic"))).ok).toBe(false);
    expect(sent.map((one) => (one.body.thinking as { type: string }).type)).toEqual(["adaptive", "enabled"]);
    await client.complete(hop("https://open.example.cn/api/anthropic"));
    expect((sent[2]!.body.thinking as { type: string }).type).toBe("adaptive");
  });

  test("a full context lowers the cap to what is left, for that request only", async () => {
    const { sent, fetch } = recorder((_, n) => n === 1
      ? new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "input length and `max_tokens` exceed context limit: 190000 + 32768 > 200000, decrease input length or `max_tokens` and try again" } }), { status: 400 })
      : stream(textStream("ok")));
    const client = createCompletionsClient({ fetch, clock: quick });
    expect((await client.complete(hop("https://api.anthropic.com"))).ok).toBe(true);
    expect(sent.map((one) => one.body.max_tokens)).toEqual([32_768, 10_000]);
    await client.complete(hop("https://api.anthropic.com"));
    expect(sent[2]!.body.max_tokens).toBe(32_768);
  });

  test("a prompt over the context once the cap is out of the way is context_full, not a bare refusal (ADR 0068)", async () => {
    const tooLong = new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } }), { status: 400 });
    const { sent, fetch } = recorder(() => tooLong.clone());
    const client = createCompletionsClient({ fetch, clock: quick });
    expect(await client.complete(hop("https://api.anthropic.com"))).toMatchObject({ ok: false, failKind: "context_full" });
    // Not sent again: the same prompt would meet the same window.
    expect(sent).toHaveLength(1);

    const other = recorder(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages: roles must alternate" } }), { status: 400 }));
    const refused = createCompletionsClient({ fetch: other.fetch, clock: quick });
    expect(await refused.complete(hop("https://api.anthropic.com"))).toMatchObject({ ok: false, failKind: "refused" });
  });

  test("a stream stopped at a full context is context_full, not a reply cut at the cap (ADR 0068)", async () => {
    const { fetch } = recorder(() => stream(textStream("写到一半", "model_context_window_exceeded")));
    const client = createCompletionsClient({ fetch, clock: quick });
    expect(await client.complete(hop("https://api.anthropic.com"))).toMatchObject({ ok: false, failKind: "context_full", hadChoices: true });
    const cut = recorder(() => stream(textStream("写到上限", "max_tokens")));
    expect(await createCompletionsClient({ fetch: cut.fetch, clock: quick }).complete(hop("https://api.anthropic.com")))
      .toMatchObject({ ok: true, finishReason: "length" });
  });

  test("a key refused as x-api-key goes as a Bearer token, and stays that way for the endpoint", async () => {
    const { sent, fetch } = recorder((one) => one.headers["x-api-key"]
      ? new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })
      : stream(textStream("ok")));
    const client = createCompletionsClient({ fetch, clock: quick });
    expect((await client.complete(hop("https://dashscope.example.com/apps/anthropic"))).ok).toBe(true);
    expect(sent.map((one) => one.headers.Authorization ?? one.headers["x-api-key"])).toEqual(["sk-ant-test", "Bearer sk-ant-test"]);
    await client.complete(hop("https://dashscope.example.com/apps/anthropic"));
    expect(sent[2]!.headers.Authorization).toBe("Bearer sk-ant-test");
  });

  test("a key refused both ways is refused, without a third try", async () => {
    const { sent, fetch } = recorder(() => new Response("{}", { status: 401 }));
    const result = await createCompletionsClient({ fetch, clock: quick }).complete(hop("https://api.anthropic.com"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("refused");
    expect(sent).toHaveLength(2);
  });

  test("a Chat Completions endpoint is untouched", async () => {
    const { sent, fetch } = recorder(() => new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    const result = await createCompletionsClient({ fetch, clock: quick }).complete(hop("http://127.0.0.1/v1", { apiFormat: undefined }));
    expect(result.ok && result.content).toBe("hi");
    expect(sent[0]!.url).toBe("http://127.0.0.1/v1/chat/completions");
    expect(sent[0]!.headers.Authorization).toBe("Bearer sk-ant-test");
    expect(sent[0]!.body.reasoning_effort).toBe("high");
  });
});

describe("Anthropic Messages: a judge", () => {
  function judge(over: Partial<JudgeRequest> = {}): JudgeRequest {
    return {
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      apiFormat: "anthropic",
      model: "claude-test",
      messages: [{ role: "system", content: "Answer yes or no." }, { role: "user", content: "Is it done?" }],
      signal: new AbortController().signal,
      prompt: { id: "reader", revision: null } as never,
      ...over,
    };
  }

  test("a whole answer: text, tool calls, usage, and no sampling setting", async () => {
    const { sent, fetch } = recorder(() => Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "yes" }, { type: "tool_use", id: "toolu_1", name: "file_under", input: { job: "J1" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 12, cache_read_input_tokens: 100, output_tokens: 4 },
    }));
    const result = await createCompletionsClient({ fetch, clock: quick }).judge(judge());
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.body.temperature).toBeUndefined();
    expect(sent[0]!.body.stream).toBeUndefined();
    expect(sent[0]!.body.max_tokens).toBe(256);
    expect(sent[0]!.headers["X-Session-ID"]).toBe("deskfolk-reader");
    // Only the system prompt is marked for the cache: a judge's question is never asked again.
    expect(JSON.stringify(sent[0]!.body.messages)).not.toContain("cache_control");
    expect(result.content).toBe("yes");
    expect(result.toolCalls).toEqual([{ id: "toolu_1", name: "file_under", arguments: "{\"job\":\"J1\"}" }]);
    expect(result.usage?.input_tokens).toBe(112);
    expect(result.usage?.cached_tokens).toBe(100);
    expect(result.failKind).toBeNull();
  });

  test("an answer cut at the cap says so; a refused one fails as endpoint_error", async () => {
    const cut = await createCompletionsClient({
      fetch: recorder(() => Response.json({ content: [{ type: "text", text: "ye" }], stop_reason: "max_tokens", usage: {} })).fetch,
      clock: quick,
    }).judge(judge());
    expect(cut.truncated).toBe(true);
    const refused = await createCompletionsClient({ fetch: recorder(() => new Response("{}", { status: 404 })).fetch, clock: quick }).judge(judge());
    expect(refused.failKind).toBe("endpoint_error");
  });
});

describe("Anthropic Messages: the model list", () => {
  test("probed at /v1/models with the Messages headers, falling back to Bearer", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = { ...(init?.headers as Record<string, string>) };
      seen.push({ url, headers });
      if (headers["x-api-key"]) return new Response("{}", { status: 401 });
      return Response.json({ data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { type: "model", id: "claude-haiku-4-5" }], has_more: false });
    }) as typeof fetch;
    const probed = await probeEndpointModels("https://api.anthropic.com/", "sk-ant-test", fetchImpl, undefined, { apiFormat: "anthropic" });
    expect(probed.models).toEqual(["claude-opus-5-5", "claude-haiku-4-5"]);
    expect(seen.map((one) => one.url)).toEqual(["https://api.anthropic.com/v1/models?limit=1000", "https://api.anthropic.com/v1/models?limit=1000"]);
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[1]!.headers.Authorization).toBe("Bearer sk-ant-test");
  });
});
