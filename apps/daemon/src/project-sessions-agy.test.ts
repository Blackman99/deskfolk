/**
 * Project sessions on Antigravity (ADR 0111), through the local API: a stand-in `agy acp`
 * (`fixtures/agents/fake-agy.ts`) plays one script per process the app starts — each run's, and
 * each listing or read of your sessions — and logs what it was sent and how it was answered.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_APPROVAL_KIND, type AgentRun, type AgentSessionList, type ClaudeCodeCommandList, type SessionDetail, type ToolFrame } from "@real-bot/protocol";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import { mountedAgentMcp } from "./agent-mcp/bridge";
import { agyBrainDir } from "./project-runner-agy";
import { validateBusiness } from "./remote/routes";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const FAKE = join(import.meta.dir, "fixtures", "agents", "fake-agy.ts");
const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

type Script = Record<string, unknown> & { prompts: unknown[][] };
type Entry = Record<string, unknown> & { method?: string; params?: Record<string, unknown>; notification?: string; asked?: string; answer?: { outcome?: { optionId?: string } }; argv?: string[] };

function start(scripts: Script[], opts: { version?: string } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-project-")));
  const logDir = realpathSync(mkdtempSync(join(tmpdir(), "agy-project-log-")));
  const store = new Store({ endpointKey: memoryKeyStore() });
  let runs = 0;
  const frames: ToolFrame[] = [];
  const api = createLocalApi({
    store, token: "agy-test", schedule: false, projectSettleMs: 60,
    projectAgyVersion: async () => opts.version ?? "1.5.10",
    projectAgy: async () => {
      const index = runs++;
      return {
        ok: true, executable: process.execPath, source: "known", args: [FAKE, "acp"], proxy: null,
        env: { ...process.env as Record<string, string>, FAKE_AGY_SCRIPT: JSON.stringify(scripts[index] ?? { prompts: [] }), FAKE_AGY_LOG: join(logDir, `run-${index}.log`) },
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
      headers: { Authorization: "Bearer agy-test", "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": ulid() }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const open = async () => {
    const made = await call<SessionDetail>("POST", "/v1/project-sessions", { agent: "antigravity", dir });
    expect(made.status).toBe(201);
    return made.body.id;
  };
  const say = (sessionId: string, body: string) => call<{ id: string }>("POST", `/v1/sessions/${sessionId}/messages`, { body });
  const run = async (sessionId: string) => (await call<{ run: AgentRun | null }>("GET", `/v1/project-sessions/${sessionId}/run`)).body.run;
  const until = async (check: () => Promise<boolean> | boolean, tries = 500) => {
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
  const lines = (sessionId: string) => store.db
    .query<{ kind: string; author: string; body: string }, [string]>(`SELECT kind, author, body FROM messages WHERE session_id = ? ORDER BY message_seq`).all(sessionId);
  return { store, api, dir, frames, call, open, say, run, until, settled, log, sent, lines };
}

test("an Antigravity session: your own agy in its directory with the app's consult tool only; later lines resume its session", async () => {
  const h = start([{ prompts: [[{ say: "Hello " }, { say: "there." }]], commands: [{ name: "compact", description: "Compact" }] }, { prompts: [[{ say: "Again." }]] }]);
  const id = await h.open();
  await h.say(id, "hi");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("completed");
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "bot", body: "Hello there." });
  // `agy acp` with its terminal sandbox on, offered no file system and no terminal, in the session's directory.
  expect(h.log(0)[0]?.argv).toEqual(["acp", "--sandbox"]);
  expect(h.sent(0, "initialize")[0]).toMatchObject({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  expect(h.sent(0, "session/new")).toEqual([{ cwd: h.dir, mcpServers: [expect.objectContaining({ name: "deskfolk" })] }]);
  expect(h.store.projectOf(id)?.agentSession).toBe("agy-session-1");
  // Only your line goes: no instructions of the app's.
  expect(h.sent(0, "session/prompt")[0]).toEqual({ sessionId: "agy-session-1", prompt: [{ type: "text", text: "hi" }] });
  // The commands it offered are the session's `/` list now.
  const commands = await h.call<ClaudeCodeCommandList>("GET", `/v1/project-sessions/${id}/commands`);
  expect(commands.body.commands.map((one) => one.name)).toEqual(["compact"]);
  // Spend: tokens, under the run.
  const spend = h.store.db.query<{ provider_name: string; input_tokens: number }, []>(`SELECT provider_name, input_tokens FROM spend WHERE purpose = 'project'`).all();
  expect(spend).toEqual([{ provider_name: "Antigravity", input_tokens: 100 }]);

  await h.say(id, "more");
  await h.until(async () => (await h.run(id))?.status === "completed" && h.lines(id).at(-1)?.body === "Again.");
  expect(h.sent(1, "session/resume")).toEqual([{ sessionId: "agy-session-1", cwd: h.dir, mcpServers: [expect.objectContaining({ name: "deskfolk" })] }]);
  expect(h.sent(1, "session/new")).toEqual([]);
});

test("the model, level and plan mode reach agy's session; the account is refused", async () => {
  const h = start([{ prompts: [[{ say: "ok" }]] }]);
  const id = await h.open();
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { model: "gemini-3.8-flash-low", effort: "medium", mode: "plan" })).status).toBe(200);
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { config_dir: "/x" })).status).toBe(422);
  await h.say(id, "plan something");
  await h.settled(id);
  expect(h.sent(0, "session/set_model")).toEqual([{ sessionId: "agy-session-1", modelId: "gemini-3.8-flash-low" }]);
  expect(h.sent(0, "session/set_config_option")).toEqual([
    { sessionId: "agy-session-1", configId: "thought_level", value: "medium" },
    { sessionId: "agy-session-1", configId: "mode", value: "plan" },
  ]);
});

test("a call agy makes without asking is checked as it starts: the mode lets it through, or the turn stops there", async () => {
  const h = start([
    { prompts: [[{ tool: { kind: "edit", title: "note.txt", rawInput: { Path: "note.txt", Content: "x" } } }, { say: "Done." }]] },
    { prompts: [[{ tool: { kind: "edit", title: "note.txt", rawInput: { Path: "note.txt", Content: "x" }, holdMs: 30 } }, { say: "Done." }]] },
  ]);
  const id = await h.open();
  // Under auto it goes through, as a tool frame with where it works.
  await h.say(id, "write it");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("completed");
  expect(h.frames.filter((frame) => frame.name === "write_file").map((frame) => frame.phase)).toEqual(["started", "exited"]);
  // Under ask first it cannot be asked any more: the turn stops and says so.
  h.store.patchSettings({ permission_mode: "ask_first" });
  await h.say(id, "write it again");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("failed");
  expect(h.log(1).some((entry) => entry.notification === "session/cancel")).toBe(true);
  expect(h.lines(id).at(-1)?.body).toStartWith("Antigravity 没先问就做了「note.txt」");
});

test("a command that cds and builds elsewhere in its list may still keep a script in agy's own folder for the session", async () => {
  const brain = agyBrainDir("agy-session-1", homedir());
  const command = `cd /tmp && V=$(git rev-parse HEAD) && echo "$V" && python3 -c 'import pathlib; pathlib.Path("${brain}/scratch/deploy.sh").write_text("x")'`;
  const h = start([{ prompts: [[{ tool: { kind: "execute", title: "deploy", rawInput: { CommandLine: command } } }, { say: "Wrote it." }]] }]);
  const id = await h.open();
  await h.say(id, "deploy to test");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("completed");
  expect(h.log(0).some((entry) => entry.notification === "session/cancel")).toBe(false);
  expect(h.lines(id).at(-1)?.body).toBe("Wrote it.");
});

test("what agy asks about is answered by the rules, on a card under ask first", async () => {
  const h = start([{ prompts: [[{ ask: { kind: "execute", title: "npm test", rawInput: { CommandLine: "npm test" } } }, { say: "Tested." }]] }]);
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = await h.open();
  await h.say(id, "test it");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  const card = (await h.run(id))!;
  expect(card.approval).toMatchObject({ kind_key: "shell", summary: "shell npm test" });
  expect((await h.call("POST", `/v1/agent-runs/${card.id}/approve`)).status).toBe(200);
  await h.settled(id);
  expect(h.log(0).find((entry) => entry.asked)?.answer).toEqual({ outcome: { outcome: "selected", optionId: "yes" } } as never);
  expect(h.lines(id).at(-1)?.body).toBe("Tested.");
});

test("in plan mode its plan is a card: approved, plan mode goes off and agy is told to carry it out", async () => {
  // The plan goes into agy's own folder for its session, which no mode stops.
  const brain = agyBrainDir("agy-session-1", homedir());
  const h = start([{ prompts: [
    [{ tool: { kind: "edit", title: "plan", rawInput: { Path: join(brain, "plan.md"), Content: "# Plan\n\n1. do it", ArtifactMetadata: { RequestFeedback: true } } } }, { say: "Please review the plan." }],
    [{ say: "Carried out." }],
  ] }]);
  h.store.patchSettings({ permission_mode: "read_only" });
  const id = await h.open();
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { mode: "plan" })).status).toBe(200);
  await h.say(id, "plan it");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval" || (await h.run(id))?.status === "failed");
  const card = (await h.run(id))!;
  expect(card.status).toBe("waiting_approval");
  expect(card.approval).toMatchObject({ kind_key: PLAN_APPROVAL_KIND, summary: "# Plan\n\n1. do it" });
  expect(h.lines(id).at(-1)?.body).toBe("Please review the plan.");
  expect((await h.call("POST", `/v1/agent-runs/${card.id}/approve`)).status).toBe(200);
  await h.settled(id);
  expect(h.store.projectOf(id)?.mode).toBeNull();
  expect(h.sent(0, "session/prompt")[1]).toMatchObject({ prompt: [{ type: "text", text: "计划已批准，现在按计划去做。" }] });
  expect(h.lines(id).at(-1)?.body).toBe("Carried out.");
});

test("a command sent to the background keeps the run open as a task; its end and what agy says after it close the run", async () => {
  const h = start([{ afterSay: "It finished: done-sleeping.", prompts: [[{ tool: { kind: "execute", title: "sleep", rawInput: { CommandLine: "sleep 1 && echo done-sleeping", toolSummary: "Sleep in background" }, background: 150, output: "done-sleeping" } }, { say: "Started it." }]] }]);
  const id = await h.open();
  await h.say(id, "start it");
  await h.until(async () => (await h.run(id))?.idle === true);
  const going = (await h.run(id))!;
  expect(going.status).toBe("running");
  expect(going.tasks?.map((task) => [task.kind, task.status, task.description, task.command])).toEqual([["shell", "running", "Sleep in background", "sleep 1 && echo done-sleeping"]]);
  expect(h.lines(id).at(-1)?.body).toBe("Started it.");
  await h.settled(id);
  const over = (await h.run(id))!;
  expect(over.status).toBe("completed");
  expect(over.tasks?.[0]).toMatchObject({ status: "completed" });
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "bot", body: "It finished: done-sleeping." });
  // The finished command's output opens from the tasks list.
  const tasks = await h.call<{ tasks: Array<{ output?: string | null }> }>("GET", `/v1/project-sessions/${id}/tasks`);
  expect(tasks.body.tasks[0]?.output).toContain("done-sleeping");
});

test("a call agy makes by itself after a background command ended is checked too: one the mode refuses ends the run", async () => {
  const h = start([{ afterTool: { kind: "edit", title: "settings", rawInput: { Path: join(homedir(), ".claude", "zz-agy-test.json"), Content: "{}" } },
    prompts: [[{ tool: { kind: "execute", title: "sleep", rawInput: { CommandLine: "sleep 1" }, background: 100 } }, { say: "Started." }]] }]);
  const id = await h.open();
  await h.say(id, "start it");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("failed");
  expect(h.lines(id).at(-1)?.body).toStartWith("Antigravity 没先问就做了「settings」");
  expect(h.log(0).some((entry) => entry.notification === "session/cancel")).toBe(true);
});

test("a terminal agy session is listed without the app's own, carried on in that same session, and only once", async () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "agy-ws-")));
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "agy-term-")));
  closes.push(() => { rmSync(ws, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); });
  const sessions = [
    { sessionId: "term-1", cwd: elsewhere, title: "Fix the build", updatedAt: "2026-11-17T08:00:00Z", history: [{ user: "Fix the build" }, { tool: { kind: "execute", rawInput: { CommandLine: "npm run build" } } }, { agent: "Fixed it." }] },
    { sessionId: "bot-1", cwd: ws, title: "# 人设", updatedAt: "2026-11-17T09:00:00Z", history: [] },
    { sessionId: "bot-2", cwd: elsewhere, title: "# Profile", updatedAt: "2026-11-17T09:30:00Z", history: [] },
    { sessionId: "ws-1", cwd: join(ws, "sub"), title: "In the workspace", updatedAt: "2026-11-17T07:00:00Z", history: [] },
  ];
  mkdirSync(join(ws, "sub"));
  const h = start([{ sessions, prompts: [] }, { sessions, prompts: [] }, { sessions, prompts: [[{ say: "Still fixed." }]] }]);
  expect((await h.call("PATCH", "/v1/settings", { workspace_path: ws })).status).toBe(200);
  const listed = await h.call<AgentSessionList>("GET", "/v1/runtime/agents/antigravity/sessions?limit=10");
  expect(listed.body.items.map((item) => [item.session_id, item.title, item.agent])).toEqual([["term-1", "Fix the build", "antigravity"]]);

  const made = await h.call<SessionDetail>("POST", "/v1/project-sessions", { agent: "antigravity", import: { session_id: "term-1" } });
  expect(made.status).toBe(201);
  const id = made.body.id;
  expect(h.lines(id).map((line) => [line.kind, line.body])).toEqual([
    ["user", "Fix the build"],
    ["bot", "Fixed it."],
    ["system", "从 Antigravity 会话「Fix the build」接过来：上面 2 条，1 次工具调用没有列出。接着的是终端里同一个 Antigravity 会话：这里说的话在终端里也看得到，别在两边同时说。"],
  ]);
  expect(h.store.projectOf(id)).toMatchObject({ agentSession: "term-1", source: "term-1", dir: elsewhere });
  // Twice would be two sessions here writing one of agy's.
  expect((await h.call("POST", "/v1/project-sessions", { agent: "antigravity", import: { session_id: "term-1" } })).status).toBe(409);

  await h.say(id, "still?");
  await h.settled(id);
  expect(h.sent(2, "session/resume")).toEqual([{ sessionId: "term-1", cwd: elsewhere, mcpServers: [expect.objectContaining({ name: "deskfolk" })] }]);
  expect(h.lines(id).at(-1)?.body).toBe("Still fixed.");
  expect(() => validateBusiness({ v: 1, id: ulid(), method: "GET", path: "/v1/runtime/agents/antigravity/sessions" })).not.toThrow();
});

test("agy's own failure lines fail the run; Stop keeps what it had said; an agy too old is not started", async () => {
  const h = start([
    { prompts: [[{ say: "⚠ API error (attempt 1): UNAVAILABLE (code 503): No capacity\n⚠ Our servers are busy." }]] },
    { prompts: [[{ say: "Working on it…" }, { hang: true }]] },
  ]);
  const id = await h.open();
  await h.say(id, "go");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("failed");
  expect(h.lines(id).at(-1)?.body).toBe("Antigravity 出错停下了：Our servers are busy.");

  await h.say(id, "go again");
  await h.until(async () => (await h.run(id))?.partial === "Working on it…");
  const live = (await h.run(id))!;
  expect((await h.call("POST", `/v1/agent-runs/${live.id}/stop`)).status).toBe(200);
  await h.settled(id);
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "bot", body: "Working on it…" });
  await h.until(() => h.log(1).some((entry) => entry.notification === "session/cancel"));

  const old = start([{ prompts: [] }], { version: "agy 1.5.2" });
  const oldId = await old.open();
  await old.say(oldId, "hi");
  await old.settled(oldId);
  expect(old.lines(oldId).at(-1)?.body).toContain("1.5.4");
});

test("/compact goes to agy as it is and says it ran", async () => {
  const h = start([{ prompts: [[]] }]);
  const id = await h.open();
  await h.say(id, "/compact");
  await h.settled(id);
  expect(h.sent(0, "session/prompt")[0]).toMatchObject({ prompt: [{ type: "text", text: "/compact" }] });
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "system", body: "已执行 /compact：Antigravity 把之前的对话压成了摘要" });
  // A command names no session.
  expect((await h.call<SessionDetail>("GET", `/v1/sessions/${id}`)).body.name).toBeNull();
});

test("agy's questions (ask_question) are cards: answered by an option, several, or your words, agy reads them from its form", async () => {
  const h = start([{ prompts: [[
    { question: [{ question: "Which color?", options: ["red", "green", "blue"] }, { question: "Which sizes?", options: ["small", "medium", "large"], multi: true }] },
    { say: "Noted." },
  ]] }]);
  const id = await h.open();
  await h.say(id, "ask me");
  await h.until(async () => ((await h.run(id))?.asks ?? []).length === 2);
  // Forms are offered at the handshake, so agy sends its questions as one.
  expect(h.sent(0, "initialize")[0]).toMatchObject({ clientCapabilities: { elicitation: { form: {} } } });
  const asks = (await h.call<{ items: Array<{ id: string; kind: string; body: string; ask?: { options: Array<{ label: string }>; multi_select: boolean } | null }> }>("GET", `/v1/sessions/${id}/messages`)).body.items.filter((line) => line.kind === "ask").reverse();
  expect(asks.map((ask) => [ask.body, ask.ask?.options.map((option) => option.label), ask.ask?.multi_select])).toEqual([
    ["Which color?", ["red", "green", "blue"], false],
    ["Which sizes?", ["small", "medium", "large"], true],
  ]);
  expect((await h.call("POST", `/v1/messages/${asks[0]!.id}/answer`, { selected: ["green"], custom: "or teal" })).status).toBe(200);
  expect((await h.call("POST", `/v1/messages/${asks[1]!.id}/answer`, { selected: ["small", "large"] })).status).toBe(200);
  await h.settled(id);
  expect(h.log(0).find((entry) => "question" in entry)?.answer as unknown).toEqual({ action: "accept", content: { q1: "2", q1_other: "or teal", q2: ["1", "3"] } });
  // The question is its card: no step of its own on the record.
  expect(h.frames.some((frame) => frame.name.includes("ask_question"))).toBe(false);
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "bot", body: "Noted." });
});

test("a line typed while agy's question waits answers it in your words; Stop instead cancels the form", async () => {
  const h = start([
    { prompts: [[{ question: [{ question: "Which color?", options: ["red", "green"] }] }, { say: "ok" }]] },
    { prompts: [[{ question: [{ question: "Again?", options: ["yes", "no"] }] }, { say: "never" }]] },
  ]);
  const id = await h.open();
  await h.say(id, "ask me");
  await h.until(async () => ((await h.run(id))?.asks ?? []).length === 1);
  await h.say(id, "purple, really");
  await h.settled(id);
  expect(h.log(0).find((entry) => "question" in entry)?.answer as unknown).toEqual({ action: "accept", content: { q1_other: "purple, really" } });
  expect(h.sent(0, "session/prompt")).toHaveLength(1);

  await h.say(id, "again");
  await h.until(async () => ((await h.run(id))?.asks ?? []).length === 1);
  const stopped = await h.call<AgentRun>("POST", `/v1/agent-runs/${(await h.run(id))!.id}/stop`);
  expect(stopped.body).toMatchObject({ status: "stopped", asks: [] });
  await h.api.projects.idle();
  expect(h.log(1).find((entry) => "question" in entry)?.answer as unknown).toEqual({ action: "cancel" });
});

const CONSULT_CALL = { kind: "other", title: "Run mcp_deskfolk_consult", rawInput: { agent: "codex", message: "看看", toolSummary: "Ask Codex" } };

test("a session of yours gets the consult tool as a stdio server at session/new and again at session/resume (ADR 0116)", async () => {
  const h = start([{ prompts: [[{ say: "one" }]] }, { prompts: [[{ say: "two" }]] }]);
  const id = await h.open();
  await h.say(id, "hi");
  await h.settled(id);
  const mounted = (params: Record<string, unknown> | undefined) => {
    const servers = params?.mcpServers as Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }>;
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("deskfolk");
    expect(typeof servers[0]!.command).toBe("string");
    expect(Array.isArray(servers[0]!.args)).toBe(true);
    const names = servers[0]!.env.map((entry) => entry.name);
    expect(names).toContain("DESKFOLK_AGENT_MCP_URL");
    expect(names).toContain("DESKFOLK_AGENT_MCP_TOKEN");
  };
  mounted(h.sent(0, "session/new")[0]);
  await h.say(id, "more");
  await h.until(async () => h.lines(id).at(-1)?.body === "two");
  mounted(h.sent(1, "session/resume")[0]);
  // Each run's token goes with the run.
  await h.until(() => mountedAgentMcp() === 0);
});

test("the consult call passes under read-only, ask-first and plan mode, and is never taken for a shell command or a read", async () => {
  const step = [{ tool: { ...CONSULT_CALL, rawInput: { ...CONSULT_CALL.rawInput, command: "rm -rf /", path: "/etc/passwd" } } }, { say: "Done." }];
  const h = start([{ prompts: [step] }, { prompts: [step] }, { prompts: [step] }]);
  const id = await h.open();
  const asked = async (line: string, count: number) => {
    await h.say(id, line);
    await h.until(async () => h.lines(id).at(-1)?.body === "Done." && (await h.run(id))?.status === "completed" && h.log(count).length > 0);
  };
  h.store.patchSettings({ permission_mode: "read_only" });
  await asked("one", 0);
  h.store.patchSettings({ permission_mode: "ask_first" });
  await asked("two", 1);
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { mode: "plan" })).status).toBe(200);
  await asked("three", 2);
  for (const index of [0, 1, 2]) expect(h.log(index).some((entry) => entry.notification === "session/cancel")).toBe(false);
});

test("another MCP tool of yours is still read by what it names: under ask first, one that runs a command stops the turn", async () => {
  const h = start([{ prompts: [[{ tool: { kind: "other", title: "Run mcp_other_x", rawInput: { command: "rm -rf build" }, holdMs: 30 } }, { say: "Done." }]] }]);
  const id = await h.open();
  h.store.patchSettings({ permission_mode: "ask_first" });
  await h.say(id, "clean up");
  await h.settled(id);
  expect(h.log(0).some((entry) => entry.notification === "session/cancel")).toBe(true);
});

test("a consultant's agy opens with no tools, and a call of any MCP tool stops its turn", async () => {
  const h = start([{ prompts: [[{ tool: { kind: "other", title: "Run mcp_other_tool", rawInput: { a: 1 }, holdMs: 30 } }, { say: "Done." }]] }]);
  const parent = await h.open();
  const child = h.store.createConsultantSession({ parentId: parent, agent: "antigravity", model: null, effort: null, name: "参谋 · Antigravity" });
  const childId = child.id;
  await h.say(childId, "look at this");
  await h.settled(childId);
  expect(h.sent(0, "session/new")).toEqual([{ cwd: h.dir, mcpServers: [] }]);
  expect((await h.run(childId))?.status).toBe("failed");
  expect(h.log(0).some((entry) => entry.notification === "session/cancel")).toBe(true);
});

test("with the consultant switch on, the agent reads whom to ask after your line, and your line stays as typed (ADR 0116 addendum)", async () => {
  const h = start([{ prompts: [[{ say: "ok" }]] }]);
  const id = await h.open();
  h.store.tuneProjectSession(id, { consult: { on: true, members: [{ agent: "codex", model: "gpt-5.6-terra", effort: null }] } });
  await h.say(id, "看看方案");
  await h.settled(id);
  const blocks = h.sent(0, "session/prompt")[0]!.prompt as Array<{ type: string; text?: string }>;
  const text = blocks.find((block) => block.type === "text")?.text ?? "";
  expect(text).toStartWith("看看方案\n\n[参谋开着]");
  expect(text).toContain("1. Codex · gpt-5.6-terra —— 新请： agent=codex, model=gpt-5.6-terra");
  expect(h.lines(id)[0]!.body).toBe("看看方案");
});
