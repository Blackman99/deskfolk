import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallbackMatcher, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeCodeStatus, ClientEvent } from "@real-bot/protocol";
import type { CompletionOk, JudgeResult } from "./completions";
import type { ClaudeCodeProbe } from "./claude-code/probe";
import type { AgentQuery, AgentSession, AgentToolBridge } from "./engine/agent-runner";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function judged(content: string): JudgeResult {
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}
function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

const signedIn: ClaudeCodeStatus = {
  path: "/usr/local/bin/claude", source: "known", version: "2.1.289", sdk_version: "2.1.289", outdated: false,
  logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: null, base_url_set: false,
  proxy: null, proxy_source: null, checked_at: new Date(0).toISOString(), error: null,
};

function probeOf(status: ClaudeCodeStatus): ClaudeCodeProbe {
  return { last: () => status, current: async () => status, detect: async () => status };
}

type ToolUse = { allowed: boolean; reason?: string };

/** What a scripted Claude Code session can do: read its next user message, call a tool the way Claude Code would, and the app's own tools. */
type Script = (ctx: {
  first: SDKUserMessage;
  next: () => Promise<SDKUserMessage | null>;
  useTool: (name: string, input: Record<string, unknown>, run?: () => void) => Promise<ToolUse>;
  deskfolk: AgentToolBridge;
  options: Options;
  root: string;
}) => AsyncGenerator<SDKMessage>;

let toolSeq = 0;

/** A stand-in for the Agent SDK's query that runs `script` against the runner's hooks and callbacks, in Claude Code's order. */
function scripted(script: Script, seen: { options?: Options; firstText?: string; closed?: boolean }, root: string): AgentQuery {
  return ({ prompt, options, deskfolk }) => {
    seen.options = options;
    const iterator = prompt[Symbol.asyncIterator]();
    const hooks = (options.hooks ?? {}) as Record<string, HookCallbackMatcher[]>;
    const runHook = async (event: string, input: Record<string, unknown>, id: string) => {
      let decision: unknown = {};
      for (const matcher of hooks[event] ?? []) {
        for (const hook of matcher.hooks) decision = await hook({ hook_event_name: event, session_id: "s", transcript_path: "/dev/null", cwd: options.cwd ?? root, ...input } as never, id, { signal: new AbortController().signal });
      }
      return decision as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    };
    const useTool = async (name: string, input: Record<string, unknown>, run?: () => void): Promise<ToolUse> => {
      const id = `toolu_${++toolSeq}`;
      const pre = await runHook("PreToolUse", { tool_name: name, tool_input: input, tool_use_id: id }, id);
      let decision = pre.hookSpecificOutput?.permissionDecision ?? "ask";
      if (decision === "deny") return { allowed: false, reason: pre.hookSpecificOutput?.permissionDecisionReason };
      if (decision === "ask") {
        const verdict = await options.canUseTool!(name, input, { signal: new AbortController().signal, toolUseID: id, requestId: id } as never);
        if (!verdict || verdict.behavior === "deny") return { allowed: false, reason: verdict?.behavior === "deny" ? verdict.message : "no answer" };
        decision = "allow";
      }
      run?.();
      await runHook("PostToolUse", { tool_name: name, tool_input: input, tool_response: "ok", tool_use_id: id }, id);
      await runHook("PostToolBatch", { tool_calls: [{ tool_name: name, tool_input: input, tool_use_id: id }] }, id);
      return { allowed: true };
    };
    let closed = false;
    const generator = (async function* () {
      const first = await iterator.next();
      if (first.done) return;
      const content = first.value.message.content;
      seen.firstText = Array.isArray(content) ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n") : String(content);
      yield* script({
        first: first.value,
        next: async () => {
          const item = await iterator.next();
          return item.done ? null : item.value;
        },
        useTool,
        deskfolk,
        options,
        root,
      });
      // Claude Code stays up until its input closes.
      while (!closed) {
        const item = await iterator.next();
        if (item.done) break;
      }
    })();
    const session = generator as unknown as AgentSession;
    session.interrupt = async () => undefined;
    session.close = () => {
      closed = true;
      seen.closed = true;
    };
    return session;
  };
}

function result(text: string, cost = 0.01): SDKMessage {
  return {
    type: "result", subtype: "success", result: text, is_error: false, num_turns: 1, duration_ms: 1, duration_api_ms: 1,
    total_cost_usd: cost, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-sonnet-5": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } },
    permission_denials: [], uuid: crypto.randomUUID(), session_id: "s", stop_reason: "end_turn",
  } as unknown as SDKMessage;
}

function assistant(text: string): SDKMessage {
  return {
    type: "assistant", parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "s",
    message: { id: `msg_${crypto.randomUUID()}`, role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SDKMessage;
}

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});

async function harness(script: Script, opts: { status?: ClaudeCodeStatus; runner?: "claude_code" | null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-runner-")));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const events: ClientEvent[] = [];
  const completedWaiters: Array<() => void> = [];
  const seen: { options?: Options; firstText?: string; closed?: boolean } = {};
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
    claudeCode: probeOf(opts.status ?? signedIn),
    agentQuery: scripted(script, seen, root),
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
  const bot = store.createBot({ name: "Coder", duties: "write code", boundaries: "stay in the workspace", runner: opts.runner === undefined ? "claude_code" : opts.runner, agent_model: "sonnet" });
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
  return { store, engine, root, bot, session, events, seen, post, lines };
}

test("a Claude Agent Bot's turn is Claude Code's: its closing reply is posted and the turn completes", async () => {
  const h = await harness(async function* () {
    yield assistant("看过了");
    yield result("这是答复。");
  });
  await h.post("帮我看看这个项目");
  expect(h.lines("bot")).toEqual(["这是答复。"]);
  expect(h.seen.firstText).toContain("帮我看看这个项目");
  expect(h.seen.options?.settingSources).toEqual([]);
  expect(h.seen.options?.permissionMode).toBe("default");
  expect(h.seen.options?.model).toBe("sonnet");
  expect(h.seen.options?.disallowedTools).toContain("AskUserQuestion");
  expect(h.seen.options?.tools).not.toContain("AskUserQuestion");
  expect(String((h.seen.options?.systemPrompt as { append?: string })?.append)).toContain("mcp__deskfolk__");
  const route = h.store.db.query<{ provider_id: string | null; model: string; reason_code: string | null }, []>(
    "SELECT provider_id, model, reason_code FROM turn_route_decisions").get();
  expect(route).toEqual({ provider_id: null, model: "sonnet", reason_code: "claude_code" });
  const spend = h.store.db.query<{ provider_id: string | null; provider_name: string; model: string; estimated_cost_usd_ticks: number; cost_usd_ticks: number | null }, []>(
    "SELECT provider_id, provider_name, model, estimated_cost_usd_ticks, cost_usd_ticks FROM spend WHERE kind = 'turn'").get();
  expect(spend).toEqual({ provider_id: null, provider_name: "Claude Agent", model: "claude-sonnet-5", estimated_cost_usd_ticks: 100_000_000, cost_usd_ticks: null });
});

test("a Bot on the app's own loop is untouched by any of it", async () => {
  const h = await harness(async function* () {
    yield result("should not run");
  }, { runner: null });
  await h.post("hi");
  expect(h.lines("bot")).toEqual(["the hop loop ran"]);
  expect(h.seen.options).toBeUndefined();
});

test("a write inside the workspace runs without asking and is cited with the reply", async () => {
  const h = await harness(async function* ({ useTool, root }) {
    const file = join(root, "notes.md");
    const used = await useTool("Write", { file_path: file, content: "# notes" }, () => writeFileSync(file, "# notes"));
    expect(used.allowed).toBe(true);
    yield result("写好了 notes.md");
  });
  await h.post("写个笔记");
  expect(h.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM approvals").get()!.n).toBe(0);
  expect(existsSync(join(h.root, "notes.md"))).toBe(true);
  const tools = h.events.filter((event) => event.event === "turn.tool") as Array<{ name?: string; phase?: string }>;
  expect(tools.map((event) => `${event.name}:${event.phase}`)).toEqual(["write_file:started", "write_file:exited"]);
});

test("a write outside the workspace waits for your approval, and a denial reaches Claude Code", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agent-outside-")));
  let verdict: { allowed: boolean; reason?: string } | null = null;
  const h = await harness(async function* ({ useTool }) {
    verdict = await useTool("Write", { file_path: join(outside, "x.txt"), content: "x" }, () => writeFileSync(join(outside, "x.txt"), "x"));
    yield result(verdict.allowed ? "写了" : "没写成");
  });
  const done = h.post("写到外面去");
  // The card is up and the turn waits on it.
  let approvalId: string | null = null;
  for (let i = 0; i < 100 && !approvalId; i++) {
    await Bun.sleep(10);
    approvalId = h.store.db.query<{ id: string }, []>("SELECT id FROM approvals WHERE status = 'pending'").get()?.id ?? null;
  }
  expect(approvalId).not.toBeNull();
  const approval = h.store.db.query<{ kind_key: string; summary: string }, [string]>("SELECT kind_key, summary FROM approvals WHERE id = ?").get(approvalId!);
  expect(approval!.kind_key).toBe("outside-write");
  expect(approval!.summary).toContain(join(outside, "x.txt"));
  h.engine.resolveApproval(approvalId!, "deny");
  await done;
  expect(verdict!.allowed).toBe(false);
  expect(verdict!.reason).toContain("denied");
  expect(existsSync(join(outside, "x.txt"))).toBe(false);
  expect(h.lines("bot")).toEqual(["没写成"]);
  rmSync(outside, { recursive: true, force: true });
});

test("an approved write outside the workspace runs", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agent-outside-")));
  const h = await harness(async function* ({ useTool }) {
    const used = await useTool("Write", { file_path: join(outside, "y.txt"), content: "y" }, () => writeFileSync(join(outside, "y.txt"), "y"));
    yield result(used.allowed ? "写了" : "没写成");
  });
  const done = h.post("写到外面去");
  let approvalId: string | null = null;
  for (let i = 0; i < 100 && !approvalId; i++) {
    await Bun.sleep(10);
    approvalId = h.store.db.query<{ id: string }, []>("SELECT id FROM approvals WHERE status = 'pending'").get()?.id ?? null;
  }
  h.engine.resolveApproval(approvalId!, "allow_once");
  await done;
  expect(readFileSync(join(outside, "y.txt"), "utf8")).toBe("y");
  expect(h.lines("bot")).toEqual(["写了"]);
  rmSync(outside, { recursive: true, force: true });
});

test("Claude Code's own credentials are refused outright, with no card", async () => {
  let verdict: { allowed: boolean; reason?: string } | null = null;
  const h = await harness(async function* ({ useTool }) {
    verdict = await useTool("Bash", { command: "cat ~/.claude/.credentials.json" });
    yield result("读不到");
  });
  await h.post("看看凭据");
  expect(verdict!.allowed).toBe(false);
  expect(h.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM approvals").get()!.n).toBe(0);
});

test("a tool outside the short list is refused", async () => {
  let verdict: { allowed: boolean; reason?: string } | null = null;
  const h = await harness(async function* ({ useTool }) {
    verdict = await useTool("CronCreate", { schedule: "* * * * *" });
    yield result("ok");
  });
  await h.post("定个时");
  expect(verdict!.allowed).toBe(false);
  expect(verdict!.reason).toContain("not available");
});

test("end_turn through the deskfolk tools ends the segment silently; Claude Code's later result is dropped", async () => {
  let ended = "";
  const h = await harness(async function* ({ deskfolk }) {
    const out = await deskfolk.call("end_turn", { reason: "nothing_new" });
    ended = out.text;
    yield result("这一句不该发出去");
  });
  await h.post("没什么事");
  expect(ended).toContain("\"ok\":true");
  expect(h.lines("bot")).toEqual([]);
  expect(h.seen.closed).toBe(true);
});

test("an empty closing reply is answered with one note, and the next reply goes out", async () => {
  const h = await harness(async function* ({ next }) {
    yield result("");
    const nudge = await next();
    expect(nudge).not.toBeNull();
    yield result("补上了答复");
  });
  await h.post("说点什么");
  expect(h.lines("bot")).toEqual(["补上了答复"]);
});

test("Claude Code missing or signed out fails the turn with a line that says so", async () => {
  const missing = await harness(async function* () {
    yield result("never");
  }, { status: { ...signedIn, path: null, error: "not found" } });
  await missing.post("hi");
  expect(missing.lines("system").some((line) => line.includes("没找到 Claude Code"))).toBe(true);
  expect(missing.seen.options).toBeUndefined();

  const signedOut = await harness(async function* () {
    yield result("never");
  }, { status: { ...signedIn, logged_in: false } });
  await signedOut.post("hi");
  expect(signedOut.lines("system").some((line) => line.includes("没通过认证") && line.includes("还没登录"))).toBe(true);
});

test("a request Claude Code could not make fails the turn with its own line, never posted as the reply", async () => {
  const refused = "Failed to authenticate. API Error: 403 Request not allowed";
  const h = await harness(async function* () {
    yield { ...(assistant(refused) as object), error: "authentication_failed" } as unknown as SDKMessage;
    yield { ...(result(refused, 0) as object), is_error: true } as unknown as SDKMessage;
  });
  await h.post("hi");
  expect(h.lines("bot")).toEqual([]);
  const line = h.lines("system").find((body) => body.includes("没通过认证"));
  expect(line).toContain("403 Request not allowed");
  const partials = h.events.filter((event) => event.event === "turn.upsert" && (event as { partial_text?: string | null }).partial_text);
  expect(partials.some((event) => String((event as { partial_text?: string }).partial_text).includes("403"))).toBe(false);
  // Yours to fix, so nothing retries it.
  const cut = h.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_items WHERE state = 'needs_attention'").get();
  expect(cut?.n ?? 0).toBe(0);
});

test("any other request that failed ends the turn as Claude Code stopping, with its line", async () => {
  const h = await harness(async function* () {
    yield { ...(result("API Error: 529 Overloaded", 0) as object), is_error: true } as unknown as SDKMessage;
  });
  await h.post("hi");
  expect(h.lines("bot")).toEqual([]);
  expect(h.lines("system").find((body) => body.includes("中途退出"))).toContain("529 Overloaded");
});

test("with no proxy in the daemon's environment, Claude Code gets the system's HTTPS proxy the card shows", async () => {
  const h = await harness(async function* () {
    yield result("好了");
  }, { status: { ...signedIn, proxy: "http://10.9.8.7:3128", proxy_source: "system" } });
  await h.post("hi");
  const env = h.seen.options?.env ?? {};
  expect(env.HTTPS_PROXY).toBe("http://10.9.8.7:3128");
  expect(env.NO_PROXY ?? env.no_proxy).toBeTruthy();
  expect(env.HTTP_PROXY).toBe(process.env.HTTP_PROXY);

  const passed = await harness(async function* () {
    yield result("好了");
  }, { status: { ...signedIn, proxy: "http://***@10.0.0.2:8080", proxy_source: "env" } });
  await passed.post("hi");
  expect(passed.seen.options?.env?.HTTPS_PROXY).toBe(process.env.HTTPS_PROXY);
});

test("a usage limit fails the turn with when it resets, and the supervisor does not retry it", async () => {
  const h = await harness(async function* () {
    yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000 }, uuid: crypto.randomUUID(), session_id: "s" } as unknown as SDKMessage;
    yield { ...(result("") as object), subtype: "error_during_execution", errors: ["limit"] } as unknown as SDKMessage;
  });
  await h.post("干活");
  const line = h.lines("system").find((body) => body.includes("用量额度用完了"));
  expect(line).toBeDefined();
  expect(line).toContain("重置");
  const cut = h.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_items WHERE state = 'needs_attention'").get();
  expect(cut?.n ?? 0).toBe(0);
});

test("past the plan's limit with extra usage on, the turn goes on and its reply is posted", async () => {
  const h = await harness(async function* () {
    yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000, overageStatus: "allowed", isUsingOverage: true }, uuid: crypto.randomUUID(), session_id: "s" } as unknown as SDKMessage;
    yield result("做完了。");
  });
  await h.post("干活");
  expect(h.lines("bot")).toEqual(["做完了。"]);
  expect(h.lines("system").some((body) => body.includes("用量额度用完了"))).toBe(false);
});

test("a request the limit stopped fails as the limit, with when it resets, whatever Claude Code wrote", async () => {
  const h = await harness(async function* () {
    yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000 }, uuid: crypto.randomUUID(), session_id: "s" } as unknown as SDKMessage;
    yield { ...(assistant("You've hit your limit") as object), error: "rate_limit" } as unknown as SDKMessage;
    yield { ...(result("You've hit your limit", 0) as object), is_error: true } as unknown as SDKMessage;
  });
  await h.post("干活");
  expect(h.lines("bot")).toEqual([]);
  const line = h.lines("system").find((body) => body.includes("用量额度用完了"));
  expect(line).toContain("重置");
});

test("only the user chooses what runs a Bot", () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const bot = store.createBot({ name: "Helper", duties: "help", boundaries: "none" });
  expect(() => store.patchBot(bot.bot.id, { runner: "claude_code" }, bot.bot.id)).toThrow("only the user");
  const patched = store.patchBot(bot.bot.id, { runner: "claude_code", agent_model: "opus", agent_effort: "high" });
  expect(patched.runner).toBe("claude_code");
  expect(patched.agent_model).toBe("opus");
  expect(patched.agent_effort).toBe("high");
  expect(() => store.patchBot(bot.bot.id, { agent_effort: "extreme" as never })).toThrow("agent_effort");
  expect(() => store.patchBot(bot.bot.id, { agent_model: "rm -rf" })).toThrow("Claude model name");
  store.close();
});
