import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallbackMatcher, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Database } from "bun:sqlite";
import type { AgentReplay, AgentRun, ClaudeCodeStatus, ClientEvent, ProjectPathLookup, SessionDetail, ToolFrame } from "@real-bot/protocol";
import { claudeProjectKey } from "./claude-code/memory-dir";
import type { ClaudeCommandList } from "./claude-code/commands";
import type { ClaudeModelList } from "./claude-code/models";
import type { ClaudeCodeProbe } from "./claude-code/probe";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import type { ProjectQuery } from "./project-runner";
import { validateBusiness } from "./remote/routes";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { migrateProjectSessions } from "./store/project-sessions";

const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

const signedIn = { path: "/usr/local/bin/claude", version: "2.1.304", logged_in: true, accounts: [] } as unknown as ClaudeCodeStatus;
const probe: ClaudeCodeProbe = { last: () => signedIn, current: async () => signedIn, detect: async () => signedIn };

/** What one run of Claude Code does with the lines it is sent: `say` answers each with a result. */
type UseTool = (name: string, input: Record<string, unknown>, call?: { id?: string; agentId?: string; mode?: string }) => Promise<boolean>;
type Step = (ctx: { line: string; options: Options; useTool: UseTool }) => Promise<string>;
/** What the runner asked of Claude Code: each run's options, the lines, mid-run switches and the answers to its asks. */
type Seen = {
  options: Options[]; lines: string[]; closed: number; models: Array<string | null>; efforts: Array<string | null>; modes: string[];
  verdicts: Array<{ name: string; behavior: string; message?: string; updatedPermissions?: unknown }>;
};

function scripted(seen: Seen, step: Step, ownSession = "own-1", preface: (line: string) => SDKMessage[] = () => []): ProjectQuery {
  let tool = 0;
  return ({ prompt, options }) => {
    seen.options.push(options);
    const hooks = (options.hooks ?? {}) as Record<string, HookCallbackMatcher[]>;
    const runHook = async (event: string, input: Record<string, unknown>, id: string) => {
      let decision: unknown = {};
      for (const matcher of hooks[event] ?? []) {
        for (const hook of matcher.hooks) decision = await hook({ hook_event_name: event, session_id: "s", transcript_path: "/dev/null", cwd: options.cwd, ...input } as never, id, { signal: new AbortController().signal });
      }
      return decision as { hookSpecificOutput?: { permissionDecision?: string } };
    };
    const useTool: UseTool = async (name, input, call = {}) => {
      const id = call.id ?? `toolu_${++tool}`;
      const agent = { ...(call.agentId ? { agent_id: call.agentId } : {}), ...(call.mode ? { permission_mode: call.mode } : {}) };
      const pre = await runHook("PreToolUse", { tool_name: name, tool_input: input, tool_use_id: id, ...agent }, id);
      const decision = pre.hookSpecificOutput?.permissionDecision ?? "ask";
      if (decision === "deny") return false;
      if (decision === "ask") {
        const verdict = await options.canUseTool!(name, input, { signal: new AbortController().signal, toolUseID: id, requestId: id } as never);
        if (verdict) seen.verdicts.push({ name, behavior: verdict.behavior, ...(verdict.behavior === "deny" ? { message: verdict.message } : { updatedPermissions: verdict.updatedPermissions }) });
        if (!verdict || verdict.behavior === "deny") return false;
      }
      await runHook("PostToolUse", { tool_name: name, tool_input: input, tool_response: "ok", tool_use_id: id, ...agent }, id);
      return true;
    };
    let closed = false;
    const generator = (async function* (): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: ownSession, model: "claude-sonnet-5", uuid: crypto.randomUUID() } as unknown as SDKMessage;
      for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
        if (closed) break;
        // A picture reads as its type, so a test can say what went with the words.
        const content = message.message.content;
        const line = typeof content === "string" ? content : content
          .map((part) => (part.type === "text" ? part.text : part.type === "image" && part.source.type === "base64" ? `[${part.source.media_type}]` : `[${part.type}]`))
          .join("\n");
        seen.lines.push(line);
        yield* preface(line);
        const reply = await step({ line, options, useTool });
        yield { type: "result", subtype: "success", result: reply, is_error: false, session_id: ownSession, uuid: crypto.randomUUID() } as unknown as SDKMessage;
      }
    })();
    return Object.assign(generator, {
      close: () => { closed = true; seen.closed += 1; },
      setModel: async (model?: string) => { seen.models.push(model ?? null); },
      applyFlagSettings: async (settings: { effortLevel?: string | null }) => { seen.efforts.push(settings.effortLevel ?? null); },
      setPermissionMode: async (mode: string) => { seen.modes.push(mode); },
    });
  };
}

function start(step: Step, opts: { ownSession?: string; preface?: (line: string) => SDKMessage[]; claudeModels?: ClaudeModelList; claudeCommands?: ClaudeCommandList; query?: ProjectQuery } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "project-session-")));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: Seen = { options: [], lines: [], closed: 0, models: [], efforts: [], modes: [], verdicts: [] };
  const api = createLocalApi({ store, token: "project-test", schedule: false, claudeCode: probe, projectQuery: opts.query ?? scripted(seen, step, opts.ownSession, opts.preface),
    ...(opts.claudeModels ? { claudeModels: opts.claudeModels } : {}), ...(opts.claudeCommands ? { claudeCommands: opts.claudeCommands } : {}) });
  const events: ClientEvent[] = [];
  api.subscribeSync((frame) => { if (frame.type === "event") events.push(frame.payload); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { api.projects.close(); await api.projects.idle(); await api.engine.close(); store.close(); await server.stop(true); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://${server.hostname}:${server.port}`;
  const headers = { Authorization: "Bearer project-test", "Content-Type": "application/json" };
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${origin}${path}`, { method, headers: { ...headers, ...(method === "GET" ? {} : { "Idempotency-Key": ulid() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const say = async (sessionId: string, body: string) => call<{ id: string }>("POST", `/v1/sessions/${sessionId}/messages`, { body });
  const run = async (sessionId: string) => (await call<{ run: AgentRun | null }>("GET", `/v1/project-sessions/${sessionId}/run`)).body.run;
  const until = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 200; i += 1) {
      if (await check()) return;
      await Bun.sleep(10);
    }
    throw new Error("timed out");
  };
  const lines = (sessionId: string) => store.db
    .query<{ kind: string; author: string; body: string }, [string]>(`SELECT kind, author, body FROM messages WHERE session_id = ? ORDER BY created_at, id`).all(sessionId);
  return { store, api, dir, seen, events, call, say, run, until, lines, origin, headers };
}

test("a new project session: Claude Code runs in its directory as in the terminal, and later lines resume its own session", async () => {
  const h = start(async ({ line }) => `答：${line}`);
  const made = await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir });
  expect(made.status).toBe(201);
  expect(made.body).toMatchObject({ kind: "project", name: null, project_dir: h.dir, project_agent: "claude_code" });
  const id = made.body.id;

  await h.say(id, "看看这个项目的结构");
  await h.until(async () => (await h.run(id))?.status === "completed");
  const first = h.seen.options[0]!;
  expect(first.cwd).toBe(h.dir);
  expect(first.persistSession).toBe(true);
  expect(first.resume).toBeUndefined();
  expect(first.settingSources).toEqual(["user", "project", "local"]);
  expect(first.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  expect(first.disallowedTools).toContain("AskUserQuestion");
  expect(h.lines(id)).toEqual([
    { kind: "user", author: "user", body: "看看这个项目的结构" },
    { kind: "bot", author: "agent", body: "答：看看这个项目的结构" },
  ]);
  // Named by your first line; the agent's own session is what later runs resume.
  expect(h.store.getSession(id)).toMatchObject({ name: "看看这个项目的结构", project_agent_session: "own-1" });

  await h.say(id, "再说一遍");
  await h.until(() => h.seen.options.length === 2 && h.lines(id).length === 4);
  expect(h.seen.options[1]!.resume).toBe("own-1");
  expect(h.seen.options[1]!.forkSession).toBe(false);
  // Only the new line is sent: Claude Code keeps the history itself.
  expect(h.seen.lines).toEqual(["看看这个项目的结构", "再说一遍"]);
  // No Bot's machinery ran: no turn, no Bot.
  expect(h.store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM turns`).get()?.n).toBe(0);
  expect(h.events.some((event) => event.event === "agent_run.upsert" && event.status === "completed")).toBe(true);
});

test("an imported session branches off the terminal session on its first run", async () => {
  const h = start(async () => "PELICAN-42");
  const account = mkdtempSync(join(tmpdir(), "project-account-"));
  closes.push(() => rmSync(account, { recursive: true, force: true }));
  const project = join(account, "projects", "-work-app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "src-1.jsonl"), [
    { type: "user", uuid: "u1", parentUuid: null, cwd: h.dir, entrypoint: "cli", timestamp: "2026-10-19T10:00:00.000Z", message: { role: "user", content: "记住代号 PELICAN-42" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", cwd: h.dir, entrypoint: "cli", timestamp: "2026-10-19T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "好" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  h.store.setClaudeCodeConfigDirs([account]);
  const made = await h.call<SessionDetail>("POST", "/v1/project-sessions", { import: { session_id: "src-1", config_dir: account } });
  expect(made.status).toBe(201);
  expect(made.body).toMatchObject({ project_dir: h.dir, project_source: "src-1", project_config_dir: account, name: "记住代号 PELICAN-42" });
  await h.say(made.body.id, "代号是什么");
  await h.until(async () => (await h.run(made.body.id))?.status === "completed");
  expect(h.seen.options[0]).toMatchObject({ resume: "src-1", forkSession: true, cwd: h.dir });
  expect(h.lines(made.body.id).map((row) => row.body).slice(0, 2)).toEqual(["记住代号 PELICAN-42", "好"]);
  expect(h.lines(made.body.id).at(-1)?.body).toBe("PELICAN-42");

  expect((await h.call("POST", "/v1/project-sessions", { import: { session_id: "src-1", config_dir: "/elsewhere" } })).status).toBe(422);
  expect((await h.call("POST", "/v1/project-sessions", { import: { session_id: "missing", config_dir: account } })).status).toBe(404);
  expect((await h.call("POST", "/v1/project-sessions", { dir: "relative/path" })).status).toBe(422);
});

test("under ask first a write waits on the run's card; approving lets it run, denying reaches Claude Code", async () => {
  const outcomes: boolean[] = [];
  const h = start(async ({ useTool, options }) => {
    outcomes.push(await useTool("Write", { file_path: join(options.cwd!, "a.txt"), content: "x" }));
    return "写好了";
  });
  h.store.patchSettings({ permission_mode: "ask_first" });
  const made = await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir });
  const id = made.body.id;

  await h.say(id, "写个文件");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  const waiting = (await h.run(id))!;
  expect(waiting.approval?.summary).toContain("a.txt");
  expect(waiting.activity).toContain("Write");
  expect((await h.call<AgentRun>("POST", `/v1/agent-runs/${waiting.id}/approve`)).status).toBe(200);
  await h.until(async () => (await h.run(id))?.status === "completed");

  await h.say(id, "再写一个");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  await h.call("POST", `/v1/agent-runs/${(await h.run(id))!.id}/deny`);
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(outcomes).toEqual([true, false]);
});

test("two calls asking at once each get their card, one after the other; neither is lost", async () => {
  let outcomes: boolean[] = [];
  const h = start(async ({ useTool, options }) => {
    // Claude Code runs independent tools in parallel, so it can ask about two at once.
    outcomes = await Promise.all([
      useTool("Write", { file_path: join(options.cwd!, "a.txt"), content: "x" }),
      useTool("Write", { file_path: join(options.cwd!, "b.txt"), content: "y" }),
    ]);
    return "写好了";
  });
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "写两个文件");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  const first = (await h.run(id))!;
  expect(first.approval?.summary).toContain("a.txt");
  await h.call("POST", `/v1/agent-runs/${first.id}/approve`);
  // The second one's card comes up instead of the run going on without an answer.
  await h.until(async () => (await h.run(id))?.approval?.summary?.includes("b.txt") === true);
  expect((await h.run(id))!.status).toBe("waiting_approval");
  await h.call("POST", `/v1/agent-runs/${first.id}/deny`);
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(outcomes).toEqual([true, false]);
});

test("Stop answers every call still asking, so none is left waiting", async () => {
  let settled = 0;
  const h = start(async ({ useTool, options }) => {
    await Promise.all([
      useTool("Write", { file_path: join(options.cwd!, "a.txt"), content: "x" }).then(() => settled++),
      useTool("Write", { file_path: join(options.cwd!, "b.txt"), content: "y" }).then(() => settled++),
    ]);
    return "好";
  });
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "写两个文件");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  await h.call("POST", `/v1/agent-runs/${(await h.run(id))!.id}/stop`);
  await h.until(() => settled === 2);
  expect((await h.run(id))!.status).toBe("stopped");
});

test("read-only refuses a write with no card, and Claude Code's credentials are refused in any mode", async () => {
  const outcomes: boolean[] = [];
  const h = start(async ({ useTool, options }) => {
    outcomes.push(await useTool("Write", { file_path: join(options.cwd!, "a.txt"), content: "x" }));
    outcomes.push(await useTool("Read", { file_path: join(process.env.HOME ?? "/", ".claude.json") }));
    return "好";
  });
  h.store.patchSettings({ permission_mode: "read_only" });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "写个文件");
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(outcomes).toEqual([false, false]);
});

test("Claude Code's memory of the project opens with its file tools, by the mode; its transcripts and other projects' memory stay shut", async () => {
  const outcomes: boolean[] = [];
  const projects = join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects");
  const h = start(async ({ useTool, options }) => {
    const memory = join(projects, claudeProjectKey(options.cwd!), "memory");
    outcomes.push(await useTool("Read", { file_path: join(memory, "product_test_account.md") }));
    outcomes.push(await useTool("Write", { file_path: join(memory, "new.md"), content: "x" }));
    outcomes.push(await useTool("Read", { file_path: join(memory, "..", "own-1.jsonl") }));
    outcomes.push(await useTool("Read", { file_path: join(projects, "-somewhere-else", "memory", "MEMORY.md") }));
    outcomes.push(await useTool("Bash", { command: `cat ${join(memory, "MEMORY.md")}` }));
    return "好";
  });
  h.store.patchSettings({ permission_mode: "read_only" });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "看看记忆");
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(outcomes).toEqual([true, false, false, false, false]);
});

test("Stop ends a run waiting on you; your next line starts a new one", async () => {
  let calls = 0;
  const h = start(async ({ useTool, options }) => {
    calls += 1;
    if (calls === 1) await useTool("Write", { file_path: join(options.cwd!, "a.txt"), content: "x" });
    return "好";
  });
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "写个文件");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  const stopped = await h.call<AgentRun>("POST", `/v1/agent-runs/${(await h.run(id))!.id}/stop`);
  expect(stopped.body.status).toBe("stopped");
  await h.api.projects.idle();
  expect(h.seen.closed).toBe(1);
  await h.say(id, "算了，说句话就行");
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(h.lines(id).at(-1)).toEqual({ kind: "bot", author: "agent", body: "好" });
});

test("a line sent while a run is going goes into that run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = start(async ({ line }) => {
    if (line === "第一句") await gate;
    return `答：${line}`;
  });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "第一句");
  await h.until(() => h.seen.lines.length === 1);
  await h.say(id, "第二句");
  release();
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(h.seen.options).toHaveLength(1);
  expect(h.lines(id).filter((row) => row.kind === "bot").map((row) => row.body)).toEqual(["答：第一句", "答：第二句"]);
});

test("a line's pictures reach Claude Code as images ahead of its words; any other file by its path", async () => {
  const h = start(async ({ line }) => `答：${line}`);
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "project-session-ws-")));
  closes.push(() => rmSync(ws, { recursive: true, force: true }));
  expect((await h.call("PATCH", "/v1/settings", { workspace_path: ws })).status).toBe(200);
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  const post = async (body: string, files: File[], extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.append("body", body);
    for (const file of files) form.append("files", file);
    for (const [key, value] of Object.entries(extra)) form.append(key, value);
    const response = await fetch(`${h.origin}/v1/sessions/${id}/messages`, { method: "POST", headers: { Authorization: "Bearer project-test", "Idempotency-Key": ulid() }, body: form });
    return { status: response.status, body: (await response.json()) as { attachments: Array<{ workspace_relpath: string }> } };
  };
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], "image.png", { type: "image/png" });

  const first = await post("这是什么颜色", [png()]);
  expect(first.status).toBe(201);
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(h.seen.lines).toEqual(["[image/png]\n这是什么颜色"]);

  // A picture alone carries no empty text with it; a file Claude Code cannot look at goes by where it is.
  const second = await post("", [png(), new File([new Uint8Array([1, 2])], "notes.txt", { type: "text/plain" })]);
  expect(second.status).toBe(201);
  await h.until(() => h.seen.lines.length === 2);
  const notes = join(ws, second.body.attachments[1]!.workspace_relpath);
  expect(existsSync(notes)).toBe(true);
  expect(h.seen.lines[1]).toBe(`[image/png]\n附件：${notes}`);
  await h.until(async () => (await h.run(id))?.status === "completed");

  // Your first line named the session; a line of pictures alone names nothing.
  expect(h.store.getSession(id).name).toBe("这是什么颜色");
  // Quotes and workspace paths are a Bot conversation's.
  expect((await h.call("POST", `/v1/sessions/${id}/messages`, { body: "看这个", paths: ["notes.md"] })).status).toBe(422);
});

test("Claude Code missing fails the run with a line that says so", async () => {
  const h = start(async () => "never");
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: join(h.dir, "gone") })).body.id;
  await h.say(id, "你好");
  await h.until(async () => (await h.run(id))?.status === "failed");
  expect((await h.run(id))?.error).toContain("已经不在了");
  expect(h.lines(id).at(-1)?.kind).toBe("system");
});

test("a sessions table from before project sessions is rebuilt with every row kept", () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')), name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions (id))`);
  db.run(`CREATE INDEX sessions_by_name ON sessions (name)`);
  db.run(`INSERT INTO sessions VALUES ('s1', 'group', 'G', 't', 't')`);
  db.run(`INSERT INTO messages VALUES ('m1', 's1')`);
  migrateProjectSessions(db);
  migrateProjectSessions(db);
  expect(db.query(`SELECT id, kind, name FROM sessions`).all()).toEqual([{ id: "s1", kind: "group", name: "G" }]);
  db.run(`INSERT INTO sessions (id, kind, created_at, updated_at, project_dir) VALUES ('s2', 'project', 't', 't', '/work')`);
  expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'sessions_by_name'`).get()).toEqual({ name: "sessions_by_name" });
  expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
});

test("a session's model: each run asks for it, a run going now switches, and null goes back to your settings", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = start(async ({ line }) => {
    if (line === "慢一点") await gate;
    return `答：${line}`;
  });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  expect((await h.call<SessionDetail>("PATCH", `/v1/project-sessions/${id}`, { model: "a b" })).status).toBe(422);
  expect((await h.call<SessionDetail>("PATCH", `/v1/project-sessions/${ulid()}`, { model: "opus" })).status).toBe(404);

  const set = await h.call<SessionDetail>("PATCH", `/v1/project-sessions/${id}`, { model: " opus " });
  expect(set.status).toBe(200);
  expect(set.body.project_model).toBe("opus");
  expect(h.events.some((event) => event.event === "session.upsert" && event.id === id && event.project_model === "opus")).toBe(true);
  await h.say(id, "第一句");
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(h.seen.options[0]!.model).toBe("opus");

  // Changed mid-run: the run going now takes it from its next step.
  await h.say(id, "慢一点");
  await h.until(() => h.seen.lines.length === 2);
  await h.call("PATCH", `/v1/project-sessions/${id}`, { model: "haiku" });
  expect(h.seen.models).toEqual(["haiku"]);
  release();
  await h.until(async () => (await h.run(id))?.status === "completed" && h.lines(id).length === 4);

  await h.call("PATCH", `/v1/project-sessions/${id}`, { model: null });
  await h.say(id, "第三句");
  await h.until(() => h.seen.options.length === 3);
  expect(h.seen.options[2]!.model).toBeUndefined();
});

test("you can rename a project session; your first line then no longer names it", async () => {
  const h = start(async ({ line }) => `答：${line}`);
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  const renamed = await h.call<SessionDetail>("PATCH", `/v1/sessions/${id}`, { name: "  登录修复  " });
  expect(renamed.status).toBe(200);
  expect(renamed.body.name).toBe("登录修复");
  expect(h.events.some((event) => event.event === "session.upsert" && event.id === id && event.name === "登录修复")).toBe(true);
  expect((await h.call("PATCH", `/v1/sessions/${id}`, { name: "  " })).status).toBe(422);
  await h.say(id, "看看这个项目的结构");
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(h.store.getSession(id).name).toBe("登录修复");
});

test("a session's thinking level: each run asks for it, a run going now switches, and the model is left alone", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = start(async ({ line }) => {
    if (line === "慢一点") await gate;
    return `答：${line}`;
  });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { effort: "huge" })).status).toBe(422);
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, {})).status).toBe(422);
  await h.call("PATCH", `/v1/project-sessions/${id}`, { model: "opus" });
  const set = await h.call<SessionDetail>("PATCH", `/v1/project-sessions/${id}`, { effort: "high" });
  expect(set.status).toBe(200);
  // Setting one leaves the other as it was.
  expect(set.body).toMatchObject({ project_model: "opus", project_effort: "high" });
  expect(h.events.some((event) => event.event === "session.upsert" && event.id === id && event.project_effort === "high")).toBe(true);
  await h.say(id, "第一句");
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(h.seen.options[0]).toMatchObject({ model: "opus", effort: "high" });

  await h.say(id, "慢一点");
  await h.until(() => h.seen.lines.length === 2);
  await h.call("PATCH", `/v1/project-sessions/${id}`, { effort: "max" });
  expect(h.seen.efforts).toEqual(["max"]);
  expect(h.seen.models).toEqual([]);
  await h.call("PATCH", `/v1/project-sessions/${id}`, { effort: null });
  expect(h.seen.efforts).toEqual(["max", null]);
  release();
  await h.until(async () => (await h.run(id))?.status === "completed" && h.lines(id).length === 4);
  await h.say(id, "第三句");
  await h.until(() => h.seen.options.length === 3);
  expect(h.seen.options[2]!.effort).toBeUndefined();
  expect(h.seen.options[2]!.model).toBe("opus");
});

test("a session moves to another of your Claude accounts: its Claude Code session goes with it, and its next run spends that account", async () => {
  const h = start(async ({ line }) => `答：${line}`);
  const homeA = mkdtempSync(join(tmpdir(), "claude-a-"));
  const homeB = mkdtempSync(join(tmpdir(), "claude-b-"));
  closes.push(async () => { rmSync(homeA, { recursive: true, force: true }); rmSync(homeB, { recursive: true, force: true }); });
  h.store.setClaudeCodeConfigDirs([homeA, homeB]);
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir, config_dir: homeA })).body.id;
  // A run on account A left its session there, with a subagent beside it.
  const folder = join(homeA, "projects", "-work-app");
  mkdirSync(join(folder, "own-1", "subagents"), { recursive: true });
  writeFileSync(join(folder, "own-1.jsonl"), '{"type":"user"}\n');
  writeFileSync(join(folder, "own-1", "subagents", "agent-x.jsonl"), "{}\n");
  h.store.recordProjectAgentSession(id, "own-1");

  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { config_dir: "/not/listed" })).status).toBe(422);
  const moved = await h.call<SessionDetail>("PATCH", `/v1/project-sessions/${id}`, { config_dir: homeB });
  expect(moved.status).toBe(200);
  expect(moved.body.project_config_dir).toBe(homeB);
  expect(readFileSync(join(homeB, "projects", "-work-app", "own-1.jsonl"), "utf8")).toBe('{"type":"user"}\n');
  expect(existsSync(join(homeB, "projects", "-work-app", "own-1", "subagents", "agent-x.jsonl"))).toBe(true);
  // The original is left as it was.
  expect(existsSync(join(folder, "own-1.jsonl"))).toBe(true);

  await h.say(id, "接着说");
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(h.seen.options[0]!.env?.CLAUDE_CONFIG_DIR).toBe(homeB);
  expect(h.seen.options[0]!.resume).toBe("own-1");

  // Back to A after turns on B: A's older copy gives way to the one B wrote.
  const later = '{"type":"user"}\n{"type":"assistant"}\n';
  writeFileSync(join(homeB, "projects", "-work-app", "own-1.jsonl"), later);
  utimesSync(join(folder, "own-1.jsonl"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { config_dir: homeA })).status).toBe(200);
  expect(readFileSync(join(folder, "own-1.jsonl"), "utf8")).toBe(later);
});

test("the account does not change under a run still writing its session", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = start(async () => { await gate; return "好"; });
  const homeB = mkdtempSync(join(tmpdir(), "claude-b-"));
  closes.push(async () => rmSync(homeB, { recursive: true, force: true }));
  h.store.setClaudeCodeConfigDirs([homeB]);
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "慢慢来");
  await h.until(async () => (await h.run(id))?.status === "running");
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { config_dir: homeB })).status).toBe(409);
  // The model still changes under it.
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { model: "haiku" })).status).toBe(200);
  release();
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { config_dir: homeB })).status).toBe(200);
});

test("each account's models are asked of Claude Code, and only a listed account's", async () => {
  const asked: Array<string | null> = [];
  const claudeModels: ClaudeModelList = { list: async (configDir) => (asked.push(configDir), { config_dir: configDir, models: [{ value: "opus", display_name: "Opus 5.5", description: "", resolved_model: "claude-opus-5-5", efforts: ["low", "high"] }], checked_at: "t", error: null }) };
  const h = start(async () => "好", { claudeModels });
  const homeB = mkdtempSync(join(tmpdir(), "claude-b-"));
  closes.push(async () => rmSync(homeB, { recursive: true, force: true }));
  h.store.setClaudeCodeConfigDirs([homeB]);
  const own = await h.call<{ models: Array<{ value: string }> }>("GET", "/v1/runtime/claude-code/models");
  expect(own.body.models.map((m) => m.value)).toEqual(["opus"]);
  expect((await h.call("GET", `/v1/runtime/claude-code/models?config_dir=${encodeURIComponent(homeB)}`)).status).toBe(200);
  expect((await h.call("GET", "/v1/runtime/claude-code/models?config_dir=%2Fnot%2Flisted")).status).toBe(422);
  expect(asked).toEqual([null, homeB]);
});

test("a phone reaches the same routes", () => {
  const id = ulid();
  const ok = (request: Parameters<typeof validateBusiness>[0]) => expect(() => validateBusiness(request)).not.toThrow();
  ok({ v: 1, id, method: "GET", path: "/v1/runtime/claude-code/sessions", query: { limit: "40" } });
  ok({ v: 1, id, method: "POST", path: "/v1/project-sessions", body: { dir: "/work/app" } });
  ok({ v: 1, id, method: "POST", path: "/v1/project-sessions", body: { import: { session_id: "abc", config_dir: null } } });
  ok({ v: 1, id, method: "GET", path: `/v1/project-sessions/${ulid()}/run` });
  ok({ v: 1, id, method: "POST", path: `/v1/agent-runs/${ulid()}/stop` });
  ok({ v: 1, id, method: "PATCH", path: `/v1/project-sessions/${ulid()}`, body: { model: "opus" } });
  ok({ v: 1, id, method: "PATCH", path: `/v1/project-sessions/${ulid()}`, body: { model: null } });
  ok({ v: 1, id, method: "PATCH", path: `/v1/project-sessions/${ulid()}`, body: { effort: "xhigh" } });
  ok({ v: 1, id, method: "PATCH", path: `/v1/project-sessions/${ulid()}`, body: { model: "opus", effort: null } });
  ok({ v: 1, id, method: "PATCH", path: `/v1/project-sessions/${ulid()}`, body: { config_dir: "/Users/a/.claude-b" } });
  ok({ v: 1, id, method: "GET", path: "/v1/runtime/claude-code/models", query: { config_dir: "/Users/a/.claude-b" } });
  ok({ v: 1, id, method: "GET", path: "/v1/runtime/claude-code/models" });
  expect(() => validateBusiness({ v: 1, id, method: "PATCH", path: `/v1/project-sessions/${ulid()}`, body: { effort: "huge" } })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "PATCH", path: `/v1/project-sessions/${ulid()}`, body: {} })).toThrow();
  ok({ v: 1, id, method: "PATCH", path: `/v1/sessions/${ulid()}`, body: { name: "登录修复" } });
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: `/v1/agent-runs/${ulid()}/delete` })).toThrow();
});

test("clearing a project session stops its run and starts the agent over; deleting it takes it and its runs away", async () => {
  let calls = 0;
  const h = start(async ({ useTool, options }) => {
    calls += 1;
    if (calls === 1) await useTool("Write", { file_path: join(options.cwd!, "a.txt"), content: "x" });
    return "好";
  });
  h.store.patchSettings({ permission_mode: "ask_first" });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "写个文件");
  await h.until(async () => (await h.run(id))?.status === "waiting_approval");
  expect((await h.call("POST", `/v1/sessions/${id}/clear`, {})).status).toBe(204);
  await h.api.projects.idle();
  expect(h.seen.closed).toBe(1);
  expect(h.store.getSession(id)).toMatchObject({ project_agent_session: null, project_source: null });
  expect(await h.run(id)).toBeNull();
  await h.say(id, "重新开始");
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(h.seen.options.at(-1)!.resume).toBeUndefined();

  const removed = await fetch(`${h.origin}/v1/sessions/${id}`, { method: "DELETE", headers: { ...h.headers, "Idempotency-Key": ulid() }, body: "{}" });
  expect([200, 204]).toContain(removed.status);
  expect(h.store.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?`).get(id)?.n).toBe(0);
  expect(h.store.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?`).get(id)?.n).toBe(0);
});

test("archiving a project session stops its live run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = start(async () => { await gate; return "好"; });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "慢慢来");
  await h.until(() => h.seen.lines.length === 1);
  expect((await h.call("POST", `/v1/sessions/${id}/archive`, {})).status).toBe(200);
  expect((await h.run(id))?.status).toBe("stopped");
  release();
  await h.api.projects.idle();
});

test("each tool call reaches the windows as a tool frame with where it works, start and end, never stored", async () => {
  const h = start(async ({ useTool, options }) => {
    await useTool("Read", { file_path: join(options.cwd!, "src", "a.ts") });
    await useTool("Bash", { command: "bun test src/a.test.ts" });
    return "好";
  });
  const frames: ToolFrame[] = [];
  h.api.subscribeTools((frame) => frames.push(frame));
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "看看");
  await h.until(async () => (await h.run(id))?.status === "completed");
  const runId = (await h.run(id))!.id;
  expect(frames.map((frame) => [frame.phase, frame.name, frame.turn_id === runId, frame.agent_run?.session_id === id])).toEqual([
    ["started", "Read", true, true], ["exited", "Read", true, true], ["started", "Bash", true, true], ["exited", "Bash", true, true],
  ]);
  expect(frames[0]!.agent_run).toMatchObject({ agent_id: null, place: { zone: "project", path: "src/a.ts" } });
  expect(frames[0]!.target).toBe("src/a.ts");
  expect(frames[2]!.agent_run).toMatchObject({ place: { zone: "check", check: "test" }, action: "check" });
  expect(frames[3]!.agent_run?.ok).toBe(true);
  expect(typeof frames[3]!.duration_ms).toBe("number");
  // A command says itself, as a Bot's does, for the chat's command card and working line.
  expect(frames[2]).toMatchObject({ command: "bun test src/a.test.ts", target: "bun test src/a.test.ts" });
  expect(frames[3]).toMatchObject({ command: "bun test src/a.test.ts", exit_code: 0 });
  expect(frames[0]!.command).toBeUndefined();
  // No message named a model for these calls: the run's own, from its start.
  expect(frames.map((frame) => frame.agent_run?.model)).toEqual(["claude-sonnet-5", "claude-sonnet-5", "claude-sonnet-5", "claude-sonnet-5"]);
});

test("a tool frame names the model that asked for the call: a subagent's own, then its last known", async () => {
  const subagentAsks = (id: string) => ({ type: "assistant", parent_tool_use_id: "toolu_agent", uuid: crypto.randomUUID(), session_id: "own-1",
    message: { id: `msg_${id}`, role: "assistant", model: "claude-haiku-5-5", content: [{ type: "tool_use", id, name: "Read", input: {} }] } }) as unknown as SDKMessage;
  const h = start(async ({ useTool, options }) => {
    await useTool("Read", { file_path: join(options.cwd!, "a.ts") }, { id: "toolu_sub1", agentId: "sub-a" });
    await useTool("Read", { file_path: join(options.cwd!, "b.ts") }, { id: "toolu_sub2", agentId: "sub-a" });
    await useTool("Read", { file_path: join(options.cwd!, "c.ts") });
    return "好";
  }, { preface: () => [subagentAsks("toolu_sub1")] });
  const frames: ToolFrame[] = [];
  h.api.subscribeTools((frame) => frames.push(frame));
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "派个分身看看");
  await h.until(async () => (await h.run(id))?.status === "completed");
  const started = frames.filter((frame) => frame.phase === "started");
  expect(started.map((frame) => [frame.id, frame.agent_run?.agent_id, frame.agent_run?.model])).toEqual([
    ["toolu_sub1", "sub-a", "claude-haiku-5-5"],
    ["toolu_sub2", "sub-a", "claude-haiku-5-5"],
    [started[2]!.id, null, "claude-sonnet-5"],
  ]);
});

test("the replay reads the agent's own session file under the session's account", async () => {
  const h = start(async () => "好");
  const account = mkdtempSync(join(tmpdir(), "project-replay-"));
  closes.push(() => rmSync(account, { recursive: true, force: true }));
  mkdirSync(join(account, "projects", "-work-app"), { recursive: true });
  writeFileSync(join(account, "projects", "-work-app", "own-9.jsonl"), [
    { type: "user", timestamp: "2026-10-20T10:00:00.000Z", message: { role: "user", content: "看看" } },
    { type: "assistant", timestamp: "2026-10-20T10:00:01.000Z", cwd: h.dir, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: join(h.dir, "a.ts") } }] } },
    { type: "user", timestamp: "2026-10-20T10:00:02.000Z", permissionDecision: { decision: "accept", source: "config", reasonType: "mode" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  h.store.setClaudeCodeConfigDirs([account]);
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir, config_dir: account })).body.id;
  expect((await h.call<AgentReplay>("GET", `/v1/project-sessions/${id}/replay`)).body).toMatchObject({ agent_session: null, calls: [] });
  h.store.recordProjectAgentSession(id, "own-9");
  const replay = (await h.call<AgentReplay>("GET", `/v1/project-sessions/${id}/replay`)).body;
  expect(replay).toMatchObject({ session_id: id, agent_session: "own-9", said: [{ kind: "say", text: "看看" }] });
  expect(replay.calls).toEqual([{ id: "t1", at: "2026-10-20T10:00:01.000Z", agent_id: null, tool: "Read", place: { zone: "project", path: "a.ts" }, model: "claude-opus-5-5", file: "a.ts",
    ok: true, duration_ms: 1000, decision: { decision: "accept", source: "config", reason_type: "mode" } }]);
  const direct = h.store.createBot({ name: "zz-bot", duties: "d", boundaries: "b" }).direct_session;
  expect((await h.call("GET", `/v1/project-sessions/${direct.id}/replay`)).status).toBe(404);
  expect(() => validateBusiness({ v: 1, id: ulid(), method: "GET", path: `/v1/project-sessions/${id}/replay` })).not.toThrow();
});

test("a path the agent cites is located under the session's directory; other conversations have none", async () => {
  const h = start(async () => "好");
  mkdirSync(join(h.dir, "steez", "comm"), { recursive: true });
  writeFileSync(join(h.dir, "steez", "comm", "defs.go"), "package comm");
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  const locate = (path: string) => h.call<ProjectPathLookup>("GET", `/v1/project-sessions/${id}/locate?path=${encodeURIComponent(path)}`);
  expect((await locate("comm/defs.go")).body).toEqual({ path: join(h.dir, "steez", "comm", "defs.go"), kind: "file", matches: ["steez/comm/defs.go"] });
  expect((await locate("steez/comm/")).body).toEqual({ path: join(h.dir, "steez", "comm"), kind: "dir", matches: [] });
  expect((await locate("feat/adverse-media")).body).toEqual({ path: null, kind: null, matches: [] });
  expect((await h.call("GET", `/v1/project-sessions/${id}/locate`)).status).toBe(422);
  const direct = h.store.createBot({ name: "zz-bot", duties: "d", boundaries: "b" }).direct_session;
  expect((await h.call("GET", `/v1/project-sessions/${direct.id}/locate?path=a.ts`)).status).toBe(404);
  expect(() => validateBusiness({ v: 1, id: ulid(), method: "GET", path: `/v1/project-sessions/${id}/locate`, query: { path: "comm/defs.go" } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id: ulid(), method: "GET", path: `/v1/project-sessions/${id}/locate` })).toThrow();
});

/** Where the runner's Claude Code saves its plans, as the runner works it out in these tests. */
const planFile = (name: string) => join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "plans", name);

test("plan mode: runs start in it, change nothing but the plan, and the plan is a card; approving it gets to work and turns plan mode off", async () => {
  const outcomes: Array<[string, boolean]> = [];
  const h = start(async ({ line, useTool, options }) => {
    const mode = line === "开始" ? "plan" : "default";
    outcomes.push(["write", await useTool("Write", { file_path: join(options.cwd!, "a.txt"), content: "x" }, { mode })]);
    outcomes.push(["command", await useTool("Bash", { command: "git log --oneline" }, { mode })]);
    if (line !== "开始") return "照常做了";
    outcomes.push(["plan file", await useTool("Write", { file_path: planFile("cozy-newt.md"), content: "# 计划" }, { mode })]);
    outcomes.push(["plan", await useTool("ExitPlanMode", { plan: "# 计划\n1. 写 a.txt", planFilePath: planFile("cozy-newt.md") }, { mode })]);
    outcomes.push(["after", await useTool("Write", { file_path: join(options.cwd!, "a.txt"), content: "x" }, { mode: "default" })]);
    return "做完了";
  });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  expect((await h.call("PATCH", `/v1/project-sessions/${id}`, { mode: "acceptEdits" })).status).toBe(422);
  const on = await h.call<SessionDetail>("PATCH", `/v1/project-sessions/${id}`, { mode: "plan" });
  expect(on.body.project_mode).toBe("plan");
  expect(h.events.some((event) => event.event === "session.upsert" && event.id === id && event.project_mode === "plan")).toBe(true);

  await h.say(id, "开始");
  // The command runs under auto with no card, as it would with plan mode off: only the plan is one.
  await h.until(async () => (await h.run(id))?.approval?.kind_key === "plan");
  const waiting = (await h.run(id))!;
  expect(h.seen.options[0]!.permissionMode).toBe("plan");
  expect(h.seen.options[0]!.tools).toContain("ExitPlanMode");
  expect(waiting.approval).toEqual({ kind_key: "plan", target: planFile("cozy-newt.md"), summary: "# 计划\n1. 写 a.txt" });
  await h.call("POST", `/v1/agent-runs/${waiting.id}/approve`);
  await h.until(async () => (await h.run(id))?.status === "completed");

  expect(outcomes).toEqual([["write", false], ["command", true], ["plan file", true], ["plan", true], ["after", true]]);
  expect([...new Set(h.events.flatMap((event) => event.event === "agent_run.upsert" && event.approval ? [event.approval.kind_key] : []))]).toEqual(["plan"]);
  // Approved: Claude Code leaves plan mode, and so does the session.
  expect(h.seen.verdicts.find((verdict) => verdict.name === "ExitPlanMode")).toEqual({ name: "ExitPlanMode", behavior: "allow",
    updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] });
  expect(h.store.getSession(id).project_mode).toBeNull();
  expect(h.events.some((event) => event.event === "session.upsert" && event.id === id && event.project_mode === null)).toBe(true);

  // The next run starts as usual.
  await h.say(id, "再来");
  await h.until(async () => h.seen.options.length === 2 && (await h.run(id))?.status === "completed");
  expect(h.seen.options[1]!.permissionMode).toBe("default");
  expect(outcomes.slice(5)).toEqual([["write", true], ["command", true]]);
});

test("a plan not approved keeps planning: the button says keep at it, a line you send says what to change", async () => {
  const h = start(async ({ line, useTool }) => {
    if (line === "改成两步") return "好的，改了";
    await useTool("ExitPlanMode", { plan: "# 计划", planFilePath: planFile("p.md") }, { mode: "plan" });
    return "计划交了";
  });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.call("PATCH", `/v1/project-sessions/${id}`, { mode: "plan" });

  await h.say(id, "出个计划");
  await h.until(async () => (await h.run(id))?.approval?.kind_key === "plan");
  await h.call("POST", `/v1/agent-runs/${(await h.run(id))!.id}/deny`);
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(h.seen.verdicts[0]).toMatchObject({ name: "ExitPlanMode", behavior: "deny" });
  expect(h.seen.verdicts[0]!.message).toContain("接着改");
  expect(h.store.getSession(id).project_mode).toBe("plan");

  // A line while the plan waits: not an approval, a change to the plan, and it goes into the run.
  await h.say(id, "再出一个");
  await h.until(async () => (await h.run(id))?.approval?.kind_key === "plan");
  await h.say(id, "改成两步");
  await h.until(async () => (await h.run(id))?.status === "completed" && h.lines(id).length === 6);
  expect(h.seen.verdicts[1]).toMatchObject({ name: "ExitPlanMode", behavior: "deny" });
  expect(h.seen.verdicts[1]!.message).toContain("下一条消息");
  expect(h.seen.lines).toEqual(["出个计划", "再出一个", "改成两步"]);
  expect(h.seen.options[1]!.permissionMode).toBe("plan");
});

test("plan mode switched mid-run reaches Claude Code at its next step; Claude Code asking on its own while it plans is refused", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = start(async ({ line, options }) => {
    if (line !== "慢一点") return "好";
    await gate;
    // Asked about a protected file with no card of the app's: refused while it plans.
    const verdict = await options.canUseTool!("Write", { file_path: "/x" }, { signal: new AbortController().signal, toolUseID: "own-ask", requestId: "own-ask" } as never);
    return verdict?.behavior ?? "none";
  });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "慢一点");
  await h.until(() => h.seen.lines.length === 1);
  await h.call("PATCH", `/v1/project-sessions/${id}`, { mode: "plan" });
  expect(h.seen.modes).toEqual(["plan"]);
  release();
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "bot", body: "deny" });
  await h.call("PATCH", `/v1/project-sessions/${id}`, { mode: null });
  expect(h.store.getSession(id).project_mode).toBeNull();
});

test("a slash command goes to Claude Code as typed; one that answers nothing still says it ran", async () => {
  const h = start(async ({ line }) => (line === "/context" ? "## Context Usage" : /^\/[^\s/]+(\s|$)/.test(line) ? "" : `答：${line}`));
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "/compact 留下测试相关的");
  await h.until(async () => (await h.run(id))?.status === "completed");
  await h.say(id, "/context");
  await h.until(async () => h.lines(id).length === 4);
  await h.say(id, "/clear");
  await h.until(async () => h.lines(id).length === 6);
  expect(h.seen.lines).toEqual(["/compact 留下测试相关的", "/context", "/clear"]);
  // A command names nothing: the session waits for a line that asks for something.
  expect(h.store.getSession(id).name).toBeNull();
  expect(h.lines(id).filter((line) => line.author !== "user")).toEqual([
    { kind: "system", author: "app", body: "已执行 /compact：Claude Code 把之前的对话压成了摘要" },
    { kind: "bot", author: "agent", body: "## Context Usage" },
    { kind: "system", author: "app", body: "已执行 /clear：Claude Code 从空的上下文重新开始，这里的记录还在" },
  ]);
  // A path is not a command: it names the session, and its answer is Claude Code's.
  await h.say(id, "/tmp/notes.md 看一下");
  await h.until(async () => h.lines(id).length === 8);
  expect(h.store.getSession(id).name).toBe("/tmp/notes.md 看一下");
  expect(h.lines(id).at(-1)).toEqual({ kind: "bot", author: "agent", body: "答：/tmp/notes.md 看一下" });
});

test("typing / lists the session's commands, asked of Claude Code in its directory under its account", async () => {
  const asked: Array<[string | null, string]> = [];
  const claudeCommands: ClaudeCommandList = { list: async (configDir, dir) => (asked.push([configDir, dir]), { commands: [{ name: "compact", description: "Clear history but keep a summary", argument_hint: "<instructions>", aliases: [] }], checked_at: "t", error: null }) };
  const h = start(async () => "好", { claudeCommands });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  const listed = await h.call<{ commands: Array<{ name: string }> }>("GET", `/v1/project-sessions/${id}/commands`);
  expect(listed.body.commands.map((command) => command.name)).toEqual(["compact"]);
  expect(asked).toEqual([[null, h.dir]]);
  expect((await h.call("GET", `/v1/project-sessions/${ulid()}/commands`)).status).toBe(404);
  const ok = (request: Parameters<typeof validateBusiness>[0]) => expect(() => validateBusiness(request)).not.toThrow();
  ok({ v: 1, id: ulid(), method: "GET", path: `/v1/project-sessions/${ulid()}/commands` });
  ok({ v: 1, id: ulid(), method: "PATCH", path: `/v1/project-sessions/${ulid()}`, body: { mode: "plan" } });
  ok({ v: 1, id: ulid(), method: "PATCH", path: `/v1/project-sessions/${ulid()}`, body: { mode: null } });
  expect(() => validateBusiness({ v: 1, id: ulid(), method: "PATCH", path: `/v1/project-sessions/${ulid()}`, body: { mode: "bypassPermissions" } })).toThrow();
});

test("a line Claude Code folds into the step it is on is answered by that step's result: the run ends, nothing waits", async () => {
  let second!: () => void;
  const secondSent = new Promise<void>((resolve) => { second = resolve; });
  const sent: Array<{ line: string; uuid?: string }> = [];
  // As Claude Code 2.1.307 does: a line sent mid-step joins it, and the one result lists both.
  const folding: ProjectQuery = ({ prompt }) => Object.assign((async function* (): AsyncGenerator<SDKMessage> {
    yield { type: "system", subtype: "init", session_id: "own-1", uuid: crypto.randomUUID() } as unknown as SDKMessage;
    const lines = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    const read = async () => {
      const next = (await lines.next()).value as SDKUserMessage;
      sent.push({ line: String(next.message.content), uuid: next.uuid });
      return next.uuid;
    };
    const first = await read();
    await secondSent;
    const folded = await read();
    yield { type: "result", subtype: "success", result: "两句一起答了", is_error: false, session_id: "own-1", user_message_uuids: [first, folded], uuid: crypto.randomUUID() } as unknown as SDKMessage;
    for (;;) {
      const done = await lines.next();
      if (done.done) return;
    }
  })(), { close: () => {} });
  const h = start(async () => "", { query: folding });
  const id = (await h.call<SessionDetail>("POST", "/v1/project-sessions", { dir: h.dir })).body.id;
  await h.say(id, "先做这个");
  await h.until(() => sent.length === 1);
  await h.say(id, "顺便也做那个");
  second();
  await h.until(async () => (await h.run(id))?.status === "completed");
  expect(sent.map((row) => row.line)).toEqual(["先做这个", "顺便也做那个"]);
  expect(sent.every((row) => typeof row.uuid === "string" && row.uuid.length > 0)).toBe(true);
  expect(h.lines(id).at(-1)).toMatchObject({ kind: "bot", body: "两句一起答了" });
});
