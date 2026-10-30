/**
 * A project session's agent (ADR 0095): your own Claude Code in the session's directory, as in its
 * desktop app, with no Bot. The app keeps two things: every tool goes through the app's permission
 * mode (`decideAgentCall`, an approval card under ask first), and Stop ends the run and what it
 * started. In plan mode (ADR 0098) it writes no file but its plan, and the plan is a card of its
 * own: approved, it gets to work; not, it keeps planning. Nothing else of a Bot's turn runs: no jobs, organizer, end contract or supervisor. The
 * agent keeps the history itself — the first run starts or branches its session, every later one
 * resumes it — so a run is sent only your new line, with its pictures.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { CanUseTool, HookCallbackMatcher, HookInput, HookJSONOutput, Options, PermissionResult, SDKMessage, SDKResultMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { isClaudeEffort, PLAN_APPROVAL_KIND, type AgentRun, type AgentRunApproval, type AgentRunToolInfo, type Attachment, type ClaudeEffort, type Message, type ProjectAgentMode, type ToolFrame } from "@real-bot/protocol";
import { homedir } from "node:os";
import { placeOfCall } from "./claude-code/tool-place";
import { modelOf } from "./claude-code/replay";
import { changeVerdict } from "./permission-gate";
import { accountOf, claudeChildEnv } from "./claude-code/status";
import { AGENT_WORK_TOOLS, decideAgentCall } from "./claude-code/policy";
import type { ClaudeCodeProbe } from "./claude-code/probe";
import { withSystemProxy } from "./claude-code/proxy";
import { claudeLaunch, killsTree } from "./claude-code/spawn";
import { defaultConfigDir, tildeDir } from "./claude-code/account";
import { claudeMemoryDirs, claudePlanDirs } from "./claude-code/memory-dir";
import { carriedTotals, resultTotals, type ModelTotals } from "./claude-code/model-usage";
import { findClaudeSessionFile } from "./claude-code/sessions";
import { inputQueue, LIMIT_ERRORS, SIGNED_OUT_ERRORS, userMessage } from "./engine/agent-runner";
import { recordLiveProc } from "./live-procs";
import { pictureMime } from "./loop-pictures";
import type { Store } from "./store";
import { visionImage } from "./vision-image";

/** The SDK's `query` as the runner uses it, or a test's stand-in. */
export type ProjectQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & {
  close(): void;
  /** The SDK's own: the model for the steps still to come in this run. */
  setModel?(model?: string): Promise<void>;
  /** The SDK's own: the session's flag settings, here its thinking level (null: the model's default). */
  applyFlagSettings?(settings: { effortLevel?: ClaudeEffort | null }): Promise<void>;
  /** The SDK's own: plan mode on or off for the steps still to come. */
  setPermissionMode?(mode: ClaudeMode): Promise<void>;
};

/** The two of Claude Code's own modes a project session runs in: as usual, or planning (ADR 0098). */
type ClaudeMode = "default" | "plan";

/** Your answer on a card: a line sent while a plan waits on you is a change to it (`revise`). */
type Answer = "allow" | "deny" | "revise";

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
  /**
   * The session's model or thinking level changed: a live run takes it from its next step (null:
   * the agent's default); a key left out is not touched.
   */
  tune(sessionId: string, change: { model?: string | null; effort?: string | null; mode?: ProjectAgentMode | null }): void;
  /** Resolves once every run started so far has ended (tests). */
  idle(): Promise<void>;
  close(): void;
};

type Live = {
  runId: string;
  sessionId: string;
  input: ReturnType<typeof inputQueue<SDKUserMessage>>;
  abort: AbortController;
  /**
   * Lines sent that no result has answered yet, oldest first: each with the uuid a result lists it
   * by, and the command it runs (`compact`) or null. Claude Code folds a line sent mid-step into the
   * step it is on, so one result can answer several.
   */
  sent: Array<{ uuid: string; command: string | null }>;
  /**
   * The approvals waiting on you, oldest first, and how to answer each: Claude Code can ask about
   * two calls at once (it runs independent tools in parallel). The first is the card; answering it
   * brings the next.
   */
  waiting: Array<{ approval: AgentRunApproval; resolve: (answer: Answer) => void }>;
  /** The approval each tool call asked for, by call id, read back when Claude Code asks. */
  asked: Map<string, AgentRunApproval>;
  /**
   * What it has said since its last result, whole: the working bubble shows the start of it, and a
   * run cut short before its result keeps it as its line.
   */
  said: string;
  stopped: boolean;
  /** Its input is closed (everything answered, or stopped): a new line waits for the next run. */
  closing: boolean;
  done: Promise<void>;
  /** The SDK query, once it is started: a model change reaches it here. */
  query: ReturnType<ProjectQuery> | null;
  /** Claude Code's mode as last known: the session's when the run starts, then as it says. */
  mode: ClaudeMode;
};

const STDERR_KEEP = 8 * 1024;
const ACTIVITY_MAX = 160;
const PARTIAL_MAX = 4000;

let sdkQuery: Promise<ProjectQuery> | null = null;

function loadQuery(): Promise<ProjectQuery> {
  sdkQuery ??= import("@anthropic-ai/claude-agent-sdk").then((sdk) => ({ prompt, options }) => sdk.query({ prompt, options }));
  return sdkQuery;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A place as a few words, for a reader that knows only `ToolFrame.target`. */
export function targetText(place: AgentRunToolInfo["place"]): string | undefined {
  if (place.zone === "project") return place.path || ".";
  if (place.zone === "outside" || place.zone === "claude_home") return place.path;
  if (place.zone === "check") return place.check;
  if (place.zone === "git") return "git";
  if (place.zone === "service") return place.server;
  return undefined;
}

/**
 * The slash command a line runs, by its name (`/compact keep the tests` runs `compact`); null for
 * any other line, a path included (`/Users/me/a.ts 看一下`).
 */
export function slashCommandOf(text: string): string | null {
  return /^\/([^\s/]+)(?=\s|$)/.exec(text.trim())?.[1] ?? null;
}

function commandOf(content: LineContent): string | null {
  return typeof content === "string" ? slashCommandOf(content) : null;
}

export function firstLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/).find((part) => part.trim())?.trim();
  return line ? clip(line, 300) : null;
}

type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } };
type LineContent = SDKUserMessage["message"]["content"];

/** What the Messages API takes as one picture; a bigger one goes by its path. */
const PICTURE_BYTES_MAX = 5_000_000;

/** A file of a line as an image Claude Code can look at, shrunk as a Bot's are; null for anything else. */
function pictureOf(abs: string, att: Attachment): ImageBlock | null {
  const mime = pictureMime(att.original_filename) ?? pictureMime(abs);
  if (!mime) return null;
  try {
    const image = visionImage(abs, mime, statSync(abs));
    if (image.bytes.byteLength > PICTURE_BYTES_MAX) return null;
    return { type: "image", source: { type: "base64", media_type: image.mime as ImageBlock["source"]["media_type"], data: image.bytes.toString("base64") } };
  } catch {
    return null;
  }
}

/**
 * Your line as Claude Code reads it: its pictures first, as a paste into Claude Code sends them,
 * then your words. Any other file, or a picture too big or of a type it does not take, is named by
 * its path on this computer: the app keeps what you send in its inbox, not in the session's
 * directory, so a relative path would point nowhere.
 */
function lineContent(store: Store, message: Message, en: boolean): LineContent {
  if (message.attachments.length === 0) return message.body;
  const pictures: ImageBlock[] = [];
  const named: string[] = [];
  for (const att of message.attachments) {
    let abs: string;
    try {
      abs = store.getAttachmentFilePath(att);
    } catch {
      continue;
    }
    const picture = pictureOf(abs, att);
    if (picture) pictures.push(picture);
    else named.push(`${en ? "Attached: " : "附件："}${abs}`);
  }
  const text = [message.body.trim() ? message.body : "", ...named].filter(Boolean).join("\n\n");
  // The API takes no empty text block: a line of pictures alone is just them.
  if (pictures.length === 0) return text || message.body;
  return text ? [...pictures, { type: "text", text }] : pictures;
}

/** One line for what a tool call is doing: its name and what it names. */
function activityOf(name: string, input: Record<string, unknown>): string {
  const named = ["command", "file_path", "notebook_path", "pattern", "url", "query", "description", "path"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return clip(named ? `${name} ${named.replace(/\s+/g, " ").trim()}` : name, ACTIVITY_MAX);
}

/** Claude Code's mode as an `init` or `status` message says it; null when it says none. */
function modeOf(message: SDKMessage): ClaudeMode | null {
  const mode = (message as { permissionMode?: unknown }).permissionMode;
  return typeof mode === "string" ? (mode === "plan" ? "plan" : "default") : null;
}

const PLAN_MODE_DENIED = {
  en: "plan mode is on: nothing changes before the user approves your plan. Present it with ExitPlanMode",
  zh: "计划模式开着：用户批准计划之前什么都不改。用 ExitPlanMode 交上计划",
};
const PLAN_REVISE = {
  en: "The user has not approved this plan: they want it changed, and their next message says how. Stay in plan mode, revise the plan and present it again with ExitPlanMode.",
  zh: "用户还没批准这个计划，要改的地方在用户的下一条消息里。留在计划模式，改好计划后再用 ExitPlanMode 交上来。",
};
const PLAN_KEEP = {
  en: "The user has not approved this plan and wants to keep planning. Stay in plan mode; ask what to change if it is unclear, then present the revised plan with ExitPlanMode.",
  zh: "用户没有批准这个计划，要接着改。留在计划模式；不清楚改哪里就问，改好后再用 ExitPlanMode 交上来。",
};
export const COMPACTING = { en: "Compacting the conversation", zh: "正在压缩上下文" };

/** The app's line for a command that answered nothing. */
function commandRan(command: string, en: boolean): string {
  if (command === "clear") return en ? "Ran /clear: Claude Code starts over with an empty context; the lines here stay" : "已执行 /clear：Claude Code 从空的上下文重新开始，这里的记录还在";
  if (command === "compact") return en ? "Ran /compact: Claude Code keeps a summary of the conversation so far" : "已执行 /compact：Claude Code 把之前的对话压成了摘要";
  return en ? `Ran /${command}` : `已执行 /${command}`;
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
    // A command names nothing: the session takes its name from the first thing you ask.
    if (!commandOf(message.body)) store.nameProjectSessionIfUnnamed(sessionId, message.body);
    const live = lives.get(sessionId);
    if (live && (live.stopped || live.closing)) {
      // Winding down: the line opens the next run once this one is gone.
      void live.done.then(() => heard(message));
      return;
    }
    if (live) {
      // A plan waiting on you is not approved by what you say next: it is what to change.
      if (live.waiting[0]?.approval.kind_key === PLAN_APPROVAL_KIND) live.waiting.shift()!.resolve("revise");
      // Read at Claude Code's next step: folded into the step it is on, or answered on its own.
      send(live, lineContent(store, message, locale() === "en"));
      return;
    }
    const run = store.createAgentRun(sessionId);
    const input = inputQueue<SDKUserMessage>();
    let finish!: () => void;
    const fresh: Live = {
      runId: run.id, sessionId, input, abort: new AbortController(), sent: [], waiting: [], asked: new Map(), said: "", stopped: false, closing: false, query: null,
      done: new Promise<void>((resolve) => { finish = resolve; }), mode: project.mode === "plan" ? "plan" : "default",
    };
    lives.set(sessionId, fresh);
    send(fresh, lineContent(store, message, locale() === "en"));
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

  function send(live: Live, content: LineContent): void {
    const uuid = crypto.randomUUID();
    live.sent.push({ uuid, command: commandOf(content) });
    live.input.push({ ...userMessage(content), uuid });
  }

  /** What it said in a step that ends before its result (Stop, a failure, the daemon going down) stays on the record, as the bubble showed it. */
  function keepSaid(live: Live): void {
    const said = live.said.trim();
    live.said = "";
    if (!said) return;
    try {
      postLine(live.sessionId, "bot", said);
    } catch (error) {
      // The run still has to end: a session gone meanwhile has nowhere to keep it.
      console.error(`[project ${live.sessionId}] could not keep what it said`, error);
    }
  }

  function fail(live: Live, detail: string): void {
    const run = store.getAgentRun(live.runId);
    if (!["running", "waiting_approval"].includes(run.status)) return;
    keepSaid(live);
    update(live.runId, { status: "failed", activity: null, partial: null, approval: null, error: detail });
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
    const accountDir = project.configDir ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || defaultConfigDir());
    // Its memory of this project and its saved plans, under the account it runs on: the things in there it may open.
    const memoryDirs = claudeMemoryDirs(project.dir, accountDir);
    const planDirs = claudePlanDirs(accountDir);
    const home = homedir();
    /** The calls under way, by id: when each started and where, for its exited frame. */
    const started = new Map<string, { at: number; name: string; info: AgentRunToolInfo; command?: string }>();
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
      // The call's own mode, as Claude Code says it; the run's as last known otherwise.
      const planning = (raw.permission_mode ?? live.mode) === "plan";
      const decision = decideAgentCall({
        tool: raw.tool_name, input: toolInput, cwd: raw.cwd || project.dir, agentId: raw.agent_id ?? null,
        mode: "work", workspace: project.dir, configDirs, memoryDirs, plan: { on: planning, dirs: planDirs }, permission,
      });
      if (decision.kind === "deny") return deny(decision.reason);
      if (!raw.agent_id) update(live.runId, { activity: activityOf(raw.tool_name, toolInput) });
      const { place, action } = placeOfCall(raw.tool_name, toolInput, { projectDir: project.dir, cwd: raw.cwd || project.dir, home, configDirs });
      const info: AgentRunToolInfo = { session_id: live.sessionId, agent_id: raw.agent_id ?? null, place, ...(action ? { action } : {}),
        model: modelFor(id, raw.agent_id ?? null), at: new Date().toISOString() };
      // A command says itself, as a Bot's does: the chat's command card and its working line read it.
      const command = raw.tool_name === "Bash" && typeof toolInput.command === "string" ? toolInput.command : undefined;
      started.set(id, { at: Date.now(), name: raw.tool_name, info, ...(command ? { command } : {}) });
      deps.onTool?.({ type: "tool", turn_id: live.runId, id, name: raw.tool_name, phase: "started",
        ...(command ? { command, target: command } : { target: targetText(place) }), agent_run: info });
      if (decision.kind === "ask") {
        live.asked.set(id, decision.approval);
        const plan = decision.approval.kind_key === PLAN_APPROVAL_KIND;
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: plan ? "the plan waits on the user" : decision.approval.summary } };
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
      deps.onTool?.({ type: "tool", turn_id: live.runId, id, name: call.name, phase: "exited",
        ...(call.command ? { command: call.command, target: call.command, exit_code: ok ? 0 : 1 } : { target: targetText(call.info.place) }),
        duration_ms: Date.now() - call.at, agent_run: { ...call.info, at: new Date().toISOString(), ok } });
    };
    const canUseTool: CanUseTool = async (toolName, toolInput, options): Promise<PermissionResult> => {
      const asked = live.asked.get(options.toolUseID);
      // Claude Code asking on its own while it plans: nothing changes before the plan is approved.
      if (!asked && live.mode === "plan") return { behavior: "deny", message: en ? PLAN_MODE_DENIED.en : PLAN_MODE_DENIED.zh };
      // Claude Code asking on its own (a protected file): answered by the mode, as for a Bot.
      if (!asked) {
        const verdict = changeVerdict(permission);
        if (verdict === "allow") return { behavior: "allow", updatedInput: toolInput };
        if (verdict === "refuse") return { behavior: "deny", message: en ? "the permission mode is read-only" : "权限模式是只读" };
      }
      const approval = asked ?? { kind_key: "agent-permission", target: options.blockedPath ?? toolName, summary: clip(`${toolName} ${options.title ?? options.description ?? JSON.stringify(toolInput)}`, 300) };
      const answer = await new Promise<Answer>((resolve) => {
        live.waiting.push({ approval, resolve });
        // Another call already asking keeps the card until it is answered.
        if (live.waiting.length === 1) update(live.runId, { status: "waiting_approval", approval });
      });
      live.asked.delete(options.toolUseID);
      if (live.stopped) return { behavior: "deny", message: en ? "stopped" : "已停止", interrupt: true };
      // The next call still asking is the card now; with none, the run is at work again.
      const next = live.waiting[0];
      update(live.runId, next ? { status: "waiting_approval", approval: next.approval } : { status: "running", approval: null });
      if (answer !== "allow") ended(options.toolUseID, false);
      if (approval.kind_key === PLAN_APPROVAL_KIND) {
        if (answer !== "allow") return { behavior: "deny", message: (answer === "revise" ? PLAN_REVISE : PLAN_KEEP)[en ? "en" : "zh"] };
        // Approved: it works as usual from here, under the app's permission mode, and so do later runs.
        live.mode = "default";
        store.tuneProjectSession(live.sessionId, { mode: null });
        return { behavior: "allow", updatedInput: toolInput, updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] };
      }
      if (answer !== "allow") return { behavior: "deny", message: en ? "denied: the user does not want this. Do not do the same thing another way." : "denied：用户拒绝了这个动作。不要换办法做同一件事。" };
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
    // What the session carries in: Claude Code's totals go on from it, and the ledger bills only what grows past it.
    const carried = resume ? findClaudeSessionFile({ configDir: project.configDir, dir: accountDir }, resume) : null;
    const billed = (carried ? carriedTotals(carried) : null) ?? new Map<string, ModelTotals>();
    const options: Options = {
      pathToClaudeCodeExecutable: status.path,
      spawnClaudeCodeProcess: (spawnOptions) => (deps.spawnProcess ?? spawnRecorded)(spawnOptions),
      cwd: project.dir,
      env,
      // As in your terminal: your settings and CLAUDE.md, Claude Code's own system prompt.
      settingSources: ["user", "project", "local"],
      persistSession: true,
      ...(resume ? { resume, forkSession: project.agentSession === null } : {}),
      // The session's own picks; none leaves them to your settings, as in the terminal.
      ...(project.model ? { model: project.model } : {}),
      ...(project.effort && isClaudeEffort(project.effort) ? { effort: project.effort } : {}),
      includePartialMessages: false,
      // The session's own: plan mode carries from run to run until a plan is approved or you turn it off.
      permissionMode: live.mode,
      // Always offered, so plan mode turned on mid-run has a way out.
      tools: [...AGENT_WORK_TOOLS, "ExitPlanMode"],
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
    const session = query({ prompt: live.input.iterable, options });
    live.query = session;
    try {
      for await (const message of session) {
        if (live.stopped) break;
        if (message.type === "system" && message.subtype === "init") {
          const own = (message as { session_id?: string }).session_id;
          if (own) store.recordProjectAgentSession(live.sessionId, own);
          models.main = modelOf({ model: (message as { model?: string }).model }) ?? models.main;
          live.mode = modeOf(message) ?? live.mode;
          continue;
        }
        if (message.type === "system" && message.subtype === "status") {
          live.mode = modeOf(message) ?? live.mode;
          // `/compact` says it is at it; nothing else on screen would.
          const compacting = (message as { status?: string | null }).status === "compacting";
          if (compacting || store.getAgentRun(live.runId).activity === COMPACTING[en ? "en" : "zh"]) {
            update(live.runId, { activity: compacting ? COMPACTING[en ? "en" : "zh"] : null });
          }
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
            live.said = live.said ? `${live.said}\n\n${text}` : text;
            update(live.runId, { partial: clip(live.said, PARTIAL_MAX) });
          }
          continue;
        }
        if (message.type === "result") {
          // The lines it answers: the ones it lists, or the oldest when it lists none of ours (an
          // older Claude Code lists none).
          const listed = (message as { user_message_uuids?: unknown }).user_message_uuids;
          const mine = Array.isArray(listed) ? live.sent.filter((line) => listed.includes(line.uuid)) : [];
          const answered = mine.length > 0 ? mine : live.sent.slice(0, 1);
          live.sent = live.sent.filter((line) => !answered.includes(line));
          const command = answered.find((line) => line.command)?.command ?? null;
          bill(live, message, billed, models.main);
          if (message.subtype !== "success" || message.is_error || failure) {
            failure ??= message.subtype === "success" ? firstLine(message.result ?? "") ?? "error" : message.errors?.[0] ?? message.subtype;
            break;
          }
          if ((message.result ?? "").trim()) postLine(live.sessionId, "bot", message.result!.trim());
          // A command that answers nothing (`/compact`, `/clear`) still says it ran.
          else if (command) postLine(live.sessionId, "system", commandRan(command, en));
          live.said = "";
          update(live.runId, { partial: null, activity: null });
          // Nothing more of yours to answer: the run is over.
          if (live.sent.length === 0) {
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

  /**
   * What the run has cost since its last row, per model, as the spend ledger's `project` line (ADR
   * 0095, 2026-10-27): a result's totals are the whole session's, carried across runs, so a row
   * bills what grew past `billed`. Totals smaller than that started from zero after all and bill whole.
   */
  function bill(live: Live, result: SDKResultMessage, billed: Map<string, ModelTotals>, model: string | null): void {
    for (const [name, total] of resultTotals(result, model)) {
      const before = billed.get(name);
      const base = before && total.input >= before.input && total.output >= before.output && total.cost >= before.cost
        ? before : { input: 0, output: 0, cached: 0, cost: 0 };
      billed.set(name, total);
      const delta = { input: total.input - base.input, output: total.output - base.output, cached: Math.max(0, total.cached - base.cached), cost: total.cost - base.cost };
      if (delta.input <= 0 && delta.output <= 0 && delta.cost <= 0) continue;
      try {
        store.insertSpend({
          kind: "turn", purpose: "project", sessionId: live.sessionId, botId: null, turnId: live.runId, providerId: "", providerName: "Claude Agent",
          model: name, thinkingLevel: null, inputTokens: delta.input, outputTokens: delta.output, totalTokens: delta.input + delta.output,
          cachedTokens: delta.cached, reasoningTokens: null, costUsdTicks: null, estimatedCostUsdTicks: Math.max(0, Math.round(delta.cost * 1e10)), missingReason: null,
        });
      } catch (error) {
        console.error(`[project ${live.sessionId}] could not record spend`, error);
      }
    }
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
      const head = run.status === "waiting_approval" ? live.waiting.shift() : undefined;
      if (!head) return run;
      head.resolve(allow ? "allow" : "deny");
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
      // Before the run reads as stopped, and so before a line you send next.
      keepSaid(live);
      for (const asking of live.waiting.splice(0)) asking.resolve("deny");
      live.input.close();
      live.abort.abort();
      return update(runId, { status: "stopped", activity: null, partial: null, approval: null });
    },
    stopSession(sessionId) {
      const live = lives.get(sessionId);
      if (live && !live.stopped) this.stop(live.runId);
    },
    tune(sessionId, change) {
      const live = lives.get(sessionId);
      if (!live || live.stopped || live.closing) return;
      // Known before the query starts too: the run starts in it.
      if (change.mode !== undefined) {
        live.mode = change.mode === "plan" ? "plan" : "default";
        live.query?.setPermissionMode?.(live.mode).catch(() => {});
      }
      if (!live.query) return;
      // Best effort: a run that ends meanwhile has nothing to switch, and the next one starts on it.
      if (change.model !== undefined) live.query.setModel?.(change.model ?? undefined).catch(() => {});
      if (change.effort !== undefined) {
        const effortLevel = change.effort && isClaudeEffort(change.effort) ? change.effort : null;
        live.query.applyFlagSettings?.({ effortLevel }).catch(() => {});
      }
    },
    async idle() {
      while (settling.size > 0) await Promise.all([...settling]);
    },
    close() {
      for (const live of lives.values()) {
        live.stopped = true;
        keepSaid(live);
        for (const asking of live.waiting.splice(0)) asking.resolve("deny");
        live.input.close();
        live.abort.abort();
      }
    },
  };
}
