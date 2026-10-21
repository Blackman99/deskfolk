import { expect, test } from "bun:test";
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import { accountChoices } from "./project-agent-options.svelte.ts";

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
