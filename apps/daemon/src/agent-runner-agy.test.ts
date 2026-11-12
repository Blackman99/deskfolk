/**
 * A Bot run by your Antigravity `agy acp` (ADR 0079, addendum of 2026-11-12), end to end through the
 * real engine and store: the stand-in ACP agent (`fixtures/agents/fake-acp-agent.ts`) is shaped like
 * `agy acp` 1.5.6 — its models, modes and options, the tokens each prompt's answer reports, its own
 * calls reported only once under way and never asked about — and plays a script against the app's
 * side of the protocol.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent, PermissionMode } from "@real-bot/protocol";
import type { CompletionOk, JudgeResult } from "./completions";
import { handleAgentMcp, isAgentMcpPath, setAgentMcpPort } from "./agent-mcp/bridge";
import { agyAnswersQuota } from "./agents/usage";
import { agyServesAcp, agyTooOld } from "./agents/agy-version";
import { AGENT_LAUNCH } from "./agents/registry";
import { agyDriver, agyFailure } from "./engine/agent/drivers/agy";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}
function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

const FAKE = join(import.meta.dir, "fixtures", "agents", "fake-acp-agent.ts");

// The stdio shim reaches the app's tools on the daemon's own port.
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

const MODEL_SELECT = { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-3.8-flash",
  options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" }] };
const MODE_SELECT = (current: string) => ({ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: current,
  options: [{ value: "default", name: "Default" }, { value: "accept-edits", name: "Accept edits" }, { value: "auto", name: "Auto" }, { value: "plan", name: "Plan" }] });

/** `session/new` as `agy acp` 1.5.6 answers it (measured 2026-11-12), left in a mode of your own. */
const AGY_SESSION = {
  models: {
    availableModels: [
      { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      { modelId: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    ],
    currentModelId: "gemini-3.8-flash-high",
  },
  modes: { currentModeId: "accept-edits" },
  configOptions: [
    MODEL_SELECT,
    { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: "high",
      options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
    MODE_SELECT("accept-edits"),
  ],
};

type Step = Record<string, unknown>;
type Entry = Record<string, unknown>;

async function harness(prompts: Step[][], opts: {
  version?: string; permissionMode?: PermissionMode; model?: string | null; effort?: string | null;
  usage?: Record<string, number>; session?: Record<string, unknown>;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-agy-")));
  const logFile = join(root, ".fake-acp.log");
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
    agentDrivers: { antigravity: agyDriver({ version: async () => opts.version ?? "1.5.6" }) },
    async resolveAgent() {
      return {
        ok: true, executable: process.execPath, source: "known", args: [FAKE], proxy: null,
        env: { ...process.env as Record<string, string>, FAKE_ACP_LOG: logFile,
          FAKE_ACP_SCRIPT: JSON.stringify({ prompts, http: false, newSession: { result: opts.session ?? AGY_SESSION }, usage: opts.usage }) },
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
  const bot = store.createBot({
    name: "Coder", duties: "write code", boundaries: "stay in the workspace", runner: "antigravity",
    agent_model: opts.model === undefined ? "gemini-3.8-flash-high" : opts.model, agent_effort: opts.effort ?? null,
    permission_mode: opts.permissionMode ?? null,
  });
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
  const asked = (method: string) => seen().filter((entry) => entry.method === method).map((entry) => entry.params as Record<string, unknown>);
  const failKind = () => store.db.query<{ fail_kind: string | null }, []>("SELECT fail_kind FROM notifications WHERE kind = 'failure'").get()?.fail_kind;
  const pendingApproval = async () => {
    for (let i = 0; i < 200; i++) {
      const row = store.db.query<{ id: string; kind_key: string }, []>("SELECT id, kind_key FROM approvals WHERE status = 'pending'").get();
      if (row) return row;
      await Bun.sleep(20);
    }
    return null;
  };
  return { store, engine, root, bot, session, events, post, lines, seen, asked, failKind, pendingApproval };
}

/** The fake agent's log once it holds an entry the test waits for. */
async function seenWhen(h: { seen: () => Entry[] }, found: (entry: Entry) => boolean) {
  for (let i = 0; i < 250; i++) {
    if (h.seen().some(found)) return true;
    await Bun.sleep(20);
  }
  return false;
}

test("an Antigravity Bot's turn runs on agy acp: sandboxed, the app's tools over stdio, the model as agy lists it, agy's own mode put back to default, and the tokens it reports spent", async () => {
  const h = await harness([[{ say: "这是" }, { say: "答复。" }]], {
    effort: "medium",
    usage: { inputTokens: 100, cachedReadTokens: 40, cachedWriteTokens: 0, outputTokens: 20, thoughtTokens: 5, totalTokens: 165 },
  });
  await h.post("帮我看看这个项目");
  expect(h.lines("bot")).toEqual(["这是答复。"]);

  const launch = h.seen().find((entry) => entry.argv)!;
  expect(launch.argv).toContain("--sandbox");
  const [created] = h.asked("session/new") as Array<{ cwd: string; additionalDirectories?: string[]; mcpServers: Array<{ name: string; type?: string; args?: string[] }> }>;
  // The turn's work dir, with the workspace beside it; the app's tools through the daemon's stdio shim.
  expect(created!.cwd.startsWith(join(h.root, "work"))).toBe(true);
  expect(created!.additionalDirectories).toEqual([h.root]);
  expect(created!.mcpServers[0]).toMatchObject({ name: "deskfolk" });
  expect(created!.mcpServers[0]!.type).toBeUndefined();
  expect(created!.mcpServers[0]!.args).toContain("--agent-mcp");

  // `gemini-3.8-flash-high` is in agy's model list, not its select: set as a model, not an option.
  expect(h.asked("session/set_model")).toEqual([{ sessionId: "fake-session-1", modelId: "gemini-3.8-flash-high" }]);
  const options = h.asked("session/set_config_option").map((params) => [params.configId, params.value]);
  expect(options).toEqual([["thought_level", "medium"], ["mode", "default"]]);

  const [prompt] = h.asked("session/prompt") as Array<{ prompt: Array<{ text?: string }> }>;
  expect(prompt!.prompt[0]!.text).toContain("这一轮由用户自己的 Antigravity 运行");
  expect(prompt!.prompt[0]!.text).not.toContain("拿不到 Deskfolk 的工具");

  const spend = h.store.db.query<{ provider_name: string; input_tokens: number; output_tokens: number; cached_tokens: number }, []>(
    "SELECT provider_name, input_tokens, output_tokens, cached_tokens FROM spend WHERE provider_name = 'Antigravity'").all();
  expect(spend).toEqual([{ provider_name: "Antigravity", input_tokens: 140, output_tokens: 25, cached_tokens: 40 }]);
  const route = h.store.db.query<{ reason_code: string | null }, []>("SELECT reason_code FROM turn_route_decisions").get();
  expect(route?.reason_code).toBe("agent_antigravity");
}, 30_000);

test("a model agy's select names is set there, and a level that model does not offer is left to agy", async () => {
  const h = await harness([[{ say: "好" }]], {
    model: "claude-opus-4-6-thinking", effort: "high",
    // Claude Opus offers no thinking level; the session is already in agy's default mode.
    session: { ...AGY_SESSION, modes: { currentModeId: "default" }, configOptions: [MODEL_SELECT, MODE_SELECT("default")] },
  });
  await h.post("hi");
  expect(h.lines("bot")).toEqual(["好"]);
  expect(h.asked("session/set_model")).toEqual([]);
  expect(h.asked("session/set_config_option").map((params) => [params.configId, params.value])).toEqual([["model", "claude-opus-4-6-thinking"]]);
}, 30_000);

test("the app's own tools reach agy, and end_turn ends the segment without a reply", async () => {
  const h = await harness([[{ tool: { name: "end_turn", args: { reason: "nothing to add" } } }, { hang: true }]]);
  await h.post("不用回");
  const listed = h.seen().find((entry) => entry.listed)!.listed as string[];
  expect(listed).toContain("end_turn");
  expect(listed).toContain("ask_user");
  expect(h.lines("bot")).toEqual([]);
  expect(await seenWhen(h, (entry) => entry.notification === "session/cancel")).toBe(true);
}, 30_000);

test("insert-now cuts agy's step in progress, and the line goes in as the next prompt", async () => {
  const h = await harness([[{ say: "开始渲染" }, { hang: true }], [{ say: "好，换真模型重做。" }]]);
  const done = h.post("把这段渲染出来");
  expect(await seenWhen(h, (entry) => entry.method === "session/prompt")).toBe(true);
  await Bun.sleep(100);
  const line = h.store.insertMessage({ sessionId: h.session, kind: "user", author: "user", body: "模型要用真一点的" });
  await h.engine.handleInboundMessage(line, { fromUser: true });
  expect(h.engine.insertNow(line.id)).toBe(1);
  await done;
  expect(h.seen().some((entry) => entry.notification === "session/cancel")).toBe(true);
  expect(h.asked("session/prompt").length).toBe(2);
  expect(h.lines("bot")).toEqual(["好，换真模型重做。"]);
}, 30_000);

test("read-only, a write agy did not ask about stops the turn as soon as agy reports it, before it is done", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agent-outside-")));
  const target = join(outside, "x.txt");
  const h = await harness([[
    { unasked: { kind: "edit", title: "File x.txt", rawInput: { Path: target, Content: "x\n" }, locations: [{ path: target }], holdMs: 3_000 } },
    { say: "写了" },
  ]], { permissionMode: "read_only" });
  const started = Date.now();
  await h.post("在外面写个文件");
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(h.failKind()).toBe("agent_unguarded");
  expect(h.lines("bot")).toEqual([]);
  // The write was still under way when the turn stopped.
  expect(h.seen().some((entry) => entry.unasked)).toBe(false);
  rmSync(outside, { recursive: true, force: true });
}, 30_000);

test("ask-first, a call agy reports as pending and then asks about gets the approval card, not a stop", async () => {
  const h = await harness([[
    { ask: { kind: "edit", title: "File notes.md", rawInput: { Path: "@CWD/notes.md", Content: "x\n" }, locations: [{ path: "@CWD/notes.md" }] } },
    { say: "写好了" },
  ]], { permissionMode: "ask_first" });
  const done = h.post("写个笔记");
  const card = await h.pendingApproval();
  expect(card).not.toBeNull();
  h.engine.resolveApproval(card!.id, "allow_once");
  await done;
  expect(h.failKind()).toBeUndefined();
  expect(h.seen().find((entry) => entry.asked)?.outcome).toEqual({ outcome: "selected", optionId: "once" });
  expect(h.lines("bot")).toEqual(["写好了"]);
}, 30_000);

test("read-only, agy's own report of a Deskfolk tool call is no write and stops nothing", async () => {
  const h = await harness([[
    { unasked: { kind: "other", title: "Run mcp_deskfolk_note", rawInput: { text: "hello", toolSummary: "Record note" }, holdMs: 50 } },
    { say: "记好了" },
  ]], { permissionMode: "read_only" });
  await h.post("记一下");
  expect(h.failKind()).toBeUndefined();
  expect(h.lines("bot")).toEqual(["记好了"]);
}, 30_000);

test("an agy older than 1.5.4 is never started: the turn fails as too old, naming the version it needs", async () => {
  const h = await harness([[{ say: "x" }]], { version: "1.4.2" });
  await h.post("hi");
  expect(h.failKind()).toBe("agent_outdated");
  const failure = h.lines("system").join("\n");
  expect(failure).toContain("Antigravity");
  expect(failure).toContain("1.5.4");
  expect(h.seen()).toEqual([]);
});

test("a built-in call on Antigravity answers once with no tools, and an agy too old for it is unavailable", async () => {
  const { createAgentJudge } = await import("./agents/judge");
  const store = new Store({ endpointKey: memoryKeyStore() });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-agy-judge-")));
  const judgeFor = (version: string, prompts: Step[][]) => createAgentJudge({
    store,
    drivers: { antigravity: agyDriver({ version: async () => version }) },
    resolve: async () => ({ ok: true, executable: process.execPath, source: "known", args: [FAKE], proxy: null,
      env: { ...process.env as Record<string, string>, FAKE_ACP_SCRIPT: JSON.stringify({ prompts, http: false, newSession: { result: AGY_SESSION } }), FAKE_ACP_LOG: join(root, "judge.log") } }),
  });
  const target = { kind: "agent" as const, runner: "antigravity" as const, customId: null, label: "Antigravity", model: "gemini-3.8-flash-low", configDir: null, effort: null };
  try {
    const answered = await judgeFor("1.5.6", [[{ say: "{\"kind\":\"chat\"}" }]])({ target, system: "Read the line.", prompt: "你好", signal: new AbortController().signal });
    expect(answered).toMatchObject({ content: "{\"kind\":\"chat\"}", fail: null });
    const created = readFileSync(join(root, "judge.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.method === "session/new");
    expect(created.params.mcpServers).toEqual([]);
    const old = await judgeFor("1.5.3", [[{ say: "x" }]])({ target, system: "s", prompt: "p", signal: new AbortController().signal });
    expect(old.fail).toBe("claude_unavailable");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("agy is launched as `agy acp`, and its version decides whether a turn may start", () => {
  expect(AGENT_LAUNCH.antigravity.args).toEqual(["acp"]);
  expect(agyServesAcp("1.5.4")).toBe(true);
  expect(agyServesAcp("agy version 1.5.6\n")).toBe(true);
  expect(agyServesAcp("1.10.0")).toBe(true);
  expect(agyServesAcp("1.5.3")).toBe(false);
  expect(agyServesAcp("")).toBe(false);
  expect(agyTooOld("1.5.6", "zh")).toBeNull();
  expect(agyTooOld("1.4.2", "zh")).toBe("agy 1.4.2：Antigravity 的 Bot 需要 1.5.4 或更高");
  expect(agyTooOld("", "en")).toBe("agy of an unknown version: Antigravity Bots need 1.5.4 or later");
  // The quota floor reads the same way.
  expect(agyAnswersQuota("1.1.11")).toBe(true);
  expect(agyAnswersQuota("1.1.10")).toBe(false);
});

test("a prompt agy ends with only its own ⚠ line fails the turn instead of posting it; a turned-off account is left to you", async () => {
  const h = await harness([[{ say: "\n⚠ Agent execution terminated due to error.\n" }]]);
  await h.post("hi");
  expect(h.lines("bot")).toEqual([]);
  expect(h.failKind()).toBe("agent_exited");
  expect(h.lines("system").join("\n")).toContain("Agent execution terminated due to error.");

  const off = await harness([[{ say: "\n⚠ This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.\n" }]]);
  await off.post("hi");
  expect(off.lines("bot")).toEqual([]);
  expect(off.failKind()).toBe("agent_signed_out");

  // The model's own words that merely start with the sign are a reply.
  expect(agyFailure("⚠ 注意：这个脚本会删文件。\n下面是改法：…")).toBeNull();
  expect(agyFailure("好的")).toBeNull();
  expect(agyFailure("\n⚠ Agent execution terminated due to error.\n")).toBe("Agent execution terminated due to error.");
  // A model out of capacity: one line per retry, the last one says what to do.
  expect(agyFailure("\n⚠ API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-low on the server\n\n⚠ Our servers are experiencing high traffic right now, please try again in a minute.\n\n"))
    .toBe("Our servers are experiencing high traffic right now, please try again in a minute.");
}, 30_000);
