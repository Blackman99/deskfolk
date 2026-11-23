import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallbackMatcher, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRun, AgentTaskDetail, ClaudeCodeStatus, SessionDetail } from "@real-bot/protocol";
import type { ClaudeCodeProbe } from "./claude-code/probe";
import type { AgentToolBridge } from "./engine/agent-runner";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import { CONSULT_TOOL } from "./project-consult";
import type { ProjectQuery } from "./project-runner";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

const signedIn = { path: "/usr/local/bin/claude", version: "2.1.329", logged_in: true, accounts: [] } as unknown as ClaudeCodeStatus;
const probe: ClaudeCodeProbe = { last: () => signedIn, current: async () => signedIn, detect: async () => signedIn };

type UseTool = (name: string, input: Record<string, unknown>, call?: { agentId?: string }) => Promise<boolean>;
/** One line of a run: `deskfolk` is there for a session of yours, absent for a consultant. */
type Step = (ctx: { line: string; options: Options; useTool: UseTool; deskfolk?: AgentToolBridge; signal: AbortSignal }) => Promise<string>;
type Seen = { parent: Options[]; consultant: Options[]; lines: string[]; denied: string[] };

/** Claude Code for both sides: a run with the app's tool is the asking session's, one without is a consultant's. */
function scripted(seen: Seen, parentStep: Step, consultantStep: Step): ProjectQuery {
  let tool = 0;
  return ({ prompt, options, deskfolk }) => {
    (deskfolk ? seen.parent : seen.consultant).push(options);
    const abort = new AbortController();
    // Stop ends the process, as the SDK's abort does.
    options.abortController?.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const hooks = (options.hooks ?? {}) as Record<string, HookCallbackMatcher[]>;
    const runHook = async (event: string, input: Record<string, unknown>, id: string) => {
      let decision: unknown = {};
      for (const matcher of hooks[event] ?? []) {
        for (const hook of matcher.hooks) decision = await hook({ hook_event_name: event, session_id: "s", transcript_path: "/dev/null", cwd: options.cwd, ...input } as never, id, { signal: abort.signal });
      }
      return decision as { hookSpecificOutput?: { permissionDecision?: string } };
    };
    const useTool: UseTool = async (name, input, call = {}) => {
      const id = `toolu_${++tool}`;
      const pre = await runHook("PreToolUse", { tool_name: name, tool_input: input, tool_use_id: id, ...(call.agentId ? { agent_id: call.agentId } : {}) }, id);
      const decision = pre.hookSpecificOutput?.permissionDecision ?? "ask";
      if (decision === "deny") {
        seen.denied.push(name);
        return false;
      }
      if (decision === "ask") {
        const verdict = await options.canUseTool!(name, input, { signal: abort.signal, toolUseID: id, requestId: id } as never);
        if (!verdict || verdict.behavior === "deny") {
          seen.denied.push(name);
          return false;
        }
      }
      await runHook("PostToolUse", { tool_name: name, tool_input: input, tool_response: "ok", tool_use_id: id }, id);
      return true;
    };
    const own = deskfolk ? "parent-own" : `consultant-own-${seen.consultant.length}`;
    let closed = false;
    const generator = (async function* (): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: own, model: "claude-sonnet-5", uuid: crypto.randomUUID() } as unknown as SDKMessage;
      for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
        if (closed) break;
        const content = message.message.content;
        const line = typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
        seen.lines.push(line);
        const reply = await (deskfolk ? parentStep : consultantStep)({ line, options, useTool, ...(deskfolk ? { deskfolk } : {}), signal: abort.signal });
        yield { type: "result", subtype: "success", result: reply, is_error: false, session_id: own, uuid: crypto.randomUUID() } as unknown as SDKMessage;
      }
    })();
    return Object.assign(generator, { close: () => { closed = true; abort.abort(); } });
  };
}

const FAKE_GROK = join(import.meta.dir, "fixtures/agents/fake-grok.ts");

function start(parentStep: Step, consultantStep: Step, opts: { waitMs?: number; grok?: Record<string, unknown> } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "consult-")));
  const grokLog = realpathSync(mkdtempSync(join(tmpdir(), "consult-grok-")));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: Seen = { parent: [], consultant: [], lines: [], denied: [] };
  const api = createLocalApi({ store, token: "consult-test", schedule: false, claudeCode: probe, projectQuery: scripted(seen, parentStep, consultantStep),
    projectConsultPollMs: 10, ...(opts.waitMs !== undefined ? { projectConsultWaitMs: opts.waitMs } : {}), projectSettleMs: 80,
    // A Grok consultant is the fake Grok playing `opts.grok`.
    projectGrok: async () => ({ ok: true, executable: process.execPath, source: "known", args: [FAKE_GROK, "agent", "--no-leader", "stdio"], proxy: null,
      env: { ...process.env as Record<string, string>, FAKE_GROK_SCRIPT: JSON.stringify(opts.grok ?? { prompts: [] }), FAKE_GROK_LOG: join(grokLog, "run.log") } }) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { api.projects.close(); await api.projects.idle(); await api.engine.close(); store.close(); await server.stop(true); rmSync(dir, { recursive: true, force: true }); rmSync(grokLog, { recursive: true, force: true }); });
  const origin = `http://${server.hostname}:${server.port}`;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${origin}${path}`, { method, headers: { Authorization: "Bearer consult-test", "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": ulid() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const run = async (sessionId: string) => (await call<{ run: AgentRun | null }>("GET", `/v1/project-sessions/${sessionId}/run`)).body.run;
  const until = async (check: () => Promise<boolean> | boolean, tries = 500) => {
    for (let i = 0; i < tries; i += 1) {
      if (await check()) return;
      await Bun.sleep(10);
    }
    throw new Error("timed out");
  };
  const lines = (sessionId: string) => store.db
    .query<{ kind: string; body: string }, [string]>(`SELECT kind, body FROM messages WHERE session_id = ? ORDER BY message_seq`).all(sessionId);
  const session = async () => (await call<SessionDetail>("POST", "/v1/project-sessions", { dir })).body.id;
  const say = (sessionId: string, body: string) => call<{ id: string }>("POST", `/v1/sessions/${sessionId}/messages`, { body });
  return { store, dir, seen, call, run, until, lines, session, say };
}

/** The consult tool as the agent calls it: through Claude Code's gate first, then the call itself. */
async function consult(ctx: Parameters<Step>[0], args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (!(await ctx.useTool(`mcp__deskfolk__${CONSULT_TOOL}`, args))) return { text: "refused", isError: true };
  return ctx.deskfolk!.call(CONSULT_TOOL, args);
}

const consultantIdOf = (text: string) => /(?:参谋|Consultant) (\S+) ·/.exec(text)?.[1] ?? "";

test("asked in by the agent, a consultant answers in its own session under this one, and only looks", async () => {
  const answers: string[] = [];
  const h = start(async (ctx) => {
    const out = await consult(ctx, { agent: "claude_code", model: "haiku", message: "方案 A 还是 B？看 src/cache.ts" });
    answers.push(out.text);
    return `参谋说：${out.text}`;
  }, async ({ useTool }) => {
    // It may read, never write or run anything.
    const read = await useTool("Read", { file_path: "src/cache.ts" });
    const wrote = await useTool("Write", { file_path: "x.txt", content: "hi" });
    const ran = await useTool("Bash", { command: "ls" });
    return `选 B。read=${read} wrote=${wrote} ran=${ran}`;
  });
  const parent = await h.session();
  await h.say(parent, "请 Claude 的 haiku 也看看这个方案");
  await h.until(async () => (await h.run(parent))?.status === "completed");

  expect(answers[0]).toContain("选 B。read=true wrote=false ran=false");
  const consultant = consultantIdOf(answers[0]!);
  const row = h.store.getSession(consultant);
  expect(row).toMatchObject({ kind: "project", project_parent_id: parent, project_dir: h.dir, project_agent: "claude_code", project_model: "haiku" });
  expect(row.name).toContain("参谋 · Claude Code");
  // Its first line says who asks and what it may do; then what it was asked.
  const first = h.lines(consultant)[0]!;
  expect(first.kind).toBe("user");
  expect(first.body).toStartWith("[Deskfolk 参谋]");
  expect(first.body).toEndWith("方案 A 还是 B？看 src/cache.ts");
  // A consultant never plans, sends nothing to the background and gets no consult tool of its own.
  expect(h.seen.consultant[0]!.tools).not.toContain("ExitPlanMode");
  expect(h.seen.consultant[0]!.tools).not.toContain("Monitor");
  expect(h.seen.consultant[0]!.cwd).toBe(h.dir);

  // The call is a task on the asking run, and opens onto what the consultant said.
  const run = (await h.run(parent))!;
  const task = run.tasks!.find((one) => one.id.startsWith("consult_"))!;
  expect(task).toMatchObject({ kind: "subagent", status: "completed", agent: "claude_code", model: "haiku", agent_type: "Claude Code" });
  const detail = await h.call<AgentTaskDetail>("GET", `/v1/agent-runs/${run.id}/tasks/${encodeURIComponent(task.id)}`);
  expect(detail.status).toBe(200);
  // What the agent asked, without the app's opener.
  expect(detail.body.prompt).toBe("方案 A 还是 B？看 src/cache.ts");
  expect(detail.body.model).toBe("haiku");
  expect(detail.body.steps.map((step) => (step.kind === "say" ? step.text : ""))).toEqual(["选 B。read=true wrote=false ran=false"]);

  // Not a conversation of its own: its agent session is the app's, and search does not find it.
  expect(h.store.knownAgentSessions("claude_code").has("consultant-own-1")).toBe(true);
  const found = await h.call<{ items: Array<{ session_id?: string }> }>("GET", `/v1/search?q=${encodeURIComponent("选 B")}`);
  expect((found.body.items ?? []).some((item) => item.session_id === consultant)).toBe(false);
  const listed = await h.call<{ items: Array<{ id: string }> }>("GET", "/v1/sessions");
  expect(listed.body.items.map((item) => item.id)).toContain(parent);
  expect(listed.body.items.map((item) => item.id)).not.toContain(consultant);
});

test("the agent goes on with the same consultant, and answers a question it asks", async () => {
  const results: string[] = [];
  const h = start(async (ctx) => {
    const first = await consult(ctx, { agent: "claude_code", message: "缓存放哪一层？" });
    results.push(first.text);
    const id = consultantIdOf(first.text);
    const answered = await consult(ctx, { consultant: id, message: "读多写少，单机" });
    results.push(answered.text);
    const again = await consult(ctx, { consultant: id, message: "/compact 不是命令，只是一句话" });
    results.push(again.text);
    return "好";
  }, async ({ line, useTool }) => {
    if (line.includes("缓存放哪一层")) {
      // Its question goes to the agent that asked it, not to you.
      await useTool("AskUserQuestion", { questions: [{ question: "读多还是写多？", header: "负载", multiSelect: false, options: [{ label: "读多", description: "" }, { label: "写多", description: "" }] }] });
      return "那就放在服务层，用 LRU。";
    }
    return `收到：${line}`;
  });
  const parent = await h.session();
  await h.say(parent, "问问另一个 Claude");
  await h.until(async () => (await h.run(parent))?.status === "completed", 800);

  expect(results[0]).toContain("在问你");
  expect(results[0]).toContain("读多还是写多？（选项：读多 / 写多）");
  expect(results[1]).toContain("那就放在服务层，用 LRU。");
  // A line that looks like a command reaches it as words.
  expect(results[2]).toContain("收到：› /compact 不是命令，只是一句话");
  const consultant = consultantIdOf(results[0]!);
  // The answer is written on its question, as yours would be; it came in as a line of the asking agent.
  const asks = h.store.db.query<{ ask_answer: string | null }, [string]>(`SELECT ask_answer FROM messages WHERE session_id = ? AND kind = 'ask'`).all(consultant);
  expect(JSON.parse(asks[0]!.ask_answer!)).toMatchObject({ custom: "读多写少，单机" });
  const run = (await h.run(parent))!;
  expect(run.tasks!.filter((one) => one.id.startsWith("consult_")).length).toBe(3);
});

test("a consultant still at it past the wait says so; called again, the agent gets its answer", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const results: string[] = [];
  const h = start(async (ctx) => {
    const first = await consult(ctx, { agent: "claude_code", message: "慢慢想" });
    results.push(first.text);
    release();
    const second = await consult(ctx, { consultant: consultantIdOf(first.text) });
    results.push(second.text);
    return "好";
  }, async () => {
    await released;
    return "想好了";
  }, { waitMs: 150 });
  const parent = await h.session();
  await h.say(parent, "问问看");
  await h.until(async () => (await h.run(parent))?.status === "completed");
  expect(results[0]).toContain("还在想");
  expect(results[1]).toContain("想好了");
});

test("Stop on the asking run stops its consultants with it", async () => {
  let result: { text: string; isError: boolean } | null = null;
  const h = start(async (ctx) => {
    result = await consult(ctx, { agent: "claude_code", message: "想很久" });
    return "好";
  }, async ({ signal }) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return "不会到这里";
  });
  const parent = await h.session();
  await h.say(parent, "问问看");
  let consultant = "";
  await h.until(() => {
    consultant = h.store.consultantsOf(parent)[0] ?? "";
    return consultant !== "" && h.store.latestAgentRun(consultant)?.status === "running";
  });
  const live = (await h.run(parent))!;
  await h.call("POST", `/v1/agent-runs/${live.id}/stop`);
  await h.until(() => h.store.latestAgentRun(consultant)?.status === "stopped");
  await h.until(() => result !== null);
  expect(result!.isError).toBe(true);
});

test("a subagent of the agent asks no consultant, and a consultant's own run has no consult tool", async () => {
  const h = start(async (ctx) => {
    const bySubagent = await ctx.useTool(`mcp__deskfolk__${CONSULT_TOOL}`, { agent: "codex", message: "?" }, { agentId: "sub-1" });
    const own = await consult(ctx, { agent: "claude_code", message: "你好" });
    return `sub=${bySubagent} own=${own.isError ? "error" : "ok"}`;
  }, async ({ deskfolk }) => `has tool: ${deskfolk ? "yes" : "no"}`);
  const parent = await h.session();
  await h.say(parent, "问问看");
  await h.until(async () => (await h.run(parent))?.status === "completed");
  expect(h.lines(parent).at(-1)!.body).toBe("sub=false own=ok");
  const consultant = h.store.consultantsOf(parent)[0]!;
  expect(h.lines(consultant).at(-1)!.body).toBe("has tool: no");
  expect(h.seen.denied).toContain(`mcp__deskfolk__${CONSULT_TOOL}`);
});

test("deleting the session deletes its consultants; a runner's own task list keeps the consultants' tasks", async () => {
  const h = start(async (ctx) => (await consult(ctx, { agent: "claude_code", message: "看一眼" })).text, async () => "看过了");
  const parent = await h.session();
  await h.say(parent, "问问看");
  await h.until(async () => (await h.run(parent))?.status === "completed");
  const run = (await h.run(parent))!;
  const consultant = h.store.consultantsOf(parent)[0]!;
  // What a runner says of its own tasks replaces its list, but not the consultants' on it.
  h.store.updateAgentRun(run.id, { tasks: [] });
  expect(h.store.getAgentRun(run.id).tasks!.some((one) => one.id.startsWith("consult_"))).toBe(true);
  const removed = await h.call("DELETE", `/v1/sessions/${parent}`);
  expect(removed.status).toBe(204);
  expect(() => h.store.getSession(consultant)).toThrow();
  // Its agent's session stays known to the app, so no list of your terminal sessions offers it.
  expect(h.store.knownAgentSessions("claude_code").has("consultant-own-1")).toBe(true);
});

test("a Grok consultant's question goes to the asking agent, and its answer goes back on the same run", async () => {
  const results: string[] = [];
  const h = start(async (ctx) => {
    const first = await consult(ctx, { agent: "grok", message: "回复用户时用哪种语气？" });
    results.push(first.text);
    const answered = await consult(ctx, { consultant: consultantIdOf(first.text), message: "Formal" });
    results.push(answered.text);
    return "好";
  }, async () => "unused", { grok: { prompts: [[{ question: [{ question: "Tone?", options: ["Formal", "Casual"] }] }, { say: "Formal it is." }]] } });
  const parent = await h.session();
  await h.say(parent, "问问 Grok");
  await h.until(async () => (await h.run(parent))?.status === "completed", 800);
  expect(results[0]).toContain("在问你");
  expect(results[0]).toContain("Tone?（选项：Formal / Casual）");
  expect(results[1]).toContain("Formal it is.");
  const consultant = h.store.consultantsOf(parent)[0]!;
  // One Grok run took both the question and its answer.
  expect(h.store.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?`).get(consultant)?.n).toBe(1);
});
