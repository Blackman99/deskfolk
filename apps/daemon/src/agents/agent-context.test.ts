import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectContext, type ClaudeCodeStatus } from "@real-bot/protocol";
import { createClaudeContextWindowProbe } from "../claude-code/context-window";
import { lastContextUsage } from "../claude-code/model-usage";
import {
  acpContextUsage,
  carryContextLimit,
  claudeAssistantPromptTokens,
  claudeContextUsageField,
  claudeControlContextUsage,
  claudeControlContextWindow,
  claudeModelContextWindow,
  claudeResultContextWindow,
  codexContextUsage,
  sameModelBase,
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

    // Even before the first API response (totalTokens === 0), rawMaxTokens still yields the window size.
    expect(claudeControlContextUsage({
      model: "claude-opus-5-5",
      totalTokens: 0,
      rawMaxTokens: 1_000_000,
      maxTokens: 1_000_000,
    })).toBeNull();
    expect(claudeControlContextWindow({
      model: "claude-opus-5-5",
      totalTokens: 0,
      rawMaxTokens: 1_000_000,
      maxTokens: 1_000_000,
    })).toEqual({ limit: 1_000_000, model: "claude-opus-5-5" });
  });

  test("sameModelBase and carryContextLimit preserve limits across [1m] variants without crossing models", () => {
    expect(sameModelBase("claude-opus-4-6[1m]", "claude-opus-4-6")).toBe(true);
    expect(sameModelBase("claude-opus-4-6", "claude-sonnet-4-6")).toBe(false);
    expect(sameModelBase(null, "claude-opus-4-6")).toBe(false);

    expect(carryContextLimit(
      { used: 50_000, limit: 1_000_000, model: "claude-opus-4-6[1m]" },
      { used: 62_000, limit: null, model: "claude-opus-4-6" },
    )).toEqual({ used: 62_000, limit: 1_000_000, model: "claude-opus-4-6" });

    expect(carryContextLimit(
      { used: 50_000, limit: 1_000_000, model: "claude-opus-4-6" },
      { used: 12_000, limit: null, model: "claude-sonnet-4-6" },
    )).toEqual({ used: 12_000, limit: null, model: "claude-sonnet-4-6" });

    expect(carryContextLimit(
      { used: 50_000, limit: 200_000, model: "claude-opus-4-6" },
      { used: 62_000, limit: 1_000_000, model: "claude-opus-4-6[1m]" },
    )).toEqual({ used: 62_000, limit: 1_000_000, model: "claude-opus-4-6[1m]" });
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

      // Real Claude Code cost-state omits contextWindow; api-request's context-1m beta preserves [1m] for probing,
      // and a sidechain model's api-request does not shadow the main model's beta.
      const with1mBeta = join(dir, "with-1m-beta.jsonl");
      writeFileSync(with1mBeta, [
        JSON.stringify({ type: "api-request", params: { model: "claude-opus-4-6", betas: ["claude-code-20250219", "context-1m-2025-08-07"] } }),
        JSON.stringify({ type: "api-request", params: { model: "claude-haiku-4-5", betas: ["claude-code-20250219"] } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-6", usage: { input_tokens: 100, cache_read_input_tokens: 272_300 } } }),
        JSON.stringify({ type: "cost-state", modelUsage: { "claude-opus-4-6": { inputTokens: 100, outputTokens: 50, costUSD: 1.2 } } }),
      ].join("\n"));
      expect(lastContextUsage(with1mBeta)).toEqual({ used: 272_400, limit: null, model: "claude-opus-4-6[1m]" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createClaudeContextWindowProbe", () => {
  test("caches per account and model, deduplicates concurrent calls, and cools down failures", async () => {
    let clock = 1_000;
    let status = { path: "/usr/local/bin/claude", email: "a@example.com", accounts: [] } as unknown as ClaudeCodeStatus;
    const asked: string[] = [];
    let nextLimit: number | null = 1_000_000;
    let fail = false;
    const probe = createClaudeContextWindowProbe({
      claudeCode: { last: () => status, current: async () => status, detect: async () => status },
      now: () => clock,
      ask: async ({ model }) => {
        asked.push(model);
        if (fail) throw new Error("boom");
        return nextLimit;
      },
    });

    expect(probe.peek(null, "claude-opus-5-5")).toBeUndefined();
    const [first, second] = await Promise.all([
      probe.windowOf(null, "claude-opus-5-5"),
      probe.windowOf(null, "claude-opus-5-5"),
    ]);
    expect(first).toBe(1_000_000);
    expect(second).toBe(1_000_000);
    expect(asked).toEqual(["claude-opus-5-5"]);
    expect(probe.peek(null, "claude-opus-5-5")).toBe(1_000_000);

    // Account switch invalidates cache.
    status = { path: "/usr/local/bin/claude", email: "b@example.com", accounts: [] } as unknown as ClaudeCodeStatus;
    expect(probe.peek(null, "claude-opus-5-5")).toBeUndefined();
    nextLimit = 200_000;
    expect(await probe.windowOf(null, "claude-opus-5-5")).toBe(200_000);
    expect(asked).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);

    // Failures cool down briefly rather than spamming spawns or poisoning forever.
    fail = true;
    expect(await probe.windowOf(null, "claude-sonnet-5")).toBeNull();
    expect(probe.peek(null, "claude-sonnet-5")).toBeNull();
    expect(await probe.windowOf(null, "claude-sonnet-5")).toBeNull();
    expect(asked).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-sonnet-5"]);
    clock += 31_000;
    fail = false;
    nextLimit = 1_000_000;
    expect(await probe.windowOf(null, "claude-sonnet-5")).toBe(1_000_000);
    expect(asked).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5"]);
  });
});
