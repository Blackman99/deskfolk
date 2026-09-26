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
  test("a stall after usable text is kept as the reply", async () => {
    const client = createCompletionsClient({
      clock: { firstByteMs: 80, idleMs: 40 },
      fetch: async () =>
        new Response(
          hangingStream([
            sseChunk({
              id: "chatcmpl-1",
              choices: [{ index: 0, delta: { role: "assistant", content: "kept" }, finish_reason: null }],
            }),
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const result = await client.complete(request("http://127.0.0.1/v1"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("kept");
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
