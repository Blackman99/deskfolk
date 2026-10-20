/**
 * A project session's agent (ADR 0095): your own Claude Code in the session's directory, as in its
 * desktop app, with no Bot. The app keeps two things: every tool goes through the app's permission
 * mode (`decideAgentCall`, an approval card under ask first), and Stop ends the run and what it
 * started. Nothing else of a Bot's turn runs: no jobs, organizer, end contract or supervisor. The
 * agent keeps the history itself — the first run starts or branches its session, every later one
 * resumes it — so a run is sent only your new line.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { CanUseTool, HookCallbackMatcher, HookInput, HookJSONOutput, Options, PermissionResult, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRun, AgentRunApproval, AgentRunToolInfo, Message, ToolFrame } from "@real-bot/protocol";
import { homedir } from "node:os";
import { placeOfCall } from "./claude-code/tool-place";
import { modelOf } from "./claude-code/replay";
import { changeVerdict } from "./permission-gate";
import { accountOf, claudeChildEnv } from "./claude-code/status";
import { AGENT_WORK_TOOLS, decideAgentCall } from "./claude-code/policy";
import type { ClaudeCodeProbe } from "./claude-code/probe";
import { withSystemProxy } from "./claude-code/proxy";
import { claudeLaunch, killsTree } from "./claude-code/spawn";
import { tildeDir } from "./claude-code/account";
import { inputQueue, LIMIT_ERRORS, SIGNED_OUT_ERRORS, userMessage } from "./engine/agent-runner";
import { recordLiveProc } from "./live-procs";
import type { Store } from "./store";

/** The SDK's `query` as the runner uses it, or a test's stand-in. */
export type ProjectQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & { close(): void };

export type ProjectRunnerDeps = {
  store: Store;
  claudeCode: ClaudeCodeProbe | undefined;
  query?: ProjectQuery;
  /** Spawning Claude Code; the SDK's own spawn, made detached and recorded, unless a test brings one. */
  spawnProcess?: (options: SpawnOptions) => SpawnedProcess;
  /**
   * Each tool call starting and ending, with where it works, for the task map (ADR 0095): to the
   * windows and phones as tool frames, never stored. The replay reads the session files instead.
   */
  onTool?: (frame: ToolFrame) => void;
};

export type ProjectRunner = {
  /** Your line in a project session: into the live run, or the start of a new one. */
  heard(message: Message): void;
  /** Your answer on the run's approval card. */
  answer(runId: string, allow: boolean): AgentRun;
  stop(runId: string): AgentRun;
  /** Stops the session's live run, if any: its history is being cleared or the session deleted. */
  stopSession(sessionId: string): void;
  /** Resolves once every run started so far has ended (tests). */
  idle(): Promise<void>;
  close(): void;
};

type Live = {
  runId: string;
  sessionId: string;
  input: ReturnType<typeof inputQueue<SDKUserMessage>>;
  abort: AbortController;
  /** Lines sent that Claude Code has not answered with a result yet. */
  unanswered: number;
  /** The approval waiting on you, and how to answer it. */
  waiting: { resolve: (allow: boolean) => void } | null;
  /** The approval each tool call asked for, by call id, read back when Claude Code asks. */
  asked: Map<string, AgentRunApproval>;
  stopped: boolean;
  /** Its input is closed (everything answered, or stopped): a new line waits for the next run. */
  closing: boolean;
  done: Promise<void>;
};

const STDERR_KEEP = 8 * 1024;
const ACTIVITY_MAX = 160;
const PARTIAL_MAX = 4000;

let sdkQuery: Promise<ProjectQuery> | null = null;

function loadQuery(): Promise<ProjectQuery> {
  sdkQuery ??= import("@anthropic-ai/claude-agent-sdk").then((sdk) => ({ prompt, options }) => sdk.query({ prompt, options }));
  return sdkQuery;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A place as a few words, for a reader that knows only `ToolFrame.target`. */
function targetText(place: AgentRunToolInfo["place"]): string | undefined {
  if (place.zone === "project") return place.path || ".";
  if (place.zone === "outside" || place.zone === "claude_home") return place.path;
  if (place.zone === "check") return place.check;
  if (place.zone === "git") return "git";
  return undefined;
}

function firstLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/).find((part) => part.trim())?.trim();
  return line ? clip(line, 300) : null;
}

/** One line for what a tool call is doing: its name and what it names. */
function activityOf(name: string, input: Record<string, unknown>): string {
  const named = ["command", "file_path", "notebook_path", "pattern", "url", "query", "description", "path"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return clip(named ? `${name} ${named.replace(/\s+/g, " ").trim()}` : name, ACTIVITY_MAX);
}

export function createProjectRunner(deps: ProjectRunnerDeps): ProjectRunner {
  const { store } = deps;
  const lives = new Map<string, Live>();
  const settling = new Set<Promise<void>>();

  // Each write reaches the windows and phones as its event through the store's change journal.
  const update = (runId: string, patch: Parameters<Store["updateAgentRun"]>[1]) => store.updateAgentRun(runId, patch);
  const postLine = (sessionId: string, kind: "bot" | "system", body: string) => {
    store.insertAgentLine(sessionId, { kind, body });
  };
  const locale = () => store.settingsCached().locale;

  /** The SDK's spawn, but in a process group of its own and on the record, so Stop and a crashed daemon's next boot can end it. */
  function spawnRecorded(options: SpawnOptions): SpawnedProcess {
    const windows = process.platform === "win32";
    const launch = claudeLaunch(options.command, options.args, options.env as Record<string, string>);
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !windows,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
    });
    if (child.pid) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        recordLiveProc(store, { pid: child.pid, exited }, { pgid: windows ? null : child.pid, command: `${options.command} (project session)` });
      } catch {
        // the record is for cleanup after a crash; the run itself does not need it
      }
    }
    killsTree(child);
    options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    return child as unknown as SpawnedProcess;
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
    if (live) {
      // Read at Claude Code's next step, answered with a result of its own.
      live.unanswered += 1;
      live.input.push(userMessage(message.body));
      return;
    }
    const run = store.createAgentRun(sessionId);
    const input = inputQueue<SDKUserMessage>();
    let finish!: () => void;
    const fresh: Live = {
      runId: run.id, sessionId, input, abort: new AbortController(), unanswered: 1, waiting: null, asked: new Map(), stopped: false, closing: false,
      done: new Promise<void>((resolve) => { finish = resolve; }),
    };
    lives.set(sessionId, fresh);
    input.push(userMessage(message.body));
    const running = runSession(fresh, project).catch((error) => {
      console.error(`[project ${sessionId}] run failed`, error);
      if (!fresh.stopped) fail(fresh, firstLine(String(error)) ?? "error");
    }).finally(() => {
      if (lives.get(sessionId) === fresh) lives.delete(sessionId);
      finish();
    });
    settling.add(running);
    void running.finally(() => settling.delete(running));
  }

  function fail(live: Live, detail: string): void {
    const run = store.getAgentRun(live.runId);
    if (!["running", "waiting_approval"].includes(run.status)) return;
    update(live.runId, { status: "failed", activity: null, approval: null, error: detail });
    postLine(live.sessionId, "system", locale() === "en" ? `Claude Code stopped: ${detail}` : `Claude Code 出错停下了：${detail}`);
  }

  async function runSession(live: Live, project: NonNullable<ReturnType<Store["projectOf"]>>): Promise<void> {
    const en = locale() === "en";
    const status = deps.claudeCode ? await deps.claudeCode.current() : null;
    if (!status?.path) return fail(live, en ? "Claude Code was not found on this computer" : "这台电脑上没找到 Claude Code");
    if ((accountOf(status, project.configDir) ?? status).logged_in === false) {
      const where = project.configDir ? tildeDir(project.configDir) : null;
      return fail(live, en ? (where ? `the Claude account in ${where} is not signed in` : "Claude Code is not signed in")
        : (where ? `${where} 的 Claude 账号还没登录` : "Claude Code 还没登录"));
    }
    if (!existsSync(project.dir)) return fail(live, en ? `${project.dir} is no longer there` : `${project.dir} 已经不在了`);
    if (live.stopped) return;

    const permission = store.appPermissionMode();
    const configDirs = store.claudeCodeConfigDirs();
    const home = homedir();
    /** The calls under way, by id: when each started and where, for its exited frame. */
    const started = new Map<string, { at: number; name: string; info: AgentRunToolInfo }>();
    /**
     * Which model makes each call, for the map's logos: by the call's id, from the message that
     * asked for it (a subagent's too); failing that the agent's last known model, then the run's.
     */
    const models = { byCall: new Map<string, string>(), byAgent: new Map<string, string>(), main: null as string | null };
    const modelFor = (id: string, agentId: string | null): string | null => {
      const model = models.byCall.get(id) ?? (agentId ? models.byAgent.get(agentId) : models.main) ?? null;
      if (model && agentId) models.byAgent.set(agentId, model);
      return model;
    };
    const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    // The app's answer comes before any allow rule in your settings: a hook's decision is final.
    const preToolUse = async (raw: HookInput, toolUseId: string | undefined): Promise<HookJSONOutput> => {
      if (raw.hook_event_name !== "PreToolUse") return {};
      const id = toolUseId ?? raw.tool_use_id;
      const toolInput = (raw.tool_input ?? {}) as Record<string, unknown>;
      const decision = decideAgentCall({
        tool: raw.tool_name, input: toolInput, cwd: raw.cwd || project.dir, agentId: raw.agent_id ?? null,
        mode: "work", workspace: project.dir, configDirs, permission,
      });
      if (decision.kind === "deny") return deny(decision.reason);
      if (!raw.agent_id) update(live.runId, { activity: activityOf(raw.tool_name, toolInput) });
      const { place, action } = placeOfCall(raw.tool_name, toolInput, { projectDir: project.dir, cwd: raw.cwd || project.dir, home, configDirs });
      const info: AgentRunToolInfo = { session_id: live.sessionId, agent_id: raw.agent_id ?? null, place, ...(action ? { action } : {}),
        model: modelFor(id, raw.agent_id ?? null), at: new Date().toISOString() };
      started.set(id, { at: Date.now(), name: raw.tool_name, info });
      deps.onTool?.({ type: "tool", turn_id: live.runId, id, name: raw.tool_name, phase: "started", target: targetText(place), agent_run: info });
      if (decision.kind === "ask") {
        live.asked.set(id, decision.approval);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: decision.approval.summary } };
      }
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    };
    const postToolUse = async (raw: HookInput, toolUseId: string | undefined, ok: boolean): Promise<HookJSONOutput> => {
      const agentId = (raw as { agent_id?: string }).agent_id;
      if (!agentId) update(live.runId, { activity: null });
      ended(toolUseId ?? (raw as { tool_use_id?: string }).tool_use_id ?? "", ok);
      return {};
    };
    /** A call that started is over: it ran (or failed), or it was refused on its card. */
    const ended = (id: string, ok: boolean) => {
      const call = started.get(id);
      if (!call) return;
      started.delete(id);
      deps.onTool?.({ type: "tool", turn_id: live.runId, id, name: call.name, phase: "exited", target: targetText(call.info.place),
        duration_ms: Date.now() - call.at, agent_run: { ...call.info, at: new Date().toISOString(), ok } });
    };
    const canUseTool: CanUseTool = async (toolName, toolInput, options): Promise<PermissionResult> => {
      const asked = live.asked.get(options.toolUseID);
      // Claude Code asking on its own (a protected file): answered by the mode, as for a Bot.
      if (!asked) {
        const verdict = changeVerdict(permission);
        if (verdict === "allow") return { behavior: "allow", updatedInput: toolInput };
        if (verdict === "refuse") return { behavior: "deny", message: en ? "the permission mode is read-only" : "权限模式是只读" };
      }
      const approval = asked ?? { kind_key: "agent-permission", target: options.blockedPath ?? toolName, summary: clip(`${toolName} ${options.title ?? options.description ?? JSON.stringify(toolInput)}`, 300) };
      update(live.runId, { status: "waiting_approval", approval });
      const allow = await new Promise<boolean>((resolve) => { live.waiting = { resolve }; });
      live.waiting = null;
      live.asked.delete(options.toolUseID);
      if (live.stopped) return { behavior: "deny", message: en ? "stopped" : "已停止", interrupt: true };
      update(live.runId, { status: "running", approval: null });
      if (!allow) ended(options.toolUseID, false);
      if (!allow) return { behavior: "deny", message: en ? "denied: the user does not want this. Do not do the same thing another way." : "denied：用户拒绝了这个动作。不要换办法做同一件事。" };
      return { behavior: "allow", updatedInput: toolInput };
    };
    const hooks: Partial<Record<"PreToolUse" | "PostToolUse" | "PostToolUseFailure", HookCallbackMatcher[]>> = {
      PreToolUse: [{ hooks: [(raw, toolUseId) => preToolUse(raw, toolUseId)], timeout: 86_400 }],
      PostToolUse: [{ hooks: [(raw, toolUseId) => postToolUse(raw, toolUseId, true)] }],
      PostToolUseFailure: [{ hooks: [(raw, toolUseId) => postToolUse(raw, toolUseId, false)] }],
    };
    const env = withSystemProxy(claudeChildEnv(process.env, project.configDir), status);
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = "1";
    let stderr = "";
    // The first run starts the agent's session, or branches off the terminal session it carries on;
    // every later run resumes the one it has.
    const resume = project.agentSession ?? project.source;
    const options: Options = {
      pathToClaudeCodeExecutable: status.path,
      spawnClaudeCodeProcess: (spawnOptions) => (deps.spawnProcess ?? spawnRecorded)(spawnOptions),
      cwd: project.dir,
      env,
      // As in your terminal: your settings and CLAUDE.md, Claude Code's own system prompt.
      settingSources: ["user", "project", "local"],
      persistSession: true,
      ...(resume ? { resume, forkSession: project.agentSession === null } : {}),
      includePartialMessages: false,
      permissionMode: "default",
      tools: [...AGENT_WORK_TOOLS],
      disallowedTools: ["AskUserQuestion"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      hooks,
      canUseTool,
      abortController: live.abort,
      stderr: (data) => { stderr = (stderr + data).slice(-STDERR_KEEP); },
    };

    let query: ProjectQuery;
    try {
      query = deps.query ?? (await loadQuery());
    } catch {
      return fail(live, en ? "the Agent SDK could not be loaded" : "Agent SDK 载入失败");
    }
    if (live.stopped) return;
    let failure: string | null = null;
    let partial = "";
    const session = query({ prompt: live.input.iterable, options });
    try {
      for await (const message of session) {
        if (live.stopped) break;
        if (message.type === "system" && message.subtype === "init") {
          const own = (message as { session_id?: string }).session_id;
          if (own) store.recordProjectAgentSession(live.sessionId, own);
          models.main = modelOf({ model: (message as { model?: string }).model }) ?? models.main;
          continue;
        }
        if (message.type === "assistant") {
          const model = modelOf(message.message);
          if (model) {
            if (!message.parent_tool_use_id) models.main = model;
            for (const block of Array.isArray(message.message.content) ? message.message.content : []) {
              if (block.type === "tool_use") models.byCall.set(block.id, model);
            }
          }
          if (message.parent_tool_use_id) continue;
          const blocks = Array.isArray(message.message.content) ? message.message.content : [];
          const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
          const error = (message as { error?: string }).error;
          if (error) {
            // Claude Code's own line about a request that failed: the failure, never a reply.
            if (SIGNED_OUT_ERRORS.has(error) || LIMIT_ERRORS.has(error)) failure = firstLine(text) ?? error;
            continue;
          }
          if (text.trim()) {
            partial = clip(partial ? `${partial}\n\n${text}` : text, PARTIAL_MAX);
            update(live.runId, { partial });
          }
          continue;
        }
        if (message.type === "result") {
          live.unanswered = Math.max(0, live.unanswered - 1);
          if (message.subtype !== "success" || message.is_error || failure) {
            failure ??= message.subtype === "success" ? firstLine(message.result ?? "") ?? "error" : message.errors?.[0] ?? message.subtype;
            break;
          }
          if ((message.result ?? "").trim()) postLine(live.sessionId, "bot", message.result!.trim());
          partial = "";
          update(live.runId, { partial: null, activity: null });
          // Nothing more of yours to answer: the run is over.
          if (live.unanswered === 0) {
            live.closing = true;
            live.input.close();
          }
        }
      }
    } catch (error) {
      if (!live.stopped) failure ??= firstLine(stderr.split("\n").filter(Boolean).at(-1) ?? "") ?? firstLine(String(error)) ?? "error";
    } finally {
      // A call cut by Stop or a crash never reports its end: it ends with the run.
      for (const id of [...started.keys()]) ended(id, false);
      live.closing = true;
      live.input.close();
      try {
        session.close();
      } catch {
        // already over
      }
    }
    if (live.stopped) return;
    if (failure) return fail(live, failure);
    update(live.runId, { status: "completed", activity: null, partial: null, approval: null });
  }

  function liveRun(runId: string): Live {
    for (const live of lives.values()) if (live.runId === runId) return live;
    throw new Error("not live");
  }

  return {
    heard,
    answer(runId, allow) {
      const run = store.getAgentRun(runId);
      let live: Live;
      try {
        live = liveRun(runId);
      } catch {
        return run;
      }
      if (run.status !== "waiting_approval" || !live.waiting) return run;
      live.waiting.resolve(allow);
      return store.getAgentRun(runId);
    },
    stop(runId) {
      const run = store.getAgentRun(runId);
      let live: Live;
      try {
        live = liveRun(runId);
      } catch {
        return run;
      }
      live.stopped = true;
      live.waiting?.resolve(false);
      live.input.close();
      live.abort.abort();
      return update(runId, { status: "stopped", activity: null, approval: null });
    },
    stopSession(sessionId) {
      const live = lives.get(sessionId);
      if (live && !live.stopped) this.stop(live.runId);
    },
    async idle() {
      while (settling.size > 0) await Promise.all([...settling]);
    },
    close() {
      for (const live of lives.values()) {
        live.stopped = true;
        live.waiting?.resolve(false);
        live.input.close();
        live.abort.abort();
      }
    },
  };
}
