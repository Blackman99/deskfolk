/**
 * Project sessions on Codex (ADR 0099), through the local API: a stand-in app-server
 * (`fixtures/agents/fake-codex.ts`) plays one script per run against the Codex project runner and
 * logs what it was sent and how its approvals were answered.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReplay, AgentRun, ClientEvent, SessionDetail, ToolFrame } from "@real-bot/protocol";
import type { ClaudeCommandList } from "./claude-code/commands";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import { validateBusiness } from "./remote/routes";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const FAKE = join(import.meta.dir, "fixtures", "agents", "fake-codex.ts");

const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

type Step = Record<string, unknown>;
/** One app-server's script: each run of a session starts an app-server of its own. */
type Script = { signedOut?: boolean; model?: string; resumable?: string; turns: Step[][] };
type Entry = Record<string, unknown> & { method?: string; params?: Record<string, unknown>; asked?: string; answer?: { decision?: string } };

function start(scripts: Script[], opts: { claudeCommands?: ClaudeCommandList } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-project-")));
  const logDir = realpathSync(mkdtempSync(join(tmpdir(), "codex-project-log-")));
  const store = new Store({ endpointKey: memoryKeyStore() });
  let runs = 0;
  const api = createLocalApi({
    store, token: "codex-test", schedule: false,
    ...(opts.claudeCommands ? { claudeCommands: opts.claudeCommands } : {}),
    projectCodex: async () => {
      const index = runs++;
      return {
        ok: true, executable: process.execPath, source: "known", args: [FAKE], proxy: null,
        env: { ...process.env as Record<string, string>, FAKE_CODEX_SCRIPT: JSON.stringify(scripts[index] ?? { turns: [] }), FAKE_CODEX_LOG: join(logDir, `run-${index}.log`) },
      };
    },
  });
  const events: ClientEvent[] = [];
  api.subscribeSync((frame) => { if (frame.type === "event") events.push(frame.payload); });
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
      headers: { Authorization: "Bearer codex-test", "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": ulid() }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const open = async () => {
    const made = await call<SessionDetail>("POST", "/v1/project-sessions", { agent: "codex", dir });
    expect(made.status).toBe(201);
    return made.body.id;
  };
  const say = async (sessionId: string, body: string) => call<{ id: string }>("POST", `/v1/sessions/${sessionId}/messages`, { body });
  const run = async (sessionId: string) => (await call<{ run: AgentRun | null }>("GET", `/v1/project-sessions/${sessionId}/run`)).body.run;
  const until = async (check: () => Promise<boolean> | boolean, tries = 400) => {
    for (let i = 0; i < tries; i += 1) {
      if (await check()) return;
      await Bun.sleep(10);
    }
    throw new Error("timed out");
  };
  const settled = (sessionId: string) => until(async () => ["completed", "failed", "stopped"].includes((await run(sessionId))?.status ?? ""));
  /** What the app-server of run `index` was sent and answered. */
  const log = (index: number): Entry[] => {
    const file = join(logDir, `run-${index}.log`);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry) : [];
  };
  const sent = (index: number, method: string) => log(index).filter((entry) => entry.method === method && entry.params).map((entry) => entry.params!);
  const lines = (sessionId: string) => store.db
    .query<{ kind: string; author: string; body: string }, [string]>(`SELECT kind, author, body FROM messages WHERE session_id = ? ORDER BY created_at, id`).all(sessionId);
  return { store, api, dir, events, call, open, say, run, until, settled, log, sent, lines, origin };
}

test("a Codex session: your own Codex in its directory, asking before it acts; later lines resume its thread", async () => {
  const h = start([
    { model: "gpt-5.6-luna", turns: [[{ commentary: "先看一下" }, { say: "答一" }]] },
    { turns: [[{ say: "答二" }]] },
  ]);
  const id = await h.open();
  expect(h.store.getSession(id).project_agent).toBe("codex");
  await h.say(id, "你好");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("completed");

  // As in Codex's own app: your config, AGENTS.md and MCP servers, no instructions or tools of the app's.
  const opened = h.sent(0, "thread/start")[0]!;
  expect(opened).toMatchObject({ cwd: h.dir, approvalPolicy: "untrusted", sandbox: "read-only", ephemeral: false, serviceName: "deskfolk" });
  expect(opened.developerInstructions).toBeUndefined();
  expect(opened.dynamicTools).toBeUndefined();
  expect(opened.config).toBeUndefined();
  expect(opened.model).toBeUndefined();
  expect(h.sent(0, "turn/start")[0]).toMatchObject({ threadId: "thread-1", input: [{ type: "text", text: "你好" }] });
  expect(h.store.projectOf(id)?.agentSession).toBe("thread-1");
  expect(h.lines(id)).toEqual([
    { kind: "user", author: "user", body: "你好" },
    { kind: "bot", author: "agent", body: "答一" },
  ]);
  // What it said beside its work showed while the run went on.
  expect(h.events.some((event) => event.event === "agent_run.upsert" && event.partial === "先看一下")).toBe(true);
  expect(h.store.getSession(id).name).toBe("你好");

  await h.say(id, "再来");
  await h.until(() => h.lines(id).length === 4);
  await h.settled(id);
  expect(h.sent(1, "thread/start")).toEqual([]);
  expect(h.sent(1, "thread/resume")[0]).toMatchObject({ threadId: "thread-1", cwd: h.dir, approvalPolicy: "untrusted", sandbox: "read-only" });
  expect(h.lines(id).at(-1)).toEqual({ kind: "bot", author: "agent", body: "答二" });
});

test("under ask first a command waits on the run's card; approving runs it, denying reaches Codex as declined", async () => {
  const h = start([{ turns: [[{ command: "npm test" }, { command: "rm -rf build" }, { say: "好" }]] }]);
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = await h.open();
  await h.say(id, "跑测试");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  const first = (await h.run(id))!;
  expect(first.approval?.summary).toContain("npm test");
  expect((await h.call("POST", `/v1/agent-runs/${first.id}/approve`)).status).toBe(200);
  await h.until(async () => (await h.run(id))?.approval?.summary.includes("rm -rf build") ?? false);
  expect((await h.call("POST", `/v1/agent-runs/${first.id}/deny`)).status).toBe(200);
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("completed");
  expect(h.log(0).filter((entry) => entry.asked).map((entry) => [entry.asked, entry.answer?.decision])).toEqual([["npm test", "accept"], ["rm -rf build", "decline"]]);
});

test("read-only refuses a file change with no card; Codex's own sign-in is refused in any mode", async () => {
  const h = start([
    { turns: [[{ fileChange: "@CWD/a.txt" }, { say: "改不了" }]] },
    { turns: [[{ command: `cat ${join(homedir(), ".codex", "auth.json")}` }, { command: "ls" }, { say: "好" }]] },
  ]);
  h.store.patchSettings({ permission_mode: "read_only" });
  const id = await h.open();
  await h.say(id, "写个文件");
  await h.settled(id);
  expect(h.log(0).filter((entry) => entry.asked).map((entry) => entry.answer?.decision)).toEqual(["decline"]);
  expect(existsSync(join(h.dir, "a.txt"))).toBe(false);
  expect(h.events.some((event) => event.event === "agent_run.upsert" && event.status === "waiting_approval")).toBe(false);

  h.store.patchSettings({ permission_mode: "auto" });
  await h.say(id, "看看");
  await h.until(() => h.log(1).filter((entry) => entry.asked).length === 2);
  await h.settled(id);
  expect(h.log(1).filter((entry) => entry.asked).map((entry) => entry.answer?.decision)).toEqual(["decline", "accept"]);
});

test("Stop ends a run waiting on you; your next line resumes the thread in a new run", async () => {
  const h = start([{ turns: [[{ command: "npm test" }, { say: "不该到这" }]] }, { turns: [[{ say: "又来了" }]] }]);
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = await h.open();
  await h.say(id, "跑测试");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  const stopped = await h.call<AgentRun>("POST", `/v1/agent-runs/${(await h.run(id))!.id}/stop`);
  expect(stopped.body.status).toBe("stopped");
  await h.api.projects.idle();
  expect(h.lines(id).map((line) => line.body)).toEqual(["跑测试"]);

  await h.say(id, "接着");
  await h.until(() => h.lines(id).length === 3);
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("completed");
  expect(h.sent(1, "thread/resume")[0]).toMatchObject({ threadId: "thread-1" });
});

test("a line sent while a turn is going is steered into it", async () => {
  const h = start([{ turns: [[{ sleep: 400 }, { say: "两句都答了" }]] }]);
  const id = await h.open();
  await h.say(id, "第一句");
  await h.until(() => h.sent(0, "turn/start").length === 1);
  await h.say(id, "第二句");
  await h.settled(id);
  expect(h.sent(0, "turn/start")).toHaveLength(1);
  expect(h.sent(0, "turn/steer")[0]).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "第二句" }] });
  expect(h.lines(id).map((line) => line.body)).toEqual(["第一句", "第二句", "两句都答了"]);
});

test("a line's pictures reach Codex by their path, ahead of its words; any other file by its path", async () => {
  const h = start([{ turns: [[{ say: "红色" }]] }]);
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "codex-project-ws-")));
  closes.push(() => rmSync(ws, { recursive: true, force: true }));
  expect((await h.call("PATCH", "/v1/settings", { workspace_path: ws })).status).toBe(200);
  const id = await h.open();
  const form = new FormData();
  form.append("body", "这是什么颜色");
  form.append("files", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], "image.png", { type: "image/png" }));
  form.append("files", new File([new Uint8Array([1, 2])], "notes.txt", { type: "text/plain" }));
  const posted = await fetch(`${h.origin}/v1/sessions/${id}/messages`, { method: "POST", headers: { Authorization: "Bearer codex-test", "Idempotency-Key": ulid() }, body: form });
  expect(posted.status).toBe(201);
  const attachments = ((await posted.json()) as { attachments: Array<{ workspace_relpath: string }> }).attachments;
  await h.settled(id);
  const [picture, notes] = attachments.map((att) => join(ws, att.workspace_relpath));
  expect(h.sent(0, "turn/start")[0]!.input).toEqual([
    { type: "localImage", path: picture },
    { type: "text", text: `这是什么颜色\n\n附件：${notes}`, text_elements: [] },
  ]);
});

test("each command and file change reaches the windows as a tool frame with where it works", async () => {
  const h = start([{ model: "gpt-5.6-luna", turns: [[{ command: "bun test src/a.test.ts" }, { fileChange: "@CWD/src/a.ts" }, { say: "好" }]] }]);
  const frames: ToolFrame[] = [];
  h.api.subscribeTools((frame) => frames.push(frame));
  const id = await h.open();
  await h.say(id, "改一下");
  await h.settled(id);
  const runId = (await h.run(id))!.id;
  expect(frames.map((frame) => [frame.phase, frame.name, frame.turn_id === runId, frame.agent_run?.session_id === id])).toEqual([
    ["started", "shell", true, true], ["exited", "shell", true, true], ["started", "write_file", true, true], ["exited", "write_file", true, true],
  ]);
  expect(frames[0]).toMatchObject({ command: "bun test src/a.test.ts", agent_run: { agent_id: null, place: { zone: "check", check: "test" }, action: "check", model: "gpt-5.6-luna" } });
  expect(frames[1]).toMatchObject({ exit_code: 0, agent_run: { ok: true } });
  expect(frames[2]!.agent_run).toMatchObject({ place: { zone: "project", path: "src/a.ts" } });
  expect(frames[3]!.agent_run?.ok).toBe(true);
  expect(existsSync(join(h.dir, "src", "a.ts"))).toBe(true);
});

test("a failed turn says why in Codex's own words; a signed-out Codex says how to sign in", async () => {
  const unsupported = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." } });
  const h = start([{ turns: [[{ fail: { message: unsupported, codexErrorInfo: "other", errorNotice: true } }]] }, { signedOut: true, turns: [] }]);
  const id = await h.open();
  await h.say(id, "你好");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("failed");
  expect(h.lines(id).at(-1)).toEqual({ kind: "system", author: "app", body: "Codex 出错停下了：The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." });

  await h.say(id, "再试");
  await h.until(() => h.lines(id).length === 4);
  expect(h.lines(id).at(-1)?.body).toBe("Codex 出错停下了：Codex 还没登录：在终端里运行 codex login");
  expect(h.sent(1, "thread/resume")).toEqual([]);
});

test("a Codex session's model and level reach its next turn; what it has not got is refused, and its replay and commands are empty", async () => {
  const claudeCommands: ClaudeCommandList = { list: async () => { throw new Error("Claude Code is not asked for a Codex session"); } };
  const h = start([{ turns: [[{ say: "好" }]] }], { claudeCommands });
  const id = await h.open();
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { model: "gpt-5.6-luna", effort: "high" })).status).toBe(200);
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { effort: "ultra" })).status).toBe(422);
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { mode: "plan" })).status).toBe(422);
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { config_dir: null })).status).toBe(422);
  await h.say(id, "你好");
  await h.settled(id);
  expect(h.sent(0, "thread/start")[0]).toMatchObject({ model: "gpt-5.6-luna" });
  expect(h.sent(0, "turn/start")[0]).toMatchObject({ model: "gpt-5.6-luna", effort: "high" });

  const replay = await h.call<AgentReplay>("GET", `/v1/project-sessions/${id}/replay`);
  expect(replay.body).toEqual({ session_id: id, agent_session: "thread-1", source_session: null, calls: [], subagents: [], said: [] });
  const commands = await h.call<{ commands: unknown[]; error: string | null }>("GET", `/v1/project-sessions/${id}/commands`);
  expect(commands.body).toMatchObject({ commands: [], error: null });

  expect((await h.call("POST", "/v1/project-sessions", { agent: "codex", import: { session_id: "x" } })).status).toBe(422);
  expect((await h.call("POST", "/v1/project-sessions", { agent: "codex", dir: h.dir, config_dir: "/somewhere" })).status).toBe(422);
  expect((await h.call("POST", "/v1/project-sessions", { agent: "grok", dir: h.dir })).status).toBe(422);
  // The phone reaches the same route.
  expect(() => validateBusiness({ v: 1, id: ulid(), method: "POST", path: "/v1/project-sessions", body: { agent: "codex", dir: "/tmp/x" } })).not.toThrow();
});
