import { expect, test } from "bun:test";
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import { CLAUDE_COMMANDS_MAX_AGE_MS, createClaudeCommandList, readCommands, type CommandAnswer } from "./commands";

const status = { path: "/usr/local/bin/claude", accounts: [] } as unknown as ClaudeCodeStatus;
const probe = { current: async () => status } as never;
// As Claude Code 2.1.307 answered `supportedCommands` (abridged): skills first, then its own.
const answered: CommandAnswer = [
  { name: "pdf", description: "Use this skill whenever the user wants to do anything with PDF files. (user)", argumentHint: "" },
  { name: "frontend-design:frontend-design", description: "(frontend-design) Guidance for distinctive visual design", argumentHint: "", aliases: ["frontend-design"] },
  { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "<optional custom summarization instructions>" },
  { name: "clear", description: "Clear conversation history and free up context", argumentHint: "", aliases: ["reset", "new"] },
  { name: "model", description: "Set the AI model for Claude Code", argumentHint: "[model]" },
  { name: "effort", description: "Set effort level", argumentHint: "" },
  { name: "rename", description: "Rename the current conversation", argumentHint: "" },
  { name: "doctor", description: "Diagnose and verify your Claude Code installation", argumentHint: "" },
  { name: "__remote-workflow", description: "", argumentHint: "" },
  { name: "compact", description: "a second row of the same name", argumentHint: "" },
  { name: "", description: "nameless" },
];

test("the list reads as Claude Code's own /: each name once, without the terminal's, the picker's and its internal ones", () => {
  expect(readCommands(answered)).toEqual([
    { name: "clear", description: "Clear conversation history and free up context", argument_hint: "", aliases: ["reset", "new"] },
    { name: "compact", description: "Clear conversation history but keep a summary in context", argument_hint: "<optional custom summarization instructions>", aliases: [] },
    { name: "frontend-design:frontend-design", description: "(frontend-design) Guidance for distinctive visual design", argument_hint: "", aliases: ["frontend-design"] },
    { name: "pdf", description: "Use this skill whenever the user wants to do anything with PDF files. (user)", argument_hint: "", aliases: [] },
  ]);
});

test("each account and directory is asked once, in that directory, the answer kept a while", async () => {
  let now = 1_000;
  const asked: Array<[string | undefined, string]> = [];
  const list = createClaudeCommandList({
    claudeCode: probe,
    env: {},
    now: () => now,
    ask: async (launch) => {
      asked.push([launch.env.CLAUDE_CONFIG_DIR, launch.cwd]);
      return answered;
    },
  });
  const [a, b] = await Promise.all([list.list(null, "/work/app"), list.list(null, "/work/app")]);
  expect(a.commands.map((command) => command.name)).toContain("compact");
  expect(b).toBe(a);
  await list.list(null, "/work/other");
  await list.list("/Users/a/.claude-b", "/work/app");
  expect(asked).toEqual([[undefined, "/work/app"], [undefined, "/work/other"], ["/Users/a/.claude-b", "/work/app"]]);
  now += CLAUDE_COMMANDS_MAX_AGE_MS + 1;
  await list.list(null, "/work/app");
  expect(asked).toHaveLength(4);
});

test("a failed ask says so, and keeps serving the list it had", async () => {
  let fail = false;
  let now = 0;
  const list = createClaudeCommandList({ claudeCode: probe, env: {}, now: () => now, ask: async () => { if (fail) throw new Error("claude gave no commands"); return answered; } });
  expect((await list.list(null, "/work/app")).error).toBeNull();
  fail = true;
  now += CLAUDE_COMMANDS_MAX_AGE_MS + 1;
  const again = await list.list(null, "/work/app");
  expect(again.commands).toHaveLength(4);
  expect(again.error).toBe("claude gave no commands");
  const none = createClaudeCommandList({ claudeCode: { current: async () => ({ ...status, path: null }) } as never, env: {}, ask: async () => answered });
  expect(await none.list(null, "/work/app")).toMatchObject({ commands: [], error: "claude_not_found" });
});
