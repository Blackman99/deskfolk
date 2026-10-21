import { expect, test } from "bun:test";
import type { ClaudeCodeModel, ClaudeCodeStatus } from "@real-bot/protocol";
import { accountChoices, effortChoices, modelChoices, modelRowOf } from "./project-agent-options.svelte.ts";

const list: ClaudeCodeModel[] = [
  { value: "default", display_name: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", resolved_model: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", display_name: "Opus 5.5", description: "", resolved_model: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", display_name: "Haiku 5.5", description: "", resolved_model: "claude-haiku-5-5", efforts: [] },
];

test("the models are Claude Code's own, its default the session's no-pick, a model set elsewhere kept", () => {
  expect(modelChoices(list, "", "默认模型")).toEqual([
    { value: "", label: "Default (recommended)" }, { value: "opus", label: "Opus 5.5" }, { value: "haiku", label: "Haiku 5.5" },
  ]);
  expect(modelChoices(list, "claude-sonnet-4-5", "默认模型").at(-1)).toEqual({ value: "claude-sonnet-4-5", label: "claude-sonnet-4-5" });
  // Before the list comes: Claude Code's aliases.
  expect(modelChoices(null, "", "默认模型").map((c) => c.value)).toEqual(["", "sonnet", "opus", "haiku", "fable"]);
});

test("the thinking levels are the picked model's, all of them until the list says", () => {
  expect(effortChoices(list, "")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(effortChoices(list, "haiku")).toEqual([]);
  expect(effortChoices(null, "haiku")).toHaveLength(5);
  // A full id is the row it resolves from.
  expect(modelRowOf(list, "claude-haiku-5-5")?.value).toBe("haiku");
});

test("accounts read by their email, this computer's own first", () => {
  const status = { email: "me@a.com", accounts: [
    { config_dir: null, email: "me@a.com" }, { config_dir: "/Users/a/.claude-b", email: "team@b.com" }, { config_dir: "/Users/a/.claude-c", email: null },
  ] } as unknown as ClaudeCodeStatus;
  expect(accountChoices(status, "", "默认账号")).toEqual([
    { value: "", label: "me@a.com" }, { value: "/Users/a/.claude-b", label: "team@b.com" }, { value: "/Users/a/.claude-c", label: "/Users/a/.claude-c" },
  ]);
  expect(accountChoices(null, "", "默认账号")).toEqual([{ value: "", label: "默认账号" }]);
  expect(accountChoices(null, "/gone", "默认账号").map((c) => c.value)).toEqual(["", "/gone"]);
});
