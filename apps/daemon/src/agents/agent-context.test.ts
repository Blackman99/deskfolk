import { describe, expect, test } from "bun:test";
import { parseProjectContext } from "@real-bot/protocol";
import { acpContextUsage, agentContextWindow, claudeAssistantPromptTokens, claudeResultContextWindow } from "./agent-context";
import { memoryKeyStore } from "../secrets";
import { Store } from "../store";

describe("parseProjectContext", () => {
  test("parses valid object and JSON string", () => {
    expect(parseProjectContext({ used: 42_000, limit: 200_000, model: "claude-opus-4-6" })).toEqual({
      used: 42_000,
      limit: 200_000,
      model: "claude-opus-4-6",
    });
    expect(parseProjectContext(JSON.stringify({ used: 12_345.6, limit: null }))).toEqual({
      used: 12_346,
      limit: null,
    });
  });

  test("rejects invalid payloads", () => {
    expect(parseProjectContext(null)).toBeNull();
    expect(parseProjectContext("not-json")).toBeNull();
    expect(parseProjectContext({ used: -1, limit: 200_000 })).toBeNull();
    expect(parseProjectContext({ used: 1000, limit: 0 })).toBeNull();
    expect(parseProjectContext({ used: "1000", limit: 200_000 })).toBeNull();
  });
});

describe("agentContextWindow", () => {
  test("returns known window sizes and null for unknown models", () => {
    expect(agentContextWindow("claude-opus-4-6")).toBe(200_000);
    expect(agentContextWindow("claude-sonnet-4-6[1m]")).toBe(1_000_000);
    expect(agentContextWindow("gemini-3.8-flash-high")).toBe(1_000_000);
    expect(agentContextWindow("gpt-5.6-terra")).toBe(400_000);
    expect(agentContextWindow("grok-4.7-build")).toBe(256_000);
    expect(agentContextWindow("grok-4.7-build-fast")).toBe(2_000_000);
    expect(agentContextWindow("custom-unknown-model")).toBeNull();
    expect(agentContextWindow(null)).toBeNull();
  });
});

describe("Claude and ACP context extractors", () => {
  test("sums uncached input, cache read, and cache creation tokens from assistant message", () => {
    expect(claudeAssistantPromptTokens({
      usage: { input_tokens: 1_200, cache_read_input_tokens: 45_000, cache_creation_input_tokens: 3_800 },
    })).toBe(50_000);
    expect(claudeAssistantPromptTokens({ usage: { input_tokens: 0 } })).toBeNull();
    expect(claudeAssistantPromptTokens(null)).toBeNull();
  });

  test("picks main model contextWindow from Claude result modelUsage", () => {
    const result = {
      modelUsage: {
        "claude-haiku-4-5": { contextWindow: 200_000 },
        "claude-opus-4-6[1m]": { contextWindow: 1_000_000 },
      },
    };
    expect(claudeResultContextWindow(result, "claude-opus-4-6[1m]")).toBe(1_000_000);
    expect(claudeResultContextWindow(result, "other")).toBe(200_000);
    expect(claudeResultContextWindow({}, null)).toBeNull();
  });

  test("extracts ACP usage_update with explicit size or model fallback", () => {
    expect(acpContextUsage({ sessionUpdate: "usage_update", used: 68_000, size: 1_000_000 }, "gemini-3.8-flash")).toEqual({
      used: 68_000,
      limit: 1_000_000,
      model: "gemini-3.8-flash",
    });
    expect(acpContextUsage({ sessionUpdate: "usage_update", used: 30_000 }, "grok-4.7")).toEqual({
      used: 30_000,
      limit: 256_000,
      model: "grok-4.7",
    });
    expect(acpContextUsage({ sessionUpdate: "usage_update", used: 0, size: 200_000 }, "claude-opus-4-6")).toBeNull();
  });
});

describe("Store.recordProjectContext", () => {
  test("persists, lists, and resets context usage on clear or startOver", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const created = store.createProjectSession({ dir: "/tmp/demo", agent: "claude_code", configDir: null, locale: "zh" });
      expect(created.project_context).toBeNull();

      store.recordProjectContext(created.id, { used: 64_000, limit: 200_000, model: "claude-opus-4-6" });
      expect(store.getSession(created.id).project_context).toEqual({ used: 64_000, limit: 200_000, model: "claude-opus-4-6" });
      expect(store.listSessions().find((s) => s.id === created.id)?.project_context).toEqual({ used: 64_000, limit: 200_000, model: "claude-opus-4-6" });
      expect(store.projectOf(created.id)?.context).toEqual({ used: 64_000, limit: 200_000, model: "claude-opus-4-6" });

      // startOver clears context usage (e.g. Codex /new)
      store.recordProjectAgentSession(created.id, null, true);
      expect(store.getSession(created.id).project_context).toBeNull();

      // clearSessionMessages clears context usage
      store.recordProjectContext(created.id, { used: 12_000, limit: 200_000 });
      expect(store.getSession(created.id).project_context).toEqual({ used: 12_000, limit: 200_000 });
      store.clearSessionMessages(created.id);
      expect(store.getSession(created.id).project_context).toBeNull();
    } finally {
      store.close();
    }
  });
});
