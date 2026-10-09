/** One reading through the user's Claude Code: its options, its two places, and what it says when it cannot. Never a real `claude`. */
import { expect, test } from "bun:test";
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeCodeProbe } from "./probe";
import { createClaudeJudge, type ReadingQuery } from "./reading";

const own = { logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: null };
const status: ClaudeCodeStatus = {
  path: "/u/claude", source: "path", version: "2.1.294", sdk_version: "2.1.289", outdated: false, ...own, base_url_set: false,
  proxy: "http://127.0.0.1:12334", proxy_source: "system", checked_at: "2026-10-08T00:00:00.000Z", error: null,
  accounts: [
    { config_dir: null, config_directory: null, ...own, error: null, login_command: "claude auth login" },
    { config_dir: "/opt/claude-b", config_directory: "/opt/claude-b", logged_in: false, auth_method: "none", subscription_type: null, email: null, error: null, login_command: "x" },
  ],
};
const probeOf = (value: ClaudeCodeStatus | null): ClaudeCodeProbe => ({ last: () => value, current: async () => value!, detect: async () => value! });

const success = (result: string): SDKMessage => ({
  type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.0004,
  usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
} as unknown as SDKMessage);

function fakeQuery(messages: (options: Options) => SDKMessage[] | Promise<SDKMessage[]>, seen: Array<{ prompt: string; options: Options }> = []): ReadingQuery {
  return ({ prompt, options }) => {
    seen.push({ prompt, options });
    return {
      close() {},
      async *[Symbol.asyncIterator]() {
        for (const message of await messages(options)) yield message;
      },
    };
  };
}

const target = { kind: "claude_code" as const, model: "haiku", configDir: null };
const asked = { target, system: "SYSTEM", prompt: '{"said":"停"}', signal: new AbortController().signal };

test("a reading is one tool-less call on the account and model chosen, with the prompt as the system prompt", async () => {
  const seen: Array<{ prompt: string; options: Options }> = [];
  const judge = createClaudeJudge({ claudeCode: probeOf(status), query: fakeQuery(() => [success("ANSWER")], seen) });
  expect(await judge(asked)).toEqual({ content: "ANSWER", usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 100, costUsd: 0.0004 }, fail: null });
  const { prompt, options } = seen[0]!;
  expect(prompt).toBe('{"said":"停"}');
  expect(options).toMatchObject({
    pathToClaudeCodeExecutable: "/u/claude", model: "haiku", settingSources: [], strictMcpConfig: true, persistSession: false,
    tools: [], systemPrompt: "SYSTEM", maxTurns: 1, permissionMode: "default",
  });
  expect(options.cwd).toBe(require("node:os").tmpdir());
  expect(options.env!.HTTPS_PROXY).toBe("http://127.0.0.1:12334");
  expect(options.env!.CLAUDE_AGENT_SDK_CLIENT_APP).toStartWith("deskfolk/");
  expect(options.abortController).toBeInstanceOf(AbortController);

  // On a listed account: Claude Code is told which directory is its own.
  const signedIn = { ...status, accounts: status.accounts!.map((account) => ({ ...account, logged_in: true })) };
  await createClaudeJudge({ claudeCode: probeOf(signedIn), query: fakeQuery(() => [success("A")], seen) })({ ...asked, target: { ...target, configDir: "/opt/claude-b" } });
  expect(seen[1]!.options.env!.CLAUDE_CONFIG_DIR).toBe("/opt/claude-b");
});

test("Claude Code missing, or the account signed out, is claude_unavailable without running claude; an error result is claude_failed", async () => {
  const seen: Array<{ prompt: string; options: Options }> = [];
  const query = fakeQuery(() => [success("A")], seen);
  expect((await createClaudeJudge({ claudeCode: undefined, query })(asked)).fail).toBe("claude_unavailable");
  expect((await createClaudeJudge({ claudeCode: probeOf({ ...status, path: null }), query })(asked)).fail).toBe("claude_unavailable");
  expect((await createClaudeJudge({ claudeCode: probeOf(status), query })({ ...asked, target: { ...target, configDir: "/opt/claude-b" } })).fail).toBe("claude_unavailable");
  expect(seen).toEqual([]);

  const errored = fakeQuery(() => [{ type: "result", subtype: "error_during_execution", is_error: true, usage: { input_tokens: 5, output_tokens: 0 }, total_cost_usd: 0 } as unknown as SDKMessage]);
  expect(await createClaudeJudge({ claudeCode: probeOf(status), query: errored })(asked)).toMatchObject({ content: null, fail: "claude_failed" });
  const none = fakeQuery(() => []);
  expect(await createClaudeJudge({ claudeCode: probeOf(status), query: none })(asked)).toEqual({ content: null, usage: null, fail: "claude_failed" });
  const throws = fakeQuery(() => { throw new Error("spawn failed"); });
  expect((await createClaudeJudge({ claudeCode: probeOf(status), query: throws })(asked)).fail).toBe("claude_failed");
});

test("only two readings run at once, a third waits for a place, and one given up while it waits never runs", async () => {
  let running = 0;
  let peak = 0;
  const gates: Array<() => void> = [];
  const query = fakeQuery(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise<void>((resolve) => gates.push(resolve));
    running -= 1;
    return [success("A")];
  });
  const judge = createClaudeJudge({ claudeCode: probeOf(status), query });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const first = judge(asked);
  const second = judge(asked);
  const giveUp = new AbortController();
  const third = judge({ ...asked, signal: giveUp.signal });
  const fourth = judge(asked);
  await tick();
  expect(running).toBe(2);
  giveUp.abort();
  expect((await third).fail).toBe("claude_failed");
  gates.shift()!();
  await first;
  await tick();
  // The fourth took the place the first left; the given-up one took none.
  expect(running).toBe(2);
  while (gates.length) gates.shift()!();
  await Promise.all([second, fourth]);
  expect(peak).toBe(2);
});

test("a reading given up while it runs is aborted", async () => {
  let aborted = false;
  const query: ReadingQuery = ({ options }) => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => options.abortController!.signal.addEventListener("abort", () => { aborted = true; resolve(); }));
      throw new Error("aborted");
    },
  });
  const stop = new AbortController();
  const pending = createClaudeJudge({ claudeCode: probeOf(status), query })({ ...asked, signal: stop.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  stop.abort();
  expect((await pending).fail).toBe("claude_failed");
  expect(aborted).toBe(true);
});
