import { describe, expect, test } from "bun:test";
import { extractModelIds, extractProbedModels, probeEndpointModels, refusalText } from "./probe-models";

describe("extractModelIds", () => {
  test("extracts from OpenAI format", () => {
    const data = {
      object: "list",
      data: [
        { id: "gpt-4o", object: "model" },
        { id: "gpt-4o-mini", object: "model" },
        { id: "text-embedding-3-small", object: "model" },
      ],
    };
    expect(extractModelIds(data)).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
      "text-embedding-3-small",
    ]);
  });

  test("extracts from Ollama / models format", () => {
    const data = {
      models: [
        { name: "llama3:latest" },
        { name: "qwen2.5:7b" },
      ],
    };
    expect(extractModelIds(data)).toEqual(["llama3:latest", "qwen2.5:7b"]);
  });

  test("extracts from plain string array", () => {
    const data = ["claude-3-5-sonnet", "claude-3-opus", "claude-3-5-sonnet"];
    expect(extractModelIds(data)).toEqual(["claude-3-5-sonnet", "claude-3-opus"]);
  });

  test("handles empty or invalid inputs", () => {
    expect(extractModelIds(null)).toEqual([]);
    expect(extractModelIds({})).toEqual([]);
    expect(extractModelIds("invalid")).toEqual([]);
  });
});

describe("extractProbedModels", () => {
  test("pulls advertised reasoning efforts off OpenAI-compatible objects", () => {
    expect(
      extractProbedModels({
        data: [
          { id: "grok-4.6", reasoning_efforts: ["low", "high", "xhigh"] },
          { id: "gemini-flash", reasoning: { supported_efforts: ["low", "max"] } },
          { id: "plain" },
        ],
      }),
    ).toEqual({
      models: ["grok-4.6", "gemini-flash", "plain"],
      catalog: [
        { name: "grok-4.6", thinking_levels: ["low", "high", "xhigh"] },
        { name: "gemini-flash", thinking_levels: ["low", "max"] },
        { name: "plain", thinking_levels: [] },
      ],
    });
  });

  test("accepts a single thinking_level string and ignores junk tokens", () => {
    expect(
      extractProbedModels([{ id: "m", thinking_level: "max" }, { name: "n", thinking_levels: ["low", "??", "HIGH"] }]),
    ).toEqual({
      models: ["m", "n"],
      catalog: [
        { name: "m", thinking_levels: ["max"] },
        { name: "n", thinking_levels: ["low", "HIGH"] },
      ],
    });
  });
});

describe("probeEndpointModels", () => {
  test("queries /models with auth header and returns extracted models", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(
        JSON.stringify({
          data: [{ id: "model-a" }, { id: "model-b" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const models = await probeEndpointModels(
      "https://example.com/v1",
      "test-key",
      mockFetch as unknown as typeof fetch,
    );
    expect(capturedUrl).toBe("https://example.com/v1/models");
    expect(capturedAuth).toBe("Bearer test-key");
    expect(models).toEqual({
      models: ["model-a", "model-b"],
      catalog: [
        { name: "model-a", thinking_levels: [] },
        { name: "model-b", thinking_levels: [] },
      ],
    });
  });

  test("throws 401 when endpoint returns 401", async () => {
    const mockFetch = async () => new Response("Unauthorized", { status: 401 });
    expect(
      probeEndpointModels("https://example.com/v1", "bad-key", mockFetch as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 401 });
  });

  test("a try that runs out of time gets one more, and the second answer counts", async () => {
    let calls = 0;
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (calls === 1) return hangUntilAborted(init?.signal);
      return Response.json({ data: [{ id: "model-a" }] });
    };
    const probed = await probeEndpointModels(
      "https://example.com/v1",
      "key",
      mockFetch as unknown as typeof fetch,
      undefined,
      { timeoutMs: 20 },
    );
    expect(probed.models).toEqual(["model-a"]);
    expect(calls).toBe(2);
  });

  test("two silent tries say it did not answer in time, not that it could not connect", async () => {
    let calls = 0;
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      return hangUntilAborted(init?.signal);
    };
    const failed = probeEndpointModels(
      "https://example.com/v1",
      "key",
      mockFetch as unknown as typeof fetch,
      undefined,
      { timeoutMs: 20 },
    );
    await expect(failed).rejects.toMatchObject({
      status: 422,
      code: "probe_failed",
      message: "https://example.com/v1/models did not answer within 0.02s (tried 2 times)",
    });
    expect(calls).toBe(2);
  });

  test("a body that stalls after the headers is a timeout too, not an empty list", async () => {
    let calls = 0;
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":['));
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    };
    await expect(
      probeEndpointModels("https://example.com/v1", "key", mockFetch as unknown as typeof fetch, undefined, {
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "probe_failed", message: expect.stringContaining("did not answer within") });
    expect(calls).toBe(2);
  });

  test("a refused connection is reported once, without a retry", async () => {
    let calls = 0;
    const mockFetch = async () => {
      calls++;
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    };
    await expect(
      probeEndpointModels("https://example.com/v1", "key", mockFetch as unknown as typeof fetch, undefined, {
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "probe_failed", message: expect.stringMatching(/^Failed to connect to /) });
    expect(calls).toBe(1);
  });

  test("the caller hanging up is not retried or called a timeout", async () => {
    let calls = 0;
    const caller = new AbortController();
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      queueMicrotask(() => caller.abort());
      return hangUntilAborted(init?.signal);
    };
    await expect(
      probeEndpointModels("https://example.com/v1", "key", mockFetch as unknown as typeof fetch, caller.signal, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: "probe_failed", message: expect.stringMatching(/^Failed to connect to /) });
    expect(calls).toBe(1);
  });

  test("the guard runs before every fetch, the retry's included, and a throw stops the probe", async () => {
    const order: string[] = [];
    let allow = true;
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      order.push("fetch");
      allow = false;
      return hangUntilAborted(init?.signal);
    };
    const guard = () => {
      order.push("guard");
      if (!allow) throw new Error("revoked");
    };
    await expect(
      probeEndpointModels("https://example.com/v1", "key", mockFetch as unknown as typeof fetch, undefined, {
        timeoutMs: 20,
        guard,
      }),
    ).rejects.toThrow("revoked");
    expect(order).toEqual(["guard", "fetch", "guard"]);
  });
});

describe("probeEndpointModels: the Anthropic workspace", () => {
  const modelsBody = { data: [{ type: "model", id: "claude-opus-5-5" }], has_more: false };
  function recording(answer: (headers: Record<string, string>) => Response) {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const headers = { ...(init?.headers as Record<string, string>) };
      seen.push(headers);
      return answer(headers);
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  test("an Anthropic probe names the workspace, on the Bearer retry too", async () => {
    const { seen, fetchImpl } = recording((headers) => (headers["x-api-key"] ? new Response("{}", { status: 401 }) : Response.json(modelsBody)));
    await probeEndpointModels("https://api.anthropic.com", "sk-ant-usr-x", fetchImpl, undefined, { apiFormat: "anthropic", workspaceId: "wrkspc_01Test" });
    expect(seen).toHaveLength(2);
    expect(seen[0]!["x-api-key"]).toBe("sk-ant-usr-x");
    expect(seen[1]!.Authorization).toBe("Bearer sk-ant-usr-x");
    expect(seen.map((headers) => headers["anthropic-workspace-id"])).toEqual(["wrkspc_01Test", "wrkspc_01Test"]);
  });

  test("without a workspace no such header goes", async () => {
    const { seen, fetchImpl } = recording(() => Response.json(modelsBody));
    await probeEndpointModels("https://api.anthropic.com", "sk-ant", fetchImpl, undefined, { apiFormat: "anthropic", workspaceId: null });
    expect(seen[0]).not.toHaveProperty("anthropic-workspace-id");
  });

  test("an OpenAI-format probe never sends it", async () => {
    const { seen, fetchImpl } = recording(() => Response.json({ data: [{ id: "gpt-4o" }] }));
    await probeEndpointModels("https://api.openai.com/v1", "sk", fetchImpl, undefined, { apiFormat: "openai", workspaceId: "wrkspc_01Test" });
    expect(seen[0]).not.toHaveProperty("anthropic-workspace-id");
    expect(seen[0]!.Authorization).toBe("Bearer sk");
  });

  test("a refused probe says why, in the endpoint's own words", async () => {
    const message = "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.";
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } });
    const { fetchImpl } = recording(() => new Response(body, { status: 400 }));
    const err = await probeEndpointModels("https://api.anthropic.com", "sk-ant-usr-x", fetchImpl, undefined, { apiFormat: "anthropic" }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(`Endpoint returned 400: ${message}`);
    const unauthorized = recording(() => new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 }));
    const refused = await probeEndpointModels("https://api.openai.com/v1", "bad", unauthorized.fetchImpl).catch((e: unknown) => e);
    expect((refused as Error).message).toBe("Endpoint returned 401: Invalid API Key");
  });
});

describe("refusalText", () => {
  test("an Anthropic error comes back whole, past 150 characters", () => {
    const message = "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.";
    expect(message.length).toBeGreaterThan(150);
    expect(refusalText(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }))).toBe(message);
  });

  test("an OpenAI-style error", () => {
    expect(refusalText(JSON.stringify({ error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } }))).toBe("Invalid API Key");
  });

  test("a Bailian-style error", () => {
    expect(refusalText(JSON.stringify({ code: "InvalidApiKey", message: "Invalid API-key provided." }))).toBe("Invalid API-key provided.");
  });

  test("a body that is not JSON falls back to its first 150 code points", () => {
    const html = `<html><body>${"x".repeat(300)}</body></html>`;
    const text = refusalText(html);
    expect(text).toBe(`${html.slice(0, 150)}…`);
    expect(refusalText("Bad Gateway")).toBe("Bad Gateway");
  });

  test("a very long message is cut at 400 code points", () => {
    const text = refusalText(JSON.stringify({ error: { message: "y".repeat(500) } }));
    expect(text).toBe(`${"y".repeat(400)}…`);
  });
});

/** A fetch that never answers: it rejects only when its signal aborts, as a real one does. */
function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
