/**
 * Project sessions on Grok (ADR 0115), through the local API: a stand-in `grok agent stdio`
 * (`fixtures/agents/fake-grok.ts`) plays one script per process the app starts — each run's, and
 * each listing, read or `/` list — and logs what it was sent and how it was answered.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { estimateAgentCost } from "./agents/agent-prices";
import { PLAN_APPROVAL_KIND, type AgentReplay, type AgentRun, type AgentSessionList, type AgentTaskDetail, type ClaudeCodeCommandList, type SessionDetail, type ToolFrame } from "@real-bot/protocol";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import { validateBusiness } from "./remote/routes";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const FAKE = join(import.meta.dir, "fixtures", "agents", "fake-grok.ts");
const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

type Script = Record<string, unknown> & { prompts: unknown[][] };
type Entry = Record<string, unknown> & { method?: string; params?: Record<string, unknown>; notification?: string; hook?: string; answer?: Record<string, unknown>; env?: { GROK_HOME: string | null } };

function start(scripts: Script[], opts: { holdMs?: number; billing?: { percent: number | null; end: number | null } } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "grok-project-")));
  const logDir = realpathSync(mkdtempSync(join(tmpdir(), "grok-project-log-")));
  const store = new Store({ endpointKey: memoryKeyStore() });
  let runs = 0;
  const frames: ToolFrame[] = [];
  const api = createLocalApi({
    store, token: "grok-test", schedule: false, projectSettleMs: 80,
    ...(opts.holdMs !== undefined ? { projectGrokHoldMs: opts.holdMs } : {}),
    ...(opts.billing ? { projectGrokBilling: async () => opts.billing! } : {}),
    projectGrok: async (configDir) => {
      const index = runs++;
      return {
        ok: true, executable: process.execPath, source: "known", args: [FAKE, "agent", "--no-leader", "stdio"], proxy: null,
        env: {
          ...process.env as Record<string, string>, FAKE_GROK_SCRIPT: JSON.stringify(scripts[index] ?? { prompts: [] }), FAKE_GROK_LOG: join(logDir, `run-${index}.log`),
          ...(configDir ? { GROK_HOME: configDir } : {}),
        },
      };
    },
  });
  api.subscribeTools((frame) => frames.push(frame));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => {
    api.projects.close();
    await api.projects.idle();
    await api.engine.close();
    store.close();
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });
  const origin = `http://${server.hostname}:${server.port}`;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { Authorization: "Bearer grok-test", "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": ulid() }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const open = async (extra: Record<string, unknown> = {}) => {
    const made = await call<SessionDetail>("POST", "/v1/project-sessions", { agent: "grok", dir, ...extra });
    expect(made.status).toBe(201);
    return made.body.id;
  };
  const say = (sessionId: string, body: string) => call<{ id: string }>("POST", `/v1/sessions/${sessionId}/messages`, { body });
  const run = async (sessionId: string) => (await call<{ run: AgentRun | null }>("GET", `/v1/project-sessions/${sessionId}/run`)).body.run;
  const until = async (check: () => Promise<boolean> | boolean, tries = 600) => {
    for (let i = 0; i < tries; i += 1) {
      if (await check()) return;
      await Bun.sleep(10);
    }
    throw new Error("timed out");
  };
  const settled = (sessionId: string) => until(async () => ["completed", "failed", "stopped"].includes((await run(sessionId))?.status ?? ""));
  const log = (index: number): Entry[] => {
    const file = join(logDir, `run-${index}.log`);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry) : [];
  };
  const sent = (index: number, method: string) => log(index).filter((entry) => entry.method === method && entry.params).map((entry) => entry.params!);
  const hooks = (index: number) => log(index).filter((entry) => entry.hook);
  const lines = (sessionId: string) => store.db
    .query<{ kind: string; author: string; body: string }, [string]>(`SELECT kind, author, body FROM messages WHERE session_id = ? ORDER BY message_seq`).all(sessionId);
  const spend = (sessionId: string) => store.db
    .query<{ provider_name: string; cost_usd_ticks: number | null; estimated_cost_usd_ticks: number | null; input_tokens: number; model: string | null }, [string]>(
      `SELECT provider_name, cost_usd_ticks, estimated_cost_usd_ticks, input_tokens, model FROM spend WHERE session_id = ? ORDER BY rowid`).all(sessionId);
  return { store, api, dir, frames, call, open, say, run, until, settled, log, sent, hooks, lines, spend };
}

test("a Grok session: your own Grok in its directory, every call held by the app's hook; later lines resume its session", async () => {
  const h = start([{ prompts: [[{ tool: { name: "read_file", input: { target_file: "a.txt" } } }, { say: "Hello " }, { say: "there." }]] }, { prompts: [[{ say: "Again." }]] }]);
  const id = await h.open();
  await h.say(id, "hi");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("completed");
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "bot", body: "Hello there." });
  // `grok agent --no-leader stdio`, offered no file system and no terminal, in the session's directory, the hook registered.
  expect(h.log(0)[0]?.argv).toEqual(["agent", "--no-leader", "stdio"]);
  expect(h.log(0)[0]?.cwd).toBe(h.dir);
  expect(h.sent(0, "initialize")[0]).toMatchObject({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const opened = h.sent(0, "session/new")[0]!;
  expect(opened).toMatchObject({ cwd: h.dir, mcpServers: [], _meta: { "x.ai/hooks": { pre_tool_use: [{ matcher: "*", hookCallbackIds: ["deskfolk"], timeout: 600 }] } } });
  expect(h.hooks(0).map((entry) => [entry.hook, entry.answer?.decision])).toEqual([["read_file", "continue"]]);
  expect(h.sent(0, "session/prompt")[0]?._meta).toEqual({ mode: "agent" });
  // Its read is on the task map, as the other agents' are.
  expect(h.frames.filter((frame) => frame.phase === "started").map((frame) => frame.name)).toEqual(["Read"]);
  const agentSession = h.store.projectOf(id)!.agentSession!;
  expect(agentSession).toMatch(/^grok-session-/);
  await h.say(id, "again");
  await h.settled(id);
  expect(h.sent(1, "session/new")).toEqual([]);
  expect(h.sent(1, "session/resume")[0]).toMatchObject({ sessionId: agentSession, _meta: { "x.ai/hooks": { pre_tool_use: [{ hookCallbackIds: ["deskfolk"] }] } } });
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "bot", body: "Again." });
  // Each turn's price as Grok reports it, under Grok, the model its usage names.
  expect(h.spend(id).map((row) => [row.provider_name, row.cost_usd_ticks, row.model])).toEqual([["Grok", 12_345_000, "grok-4.7-build"], ["Grok", 12_345_000, "grok-4.7-build"]]);
});

test("a turn Grok gives no price for is estimated from the model's public price", async () => {
  const h = start([{ noCost: true, prompts: [[{ say: "ok" }]] }]);
  const id = await h.open();
  await h.say(id, "hi");
  await h.settled(id);
  // grok-4.7's public price, the model its usage names (`grok-4.7-build`).
  const estimate = estimateAgentCost("grok-4.7", { inputTokens: 1000, outputTokens: 50, cachedTokens: 400 });
  expect(estimate).toBeGreaterThan(0);
  expect(h.spend(id).map((row) => [row.cost_usd_ticks, row.estimated_cost_usd_ticks])).toEqual([[null, estimate]]);
});

test("under ask first a change waits on your card before it runs; refused, Grok reads why; its credentials are refused outright", async () => {
  const auth = join(homedir(), ".grok", "auth.json");
  const h = start([{ prompts: [[
    { tool: { name: "write", input: { file_path: "notes.md", content: "x" } } },
    { tool: { name: "run_terminal_command", input: { command: "npm test" } } },
    { tool: { name: "read_file", input: { target_file: auth } } },
    { say: "done" },
  ]] }]);
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = await h.open();
  await h.say(id, "go");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  let card = (await h.run(id))!;
  expect(card.approval).toMatchObject({ kind_key: "file-write" });
  expect(h.hooks(0)).toEqual([]);
  expect((await h.call("POST", `/v1/agent-runs/${card.id}/approve`)).status).toBe(200);
  await h.until(async () => (await h.run(id))?.approval?.kind_key === "shell");
  card = (await h.run(id))!;
  expect(card.approval).toMatchObject({ kind_key: "shell", summary: "shell npm test" });
  expect((await h.call("POST", `/v1/agent-runs/${card.id}/deny`)).status).toBe(200);
  await h.settled(id);
  expect(h.hooks(0).map((entry) => [entry.hook, entry.answer?.decision])).toEqual([["write", "continue"], ["run_terminal_command", "deny"], ["read_file", "deny"]]);
  expect(h.hooks(0)[1]?.answer?.reason).toBe("用户没有批准这一步");
  expect(String(h.hooks(0)[2]?.answer?.reason)).toContain("off limits");
});

test("a card left past Grok's hook time tells Grok the call waits; approved later, its next try goes through and it is told so", async () => {
  const h = start([{ prompts: [
    [{ tool: { name: "run_terminal_command", input: { command: "make deploy" } } }, { say: "waiting for approval" }],
    [{ tool: { name: "run_terminal_command", input: { command: "make deploy" } } }, { say: "deployed" }],
  ] }], { holdMs: 60 });
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = await h.open();
  await h.say(id, "deploy it");
  await h.until(() => h.hooks(0).length === 1);
  expect(h.hooks(0)[0]?.answer).toMatchObject({ decision: "deny", reason: "这一步在等用户批准，还没批；收到批准的消息之前不要再试" });
  await h.until(() => h.lines(id).some((line) => line.body === "waiting for approval"));
  const card = (await h.run(id))!;
  expect(card).toMatchObject({ status: "waiting_approval", idle: false });
  expect(card.approval).toMatchObject({ kind_key: "shell" });
  expect((await h.call("POST", `/v1/agent-runs/${card.id}/approve`)).status).toBe(200);
  await h.until(() => h.lines(id).some((line) => line.body === "deployed"));
  // Told, then let through without another card.
  expect(JSON.stringify(h.sent(0, "session/prompt")[1]?.prompt)).toContain("用户现在批准了");
  expect(h.hooks(0).map((entry) => entry.answer?.decision)).toEqual(["deny", "continue"]);
});

test("work Grok would schedule past its reply is refused with the reason; hidden commands are not sent", async () => {
  const h = start([{ prompts: [[{ tool: { name: "scheduler_create", input: { interval: "10m" } } }, { say: "ok" }]] }]);
  const id = await h.open();
  await h.say(id, "/loop 5m check");
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "system" });
  expect(h.lines(id).at(-1)?.body).toContain("/loop 没有发出");
  expect(await h.run(id)).toBeNull();
  await h.say(id, "keep checking");
  await h.settled(id);
  expect(h.hooks(0)[0]).toMatchObject({ hook: "scheduler_create", answer: { decision: "deny" } });
  // The `/` list leaves out what is not sent.
  const listed = await h.call<ClaudeCodeCommandList>("GET", `/v1/project-sessions/${id}/commands`);
  expect(listed.body.commands.map((command) => command.name)).toEqual(["compact"]);
});

test("in plan mode its plan is a card: a line sent while it waits goes back as the change; approved, plan mode goes off", async () => {
  const h = start([{ prompts: [[{ plan: "# Plan\n\n1. first" }, { plan: "# Plan\n\n1. first\n2. tests" }, { say: "Built it." }]] }]);
  const id = await h.open();
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { mode: "plan" })).status).toBe(200);
  await h.say(id, "add tests");
  await h.until(async () => (await h.run(id))?.approval?.kind_key === PLAN_APPROVAL_KIND);
  expect(h.sent(0, "session/prompt")[0]?._meta).toEqual({ mode: "plan" });
  expect((await h.run(id))!.approval).toMatchObject({ summary: "# Plan\n\n1. first" });
  await h.say(id, "also add tests");
  await h.until(async () => (await h.run(id))?.approval?.summary === "# Plan\n\n1. first\n2. tests");
  const card = (await h.run(id))!;
  expect((await h.call("POST", `/v1/agent-runs/${card.id}/approve`)).status).toBe(200);
  await h.settled(id);
  expect(h.log(0).filter((entry) => entry.plan).map((entry) => entry.answer)).toEqual([{ outcome: "cancelled", feedback: "also add tests" }, { outcome: "approved" }]);
  expect(h.store.projectOf(id)?.mode).toBeNull();
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "bot", body: "Built it." });
});

test("its questions are cards it waits on, answered by the question's own words", async () => {
  const h = start([{ prompts: [[{ question: [{ question: "Tone?", options: ["Formal", "Casual"] }] }, { say: "Formal it is." }]] }]);
  const id = await h.open();
  await h.say(id, "write a readme");
  await h.until(async () => ((await h.run(id))?.asks ?? []).length === 1);
  const ask = (await h.call<{ items: Array<{ id: string; kind: string; body: string }> }>("GET", `/v1/sessions/${id}/messages`)).body.items.find((line) => line.kind === "ask")!;
  expect(ask.body).toContain("Tone?");
  expect((await h.call("POST", `/v1/messages/${ask.id}/answer`, { selected: ["Formal"], custom: "but warm" })).status).toBe(200);
  await h.settled(id);
  expect(h.log(0).find((entry) => entry.question)?.answer).toEqual({ outcome: "accepted", answers: { "Tone?": ["Formal", "but warm"] } });
});

test("a background command keeps the run open and idle; its end and what Grok then says by itself are kept; one can be stopped alone", async () => {
  const h = start([{ prompts: [[
    { background: { command: "sleep 1 && echo done-sleeping", id: "task-short", after: 150, output: "done-sleeping\n", wake: "The sleep finished." } },
    { background: { command: "sleep 600", id: "task-long", after: 600_000 } },
    { say: "Started both." },
  ]] }]);
  const id = await h.open();
  await h.say(id, "run them");
  await h.until(() => h.lines(id).some((line) => line.body === "Started both."));
  const going = (await h.run(id))!;
  expect(going.idle).toBe(true);
  expect(going.tasks?.map((task) => [task.id, task.kind, task.status, task.command])).toEqual([["task-short", "shell", "running", "sleep 1 && echo done-sleeping"], ["task-long", "shell", "running", "sleep 600"]]);
  await h.until(() => h.lines(id).some((line) => line.body === "The sleep finished."));
  expect((await h.run(id))!.tasks?.find((task) => task.id === "task-short")).toMatchObject({ status: "completed" });
  const tasks = await h.call<{ tasks: Array<{ id: string; output?: string | null }> }>("GET", `/v1/project-sessions/${id}/tasks`);
  expect(tasks.body.tasks.find((task) => task.id === "task-short")?.output).toContain("done-sleeping");
  // Ended alone: Grok kills that one, the run then closes.
  expect((await h.call("POST", `/v1/agent-runs/${going.id}/tasks/task-long/stop`)).status).toBe(200);
  await h.settled(id);
  expect(h.sent(0, "_x.ai/task/kill")[0]).toMatchObject({ taskId: "task-long" });
  expect((await h.run(id))!.tasks?.find((task) => task.id === "task-long")).toMatchObject({ status: "failed" });
  expect((await h.run(id))!.status).toBe("completed");
});

test("a subagent is a task with its own calls through the hook; opened, its steps are read from Grok; it can be cancelled alone", async () => {
  const child = "child-1";
  const h = start([
    { prompts: [[{ subagent: { child, description: "Look around", calls: [{ name: "list_dir", input: { target_directory: "." } }], after: 100, output: "found it", wake: "The subagent is back." } }, { subagent: { child: "child-2", description: "Slow one", after: 600_000 } }, { say: "Sent them." }]] },
    { prompts: [], children: { [child]: [
      { timestamp_us: 1795018958565806, method: "session/update", params: { sessionId: child, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "List the files" }, _meta: { modelId: "grok-4.7" } } } },
      { timestamp_us: 1795018961096664, method: "session/update", params: { sessionId: child, update: { sessionUpdate: "tool_call", toolCallId: "c-1", title: "list_dir", rawInput: { target_directory: "." } } } },
      { timestamp_us: 1795018961105406, method: "session/update", params: { sessionId: child, update: { sessionUpdate: "tool_call_update", toolCallId: "c-1", status: "completed", title: "List `.`" } } },
      { timestamp_us: 1795018963514251, method: "session/update", params: { sessionId: child, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Two files." } } } },
    ] } },
  ]);
  const id = await h.open();
  await h.say(id, "explore");
  await h.until(() => h.lines(id).some((line) => line.body === "The subagent is back."));
  const run = (await h.run(id))!;
  expect(run.tasks?.find((task) => task.id === child)).toMatchObject({ kind: "subagent", status: "completed", description: "Look around", agent_type: "general-purpose", summary: "found it" });
  expect(h.hooks(0).find((entry) => entry.hook === "list_dir")).toMatchObject({ sessionId: child, answer: { decision: "continue" } });
  // On the task map, the subagent's call is its own.
  expect(h.frames.find((frame) => frame.phase === "started" && frame.agent_run?.agent_id === child)).toBeTruthy();
  const detail = await h.call<AgentTaskDetail>("GET", `/v1/agent-runs/${run.id}/tasks/${child}`);
  expect(detail.body).toMatchObject({ prompt: "List the files", model: "grok-4.7" });
  expect(detail.body.steps.map((step) => (step.kind === "say" ? ["say", step.text] : ["call", step.tool, step.ok]))).toEqual([["call", "list_dir", true], ["say", "Two files."]]);
  expect((await h.call("POST", `/v1/agent-runs/${run.id}/tasks/child-2/stop`)).status).toBe(200);
  await h.settled(id);
  expect(h.sent(0, "_x.ai/subagent/cancel")[0]).toEqual({ subagentId: "child-2" });
  expect((await h.run(id))!.tasks?.find((task) => task.id === "child-2")).toMatchObject({ status: "stopped" });
  // The subagents' own turns are spent too, and the turn Grok took when one came back.
  expect(h.spend(id).length).toBe(4);
});

test("a terminal Grok session is listed, read with its own times, and carried on as a branch: yours stays as it was", async () => {
  const at = Date.parse("2026-11-18T10:00:00Z");
  const scripts: Script[] = [];
  const h = start(scripts);
  // Grok keeps a session under the directory as it was spelled then (`/tmp` for `/private/tmp`): here a link to it.
  const spelled = join(realpathSync(mkdtempSync(join(tmpdir(), "grok-link-"))), "project");
  symlinkSync(h.dir, spelled);
  closes.push(() => rmSync(dirname(spelled), { recursive: true, force: true }));
  const session = {
    sessionId: "term-1", cwd: spelled, title: "Fix the parser", updatedAt: "2026-11-18T10:05:00Z",
    history: [{ user: "Remember HERON", at }, { agent: "OK", at: at + 2000 }, { tool: { name: "read_file", input: { target_file: "a.txt" } }, at: at + 3000 }],
  };
  // A Bot's session sits in the workspace: not yours to carry on.
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "grok-workspace-")));
  closes.push(() => rmSync(workspace, { recursive: true, force: true }));
  h.store.patchSettings({ workspace_path: workspace });
  const workspaceOne = { sessionId: "bot-1", cwd: workspace, updatedAt: "2026-11-18T09:00:00Z", history: [] };
  scripts.push({ sessions: [session, workspaceOne], prompts: [] }, { sessions: [session], prompts: [] }, { sessions: [session], prompts: [[{ say: "HERON" }]] });
  const listed = await h.call<AgentSessionList>("GET", "/v1/runtime/agents/grok/sessions");
  expect(listed.body.items.map((item) => [item.session_id, item.title, item.agent, item.config_dir])).toEqual([["term-1", "Fix the parser", "grok", null]]);
  const made = await h.call<SessionDetail>("POST", "/v1/project-sessions", { agent: "grok", import: { session_id: "term-1", config_dir: null } });
  expect(made.status).toBe(201);
  const id = made.body.id;
  const imported = h.lines(id);
  expect(imported.slice(0, 2).map((line) => line.body)).toEqual(["Remember HERON", "OK"]);
  expect(imported.at(-1)?.body).toContain("Grok 记得这些全部内容；终端里的原会话不受影响");
  expect(imported.at(-1)?.body).toContain("1 次工具调用没有列出");
  await h.say(id, "what was the word?");
  await h.settled(id);
  // Branched by the session's own directory spelling, then resumed: never the terminal's own.
  expect(h.sent(2, "_x.ai/session/fork").map((params) => params.sourceCwd)).toEqual([h.dir, spelled]);
  const fork = h.store.projectOf(id)!.agentSession!;
  expect(fork).toMatch(/^grok-fork-/);
  expect(h.sent(2, "session/resume")[0]).toMatchObject({ sessionId: fork });
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "bot", body: "HERON" });
  // A session with no title of its own is named by its first line.
  const untitled = { ...session, sessionId: "term-2", title: undefined };
  scripts.push({ sessions: [untitled], prompts: [] });
  const second = await h.call<SessionDetail>("POST", "/v1/project-sessions", { agent: "grok", import: { session_id: "term-2", config_dir: null } });
  expect(second.status).toBe(201);
  expect(h.lines(second.body.id).at(-1)?.body).toContain("从 Grok 会话「Remember HERON」接过来");
});

test("the replay is read from Grok with the times it wrote", async () => {
  const at = Date.parse("2026-11-18T10:00:00Z");
  const scripts: Script[] = [{ prompts: [[{ say: "ok" }]] }];
  const h = start(scripts);
  const id = await h.open();
  await h.say(id, "hi");
  await h.settled(id);
  const agentSession = h.store.projectOf(id)!.agentSession!;
  scripts.push({ prompts: [], sessions: [{ sessionId: agentSession, cwd: h.dir, updatedAt: "2026-11-18T10:05:00Z", history: [{ user: "hi", at }, { tool: { name: "run_terminal_command", input: { command: "npm test" } }, at: at + 1000 }, { agent: "ok", at: at + 4000 }] }] });
  const replay = await h.call<AgentReplay>("GET", `/v1/project-sessions/${id}/replay`);
  expect(replay.body.said).toEqual([{ kind: "say", at: new Date(at).toISOString(), text: "hi" }]);
  expect(replay.body.calls.map((call) => [call.tool, call.at, call.duration_ms, call.ok, call.action])).toEqual([["shell", new Date(at + 1000).toISOString(), 1500, true, "check"]]);
});

test("out of usage with the plan used up, the session moves to your other Grok account and goes on there, the conversation carried in", async () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), "grok-home-b-")));
  closes.push(() => rmSync(other, { recursive: true, force: true }));
  const end = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const scripts: Script[] = [
    { prompts: [[{ say: "first answer" }]] },
  ];
  const h = start(scripts, { billing: { percent: 100, end: Date.parse(end) } });
  h.store.setAgentConfigDirs("grok", [other]);
  const id = await h.open();
  await h.say(id, "one");
  await h.settled(id);
  const before = h.store.projectOf(id)!.agentSession!;
  scripts.push(
    { prompts: [[{ fail: { code: -32003, message: "Rate limited", data: "subscription:free-usage-exhausted" } }]] },
    // The next run, on the other account, cannot resume the session; it reads it from the default account and opens one anew.
    { gone: [before], prompts: [[{ say: "carried on" }]] },
    { prompts: [], sessions: [{ sessionId: before, cwd: h.dir, updatedAt: end, history: [{ user: "one", at: Date.now() - 10_000 }, { agent: "first answer", at: Date.now() - 9_000 }] }] },
  );
  await h.say(id, "two");
  await h.until(() => h.lines(id).some((line) => line.body === "carried on"));
  expect(h.store.projectOf(id)?.configDir).toBe(other);
  expect(h.store.accountsOut().map((row) => [row.runner, row.known])).toEqual([["grok", true]]);
  expect(h.lines(id).some((line) => line.kind === "system" && line.body.startsWith("Grok 账号") && line.body.includes("这个会话换到"))).toBe(true);
  expect(h.lines(id).some((line) => line.body.startsWith("这段对话从你的另一个 Grok 账号接了过来"))).toBe(true);
  expect(h.log(2)[0]?.env?.GROK_HOME).toBe(other);
  expect(JSON.stringify(h.sent(2, "session/prompt")[0]?.prompt)).toContain("first answer");
});

test("out of usage on your only account, the line says when it picks up and it does then", async () => {
  const end = Date.now() + 3_600_000;
  const h = start([{ prompts: [[{ fail: { code: -32003, message: "Rate limited", data: "subscription:free-usage-exhausted" } }]] }, { prompts: [[{ say: "back at it" }]] }], { billing: { percent: 100, end } });
  const id = await h.open();
  await h.say(id, "keep going");
  await h.settled(id);
  expect(h.lines(id).at(-1)?.body).toContain("Grok 的用量额度用完了");
  expect(h.store.projectResumes().map((row) => row.session_id)).toEqual([id]);
  h.api.projects.resumeAfterLimits?.(new Date(end + 120_000));
  await h.until(() => h.lines(id).some((line) => line.body === "back at it"));
  expect(JSON.stringify(h.sent(1, "session/prompt")[0]?.prompt)).toContain("keep going");
});

test("signed out, the line says how to sign in; a Grok without the hook is not started", async () => {
  const h = start([{ prompts: [] }, { hooks: false, prompts: [] }]);
  const signedOut = realpathSync(mkdtempSync(join(tmpdir(), "grok-signed-out-")));
  closes.push(() => rmSync(signedOut, { recursive: true, force: true }));
  h.store.setAgentConfigDirs("grok", [signedOut]);
  const id = await h.open({ config_dir: signedOut });
  await h.say(id, "hi");
  await h.settled(id);
  expect(h.lines(id).at(-1)?.body).toBe(`Grok 出错停下了：Grok 还没登录：在终端里运行 GROK_HOME=${signedOut} grok login`);
  const other = await h.open();
  await h.say(other, "hi");
  await h.settled(other);
  expect(h.lines(other).at(-1)?.body).toContain("grok update");
});

test("Grok's session listing is a route the phone may ask too", () => {
  expect(() => validateBusiness({ v: 1, id: ulid(), method: "GET", path: "/v1/runtime/agents/grok/sessions" })).not.toThrow();
});

test("in plan mode nothing changes but its plan: a write, a writing command and a subagent's write are refused, the plan file is not", async () => {
  const h = start([{ prompts: [[
    { tool: { name: "write", input: { file_path: "src/a.ts", content: "x" } } },
    { tool: { name: "run_terminal_command", input: { command: "echo x > out.txt" } } },
    { tool: { name: "run_terminal_command", input: { command: "git status" } } },
    { tool: { name: "write", input: { file_path: "/tmp/fake-grok-home/sessions/x/grok-session-1/plan.md", content: "# Plan" } } },
    { subagent: { child: "child-p", description: "Try a write", calls: [{ name: "write", input: { file_path: "b.ts", content: "y" } }], after: 20 } },
    { say: "planned" },
  ]] }]);
  h.store.patchSettings({ permission_mode: "read_only" });
  const id = await h.open();
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { mode: "plan" })).status).toBe(200);
  await h.say(id, "plan it");
  await h.until(() => h.hooks(0).length === 6);
  const decided = h.hooks(0).filter((entry) => entry.hook !== "spawn_subagent").map((entry) => [entry.hook, (entry.input as { file_path?: string; command?: string }).file_path ?? (entry.input as { command?: string }).command ?? "", entry.answer?.decision]);
  expect(decided).toEqual([
    ["write", "src/a.ts", "deny"],
    ["run_terminal_command", "echo x > out.txt", "deny"],
    // Reading is no change; under read-only the mode refuses every command anyway.
    ["run_terminal_command", "git status", "deny"],
    ["write", "/tmp/fake-grok-home/sessions/x/grok-session-1/plan.md", "continue"],
    ["write", "b.ts", "deny"],
  ]);
  expect(String(h.hooks(0)[0]?.answer?.reason)).toContain("计划模式开着");
  expect(String(h.hooks(0)[5]?.answer?.reason)).toContain("计划模式开着");
});

test("read-only refuses every change and command; a tool the app cannot tell is a change: asked first, refused read-only", async () => {
  const h = start([
    // An MCP server's tool as Grok 1.0.89 reaches it: looked up with search_tool, then the hook names it `<server>__<tool>`, its input wrapped.
    { prompts: [[{ tool: { name: "write", input: { file_path: "a.txt", content: "x" } } }, { tool: { name: "read_file", input: { target_file: "a.txt" } } }, { tool: { name: "search_tool", input: { query: "notes save" } } }, { tool: { name: "notes__save", input: { tool_name: "notes__save", tool_input: { text: "hi" } } } }, { say: "ok" }]] },
    { prompts: [[{ tool: { name: "notes__save", input: { tool_name: "notes__save", tool_input: { text: "hi" } } } }, { tool: { name: "use_skill", input: { name: "pdf" } } }, { say: "ok" }]] },
  ]);
  h.store.patchSettings({ permission_mode: "read_only" });
  const id = await h.open();
  await h.say(id, "go");
  await h.settled(id);
  expect(h.hooks(0).map((entry) => [entry.hook, entry.answer?.decision])).toEqual([["write", "deny"], ["read_file", "continue"], ["search_tool", "continue"], ["notes__save", "deny"]]);
  expect(String(h.hooks(0)[0]?.answer?.reason)).toContain("read-only");
  h.store.patchSettings({ permission_mode: "ask_first" });
  await h.say(id, "again");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  const card = (await h.run(id))!;
  expect(card.approval).toEqual({ kind_key: "tool", target: "mcp__notes__save", summary: "tool mcp__notes__save" });
  expect((await h.call("POST", `/v1/agent-runs/${card.id}/approve`)).status).toBe(200);
  await h.settled(id);
  // A skill changes nothing by being invoked.
  expect(h.hooks(1).map((entry) => [entry.hook, entry.answer?.decision])).toEqual([["notes__save", "continue"], ["use_skill", "continue"]]);
});

test("a permission Grok asks for by its own settings is answered allow-once, never an option it would keep", async () => {
  const h = start([{ prompts: [[{ perm: { name: "run_terminal_command", input: { command: "npm test" } } }, { say: "ok" }]] }]);
  h.store.patchSettings({ permission_mode: "allow_all" });
  const id = await h.open();
  await h.say(id, "test it");
  await h.settled(id);
  expect(h.log(0).find((entry) => entry.perm)?.answer).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
});

test("Stop cancels the prompt with its subagents, keeps what it had said, and answers a card waiting no", async () => {
  const h = start([{ prompts: [[{ say: "Working on it" }, { tool: { name: "run_terminal_command", input: { command: "make" } } }, { hang: true }]] }]);
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = await h.open();
  await h.say(id, "build");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  const run = (await h.run(id))!;
  expect((await h.call("POST", `/v1/agent-runs/${run.id}/stop`)).status).toBe(200);
  await h.settled(id);
  expect((await h.run(id))!.status).toBe("stopped");
  expect(h.lines(id).some((line) => line.kind === "bot" && line.body === "Working on it")).toBe(true);
  expect(h.hooks(0)[0]?.answer).toMatchObject({ decision: "deny" });
  await h.until(() => h.log(0).some((entry) => entry.notification === "session/cancel"));
  expect(h.log(0).find((entry) => entry.notification === "session/cancel")?.params).toMatchObject({ _meta: { cancelSubagents: true } });
});

test("the model and thinking level picked are set on Grok's session; a level the model lacks is left alone", async () => {
  const h = start([{ prompts: [[{ say: "ok" }]] }, { prompts: [[{ say: "ok" }]] }]);
  const id = await h.open();
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { model: "grok-4.7", effort: "xhigh" })).status).toBe(200);
  await h.say(id, "hi");
  await h.settled(id);
  expect(h.sent(0, "session/set_config_option").map((params) => [params.configId, params.value])).toEqual([["model", "grok-4.7"], ["reasoning_effort", "xhigh"]]);
  // grok-4.5 lists no xhigh: the model is set, the level is not.
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { model: "grok-4.5" })).status).toBe(200);
  await h.say(id, "again");
  await h.settled(id);
  expect(h.sent(1, "session/set_config_option").map((params) => [params.configId, params.value])).toEqual([["model", "grok-4.5"]]);
});
