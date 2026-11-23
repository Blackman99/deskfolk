import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectContext } from "@real-bot/protocol";
import { lastContextUsage } from "../claude-code/model-usage";
import {
  acpContextUsage,
  claudeAssistantPromptTokens,
  claudeContextUsageField,
  claudeControlContextUsage,
  claudeModelContextWindow,
  claudeResultContextWindow,
  codexContextUsage,
} from "./agent-context";
import { memoryKeyStore } from "../secrets";
import { Store } from "../store";

describe("parseProjectContext", () => {
  test("parses valid object and JSON string", () => {
    expect(parseProjectContext({ used: 42_000, limit: 1_000_000, model: "claude-opus-4-7" })).toEqual({
      used: 42_000,
      limit: 1_000_000,
      model: "claude-opus-4-7",
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

describe("Claude context extractors", () => {
  test("sums uncached input, cache read, and cache creation tokens from assistant message", () => {
    expect(claudeAssistantPromptTokens({
      usage: { input_tokens: 1_200, cache_read_input_tokens: 45_000, cache_creation_input_tokens: 3_800 },
    })).toBe(50_000);
    expect(claudeAssistantPromptTokens({ usage: { input_tokens: 0 } })).toBeNull();
    expect(claudeAssistantPromptTokens(null)).toBeNull();
  });

  test("matches main model contextWindow without falling back to a subagent model", () => {
    const result = {
      modelUsage: {
        "claude-haiku-4-5": { contextWindow: 200_000 },
        "claude-opus-4-6[1m]": { contextWindow: 1_000_000, canonicalModel: "claude-opus-4-6" },
      },
    };
    // Exact match
    expect(claudeResultContextWindow(result, "claude-opus-4-6[1m]")).toBe(1_000_000);
    // API message.model omits [1m] suffix: matches via canonicalModel / base name, never Haiku's 200k
    expect(claudeResultContextWindow(result, "claude-opus-4-6")).toBe(1_000_000);
    // Unmatched model in multi-model usage returns null rather than guessing another model's window
    expect(claudeResultContextWindow(result, "claude-sonnet-4-6")).toBeNull();
    // Single-entry usage falls back safely
    expect(claudeModelContextWindow({ "claude-opus-4-7": { contextWindow: 1_000_000 } }, null)).toBe(1_000_000);
    expect(claudeResultContextWindow({}, null)).toBeNull();
  });

  test("extracts structured context_usage from /context messages and getContextUsage summary", () => {
    expect(claudeContextUsageField({
      context_usage: { model: "claude-opus-4-7", total_tokens: 145_000, raw_max_tokens: 1_000_000 },
    })).toEqual({ used: 145_000, limit: 1_000_000, model: "claude-opus-4-7" });

    expect(claudeControlContextUsage({
      model: "claude-opus-4-7",
      totalTokens: 162_400,
      rawMaxTokens: 1_000_000,
      maxTokens: 950_000,
    })).toEqual({ used: 162_400, limit: 1_000_000, model: "claude-opus-4-7" });
  });
});

describe("Codex and ACP context extractors", () => {
  test("reads Codex last.totalTokens and modelContextWindow without guessing when window is omitted", () => {
    expect(codexContextUsage({
      last: { inputTokens: 28_000, outputTokens: 1_200, totalTokens: 29_200 },
      modelContextWindow: 272_000,
    }, "gpt-5.6-terra")).toEqual({ used: 29_200, limit: 272_000, model: "gpt-5.6-terra" });

    expect(codexContextUsage({
      last: { inputTokens: 18_000 },
    }, "gpt-5.6-terra")).toEqual({ used: 18_000, limit: null, model: "gpt-5.6-terra" });
  });

  test("extracts ACP usage_update strictly from reported used and size without guessing", () => {
    expect(acpContextUsage({ sessionUpdate: "usage_update", used: 68_000, size: 1_000_000 }, "gemini-3.8-flash")).toEqual({
      used: 68_000,
      limit: 1_000_000,
      model: "gemini-3.8-flash",
    });
    expect(acpContextUsage({ sessionUpdate: "usage_update", used: 30_000 }, "grok-4.7")).toEqual({
      used: 30_000,
      limit: null,
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

      store.recordProjectContext(created.id, { used: 64_000, limit: 1_000_000, model: "claude-opus-4-7" });
      expect(store.getSession(created.id).project_context).toEqual({ used: 64_000, limit: 1_000_000, model: "claude-opus-4-7" });
      expect(store.listSessions().find((s) => s.id === created.id)?.project_context).toEqual({ used: 64_000, limit: 1_000_000, model: "claude-opus-4-7" });
      expect(store.projectOf(created.id)?.context).toEqual({ used: 64_000, limit: 1_000_000, model: "claude-opus-4-7" });

      // startOver clears context usage (e.g. Codex /new)
      store.recordProjectAgentSession(created.id, null, true);
      expect(store.getSession(created.id).project_context).toBeNull();

      // clearSessionMessages clears context usage
      store.recordProjectContext(created.id, { used: 12_000, limit: null });
      expect(store.getSession(created.id).project_context).toEqual({ used: 12_000, limit: null });
      store.clearSessionMessages(created.id);
      expect(store.getSession(created.id).project_context).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("lastContextUsage", () => {
  test("reads latest non-sidechain assistant prompt usage and reported cost-state contextWindow", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-jsonl-"));
    try {
      const withCost = join(dir, "with-cost.jsonl");
      writeFileSync(withCost, [
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-6", usage: { input_tokens: 1000, cache_read_input_tokens: 19_000 } } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-6", usage: { input_tokens: 2000, cache_read_input_tokens: 48_000, cache_creation_input_tokens: 5_000 } } }),
        JSON.stringify({ type: "assistant", isSidechain: true, message: { model: "claude-haiku-4-5", usage: { input_tokens: 500 } } }),
        JSON.stringify({
          type: "cost-state",
          modelUsage: {
            "claude-haiku-4-5": { contextWindow: 200_000 },
            "claude-opus-4-6[1m]": { contextWindow: 1_000_000 },
          },
        }),
      ].join("\n"));
      expect(lastContextUsage(withCost)).toEqual({ used: 55_000, limit: 1_000_000, model: "claude-opus-4-6" });

      // Without cost-state contextWindow, limit stays null (never guessed as 200k)
      const withoutCost = join(dir, "without-cost.jsonl");
      writeFileSync(withoutCost, JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-4-7", usage: { input_tokens: 2000, cache_read_input_tokens: 248_000 } },
      }));
      expect(lastContextUsage(withoutCost)).toEqual({ used: 250_000, limit: null, model: "claude-opus-4-7" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
