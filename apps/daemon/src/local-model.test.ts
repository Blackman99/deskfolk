import { describe, expect, test } from "bun:test";
import {
  CUT_BYTES_PER_TOKEN,
  MIN_CHECKED_BYTES,
  ThinkStrip,
  estimateTokens,
  nextBytesPerToken,
  overWindow,
  promptBytes,
  promptWasCut,
  readLlamaCppProps,
  readLmStudioModels,
  readLocalModels,
  readOllamaLoaded,
  readOllamaTags,
  serverRoot,
  stripLeadingThink,
} from "./local-model";

describe("promptBytes", () => {
  test("counts text, tool calls and tool definitions, not pictures", () => {
    const tools = [{ type: "function", function: { name: "ping", parameters: { type: "object" } } }];
    const bytes = promptBytes(
      [
        { role: "system", content: "你好" },
        { role: "user", content: [{ type: "text", text: "abc" }, { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(50_000)}` } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", name: "ping", arguments: "{}" }] },
        { role: "tool", tool_call_id: "c1", content: "pong" },
      ],
      tools,
    );
    expect(bytes).toBe(6 + 3 + "ping{}".length + 4 + JSON.stringify(tools).length);
  });
});

describe("cut detection", () => {
  // The measured requests of 2026-10-08 (Ollama 0.40, qwen3:8b, window 32,768).
  test("Ollama's cut prompts read as cut, whole ones do not", () => {
    expect(promptWasCut(165_868, 16_386, undefined)).toBe(true);
    expect(promptWasCut(113_788, 16_386, undefined)).toBe(true);
    expect(promptWasCut(106_228, 31_377, undefined)).toBe(false);
    expect(promptWasCut(65_468, 19_037, undefined)).toBe(false);
  });

  test("a calibrated model catches a cut the fixed rule would miss", () => {
    // A model reading Chinese-heavy prompts at 3 bytes a token, cut to half: 6 bytes a token.
    expect(promptWasCut(120_000, 20_000, undefined)).toBe(false);
    expect(promptWasCut(120_000, 20_000, 3)).toBe(true);
    expect(promptWasCut(120_000, 36_000, 3)).toBe(false);
  });

  test("small requests and missing usage are never judged", () => {
    expect(promptWasCut(MIN_CHECKED_BYTES - 1, 10, undefined)).toBe(false);
    expect(promptWasCut(200_000, null, undefined)).toBe(false);
    expect(promptWasCut(200_000, 0, 3)).toBe(false);
  });

  test("calibration folds readings in and ignores impossible ones", () => {
    expect(nextBytesPerToken(undefined, 34_000, 10_000)).toBe(3.4);
    expect(nextBytesPerToken(3.4, 40_000, 10_000)).toBeCloseTo(3.58, 5);
    expect(nextBytesPerToken(3.4, 100_000, 10_000)).toBe(3.4);
    expect(nextBytesPerToken(3.4, 1_000, 100)).toBe(3.4);
    expect(CUT_BYTES_PER_TOKEN).toBeGreaterThan(5);
  });

  test("a request is refused unsent only when clearly over a known window", () => {
    expect(estimateTokens(40_000, undefined)).toBe(10_000);
    expect(overWindow(150_000, 3.4, 32_768)).toBe(true);
    expect(overWindow(106_228, 3.4, 32_768)).toBe(false);
    expect(overWindow(150_000, 3.4, undefined)).toBe(false);
  });
});

describe("ThinkStrip", () => {
  const run = (chunks: string[]) => {
    const strip = new ThinkStrip();
    let streamed = "";
    for (const chunk of chunks) streamed += strip.feed(chunk);
    return { streamed, final: strip.finish(streamed) };
  };

  test("a leading block is dropped even when its tags arrive in pieces", () => {
    expect(run(["<th", "ink>\nplan it", " out</thi", "nk>\n\nThe answer."])).toEqual({ streamed: "The answer.", final: "The answer." });
    expect(run(["\n<think>", "</think>", "\n\nOK"])).toEqual({ streamed: "OK", final: "OK" });
  });

  test("a reply that does not start with the tag is left alone", () => {
    expect(run(["Use ", "<think> tags like this."])).toEqual({ streamed: "Use <think> tags like this.", final: "Use <think> tags like this." });
    expect(run(["<", "b>bold</b>"])).toEqual({ streamed: "<b>bold</b>", final: "<b>bold</b>" });
  });

  test("an unclosed block is all thinking; a lone close tag ends one", () => {
    expect(run(["<think>still going"])).toEqual({ streamed: "", final: "" });
    expect(run(["reasoning here", "</think>\n", "Done."]).final).toBe("Done.");
  });

  test("stripLeadingThink does the same on a whole reply", () => {
    expect(stripLeadingThink("<think>x</think>\n{\"kind\":\"task\"}")).toBe("{\"kind\":\"task\"}");
    expect(stripLeadingThink("x</think>{}")).toBe("{}");
    expect(stripLeadingThink("<think>never closed")).toBe("");
    expect(stripLeadingThink("{\"a\":1}")).toBe("{\"a\":1}");
  });
});

describe("local server facts", () => {
  test("serverRoot drops the Chat Completions path", () => {
    expect(serverRoot("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(serverRoot("http://localhost:1234/v1/")).toBe("http://localhost:1234");
    expect(serverRoot("http://10.0.0.2:8080")).toBe("http://10.0.0.2:8080");
  });

  test("Ollama tags and loaded windows", () => {
    const tags = readOllamaTags({
      models: [
        { name: "qwen3:8b", details: { context_length: 40960 }, capabilities: ["completion", "tools", "thinking"] },
        { name: "llava:7b", details: { context_length: 4096 }, capabilities: ["completion", "vision"] },
        { name: "old:1b", details: {} },
      ],
    });
    expect(tags.get("qwen3:8b")).toEqual({ context_window: 40960, input_image: false, tools: true });
    expect(tags.get("llava:7b")).toEqual({ context_window: 4096, input_image: true, tools: false });
    expect(tags.get("old:1b")).toEqual({});
    expect(readOllamaLoaded({ models: [{ name: "qwen3:8b", context_length: 32768 }] })).toEqual(new Map([["qwen3:8b", 32768]]));
    expect(readOllamaLoaded(null).size).toBe(0);
  });

  test("LM Studio and llama.cpp answers", () => {
    const lm = readLmStudioModels({
      data: [
        { id: "qwen2-vl", type: "vlm", max_context_length: 32768 },
        { id: "qwen3-30b", type: "llm", max_context_length: 262144, loaded_context_length: 65536, capabilities: ["tool_use"] },
        { id: "nomic-embed", type: "embeddings", max_context_length: 2048 },
      ],
    });
    expect(lm.get("qwen2-vl")).toEqual({ context_window: 32768, input_image: true });
    expect(lm.get("qwen3-30b")).toEqual({ context_window: 65536, input_image: false, tools: true });
    expect(lm.has("nomic-embed")).toBe(false);
    expect(readLlamaCppProps({ default_generation_settings: { n_ctx: 8192 }, modalities: { vision: false } })).toEqual({ context_window: 8192, input_image: false });
    expect(readLlamaCppProps({ models: [] })).toBeNull();
  });

  test("readLocalModels asks Ollama first: loaded windows, then a Modelfile's num_ctx, then the limit", async () => {
    const asked: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      asked.push(init?.body ? `${url} ${init.body}` : url);
      if (url.endsWith("/api/tags")) {
        return Response.json({ models: [
          { name: "qwen3:8b", details: { context_length: 40960 }, capabilities: ["tools"] },
          { name: "qwen3-8k:latest", details: { context_length: 40960 }, capabilities: ["tools"] },
          { name: "gpt-oss:20b", details: { context_length: 131072 }, capabilities: ["tools"] },
        ] });
      }
      if (url.endsWith("/api/ps")) return Response.json({ models: [{ name: "qwen3:8b", context_length: 32768 }] });
      if (url.endsWith("/api/show")) {
        const name = JSON.parse(String(init?.body)).model;
        return Response.json({ parameters: name === "qwen3-8k:latest" ? "num_ctx                        8192\ntemperature 0.6" : "temperature 1" });
      }
      return new Response("no", { status: 404 });
    };
    const facts = await readLocalModels(fetchImpl, "http://localhost:11434/v1", ["qwen3:8b", "qwen3-8k:latest", "gpt-oss:20b"]);
    expect(facts.get("qwen3:8b")).toEqual({ context_window: 32768, input_image: false, tools: true });
    expect(facts.get("qwen3-8k:latest")?.context_window).toBe(8192);
    expect(facts.get("gpt-oss:20b")?.context_window).toBe(131072);
    expect(asked.slice(0, 2)).toEqual(["http://localhost:11434/api/tags", "http://localhost:11434/api/ps"]);
    expect(asked.slice(2).sort()).toEqual([
      'http://localhost:11434/api/show {"model":"gpt-oss:20b"}',
      'http://localhost:11434/api/show {"model":"qwen3-8k:latest"}',
    ]);
  });

  test("readLocalModels falls through to llama.cpp, and to nothing", async () => {
    const llama = async (url: string) =>
      url.endsWith("/props") ? Response.json({ default_generation_settings: { n_ctx: 4096 } }) : new Response("", { status: 404 });
    expect((await readLocalModels(llama, "http://127.0.0.1:8080/v1", ["any"])).get("any")).toEqual({ context_window: 4096 });
    const down = async () => {
      throw new TypeError("connection refused");
    };
    expect((await readLocalModels(down, "http://127.0.0.1:9/v1", ["x"])).size).toBe(0);
  });
});
