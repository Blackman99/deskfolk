/**
 * Project sessions on Codex (ADR 0099), through the local API: a stand-in app-server
 * (`fixtures/agents/fake-codex.ts`) plays one script per run against the Codex project runner and
 * logs what it was sent and how its approvals were answered.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReplay, AgentRun, ClaudeCodeCommandList, ClientEvent, SessionDetail, ToolFrame } from "@real-bot/protocol";
import { CODEX_BUILTIN_COMMANDS, type CodexCommandList } from "./agents/codex-commands";
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
type Script = { signedOut?: boolean; model?: string; resumable?: string; resumedUsage?: { input: number; output: number; cached: number; turnId: string }; skills?: Array<{ name: string; description: string; path: string }>; compactMs?: number; turns: Step[][] };
type Entry = Record<string, unknown> & { method?: string; params?: Record<string, unknown>; asked?: string; answer?: { decision?: string } };

function start(scripts: Script[], opts: { claudeCommands?: ClaudeCommandList; codexCommands?: CodexCommandList } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-project-")));
  const logDir = realpathSync(mkdtempSync(join(tmpdir(), "codex-project-log-")));
  const store = new Store({ endpointKey: memoryKeyStore() });
  let runs = 0;
  const api = createLocalApi({
    store, token: "codex-test", schedule: false,
    ...(opts.claudeCommands ? { claudeCommands: opts.claudeCommands } : {}),
    ...(opts.codexCommands ? { codexCommands: opts.codexCommands } : {}),
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

test("Stop keeps what Codex had said beside its work as its line", async () => {
  const h = start([{ turns: [[{ commentary: "先看一下" }, { commentary: "再跑测试" }, { hang: true }]] }]);
  const id = await h.open();
  await h.say(id, "跑测试");
  await h.until(async () => (await h.run(id))?.partial === "先看一下\n\n再跑测试");
  const stopped = await h.call<AgentRun>("POST", `/v1/agent-runs/${(await h.run(id))!.id}/stop`);
  expect(stopped.body).toMatchObject({ status: "stopped", partial: null });
  expect(h.lines(id)).toEqual([
    { kind: "user", author: "user", body: "跑测试" },
    { kind: "bot", author: "agent", body: "先看一下\n\n再跑测试" },
  ]);
  await h.api.projects.idle();
  // Codex winding down after the interrupt says nothing more on the record.
  expect(h.lines(id)).toHaveLength(2);
  expect((await h.run(id))).toMatchObject({ status: "stopped", partial: null });
});

test("a failed turn keeps what Codex had said, then says why", async () => {
  const h = start([{ turns: [[{ commentary: "先看一下" }, { fail: { message: "boom", codexErrorInfo: "other", errorNotice: true } }]] }]);
  const id = await h.open();
  await h.say(id, "你好");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("failed");
  expect(h.lines(id).map((line) => [line.kind, line.body])).toEqual([["user", "你好"], ["bot", "先看一下"], ["system", "Codex 出错停下了：boom"]]);
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

test("a Codex session's model and level reach its next turn; what it has not got is refused, its replay is empty, and `/` lists Codex's", async () => {
  const claudeCommands: ClaudeCommandList = { list: async () => { throw new Error("Claude Code is not asked for a Codex session"); } };
  const asked: string[] = [];
  const listed: ClaudeCodeCommandList = { commands: [...CODEX_BUILTIN_COMMANDS, { name: "pdf:pdf", description: "Read PDF files", argument_hint: "", aliases: [] }], checked_at: new Date().toISOString(), error: null };
  const codexCommands: CodexCommandList = { list: async (dir) => { asked.push(dir); return listed; } };
  const h = start([{ turns: [[{ say: "好" }]] }], { claudeCommands, codexCommands });
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
  const commands = await h.call<ClaudeCodeCommandList>("GET", `/v1/project-sessions/${id}/commands`);
  expect(commands.body).toEqual(listed);
  expect(asked).toEqual([h.dir]);

  expect((await h.call("POST", "/v1/project-sessions", { agent: "codex", import: { session_id: "x" } })).status).toBe(422);
  expect((await h.call("POST", "/v1/project-sessions", { agent: "codex", dir: h.dir, config_dir: "/somewhere" })).status).toBe(422);
  expect((await h.call("POST", "/v1/project-sessions", { agent: "grok", dir: h.dir })).status).toBe(422);
  // The phone reaches the same route.
  expect(() => validateBusiness({ v: 1, id: ulid(), method: "POST", path: "/v1/project-sessions", body: { agent: "codex", dir: "/tmp/x" } })).not.toThrow();
});

test("/compact compacts Codex's thread in a turn of its own and says it ran; a command names no session", async () => {
  const h = start([{ turns: [] }]);
  const id = await h.open();
  await h.say(id, "/compact");
  await h.settled(id);
  expect((await h.run(id))?.status).toBe("completed");
  expect(h.sent(0, "thread/compact/start")).toEqual([{ threadId: "thread-1" }]);
  expect(h.sent(0, "turn/start")).toEqual([]);
  expect(h.lines(id)).toEqual([
    { kind: "user", author: "user", body: "/compact" },
    { kind: "system", author: "app", body: "已执行 /compact：Codex 把之前的对话压成了摘要" },
  ]);
  expect(h.events.some((event) => event.event === "agent_run.upsert" && event.activity === "正在压缩上下文")).toBe(true);
  expect(h.store.getSession(id).name).toBeNull();
});

test("Stop interrupts a compaction by the turn Codex named for it", async () => {
  const h = start([{ compactMs: 5_000, turns: [] }]);
  const id = await h.open();
  await h.say(id, "/compact");
  await h.until(() => h.log(0).some((entry) => entry.method === "thread/compact/start"));
  await Bun.sleep(80);
  expect((await h.call<AgentRun>("POST", `/v1/agent-runs/${(await h.run(id))!.id}/stop`)).body.status).toBe("stopped");
  await h.until(() => h.sent(0, "turn/interrupt").length === 1);
  expect(h.sent(0, "turn/interrupt")[0]).toEqual({ threadId: "thread-1", turnId: expect.stringMatching(/^compact-/) });
});

test("/review reviews the uncommitted changes, or what you wrote after it: its commands run unasked, its findings are the reply", async () => {
  const h = start([
    { turns: [[{ unasked: "git diff" }, { say: "没发现问题" }]] },
    { turns: [[{ say: "add 用了减号" }]] },
  ]);
  h.store.patchSettings({ permission_mode: "auto" });
  const frames: ToolFrame[] = [];
  h.api.subscribeTools((frame) => frames.push(frame));
  const id = await h.open();
  await h.say(id, "/review");
  await h.settled(id);
  expect(h.sent(0, "review/start")).toEqual([{ threadId: "thread-1", target: { type: "uncommittedChanges" }, delivery: "inline" }]);
  expect(h.sent(0, "turn/start")).toEqual([]);
  expect(h.log(0).some((entry) => entry.asked)).toBe(false);
  expect(frames.map((frame) => [frame.phase, frame.name, frame.command])).toEqual([["started", "shell", "git diff"], ["exited", "shell", "git diff"]]);
  // Its findings are said once: the reply, not words beside its work as well.
  expect(h.events.some((event) => event.event === "agent_run.upsert" && event.partial === "没发现问题")).toBe(false);

  await h.say(id, "/review 看看 calc.py 的 add");
  await h.until(() => h.lines(id).length === 4);
  await h.settled(id);
  expect(h.sent(1, "review/start")).toEqual([{ threadId: "thread-1", target: { type: "custom", instructions: "看看 calc.py 的 add" }, delivery: "inline" }]);
  expect(h.lines(id).map((line) => [line.kind, line.body])).toEqual([
    ["user", "/review"], ["bot", "没发现问题"], ["user", "/review 看看 calc.py 的 add"], ["bot", "add 用了减号"],
  ]);
});

test("/review waits on one card under ask first and starts once approved; denied it says so; read-only refuses it", async () => {
  const h = start([{ turns: [[{ unasked: "git diff" }, { say: "好" }]] }, { turns: [] }, { turns: [] }]);
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = await h.open();
  await h.say(id, "/review");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  const card = (await h.run(id))!;
  expect(card.approval).toMatchObject({ kind_key: "codex-review", target: h.dir });
  expect(card.approval?.summary).toContain("review 未提交的改动");
  expect(h.sent(0, "review/start")).toEqual([]);
  expect((await h.call("POST", `/v1/agent-runs/${card.id}/approve`)).status).toBe(200);
  await h.settled(id);
  expect(h.sent(0, "review/start")).toHaveLength(1);
  expect(h.lines(id).at(-1)).toEqual({ kind: "bot", author: "agent", body: "好" });

  await h.say(id, "/review");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  expect((await h.call("POST", `/v1/agent-runs/${(await h.run(id))!.id}/deny`)).status).toBe(200);
  await h.settled(id);
  expect(h.sent(1, "review/start")).toEqual([]);
  expect(h.lines(id).at(-1)).toEqual({ kind: "system", author: "app", body: "没有执行 /review：你拒绝了" });

  h.store.patchSettings({ permission_mode: "read_only" });
  await h.say(id, "/review");
  await h.until(() => h.lines(id).length === 6);
  await h.settled(id);
  expect(h.sent(2, "review/start")).toEqual([]);
  expect(h.lines(id).at(-1)).toEqual({ kind: "system", author: "app", body: "只读模式下不能用 /review：审查时 Codex 自己跑命令，不经过应用" });
});

test("/new opens a new Codex thread: what follows it, and every later line, go there", async () => {
  const h = start([{ turns: [[{ say: "答一" }]] }, { turns: [[{ say: "新的" }]] }, { turns: [[{ say: "接着新的" }]] }, { turns: [] }, { turns: [[{ say: "第三个" }]] }]);
  const id = await h.open();
  await h.say(id, "你好");
  await h.settled(id);
  await h.say(id, "/new 从头来");
  await h.until(() => h.lines(id).length === 5);
  await h.settled(id);
  expect(h.sent(1, "thread/resume")[0]).toMatchObject({ threadId: "thread-1" });
  expect(h.sent(1, "thread/start")[0]).toMatchObject({ cwd: h.dir, approvalPolicy: "untrusted", sandbox: "read-only", ephemeral: false });
  expect(h.sent(1, "turn/start")).toEqual([{ threadId: "thread-2", input: [{ type: "text", text: "从头来", text_elements: [] }] }]);
  expect(h.store.projectOf(id)?.agentSession).toBe("thread-2");
  expect(h.lines(id).slice(2).map((line) => [line.kind, line.body])).toEqual([
    ["user", "/new 从头来"], ["system", "已执行 /new：Codex 开了一个新会话，从空的上下文重新开始，这里的记录还在"], ["bot", "新的"],
  ]);

  await h.say(id, "再来");
  await h.until(() => h.lines(id).length === 7);
  await h.settled(id);
  expect(h.sent(2, "thread/resume")[0]).toMatchObject({ threadId: "thread-2" });

  // Alone it opens no thread yet: Codex keeps one only once it has had a turn, so the next line's run starts it.
  await h.say(id, "/new");
  await h.until(() => h.lines(id).length === 9);
  await h.settled(id);
  expect(h.sent(3, "thread/start")).toEqual([]);
  expect(h.store.projectOf(id)?.agentSession).toBeNull();
  await h.say(id, "第三句");
  await h.until(() => h.lines(id).length === 11);
  await h.settled(id);
  expect(h.sent(4, "thread/resume")).toEqual([]);
  expect(h.sent(4, "thread/start")).toHaveLength(1);
  expect(h.lines(id).at(-1)).toEqual({ kind: "bot", author: "agent", body: "第三个" });
});

test("a skill named after `/` goes as Codex's own `$` sends one; a command sent mid-turn waits for its end; a name Codex has not got goes as your words", async () => {
  const path = "/skills/hello/SKILL.md";
  const h = start([{ skills: [{ name: "hello", description: "Say hello", path }], turns: [[{ sleep: 300 }, { say: "Ahoy" }], [{ say: "状态" }]] }]);
  const id = await h.open();
  await h.say(id, "/hello 打个招呼");
  await h.until(() => h.sent(0, "turn/start").length === 1);
  await h.say(id, "/status");
  await h.until(() => h.lines(id).length === 4);
  await h.settled(id);
  expect(h.sent(0, "skills/list")).toEqual([{ cwds: [h.dir] }]);
  expect(h.sent(0, "turn/start")).toEqual([
    { threadId: "thread-1", input: [{ type: "text", text: "$hello 打个招呼", text_elements: [] }, { type: "skill", name: "hello", path }] },
    { threadId: "thread-1", input: [{ type: "text", text: "/status", text_elements: [] }] },
  ]);
  expect(h.sent(0, "turn/steer")).toEqual([]);
  expect(h.lines(id).map((line) => line.body)).toEqual(["/hello 打个招呼", "/status", "Ahoy", "状态"]);
});

test("each Codex call's usage goes in the ledger as a project session's, once; an earlier run's turn a resume repeats is not billed again", async () => {
  const h = start([
    { model: "gpt-5.6-luna", turns: [[
      { usage: { input: 1000, output: 50, cached: 800 } },
      // The same update again bills nothing.
      { usage: { input: 1000, output: 50, cached: 800 } },
      { usage: { input: 2200, output: 120, cached: 1700, last: { input: 1200, output: 70, cached: 900 } } },
      // After a compaction its totals start over; the call is still the last one.
      { usage: { input: 1500, output: 30, cached: 0 } },
      { say: "好" },
    ]] },
    { model: "gpt-5.6-luna", resumedUsage: { input: 1500, output: 30, cached: 0, turnId: "turn-earlier" }, turns: [[{ usage: { input: 400, output: 20, cached: 300 } }, { say: "再好" }]] },
  ]);
  const id = await h.open();
  await h.say(id, "看看");
  await h.settled(id);
  const first = (await h.run(id))!.id;
  await h.say(id, "接着");
  await h.until(async () => (await h.run(id))?.id !== first);
  await h.settled(id);
  const second = (await h.run(id))!.id;

  const rows = h.store.db
    .query<Record<string, unknown>, [string]>(`SELECT * FROM spend WHERE session_id = ? ORDER BY created_at, id`).all(id)
    .map((row) => ({ run: row.turn_id === first ? 1 : row.turn_id === second ? 2 : null, input: row.input_tokens, output: row.output_tokens, cached: row.cached_tokens }));
  expect(rows).toEqual([
    { run: 1, input: 1000, output: 50, cached: 800 },
    { run: 1, input: 1200, output: 70, cached: 900 },
    { run: 1, input: 1500, output: 30, cached: 0 },
    { run: 2, input: 400, output: 20, cached: 300 },
  ]);
  // No Bot, named after the session; Codex reports no price, so there is no estimate and the cap does not count it.
  expect(h.store.db.query(`SELECT DISTINCT kind, purpose, bot_id, session_name, provider_name, model, cost_usd_ticks, estimated_cost_usd_ticks FROM spend`).all()).toEqual([
    { kind: "turn", purpose: "project", bot_id: null, session_name: "看看", provider_name: "Codex", model: "gpt-5.6-luna", cost_usd_ticks: null, estimated_cost_usd_ticks: null },
  ]);
});
