/**
 * A project session's agent when it is Codex (ADR 0099): your own Codex in the session's
 * directory, through its app-server, as in Codex's own app — your config, AGENTS.md, MCP servers
 * and skills come along, and the app adds no instructions and none of its tools. As with Claude
 * Code (`project-runner.ts`), the app keeps two things. Every command and file change waits for
 * it: the thread runs with a read-only sandbox and approval `untrusted`, as a Bot's Codex does
 * (`engine/agent/drivers/codex.ts`), and the app's permission mode answers (`decideAction`), with
 * a card under ask first. Stop ends the run and what it started. Each run is an app-server of its
 * own: the first starts a thread Codex keeps, every later one resumes it, so a run is sent only
 * your new line. Plan mode, the `/` list, accounts, carrying on a terminal session and the replay
 * are Claude Code's only (`PROJECT_AGENT_CAPS`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAgentEffort, type AgentRunApproval, type AgentRunToolInfo, type Message, type ToolFrame } from "@real-bot/protocol";
import daemonPackage from "../package.json";
import { resolveAgent, type ResolvedAgent } from "./agents/runtime";
import { placeOfCall } from "./claude-code/tool-place";
import { claudeLaunch, killsTree } from "./claude-code/spawn";
import { classifyCodexError } from "./engine/agent/drivers/codex";
import { rpcPeer, type RpcPeer } from "./engine/agent/jsonrpc";
import { absoluteFrom, decideAction, unwrapShell, type AppAction } from "./engine/agent/policy";
import { agentTrace } from "./engine/agent/trace";
import { recordLiveProc } from "./live-procs";
import { pictureMime } from "./loop-pictures";
import { clip, firstLine, targetText, type ProjectRunner } from "./project-runner";
import type { Store } from "./store";

export type CodexProjectDeps = {
  store: Store;
  /** The Codex a run starts, found as a Bot's is; a test brings its stand-in. */
  resolve?: () => Promise<ResolvedAgent>;
  /** Each call starting and ending, with where it works, for the task map (ADR 0095): never stored. */
  onTool?: (frame: ToolFrame) => void;
};

/** One of your lines as Codex's `turn/start` takes it: pictures by their path, then your words. */
type CodexInput = { type: "text"; text: string; text_elements: [] } | { type: "localImage"; path: string };
type Item = Record<string, unknown> & { id: string; type: string };
type TurnEnd = { status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null };

type Live = {
  runId: string;
  sessionId: string;
  /** Your lines Codex has not been sent yet, oldest first: the next turn takes them all. */
  queue: CodexInput[][];
  /** Lines being added to the turn going now (`turn/steer`); one Codex turns down joins the queue. */
  steering: Set<Promise<void>>;
  /** The approvals waiting on you, oldest first: the first is the card; answering it brings the next. */
  waiting: Array<{ approval: AgentRunApproval; resolve: (allow: boolean) => void }>;
  stopped: boolean;
  /** Nothing more to send (everything answered, or stopped): a new line waits for the next run. */
  closing: boolean;
  done: Promise<void>;
  abort: AbortController;
  rpc: RpcPeer | null;
  threadId: string | null;
  /** The turn going now; null between turns. */
  turnId: string | null;
};

const INIT_TIMEOUT_MS = 60_000;
const STEER_TIMEOUT_MS = 10_000;
const INTERRUPT_TIMEOUT_MS = 3_000;
const STDERR_KEEP = 8 * 1024;
const ACTIVITY_MAX = 160;
const PARTIAL_MAX = 4000;

/**
 * Your line as Codex reads it: its pictures by their path on this computer (Codex opens them
 * itself, as a picture pasted into it), then your words, with any other file named by its path —
 * the app keeps what you send in its inbox, not in the session's directory.
 */
function lineInput(store: Store, message: Message, en: boolean): CodexInput[] {
  const pictures: CodexInput[] = [];
  const named: string[] = [];
  for (const att of message.attachments) {
    let abs: string;
    try {
      abs = store.getAttachmentFilePath(att);
    } catch {
      continue;
    }
    if (pictureMime(att.original_filename) ?? pictureMime(abs)) pictures.push({ type: "localImage", path: abs });
    else named.push(`${en ? "Attached: " : "附件："}${abs}`);
  }
  const text = [message.body.trim() ? message.body : "", ...named].filter(Boolean).join("\n\n");
  return [...pictures, ...(text || pictures.length === 0 ? [{ type: "text" as const, text: text || message.body, text_elements: [] as [] }] : [])];
}

/**
 * One of Codex's own calls as the app names it — a command is `shell`, a file change `write_file`,
 * as a Codex Bot's are — with what the task map reads it by: the input `placeOfCall` takes, a
 * line for the run's activity, and the frame's target and MCP fields.
 */
function callOf(item: Item, cwd: string): { name: string; place: { tool: string; input: Record<string, unknown> }; activity: string; command?: string; target?: string; mcp?: { server: string; tool: string } } | null {
  const itemCwd = typeof item.cwd === "string" && item.cwd ? item.cwd : cwd;
  if (item.type === "commandExecution" && typeof item.command === "string") {
    const command = unwrapShell(item.command);
    return { name: "shell", place: { tool: "Bash", input: { command } }, activity: command, command };
  }
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    const paths = (item.changes as Array<{ path?: unknown }>).flatMap((change) => (typeof change.path === "string" ? [absoluteFrom(itemCwd, change.path)] : []));
    return { name: "write_file", place: { tool: "Write", input: { file_path: paths[0] ?? itemCwd } }, activity: paths.join(", ") || "apply_patch", ...(paths[0] ? { target: paths[0] } : {}) };
  }
  if (item.type === "mcpToolCall" && typeof item.server === "string" && typeof item.tool === "string") {
    const name = `mcp__${item.server}__${item.tool}`;
    return { name, place: { tool: name, input: {} }, activity: `${item.server} · ${item.tool}`, mcp: { server: item.server, tool: item.tool } };
  }
  if (item.type === "webSearch") {
    const query = typeof item.query === "string" ? item.query : "";
    return { name: "WebSearch", place: { tool: "WebSearch", input: {} }, activity: query ? `WebSearch ${query}` : "WebSearch", ...(query ? { target: query } : {}) };
  }
  return null;
}

/**
 * Codex's error as a line you can read: a request it relays fails with the service's JSON
 * (`{"error":{"message":"The 'x' model is not supported…"}}`), whose own message is the part to show.
 */
function codexFailure(error: { message?: string; codexErrorInfo?: unknown }): string {
  let message = error.message ?? "";
  try {
    const parsed = JSON.parse(message) as { message?: unknown; error?: { message?: unknown } };
    const inner = parsed?.error?.message ?? parsed?.message;
    if (typeof inner === "string" && inner.trim()) message = inner;
  } catch {
    // not JSON: as it is
  }
  return classifyCodexError({ ...error, message }).detail ?? "error";
}

/** A command or file change as the app's rules count it (`decideAction`). */
function actionOf(item: Item, cwd: string): AppAction | null {
  const itemCwd = typeof item.cwd === "string" && item.cwd ? item.cwd : cwd;
  if (item.type === "commandExecution" && typeof item.command === "string") {
    return { appName: "shell", vendorTool: "shell", paths: [], command: unwrapShell(item.command), cwd: itemCwd };
  }
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    const paths = (item.changes as Array<{ path?: unknown }>).flatMap((change) => (typeof change.path === "string" ? [absoluteFrom(itemCwd, change.path)] : []));
    return { appName: "write_file", vendorTool: "apply_patch", paths, cwd: itemCwd };
  }
  return null;
}

export function createCodexProjectRunner(deps: CodexProjectDeps): ProjectRunner {
  const { store } = deps;
  const lives = new Map<string, Live>();
  const settling = new Set<Promise<void>>();

  const update = (runId: string, patch: Parameters<Store["updateAgentRun"]>[1]) => store.updateAgentRun(runId, patch);
  const postLine = (sessionId: string, kind: "bot" | "system", body: string) => {
    store.insertAgentLine(sessionId, { kind, body });
  };
  const locale = () => store.settingsCached().locale;
  const resolve = deps.resolve ?? (() => resolveAgent({ runner: "codex", custom: null, setting: store.agentPath("codex"), configDir: null }));

  /** Codex's app-server, in a process group of its own and on the record, so Stop and a crashed daemon's next boot can end it. */
  function spawnRecorded(live: Live, executable: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
    const windows = process.platform === "win32";
    // npm's `codex.cmd` on Windows is a batch file, run through cmd.exe (ADR 0061 decision 2).
    const launch = claudeLaunch(executable, args, env);
    const child = spawn(launch.command, launch.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: !windows, windowsHide: true, windowsVerbatimArguments: launch.verbatim });
    if (child.pid) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        recordLiveProc(store, { pid: child.pid, exited }, { pgid: windows ? null : child.pid, command: `${executable} (project session)` });
      } catch {
        // the record is for cleanup after a crash; the run itself does not need it
      }
    }
    killsTree(child);
    const kill = () => child.kill("SIGTERM");
    if (live.abort.signal.aborted) kill();
    else live.abort.signal.addEventListener("abort", kill, { once: true });
    return child;
  }

  function heard(message: Message): void {
    const sessionId = message.session_id;
    const project = store.projectOf(sessionId);
    if (!project) return;
    store.nameProjectSessionIfUnnamed(sessionId, message.body);
    const live = lives.get(sessionId);
    if (live && (live.stopped || live.closing)) {
      // Winding down: the line opens the next run once this one is gone.
      void live.done.then(() => heard(message));
      return;
    }
    const input = lineInput(store, message, locale() === "en");
    if (live) {
      // A turn going now takes it at its next step, as Codex's own steer does; between turns it waits for the next.
      if (live.rpc && live.threadId && live.turnId) steer(live, live.rpc, live.threadId, live.turnId, input);
      else live.queue.push(input);
      return;
    }
    const run = store.createAgentRun(sessionId);
    let finish!: () => void;
    const fresh: Live = {
      runId: run.id, sessionId, queue: [input], steering: new Set(), waiting: [], stopped: false, closing: false,
      done: new Promise<void>((resolve) => { finish = resolve; }), abort: new AbortController(), rpc: null, threadId: null, turnId: null,
    };
    lives.set(sessionId, fresh);
    const running = runSession(fresh).catch((error) => {
      console.error(`[project ${sessionId}] Codex run failed`, error);
      if (!fresh.stopped) fail(fresh, firstLine(String(error)) ?? "error");
    }).finally(() => {
      fresh.closing = true;
      fresh.abort.abort();
      if (lives.get(sessionId) === fresh) lives.delete(sessionId);
      finish();
    });
    settling.add(running);
    void running.finally(() => settling.delete(running));
  }

  function steer(live: Live, rpc: RpcPeer, threadId: string, turnId: string, input: CodexInput[]): void {
    const going = rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input }, STEER_TIMEOUT_MS).then(
      () => {},
      // The turn ended first: the line starts the next one.
      () => { live.queue.push(input); },
    );
    live.steering.add(going);
    void going.finally(() => live.steering.delete(going));
  }

  function fail(live: Live, detail: string): void {
    const run = store.getAgentRun(live.runId);
    if (!["running", "waiting_approval"].includes(run.status)) return;
    update(live.runId, { status: "failed", activity: null, approval: null, error: detail });
    postLine(live.sessionId, "system", locale() === "en" ? `Codex stopped: ${detail}` : `Codex 出错停下了：${detail}`);
  }

  async function runSession(live: Live): Promise<void> {
    const en = locale() === "en";
    const project = store.projectOf(live.sessionId);
    if (!project) return;
    const resolved = await resolve();
    if (!resolved.ok) return fail(live, en ? `Codex was not found on this computer (${resolved.error})` : `这台电脑上没找到 Codex（${resolved.error}）`);
    if (!existsSync(project.dir)) return fail(live, en ? `${project.dir} is no longer there` : `${project.dir} 已经不在了`);
    if (live.stopped) return;

    const child = spawnRecorded(live, resolved.executable, resolved.args, project.dir, resolved.env);
    let stderr = "";
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", (error) => {
        stderr = (stderr + `${error instanceof Error ? error.message : String(error)}\n`).slice(-STDERR_KEEP);
        resolve();
      });
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_KEEP); });
    const rpc = rpcPeer(child.stdout!, child.stdin!, { jsonrpc: false, trace: agentTrace(live.runId) });
    void exited.then(() => rpc.close(new Error("Codex exited")));
    live.rpc = rpc;

    const permission = store.appPermissionMode();
    const configDirs = store.allAgentConfigDirs();
    const home = homedir();
    const items = new Map<string, Item>();
    /** The calls under way, by item id: when each started and what it was, for its exited frame. */
    const started = new Map<string, { at: number; name: string; info: AgentRunToolInfo; command?: string; target?: string; mcp?: { server: string; tool: string } }>();
    let model: string | null = project.model;
    let partial = "";
    let finalText = "";
    let lastText = "";
    let failure: string | null = null;
    let turnDone: ((turn: TurnEnd) => void) | null = null;

    /** Whose call it is: Codex's own thread, or a subagent's thread of its own. */
    const agentOf = (p: Record<string, unknown>): string | null => (typeof p.threadId === "string" && live.threadId && p.threadId !== live.threadId ? p.threadId : null);

    /** The app's rules for one command or file change: allowed, refused, or a card that waits on you. */
    const gate = async (action: AppAction): Promise<boolean> => {
      if (live.stopped) return false;
      const decision = decideAction(action, { mode: "work", workspace: project.dir, configDirs, permission });
      if (decision.kind === "deny") return false;
      if (decision.kind === "allow") return true;
      const allow = await new Promise<boolean>((resolve) => {
        live.waiting.push({ approval: decision.approval, resolve });
        // Another call already asking keeps the card until it is answered.
        if (live.waiting.length === 1) update(live.runId, { status: "waiting_approval", approval: decision.approval });
      });
      if (live.stopped) return false;
      // The next call still asking is the card now; with none, the run is at work again.
      const next = live.waiting[0];
      update(live.runId, next ? { status: "waiting_approval", approval: next.approval } : { status: "running", approval: null });
      return allow;
    };

    rpc.onRequest(async (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case "item/commandExecution/requestApproval": {
          const known = items.get(String(p.itemId ?? p.approvalId ?? ""));
          const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : project.dir;
          const command = typeof p.command === "string" ? p.command : typeof known?.command === "string" ? known.command : "";
          const allow = await gate({ appName: "shell", vendorTool: "shell", paths: [], command: unwrapShell(command), cwd });
          return { decision: allow ? "accept" : "decline" };
        }
        case "item/fileChange/requestApproval": {
          const known = items.get(String(p.itemId ?? ""));
          const action = known ? actionOf(known, project.dir) : null;
          // A change the app cannot see the files of is no change it can approve.
          if (!action || action.paths.length === 0) return { decision: "decline" };
          return { decision: (await gate(action)) ? "accept" : "decline" };
        }
        // Anything else that would hand Codex more than the app's rules give: no, as for a Bot's Codex.
        case "item/permissions/requestApproval":
          return { permissions: {}, scope: "turn" };
        case "applyPatchApproval":
        case "execCommandApproval":
          return { decision: { denied: { rejection: en ? "Deskfolk answers approvals through its own rules" : "Deskfolk 按自己的规则批准" } } };
        case "mcpServer/elicitation/request":
          return { action: "decline", content: null, _meta: null };
        case "item/tool/requestUserInput":
          throw new Error(en ? "ask the user in your reply" : "在回复里问用户");
        default:
          throw new Error(`${method} is not supported by Deskfolk`);
      }
    });

    /** A call that started is over: it ran (or failed), or it was refused. */
    const ended = (id: string, ok: boolean, exitCode?: number | null) => {
      const call = started.get(id);
      if (!call) return;
      started.delete(id);
      if (!call.info.agent_id) update(live.runId, { activity: null });
      deps.onTool?.({ type: "tool", turn_id: live.runId, id, name: call.name, phase: "exited",
        ...(call.command ? { command: call.command, target: call.command, exit_code: exitCode ?? (ok ? 0 : 1) } : { target: call.target ?? targetText(call.info.place) }),
        ...(call.mcp ? { mcp_server: call.mcp.server, mcp_tool: call.mcp.tool } : {}),
        duration_ms: Date.now() - call.at, agent_run: { ...call.info, at: new Date().toISOString(), ok } });
    };

    rpc.onNotification((method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      // An item is noted at once, before an approval request that follows it in the same read is
      // answered: a file change's request names only the item, and its paths are in the item.
      if (method === "item/started" || method === "item/completed") {
        const item = p.item as Item | undefined;
        if (!item?.id) return;
        items.set(item.id, { ...(items.get(item.id) ?? {}), ...item });
        const agentId = agentOf(p);
        if (item.type === "agentMessage") {
          if (method !== "item/completed" || agentId) return;
          const text = typeof item.text === "string" ? item.text : "";
          lastText = text;
          // Its final answer is the reply; words beside its work are what it has said so far.
          if (item.phase === "final_answer") finalText = text;
          else if (text.trim()) {
            partial = clip(partial ? `${partial}\n\n${text}` : text, PARTIAL_MAX);
            update(live.runId, { partial });
          }
          return;
        }
        const call = callOf(item, project.dir);
        if (!call) return;
        if (method === "item/started" && !started.has(item.id)) {
          const { place, action } = placeOfCall(call.place.tool, call.place.input, { projectDir: project.dir, cwd: typeof item.cwd === "string" && item.cwd ? item.cwd : project.dir, home, configDirs });
          const info: AgentRunToolInfo = { session_id: live.sessionId, agent_id: agentId, place, ...(action ? { action } : {}), model, at: new Date().toISOString() };
          started.set(item.id, { at: Date.now(), name: call.name, info, ...(call.command ? { command: call.command } : {}), ...(call.target ? { target: call.target } : {}), ...(call.mcp ? { mcp: call.mcp } : {}) });
          if (!agentId) update(live.runId, { activity: clip(call.activity, ACTIVITY_MAX) });
          deps.onTool?.({ type: "tool", turn_id: live.runId, id: item.id, name: call.name, phase: "started",
            ...(call.command ? { command: call.command, target: call.command } : { target: call.target ?? targetText(place) }),
            ...(call.mcp ? { mcp_server: call.mcp.server, mcp_tool: call.mcp.tool } : {}), agent_run: info });
        } else if (method === "item/completed") {
          const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
          ended(item.id, item.status === "completed" && (exitCode === null || exitCode === 0), exitCode);
        }
        return;
      }
      if (method === "error") {
        const error = (p.error ?? {}) as { message?: string; codexErrorInfo?: unknown };
        if (p.willRetry !== true && !agentOf(p)) failure = codexFailure(error);
        return;
      }
      if (method === "turn/completed" && !agentOf(p)) {
        const turn = (p.turn ?? {}) as TurnEnd & { id?: string };
        if (live.turnId && turn.id && turn.id !== live.turnId) return;
        live.turnId = null;
        turnDone?.(turn);
      }
    });

    try {
      await rpc.request("initialize", {
        clientInfo: { name: "deskfolk", title: "Deskfolk", version: typeof daemonPackage.version === "string" ? daemonPackage.version : "dev" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, INIT_TIMEOUT_MS);
      rpc.notify("initialized");
      const account = await rpc.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>("account/read", { refreshToken: false }, INIT_TIMEOUT_MS);
      if (!account?.account && account?.requiresOpenaiAuth !== false) {
        return fail(live, en ? "Codex is not signed in: run codex login in a terminal" : "Codex 还没登录：在终端里运行 codex login");
      }
      if (live.stopped) return;
      // Asks before every command and file change, whatever your config says: the app answers them.
      const asks = { cwd: project.dir, approvalPolicy: "untrusted", sandbox: "read-only", ...(project.model ? { model: project.model } : {}) };
      // The first run starts a thread Codex keeps; every later one resumes it.
      const opened = project.agentSession
        ? await rpc.request<{ thread?: { id?: string }; model?: string }>("thread/resume", { threadId: project.agentSession, ...asks, excludeTurns: true }, INIT_TIMEOUT_MS)
        : await rpc.request<{ thread?: { id?: string }; model?: string }>("thread/start", { ...asks, ephemeral: false, serviceName: "deskfolk" }, INIT_TIMEOUT_MS);
      const threadId = opened?.thread?.id ?? project.agentSession;
      if (!threadId) return fail(live, en ? "Codex opened no thread" : "Codex 没有开出会话");
      if (!project.agentSession) store.recordProjectAgentSession(live.sessionId, threadId);
      live.threadId = threadId;
      model = opened?.model ?? model;

      while (!live.stopped) {
        // Lines being added to the turn that just ended either made it in or wait in the queue now.
        while (live.steering.size > 0) await Promise.all([...live.steering]);
        const input = live.queue.splice(0).flat();
        if (input.length === 0 || live.stopped) break;
        // The session's model and level as they are now: a change reaches the next turn.
        const now = store.projectOf(live.sessionId) ?? project;
        finalText = "";
        lastText = "";
        const finished = new Promise<TurnEnd>((resolve) => { turnDone = resolve; });
        const turnStarted = await rpc.request<{ turn?: { id?: string } }>("turn/start", {
          threadId, input,
          ...(now.model ? { model: now.model } : {}),
          ...(now.effort && isAgentEffort("codex", now.effort) ? { effort: now.effort } : {}),
        }, INIT_TIMEOUT_MS);
        if (now.model) model = now.model;
        if (turnStarted?.turn?.id) live.turnId = turnStarted.turn.id;
        const turn = await Promise.race([finished, exited.then((): TurnEnd => ({ status: "exited" }))]);
        turnDone = null;
        live.turnId = null;
        if (live.stopped) return;
        if (turn.status === "exited") {
          failure ??= firstLine(stderr.split("\n").filter(Boolean).at(-1) ?? "") ?? (en ? "Codex exited" : "Codex 退出了");
          break;
        }
        if (turn.status !== "completed") {
          failure ??= turn.error ? codexFailure(turn.error) : turn.status ?? "error";
          break;
        }
        const reply = (finalText || lastText).trim();
        if (reply) postLine(live.sessionId, "bot", reply);
        partial = "";
        update(live.runId, { partial: null, activity: null });
      }
    } catch (error) {
      if (!live.stopped) failure ??= firstLine(error instanceof Error ? error.message : String(error)) ?? firstLine(stderr.split("\n").filter(Boolean).at(-1) ?? "") ?? "error";
    } finally {
      // A call cut by Stop or a crash never reports its end: it ends with the run.
      for (const id of [...started.keys()]) ended(id, false);
      live.closing = true;
      rpc.close();
      live.abort.abort();
    }
    if (live.stopped) return;
    if (failure) return fail(live, failure);
    update(live.runId, { status: "completed", activity: null, partial: null, approval: null });
  }

  function liveRun(runId: string): Live | null {
    for (const live of lives.values()) if (live.runId === runId) return live;
    return null;
  }

  function stopLive(live: Live): void {
    live.stopped = true;
    for (const asking of live.waiting.splice(0)) asking.resolve(false);
    const { rpc, threadId, turnId } = live;
    // The turn is told to stop first, so Codex keeps a thread it can resume; then its process goes.
    if (rpc && !rpc.closed && threadId && turnId) {
      void rpc.request("turn/interrupt", { threadId, turnId }, INTERRUPT_TIMEOUT_MS).catch(() => undefined).finally(() => live.abort.abort());
    } else live.abort.abort();
  }

  return {
    heard,
    answer(runId, allow) {
      const run = store.getAgentRun(runId);
      const live = liveRun(runId);
      const head = live && run.status === "waiting_approval" ? live.waiting.shift() : undefined;
      if (!head) return run;
      head.resolve(allow);
      return store.getAgentRun(runId);
    },
    stop(runId) {
      const run = store.getAgentRun(runId);
      const live = liveRun(runId);
      if (!live) return run;
      stopLive(live);
      return update(runId, { status: "stopped", activity: null, approval: null });
    },
    stopSession(sessionId) {
      const live = lives.get(sessionId);
      if (live && !live.stopped) this.stop(live.runId);
    },
    // The model and level are read again at each turn's start; plan mode is Claude Code's only.
    tune() {},
    async idle() {
      while (settling.size > 0) await Promise.all([...settling]);
    },
    close() {
      for (const live of lives.values()) stopLive(live);
    },
  };
}
