/**
 * A turn run by one of your local agents other than Claude Code (ADR 0079): Codex, Grok, OpenCode,
 * DSH, ZCode, Antigravity or an ACP agent of your own. One Deskfolk turn is one fresh session of
 * the agent in the turn's work dir, as for a Claude Agent turn (ADR 0061), and wrapped in the same
 * things: the workspace boundary and your approvals, holds and Stop, the effect ledger and its
 * records, the app's own tools, the closing reply with its bounces. The driver (`drivers/*`) speaks
 * the agent's protocol; everything here is the same for every agent.
 *
 * The boundary, as you chose it (2026-10-10): every call the agent asks about or has the app carry
 * out is decided before it runs (`gate`); a call the app only hears of after it ran is checked
 * then, and one that crossed out of the workspace or touched an agent's credentials stops the turn
 * (`agent_unguarded`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AGENT_KINDS, type BotRunner, type CustomAgent, type Turn } from "@real-bot/protocol";
import { assembleAgentTurnInput, type AgentInputPart } from "../../context";
import { memoryDigest } from "../../context/memory-digest";
import type { ToolCall } from "../../completions";
import { recordLiveProc } from "../../live-procs";
import { INTERRUPT_FLAG, OWN_FILE_TOOLS, builtinTools, type ChatTool, type FailKind } from "../../prompts";
import { agentSystemPrompt } from "../../prompts/agent-system";
import { editedToolDescription, promptPage, turnPromptTexts } from "../../prompts/book";
import { classifyMessage } from "../../route-decision";
import { inboxLabel, type Store } from "../../store";
import { ENGINE_LEVELS } from "../../store/schema-gate";
import { heardNote } from "../../turn-inbox";
import { emptyReplyNote } from "../../turn-pace";
import { classifyPath } from "../../workspace-paths";
import { producedPaths, snapshotWorkDir } from "../../workspace-tools";
import { AGENT_MCP_PREFIX, AGENT_MCP_TOKEN_ENV, AGENT_MCP_URL_ENV, mintAgentMcp, revokeAgentMcp } from "../../agent-mcp/bridge";
import { agentMcpShim } from "../../agent-mcp/launch";
import { claudeLaunch, killsTree } from "../../claude-code/spawn";
import { readOnlyTools } from "../tools";
import type { Live } from "../types";
import type { AgentRunnerDeps, AgentTool, AgentToolBridge } from "../agent-runner";
import type { AgentDriver, AgentEvent, AgentHost, AgentSession, AppTerminal, GateAnswer } from "./driver";
import { decideAction, type AppAction } from "./policy";
import { AgentStartError } from "./drivers/acp";

/** What the runner was asked for: from the Bot, or from the ladder rung the job climbed to. */
export type ExternalSettings = {
  runner: Exclude<BotRunner, "claude_code">;
  custom: CustomAgent | null;
  model: string | null;
  effort: string | null;
  configDir: string | null;
  climbed: boolean;
};

/** The resolved command and environment (`agents/runtime.ts`). */
export type ExternalLaunch = { executable: string; args: string[]; env: Record<string, string> };

const WIND_DOWN_MS = 10_000;
const LOOP_RESULT_MAX = 2_000;
const STDERR_KEEP = 8 * 1024;
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const TERMINAL_OUTPUT_MAX = 1024 * 1024;

type ModelTotals = { input: number; output: number; cached: number; cost: number };

/** Runs one at a time what must not interleave: approvals, questions and the app's tool calls. */
function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function agentLabel(runner: BotRunner, custom: CustomAgent | null): string {
  return runner === "custom" && custom ? custom.name : AGENT_KINDS[runner].label;
}

export async function runExternalSession(input: {
  deps: AgentRunnerDeps;
  turnId: string;
  live: Live;
  current: Turn;
  bot: ReturnType<Store["getBot"]>;
  settings: ExternalSettings;
  launch: ExternalLaunch;
  driver: AgentDriver;
  root: string;
  daemonPort: () => number | null;
}): Promise<void> {
  const { deps, turnId, live, bot, settings, launch, driver, root } = input;
  const { store, publish, publishTurn, occurred, lives, active } = deps;
  let current = input.current;
  const locale = live.locale ?? "zh";
  const en = locale === "en";
  const sessionId = current.session_id;
  const level = store.capabilities().engine_level;
  const label = agentLabel(settings.runner, settings.custom);
  live.agentLabel = label;
  let triggerBody = "";
  try {
    triggerBody = store.getMessage(current.trigger_message_id).body;
  } catch {
    triggerBody = "";
  }
  try {
    store.recordTurnRoute({
      turnId,
      decision: { providerId: "", model: settings.model ?? "default", thinkingLevel: settings.effort ?? "default",
        signature: classifyMessage(triggerBody), reasonCode: `agent_${settings.runner}`, ...(settings.climbed ? { baseReasonCode: "escalation_model" } : {}) },
      continuesPrevious: false,
    });
  } catch {
    // best-effort, as for the hop loop
  }
  deps.closeChain(sessionId, current.bot_id);
  deps.holdChain(sessionId, current.bot_id);

  const cwdRel = live.workDir ?? live.planDir ?? ".";
  const cwdClass = classifyPath(root, cwdRel);
  const cwd = cwdClass.zone === "inside" ? cwdClass.abs : root;
  try {
    mkdirSync(cwd, { recursive: true });
  } catch {
    // the workspace root always exists; a work dir that cannot be made fails the agent's spawn
  }

  // The app's own tools, less the five every agent has its own of — or none, for an agent the app
  // cannot hand them to (Antigravity's print mode).
  const listed = driver.caps.appTools && deps.mcp ? await deps.mcp.listForTurn() : { tools: [], guides: [] };
  if (!active(turnId, live)) return;
  const offered = driver.caps.appTools
    ? [...builtinTools(locale, level, editedToolDescription(promptPage(store, locale))).filter((tool) => !OWN_FILE_TOOLS.has(tool.function.name)), ...listed.tools]
    : [];
  const chatTools: ChatTool[] = current.mode === "readonly" ? readOnlyTools(offered, listed.guides) : offered;
  live.toolNames = new Set(chatTools.map((tool) => tool.function.name));
  const params = new Map(listed.tools.map((tool) => [tool.function.name,
    Object.keys(((tool.function.parameters ?? {}) as { properties?: Record<string, unknown> }).properties ?? {})] as const));
  live.mcpTools = new Map(listed.guides.flatMap((guide) =>
    guide.tools.map((tool) => [tool.modelName, { server: guide.name, tool: tool.toolName ?? tool.modelName, readOnly: tool.readOnly === true,
      params: params.get(tool.modelName) ?? [] }] as const)));
  const readOnlyNames = new Set(readOnlyTools(chatTools, listed.guides).map((tool) => tool.function.name));

  const serial = serialQueue();
  const state = {
    ended: false,
    endedByTool: false,
    emptyNudged: false,
    failure: null as { kind: FailKind; detail?: string | null } | null,
    billed: new Map<string, ModelTotals>(),
    stderr: "",
    model: settings.model,
    hopIds: new Set<string>(),
    /** Insert-now asked for a cut: the `cancelled` result that follows hands over the lines. */
    cutting: false,
    /** The app note to hand the agent with the next tool result (a work dir it now has, lines heard). */
    pendingNote: null as string | null,
    /** Closing replies sent back so far. */
    bounces: 0,
  };
  /** Each of the agent's own calls the app saw before it ran, with what its records need. */
  const pending = new Map<string, { appName: string; effect: boolean; begun?: boolean; startedAt: number; command?: string; snapshot?: Map<string, number> | null; gated: boolean }>();
  let session: AgentSession | null = null;
  let mcpToken: string | null = null;
  let resolveEnded: () => void = () => {};
  const endedPromise = new Promise<void>((resolve) => { resolveEnded = resolve; });

  const end = () => {
    if (state.ended) return;
    state.ended = true;
    revokeAgentMcp(mcpToken);
    resolveEnded();
  };
  const refreshed = (turn: Turn): Turn => {
    try {
      return store.getTurn(turnId);
    } catch {
      return turn;
    }
  };

  // --- the app's tools, through executeTools, one at a time --------------------------------
  const tools: AgentTool[] = chatTools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    inputSchema: (tool.function.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
    readOnly: readOnlyNames.has(tool.function.name),
  }));
  const bridge: AgentToolBridge = {
    tools,
    call: (name, args) => serial(async () => {
      if (state.ended || !active(turnId, live)) {
        return { text: JSON.stringify({ ok: false, error: { code: "segment_ended", message: "this segment has ended" } }), isError: true };
      }
      // An agent may name a tool the way it was listed to it (`deskfolk__end_turn`, `mcp__deskfolk__end_turn`).
      const bare = name.replace(/^(?:mcp__)?deskfolk(?:__|\.|_)/, "");
      const toolName = live.toolNames?.has(name) ? name : bare;
      const call: ToolCall = { id: `df_${crypto.randomUUID()}`, name: toolName, arguments: JSON.stringify(args ?? {}) };
      live.loop.push({ role: "assistant", content: null, tool_calls: [call] });
      const outcome = await deps.executeTools(turnId, [call]);
      const entry = [...live.loop].reverse().find((row) => row.role === "tool" && row.tool_call_id === call.id);
      let text = typeof entry?.content === "string" ? entry.content : JSON.stringify(entry?.content ?? { ok: false });
      if (outcome === "noop" || outcome === "spoke") {
        state.endedByTool = true;
        end();
        void session?.cancel().catch(() => false);
      } else if (outcome === "wait") {
        end();
        void session?.cancel().catch(() => false);
      } else {
        // What the app has to say meanwhile rides on the result: lines heard, a new work dir.
        const note = takeNote();
        if (note) text = `${text}\n\n${note}`;
      }
      return { text, isError: /"ok"\s*:\s*false/.test(text.slice(0, 40)) };
    }),
  };

  /** Lines said to this Bot while it works, heard now (ADR 0061's `heard`). */
  const heard = (opts: { cut?: boolean } = {}): string | null => {
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
    live.inbox = live.inbox.filter((entry) => entry.seq === undefined || !kept.has(entry.seq));
    const labels = new Map(delivered.map((row) => [row.seq, inboxLabel(row)]));
    const shown = items.filter((entry) => kept.has(entry.seq));
    if (shown.length === 0) return null;
    const note = heardNote(locale, shown.map((entry) => ({ ...entry.item, label: labels.get(entry.seq) })), opts);
    live.loop.push({ role: "user", content: note });
    return note;
  };
  /** The note waiting for the next tool result, with any lines heard since. */
  const takeNote = (): string | null => {
    const parts = [state.pendingNote, heard()].filter((part): part is string => Boolean(part));
    state.pendingNote = null;
    return parts.length > 0 ? parts.join("\n\n") : null;
  };

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
  const relOrAbs = (path: string) => {
    const classified = classifyPath(root, path);
    return classified.zone === "inside" ? classified.rel : classified.abs;
  };
  const startFrame = (id: string, action: AppAction) => {
    const command = action.appName === "shell" ? action.command : undefined;
    const path = action.paths[0];
    const target = command ?? (path ? relOrAbs(absolute(action.cwd, path)) : undefined);
    live.runningTool = { id, name: action.appName, ...(target ? { target } : {}), started_at: new Date().toISOString() };
    publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id, name: action.appName,
      arguments: JSON.stringify(command ? { command } : path ? { path: target } : {}), phase: "started", ...(target ? { target } : {}) });
  };
  const policyContext = () => ({
    mode: current.mode === "readonly" ? "readonly" as const : current.mode === "desk" ? "desk" as const : "work" as const,
    workspace: root,
    configDirs: store.allAgentConfigDirs(),
    allowed: (kind: string, target: string) => store.matchesAllowRule(kind, target),
  });

  /** What the app decides about one call before it runs: the same rules and card as Claude Agent's. */
  const gate = async (callId: string, action: AppAction): Promise<GateAnswer> => {
    store.touchTurn(turnId);
    if (state.ended || !active(turnId, live)) return { kind: "deny", reason: en ? "this segment has ended" : "这一段已经结束了" };
    const decision = decideAction(action, policyContext());
    if (decision.kind === "deny") return { kind: "deny", reason: decision.reason };
    if (decision.effect) {
      const before = live.workDir;
      const gated = await deps.beforeEffect(current, live, decision.appName, callId);
      if (!gated.ok) {
        if (gated.result.data?.ended === true) {
          state.endedByTool = true;
          end();
          void session?.cancel().catch(() => false);
        }
        return { kind: "deny", reason: gated.result.error?.message ?? (en ? "refused" : "被拒绝") };
      }
      current = gated.turn;
      if (live.workDir && live.workDir !== before) {
        const abs = classifyPath(root, live.workDir);
        if (abs.zone === "inside") {
          try {
            mkdirSync(abs.abs, { recursive: true });
          } catch {
            // said by the call when it writes there
          }
          state.pendingNote = en
            ? `(app) This work now belongs to a job; its work dir is ${abs.abs}. Put what you make there.`
            : `（应用）这件事已经归到一项工作里，本轮工作目录现在是 ${abs.abs}，产物放这里。`;
        }
      }
    }
    if (decision.kind === "ask") {
      // One card at a time, and never beside a question or another of the app's tools (ADR 0061 decision 5).
      const resolved = await serial(() => deps.openApprovalCard(current, live, { ...decision.approval, run: async () => ({ ok: true, emitted: [] }) }, callId));
      if (resolved === null || !active(turnId, live)) return { kind: "deny", reason: en ? "the turn stopped" : "这一轮停了" };
      if (!resolved.ok) {
        const held = resolved.error?.code === "held";
        return { kind: "deny", reason: held
          ? (en ? "a stop holds this work; nothing with an effect runs now" : "这件事被停住了，有效果的动作现在都不会执行")
          : (en ? "denied: the user does not want this. Do not do the same thing another way, and do not ask for it again." : "denied：用户拒绝了这个动作。不要换办法做同一件事，也不要再要同一个批准。") };
      }
    }
    const snapshot = action.appName === "shell" && live.workDir ? snapshotWorkDir(root, live.workDir) : null;
    pending.set(callId, { appName: decision.appName, effect: decision.effect, startedAt: Date.now(), gated: true, snapshot,
      ...(action.appName === "shell" && action.command ? { command: action.command } : {}) });
    if (decision.effect && !beginEffect(callId, decision.appName)) {
      pending.delete(callId);
      return { kind: "deny", reason: en ? "this work is held or no longer yours to do" : "这件事被停住了，或者已经不归你做" };
    }
    startFrame(callId, action);
    return { kind: "allow" };
  };

  /** A call the app only hears of as it runs: checked now; one that crossed out unasked stops the turn. */
  const audit = (callId: string, action: AppAction): boolean => {
    if (pending.has(callId)) return true;
    const decision = decideAction(action, policyContext());
    if (decision.kind === "allow") {
      pending.set(callId, { appName: decision.appName, effect: decision.effect, startedAt: Date.now(), gated: false,
        ...(action.appName === "shell" && action.command ? { command: action.command } : {}) });
      if (decision.effect) beginEffect(callId, decision.appName);
      startFrame(callId, action);
      return true;
    }
    const what = action.command ?? action.paths.join(", ") ?? action.vendorTool;
    console.warn(`[turn ${turnId}] ${label} ran ${action.vendorTool} unasked: ${what}`);
    if (store.capabilities().engine_level >= ENGINE_LEVELS.supervision) {
      try {
        store.beginToolExecution({ turnId, toolCallId: callId, tool: action.appName, sideEffect: true });
        store.finishToolExecution({ turnId, toolCallId: callId, outcome: "unknown", errorCode: "unguarded" });
      } catch {
        // the ledger is evidence; the stop is what matters
      }
    }
    state.failure = { kind: "agent_unguarded", detail: clip(`${action.vendorTool}: ${what}`, 200) };
    end();
    session?.close();
    return false;
  };

  /** A call of the agent's own ended: its records, as for a Claude Agent's (ADR 0061's PostToolUse). */
  const finished = (callId: string, action: AppAction, ok: boolean, output: string, exitCode?: number | null) => {
    const entry = pending.get(callId);
    pending.delete(callId);
    store.touchTurn(turnId);
    live.toolCalls += 1;
    if (!ok) live.toolErrors += 1;
    if (action.appName === "shell" && action.command) {
      const exit = ok ? (exitCode ?? 0) : (exitCode ?? 1);
      const rel = classifyPath(root, action.cwd);
      store.recordTurnRun({ turnId, tool: "shell", command: action.command, exitCode: exit, ok,
        error: ok ? null : clip(output, 400), cwd: rel.zone === "inside" ? rel.rel : null,
        toolCallId: callId, durationMs: entry ? Date.now() - entry.startedAt : null, output: output || null });
      if (ok && live.workDir) {
        const produced = producedPaths(root, live.workDir, entry?.snapshot ?? null);
        if (produced.paths?.length) deps.noteWrites(turnId, live, "shell", { ok: true, data: { paths: produced.paths }, emitted: [] });
      }
    }
    if (ok && action.appName === "write_file") {
      for (const path of action.paths) {
        const classified = classifyPath(root, absolute(action.cwd, path));
        if (classified.zone === "inside") deps.noteWrites(turnId, live, "write_file", { ok: true, data: { path: classified.rel }, emitted: [] });
      }
    }
    if (ok && (action.appName === "shell" || action.appName === "write_file")) current = refreshed(current);
    if (ok && action.appName === "read_file") {
      for (const path of action.paths.filter((path) => PICTURE.test(path))) {
        const classified = classifyPath(root, absolute(action.cwd, path));
        try {
          store.recordFrameRead({ turnId, path: classified.zone === "inside" ? classified.rel : classified.abs });
        } catch {
          // evidence, not the work
        }
      }
    }
    if (entry?.begun) {
      try {
        store.finishToolExecution({ turnId, toolCallId: callId, outcome: ok ? "succeeded" : "failed" });
      } catch {
        // the ledger row may already be closed by a stop
      }
    }
    if (live.runningTool?.id === callId) live.runningTool = null;
    publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id: callId, name: entry?.appName ?? action.appName, phase: "exited",
      duration_ms: entry ? Date.now() - entry.startedAt : undefined, exit_code: action.appName === "shell" ? (ok ? (exitCode ?? 0) : (exitCode ?? 1)) : null, ok });
    live.loop.push({ role: "tool", tool_call_id: callId, content: clip(output, LOOP_RESULT_MAX) });
  };

  /** Calls a cut left open: closed as a stop closes what it cuts (ADR 0069). */
  const closeCutTools = () => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      if (entry.begun) {
        try {
          store.finishToolExecution({ turnId, toolCallId: id, outcome: "unknown", errorCode: "cut_for_line" });
        } catch {
          // the ledger row may already be closed by a stop
        }
      }
      const stopped = en ? "stopped to read a line of the user's" : "为读用户的一句话停下了";
      if (entry.command) {
        try {
          store.recordTurnRun({ turnId, tool: "shell", command: entry.command, exitCode: null, ok: false, error: stopped,
            cwd: null, toolCallId: id, durationMs: Date.now() - entry.startedAt, output: `(${stopped})` });
        } catch {
          // the card is a record, not the work
        }
      }
      if (live.runningTool?.id === id) live.runningTool = null;
      publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id, name: entry.appName, phase: "exited",
        duration_ms: Date.now() - entry.startedAt, exit_code: null, ok: false });
      live.loop.push({ role: "tool", tool_call_id: id, content: `(${stopped})` });
    }
  };

  // Insert-now (ADR 0069) where the agent can be cut short: the step stops, and the lines go in next.
  if (driver.caps.sendNow) {
    live.sendNow = () => {
      if (state.ended || !session || state.cutting || current.mode === "readonly" || !active(turnId, live)) return false;
      if (store.queuedForTurn(turnId).length === 0) return false;
      state.cutting = true;
      void session.cancel().then((cancelled) => {
        if (!cancelled) state.cutting = false;
      }, () => {
        state.cutting = false;
      });
      return true;
    };
  }

  // --- what it is told ---------------------------------------------------------------------
  const parts = assembleAgentTurnInput(store, { sessionId, botId: current.bot_id, turnId, triggerMessageId: current.trigger_message_id, locale });
  const lead: string[] = [];
  if (live.interrupt) lead.push(INTERRUPT_FLAG);
  for (const row of live.loop) if (row.role === "user" && typeof row.content === "string") lead.push(row.content);
  const first: AgentInputPart[] = [...(lead.length > 0 ? [{ type: "text" as const, text: lead.join("\n\n") }] : []), ...parts];
  const early = heard();
  if (early) first.push({ type: "text", text: early });
  const skills = [
    ...store.listEnabledSkills(current.bot_id).map((skill) => ({ name: skill.name, description: skill.description, uses: skill.uses })),
    ...store.sharedSkillsFor(current.bot_id).map((skill) => ({ name: skill.name, description: skill.description, uses: skill.uses, sharedFrom: skill.source_bot_name })),
  ];
  const instructions = agentSystemPrompt({
    locale, name: bot.name, duties: bot.duties, boundaries: bot.boundaries, workspace: root, cwd, engineLevel: level,
    skills, memories: memoryDigest(store, current.bot_id, locale), mcpGuides: listed.guides,
    texts: turnPromptTexts(promptPage(store, locale)),
    agent: { label, runner: settings.runner, appTools: driver.caps.appTools, ...(driver.toolHint ? { toolHint: driver.toolHint } : {}) },
  });

  // --- the app's side of the protocol --------------------------------------------------------
  const spawnRecorded = (command: string, args: string[], options: { cwd: string; env: Record<string, string> }): ChildProcess => {
    const windows = process.platform === "win32";
    // npm's `codex.cmd` / `dsh.cmd` on Windows are batch files, run through cmd.exe (ADR 0061 decision 2).
    const launch = claudeLaunch(command, args, options.env);
    const child = spawn(launch.command, launch.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: !windows, windowsHide: true, windowsVerbatimArguments: launch.verbatim });
    if (child.pid) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        recordLiveProc(store, { pid: child.pid, exited }, { pgid: windows ? null : child.pid, turnId, command: `${command} (${label})` });
      } catch {
        // the record is for cleanup after a crash
      }
    }
    killsTree(child);
    const stop = () => child.kill("SIGTERM");
    if (live.abort.signal.aborted) stop();
    else live.abort.signal.addEventListener("abort", stop, { once: true });
    return child;
  };
  const host: AgentHost = {
    turnId,
    runner: settings.runner,
    custom: settings.custom,
    executable: launch.executable,
    launchArgs: launch.args,
    env: launch.env,
    workspace: root,
    cwd,
    mode: current.mode === "readonly" ? "readonly" : current.mode === "desk" ? "desk" : "work",
    locale,
    model: settings.model,
    effort: settings.effort,
    instructions,
    tools,
    callTool: bridge.call,
    mountMcp(transport) {
      mcpToken ??= mintAgentMcp(turnId, bridge);
      const port = input.daemonPort();
      const url = `http://127.0.0.1:${port ?? 17890}${AGENT_MCP_PREFIX}${mcpToken}`;
      if (transport === "http") return { url, headers: {} };
      const shim = agentMcpShim();
      return { command: shim.command, args: shim.args, env: { [AGENT_MCP_URL_ENV]: url, [AGENT_MCP_TOKEN_ENV]: mcpToken } };
    },
    gate,
    async readFile(path, line, limit) {
      const text = readFileSync(path, "utf8");
      if (!line && !limit) return text;
      const lines = text.split("\n");
      const start = Math.max(0, (line ?? 1) - 1);
      return lines.slice(start, limit ? start + limit : undefined).join("\n");
    },
    async writeFile(path, content) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    runCommand(command, args, options) {
      return runTerminal(spawnRecorded, command, args, options);
    },
    spawn: spawnRecorded,
    emit: (event) => onEvent(event),
    stderr: (chunk) => {
      state.stderr = (state.stderr + chunk).slice(-STDERR_KEEP);
    },
    signal: live.abort.signal,
  };

  async function onEvent(event: AgentEvent): Promise<void> {
    // Once the segment is over, what the agent still reports while it winds down changes nothing.
    if (state.ended && event.type !== "usage") return;
    try {
      await handleEvent(event);
    } catch (error) {
      if (!state.ended) throw error;
    }
  }

  async function handleEvent(event: AgentEvent): Promise<void> {
    store.touchTurn(turnId);
    switch (event.type) {
      case "model":
        state.model = event.model;
        return;
      case "hop": {
        if (!state.hopIds.has(event.id)) {
          state.hopIds.add(event.id);
          live.hops += 1;
        }
        if (live.interrupt && !live.burned) {
          live.burned = true;
          store.clearInterruptPending(current.bot_id);
        }
        if (event.calls.length > 0) live.loop.push({ role: "assistant", content: event.text || null, tool_calls: event.calls });
        if (event.text.trim() && !state.ended) {
          live.partial = event.text;
          publishTurn(store.getTurn(turnId), event.text);
        }
        return;
      }
      case "partial":
        if (event.text.trim() && !state.ended) {
          live.partial = event.text;
          publishTurn(store.getTurn(turnId), event.text);
        }
        return;
      case "tool_started":
        if (!event.gated) audit(event.callId, event.action);
        return;
      case "tool_finished":
        if (!pending.has(event.callId) && !event.gated && !audit(event.callId, event.action)) return;
        finished(event.callId, event.action, event.ok, event.output, event.exitCode);
        if (driver.caps.midTurn === "steer" && session?.steer && !state.ended) {
          const note = heard();
          // Lines heard are lines delivered: one the agent would not take mid-step rides the next tool result instead.
          if (note) {
            const steered = await session.steer([{ type: "text", text: note }]).catch(() => false);
            if (!steered) state.pendingNote = [state.pendingNote, note].filter(Boolean).join("\n\n");
          }
        }
        return;
      case "usage":
        recordSpend(event);
        return;
      case "limit":
        state.failure ??= { kind: "agent_limit", detail: event.reset };
        return;
      case "result":
        await onResult(event.result);
        return;
    }
  }

  /** The next thing the agent reads, with whatever the app had waiting to tell it. */
  function promptWith(text: string): void {
    const note = state.pendingNote;
    state.pendingNote = null;
    session?.prompt([{ type: "text", text: note ? `${note}\n\n${text}` : text }]);
  }

  async function onResult(result: Extract<AgentEvent, { type: "result" }>["result"]): Promise<void> {
    if (state.ended) return;
    if (result.kind === "cancelled") {
      if (state.cutting) {
        state.cutting = false;
        closeCutTools();
        const note = heard({ cut: true }) ?? (en
          ? "(App note) The step you were on was stopped, and nothing is waiting for you after all. Carry on; run again whatever was cut short if you still need it."
          : "（应用提示）刚才那一步被停下了，但没有要你读的话了。接着做；被打断没跑完的，需要的话重跑。");
        promptWith(note);
      }
      return;
    }
    if (result.kind === "error") {
      state.failure ??= { kind: result.failKind, detail: result.detail };
      end();
      return;
    }
    if (state.failure) {
      end();
      return;
    }
    const reply = result.text;
    live.loop.push({ role: "assistant", content: reply });
    if (!reply.trim() && !state.emptyNudged) {
      state.emptyNudged = true;
      const note = emptyReplyNote(locale);
      live.loop.push({ role: "user", content: note });
      promptWith(note);
      return;
    }
    current = refreshed(current);
    const settled = await deps.settleClosingReply(turnId, live, current, reply);
    if (settled.kind === "bounce") {
      state.bounces += 1;
      // An agent without the app's tools (Antigravity's print mode) can never submit or end_turn
      // as an ending may ask: once its words went out with the second bounce, the segment is over.
      if (!driver.caps.appTools && state.bounces >= 2) {
        state.endedByTool = true;
        end();
        return;
      }
      live.loop.push({ role: "user", content: settled.note });
      promptWith(settled.note);
      return;
    }
    end();
  }

  function recordSpend(event: Extract<AgentEvent, { type: "usage" }>): void {
    const owner = deps.spendOwner(current.session_id, current.bot_id);
    let delta = { input: event.input, output: event.output, cached: event.cached, cost: event.costUsd ?? 0 };
    if (event.cumulative) {
      const before = state.billed.get(event.model) ?? { input: 0, output: 0, cached: 0, cost: 0 };
      delta = { input: event.input - before.input, output: event.output - before.output, cached: event.cached - before.cached, cost: (event.costUsd ?? 0) - before.cost };
      state.billed.set(event.model, { input: event.input, output: event.output, cached: event.cached, cost: event.costUsd ?? 0 });
    }
    if (delta.input <= 0 && delta.output <= 0 && delta.cost <= 0) return;
    try {
      const spend = store.insertSpend({
        kind: "turn", sessionId: owner.sessionId, sessionName: owner.sessionName, botId: owner.botId, botName: owner.botName,
        turnId, judgementId: null, chainId: null, providerId: "", providerName: label, model: event.model || state.model || settings.runner,
        thinkingLevel: null, inputTokens: Math.max(0, delta.input), outputTokens: Math.max(0, delta.output),
        totalTokens: Math.max(0, delta.input) + Math.max(0, delta.output), cachedTokens: Math.max(0, delta.cached),
        reasoningTokens: null, costUsdTicks: null, estimatedCostUsdTicks: Math.max(0, Math.round(delta.cost * 1e10)), missingReason: null,
      });
      deps.publishSpend(spend);
    } catch (error) {
      console.error(`[turn ${turnId}] could not record ${label} spend`, error);
    }
  }

  // --- the session ---------------------------------------------------------------------------
  if (!active(turnId, live)) return;
  live.streaming = true;
  publishTurn(store.getTurn(turnId), "");
  let startError: unknown = null;
  try {
    session = await driver.start(host, first);
  } catch (error) {
    startError = error;
  }
  if (session) {
    void session.done.then(() => {
      if (!state.ended) {
        state.failure ??= { kind: "agent_exited", detail: lastLine(state.stderr) };
        end();
      }
    });
    await Promise.race([endedPromise, new Promise<void>((resolve) => live.abort.signal.addEventListener("abort", () => resolve(), { once: true }))]);
  }
  live.streaming = false;
  live.sendNow = undefined;
  // However it ended (a Stop included), what the agent still reports from here changes nothing.
  const stoppedHere = live.abort.signal.aborted;
  if (!state.ended) {
    state.ended = true;
    resolveEnded();
  }
  revokeAgentMcp(mcpToken);
  const closing = session;
  if (closing) {
    // The reply is posted: the agent gets a moment to wind down before its process goes.
    const wind = setTimeout(() => closing.close(), state.endedByTool || state.failure || stoppedHere ? 0 : WIND_DOWN_MS);
    wind.unref?.();
    if (state.endedByTool || state.failure || stoppedHere) closing.close();
  }

  if (live.abort.signal.aborted) {
    lives.delete(turnId);
    return;
  }
  if (state.endedByTool) {
    deps.completeSilent(turnId);
    return;
  }
  if (state.failure) {
    deps.failTurn(turnId, state.failure.kind, state.failure.detail ?? null);
    return;
  }
  if (startError) {
    if (startError instanceof AgentStartError) {
      deps.failTurn(turnId, startError.failKind, startError.detail);
      return;
    }
    console.error(`[turn ${turnId}] ${label} could not start`, startError);
    deps.failTurn(turnId, "agent_exited", startError instanceof Error ? clip(startError.message, 200) : lastLine(state.stderr));
    return;
  }
  if (isLive(store, turnId)) deps.failTurn(turnId, "agent_exited", lastLine(state.stderr));
}

/** The app runs a command for the agent (ACP `terminal/create`), recorded and stopped like any of the turn's processes. */
function runTerminal(
  spawnRecorded: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildProcess,
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; outputByteLimit: number | null },
): AppTerminal {
  const limit = options.outputByteLimit && options.outputByteLimit > 0 ? options.outputByteLimit : TERMINAL_OUTPUT_MAX;
  // A command handed over as one string (Grok's `bash -lc '…'`) runs through the shell it names.
  const argv = args.length > 0 ? [command, ...args] : ["/bin/sh", "-c", command];
  const child = spawnRecorded(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env });
  let output = "";
  let truncated = false;
  let exit: { exitCode: number | null; signal: string | null } | null = null;
  const take = (chunk: Buffer | string) => {
    output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(output) > limit) {
      truncated = true;
      output = output.slice(output.length - limit);
    }
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  child.stdin?.end();
  const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) => {
      exit = { exitCode: code, signal: signal ?? null };
      resolve(exit);
    });
    child.once("error", (error) => {
      take(String(error));
      exit = { exitCode: 127, signal: null };
      resolve(exit);
    });
  });
  return {
    output: () => ({ output, truncated, exitCode: exit?.exitCode ?? null, signal: exit?.signal ?? null, done: exit !== null }),
    waitForExit: () => exited,
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    },
  };
}

function absolute(cwd: string, path: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) return path;
  return `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

function isLive(store: Store, id: string): boolean {
  try {
    return ["running", "waiting_ask", "waiting_approval"].includes(store.getTurn(id).status);
  } catch {
    return false;
  }
}

function lastLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim();
  return line ? clip(line, 200) : null;
}
