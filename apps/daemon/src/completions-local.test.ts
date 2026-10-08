import { describe, expect, test } from "bun:test";
import { createCompletionsClient, type CompletionRequest, type JudgeRequest } from "./completions";

// ADR 0067: what a model server on this computer or network gets from the client.

const OLLAMA = "http://localhost:11434/v1";

function sse(...payloads: unknown[]): Response {
  const body = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function reply(content: string, promptTokens: number, extra: Record<string, unknown> = {}): Response {
  return sse(
    { choices: [{ index: 0, delta: { role: "assistant", ...extra, content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 } },
  );
}

/** A hop the size of a Bot's: about 100 KB of text. */
function bigHop(baseUrl = OLLAMA, overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    baseUrl,
    apiKey: "",
    model: "qwen3:8b",
    thinkingLevel: "none",
    messages: [{ role: "system", content: "rule ".repeat(20_000) }, { role: "user", content: "go" }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function judgeOf(baseUrl = OLLAMA, overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    baseUrl,
    apiKey: "",
    model: "qwen3:8b",
    messages: [{ role: "system", content: "classify" }, { role: "user", content: "hello" }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

type Seen = { url: string; headers: Record<string, string>; body: Record<string, unknown> | null };

function recorder(answer: (seen: Seen, index: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const entry: Seen = {
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    seen.push(entry);
    return answer(entry, seen.length - 1);
  };
  return { seen, fetch };
}

describe("keyless requests", () => {
  test("an empty key sends no Authorization header, and no level sends no reasoning_effort", async () => {
    const { seen, fetch } = recorder(() => reply("hi", 10));
    const client = createCompletionsClient({ fetch });
    const result = await client.complete({ ...bigHop(), messages: [{ role: "user", content: "go" }], thinkingLevel: null as never });
    expect(result.ok).toBe(true);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.body).not.toHaveProperty("reasoning_effort");
  });

  test("a key still goes as a Bearer token", async () => {
    const { seen, fetch } = recorder(() => reply("hi", 10));
    await createCompletionsClient({ fetch }).complete({ ...bigHop(), apiKey: "sk-x", messages: [{ role: "user", content: "go" }] });
    expect(seen[0]!.headers.authorization).toBe("Bearer sk-x");
  });
});

describe("a prompt the local server cut", () => {
  test("a hop whose reported tokens say it was cut fails as context_full, with the server's window", async () => {
    // The measured case: 165,868 bytes sent, 16,386 tokens read (Ollama 0.40, qwen3:8b, 2026-10-08).
    const measured = { ...bigHop(), messages: [{ role: "system" as const, content: "rule ".repeat(33_000) }, { role: "user" as const, content: "go" }] };
    const windows: Array<[string, string, number]> = [];
    const { seen, fetch } = recorder((entry) => {
      if (entry.url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3:8b", details: { context_length: 40960 } }] });
      if (entry.url.endsWith("/api/ps")) return Response.json({ models: [{ name: "qwen3:8b", context_length: 32768 }] });
      return reply("SYSTEM", 16_386);
    });
    const client = createCompletionsClient({ fetch, onWindow: (...args) => windows.push(args) });
    const result = await client.complete(measured);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failKind).toBe("context_full");
    expect(result.contextFull).toEqual({ estimated: 41_251, read: 16_386, window: 32_768 });
    expect(windows).toEqual([[OLLAMA, "qwen3:8b", 32_768]]);
    // Sent once: the same prompt would be cut the same way.
    expect(seen.filter((entry) => entry.url.endsWith("/chat/completions"))).toHaveLength(1);
  });

  test("a whole hop teaches the model's bytes per token, and the next cut is caught by it", async () => {
    let promptTokens = 29_500;
    const { fetch } = recorder((entry) => (entry.url.endsWith("/chat/completions") ? reply("ok", promptTokens) : new Response("", { status: 404 })));
    const client = createCompletionsClient({ fetch });
    expect((await client.complete(bigHop())).ok).toBe(true);
    // ~3.4 bytes a token learned; 18,000 tokens for the same 100 KB is 5.6 — under the fixed rule, over the learned one.
    promptTokens = 18_000;
    const second = await client.complete(bigHop());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failKind).toBe("context_full");
  });

  test("within one conversation, a longer prompt read as fewer tokens was cut: the server dropped its oldest messages (ADR 0068)", async () => {
    let promptTokens = 29_000;
    const windows: Array<[string, string, number]> = [];
    const { fetch } = recorder((entry) => {
      if (entry.url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3:8b", details: { context_length: 40_960 } }] });
      if (entry.url.endsWith("/api/ps")) return Response.json({ models: [{ name: "qwen3:8b", context_length: 32_768 }] });
      if (entry.url.endsWith("/chat/completions")) return reply("ok", promptTokens);
      return new Response("", { status: 404 });
    });
    const client = createCompletionsClient({ fetch, onWindow: (...args) => windows.push(args) });
    const hop = (grown: number, affinity = "deskfolk-s-alpha") =>
      bigHop(OLLAMA, { affinity, messages: [{ role: "system", content: "rule ".repeat(20_000 + grown) }, { role: "user", content: "go" }] });
    expect((await client.complete(hop(0))).ok).toBe(true);
    // A few hundred tokens fewer for 4 KB more: well within the bytes-per-token rule, which misses it.
    promptTokens = 28_900;
    // Another conversation on the same model says nothing about this one.
    expect((await client.complete(hop(800, "deskfolk-s-beta"))).ok).toBe(true);
    expect(await client.complete(hop(800))).toMatchObject({ ok: false, failKind: "context_full", contextFull: { read: 28_900, window: 32_768 } });
    expect(windows).toEqual([[OLLAMA, "qwen3:8b", 32_768]]);
  });

  test("a request clearly over the window on record is not sent", async () => {
    const { seen, fetch } = recorder(() => reply("ok", 10));
    const client = createCompletionsClient({ fetch, windowOf: () => 8192 });
    const result = await client.complete(bigHop());
    expect(seen).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.contextFull).toEqual({ estimated: 25_001, window: 8192 });
  });

  test("a cloud endpoint is never judged cut", async () => {
    const { fetch } = recorder(() => reply("ok", 100));
    const result = await createCompletionsClient({ fetch }).complete(bigHop("https://api.example.com/v1", { apiKey: "sk" }));
    expect(result.ok).toBe(true);
  });

  test("a refusal that says the prompt is over the context reads as context_full", async () => {
    const { fetch } = recorder(() =>
      Response.json({ error: { message: "the request exceeds the available context size, try increasing it", type: "exceed_context_size_error" } }, { status: 400 }),
    );
    const result = await createCompletionsClient({ fetch }).complete(bigHop("http://127.0.0.1:8080/v1"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("context_full");
  });
});

describe("reasoning models", () => {
  test("a leading <think> block in the content is not the reply", async () => {
    const tokens: string[] = [];
    const { fetch } = recorder(() =>
      sse(
        { choices: [{ index: 0, delta: { content: "<think>\nweigh it" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: " up</think>\n\nThe answer." }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ),
    );
    const result = await createCompletionsClient({ fetch }).complete({ ...bigHop("http://127.0.0.1:8080/v1"), messages: [{ role: "user", content: "q" }], onToken: (text) => tokens.push(text) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("The answer.");
    expect(tokens.join("")).toBe("The answer.");
  });

  test("a local model looping in its thinking is cut off as a repeat", async () => {
    const loop = "Wait, I should double check the file list again. ".repeat(12);
    const { fetch } = recorder(() =>
      sse(
        { choices: [{ index: 0, delta: { reasoning: loop }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] },
      ),
    );
    const result = await createCompletionsClient({ fetch }).complete({ ...bigHop(), messages: [{ role: "user", content: "q" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("repeat");
  });

  test("a short call to a local model asks it not to think, unless the model refused that", async () => {
    let refuse = false;
    const { seen, fetch } = recorder((entry) => {
      if (refuse && entry.body?.reasoning_effort === "none") {
        return Response.json({ error: { message: "reasoning_effort 'none' is not supported" } }, { status: 400 });
      }
      return Response.json({ choices: [{ message: { content: "<think>x</think>{\"kind\":\"task\"}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    });
    const client = createCompletionsClient({ fetch });
    const first = await client.judge(judgeOf());
    expect(first.content).toBe("{\"kind\":\"task\"}");
    expect(seen[0]!.body?.reasoning_effort).toBe("none");
    // A level the caller names is sent as named.
    await client.judge(judgeOf(OLLAMA, { thinkingLevel: "low" }));
    expect(seen[1]!.body?.reasoning_effort).toBe("low");
    refuse = true;
    const refused = await client.judge(judgeOf(OLLAMA, { model: "gpt-oss:20b" }));
    expect(refused.failKind).toBeNull();
    expect(seen.slice(2).map((entry) => entry.body?.reasoning_effort ?? null)).toEqual(["none", null]);
    await client.judge(judgeOf(OLLAMA, { model: "gpt-oss:20b" }));
    expect(seen[4]!.body).not.toHaveProperty("reasoning_effort");
  });

  test("a cloud endpoint's short call still sends no level of its own", async () => {
    const { seen, fetch } = recorder(() => Response.json({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }));
    await createCompletionsClient({ fetch }).judge(judgeOf("https://api.example.com/v1", { apiKey: "sk" }));
    expect(seen[0]!.body).not.toHaveProperty("reasoning_effort");
  });
});

describe("local timers and turns", () => {
  test("streams to one local server go one at a time", async () => {
    let open = 0;
    let most = 0;
    const fetch = async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 20));
      open -= 1;
      return reply("ok", 10);
    };
    const client = createCompletionsClient({ fetch });
    const small = { ...bigHop(), messages: [{ role: "user" as const, content: "go" }] };
    await Promise.all([client.complete(small), client.complete(small), client.complete(small)]);
    expect(most).toBe(1);
  });
});

describe("review fixes", () => {
  test("thinking full of short restated lines is not a loop", async () => {
    const lines = ["好的。", "再看一下。", "嗯，对。", "Let me check.", "OK.", "Yes.", "Wait.", "对的。"];
    const thinking = Array.from({ length: 40 }, (_, i) => lines[i % lines.length]).join("\n");
    const { fetch } = recorder(() =>
      sse(
        { choices: [{ index: 0, delta: { reasoning: thinking }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] },
      ),
    );
    const result = await createCompletionsClient({ fetch }).complete({ ...bigHop(), messages: [{ role: "user", content: "q" }] });
    expect(result.ok).toBe(true);
  });

  test("a stream in the reading lane does not queue behind a local hop", async () => {
    let releaseHop!: () => void;
    const hopHeld = new Promise<void>((resolve) => { releaseHop = resolve; });
    const order: string[] = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      if (body.messages[0]!.content === "hop") await hopHeld;
      order.push(body.messages[0]!.content);
      return reply("ok", 10);
    };
    const client = createCompletionsClient({ fetch });
    const base = { ...bigHop() };
    const hop = client.complete({ ...base, messages: [{ role: "user", content: "hop" }] });
    await Bun.sleep(10);
    const test = await client.complete({ ...base, messages: [{ role: "user", content: "speed" }], lane: "reading" });
    expect(test.ok).toBe(true);
    expect(order).toEqual(["speed"]);
    releaseHop();
    await hop;
    expect(order).toEqual(["speed", "hop"]);
  });

  test("a refusal that only mentions 上下文 in passing is not a full context", async () => {
    const refusal = (message: string) => recorder(() => Response.json({ error: { message } }, { status: 400 })).fetch;
    const loose = await createCompletionsClient({ fetch: refusal("请求参数错误：上下文中的消息格式不对") }).complete(bigHop("https://api.example.com/v1", { apiKey: "sk" }));
    expect(!loose.ok && loose.failKind).toBe("refused");
    const full = await createCompletionsClient({ fetch: refusal("输入超过了模型的上下文长度") }).complete(bigHop("https://api.example.com/v1", { apiKey: "sk" }));
    expect(!full.ok && full.failKind).toBe("context_full");
  });
});
