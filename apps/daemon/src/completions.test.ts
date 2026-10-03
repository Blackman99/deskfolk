import { describe, expect, test } from "bun:test";
import { createCompletionsClient, type CompletionRequest } from "./completions";
import type { WakeWatch } from "./wake";

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textSse(text: string): string {
  return (
    sseChunk({
      id: "chatcmpl-1",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    }) +
    sseChunk({
      id: "chatcmpl-1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) +
    "data: [DONE]\n\n"
  );
}

function hangingStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  let hang: ((reason?: unknown) => void) | null = null;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
        return;
      }
      return new Promise((_, reject) => {
        hang = reject;
      });
    },
    cancel() {
      hang?.(new Error("cancelled"));
    },
  });
}

function request(baseUrl: string, signal = new AbortController().signal): CompletionRequest {
  return {
    baseUrl,
    apiKey: "sk-test",
    model: "test-model",
    thinkingLevel: "none",
    messages: [{ role: "user", content: "go" }],
    tools: [],
    signal,
  };
}

describe("completions recovery", () => {
  test("a stall after some text keeps none of it: the hop is asked for again", async () => {
    let attempts = 0;
    const client = createCompletionsClient({
      clock: { firstByteMs: 80, idleMs: 40, sleep: quickBackoff },
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            hangingStream([
              sseChunk({
                id: "chatcmpl-1",
                choices: [{ index: 0, delta: { role: "assistant", content: "half a" }, finish_reason: null }],
              }),
            ]),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response(textSse("the whole reply"), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("the whole reply");
  });

  test("a stream that closes before the model finished is incomplete, never a reply", async () => {
    let attempts = 0;
    const client = createCompletionsClient({
      clock: { sleep: quickBackoff },
      fetch: async () => {
        attempts += 1;
        // No finish reason and no [DONE]: the connection ended partway.
        return new Response(
          sseChunk({ id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant", content: "half a" }, finish_reason: null }] }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("incomplete");
  });

  test("an empty finish reason is no finish reason: a stream cut after one is incomplete, and one that goes on to stop is a reply", async () => {
    let attempts = 0;
    let finishing = false;
    const client = createCompletionsClient({
      clock: { sleep: quickBackoff },
      fetch: async () => {
        attempts += 1;
        // Some endpoints send `finish_reason: ""` on every chunk until the last one.
        const half = sseChunk({ id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant", content: "half a" }, finish_reason: "" }] });
        const rest = sseChunk({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: " reply" }, finish_reason: "stop" }] });
        return new Response(finishing ? half + rest : half, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const cut = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(3);
    expect(cut.ok ? null : cut.failKind).toBe("incomplete");
    finishing = true;
    attempts = 0;
    const whole = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(1);
    expect(whole).toMatchObject({ ok: true, content: "half a reply", finishReason: "stop" });
  });

  test("a stall with no usable output retries the hop", async () => {
    let attempts = 0;
    const client = createCompletionsClient({
      clock: {
        firstByteMs: 80,
        idleMs: 30,
        sleep: (ms) => (ms >= 1000 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))),
      },
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            hangingStream([
              sseChunk({
                id: "chatcmpl-1",
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              }),
            ]),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response(textSse("second try"), {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("second try");
  });

  test("comment heartbeats keep the first-byte window open", async () => {
    const client = createCompletionsClient({
      clock: { firstByteMs: 40, idleMs: 40 },
      fetch: async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              await new Promise((resolve) => setTimeout(resolve, 25));
              controller.enqueue(encoder.encode(": ping\n\n"));
              await new Promise((resolve) => setTimeout(resolve, 25));
              controller.enqueue(encoder.encode(textSse("after ping")));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("after ping");
  });

  test("a stall with no usable output fails after retries", async () => {
    let attempts = 0;
    const client = createCompletionsClient({
      clock: {
        firstByteMs: 40,
        idleMs: 30,
        sleep: (ms) => (ms >= 1000 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))),
      },
      fetch: async () => {
        attempts += 1;
        return new Response(
          hangingStream([
            sseChunk({
              id: "chatcmpl-1",
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            }),
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("stalled");
  });

  test("an aborted waiter does not starve the next stream on that origin", async () => {
    let started = 0;
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = createCompletionsClient({
      originLimit: 1,
      fetch: async () => {
        started += 1;
        if (started === 1) await firstHeld;
        return new Response(textSse("ok"), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const first = client.complete(request("http://same.test/v1"));
    await Bun.sleep(10);
    expect(started).toBe(1);
    const cancelled = new AbortController();
    const waiting = client.complete(request("http://same.test/v1", cancelled.signal));
    await Bun.sleep(10);
    cancelled.abort();
    const third = client.complete(request("http://same.test/v1"));
    await Bun.sleep(10);
    expect(started).toBe(1);
    releaseFirst();
    const results = await Promise.all([first, waiting, third]);
    expect(started).toBe(2);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[2]?.ok).toBe(true);
  });

  test("one origin only runs the configured number of streams at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = createCompletionsClient({
      originLimit: 1,
      fetch: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        return new Response(textSse("ok"), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const results = await Promise.all([
      client.complete(request("http://same.test/v1")),
      client.complete(request("http://same.test/v1")),
      client.complete(request("http://same.test/v1")),
    ]);
    expect(maxInFlight).toBe(1);
    expect(results.every((row) => row.ok)).toBe(true);
  });

  test("a 400 still fails without retrying", async () => {
    let attempts = 0;
    const client = createCompletionsClient({
      fetch: async () => {
        attempts += 1;
        return new Response("nope", { status: 400 });
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("refused");
  });
});

/** A watch whose answers the test scripts; `waits` counts how often a request sat out a wake. */
function scriptedWake(script: { slept?: () => number; settled?: () => boolean; onWait?: () => void }) {
  let waits = 0;
  const wake: WakeWatch = {
    sleptBetween: () => script.slept?.() ?? 0,
    settled: () => script.settled?.() ?? true,
    async untilSettled(signal) {
      waits += 1;
      script.onWait?.();
      return !signal?.aborted;
    },
    awakeTimeout: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    stop: () => {},
  };
  return { wake, waits: () => waits };
}

const quickBackoff = (ms: number) =>
  ms >= 1000 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("completions across macOS sleep", () => {
  test("a request sent before Wi-Fi is back waits for it and does not use up attempts", async () => {
    let attempts = 0;
    let settled = false;
    const { wake, waits } = scriptedWake({
      settled: () => settled,
      // Two more maintenance wakes come and go before the lid opens.
      onWait: () => {
        if (waits() === 4) settled = true;
      },
    });
    const client = createCompletionsClient({
      clock: { sleep: quickBackoff },
      wake,
      fetch: async () => {
        attempts += 1;
        if (!settled) throw new TypeError("fetch failed");
        return new Response(textSse("after the wake"), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(waits()).toBe(4);
    expect(attempts).toBe(5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("after the wake");
  });

  test("awake and settled, an unreachable endpoint still fails after three tries", async () => {
    let attempts = 0;
    const { wake, waits } = scriptedWake({});
    const client = createCompletionsClient({
      clock: { sleep: quickBackoff },
      wake,
      fetch: async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(waits()).toBe(0);
    expect(attempts).toBe(3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("unreachable");
  });

  test("half a reply the Mac slept through is asked for again, not kept", async () => {
    let attempts = 0;
    const { wake, waits } = scriptedWake({ slept: () => (attempts === 1 ? 30 * 60_000 : 0) });
    const client = createCompletionsClient({
      clock: { firstByteMs: 80, idleMs: 40, sleep: quickBackoff },
      wake,
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            hangingStream([
              sseChunk({
                id: "chatcmpl-1",
                choices: [{ index: 0, delta: { role: "assistant", content: "half" }, finish_reason: null }],
              }),
            ]),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response(textSse("the whole reply"), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(2);
    expect(waits()).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("the whole reply");
  });

  test("sleep can only send one request back so many times", async () => {
    let attempts = 0;
    const { wake, waits } = scriptedWake({ settled: () => false });
    const client = createCompletionsClient({
      clock: { sleep: quickBackoff },
      wake,
      fetch: async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(waits()).toBe(10);
    expect(attempts).toBe(13);
    expect(result.ok).toBe(false);
  });

  test("a Stop while waiting for the network ends the request", async () => {
    const abort = new AbortController();
    let attempts = 0;
    const { wake } = scriptedWake({ settled: () => false, onWait: () => abort.abort() });
    const client = createCompletionsClient({
      clock: { sleep: quickBackoff },
      wake,
      fetch: async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1", abort.signal));
    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
  });
});

describe("onToken vs onEvent", () => {
  test("a tool-call-only reply never fires onToken, but onEvent sees every chunk — a caller timing a stream must use onEvent, not onToken, or a compliant tool-calling model always reads as zero samples", async () => {
    const client = createCompletionsClient({
      fetch: async () =>
        new Response(
          sseChunk({ id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "step", arguments: "{}" } }] }, finish_reason: null }] }) +
            sseChunk({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) +
            "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    let tokenCalls = 0;
    let eventCalls = 0;
    const result = await client.complete({
      ...request("http://127.0.0.1/v1"),
      onToken: () => {
        tokenCalls += 1;
      },
      onEvent: () => {
        eventCalls += 1;
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.toolCalls).toHaveLength(1);
    expect(tokenCalls).toBe(0);
    expect(eventCalls).toBeGreaterThanOrEqual(2);
  });
});

describe("output caps and failure shapes", () => {
  const sse = (body: string) => new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  const delta = (d: Record<string, unknown>, finish: string | null = null) =>
    sseChunk({ id: "chatcmpl-1", choices: [{ index: 0, delta: d, finish_reason: finish }] });

  /** A stream that sends one chunk per read, forever, and counts what it sent. */
  function endless(chunk: (i: number) => string, gapMs = 0) {
    const encoder = new TextEncoder();
    const state = { sent: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (gapMs) await Bun.sleep(gapMs);
        controller.enqueue(encoder.encode(chunk(state.sent)));
        state.sent += 1;
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { body, state };
  }

  /**
   * Claude refuses a whole request over one whitespace-only text block. A model that answered
   * "\n\n" twice in a row left one in the loop, and the next step of the turn was refused.
   */
  test("whitespace-only text never reaches the endpoint, tool results and tool calls stay paired", async () => {
    const sent: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const client = createCompletionsClient({
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> });
        return sse(textSse("ok"));
      },
    });
    await client.complete({
      ...request("http://127.0.0.1/v1"),
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "go" },
        { role: "assistant", content: "\n\n", tool_calls: [{ id: "call_1", name: "shell", arguments: "{}" }] },
        { role: "tool", tool_call_id: "call_1", content: "" },
        { role: "assistant", content: " \n" },
        { role: "user", content: "\n" },
        { role: "user", content: [{ type: "text", text: "  " }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
        { role: "user", content: [{ type: "text", text: " " }] },
        { role: "user", content: "next step?" },
      ],
    });
    expect(sent[0]!.messages).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
      { role: "user", content: "next step?" },
    ]);
  });

  test("each attempt sends the hop's max_tokens", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = createCompletionsClient({
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sse(textSse("ok"));
      },
    });
    await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
    await client.complete(request("http://127.0.0.1/v1"));
    expect(sent.map((body) => body.max_tokens)).toEqual([32_768, undefined]);
  });

  test("a reply that loops is cut off mid-stream as a repeat, and not asked for again", async () => {
    let attempts = 0;
    const stream = endless(() => delta({ content: "停工已对齐，本轮不再发消息。" }));
    const client = createCompletionsClient({
      fetch: async () => {
        attempts += 1;
        return new Response(stream.body, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("repeat");
    // Stopped on the fifth copy, with the connection closed so the endpoint stops writing too.
    expect(stream.state.sent).toBeLessThan(10);
    expect(stream.state.cancelled).toBe(true);
  });

  test("a tool call's arguments are not watched: a file that repeats itself is written as asked", async () => {
    // One line of the file as it streams inside the JSON arguments, so its newline is escaped.
    const line = "这一镜的背景保持和上一镜一致。\\n";
    const pieces = Array.from({ length: 20 }, () => line);
    const client = createCompletionsClient({
      fetch: async () =>
        sse(
          delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: '{"path":"notes.md","content":"' } }] }) +
            pieces.map((piece) => delta({ tool_calls: [{ index: 0, function: { arguments: piece } }] })).join("") +
            delta({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }) +
            delta({}, "tool_calls") +
            "data: [DONE]\n\n",
        ),
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.toolCalls[0]!.arguments).content).toBe(line.replace("\\n", "\n").repeat(20));
  });

  test("cut off at the cap in prose, the reply comes back as it is for the turn to carry on from", async () => {
    const client = createCompletionsClient({
      fetch: async () => sse(delta({ content: "第一部分写到这里" }) + delta({}, "length") + "data: [DONE]\n\n"),
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(result).toMatchObject({ ok: true, content: "第一部分写到这里", finishReason: "length", toolCalls: [] });
    expect(result.ok && result.toolArgsCut).toBeFalsy();
  });

  test("cut off at the cap inside a tool call's arguments, the call is dropped and the reply says so", async () => {
    let attempts = 0;
    const client = createCompletionsClient({
      fetch: async () => {
        attempts += 1;
        return sse(
          delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: '{"path":"a.md","content":"很长' } }] }) +
            delta({}, "length") +
            "data: [DONE]\n\n",
        );
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ ok: true, finishReason: "length", toolCalls: [], toolArgsCut: true });
  });

  test("a finish reason is read case-folded, and a proxy's other names for the cap are length", async () => {
    // Proxies in front of Gemini pass its own reasons through (STOP, MAX_TOKENS); Mistral says model_length.
    for (const [finish, read] of [
      ["STOP", "stop"],
      ["end_turn", "end_turn"],
      ["max_tokens", "length"],
      ["MAX_TOKENS", "length"],
      ["model_length", "length"],
    ] as const) {
      let attempts = 0;
      const client = createCompletionsClient({
        fetch: async () => {
          attempts += 1;
          return sse(delta({ content: "写到这里" }) + delta({}, finish) + "data: [DONE]\n\n");
        },
      });
      const result = await client.complete(request("http://127.0.0.1/v1"));
      expect({ finish, attempts, result: result.ok && [result.content, result.finishReason] }).toEqual({
        finish,
        attempts: 1,
        result: ["写到这里", read],
      });
    }
  });

  test("a finished stream with a finish reason the client has no name for is a reply, not half a stream", async () => {
    for (const ending of ["data: [DONE]\n\n", ""]) {
      let attempts = 0;
      const client = createCompletionsClient({
        fetch: async () => {
          attempts += 1;
          return sse(delta({ content: "做完了。" }) + delta({}, "eos") + ending);
        },
      });
      const result = await client.complete(request("http://127.0.0.1/v1"));
      expect({ ending, attempts, result: result.ok && [result.content, result.finishReason] }).toEqual({
        ending,
        attempts: 1,
        result: ["做完了。", "eos"],
      });
    }
  });

  test("a last event without the blank line after it is still read", async () => {
    let attempts = 0;
    const client = createCompletionsClient({
      fetch: async () => {
        attempts += 1;
        // The connection closes right after the finish reason, before its closing blank line and [DONE].
        return sse(delta({ content: "做完了。" }) + delta({}, "stop").replace(/\n\n$/, "\n"));
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ ok: true, content: "做完了。", finishReason: "stop" });
  });

  test("an endpoint that refuses max_tokens by name gets max_completion_tokens, and keeps getting it", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = createCompletionsClient({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        if ("max_tokens" in body) {
          // What OpenAI answers for its reasoning models.
          return new Response(
            JSON.stringify({
              error: {
                message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
                type: "invalid_request_error",
                param: "max_tokens",
                code: "unsupported_parameter",
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return sse(textSse("ok"));
      },
    });
    const first = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
    const second = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(sent.map((body) => [body.max_tokens, body.max_completion_tokens])).toEqual([
      [32_768, undefined],
      [undefined, 32_768],
      [undefined, 32_768],
    ]);
  });

  test("a 400 that does not name the other field is refused as before", async () => {
    let attempts = 0;
    const client = createCompletionsClient({
      fetch: async () => {
        attempts += 1;
        return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 400 });
      },
    });
    const result = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
    expect(attempts).toBe(1);
    expect(result.ok ? null : result.failKind).toBe("refused");
  });

  /**
   * An endpoint that answers `message` with a 400 while the cap sent is over `limit`, and what each
   * request's cap was under either name, so a needless rename shows as one more request.
   */
  function capLimited(limit: number, message: string) {
    const caps: Array<number | undefined> = [];
    const client = createCompletionsClient({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { max_tokens?: number; max_completion_tokens?: number };
        const cap = body.max_tokens ?? body.max_completion_tokens;
        caps.push(cap);
        if (cap !== undefined && cap > limit) {
          return new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param: "max_tokens" } }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return sse(textSse("ok"));
      },
    });
    return { client, caps };
  }

  test("a model that writes less than the cap gets the limit its endpoint names, and keeps getting it", async () => {
    for (const [limit, message] of [
      // DeepSeek's deepseek-chat.
      [8192, "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]"],
      // OpenAI's gpt-4o and gpt-4o-mini.
      [16_384, "max_tokens is too large: 32768. This model supports at most 16384 completion tokens, whereas you provided 32768."],
      // Claude through Anthropic's OpenAI-compatible endpoint.
      [8192, "max_tokens: 32768 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet-20241022"],
    ] as const) {
      const { client, caps } = capLimited(limit, message);
      const first = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
      const second = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
      expect({ message, ok: [first.ok, second.ok], caps }).toEqual({ message, ok: [true, true], caps: [32_768, limit, limit] });
    }
  });

  test("a refusal of the cap that names no limit of the model's own is sent again without one", async () => {
    const message = "max_tokens 参数超出范围";
    const { client, caps } = capLimited(4096, message);
    const first = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
    const second = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
    expect({ ok: [first.ok, second.ok], caps }).toEqual({ ok: [true, true], caps: [32_768, undefined, undefined] });
  });

  test("a refusal of the cap that is really a full context goes without one that time only, however it is worded", async () => {
    // vLLM: the number is the context length, and naming both fields is not asking for the other.
    const message =
      "'max_tokens' or 'max_completion_tokens' is too large: 32768. This model's maximum context length is 32768 tokens and your request has 150 input tokens (32768 > 32768 - 150).";
    const { client, caps } = capLimited(4096, message);
    const first = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
    const second = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
    // Each hop sends its cap first: the next prompt may fit with it.
    expect({ ok: [first.ok, second.ok], caps }).toEqual({ ok: [true, true], caps: [32_768, undefined, 32_768, undefined] });
  });

  test("a prompt that fills the context with the cap is sent again without one, that time only", async () => {
    let full = true;
    const caps: Array<number | undefined> = [];
    const client = createCompletionsClient({
      fetch: async (_url, init) => {
        const cap = (JSON.parse(String(init?.body)) as { max_tokens?: number }).max_tokens;
        caps.push(cap);
        if (full && cap !== undefined) {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "This model's maximum context length is 128000 tokens. However, you requested 140000 tokens (107232 in the messages, 32768 in the completion). Please reduce the length of the messages or completion.",
                type: "invalid_request_error",
                param: "messages",
                code: "context_length_exceeded",
              },
            }),
            { status: 400 },
          );
        }
        return sse(textSse("ok"));
      },
    });
    const first = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
    full = false;
    const second = await client.complete({ ...request("http://127.0.0.1/v1"), maxTokens: 32_768 });
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(caps).toEqual([32_768, undefined, 32_768]);
  });

  test("a stream that goes quiet after its finish reason is a whole reply", async () => {
    let attempts = 0;
    const client = createCompletionsClient({
      clock: { firstByteMs: 80, idleMs: 40, sleep: quickBackoff },
      fetch: async () => {
        attempts += 1;
        // The finish reason comes, then neither [DONE] nor the connection closing.
        return new Response(hangingStream([delta({ content: "做完了。" }), delta({}, "stop")]), {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ ok: true, content: "做完了。", finishReason: "stop" });
  });

  test("a stream that ends with finish reason error is half a reply, and is asked for again", async () => {
    let attempts = 0;
    let failing = 1;
    const client = createCompletionsClient({
      clock: { sleep: quickBackoff },
      fetch: async () => {
        attempts += 1;
        // What OpenRouter sends when the model behind it fails partway.
        if (attempts <= failing) return sse(delta({ content: "第一部分写到" }) + delta({}, "error") + "data: [DONE]\n\n");
        return sse(textSse("the whole reply"));
      },
    });
    const retried = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(2);
    expect(retried.ok && retried.content).toBe("the whole reply");

    attempts = 0;
    failing = 3;
    const failed = await client.complete(request("http://127.0.0.1/v1"));
    expect(attempts).toBe(3);
    expect(failed.ok ? null : failed.failKind).toBe("incomplete");
  });

  test("an endpoint's refusal finish reason is declined, and not asked for again", async () => {
    for (const finish of ["content_filter", "SAFETY"]) {
      let attempts = 0;
      const client = createCompletionsClient({
        fetch: async () => {
          attempts += 1;
          return sse(delta({ content: "I cannot" }) + delta({}, finish) + "data: [DONE]\n\n");
        },
      });
      const result = await client.complete(request("http://127.0.0.1/v1"));
      expect({ finish, attempts, fail: result.ok ? null : result.failKind }).toEqual({ finish, attempts: 1, fail: "declined" });
    }
  });

  test("an attempt still streaming past its time limit fails as overtime, and is not asked for again", async () => {
    let attempts = 0;
    // Keep-alive comments reset the idle timer forever; only the time limit ends this.
    const stream = endless(() => ": ping\n\n", 5);
    const client = createCompletionsClient({
      clock: { firstByteMs: 1000, idleMs: 1000 },
      fetch: async () => {
        attempts += 1;
        return new Response(stream.body, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const result = await client.complete({ ...request("http://127.0.0.1/v1"), wallMs: 60 });
    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failKind).toBe("overtime");
    expect(stream.state.cancelled).toBe(true);
  });

  test("a time limit the Mac slept through is not overtime: the request waits for the network and goes again", async () => {
    let attempts = 0;
    const { wake, waits } = scriptedWake({ slept: () => (attempts === 1 ? 30 * 60_000 : 0) });
    const client = createCompletionsClient({
      clock: { firstByteMs: 1000, idleMs: 1000, sleep: quickBackoff },
      wake,
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) return new Response(endless(() => ": ping\n\n", 5).body, { headers: { "Content-Type": "text/event-stream" } });
        return sse(textSse("after the wake"));
      },
    });
    const result = await client.complete({ ...request("http://127.0.0.1/v1"), wallMs: 60 });
    expect(attempts).toBe(2);
    expect(waits()).toBe(1);
    expect(result.ok && result.content).toBe("after the wake");
  });
});

describe("judge token cap", () => {
  function answering(finishReason: string, sent: Array<Record<string, unknown>>) {
    return createCompletionsClient({
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: '{"plan":' }, finish_reason: finishReason }],
            usage: { prompt_tokens: 10, completion_tokens: 256 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
  }
  const ask = (over: { maxTokens?: number; tools?: unknown[] } = {}) => ({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "sk-test",
    model: "test-model",
    messages: [{ role: "user" as const, content: "go" }],
    signal: new AbortController().signal,
    ...over,
  });

  test("a caller that needs room says how much; the rest keep a verdict's cap", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = answering("stop", sent);
    await client.judge(ask({ maxTokens: 4096 }));
    await client.judge(ask());
    await client.judge(ask({ tools: [{ type: "function", function: { name: "pick" } }] }));
    expect(sent.map((body) => body.max_tokens)).toEqual([4096, 256, 512]);
  });

  test("an answer that stopped at the cap says so, and is still handed back", async () => {
    const cut = await answering("length", []).judge(ask());
    expect(cut).toMatchObject({ truncated: true, failKind: null, content: '{"plan":' });
    const whole = await answering("stop", []).judge(ask());
    expect(whole.truncated).toBeUndefined();
    // A proxy passing Gemini's own reason through.
    expect((await answering("MAX_TOKENS", []).judge(ask())).truncated).toBe(true);
  });
});
