import { describe, expect, test } from "bun:test";
import { extractModelIds, probeEndpointModels } from "./probe-models";

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
    expect(models).toEqual(["model-a", "model-b"]);
  });

  test("throws 401 when endpoint returns 401", async () => {
    const mockFetch = async () => new Response("Unauthorized", { status: 401 });
    expect(
      probeEndpointModels("https://example.com/v1", "bad-key", mockFetch as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 401 });
  });
});
