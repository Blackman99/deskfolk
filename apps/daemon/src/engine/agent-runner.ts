/**
 * A Claude Agent turn (ADR 0061): the turn of a Bot whose runner is `claude_code`, worked by the
 * user's own installed and signed-in Claude Code through the Agent SDK instead of the app's hop
 * loop. One Deskfolk turn is one fresh Claude Code session in the turn's work dir. Claude Code works
 * with its own tools; the app wraps them in what every turn has — the workspace boundary and your
 * approvals, holds and Stop, the effect gate and its records — and offers its own collaboration
 * tools (`mcp__deskfolk__*`) through `executeTools`, so endings, hand-overs, reviews and delegation
 * mean what they mean for any Bot. A closing reply goes through the same `settleClosingReply` the
 * hop loop uses; a line it bounces comes back to Claude Code as the next user message.
 *
 * Deskfolk never signs Claude Code in and never touches its credentials: it runs the `claude` the
 * user installed, with the environment the daemon has, and only shows which credential that is.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  Options,
  PermissionResult,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClientEvent, Message, Spend, Turn } from "@real-bot/protocol";
import { withSystemProxy } from "../claude-code/proxy";
import { claudeLaunch, killsTree } from "../claude-code/spawn";
import { claudeChildEnv } from "../claude-code/status";
import type { ClaudeCodeProbe } from "../claude-code/probe";
import { AGENT_READONLY_TOOLS, AGENT_WORK_TOOLS, appToolName, decideAgentCall } from "../claude-code/policy";
import { assembleAgentTurnInput, memoryDigest } from "../context";
import type { ToolCall } from "../completions";
import { INTERRUPT_FLAG, OWN_FILE_TOOLS, builtinTools, type ChatTool, type FailKind } from "../prompts";
import { agentSystemPrompt, AGENT_MCP_SERVER, agentToolName } from "../prompts/agent-system";
import { classifyMessage } from "../route-decision";
import { recordLiveProc } from "../live-procs";
import type { McpHost } from "../mcp-host";
import { inboxLabel, type Store } from "../store";
import { ENGINE_LEVELS } from "../store/schema-gate";
import { heardNote } from "../turn-inbox";
import { classifyPath } from "../workspace-paths";
import { producedPaths, snapshotWorkDir } from "../workspace-tools";
import { emptyReplyNote } from "../turn-pace";
import { readOnlyTools, type Tools } from "./tools";
import type { Live } from "./types";
import type { Chains } from "./chains";
import type { SpendTracker } from "./spend";
import daemonPackage from "../../package.json";
import { editedToolDescription, promptPage, turnPromptTexts } from "../prompts/book";

/** One tool of the app's, as Claude Code is offered it: the app's own name and JSON schema. */
export type AgentTool = { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean };

/** What the app's tools look like from inside a Claude Agent session. */
export type AgentToolBridge = {
  tools: AgentTool[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
};

/** The running session: its messages, and the two ways to end it. */
export type AgentSession = AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown>; close(): void };

/**
 * Starts a Claude Code session: the Agent SDK's `query` with the app's tools mounted as the
 * `deskfolk` MCP server, or a stand-in a test scripts (it gets the bridge directly).
 */
export type AgentQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options; deskfolk: AgentToolBridge }) => AgentSession;

/** Claude Agent turns running at once, across every Bot; the next waits for a slot. */
export const AGENT_SLOTS = 3;
/** A backstop over Claude Code's own loop; the app's hop ceiling plus the steps it allows past it. */
export const AGENT_MAX_TURNS = 200;
/** How long an in-process MCP call (an ask, an approval) may wait. */
const DESKFOLK_TOOL_TIMEOUT_MS = 24 * 60 * 60_000;
/** How long the session gets to wind down once its segment is over. */
const WIND_DOWN_MS = 10_000;
/** The tool results the redirect carry and the hold receipts read back stay short. */
const LOOP_RESULT_MAX = 2_000;
const STDERR_KEEP = 8 * 1024;

export type AgentRunnerDeps = {
  store: Store;
  publish: (event: ClientEvent) => void;
  publishMessage: (message: Message) => void;
  publishTurn: (turn: Turn, partial?: string | null) => void;
  publishSpend: (row: Spend) => void;
  occurred: () => string;
  lives: Map<string, Live>;
  active: (turnId: string, live: Live) => boolean;
  mcp: McpHost | undefined;
  claudeCode: ClaudeCodeProbe | undefined;
  agentQuery?: AgentQuery;
  closeChain: Chains["closeChain"];
  holdChain: Chains["holdChain"];
  spendOwner: SpendTracker["spendOwner"];
  executeTools: Tools["executeTools"];
  openApprovalCard: Tools["openApprovalCard"];
  beforeEffect: Tools["beforeEffect"];
  noteWrittenPaths: Tools["noteWrittenPaths"];
  settleClosingReply: (turnId: string, live: Live, current: Turn, content: string) => Promise<{ kind: "bounce"; note: string } | { kind: "ended" } | { kind: "inactive" }>;
  completeSilent: (turnId: string) => void;
  saidNothing: (turn: Turn, live: Live) => void;
  failTurn: (turnId: string, kind: FailKind, detail?: string | null) => void;
  /** Spawning Claude Code; the SDK's own spawn, made detached and recorded, unless a test brings one. */
  spawnProcess?: (options: SpawnOptions, turnId: string) => SpawnedProcess;
};

export type AgentRunner = {
  runAgentTurn(turnId: string): Promise<void>;
};

type ModelTotals = { input: number; output: number; cached: number; cost: number };

/** A queue the session reads its user messages from; it stays open until the segment is over. */
function inputQueue<T>() {
  const items: T[] = [];
  let wake: ((result: IteratorResult<T>) => void) | null = null;
  let closed = false;
  return {
    push(item: T) {
      if (closed) return;
      if (wake) {
        const resolve = wake;
        wake = null;
        resolve({ value: item, done: false });
      } else items.push(item);
    },
    close() {
      closed = true;
      if (wake) {
        const resolve = wake;
        wake = null;
        resolve({ value: undefined as T, done: true });
      }
    },
    get closed() { return closed; },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next: () => {
            if (items.length > 0) return Promise.resolve({ value: items.shift()!, done: false });
            if (closed) return Promise.resolve({ value: undefined as T, done: true });
            return new Promise<IteratorResult<T>>((resolve) => { wake = resolve; });
          },
        };
      },
    } as AsyncIterable<T>,
  };
}

/** Runs one at a time what must not interleave: approvals, questions and the app's tool calls. */
function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
}

function userMessage(content: SDKUserMessage["message"]["content"]): SDKUserMessage {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textOfToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text"
      ? String((part as { text?: unknown }).text ?? "") : "")).filter(Boolean).join("\n");
  }
  return "";
}

/** `Exit code 2` in a failed Bash call's text; null when the text does not say. */
export function exitCodeOf(text: string): number | null {
  const match = /exit code[:\s]+(-?\d+)/i.exec(text);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/** A file path a Claude Code write tool names. */
function writtenPathOf(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;

/** The Agent SDK, loaded only when a Claude Agent turn runs: the packaged daemon never imports it at boot. */
let sdkQuery: Promise<AgentQuery> | null = null;
/** The Agent SDK's own query, loaded on first use; exported for a live check that wraps it. */
export function loadSdkQuery(): Promise<AgentQuery> {
  sdkQuery ??= (async (): Promise<AgentQuery> => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { z } = await import("zod");
    return ({ prompt, options, deskfolk }) => {
      const server = sdk.createSdkMcpServer({
        name: AGENT_MCP_SERVER,
        version: "1",
        tools: deskfolk.tools.map((entry) => sdk.tool(
          entry.name,
          entry.description,
          zodShape(z, entry.inputSchema),
          async (args) => {
            const out = await deskfolk.call(entry.name, args as Record<string, unknown>);
            return { content: [{ type: "text" as const, text: out.text }], isError: out.isError };
          },
          // Claude Code defers MCP tools behind its tool search otherwise; these are the turn's verbs.
          { alwaysLoad: true, ...(entry.readOnly ? { annotations: { readOnlyHint: true } } : {}) },
        )),
      });
      return sdk.query({ prompt, options: { ...options, mcpServers: { [AGENT_MCP_SERVER]: { ...server, timeout: DESKFOLK_TOOL_TIMEOUT_MS } } } });
    };
  })();
  return sdkQuery!;
}

/**
 * The SDK takes a tool's arguments as a zod shape. The app's tools are JSON Schema, converted a
 * property at a time; one that does not convert is taken as anything, and the app's own tool code
 * checks it, as it checks every call.
 */
export function zodShape(z: typeof import("zod").z, schema: Record<string, unknown>): Record<string, import("zod").ZodType> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const shape: Record<string, import("zod").ZodType> = {};
  for (const [key, property] of Object.entries(properties)) {
    let field: import("zod").ZodType;
    try {
      field = z.fromJSONSchema(property as never) as import("zod").ZodType;
    } catch {
      field = z.any();
    }
    if (typeof property.description === "string") field = field.describe(property.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  const { store, publish, publishTurn, occurred, lives, active } = deps;
  let running = 0;
  const waiting: Array<() => void> = [];

  async function slot(turnId: string, live: Live): Promise<boolean> {
    while (running >= AGENT_SLOTS) {
      await new Promise<void>((resolve) => waiting.push(resolve));
      if (!active(turnId, live)) return false;
    }
    running += 1;
    return true;
  }
  function release(): void {
    running = Math.max(0, running - 1);
    waiting.shift()?.();
  }

  /** The SDK's spawn, but in a process group of its own and on the record, so Stop and a crashed daemon's next boot can end it. */
  function spawnRecorded(options: SpawnOptions, turnId: string): SpawnedProcess {
    const windows = process.platform === "win32";
    const launch = claudeLaunch(options.command, options.args, options.env as Record<string, string>);
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !windows,
      // No console window for a daemon the app started without one.
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
    });
    if (child.pid) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        recordLiveProc(store, { pid: child.pid, exited }, {
          pgid: windows ? null : child.pid, turnId, command: `${options.command} (Claude Agent)`,
        });
      } catch {
        // the record is for cleanup after a crash; the session itself does not need it
      }
    }
    // Whoever stops it — a Stop here, or the SDK closing the session — stops what it started too.
    killsTree(child);
    options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    return child as unknown as SpawnedProcess;
  }

  async function runAgentTurn(turnId: string): Promise<void> {
    const live = lives.get(turnId);
    if (!live) return;
    live.agent = true;
    let current: Turn;
    try {
      current = store.getTurn(turnId);
    } catch {
      lives.delete(turnId);
      return;
    }
    const bot = store.getBot(current.bot_id);
    const locale = store.settingsCached().locale;
    live.locale = locale;
    const status = deps.claudeCode ? await deps.claudeCode.current() : null;
    if (!active(turnId, live)) return;
    if (!status?.path) {
      deps.failTurn(turnId, "agent_missing");
      return;
    }
    if (status.logged_in === false) {
      deps.failTurn(turnId, "agent_signed_out", locale === "en" ? "not signed in" : "还没登录");
      return;
    }
    const root = store.workspacePath();
    if (!root) {
      deps.failTurn(turnId, "crashed", locale === "en" ? "no workspace is set" : "还没有设工作区");
      return;
    }
    if (!(await slot(turnId, live))) return;
    try {
      await runSession(turnId, live, current, bot, status.path, status, root);
    } finally {
      release();
    }
  }

  async function runSession(
    turnId: string,
    live: Live,
    current: Turn,
    bot: ReturnType<Store["getBot"]>,
    executable: string,
    network: Parameters<typeof withSystemProxy>[1],
    root: string,
  ): Promise<void> {
    const locale = live.locale ?? "zh";
    const en = locale === "en";
    const sessionId = current.session_id;
    const level = store.capabilities().engine_level;
    let triggerBody = "";
    try {
      triggerBody = store.getMessage(current.trigger_message_id).body;
    } catch {
      triggerBody = "";
    }
    // The route row says what the turn ran on, so its hop and failure counts are kept; it never
    // feeds a Bot's endpoint default (`reason_code` claude_code).
    try {
      store.recordTurnRoute({
        turnId,
        decision: { providerId: "", model: bot.agent_model ?? "default", thinkingLevel: bot.agent_effort ?? "default",
          signature: classifyMessage(triggerBody), reasonCode: "claude_code" },
        continuesPrevious: false,
      });
    } catch {
      // best-effort, as for the hop loop
    }
    deps.closeChain(sessionId, current.bot_id);
    deps.holdChain(sessionId, current.bot_id);

    // Where it works: the turn's work dir, or its plan's, or the workspace root until a desk segment binds a job.
    const cwdRel = live.workDir ?? live.planDir ?? ".";
    const cwdClass = classifyPath(root, cwdRel);
    const cwd = cwdClass.zone === "inside" ? cwdClass.abs : root;
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      // the workspace root itself always exists; a work dir that cannot be made fails the spawn, said below
    }

    // The app's own tools, as the hop loop would offer them, less the five Claude Code has its own of.
    const listed = deps.mcp ? await deps.mcp.listForTurn() : { tools: [], guides: [] };
    if (!active(turnId, live)) return;
    const offered = [...builtinTools(locale, level, editedToolDescription(promptPage(store, locale))).filter((tool) => !OWN_FILE_TOOLS.has(tool.function.name)), ...listed.tools];
    const chatTools: ChatTool[] = current.mode === "readonly" ? readOnlyTools(offered, listed.guides) : offered;
    live.toolNames = new Set(chatTools.map((tool) => tool.function.name));
    const params = new Map(listed.tools.map((tool) => [tool.function.name,
      Object.keys(((tool.function.parameters ?? {}) as { properties?: Record<string, unknown> }).properties ?? {})] as const));
    live.mcpTools = new Map(listed.guides.flatMap((guide) =>
      guide.tools.map((tool) => [tool.modelName, { server: guide.name, tool: tool.toolName ?? tool.modelName, readOnly: tool.readOnly === true,
        params: params.get(tool.modelName) ?? [] }] as const)));
    const readOnlyNames = new Set(readOnlyTools(chatTools, listed.guides).map((tool) => tool.function.name));

    const input = inputQueue<SDKUserMessage>();
    const serial = serialQueue();
    const state = {
      ended: false,
      /** The app's tool that ended the segment (`end_turn`, a merge, a delegation wait). */
      endedByTool: false,
      emptyNudged: false,
      failure: null as { kind: FailKind; detail?: string | null } | null,
      /** The plan's limit turned a request away: when it resets, and whether extra usage carried on. */
      limit: null as { reset: string | null; carried: boolean } | null,
      lastResult: null as SDKResultMessage | null,
      /** Per model, what the spend rows already carry: a result's usage is the session's so far. */
      billed: new Map<string, ModelTotals>(),
      stderr: "",
      model: bot.agent_model as string | null,
      hopIds: new Set<string>(),
    };
    /** What the effect gate and the approvals decided per tool call, read back when Claude Code asks. */
    const pending = new Map<string, { approval?: { kind_key: string; target: string; summary: string }; appName: string; effect: boolean; snapshot?: Map<string, number> | null; begun?: boolean; startedAt: number }>();
    let session: AgentSession | null = null;

    const end = () => {
      if (state.ended) return;
      state.ended = true;
      input.close();
    };

    // --- the app's tools, through executeTools, one at a time --------------------------------
    const bridge: AgentToolBridge = {
      tools: chatTools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description ?? "",
        inputSchema: (tool.function.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
        readOnly: readOnlyNames.has(tool.function.name),
      })),
      call: (name, args) => serial(async () => {
        if (state.ended || !active(turnId, live)) {
          return { text: JSON.stringify({ ok: false, error: { code: "segment_ended", message: "this segment has ended" } }), isError: true };
        }
        const call: ToolCall = { id: `df_${crypto.randomUUID()}`, name, arguments: JSON.stringify(args ?? {}) };
        live.loop.push({ role: "assistant", content: null, tool_calls: [call] });
        const outcome = await deps.executeTools(turnId, [call]);
        const entry = [...live.loop].reverse().find((row) => row.role === "tool" && row.tool_call_id === call.id);
        const text = typeof entry?.content === "string" ? entry.content : JSON.stringify(entry?.content ?? { ok: false });
        if (outcome === "noop" || outcome === "spoke") {
          state.endedByTool = true;
          end();
          void session?.interrupt().catch(() => {});
        } else if (outcome === "wait") {
          end();
        }
        return { text, isError: /"ok"\s*:\s*false/.test(text.slice(0, 40)) };
      }),
    };

    // --- policy, before each of Claude Code's own calls ---------------------------------------
    const preToolUse = async (raw: HookInput, toolUseId: string | undefined): Promise<HookJSONOutput> => {
      if (raw.hook_event_name !== "PreToolUse") return {};
      const id = toolUseId ?? raw.tool_use_id;
      const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
      store.touchTurn(turnId);
      if (raw.tool_name.startsWith(`mcp__${AGENT_MCP_SERVER}__`)) {
        // The app gates its own tools itself. A subagent may only look, never speak or end for the Bot.
        const name = raw.tool_name.slice(`mcp__${AGENT_MCP_SERVER}__`.length);
        if (raw.agent_id && !readOnlyNames.has(name)) return deny(en ? "only the Bot itself may do that, not a subagent" : "只有 Bot 自己能做这件事，子任务不行");
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
      }
      if (state.ended) return deny(en ? "this segment has ended" : "这一段已经结束了");
      const decision = decideAgentCall({
        tool: raw.tool_name,
        input: (raw.tool_input ?? {}) as Record<string, unknown>,
        cwd: raw.cwd || cwd,
        agentId: raw.agent_id ?? null,
        mode: current.mode === "readonly" ? "readonly" : current.mode === "desk" ? "desk" : "work",
        workspace: root,
        allowed: (kind, target) => store.matchesAllowRule(kind, target),
      });
      if (decision.kind === "deny") return deny(decision.reason);
      let context: string | undefined;
      if (decision.effect) {
        const before = live.workDir;
        const gate = await deps.beforeEffect(current, live, decision.appName, id);
        if (!gate.ok) {
          if (gate.result.data?.ended === true) {
            state.endedByTool = true;
            end();
            void session?.interrupt().catch(() => {});
          }
          return deny(gate.result.error?.message ?? (en ? "refused" : "被拒绝"));
        }
        current = gate.turn;
        if (live.workDir && live.workDir !== before) {
          const abs = classifyPath(root, live.workDir);
          if (abs.zone === "inside") {
            try {
              mkdirSync(abs.abs, { recursive: true });
            } catch {
              // said by the tool when it writes there
            }
            context = en
              ? `(app) This work now belongs to a job; its work dir is ${abs.abs}. Put what you make there.`
              : `（应用）这件事已经归到一项工作里，本轮工作目录现在是 ${abs.abs}，产物放这里。`;
          }
        }
      }
      const snapshot = raw.tool_name === "Bash" && live.workDir ? snapshotWorkDir(root, live.workDir) : null;
      pending.set(id, { appName: decision.appName, effect: decision.effect, snapshot, startedAt: Date.now(),
        ...(decision.kind === "ask" ? { approval: decision.approval } : {}) });
      if (decision.kind === "ask") {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: decision.approval.summary, ...(context ? { additionalContext: context } : {}) } };
      }
      if (decision.effect && !beginEffect(id, decision.appName)) return deny(en ? "this work is held or no longer yours to do" : "这件事被停住了，或者已经不归你做");
      startFrame(id, raw.tool_name, (raw.tool_input ?? {}) as Record<string, unknown>, decision.appName);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", ...(context ? { additionalContext: context } : {}) } };
    };

    /** The effect's ledger row (ADR 0045), from the supervisor's level: right before it runs. */
    const beginEffect = (id: string, appName: string): boolean => {
      if (store.capabilities().engine_level < ENGINE_LEVELS.supervision) return true;
      try {
        const started = store.beginToolExecution({ turnId, toolCallId: id, tool: appName, sideEffect: true });
        const entry = pending.get(id);
        if (entry) entry.begun = started.begun;
        return true;
      } catch {
        return false;
      }
    };

    const startFrame = (id: string, tool: string, args: Record<string, unknown>, appName: string) => {
      const command = tool === "Bash" && typeof args.command === "string" ? args.command : undefined;
      const path = writtenPathOf(args) ?? (typeof args.path === "string" ? args.path : undefined);
      const target = command ?? (path ? relOrAbs(root, path) : undefined);
      live.runningTool = { id, name: appName, ...(target ? { target } : {}), started_at: new Date().toISOString() };
      publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id, name: appName,
        arguments: JSON.stringify(command ? { command } : path ? { path: relOrAbs(root, path) } : {}), phase: "started", ...(target ? { target } : {}) });
    };

    // --- bookkeeping, after each of Claude Code's own calls -----------------------------------
    const postToolUse = async (raw: HookInput, toolUseId: string | undefined): Promise<HookJSONOutput> => {
      if (raw.hook_event_name !== "PostToolUse" && raw.hook_event_name !== "PostToolUseFailure") return {};
      if (raw.tool_name.startsWith(`mcp__${AGENT_MCP_SERVER}__`)) return {};
      const id = toolUseId ?? raw.tool_use_id;
      const entry = pending.get(id);
      pending.delete(id);
      const failed = raw.hook_event_name === "PostToolUseFailure";
      const args = (raw.tool_input ?? {}) as Record<string, unknown>;
      const errorText = failed ? (raw as { error?: string }).error ?? "" : "";
      const responseText = failed ? errorText : textOfToolResult((raw as { tool_response?: unknown }).tool_response);
      const appName = entry?.appName ?? appToolName(raw.tool_name);
      store.touchTurn(turnId);
      live.toolCalls += 1;
      if (failed) live.toolErrors += 1;
      if (raw.tool_name === "Bash" && typeof args.command === "string") {
        const exit = failed ? exitCodeOf(errorText) ?? 1 : 0;
        const rel = classifyPath(root, raw.cwd || cwd);
        store.recordTurnRun({ turnId, tool: "shell", command: args.command, exitCode: exit, ok: !failed,
          error: failed ? clip(errorText, 400) : null, cwd: rel.zone === "inside" ? rel.rel : null,
          toolCallId: id, durationMs: entry ? Date.now() - entry.startedAt : null, output: responseText || null });
        if (!failed && live.workDir) {
          const produced = producedPaths(root, live.workDir, entry?.snapshot ?? null);
          if (produced.paths?.length) deps.noteWrittenPaths(live, "shell", { ok: true, data: { paths: produced.paths }, emitted: [] });
        }
      }
      const written = writtenPathOf(args);
      if (!failed && written && appName === "write_file") {
        const classified = classifyPath(root, written);
        if (classified.zone === "inside") deps.noteWrittenPaths(live, "write_file", { ok: true, data: { path: classified.rel }, emitted: [] });
      }
      if (!failed && raw.tool_name === "Read" && written && PICTURE.test(written)) {
        // Claude Code looked at the picture itself: a review approving pictures counts that (ADR 0046 §10).
        const classified = classifyPath(root, written);
        try {
          store.recordFrameRead({ turnId, path: classified.zone === "inside" ? classified.rel : written });
        } catch {
          // evidence, not the work
        }
      }
      if (entry?.begun) {
        try {
          store.finishToolExecution({ turnId, toolCallId: id, outcome: failed ? "failed" : "succeeded" });
        } catch {
          // the ledger row may already be closed by a stop
        }
      }
      if (live.runningTool?.id === id) live.runningTool = null;
      publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id, name: appName, phase: "exited",
        duration_ms: entry ? Date.now() - entry.startedAt : undefined,
        exit_code: raw.tool_name === "Bash" ? (failed ? exitCodeOf(errorText) ?? 1 : 0) : null, ok: !failed });
      live.loop.push({ role: "tool", tool_call_id: id, content: clip(responseText, LOOP_RESULT_MAX) });
      return {};
    };

    /** Lines said to this Bot while it works, heard after the batch of calls that was running. */
    const heard = (): string | null => {
      if (current.mode === "readonly") return null;
      const queued = store.queuedForTurn(turnId);
      if (queued.length === 0) return null;
      const items = queued.flatMap((item) => {
        try {
          const message = item.message_id ? store.getMessage(item.message_id) : store.getMessage(current.trigger_message_id);
          return [{ seq: item.seq, message, item: { author: item.author, body: item.body_snapshot, checkBack: item.source === "timer",
            ...(item.said_in ? { where: item.said_in } : {}) } }];
        } catch {
          return [];
        }
      });
      const { delivered } = store.deliverInboxItems(items.map((entry) => entry.seq), turnId, live.hops);
      const kept = new Set(delivered.map((row) => row.seq));
      const labels = new Map(delivered.map((row) => [row.seq, inboxLabel(row)]));
      const shown = items.filter((entry) => kept.has(entry.seq));
      if (shown.length === 0) return null;
      const note = heardNote(locale, shown.map((entry) => ({ ...entry.item, label: labels.get(entry.seq) })));
      live.loop.push({ role: "user", content: note });
      return note;
    };

    const postToolBatch = async (raw: HookInput): Promise<HookJSONOutput> => {
      if (raw.hook_event_name !== "PostToolBatch" || state.ended) return {};
      const note = heard();
      return note ? { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: note } } : {};
    };

    // --- what only you can answer: approvals --------------------------------------------------
    const canUseTool: CanUseTool = (toolName, toolInput, options) => serial(async (): Promise<PermissionResult> => {
      if (state.ended || !active(turnId, live)) return { behavior: "deny", message: en ? "this segment has ended" : "这一段已经结束了", interrupt: true };
      const id = options.toolUseID;
      const entry = pending.get(id);
      const approval = entry?.approval ?? {
        // Claude Code asked on its own (a protected file, say): your card says what it wants.
        kind_key: "agent-permission",
        target: options.blockedPath ?? toolName,
        summary: `${toolName} ${clip(options.title ?? options.description ?? JSON.stringify(toolInput), 300)}`,
      };
      const resolved = await deps.openApprovalCard(current, live, { ...approval, run: async () => ({ ok: true, emitted: [] }) }, id);
      if (resolved === null || !active(turnId, live)) return { behavior: "deny", message: en ? "the turn stopped" : "这一轮停了", interrupt: true };
      if (!resolved.ok) {
        const held = resolved.error?.code === "held";
        return { behavior: "deny", message: held
          ? (en ? "a stop holds this work; nothing with an effect runs now" : "这件事被停住了，有效果的动作现在都不会执行")
          : (en ? "denied: the user does not want this. Do not do the same thing another way, and do not ask for it again." : "denied：用户拒绝了这个动作。不要换办法做同一件事，也不要再要同一个批准。") };
      }
      if (entry?.effect && !beginEffect(id, entry.appName)) return { behavior: "deny", message: en ? "this work is held or no longer yours to do" : "这件事被停住了，或者已经不归你做" };
      startFrame(id, toolName, toolInput, entry?.appName ?? appToolName(toolName));
      return { behavior: "allow", updatedInput: toolInput };
    });

    // --- the first message ------------------------------------------------------------------
    const parts = assembleAgentTurnInput(store, { sessionId, botId: current.bot_id, turnId, triggerMessageId: current.trigger_message_id, locale });
    const lead: string[] = [];
    if (live.interrupt) lead.push(INTERRUPT_FLAG);
    for (const row of live.loop) if (row.role === "user" && typeof row.content === "string") lead.push(row.content);
    const content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } }> = [];
    if (lead.length > 0) content.push({ type: "text", text: lead.join("\n\n") });
    for (const part of parts) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      else if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mediaType)) {
        content.push({ type: "image", source: { type: "base64", media_type: part.mediaType as "image/png", data: part.data } });
      }
    }
    input.push(userMessage(content));
    const early = heard();
    if (early) input.push(userMessage(early));

    const skills = [
      ...store.listEnabledSkills(current.bot_id).map((skill) => ({ name: skill.name, description: skill.description, uses: skill.uses })),
      ...store.sharedSkillsFor(current.bot_id).map((skill) => ({ name: skill.name, description: skill.description, uses: skill.uses, sharedFrom: skill.source_bot_name })),
    ];
    const append = agentSystemPrompt({
      locale, name: bot.name, duties: bot.duties, boundaries: bot.boundaries, workspace: root, cwd, engineLevel: level,
      skills, memories: memoryDigest(store, current.bot_id, locale), mcpGuides: listed.guides,
      // Built-in prompts you edited (ADR 0064): the same System section every other Bot reads.
      texts: turnPromptTexts(promptPage(store, locale)),
    });

    const hooks: Partial<Record<"PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PostToolBatch", HookCallbackMatcher[]>> = {
      // A pending approval may wait for you for a long time; the hook itself never waits on you.
      PreToolUse: [{ hooks: [(raw, toolUseId) => preToolUse(raw, toolUseId)], timeout: 86_400 }],
      PostToolUse: [{ hooks: [(raw, toolUseId) => postToolUse(raw, toolUseId)] }],
      PostToolUseFailure: [{ hooks: [(raw, toolUseId) => postToolUse(raw, toolUseId)] }],
      PostToolBatch: [{ hooks: [(raw) => postToolBatch(raw)] }],
    };
    const env = withSystemProxy(claudeChildEnv(process.env), network);
    env.CLAUDE_AGENT_SDK_CLIENT_APP = `deskfolk/${safeVersion()}`;
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = "1";
    const options: Options = {
      pathToClaudeCodeExecutable: executable,
      spawnClaudeCodeProcess: (spawnOptions) => (deps.spawnProcess ?? spawnRecorded)(spawnOptions, turnId),
      cwd,
      additionalDirectories: [root],
      env,
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      verbatimPrompts: true,
      includePartialMessages: false,
      permissionMode: "default",
      tools: [...(current.mode === "readonly" ? AGENT_READONLY_TOOLS : AGENT_WORK_TOOLS)],
      // The app's own tools are let through by the PreToolUse hook, not an allow rule: a rule would
      // shadow the permission callback for them (the SDK warns), and the app gates them itself.
      disallowedTools: ["AskUserQuestion"],
      systemPrompt: { type: "preset", preset: "claude_code", append },
      maxTurns: AGENT_MAX_TURNS,
      ...(bot.agent_model ? { model: bot.agent_model } : {}),
      ...(bot.agent_effort ? { effort: bot.agent_effort } : {}),
      hooks,
      canUseTool,
      abortController: live.abort,
      stderr: (data) => { state.stderr = (state.stderr + data).slice(-STDERR_KEEP); },
    };

    let query: AgentQuery;
    try {
      query = deps.agentQuery ?? (await loadSdkQuery());
    } catch (error) {
      console.error(`[turn ${turnId}] could not load the Agent SDK`, error);
      deps.failTurn(turnId, "agent_exited", en ? "the Agent SDK could not be loaded" : "Agent SDK 载入失败");
      return;
    }
    if (!active(turnId, live)) return;
    live.streaming = true;
    publishTurn(store.getTurn(turnId), "");
    let iterationError: unknown = null;
    try {
      session = query({ prompt: input.iterable, options, deskfolk: bridge });
      for await (const message of session) {
        store.touchTurn(turnId);
        if (!active(turnId, live) && !state.ended) {
          end();
          continue;
        }
        await onMessage(message);
      }
    } catch (error) {
      iterationError = error;
    } finally {
      live.streaming = false;
      input.close();
      try {
        session?.close();
      } catch {
        // already over
      }
    }

    if (live.abort.signal.aborted) {
      lives.delete(turnId);
      return;
    }
    if (state.endedByTool) {
      // As the hop loop does when a tool ended the segment (`end_turn`, a merge, a wait).
      deps.completeSilent(turnId);
      deps.saidNothing(current, live);
      return;
    }
    if (state.failure) {
      deps.failTurn(turnId, state.failure.kind, state.failure.detail ?? null);
      return;
    }
    if (!state.ended && isLive(turnId)) {
      if (iterationError) console.error(`[turn ${turnId}] Claude Code session ended`, iterationError, state.stderr.slice(-2000));
      deps.failTurn(turnId, "agent_exited", lastLine(state.stderr));
    }

    async function onMessage(message: SDKMessage): Promise<void> {
      switch (message.type) {
        case "system": {
          if (message.subtype === "init") {
            state.model = (message as { model?: string }).model ?? state.model;
          }
          // An api_retry is only news: Claude Code tries again (a refreshed sign-in often gets
          // through), and a request that finally fails comes back as an error message below.
          return;
        }
        case "rate_limit_event": {
          // Only news on its own: with extra usage on, Claude Code goes on past the plan's limit. A
          // request the limit really stopped comes back as an error, which then says when it resets.
          const info = (message as { rate_limit_info?: { status?: string; resetsAt?: number; overageStatus?: string; isUsingOverage?: boolean } }).rate_limit_info;
          if (info?.status === "rejected") {
            state.limit = { reset: resetText(info.resetsAt, locale),
              carried: info.isUsingOverage === true || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning" };
          }
          return;
        }
        case "assistant": {
          if (message.parent_tool_use_id) return;
          const blocks = Array.isArray(message.message.content) ? message.message.content : [];
          const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
          const error = (message as { error?: string }).error;
          if (error) {
            // Claude Code's own line about a request that failed, not anything the Bot said: never
            // shown as its reply. The line itself goes with the failure, as Claude Code worded it.
            if (SIGNED_OUT_ERRORS.has(error)) state.failure = { kind: "agent_signed_out", detail: firstLine(text) };
            else if (LIMIT_ERRORS.has(error)) state.failure ??= { kind: "agent_limit", detail: state.limit?.reset ?? firstLine(text) };
            return;
          }
          const id = (message.message as { id?: string }).id ?? message.uuid;
          if (!state.hopIds.has(id)) {
            state.hopIds.add(id);
            live.hops += 1;
          }
          if (live.interrupt && !live.burned) {
            live.burned = true;
            store.clearInterruptPending(current.bot_id);
          }
          const calls = blocks.flatMap((block) => (block.type === "tool_use" && !block.name.startsWith(`mcp__${AGENT_MCP_SERVER}__`)
            ? [{ id: block.id, name: appToolName(block.name), arguments: JSON.stringify(block.input ?? {}) }] : []));
          if (calls.length > 0) live.loop.push({ role: "assistant", content: text || null, tool_calls: calls });
          if (text.trim() && !state.ended) {
            live.partial = text;
            publishTurn(store.getTurn(turnId), text);
          }
          return;
        }
        case "result": {
          state.lastResult = message;
          recordAgentSpend(turnId, current, message, state);
          if (state.ended) return;
          if ((message.subtype !== "success" || message.is_error) && !state.failure && state.limit && !state.limit.carried) {
            state.failure = { kind: "agent_limit", detail: state.limit.reset };
          }
          if (message.subtype !== "success") {
            if (message.subtype === "error_max_turns") state.failure = { kind: "stuck" };
            else state.failure ??= { kind: "agent_exited", detail: message.errors?.[0] ?? null };
            end();
            return;
          }
          // A request that failed still ends in a "success" result, its text Claude Code's error
          // line (`is_error`): that is a failure to report, never a reply to post.
          if (state.failure || message.is_error) {
            state.failure ??= { kind: "agent_exited", detail: firstLine(message.result ?? "") };
            end();
            return;
          }
          const reply = message.result ?? "";
          live.loop.push({ role: "assistant", content: reply });
          // Nothing at all came back: ask once for the next step, as the hop loop does.
          if (!reply.trim() && !state.emptyNudged) {
            state.emptyNudged = true;
            const note = emptyReplyNote(locale);
            live.loop.push({ role: "user", content: note });
            input.push(userMessage(note));
            return;
          }
          const settled = await deps.settleClosingReply(turnId, live, current, reply);
          if (settled.kind === "bounce") {
            live.loop.push({ role: "user", content: settled.note });
            input.push(userMessage(settled.note));
            return;
          }
          // Ended (posted and completed) or stopped meanwhile: either way the session is done.
          end();
          setTimeout(() => session?.close(), WIND_DOWN_MS).unref?.();
          return;
        }
        default:
          return;
      }
    }

    function isLive(id: string): boolean {
      try {
        return ["running", "waiting_ask", "waiting_approval"].includes(store.getTurn(id).status);
      } catch {
        return false;
      }
    }
  }

  /**
   * What the session has cost since the last row, from a result's usage (cumulative over the
   * session, so a bounced reply and the one after it are not counted twice): one row per model, with
   * no endpoint and its price an estimate — on a subscription nothing is billed per token.
   */
  function recordAgentSpend(turnId: string, turn: Turn, result: SDKResultMessage, state: { billed: Map<string, ModelTotals>; model: string | null }): void {
    const owner = deps.spendOwner(turn.session_id, turn.bot_id);
    const usage = (result as { modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }> }).modelUsage ?? {};
    const totals: Array<[string, ModelTotals]> = Object.keys(usage).length > 0
      ? Object.entries(usage).map(([model, row]) => [model, {
        input: (row.inputTokens ?? 0) + (row.cacheReadInputTokens ?? 0) + (row.cacheCreationInputTokens ?? 0),
        output: row.outputTokens ?? 0, cached: row.cacheReadInputTokens ?? 0, cost: row.costUSD ?? 0 }])
      : [[state.model ?? "claude", {
        input: (result.usage?.input_tokens ?? 0) + (result.usage?.cache_read_input_tokens ?? 0) + (result.usage?.cache_creation_input_tokens ?? 0),
        output: result.usage?.output_tokens ?? 0, cached: result.usage?.cache_read_input_tokens ?? 0, cost: result.total_cost_usd ?? 0 }]];
    for (const [model, total] of totals) {
      const before = state.billed.get(model) ?? { input: 0, output: 0, cached: 0, cost: 0 };
      const delta = { input: total.input - before.input, output: total.output - before.output, cached: total.cached - before.cached, cost: total.cost - before.cost };
      if (delta.input <= 0 && delta.output <= 0 && delta.cost <= 0) continue;
      state.billed.set(model, total);
      try {
        const spend = store.insertSpend({
          kind: "turn", sessionId: owner.sessionId, sessionName: owner.sessionName, botId: owner.botId, botName: owner.botName,
          turnId, judgementId: null, chainId: null, providerId: "", providerName: "Claude Agent", model,
          thinkingLevel: null, inputTokens: Math.max(0, delta.input), outputTokens: Math.max(0, delta.output),
          totalTokens: Math.max(0, delta.input) + Math.max(0, delta.output), cachedTokens: Math.max(0, delta.cached),
          reasoningTokens: null, costUsdTicks: null, estimatedCostUsdTicks: Math.max(0, Math.round(delta.cost * 1e10)), missingReason: null,
        });
        deps.publishSpend(spend);
      } catch (error) {
        console.error(`[turn ${turnId}] could not record Claude Agent spend`, error);
      }
    }
  }

  return { runAgentTurn };
}

function relOrAbs(root: string, path: string): string {
  const classified = classifyPath(root, path);
  return classified.zone === "inside" ? classified.rel : classified.abs;
}

function resetText(resetsAt: number | undefined, locale: "zh" | "en"): string | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt * (resetsAt < 1e12 ? 1000 : 1));
  const time = at.toLocaleString(locale === "en" ? "en-US" : "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return locale === "en" ? `resets ${time}` : `${time} 重置`;
}

/** Claude Code's error kinds that mean its sign-in did not get through. */
const SIGNED_OUT_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "verification_required", "cloud_credential_error"]);
/** Its error kinds that mean the plan's usage or billing stopped the request. */
const LIMIT_ERRORS = new Set(["rate_limit", "billing_error", "account_on_hold"]);

function firstLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/).find((part) => part.trim())?.trim();
  return line ? clip(line, 200) : null;
}

function lastLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim();
  return line ? clip(line, 200) : null;
}

function safeVersion(): string {
  return typeof daemonPackage.version === "string" ? daemonPackage.version : "dev";
}
