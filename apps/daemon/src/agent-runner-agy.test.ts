/**
 * A Bot run by your Antigravity `agy` in print mode (ADR 0079), end to end through the real engine
 * and store: a stand-in (`fixtures/agents/fake-agy.ts`) reads the prompts the driver writes to its
 * stdin and plays its steps back as NDJSON events — its words, its own tool calls, its failures.
 * Print mode gives the app no way in before a call, so what it did is checked as it is reported.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent } from "@real-bot/protocol";
import type { CompletionOk, JudgeResult } from "./completions";
import { agyDriver } from "./engine/agent/drivers/agy";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}
function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

const FAKE = join(import.meta.dir, "fixtures", "agents", "fake-agy.ts");

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

type Step = Record<string, unknown>;
type Entry = Record<string, unknown>;
type InputLine = { event: string; message: { role: string; content: Array<{ type: string; text?: string }> } };

async function harness(prompts: Step[][]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-agy-")));
  const logFile = join(root, ".fake-agy.log");
  const store = new Store({ endpointKey: memoryKeyStore() });
  const events: ClientEvent[] = [];
  const completedWaiters: Array<() => void> = [];
  const engine = createTurnEngine({
    store,
    settleQuietMs: 20,
    publish(event) {
      events.push(event);
      if (event.event === "turn.upsert" && event.status === "completed") for (const wake of completedWaiters.splice(0)) wake();
    },
    completions: {
      async complete() {
        return say("the hop loop ran");
      },
      async judge() {
        return judged("");
      },
    },
    agentDrivers: { antigravity: agyDriver() },
    async resolveAgent() {
      return {
        ok: true, executable: process.execPath, source: "known", args: [FAKE], proxy: null,
        env: { ...process.env as Record<string, string>, FAKE_AGY_SCRIPT: JSON.stringify({ prompts }), FAKE_AGY_LOG: logFile },
      };
    },
  });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
  });
  closes.push(async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bot = store.createBot({ name: "Coder", duties: "write code", boundaries: "stay in the workspace", runner: "antigravity" });
  const session = bot.direct_session.id;
  const completed = () => new Promise<void>((resolve) => completedWaiters.push(resolve));
  const post = async (body: string) => {
    const done = completed();
    const trigger = store.insertMessage({ sessionId: session, kind: "user", author: "user", body });
    await engine.handleInboundMessage(trigger, { fromUser: true });
    return done;
  };
  const lines = (kind: string) => store.db
    .query<{ body: string }, [string, string]>(`SELECT body FROM messages WHERE session_id = ? AND kind = ? ORDER BY created_at, rowid`)
    .all(session, kind).map((row) => row.body);
  const seen = (): Entry[] => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry) : []);
  const inputs = () => seen().flatMap((entry) => (entry.input ? [entry.input as InputLine] : []));
  /** What one input line says, all its text blocks together. */
  const textOf = (line: InputLine) => line.message.content.map((block) => block.text ?? "").join("\n");
  const failKind = () => store.db.query<{ fail_kind: string | null }, []>("SELECT fail_kind FROM notifications WHERE kind = 'failure'").get()?.fail_kind;
  const approvals = () => store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM approvals").get()!.n;
  const startedFrames = () => events
    .filter((event) => event.event === "turn.tool" && (event as { phase?: string }).phase === "started")
    .map((event) => (event as { name?: string }).name);
  return { store, engine, root, bot, session, events, post, lines, seen, inputs, textOf, failKind, approvals, startedFrames };
}

test("an Antigravity Bot's turn is its agy's: the reply is posted trimmed, agy runs sandboxed in print mode, and the app's instructions open the first line", async () => {
  const h = await harness([[{ say: "这是" }, { say: "答复。" }]]);
  await h.post("帮我看看这个项目");
  expect(h.lines("bot")).toEqual(["这是答复。"]);

  const launch = h.seen().find((entry) => entry.argv)!;
  const argv = launch.argv as string[];
  expect(argv).toContain("--sandbox");
  expect(argv).toContain("--print=");
  expect(argv).toContain("--disable-slash-commands");
  expect(argv.slice(argv.indexOf("--input-format"), argv.indexOf("--input-format") + 2)).toEqual(["--input-format", "stream-json"]);
  expect(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
  // The turn's work dir, with the workspace beside it.
  expect(String(launch.cwd).startsWith(join(h.root, "work"))).toBe(true);
  expect(argv[argv.indexOf("--add-dir") + 1]).toBe(h.root);

  const [first] = h.inputs();
  expect(first!.event).toBe("user");
  expect(first!.message.role).toBe("user");
  expect(h.textOf(first!)).toContain("这一轮由用户自己的 Antigravity 运行");
  expect(h.textOf(first!)).toContain("帮我看看这个项目");
  expect(h.inputs().length).toBe(1);

  const spend = h.store.db.query<{ provider_name: string; input_tokens: number; output_tokens: number; cached_tokens: number }, []>(
    "SELECT provider_name, input_tokens, output_tokens, cached_tokens FROM spend WHERE provider_name = 'Antigravity'").all();
  expect(spend).toEqual([{ provider_name: "Antigravity", input_tokens: 140, output_tokens: 25, cached_tokens: 40 }]);
  const route = h.store.db.query<{ reason_code: string | null }, []>("SELECT reason_code FROM turn_route_decisions").get();
  expect(route?.reason_code).toBe("agent_antigravity");
});

test("a view_file of a path inside the work dir is fine, and is the turn's read_file", async () => {
  const h = await harness([[{ tool: { name: "view_file", parameters: { AbsolutePath: "@CWD/notes.md" }, output: "第一版" } }, { say: "看完了 notes.md" }]]);
  await h.post("看看笔记");
  expect(h.lines("bot")).toEqual(["看完了 notes.md"]);
  expect(h.failKind()).toBeUndefined();
  expect(h.approvals()).toBe(0);
  expect(h.startedFrames()).toEqual(["read_file"]);
});

test("a run_command inside the work dir is fine, and is on the turn's record", async () => {
  const h = await harness([[{ tool: { name: "run_command", parameters: { CommandLine: "echo hi", Cwd: "@CWD" }, output: "hi\n" } }, { say: "跑完了" }]]);
  await h.post("跑一下");
  expect(h.lines("bot")).toEqual(["跑完了"]);
  expect(h.failKind()).toBeUndefined();
  const run = h.store.db.query<{ command: string; exit_code: number; ok: number }, []>("SELECT command, exit_code, ok FROM turn_runs").get();
  expect(run).toEqual({ command: "echo hi", exit_code: 0, ok: 1 });
  expect(h.startedFrames()).toEqual(["shell"]);
});

test("a run_command that reads outside the workspace stops the turn as unguarded", async () => {
  const h = await harness([[{ tool: { name: "run_command", parameters: { CommandLine: "cat ~/.ssh/known_hosts" }, output: "" } }, { say: "看完了" }]]);
  await h.post("看看 ssh");
  expect(h.lines("bot")).toEqual([]);
  expect(h.failKind()).toBe("agent_unguarded");
  expect(h.lines("system").join("\n")).toContain("Antigravity");
});

test("a view_file of another agent's credentials stops the turn too", async () => {
  const h = await harness([[{ tool: { name: "view_file", parameters: { AbsolutePath: join(homedir(), ".codex", "auth.json") }, output: "" } }, { say: "看完了" }]]);
  await h.post("看看");
  expect(h.lines("bot")).toEqual([]);
  expect(h.failKind()).toBe("agent_unguarded");
});

test("a write_to_file outside the workspace is not waited on: agy never asked, so the turn stops", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agent-outside-")));
  const h = await harness([[{ tool: { name: "write_to_file", parameters: { TargetFile: join(outside, "x.txt") }, output: "" } }, { say: "写了" }]]);
  await h.post("在外面写个文件");
  expect(h.lines("bot")).toEqual([]);
  expect(h.failKind()).toBe("agent_unguarded");
  expect(h.approvals()).toBe(0);
  rmSync(outside, { recursive: true, force: true });
});

test("a prompt that fails on the plan's quota fails the turn as the agent's limit", async () => {
  const h = await harness([[{ fail: "quota exceeded" }]]);
  await h.post("hi");
  expect(h.failKind()).toBe("agent_limit");
  expect(h.lines("system").join("\n")).toContain("Antigravity");
  expect(h.lines("bot")).toEqual([]);
});

test("the app's own tools are not offered: the first line says there are none, and the closing reply is all there is", async () => {
  const h = await harness([[{ say: "答复。" }]]);
  await h.post("hi");
  const text = h.textOf(h.inputs()[0]!);
  expect(text).toContain("拿不到 Deskfolk 的工具");
  // Nothing in the launch hands it an MCP server either.
  const argv = h.seen().find((entry) => entry.argv)!.argv as string[];
  expect(argv.some((arg) => /mcp/i.test(arg))).toBe(false);
  expect(h.lines("bot")).toEqual(["答复。"]);
});
