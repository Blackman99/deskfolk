import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallbackMatcher, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRun, AgentRunTask, AgentTaskDetail, ClaudeCodeStatus, SessionDetail, ToolFrame } from "@real-bot/protocol";
import { decideAgentCall } from "./claude-code/policy";
import { backgroundTaskOf, createTaskBoard, type TaskCall } from "./claude-code/task-board";
import { readOutputTail, readSubagentTrail } from "./claude-code/task-detail";
import type { ClaudeCodeProbe } from "./claude-code/probe";
import { ulid } from "./ids";
import { createProjectRunner, type ProjectQuery } from "./project-runner";
import { createLocalApi } from "./local-api";
import { validateBusiness } from "./remote/routes";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

const signedIn = { path: "/usr/local/bin/claude", version: "2.1.312", logged_in: true, accounts: [] } as unknown as ClaudeCodeStatus;
const probe: ClaudeCodeProbe = { last: () => signedIn, current: async () => signedIn, detect: async () => signedIn };

const sys = (subtype: string, rest: Record<string, unknown> = {}) => ({ type: "system", subtype, uuid: crypto.randomUUID(), session_id: "own-1", ...rest }) as unknown as SDKMessage;
const started = (id: string, rest: Record<string, unknown> = {}) => sys("task_started", { task_id: id, description: `task ${id}`, is_backgrounded: true, task_type: "local_bash", ...rest });
const level = (...ids: string[]) => sys("background_tasks_changed", { tasks: ids.map((task_id) => ({ task_id, task_type: "local_bash", description: "" })) });
const ended = (id: string, status = "completed", rest: Record<string, unknown> = {}) => sys("task_notification", { task_id: id, status, output_file: "", summary: `${id} ${status}`, ...rest });

type Script = {
  /** A message the stream yields next, as Claude Code's own come. */
  push(message: SDKMessage): void;
  /** A result answering a line of yours: by default the last one. */
  answer(text: string, uuid?: string): void;
  /** A turn Claude Code starts by itself: it says `init` again, and its result lists no line. */
  ownTurn(text: string): void;
  useTool(name: string, input: Record<string, unknown>, id: string, response?: unknown): Promise<void>;
  lines: Array<{ text: string; uuid: string }>;
  inputClosed: boolean;
  stopped: string[];
  finish(): void;
};

/** A Claude Code the test drives by hand: nothing happens until the test says. */
function handDriven(): { query: ProjectQuery; script: Script } {
  const queue: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const pump = () => { wake?.(); wake = null; };
  let hooks: Record<string, HookCallbackMatcher[]> = {};
  let cwd = "/";
  const runHook = async (event: string, input: Record<string, unknown>, id: string) => {
    for (const matcher of hooks[event] ?? []) {
      for (const hook of matcher.hooks) await hook({ hook_event_name: event, session_id: "s", transcript_path: "/dev/null", cwd, ...input } as never, id, { signal: new AbortController().signal });
    }
  };
  const script: Script = {
    push(message) { queue.push(message); pump(); },
    answer(text, uuid) {
      queue.push({ type: "result", subtype: "success", result: text, is_error: false, session_id: "own-1", user_message_uuids: [uuid ?? script.lines.at(-1)!.uuid], uuid: crypto.randomUUID() } as unknown as SDKMessage);
      pump();
    },
    ownTurn(text) {
      queue.push(sys("init", { model: "claude-sonnet-5" }));
      queue.push({ type: "result", subtype: "success", result: text, is_error: false, session_id: "own-1", uuid: crypto.randomUUID() } as unknown as SDKMessage);
      pump();
    },
    async useTool(name, input, id, response = "ok") {
      await runHook("PreToolUse", { tool_name: name, tool_input: input, tool_use_id: id }, id);
      await runHook("PostToolUse", { tool_name: name, tool_input: input, tool_response: response, tool_use_id: id }, id);
    },
    lines: [],
    inputClosed: false,
    stopped: [],
    finish() { done = true; pump(); },
  };
  const query: ProjectQuery = ({ prompt, options }) => {
    hooks = (options.hooks ?? {}) as Record<string, HookCallbackMatcher[]>;
    cwd = options.cwd!;
    void (async () => {
      for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
        script.lines.push({ text: String(message.message.content), uuid: message.uuid as string });
        pump();
      }
      script.inputClosed = true;
      pump();
    })();
    const generator = (async function* (): AsyncGenerator<SDKMessage> {
      yield sys("init", { model: "claude-sonnet-5" });
      for (;;) {
        while (queue.length) yield queue.shift()!;
        // As the real one does: its input closed and nothing left to say, it exits.
        if (done || script.inputClosed) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })();
    return Object.assign(generator, {
      close: () => { done = true; pump(); },
      stopTask: async (id: string) => { script.stopped.push(id); },
      getTaskOutput: async (id: string) => ({ output: `asked of ${id}`, total_bytes: 11, truncated: false }),
    });
  };
  return { query, script };
}

function start() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "project-tasks-")));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const { query, script } = handDriven();
  const api = createLocalApi({ store, token: "t", schedule: false, claudeCode: probe, projectQuery: query, projectSettleMs: 20 });
  const tools: ToolFrame[] = [];
  api.subscribeTools((frame) => tools.push(frame));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { script.finish(); api.projects.close(); await api.projects.idle(); await api.engine.close(); store.close(); await server.stop(true); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://${server.hostname}:${server.port}`;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${origin}${path}`, { method, headers: { Authorization: "Bearer t", "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": ulid() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const until = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 300; i += 1) {
      if (await check()) return;
      await Bun.sleep(5);
    }
    throw new Error("timed out");
  };
  const open = async () => (await call<SessionDetail>("POST", "/v1/project-sessions", { dir })).body.id;
  const say = (id: string, body: string) => call("POST", `/v1/sessions/${id}/messages`, { body });
  const run = async (id: string) => (await call<{ run: AgentRun | null }>("GET", `/v1/project-sessions/${id}/run`)).body.run!;
  const lines = (id: string) => store.db.query<{ body: string }, [string]>(`SELECT body FROM messages WHERE session_id = ? AND kind = 'bot' ORDER BY created_at, id`).all(id).map((row) => row.body);
  return { store, script, tools, call, until, open, say, run, lines, dir };
}

test("a task keeps the run open past its reply, a line sent meanwhile is answered at once, and the run ends with the last task", async () => {
  const h = start();
  const id = await h.open();
  await h.say(id, "跑起来");
  await h.until(() => h.script.lines.length === 1);
  await h.script.useTool("Bash", { command: "npm run dev", run_in_background: true }, "toolu_bg", { backgroundTaskId: "b1" });
  h.script.push(level("b1"));
  h.script.push(started("b1", { tool_use_id: "toolu_bg" }));
  h.script.answer("起来了");
  await h.until(async () => (await h.run(id)).idle === true);

  // Its reply is done, the run is not; the agent itself is at rest.
  let run = await h.run(id);
  expect(run.status).toBe("running");
  expect(h.lines(id)).toEqual(["起来了"]);
  expect(h.script.inputClosed).toBe(false);
  expect(run.tasks).toMatchObject([{ id: "b1", kind: "shell", status: "running", command: "npm run dev", description: "task b1" }]);

  // A line goes into the same run and is answered, not parked until the task ends.
  await h.say(id, "现在呢");
  await h.until(() => h.script.lines.length === 2);
  await h.until(async () => (await h.run(id)).idle === false);
  h.script.answer("还在跑");
  await h.until(async () => (await h.run(id)).idle === true);
  expect(h.lines(id)).toEqual(["起来了", "还在跑"]);
  expect((await h.run(id)).status).toBe("running");

  // The task ends and Claude Code says so by itself; the run ends with that.
  h.script.push(sys("task_updated", { task_id: "b1", patch: { status: "failed", end_time: Date.now(), error: "boom" } }));
  h.script.push(ended("b1", "failed", { summary: "exit code 1", output_file: "/tmp/b1.output", tool_use_id: "toolu_bg" }));
  h.script.push(level());
  h.script.ownTurn("它失败了");
  await h.until(async () => (await h.run(id)).status === "completed");
  run = await h.run(id);
  expect(h.script.inputClosed).toBe(true);
  expect(h.lines(id)).toEqual(["起来了", "还在跑", "它失败了"]);
  expect(run.idle).toBe(false);
  expect(run.tasks).toMatchObject([{ id: "b1", status: "failed", summary: "exit code 1", output_file: "/tmp/b1.output" }]);
  expect(run.tasks![0]!.ended_at).toBeTruthy();
});

test("a turn Claude Code starts by itself answers no line of yours", async () => {
  const h = start();
  const id = await h.open();
  await h.say(id, "第一句");
  await h.until(() => h.script.lines.length === 1);
  await h.script.useTool("Monitor", { command: "tail -f log", description: "watch", timeout_ms: 1000 }, "toolu_m", { taskId: "m1" });
  h.script.push(level("m1"));
  h.script.push(started("m1", { tool_use_id: "toolu_m" }));
  h.script.answer("在看");
  await h.until(async () => (await h.run(id)).idle === true);

  await h.say(id, "第二句");
  await h.until(() => h.script.lines.length === 2);
  // A Monitor's event, while your line is still unanswered: this result is not its answer.
  h.script.ownTurn("有事件");
  h.script.push(ended("m1", "completed", { tool_use_id: "toolu_m" }));
  h.script.push(level());
  await h.until(() => h.lines(id).length === 2);
  await Bun.sleep(40);
  expect(h.script.inputClosed).toBe(false);
  h.script.answer("答第二句", h.script.lines[1]!.uuid);
  await h.until(async () => (await h.run(id)).status === "completed");
  expect(h.lines(id)).toEqual(["在看", "有事件", "答第二句"]);
});

test("a task you stop wakes nothing: the run still ends, and a Monitor is told apart from a command", async () => {
  const h = start();
  const id = await h.open();
  await h.say(id, "盯着");
  await h.until(() => h.script.lines.length === 1);
  await h.script.useTool("Monitor", { ws: { url: "wss://x/y" }, description: "socket", timeout_ms: 1000 }, "toolu_w", { taskId: "w1" });
  h.script.push(level("w1"));
  h.script.push(started("w1", { tool_use_id: "toolu_w" }));
  h.script.answer("好");
  await h.until(async () => (await h.run(id)).idle === true);
  const before = await h.run(id);
  expect(before.tasks).toMatchObject([{ kind: "monitor", command: "wss://x/y" }]);

  const stopped = await h.call<AgentRun>("POST", `/v1/agent-runs/${before.id}/tasks/w1/stop`);
  expect(stopped.status).toBe(200);
  expect(h.script.stopped).toEqual(["w1"]);
  h.script.push(sys("task_updated", { task_id: "w1", patch: { status: "killed" } }));
  h.script.push(ended("w1", "stopped"));
  h.script.push(level());
  // Nothing more comes from Claude Code; the wait runs out and its input closes.
  await h.until(async () => (await h.run(id)).status === "completed");
  expect((await h.run(id)).tasks).toMatchObject([{ id: "w1", status: "stopped" }]);
});

test("Stop reads what was still going as stopped, and an earlier run's tasks stay listed", async () => {
  const h = start();
  const id = await h.open();
  await h.say(id, "一");
  await h.until(() => h.script.lines.length === 1);
  h.script.push(level("b1"));
  h.script.push(started("b1"));
  h.script.answer("好");
  await h.until(async () => (await h.run(id)).idle === true);
  const run = await h.run(id);
  await h.call("POST", `/v1/agent-runs/${run.id}/stop`);
  const over = await h.run(id);
  expect(over.status).toBe("stopped");
  expect(over.idle).toBe(false);
  expect(over.tasks).toMatchObject([{ id: "b1", status: "stopped" }]);
  expect(over.tasks![0]!.ended_at).toBeTruthy();
  const listed = await h.call<{ tasks: AgentRunTask[] }>("GET", `/v1/project-sessions/${id}/tasks`);
  expect(listed.body.tasks).toMatchObject([{ id: "b1", run_id: run.id, status: "stopped" }]);
  expect((await h.call("GET", `/v1/project-sessions/${ulid()}/tasks`)).status).toBe(404);
});

test("a backgrounded call's tool frame ends with its task, a foreground one's at once", async () => {
  const h = start();
  const id = await h.open();
  await h.say(id, "跑");
  await h.until(() => h.script.lines.length === 1);
  await h.script.useTool("Bash", { command: "ls" }, "toolu_fg", { stdout: "a" });
  await h.script.useTool("Bash", { command: "serve", run_in_background: true }, "toolu_bg", { backgroundTaskId: "b1" });
  h.script.push(level("b1"));
  h.script.push(started("b1", { tool_use_id: "toolu_bg" }));
  h.script.answer("好");
  await h.until(async () => (await h.run(id)).idle === true);
  const phases = (call: string) => h.tools.filter((frame) => frame.id === call).map((frame) => frame.phase);
  expect(phases("toolu_fg")).toEqual(["started", "exited"]);
  expect(phases("toolu_bg")).toEqual(["started"]);
  h.script.push(ended("b1", "completed", { tool_use_id: "toolu_bg" }));
  h.script.push(level());
  await h.until(() => phases("toolu_bg").length === 2);
  expect(h.tools.find((frame) => frame.id === "toolu_bg" && frame.phase === "exited")?.agent_run?.ok).toBe(true);
});

test("opening a task reads its output from the file, or asks the run while there is none", async () => {
  const h = start();
  const id = await h.open();
  await h.say(id, "跑");
  await h.until(() => h.script.lines.length === 1);
  const file = join(h.dir, "b2.output");
  writeFileSync(file, "line one\nline two\n");
  h.script.push(level("b1", "b2"));
  h.script.push(started("b1"));
  h.script.push(started("b2"));
  h.script.push({ type: "user", tool_use_result: { backgroundTaskId: "b2" }, message: { role: "user", content: [{ type: "tool_result", content: `Command running in background with ID: b2. Output is being written to: ${file}. You will be notified` }] } } as unknown as SDKMessage);
  h.script.answer("好");
  await h.until(async () => (await h.run(id)).idle === true);
  const run = await h.run(id);
  const read = async (task: string) => h.call<AgentTaskDetail>("GET", `/v1/agent-runs/${run.id}/tasks/${task}`);
  expect((await read("b2")).body).toMatchObject({ output: "line one\nline two\n", output_bytes: 18, prompt: null, steps: [] });
  expect((await read("b1")).body).toMatchObject({ output: "asked of b1", output_bytes: 11 });
  expect((await read("nope")).status).toBe(404);
});

test("a subagent's detail comes from its own session file, as far as it has got", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-trail-"));
  closes.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "agent-a1.jsonl");
  const entry = (value: unknown) => JSON.stringify(value);
  writeFileSync(file, [
    entry({ type: "user", timestamp: "2026-10-31T01:00:00.000Z", message: { role: "user", content: "数一下文件" } }),
    entry({ type: "assistant", timestamp: "2026-10-31T01:00:01.000Z", message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "先看目录" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
    entry({ type: "user", timestamp: "2026-10-31T01:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] } }),
    entry({ type: "assistant", timestamp: "2026-10-31T01:00:04.000Z", message: { model: "claude-haiku-5-5", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "a.txt" } }] } }),
    "{half a line being writ",
  ].join("\n"));
  const trail = readSubagentTrail(file);
  expect(trail.prompt).toBe("数一下文件");
  expect(trail.model).toBe("claude-haiku-5-5");
  expect(trail.steps).toEqual([
    { kind: "say", at: "2026-10-31T01:00:01.000Z", text: "先看目录" },
    { kind: "call", id: "t1", at: "2026-10-31T01:00:01.000Z", tool: "Bash", label: "Bash ls", ok: true, duration_ms: 2000, output: "a.txt" },
    { kind: "call", id: "t2", at: "2026-10-31T01:00:04.000Z", tool: "Read", label: "Read a.txt", ok: null, duration_ms: 0, output: null },
  ]);
  expect(readSubagentTrail(join(dir, "gone.jsonl"))).toEqual({ prompt: null, model: null, steps: [] });
});

test("a long output reads from a whole line near its end", () => {
  const dir = mkdtempSync(join(tmpdir(), "output-tail-"));
  closes.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "x.output");
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  const read = readOutputTail(file)!;
  expect(read.bytes).toBeGreaterThan(64 * 1024);
  expect(read.output.endsWith("line 19999\n")).toBe(true);
  expect(read.output.startsWith("line ")).toBe(true);
  expect(read.output.length).toBeLessThanOrEqual(64 * 1024);
  expect(readOutputTail(join(dir, "gone"))).toBeNull();
});

test("the board shows a foreground command only once it goes to the background, a subagent from the start, and leaves out Claude Code's own work", () => {
  const calls = new Map<string, TaskCall>([["t1", { tool: "Bash", input: { command: "sleep 9" } }], ["t2", { tool: "Agent", input: { prompt: "x" } }]]);
  const board = createTaskBoard((id) => (id ? calls.get(id) : undefined));
  expect(board.apply(started("c1", { tool_use_id: "t1", is_backgrounded: false }))).toBe(false);
  expect(board.list()).toEqual([]);
  expect(board.apply(sys("task_updated", { task_id: "c1", patch: { is_backgrounded: true } }))).toBe(true);
  expect(board.list()).toMatchObject([{ id: "c1", kind: "shell", command: "sleep 9" }]);

  expect(board.apply(started("c2", { tool_use_id: "t1", is_backgrounded: false }))).toBe(false);
  // The whole set going now: anything in it is in the background, however it started.
  expect(board.apply(level("c2"))).toBe(true);
  expect(board.list().map((task) => task.id)).toEqual(["c1", "c2"]);
  expect(board.going()).toBe(1);

  expect(board.apply(started("a1", { tool_use_id: "t2", is_backgrounded: false, task_type: "local_agent", subagent_type: "general-purpose" }))).toBe(true);
  expect(board.apply(sys("task_progress", { task_id: "a1", description: "Reading a.txt", usage: { total_tokens: 900, tool_uses: 2, duration_ms: 10 } }))).toBe(true);
  expect(board.list().at(-1)).toMatchObject({ kind: "subagent", agent_type: "general-purpose", activity: "Reading a.txt", tokens: 900, tool_uses: 2 });
  expect(board.apply(ended("a1"))).toBe(true);
  expect(board.list().at(-1)).toMatchObject({ status: "completed", activity: null, summary: "a1 completed" });

  expect(board.apply(started("x1", { ambient: true }))).toBe(false);
  expect(board.apply(sys("background_tasks_changed", { tasks: [{ task_id: "x2", ambient: true }] }))).toBe(false);
  expect(board.going()).toBe(0);
  expect(board.list().some((task) => task.id === "x1")).toBe(false);

  expect(backgroundTaskOf({ backgroundTaskId: "b" })).toBe("b");
  expect(backgroundTaskOf({ taskId: "m" })).toBe("m");
  expect(backgroundTaskOf({ isAsync: true, agentId: "a" })).toBe("a");
  expect(backgroundTaskOf({ isAsync: false, agentId: "a" })).toBeNull();
  expect(backgroundTaskOf({ stdout: "" })).toBeNull();
  expect(backgroundTaskOf("ok")).toBeNull();
});

test("the background is a project session's: Monitor answers to a command's rules, and a Bot gets none of it", () => {
  const root = realpathSync(tmpdir());
  const base = { cwd: root, mode: "work" as const, workspace: root, permission: "allow_all" as const };
  const project = { ...base, background: true };
  const kind = (call: Parameters<typeof decideAgentCall>[0]) => decideAgentCall(call).kind;
  // A Bot: as before.
  expect(kind({ ...base, tool: "Bash", input: { command: "npm run dev", run_in_background: true } })).toBe("deny");
  expect(kind({ ...base, tool: "Agent", input: { prompt: "x", run_in_background: true } })).toBe("deny");
  expect(kind({ ...base, tool: "Monitor", input: { command: "tail -f x" } })).toBe("deny");
  expect(kind({ ...base, tool: "TaskStop", input: { task_id: "b1" } })).toBe("deny");
  // A project session.
  expect(kind({ ...project, tool: "Bash", input: { command: "npm run dev", run_in_background: true } })).toBe("allow");
  expect(kind({ ...project, tool: "Agent", input: { prompt: "x", run_in_background: true } })).toBe("allow");
  expect(kind({ ...project, tool: "Monitor", input: { command: "tail -f x" } })).toBe("allow");
  expect(kind({ ...project, tool: "Monitor", input: { ws: { url: "wss://x" } } })).toBe("allow");
  expect(kind({ ...project, tool: "TaskStop", input: { task_id: "b1" } })).toBe("allow");
  // Still its rules: other tools, credentials and the permission mode.
  expect(kind({ ...project, tool: "CronCreate", input: {} })).toBe("deny");
  expect(decideAgentCall({ ...project, tool: "Monitor", input: { command: "tail -f ~/.claude/.credentials.json" } })).toMatchObject({ kind: "deny", reason: expect.stringContaining("off limits") });
  expect(kind({ ...project, permission: "ask_first", tool: "Monitor", input: { command: "tail -f x" } })).toBe("ask");
  expect(kind({ ...project, permission: "ask_first", tool: "Bash", input: { command: "serve", run_in_background: true } })).toBe("ask");
  expect(kind({ ...project, permission: "read_only", tool: "Monitor", input: { command: "tail -f x" } })).toBe("deny");
  // Claude Code tells it to read a task's output file; a subagent's is a link into its own config. Neither is refused by name.
  expect(kind({ ...project, tool: "Read", input: { file_path: "/private/tmp/claude-501/-a-b/own/tasks/b1.output" } })).toBe("allow");
  expect(kind({ ...project, tool: "Bash", input: { command: "tail -n 20 /private/tmp/claude-501/-a-b/own/tasks/b1.output" } })).toBe("allow");
});

test("a project session's Claude Code is offered the background: its tools and no switch turning it off", async () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  closes.push(() => store.close());
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "project-tasks-")));
  closes.push(() => rmSync(dir, { recursive: true, force: true }));
  let seen: { tools?: unknown; env?: Record<string, string | undefined> } = {};
  const query: ProjectQuery = ({ options }) => {
    seen = { tools: options.tools, env: options.env as Record<string, string | undefined> };
    return Object.assign((async function* (): AsyncGenerator<SDKMessage> {})(), { close() {} });
  };
  const runner = createProjectRunner({ store, claudeCode: probe, query });
  const session = store.createProjectSession({ dir, agent: "claude_code", configDir: null, locale: "zh" });
  runner.heard({ session_id: session.id, body: "hi", attachments: [] } as never);
  await runner.idle();
  expect(seen.tools).toEqual(expect.arrayContaining(["Monitor", "TaskStop", "Bash", "Agent"]));
  expect(seen.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
  runner.close();
});

test("the phone reaches a task as the window does", () => {
  const run = ulid();
  const id = ulid();
  const ok = (method: "GET" | "POST", path: string) => expect(() => validateBusiness({ v: 1, id, method, path } as never)).not.toThrow();
  ok("GET", `/v1/project-sessions/${run}/tasks`);
  ok("GET", `/v1/agent-runs/${run}/tasks/a68597c7a4213a465`);
  ok("POST", `/v1/agent-runs/${run}/tasks/bmz367860/stop`);
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: `/v1/agent-runs/${run}/tasks/${encodeURIComponent("../x")}` } as never)).toThrow();
});

test("a table from before these gets the columns", () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  closes.push(() => store.close());
  const names = store.db.query<{ name: string }, []>(`PRAGMA table_info(agent_runs)`).all().map((row) => row.name);
  expect(names).toEqual(expect.arrayContaining(["tasks", "idle"]));
});
