/**
 * A Bot run by your Codex (ADR 0079), end to end through the real engine and store: a stand-in
 * app-server (`fixtures/agents/fake-codex.ts`) plays a script against the Codex driver — its
 * commands and file changes asking for approval, its dynamic tools, its usage and its failures —
 * and logs what the driver sent and answered for the test to read.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent } from "@real-bot/protocol";
import type { CompletionOk, JudgeResult } from "./completions";
import { codexDriver } from "./engine/agent/drivers/codex";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}
function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

const FAKE = join(import.meta.dir, "fixtures", "agents", "fake-codex.ts");

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

type Step = Record<string, unknown>;
type Script = { signedOut?: boolean; model?: string; mcpServers?: Array<{ name: string; pluginId?: string }>; rejectMcp?: string[]; turns: Step[][] };
type Entry = Record<string, unknown>;

async function harness(script: Script) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-codex-")));
  const logFile = join(root, ".fake-codex.log");
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
    agentDrivers: { codex: codexDriver() },
    async resolveAgent() {
      return {
        ok: true, executable: process.execPath, source: "known", args: [FAKE], proxy: null,
        env: { ...process.env as Record<string, string>, FAKE_CODEX_SCRIPT: JSON.stringify(script), FAKE_CODEX_LOG: logFile },
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
  const bot = store.createBot({ name: "Coder", duties: "write code", boundaries: "stay in the workspace", runner: "codex" });
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
  const request = (method: string) => seen().filter((entry) => entry.method === method).map((entry) => entry.params as Record<string, any>);
  /** Waits until the stand-in has logged something, instead of sleeping for it. */
  const until = async (found: () => boolean) => {
    for (let i = 0; i < 200 && !found(); i++) await Bun.sleep(20);
    return found();
  };
  const pendingApproval = async () => {
    for (let i = 0; i < 200; i++) {
      const row = store.db.query<{ id: string; kind_key: string; summary: string }, []>("SELECT id, kind_key, summary FROM approvals WHERE status = 'pending'").get();
      if (row) return row;
      await Bun.sleep(20);
    }
    return null;
  };
  /** A card, or null once the turn is over without raising one. */
  const cardOrEnd = async (done: Promise<void>) => {
    let ended = false;
    void done.then(() => { ended = true; });
    for (let i = 0; i < 200 && !ended; i++) {
      const row = store.db.query<{ id: string; kind_key: string; summary: string }, []>("SELECT id, kind_key, summary FROM approvals WHERE status = 'pending'").get();
      if (row) return row;
      await Bun.sleep(20);
    }
    return null;
  };
  const failKind = () => store.db.query<{ fail_kind: string | null }, []>("SELECT fail_kind FROM notifications WHERE kind = 'failure'").get()?.fail_kind;
  const approvals = () => store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM approvals").get()!.n;
  const startedTargets = () => events
    .filter((event) => event.event === "turn.tool" && (event as { phase?: string }).phase === "started")
    .map((event) => (event as { target?: string }).target);
  const startedFrames = () => events
    .filter((event) => event.event === "turn.tool" && (event as { phase?: string }).phase === "started")
    .map((event) => (event as { name?: string }).name);
  return { store, engine, root, bot, session, events, post, lines, seen, request, until, pendingApproval, cardOrEnd, failKind, approvals, startedFrames, startedTargets };
}

test("a Codex Bot's turn is its Codex's: the reply is posted, the thread is private and read-only, and the route and spend say which agent", async () => {
  const h = await harness({ model: "gpt-fake-1", turns: [[{ say: "这是" }, { usage: { input: 1200, output: 80, cached: 1000 } }, { say: "答复。" }]] });
  await h.post("帮我看看这个项目");
  expect(h.lines("bot")).toEqual(["这是答复。"]);

  expect(h.request("initialize")[0]!.clientInfo).toMatchObject({ name: "deskfolk" });
  const thread = h.request("thread/start");
  expect(thread.length).toBe(1);
  const started = thread[0]!;
  // Every command and file change asks the app first; nothing outlives the turn; nothing of yours joins it.
  expect(started.approvalPolicy).toBe("untrusted");
  expect(started.sandbox).toBe("read-only");
  expect(started.ephemeral).toBe(true);
  expect(started.config.features.hooks).toBe(false);
  expect(started.config.notify).toEqual([]);
  expect(started.config.project_doc_max_bytes).toBe(0);
  // The turn's work dir, inside the workspace.
  expect(String(started.cwd).startsWith(join(h.root, "work"))).toBe(true);
  // The app's own tools are the thread's dynamic tools, less the ones Codex has of its own.
  const tools = (started.dynamicTools as Array<{ name: string }>).map((tool) => tool.name);
  expect(tools).toContain("end_turn");
  expect(tools).toContain("ask_user");
  expect(tools).not.toContain("shell");
  expect(started.developerInstructions).toContain("Codex");
  expect(started.developerInstructions).toContain("这一轮由用户自己的 Codex 运行");
  // What the user said reaches it as the turn's input.
  const input = h.request("turn/start")[0]!.input as Array<{ type: string; text?: string }>;
  expect(input.map((part) => part.text ?? "").join("\n")).toContain("帮我看看这个项目");

  const spend = h.store.db.query<{ provider_name: string; model: string; input_tokens: number; output_tokens: number; cached_tokens: number }, []>(
    "SELECT provider_name, model, input_tokens, output_tokens, cached_tokens FROM spend WHERE provider_name = 'Codex'").all();
  expect(spend).toEqual([{ provider_name: "Codex", model: "gpt-fake-1", input_tokens: 1200, output_tokens: 80, cached_tokens: 1000 }]);
  const route = h.store.db.query<{ provider_id: string | null; reason_code: string | null }, []>(
    "SELECT provider_id, reason_code FROM turn_route_decisions").get();
  expect(route).toEqual({ provider_id: null, reason_code: "agent_codex" });
});

test("a command inside the turn's work dir is let through without a card, and is on the turn's record", async () => {
  const h = await harness({ turns: [[{ command: "echo hi" }, { say: "跑完了" }]] });
  await h.post("跑一下");
  expect(h.lines("bot")).toEqual(["跑完了"]);
  expect(h.approvals()).toBe(0);
  expect(h.seen().find((entry) => entry.asked)).toMatchObject({ asked: "echo hi", answer: { decision: "accept" } });
  const run = h.store.db.query<{ command: string; exit_code: number; ok: number }, []>("SELECT command, exit_code, ok FROM turn_runs").get();
  expect(run).toEqual({ command: "echo hi", exit_code: 0, ok: 1 });
  expect(h.startedFrames()).toEqual(["shell"]);
});

test("a command reading outside the workspace waits for your card, and a refusal reaches Codex as a decline", async () => {
  const h = await harness({ turns: [[{ command: "cat /etc/hosts" }, { say: "没读成" }]] });
  const done = h.post("看看 hosts");
  const card = await h.pendingApproval();
  expect(card?.kind_key).toBe("unconstrained-shell");
  expect(card?.summary).toContain("cat /etc/hosts");
  h.engine.resolveApproval(card!.id, "deny");
  await done;
  expect(h.seen().find((entry) => entry.asked)).toMatchObject({ asked: "cat /etc/hosts", answer: { decision: "decline" } });
  expect(h.lines("bot")).toEqual(["没读成"]);
  // It did not run: the record says so.
  const run = h.store.db.query<{ command: string; ok: number; error: string | null }, []>("SELECT command, ok, error FROM turn_runs").get();
  expect(run).toEqual({ command: "cat /etc/hosts", ok: 0, error: "declined" });
});

test("the same command runs once you allow it", async () => {
  const h = await harness({ turns: [[{ command: "cat /etc/hosts" }, { say: "读到了" }]] });
  const done = h.post("看看 hosts");
  const card = await h.pendingApproval();
  expect(card?.kind_key).toBe("unconstrained-shell");
  h.engine.resolveApproval(card!.id, "allow_once");
  await done;
  expect(h.seen().find((entry) => entry.asked)).toMatchObject({ answer: { decision: "accept" } });
  expect(h.lines("bot")).toEqual(["读到了"]);
  expect(h.failKind()).toBeUndefined();
});

test("a file change inside the work dir is let through, written, and recorded as the turn's write_file", async () => {
  const h = await harness({ turns: [[{ fileChange: "@CWD/notes/plan.md" }, { say: "写好了 notes/plan.md" }]] });
  await h.post("写个计划");
  expect(h.lines("bot")).toEqual(["写好了 notes/plan.md"]);
  expect(h.approvals()).toBe(0);
  const wrote = String(h.seen().find((entry) => entry.wrote)?.wrote);
  expect(wrote.startsWith(join(h.root, "work"))).toBe(true);
  expect(readFileSync(wrote, "utf8")).toBe("x");
  expect(h.seen().find((entry) => entry.asked)).toMatchObject({ answer: { decision: "accept" } });
  expect(h.startedFrames()).toEqual(["write_file"]);
  // The frame names the file it was for, relative to the workspace.
  expect(h.startedTargets()[0]).toMatch(/^work\/.+\/notes\/plan\.md$/);
});

test("a file change outside the workspace waits for your card, and a refusal means it is never written", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agent-outside-")));
  const target = join(outside, "x.txt");
  const h = await harness({ turns: [[{ fileChange: target }, { say: "没写成" }]] });
  const done = h.post("在外面写个文件");
  const card = await h.pendingApproval();
  expect(card?.kind_key).toBe("outside-write");
  h.engine.resolveApproval(card!.id, "deny");
  await done;
  expect(existsSync(target)).toBe(false);
  expect(h.seen().find((entry) => entry.asked)).toMatchObject({ answer: { decision: "decline" } });
  rmSync(outside, { recursive: true, force: true });
});

// The request names only the item's id; the item, with its paths, may come in the same read
// (a pipe the daemon was too busy to read). It is noted at once, so the card is never skipped.
test("a file change outside the workspace still waits for your card when its request is read together with its item/started", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agent-outside-")));
  const target = join(outside, "x.txt");
  const h = await harness({ turns: [[{ fileChange: target, burst: true }, { say: "写了" }]] });
  try {
    const done = h.post("在外面写个文件");
    const card = await h.cardOrEnd(done);
    expect(card?.kind_key).toBe("outside-write");
    h.engine.resolveApproval(card!.id, "deny");
    await done;
    expect(existsSync(target)).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the app's end_turn is a dynamic tool that ends the segment without a reply", async () => {
  const h = await harness({ turns: [[{ tool: { name: "end_turn", args: { reason: "nothing to add" } } }, { hang: true }]] });
  await h.post("不用回");
  expect(h.seen().find((entry) => entry.toolCalled === "end_turn")?.args).toEqual({ reason: "nothing to add" });
  expect(h.lines("bot")).toEqual([]);
  expect(h.failKind()).toBeUndefined();
  expect(h.lines("system")).toEqual([]);
});

test("a Codex that is signed out fails the turn as signed out, named, before any thread", async () => {
  const h = await harness({ signedOut: true, turns: [[{ say: "x" }]] });
  await h.post("hi");
  expect(h.failKind()).toBe("agent_signed_out");
  expect(h.lines("system").join("\n")).toContain("Codex");
  expect(h.request("thread/start")).toEqual([]);
  expect(h.lines("bot")).toEqual([]);
});

test("a turn that failed on the plan's usage limit fails as the agent's limit", async () => {
  const h = await harness({ turns: [[{ fail: { message: "Something went wrong", codexErrorInfo: "usageLimitExceeded" } }]] });
  await h.post("hi");
  expect(h.failKind()).toBe("agent_limit");
  expect(h.lines("system").join("\n")).toContain("Codex");
  expect(h.lines("bot")).toEqual([]);
});

test("a limit Codex reported as an error notice, its info a one-key object, is the limit too", async () => {
  const h = await harness({ turns: [[{ fail: { message: "Rate limited", codexErrorInfo: { rateLimitExceeded: {} }, errorNotice: true } }]] });
  await h.post("hi");
  expect(h.failKind()).toBe("agent_limit");
});

test("a command Codex ran on its own out of the workspace, with no approval asked, stops the turn as unguarded", async () => {
  const h = await harness({ turns: [[{ unasked: `cat ${join(homedir(), ".ssh", "known_hosts")}` }, { say: "看完了" }]] });
  await h.post("看看 ssh");
  expect(h.lines("bot")).toEqual([]);
  expect(h.failKind()).toBe("agent_unguarded");
  expect(h.lines("system").join("\n")).toContain("Codex");
  expect(h.seen().some((entry) => entry.asked)).toBe(false);
});

test("a command Codex ran on its own on another agent's credentials stops the turn too", async () => {
  const h = await harness({ turns: [[{ unasked: "cat ~/.claude/.credentials.json" }, { say: "看完了" }]] });
  await h.post("看看");
  expect(h.lines("bot")).toEqual([]);
  expect(h.failKind()).toBe("agent_unguarded");
});

test("your own MCP servers are switched off for the thread by name; one the config cannot take is left out and asked again, and a plugin's never goes in", async () => {
  const h = await harness({
    mcpServers: [{ name: "mine" }, { name: "plug", pluginId: "x@y" }],
    rejectMcp: ["mine"],
    turns: [[{ say: "好了" }]],
  });
  await h.post("hi");
  expect(h.lines("bot")).toEqual(["好了"]);
  const [first, second] = h.request("thread/start");
  expect(h.request("thread/start").length).toBe(2);
  expect(first!.config.mcp_servers).toEqual({ mine: { enabled: false } });
  expect(second!.config.mcp_servers?.mine).toBeUndefined();
  expect(JSON.stringify(second!.config)).not.toContain("mine");
  // A plugin's server goes off with the plugins, never by name.
  expect(first!.config.mcp_servers?.plug).toBeUndefined();
  expect(second!.config.mcp_servers?.plug).toBeUndefined();
  expect(first!.config.features.plugins).toBe(false);
});
