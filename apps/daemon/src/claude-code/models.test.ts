import { expect, test } from "bun:test";
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import { CLAUDE_MODELS_MAX_AGE_MS, createClaudeModelList, readModels, type ModelAnswer } from "./models";

const status = { path: "/usr/local/bin/claude", accounts: [] } as unknown as ClaudeCodeStatus;
const probe = { current: async () => status } as never;
const official: ModelAnswer = [
  { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", resolvedModel: "claude-opus-5-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", displayName: "Haiku 5.5", description: "Fastest", resolvedModel: "claude-haiku-5-5", supportsEffort: false },
  { value: "", displayName: "nameless" },
];

test("the list reads as Claude Code's own /model: its names, what each stands for and the thinking levels it takes", () => {
  expect(readModels(official)).toEqual([
    { value: "default", display_name: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", resolved_model: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { value: "haiku", display_name: "Haiku 5.5", description: "Fastest", resolved_model: "claude-haiku-5-5", efforts: [] },
  ]);
});

test("each account is asked once, the answer kept a while, and asks at the same time share one", async () => {
  let now = 1_000;
  const asked: Array<string | undefined> = [];
  const list = createClaudeModelList({
    claudeCode: probe,
    env: {},
    now: () => now,
    ask: async (launch) => {
      asked.push(launch.env.CLAUDE_CONFIG_DIR);
      return official;
    },
  });
  const [a, b] = await Promise.all([list.list(null), list.list(null)]);
  expect(a.models.map((m) => m.value)).toEqual(["default", "haiku"]);
  expect(b).toBe(a);
  await list.list("/Users/a/.claude-b");
  expect(asked).toEqual([undefined, "/Users/a/.claude-b"]);
  now += CLAUDE_MODELS_MAX_AGE_MS - 1;
  await list.list(null);
  expect(asked).toHaveLength(2);
  now += 2;
  await list.list(null);
  expect(asked).toHaveLength(3);
});

test("a failed ask says so, and keeps serving the list it had", async () => {
  let fail = false;
  let now = 0;
  const list = createClaudeModelList({ claudeCode: probe, env: {}, now: () => now, ask: async () => { if (fail) throw new Error("claude gave no models"); return official; } });
  expect((await list.list(null)).error).toBeNull();
  fail = true;
  now += CLAUDE_MODELS_MAX_AGE_MS + 1;
  const again = await list.list(null);
  expect(again.models).toHaveLength(2);
  expect(again.error).toBe("claude gave no models");
  const none = createClaudeModelList({ claudeCode: { current: async () => ({ ...status, path: null }) } as never, env: {}, ask: async () => official });
  expect(await none.list(null)).toMatchObject({ models: [], error: "claude_not_found" });
});
