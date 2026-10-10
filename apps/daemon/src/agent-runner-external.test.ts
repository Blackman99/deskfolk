/**
 * Local agents other than Claude Code (ADR 0079), end to end through the real engine and store: a
 * stand-in ACP agent (`fixtures/agents/fake-acp-agent.ts`) plays a script against the app's side of
 * the protocol — its file and command calls, its permission answers, its tools over MCP.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRunner, ClientEvent } from "@real-bot/protocol";
import type { CompletionOk, JudgeResult } from "./completions";
import { handleAgentMcp, isAgentMcpPath, mountedAgentMcp, setAgentMcpPort } from "./agent-mcp/bridge";
import { acpDriver } from "./engine/agent/drivers/acp";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { ENGINE_LEVELS, SCHEMA_LEVEL } from "./store/schema-gate";
import { createTurnEngine } from "./turn-engine";

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}
function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

const FAKE = join(import.meta.dir, "fixtures", "agents", "fake-acp-agent.ts");

// The app's tools are reached over HTTP, as on the daemon's own port.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, srv) {
    const url = new URL(request.url);
    if (isAgentMcpPath(url.pathname)) return handleAgentMcp(request, (held) => srv.timeout(held, 0));
    return new Response(null, { status: 404 });
  },
});
setAgentMcpPort(server.port ?? null);

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

type Step = Record<string, unknown>;

async function harness(prompts: Step[][], opts: { runner?: BotRunner; http?: boolean; newSession?: { fail: { code: number; message: string } }; missing?: string; appLoop?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-external-")));
  const logFile = join(root, ".fake-acp.log");
  const store = new Store({ endpointKey: memoryKeyStore() });
  const events: ClientEvent[] = [];
  const completedWaiters: Array<() => void> = [];
  const runner = opts.runner ?? "grok";
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
    agentDrivers: { [runner]: acpDriver() },
    async resolveAgent() {
      if (opts.missing) return { ok: false, error: opts.missing };
      return {
        ok: true, executable: process.execPath, source: "known", args: [FAKE], proxy: null,
        env: { ...process.env as Record<string, string>, FAKE_ACP_SCRIPT: JSON.stringify({ prompts, http: opts.http, newSession: opts.newSession }), FAKE_ACP_LOG: logFile },
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
  const bot = opts.appLoop
    ? store.createBot({ name: "Coder", duties: "write code", boundaries: "stay in the workspace" })
    : store.createBot({ name: "Coder", duties: "write code", boundaries: "stay in the workspace", runner, agent_model: "grok-fake" });
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
  const seen = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : []);
  const pendingApproval = async () => {
    for (let i = 0; i < 200; i++) {
      const row = store.db.query<{ id: string; kind_key: string; summary: string }, []>("SELECT id, kind_key, summary FROM approvals WHERE status = 'pending'").get();
      if (row) return row;
      await Bun.sleep(20);
    }
    return null;
  };
  return { store, engine, root, bot, session, events, post, lines, seen, pendingApproval, completed };
}

test("a Grok Bot's turn is its agent's: the reply is posted, the app's instructions open the first prompt, and the route says which agent", async () => {
  const h = await harness([[{ say: "这是" }, { say: "答复。" }]]);
  await h.post("帮我看看这个项目");
  expect(h.lines("bot")).toEqual(["这是答复。"]);
  const prompt = h.seen().find((entry) => entry.method === "session/prompt")!.params as { prompt: Array<{ type: string; text?: string }> };
  expect(prompt.prompt[0]!.text).toContain("这一轮由用户自己的 Grok 运行");
  expect(prompt.prompt.map((block) => block.text ?? "").join("\n")).toContain("帮我看看这个项目");
  const created = h.seen().find((entry) => entry.method === "session/new")!.params as { cwd: string; additionalDirectories?: string[]; mcpServers: Array<{ type: string; name: string; url: string }> };
  // The turn's work dir, with the workspace beside it.
  expect(created.cwd.startsWith(join(h.root, "work"))).toBe(true);
  expect(created.additionalDirectories).toEqual([h.root]);
  expect(created.mcpServers[0]).toMatchObject({ type: "http", name: "deskfolk" });
  // The model is set over the protocol, as the agent offers it.
  expect(h.seen().some((entry) => entry.method === "session/set_config_option" && (entry.params as { value?: string }).value === "grok-fake")).toBe(true);
  const route = h.store.db.query<{ provider_id: string | null; model: string; reason_code: string | null }, []>(
    "SELECT provider_id, model, reason_code FROM turn_route_decisions").get();
  expect(route).toEqual({ provider_id: null, model: "grok-fake", reason_code: "agent_grok" });
  // The segment is over: its tools are no longer mounted.
  expect(mountedAgentMcp()).toBe(0);
});

test("the app reads and writes inside the workspace for the agent, and records the write", async () => {
  const h = await harness([[{ write: { path: "@CWD/notes/plan.md", content: "第一版" } }, { read: "@CWD/notes/plan.md" }, { say: "写好了 notes/plan.md" }]]);
  await h.post("写个计划");
  expect(h.lines("bot")).toEqual(["写好了 notes/plan.md"]);
  const wrote = String(h.seen().find((entry) => entry.wrote)?.wrote);
  expect(readFileSync(wrote, "utf8")).toBe("第一版");
  expect(h.seen().find((entry) => entry.read)?.content).toBe("第一版");
  expect(h.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM approvals").get()!.n).toBe(0);
  const frames = h.events.filter((event) => event.event === "turn.tool" && (event as { phase?: string }).phase === "started").map((event) => (event as { name?: string }).name);
  expect(frames).toEqual(["write_file", "read_file"]);
});

test("a read outside the workspace waits for your approval card, and the file reaches the agent once you allow it", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agent-outside-")));
  writeFileSync(join(outside, "notes.txt"), "outside notes");
  const h = await harness([[{ read: join(outside, "notes.txt") }, { say: "读到了" }]]);
  const done = h.post("看看外面那个文件");
  const card = await h.pendingApproval();
  expect(card?.kind_key).toBe("outside-read");
  expect(card?.summary).toContain(join(outside, "notes.txt"));
  h.engine.resolveApproval(card!.id, "allow_once");
  await done;
  expect(h.seen().find((entry) => entry.read)?.content).toBe("outside notes");
  expect(h.lines("bot")).toEqual(["读到了"]);
  rmSync(outside, { recursive: true, force: true });
});

test("a read the app carried out for the agent counts as asked, even with another call reported beside it (Grok, 2026-10-10)", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agent-outside-")));
  writeFileSync(join(outside, "hosts"), "## hosts");
  const h = await harness([[{ sideRead: join(outside, "hosts") }, { say: "第一行是 ##" }]]);
  const done = h.post("看看 hosts");
  const card = await h.pendingApproval();
  h.engine.resolveApproval(card!.id, "allow_once");
  await done;
  expect(h.lines("bot")).toEqual(["第一行是 ##"]);
  expect(h.lines("system")).toEqual([]);
  rmSync(outside, { recursive: true, force: true });
});

test("a denied write outside the workspace never happens, and the agent hears why", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agent-outside-")));
  const h = await harness([[{ write: { path: join(outside, "x.txt"), content: "nope" } }, { say: "没写成" }]]);
  const done = h.post("在外面写个文件");
  const card = await h.pendingApproval();
  expect(card?.kind_key).toBe("outside-write");
  h.engine.resolveApproval(card!.id, "deny");
  await done;
  expect(existsSync(join(outside, "x.txt"))).toBe(false);
  expect(String(h.seen().find((entry) => entry.wrote)?.error)).toContain("denied");
  rmSync(outside, { recursive: true, force: true });
});

test("a command the app runs for the agent inside the workspace runs without a card and is on the turn's record", async () => {
  const h = await harness([[{ run: "echo made > made.txt && echo ok" }, { say: "跑完了" }]]);
  await h.post("跑一下");
  // It ran in the turn's work dir.
  const made = [...new Bun.Glob("work/*/made.txt").scanSync({ cwd: h.root })];
  expect(made.length).toBe(1);
  expect(readFileSync(join(h.root, made[0]!), "utf8").trim()).toBe("made");
  expect(h.seen().find((entry) => entry.ran)?.output).toContain("ok");
  const run = h.store.db.query<{ command: string; exit_code: number; ok: number }, []>("SELECT command, exit_code, ok FROM turn_runs").get();
  expect(run).toEqual({ command: "echo made > made.txt && echo ok", exit_code: 0, ok: 1 });
  expect(h.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM approvals").get()!.n).toBe(0);
});

test("a call the agent asks permission for is answered by the app's rules: inside allowed once, never always", async () => {
  const h = await harness([[{ ask: { kind: "execute", title: "ls", rawInput: { command: "ls", cwd: "@CWD" } } }, { say: "列好了" }]]);
  await h.post("列一下");
  const asked = h.seen().find((entry) => entry.asked)!;
  expect(asked.outcome).toEqual({ outcome: "selected", optionId: "once" });
  expect(h.lines("bot")).toEqual(["列好了"]);
});

test("a call the agent ran on its own out of the workspace stops the turn as unguarded", async () => {
  const h = await harness([[{ unasked: { kind: "read", title: "Read known_hosts", locations: [{ path: join(homedir(), ".ssh", "known_hosts") }] } }, { say: "看完了" }]]);
  await h.post("看看 ssh");
  expect(h.lines("bot")).toEqual([]);
  const failure = h.lines("system").join("\n");
  expect(failure).toContain("Grok");
  expect(h.store.db.query<{ fail_kind: string | null }, []>("SELECT fail_kind FROM notifications WHERE kind = 'failure'").get()?.fail_kind).toBe("agent_unguarded");
});

test("a call the agent ran on its own on another agent's credentials stops the turn too", async () => {
  const h = await harness([[{ unasked: { kind: "execute", title: "cat", rawInput: { command: "cat ~/.codex/auth.json" } } }, { say: "看完了" }]]);
  await h.post("看看");
  expect(h.lines("bot")).toEqual([]);
  expect(h.store.db.query<{ fail_kind: string | null }, []>("SELECT fail_kind FROM notifications WHERE kind = 'failure'").get()?.fail_kind).toBe("agent_unguarded");
});

test("the app's own tools reach the agent over MCP, and end_turn ends the segment without a reply", async () => {
  const h = await harness([[{ tool: { name: "end_turn", args: { reason: "nothing to add" } } }, { hang: true }]]);
  await h.post("不用回");
  const listed = h.seen().find((entry) => entry.listed)!.listed as string[];
  expect(listed).toContain("end_turn");
  expect(listed).toContain("ask_user");
  expect(listed).not.toContain("shell");
  expect(h.lines("bot")).toEqual([]);
  // It was told to stop the step it was on.
  for (let i = 0; i < 50 && !h.seen().some((entry) => entry.notification === "session/cancel"); i++) await Bun.sleep(20);
  expect(h.seen().some((entry) => entry.notification === "session/cancel")).toBe(true);
});

test("an agent that cannot sign in fails the turn as signed out, named", async () => {
  const h = await harness([[{ say: "x" }]], { newSession: { fail: { code: -32000, message: "Authentication required" } } });
  await h.post("hi");
  expect(h.lines("system").join("\n")).toContain("Grok");
  expect(h.store.db.query<{ fail_kind: string | null }, []>("SELECT fail_kind FROM notifications WHERE kind = 'failure'").get()?.fail_kind).toBe("agent_signed_out");
});

test("a prompt that runs out of balance fails the turn as the agent's limit", async () => {
  const h = await harness([[{ fail: { code: -32603, message: "Internal error: turn failed: Insufficient Balance" } }]], { runner: "dsh" });
  await h.post("hi");
  expect(h.store.db.query<{ fail_kind: string | null }, []>("SELECT fail_kind FROM notifications WHERE kind = 'failure'").get()?.fail_kind).toBe("agent_limit");
  expect(h.lines("system").join("\n")).toContain("DSH");
});

test("an agent that is not installed fails the turn as missing, named, and is not retried", async () => {
  const h = await harness([[{ say: "x" }]], { runner: "codex", missing: "codex was not found on PATH" });
  await h.post("hi");
  const failure = h.lines("system").join("\n");
  expect(failure).toContain("Codex");
  expect(failure).toContain("codex was not found on PATH");
});

/** The fake agent's log once it holds an entry the test waits for. */
async function seenWhen(h: { seen: () => Array<Record<string, unknown>> }, found: (entry: Record<string, unknown>) => boolean) {
  for (let i = 0; i < 250; i++) {
    if (h.seen().some(found)) return true;
    await Bun.sleep(20);
  }
  return false;
}

test("insert-now cuts the step in progress, and the line goes in as the next prompt (ADR 0069)", async () => {
  const h = await harness([[{ say: "开始渲染" }, { hang: true }], [{ say: "好，换真模型重做。" }]]);
  const done = h.post("把这段渲染出来");
  expect(await seenWhen(h, (entry) => entry.method === "session/prompt")).toBe(true);
  await Bun.sleep(100);
  const line = h.store.insertMessage({ sessionId: h.session, kind: "user", author: "user", body: "模型要用真一点的" });
  await h.engine.handleInboundMessage(line, { fromUser: true });
  expect(h.engine.insertNow(line.id)).toBe(1);
  await done;
  expect(h.seen().some((entry) => entry.notification === "session/cancel")).toBe(true);
  const prompts = h.seen().filter((entry) => entry.method === "session/prompt").map((entry) => JSON.stringify(entry.params));
  expect(prompts.length).toBe(2);
  expect(prompts[1]).toContain("模型要用真一点的");
  expect(prompts[1]).toContain("用户要你马上读");
  // The cut step is no reply and no failure: the answer to the line is.
  expect(h.lines("bot")).toEqual(["好，换真模型重做。"]);
  expect(h.lines("system")).toEqual([]);
  expect(h.store.getMessage(line.id).delivery?.state).not.toBe("queued");
});

test("a line said meanwhile reaches an agent that cannot be cut in the result of the app tool it calls next", async () => {
  const h = await harness([[{ wait: 400 }, { tool: { name: "list_prompts", args: {} } }, { say: "看到了" }]]);
  const done = h.post("看看内置提示词");
  expect(await seenWhen(h, (entry) => entry.method === "session/prompt")).toBe(true);
  const line = h.store.insertMessage({ sessionId: h.session, kind: "user", author: "user", body: "顺便看看有没有关于收尾的" });
  await h.engine.handleInboundMessage(line, { fromUser: true });
  await done;
  const out = JSON.stringify(h.seen().find((entry) => entry.tool === "list_prompts")?.out);
  expect(out).toContain("顺便看看有没有关于收尾的");
});

test("Stop during a command the app runs for the agent ends the command and the agent with it", async () => {
  const marker = `sleep 31.${Math.floor(Math.random() * 900) + 100}`;
  const h = await harness([[{ run: marker }, { say: "跑完了" }]]);
  void h.post("跑个长的");
  const running = () => Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim();
  for (let i = 0; i < 200 && !running(); i++) await Bun.sleep(20);
  expect(running()).not.toBe("");
  const turn = h.store.db.query<{ id: string }, []>("SELECT id FROM turns ORDER BY created_at DESC LIMIT 1").get()!;
  h.engine.stop(turn.id);
  for (let i = 0; i < 100; i++) {
    const left = Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim();
    if (!left) break;
    await Bun.sleep(50);
  }
  expect(Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim()).toBe("");
  expect(h.lines("bot")).toEqual([]);
}, 20_000);

test("an agent that takes no HTTP MCP reaches the app's tools through the daemon's stdio shim", async () => {
  const h = await harness([[{ tool: { name: "end_turn", args: { reason: "nothing to add" } } }, { hang: true }]], { http: false });
  await h.post("不用回");
  const created = h.seen().find((entry) => entry.method === "session/new")!.params as { mcpServers: Array<{ name: string; command?: string; args?: string[] }> };
  expect(created.mcpServers[0]!.args).toContain("--agent-mcp");
  expect(h.seen().find((entry) => entry.listed)?.listed).toContain("end_turn");
  expect(h.lines("bot")).toEqual([]);
}, 30_000);

test("a job on the app's own loop that climbed onto a Grok rung of the ladder has its turn run by Grok on that rung (ADR 0076, ADR 0079)", async () => {
  const h = await harness([[{ say: "换 Grok 做完了" }]], { appLoop: true });
  for (const key of ["engine_level", "schema_min_compatible"]) {
    const value = key === "schema_min_compatible" ? Math.min(ENGINE_LEVELS.routing, SCHEMA_LEVEL) : ENGINE_LEVELS.routing;
    h.store.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
  }
  const provider = (await h.store.listProviders())[0]!;
  h.store.setModelLadder([{ provider_id: provider.id, model: "fixture" }, { runner: "grok", model: "grok-4.7", effort: "xhigh", config_dir: null }]);
  expect(() => h.store.setModelLadder([{ runner: "grok", model: "grok-4.7", effort: "max", config_dir: null }])).toThrow("low, medium, high, xhigh");
  Object.defineProperty(h.store, "workEscalation", { value: () => 9 });
  await h.post("再交一次");
  expect(h.lines("bot")).toEqual(["换 Grok 做完了"]);
  const route = h.store.db.query<{ model: string; thinking_level: string; reason_code: string | null; base_reason_code: string | null }, []>(
    "SELECT model, thinking_level, reason_code, base_reason_code FROM turn_route_decisions").get();
  expect(route).toEqual({ model: "grok-4.7", thinking_level: "xhigh", reason_code: "agent_grok", base_reason_code: "escalation_model" });
});

test("a built-in call can run on another local agent: it answers once, with no tools, and a call it tries is cut off", async () => {
  const { createAgentJudge } = await import("./agents/judge");
  const store = new Store({ endpointKey: memoryKeyStore() });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-judge-")));
  const judgeFor = (prompts: Step[][]) => createAgentJudge({
    store,
    drivers: { grok: acpDriver() },
    resolve: async () => ({ ok: true, executable: process.execPath, source: "known", args: [FAKE], proxy: null,
      env: { ...process.env as Record<string, string>, FAKE_ACP_SCRIPT: JSON.stringify({ prompts }), FAKE_ACP_LOG: join(root, "judge.log") } }),
  });
  const target = { kind: "agent" as const, runner: "grok" as const, customId: null, label: "Grok", model: "grok-4.7", configDir: null, effort: "low" };
  try {
    const answered = await judgeFor([[{ say: "{\"kind\":\"chat\"}" }]])({ target, system: "Read the line.", prompt: "你好", signal: new AbortController().signal });
    expect(answered).toMatchObject({ content: "{\"kind\":\"chat\"}", fail: null });
    const created = readFileSync(join(root, "judge.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.method === "session/new");
    // No tools are mounted for a one-shot call.
    expect(created.params.mcpServers).toEqual([]);
    const tried = await judgeFor([[{ unasked: { kind: "execute", title: "ls", rawInput: { command: "ls /" } } }, { say: "x" }]])({ target, system: "s", prompt: "p", signal: new AbortController().signal });
    expect(tried.fail).toBe("claude_failed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a built-in call's model can be another agent's, kept as chosen, and a custom agent's names which one", async () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  try {
    await store.patchSettings({ builtin_models: { organizer: { runner: "codex", model: "gpt-5.6-luna", config_dir: null } } as never });
    expect(store.settingsCached().builtin_models?.organizer).toEqual({ runner: "codex", model: "gpt-5.6-luna", config_dir: null, custom_id: null });
    await expect(store.patchSettings({ builtin_models: { organizer: { runner: "custom", model: "m", config_dir: null } } as never })).rejects.toThrow("custom agents");
    const [mine] = store.setCustomAgents([{ name: "Mine", command: "/usr/local/bin/mine", args: [] }]);
    await store.patchSettings({ builtin_models: { judge: { runner: "custom", model: "m", config_dir: null, custom_id: mine!.id } } as never });
    expect(store.settingsCached().builtin_models?.judge).toMatchObject({ runner: "custom", custom_id: mine!.id });
    // In use, it cannot be taken away.
    expect(() => store.setCustomAgents([])).toThrow("built-in call judge");
  } finally {
    store.close();
  }
});
