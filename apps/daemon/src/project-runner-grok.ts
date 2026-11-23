/**
 * A project session's agent when it is Grok (ADR 0115): your own Grok Build in the session's
 * directory over the Agent Client Protocol (`grok agent --no-leader stdio`), as in its terminal —
 * your settings, rules, skills and MCP servers come along, and the app adds no instructions and
 * none of its tools. Each run is a Grok of its own: the first opens a session Grok keeps
 * (`session/new`), or branches the terminal session carried on (`_x.ai/session/fork`); every later
 * one resumes it, so a run is sent only your new line.
 *
 * Grok runs its own tools, and your settings may let it do anything without asking (measured: the
 * user's runs `bypassPermissions`). So the app registers a hook Grok runs before every call, its
 * subagents' too (`pre_tool_use`, answered on `_x.ai/hooks/run`): the call waits on the app's rules
 * and, under ask first, on your card. Grok gives a hook 600 s at most and then runs the call, so a
 * card left longer is answered "not yet" and the call refused; approving it later lets Grok's next
 * try through and tells it so. Its plan comes as `_x.ai/exit_plan_mode`, its questions as
 * `_x.ai/ask_user_question`, each a card. What it sends to the background (commands, monitors,
 * subagents) keeps the run open, each a task that can be ended alone; when one ends Grok may take a
 * turn by itself, whose words are posted. Stop ends the run and everything it started.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLAN_APPROVAL_KIND, type AgentRunApproval, type AgentRunToolInfo, type AgentTask, type Message, type ToolFrame } from "@real-bot/protocol";
import { estimateAgentCost } from "./agents/agent-prices";
import { acpContextUsage, agentContextWindow } from "./agents/agent-context";
import { tildeDir } from "./claude-code/account";
import { shellQuote } from "./agents/status";
import { gateChange, inMemoryDir } from "./claude-code/policy";
import { placeOfCall } from "./claude-code/tool-place";
import { grokActionKey, grokActionOf, grokCallText, grokToolName, GROK_SCHEDULING_TOOLS, isOwnTool } from "./agents/grok-calls";
import { grokCarryNote, grokConversationOf, listGrokSessions } from "./agents/grok-sessions";
import { GROK_HIDDEN_COMMANDS, GROK_HOOK_ID, grokCommandsOf, grokHome, grokHooks, grokOpenDirs, grokSessionDir, grokUpdates, initializeGrok, projectGrokOf, withGrokAcp } from "./agents/grok-acp";
import type { ResolvedAgent } from "./agents/runtime";
import { classifyAcpError, offers } from "./engine/agent/drivers/acp";
import { rpcPeer, RpcError, type RpcPeer } from "./engine/agent/jsonrpc";
import { decideAction, type AppAction } from "./engine/agent/policy";
import { agyContentOf, agyQuestionsOf } from "./project-runner-agy";
import { LIMIT_GUESS_MS, RESUME_MARGIN_MS } from "./engine/agent/account-switch";
import { agentTrace } from "./engine/agent/trace";
import { HttpError } from "./errors";
import { createCommandMemory, frameOf, lineBlocks, spawnRecorded, takeNext, type CommandMemory, type Queued } from "./project-acp";
import { questionDesk, type QuestionDesk } from "./project-asks";
import { continueNote, outOfUsageLine, switchedLine } from "./project-limits";
import { clip, COMPACTING, firstLine, slashCommandOf, targetText, type ProjectRunner } from "./project-runner";
import { lineTime, pickUpDetail } from "./prompts/transcript-copy";
import { CONSULT_SERVER, CONSULT_TOOL, type ConsultDesk } from "./project-consult";
import type { Store } from "./store";
import { nodePathHost } from "./workspace-paths";

export type GrokProjectDeps = {
  store: Store;
  /** The consult tool each run of a session of yours gets (ADR 0116). */
  consult?: ConsultDesk;
  /** The Grok a run starts on an account (null: the daemon's own), found as a Bot's is; a test brings its stand-in. */
  resolve?: (configDir: string | null) => Promise<ResolvedAgent>;
  /** Each call starting and ending, with where it works, for the task map (ADR 0095): never stored. */
  onTool?: (frame: ToolFrame) => void;
  /** How long a hook holds a call for your card before Grok is told it waits; under Grok's own 600 s. */
  holdMs?: number;
  /** How long a run with nothing in the background waits for a turn Grok takes by itself; a test's is short. */
  settleMs?: number;
  /** The commands Grok offered in each directory, as runs and `/` lists heard them. */
  commands?: CommandMemory;
  /** Grok's billing, asked when a prompt is turned away for usage; a test brings its stand-in. */
  billing?: (rpc: RpcPeer) => Promise<{ percent: number | null; end: number | null }>;
};

type Answer = "allow" | "deny" | "revise";
/** A card that waits on you, and what answering it does; `words` is the line a plan waiting on you gets as its change. */
type Waiting = { approval: AgentRunApproval; resolve: (answer: Answer, words?: string) => void };

type Live = {
  runId: string;
  sessionId: string;
  /** The account the run is on (null: the daemon's own Grok home). */
  configDir: string | null;
  queue: Queued[];
  waiting: Waiting[];
  said: string;
  stopped: boolean;
  closing: boolean;
  done: Promise<void>;
  abort: AbortController;
  rpc: RpcPeer | null;
  /** Grok's own session id, once opened, branched or resumed. */
  acpSession: string | null;
  prompting: boolean;
  wake: (() => void) | null;
  tasks: Map<string, AgentTask>;
  idle: boolean;
  mode: "default" | "plan";
  questions: QuestionDesk;
  /** Calls the app let through, by Grok's call id: a permission Grok asks for one of them is the app's yes. */
  passed: Set<string>;
  /** Approvals given after Grok was told a call waits (its next try has a new id): what each covers, once. */
  approvedLate: Map<string, number>;
  /** Grok's own background output file for each running command or monitor, by task id. */
  taskFiles: Map<string, string>;
  /** Turns Grok said it will take by itself once something in the background ends, not yet ended. */
  wakes: Set<string>;
  /** It is in a turn of its own (after something in the background ended). */
  selfTurn: boolean;
  /** Each turn whose spend is recorded, by Grok's session and prompt id. */
  billed: Set<string>;
  /** Grok's session folders seen in its hooks, its own and its subagents': its plan and notes are its to write. */
  sessionDirs: Set<string>;
  /** Your lines the prompt going now carries: quoted again if it is turned away for usage. */
  inTurn: string[];
};

const ACTIVITY_MAX = 160;
const PARTIAL_MAX = 4000;
const STDERR_KEEP = 8 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
/** A card held under Grok's 600 s hook timeout, with time to answer before it gives up waiting. */
const HOLD_MS = 590_000;
/** A run with nothing in the background closes once Grok has been quiet this long after its last turn of its own. */
const SETTLE_MS = 120_000;
const TASK_LOG_DIR = "deskfolk-grok-tasks";
/** The card kind of a call of a tool the app cannot tell what it does. */
const TOOL_KIND = "tool";

/** What a late approval tells Grok, its next line (ADR 0115). */
function approvedNote(what: string, en: boolean): string {
  return en
    ? `(Deskfolk) The user has now approved what you were told was waiting for approval: ${what}. Go ahead with it.`
    : `（Deskfolk）你刚才要做、被告知在等批准的「${what}」，用户现在批准了，可以去做了。`;
}

/** The app's line for a command that answered nothing. */
function commandRan(command: string, en: boolean): string {
  if (command === "compact") return en ? "Ran /compact: Grok keeps a summary of the conversation so far" : "已执行 /compact：Grok 把之前的对话压成了摘要";
  return en ? `Ran /${command}` : `已执行 /${command}`;
}

/** Why a command is not sent (ADR 0115). */
function hiddenCommandLine(command: string, en: boolean): string {
  if (command === "always-approve") {
    return en ? "/always-approve is not sent: in a project session the app's permission mode decides what Grok may do without asking" : "/always-approve 没有发出：项目会话里 Grok 能不问就做什么由应用的权限模式定";
  }
  return en
    ? `/${command} is not sent: it keeps Grok working on a schedule of its own after its reply, and a project session's Grok ends with its run, so it would stop without a word`
    : `/${command} 没有发出：它让 Grok 在回复之后按自己的安排接着做，而项目会话里 Grok 随这一轮结束，那些事会悄悄停掉`;
}

/** The share of Grok's billing period used and when the period ends, asked of the run's own Grok. */
async function askBilling(rpc: RpcPeer): Promise<{ percent: number | null; end: number | null }> {
  const billing = await rpc.request<{ config?: { creditUsagePercent?: number; currentPeriod?: { end?: string } } }>("_x.ai/billing", {}, 15_000);
  const end = Date.parse(billing?.config?.currentPeriod?.end ?? "");
  return { percent: typeof billing?.config?.creditUsagePercent === "number" ? billing.config.creditUsagePercent : null, end: Number.isFinite(end) ? end : null };
}

/** The time a task's snapshot gives (`{secs_since_epoch}` or an ISO string), as ISO. */
function snapshotTime(value: unknown): string | null {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  const secs = (value as { secs_since_epoch?: unknown } | null)?.secs_since_epoch;
  return typeof secs === "number" ? new Date(secs * 1000).toISOString() : null;
}

/** The end of a file, at most `max` bytes, with its whole size; null when it cannot be read. */
function tailOf(path: string, max = 64 * 1024): { output: string; total_bytes: number } | null {
  try {
    const size = statSync(path).size;
    const text = readFileSync(path).subarray(Math.max(0, size - max)).toString("utf8");
    return { output: text, total_bytes: size };
  } catch {
    return null;
  }
}

export function createGrokProjectRunner(deps: GrokProjectDeps): ProjectRunner {
  const { store } = deps;
  const lives = new Map<string, Live>();
  const settling = new Set<Promise<void>>();
  const commands = deps.commands ?? createCommandMemory();
  const resolve = deps.resolve ?? projectGrokOf(store);
  const holdMs = deps.holdMs ?? HOLD_MS;
  const update = (runId: string, patch: Parameters<Store["updateAgentRun"]>[1]) => store.updateAgentRun(runId, patch);
  const postLine = (sessionId: string, kind: "bot" | "system", body: string) => {
    store.insertAgentLine(sessionId, { kind, body });
  };
  const locale = () => store.settingsCached().locale;
  /** A live run's way to set the model, level or mode on Grok's session now. */
  const tuning = new Map<string, (change: { model?: string | null; effort?: string | null; mode?: "plan" | null }) => Promise<void>>();

  function heard(message: Message): void {
    const sessionId = message.session_id;
    if (!store.projectOf(sessionId)) return;
    const command = slashCommandOf(message.body);
    if (command && GROK_HIDDEN_COMMANDS.has(command)) {
      postLine(sessionId, "system", hiddenCommandLine(command, locale() === "en"));
      return;
    }
    const live = lives.get(sessionId);
    // Grok waits on its questions: your words are the answer to each (a command still goes as one).
    if (!command && live && !live.stopped && live.questions.takeLine(message)) return;
    // A plan waiting on you is not approved by what you say next: it is what to change, sent with the plan's answer.
    if (!command && live && !live.stopped && live.waiting[0]?.approval.kind_key === PLAN_APPROVAL_KIND) {
      live.waiting.shift()!.resolve("revise", lineBlocks(store, message, locale() === "en").flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n") || message.body);
      return;
    }
    if (!command) store.nameProjectSessionIfUnnamed(sessionId, message.body);
    startRun(sessionId, () => ({ blocks: lineBlocks(store, message, locale() === "en"), command, messageId: message.id }));
  }

  /** Into the session's live run, or the start of a new one. */
  function startRun(sessionId: string, lineOf: () => Queued): void {
    const project = store.projectOf(sessionId);
    if (!project) return;
    const live = lives.get(sessionId);
    if (live && (live.stopped || live.closing)) {
      void live.done.then(() => startRun(sessionId, lineOf));
      return;
    }
    if (live) {
      // ACP has no steer: the line goes with the next prompt, once this one is answered.
      live.queue.push(lineOf());
      live.wake?.();
      return;
    }
    const run = store.createAgentRun(sessionId);
    let finish!: () => void;
    const fresh: Live = {
      runId: run.id, sessionId, configDir: project.configDir, queue: [lineOf()], waiting: [], said: "", stopped: false, closing: false,
      done: new Promise<void>((resolve) => { finish = resolve; }), abort: new AbortController(), rpc: null, acpSession: null,
      prompting: false, wake: null, tasks: new Map(), idle: false, mode: "default", passed: new Set(), approvedLate: new Map(),
      taskFiles: new Map(), wakes: new Set(), selfTurn: false, billed: new Set(), sessionDirs: new Set(), inTurn: [],
      questions: questionDesk(store, sessionId, (open) => {
        if (!fresh.stopped) update(run.id, { asks: open, status: open.length > 0 || fresh.waiting.length > 0 ? "waiting_approval" : "running" });
      }),
    };
    lives.set(sessionId, fresh);
    const running = runSession(fresh).catch((error) => {
      console.error(`[project ${sessionId}] Grok run failed`, error);
      if (!fresh.stopped) fail(fresh, firstLine(String(error)) ?? "error");
    }).finally(() => {
      fresh.closing = true;
      fresh.questions.close();
      for (const asking of fresh.waiting.splice(0)) asking.resolve("deny");
      fresh.abort.abort();
      if (lives.get(sessionId) === fresh) lives.delete(sessionId);
      finish();
    });
    settling.add(running);
    void running.finally(() => settling.delete(running));
  }

  function setIdle(live: Live, idle: boolean): void {
    if (live.idle === idle) return;
    live.idle = idle;
    update(live.runId, { idle });
  }

  function publishTasks(live: Live): void {
    update(live.runId, { tasks: [...live.tasks.values()] });
  }

  function keepSaid(live: Live): void {
    const said = live.said.trim();
    live.said = "";
    if (!said) return;
    try {
      postLine(live.sessionId, "bot", said);
    } catch (error) {
      console.error(`[project ${live.sessionId}] could not keep what Grok said`, error);
    }
  }

  function fail(live: Live, detail: string): void {
    const run = store.getAgentRun(live.runId);
    if (!["running", "waiting_approval"].includes(run.status)) return;
    keepSaid(live);
    update(live.runId, { status: "failed", activity: null, partial: null, approval: null, error: detail });
    postLine(live.sessionId, "system", locale() === "en" ? `Grok stopped: ${detail}` : `Grok 出错停下了：${detail}`);
  }

  /** A card that waits on you; the first is shown, answering it brings the next. */
  function waitOn(live: Live, entry: Waiting): void {
    live.waiting.push(entry);
    if (live.waiting.length === 1) update(live.runId, { status: "waiting_approval", approval: entry.approval });
  }

  /** The cards after one was answered, or the run back at work. */
  function afterAnswer(live: Live): void {
    if (live.stopped) return;
    const next = live.waiting[0];
    update(live.runId, next ? { status: "waiting_approval", approval: next.approval } : { status: live.questions.open().length > 0 ? "waiting_approval" : "running", approval: null });
  }

  /** An account by the name a line gives it. */
  function accountName(dir: string | null, en: boolean): string {
    return dir ? tildeDir(dir) : en ? "the default account" : "默认账号";
  }

  async function runSession(live: Live): Promise<void> {
    const en = locale() === "en";
    const project = store.projectOf(live.sessionId);
    if (!project) return;
    const resolved = await resolve(live.configDir);
    if (!resolved.ok) return fail(live, en ? `grok was not found on this computer (${resolved.error})` : `这台电脑上没找到 grok（${resolved.error}）`);
    if (!existsSync(project.dir)) return fail(live, en ? `${project.dir} is no longer there` : `${project.dir} 已经不在了`);
    if (live.stopped) return;

    const child = spawnRecorded(store, live.abort, resolved.executable, resolved.args, project.dir, resolved.env);
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
    const rpc = rpcPeer(child.stdout!, child.stdin!, { jsonrpc: true, trace: agentTrace(live.runId) });
    void exited.then(() => rpc.close(new Error("grok exited")));
    live.rpc = rpc;

    // A consultant is asked for its view and only looks (ADR 0116): its permission is read-only and it has no `consult` of its own.
    const consultant = project.parentId !== null;
    const permission = store.projectPermissionMode(live.sessionId);
    const mount = consultant ? null : (deps.consult?.mount(live.sessionId, live.runId) ?? null);
    /** The `consult` tool's stdio server for a session of yours (ACP's form); a consultant gets none. */
    const isConsultCall = (action: AppAction) => mount !== null && action.appName === "other" && action.vendorTool === `mcp__${CONSULT_SERVER}__${CONSULT_TOOL}`;
    const mcpServers = (() => {
      if (!mount) return [];
      const { command, args, env } = mount.stdio();
      return [{ name: CONSULT_SERVER, command, args, env: Object.entries(env).map(([name, value]) => ({ name, value })) }];
    })();
    const configDirs = store.allAgentConfigDirs();
    const home = homedir();
    const signIn = live.configDir ? `GROK_HOME=${shellQuote(live.configDir)} grok login` : "grok login";
    let turnText = "";
    /** What it says in a turn of its own, after something in the background ended: posted when that turn ends. */
    let selfText = "";
    let model: string | null = project.model;
    let sawUsageUpdate = false;
    let configOptions: Array<Record<string, unknown>> = [];
    /** The run's main session folder: its plan is written there. */
    const mainDir = () => (live.acpSession ? grokSessionDir(live.configDir, project.dir, live.acpSession, home) : null);
    /** Each call's frame once it went out, by Grok's call id. */
    const frames = new Map<string, { at: number; name: string; info: AgentRunToolInfo; command?: string; target?: string }>();
    /** The spawn calls not yet matched to a subagent, by their description. */
    const spawns: Array<{ id: string; description: string }> = [];
    /** A tool call came since the last words: the next words start a paragraph of their own, not glued to the last. */
    let afterTool = false;
    const joined = (text: string, next: string) => (afterTool && text.trim() && !/\n\s*$/.test(text) ? `${text}\n\n${next}` : text + next);
    let lastActivity = Date.now();

    const own = (extra: string[] = []) => grokOpenDirs(live.configDir, [...live.sessionDirs, ...(mainDir() ? [mainDir()!] : []), ...extra], home);
    /** The app's rules for one call, its plan mode included (Grok's own plan gate checks neither commands nor subagents). */
    const decide = (action: AppAction, planning: boolean, sessionDir: string | null) => {
      const mine = [...live.sessionDirs, ...(mainDir() ? [mainDir()!] : []), ...(sessionDir ? [sessionDir] : [])];
      // Its plan and notes are its to write, in every mode, as Claude Code's plan file is.
      if (action.appName === "write_file" && action.paths.length > 0 && action.paths.every((path) => inMemoryDir(path, mine, nodePathHost))) {
        return { kind: "allow" as const };
      }
      if (planning) {
        const writes = action.appName === "write_file"
          || (action.appName === "shell" && placeOfCall("Bash", { command: action.command ?? "" }, { projectDir: project.dir, cwd: action.cwd, home, configDirs }).action === "write");
        if (writes) return { kind: "deny" as const, reason: en ? "plan mode is on: nothing changes before the plan is approved" : "计划模式开着：计划批准前什么都不改" };
      }
      // A tool the app cannot tell (an MCP server's, one Grok added) may change anything: it goes as a change does.
      if (action.appName === "other") {
        if (planning) return { kind: "deny" as const, reason: en ? "plan mode is on: nothing changes before the plan is approved" : "计划模式开着：计划批准前什么都不改" };
        return gateChange(permission, { kind: "allow", effect: true, appName: "other" }, { kind_key: TOOL_KIND, target: action.vendorTool, summary: `${TOOL_KIND} ${action.vendorTool}` });
      }
      return decideAction(action, { mode: "work", workspace: project.dir, configDirs, permission, openDirs: own(sessionDir ? [sessionDir] : []) });
    };

    /** Holds a call on your card; past `holdMs` Grok is told it waits, and a later yes lets its next try through. */
    const held = (approval: AgentRunApproval, key: string, what: string): Promise<"allow" | "deny" | "late"> => new Promise((settle) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        settle("late");
      }, holdMs);
      timer.unref?.();
      waitOn(live, {
        approval,
        resolve: (answer) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            settle(answer === "allow" ? "allow" : "deny");
            return;
          }
          // Answered after Grok was told it waits: a yes covers its next try, and it is told.
          if (answer === "allow" && !live.stopped) {
            live.approvedLate.set(key, (live.approvedLate.get(key) ?? 0) + 1);
            live.queue.push({ blocks: [{ type: "text", text: approvedNote(what, en) }], command: null, messageId: null });
            live.wake?.();
          }
        },
      });
    });

    /** The hook Grok runs before each call (`_x.ai/hooks/run`): continue, or deny with the reason Grok reads. */
    const hook = async (p: Record<string, unknown>): Promise<{ decision: "continue" | "deny"; reason?: string }> => {
      const name = typeof p.toolName === "string" ? p.toolName : "";
      const input = p.toolInput && typeof p.toolInput === "object" ? p.toolInput as Record<string, unknown> : {};
      const callId = typeof p.toolUseId === "string" ? p.toolUseId : "";
      const sessionDir = typeof p.transcriptPath === "string" && p.transcriptPath ? dirname(p.transcriptPath) : null;
      if (sessionDir && p.sessionId === live.acpSession) live.sessionDirs.add(sessionDir);
      lastActivity = Date.now();
      if (live.stopped) return { decision: "deny", reason: en ? "the user stopped this run" : "用户叫停了这一轮" };
      if (GROK_SCHEDULING_TOOLS.has(name)) {
        return { decision: "deny", reason: en ? "not available in this session: your process ends with the run, so scheduled work would stop without a word; do it now or ask the user" : "这个会话里用不了：这一轮结束你的进程就退出，排好的后续工作会悄悄停掉；现在就做，或者问用户" };
      }
      if (isOwnTool(name)) return { decision: "continue" };
      const action = grokActionOf(name, input, typeof p.cwd === "string" && p.cwd ? p.cwd : project.dir);
      // Asking another agent is always allowed for a session of yours, in every mode, with no card
      // (ADR 0116); only Grok itself asks, not a subagent of its own.
      if (isConsultCall(action)) {
        if (live.acpSession && p.sessionId !== live.acpSession) return { decision: "deny", reason: en ? "only the agent itself may ask a consultant, not a subagent" : "只有它自己能请参谋，子代理不行" };
        if (callId) live.passed.add(callId);
        return { decision: "continue" };
      }
      // Plan mode holds every session of the run: a subagent starts outside Grok's own plan gate.
      const decision = decide(action, p.permissionMode === "plan" || live.mode === "plan", sessionDir);
      if (decision.kind === "allow") {
        if (callId) live.passed.add(callId);
        return { decision: "continue" };
      }
      if (decision.kind === "deny") return { decision: "deny", reason: decision.reason };
      const key = grokActionKey(action, input);
      const late = live.approvedLate.get(key) ?? 0;
      if (late > 0) {
        if (late === 1) live.approvedLate.delete(key);
        else live.approvedLate.set(key, late - 1);
        if (callId) live.passed.add(callId);
        return { decision: "continue" };
      }
      const what = grokCallText(action);
      const answer = await held(decision.approval, key, what);
      if (answer === "allow" && !live.stopped) {
        if (callId) live.passed.add(callId);
        return { decision: "continue" };
      }
      if (answer === "late") {
        return { decision: "deny", reason: en ? "this waits for the user's approval, which has not come yet; do not try it again until you are told it is approved" : "这一步在等用户批准，还没批；收到批准的消息之前不要再试" };
      }
      return { decision: "deny", reason: en ? "the user did not approve this" : "用户没有批准这一步" };
    };

    const startFrame = (sessionId: string, id: string, u: Record<string, unknown>) => {
      if (frames.has(id)) return;
      const name = grokToolName(u);
      if (isOwnTool(name) && name !== "spawn_subagent") return;
      const raw = (u.rawInput && typeof u.rawInput === "object" ? u.rawInput : {}) as Record<string, unknown>;
      if (name === "spawn_subagent") {
        spawns.push({ id, description: typeof raw.description === "string" ? raw.description : "" });
        return;
      }
      const action = grokActionOf(name, raw, project.dir);
      const frame = frameOf(action);
      const { place, action: shellAction } = placeOfCall(frame.place.tool, frame.place.input, { projectDir: project.dir, cwd: action.cwd, home, configDirs });
      const info: AgentRunToolInfo = { session_id: live.sessionId, agent_id: sessionId === live.acpSession ? null : sessionId, place, ...(shellAction ? { action: shellAction } : {}), model, at: new Date().toISOString() };
      frames.set(id, { at: Date.now(), name: frame.name, info, ...(frame.command !== undefined ? { command: frame.command } : {}), ...(frame.target ? { target: frame.target } : {}) });
      if (sessionId === live.acpSession) update(live.runId, { activity: clip(frame.command ?? `${frame.name} ${frame.target ?? ""}`.trim(), ACTIVITY_MAX) });
      deps.onTool?.({ type: "tool", turn_id: live.runId, id, name: frame.name, phase: "started",
        ...(frame.command !== undefined ? { command: frame.command, target: frame.command } : { target: frame.target ?? targetText(place) }), agent_run: info });
    };

    const endFrame = (id: string, ok: boolean, exitCode?: number | null) => {
      const call = frames.get(id);
      if (!call) return;
      frames.delete(id);
      if (call.info.agent_id === null) update(live.runId, { activity: null });
      deps.onTool?.({ type: "tool", turn_id: live.runId, id, name: call.name, phase: "exited",
        ...(call.command !== undefined ? { command: call.command, target: call.command, exit_code: exitCode ?? (ok ? 0 : 1) } : { target: call.target ?? targetText(call.info.place) }),
        duration_ms: Date.now() - call.at, agent_run: { ...call.info, at: new Date().toISOString(), ok } });
    };

    /** A task as Grok reports it: added or brought up to date. */
    const upsertTask = (id: string, patch: Partial<AgentTask> & Pick<AgentTask, "kind">) => {
      const known = live.tasks.get(id);
      const base: AgentTask = known ?? {
        id, tool_use_id: null, kind: patch.kind, status: "running", description: "", command: null, agent_type: null, activity: null,
        summary: null, tool_uses: null, tokens: null, started_at: new Date().toISOString(), ended_at: null, output_file: null,
      };
      live.tasks.set(id, { ...base, ...patch });
      publishTasks(live);
    };

    /** A background command's or monitor's end: its output kept where the tasks route reads it. */
    const taskEnded = (snapshot: Record<string, unknown>, failed: boolean) => {
      const id = typeof snapshot.task_id === "string" ? snapshot.task_id : null;
      const task = id ? live.tasks.get(id) : undefined;
      if (!id || !task) return;
      const output = typeof snapshot.output === "string" ? snapshot.output : tailOf(live.taskFiles.get(id) ?? "")?.output ?? "";
      let file: string | null = null;
      try {
        const dir = join(tmpdir(), TASK_LOG_DIR);
        mkdirSync(dir, { recursive: true });
        file = join(dir, `${live.runId}-${id}.log`);
        writeFileSync(file, output);
      } catch {
        file = null;
      }
      live.taskFiles.delete(id);
      upsertTask(id, {
        kind: task.kind, status: failed ? "failed" : "completed", ended_at: snapshotTime(snapshot.end_time) ?? new Date().toISOString(), output_file: file,
        summary: firstLine(output.split("\n").filter(Boolean).slice(-3).join("\n")),
      });
      if (task.tool_use_id) endFrame(task.tool_use_id, !failed);
      live.wake?.();
    };

    /** Spend of one turn, Grok's or a subagent's, once: the price Grok reports, else an estimate from the model's public price. */
    const bill = (sessionId: string, update: Record<string, unknown>) => {
      const promptId = typeof update.prompt_id === "string" ? update.prompt_id : null;
      const usage = update.usage as Record<string, unknown> | undefined;
      if (!promptId || !usage) return;
      const key = `${sessionId}\u0000${promptId}`;
      if (live.billed.has(key)) return;
      live.billed.add(key);
      const num = (name: string) => (typeof usage[name] === "number" ? usage[name] as number : 0);
      const input = num("inputTokens");
      const output = num("outputTokens");
      const cached = num("cachedReadTokens");
      if (input + output === 0) return;
      const used = usage.modelUsage && typeof usage.modelUsage === "object" ? Object.keys(usage.modelUsage as object)[0] ?? null : null;
      if (sessionId === live.acpSession && !sawUsageUpdate) {
        const ctxTokens = num("contextTokens") || input;
        const reportedWindow = num("contextWindow") || num("modelContextWindow") || null;
        if (ctxTokens > 0) {
          store.recordProjectContext(live.sessionId, { used: ctxTokens, limit: reportedWindow ?? agentContextWindow(used ?? model), model: used ?? model });
        }
      }
      const reported = typeof usage.costUsdTicks === "number" && usage.costIsPartial !== true ? usage.costUsdTicks : null;
      try {
        store.insertSpend({
          kind: "turn", purpose: "project", sessionId: live.sessionId, botId: null, turnId: live.runId, providerId: "", providerName: "Grok",
          model: used ?? model, thinkingLevel: null, inputTokens: input, outputTokens: output, totalTokens: input + output, cachedTokens: cached,
          reasoningTokens: num("reasoningTokens") || null, costUsdTicks: reported,
          // Grok leaves out a turn's price now and then (`usageIsIncomplete`): estimated from the model's public price then.
          estimatedCostUsdTicks: reported === null ? estimateAgentCost(used ?? model, { inputTokens: input, outputTokens: output, cachedTokens: cached }) : null,
          missingReason: null,
        });
      } catch (error) {
        console.error(`[project ${live.sessionId}] could not record spend`, error);
      }
    };

    const onSessionUpdate = (sessionId: string, u: Record<string, unknown>) => {
      const mine = sessionId === live.acpSession;
      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          if (!mine) return;
          const content = u.content as { type?: string; text?: string } | undefined;
          if (content?.type !== "text" || typeof content.text !== "string" || live.stopped) return;
          lastActivity = Date.now();
          if (live.prompting) turnText = joined(turnText, content.text);
          else {
            live.selfTurn = true;
            selfText = joined(selfText, content.text);
          }
          live.said = joined(live.said, content.text);
          afterTool = false;
          update(live.runId, { partial: clip(live.said, PARTIAL_MAX) });
          return;
        }
        case "tool_call":
        case "tool_call_update": {
          const id = typeof u.toolCallId === "string" ? u.toolCallId : null;
          if (!id) return;
          lastActivity = Date.now();
          if (mine) afterTool = true;
          if (mine && !live.prompting) live.selfTurn = true;
          if (u.sessionUpdate === "tool_call" || u.rawInput) startFrame(sessionId, id, u);
          const status = typeof u.status === "string" ? u.status : null;
          const title = typeof u.title === "string" ? u.title : "";
          // A command sent to the background ends its call at once (`[bg] … (<task>)`): its task ends the frame instead.
          if ((status === "completed" || status === "failed") && !title.startsWith("[bg]") && ![...live.tasks.values()].some((task) => task.tool_use_id === id && task.status === "running")) {
            const raw = u.rawOutput as { exit_code?: unknown } | undefined;
            endFrame(id, status === "completed", typeof raw?.exit_code === "number" ? raw.exit_code : null);
          }
          return;
        }
        case "available_commands_update":
          commands.set(project.dir, grokCommandsOf(u.availableCommands));
          return;
        case "current_mode_update": {
          if (!mine || typeof u.currentModeId !== "string") return;
          const mode = u.currentModeId === "plan" ? "plan" : "default";
          if (mode === live.mode) return;
          live.mode = mode;
          // Grok went into plan mode by itself, or out of it with an approval: the session's switch follows.
          store.tuneProjectSession(live.sessionId, { mode: mode === "plan" ? "plan" : null });
          return;
        }
        case "config_option_update":
          if (mine && Array.isArray(u.configOptions)) configOptions = u.configOptions as Array<Record<string, unknown>>;
          return;
        case "usage_update": {
          if (!mine) return;
          const ctx = acpContextUsage(u, model);
          if (ctx) {
            sawUsageUpdate = true;
            store.recordProjectContext(live.sessionId, ctx);
          }
          return;
        }
      }
    };

    const onGrokNote = (sessionId: string, u: Record<string, unknown>) => {
      const mine = sessionId === live.acpSession;
      switch (u.sessionUpdate) {
        case "model_changed":
          if (mine && typeof u.model_id === "string") model = u.model_id;
          return;
        case "task_backgrounded": {
          const id = typeof u.task_id === "string" ? u.task_id : null;
          if (!id) return;
          if (typeof u.output_file === "string") live.taskFiles.set(id, u.output_file);
          const toolUseId = typeof u.tool_call_id === "string" ? u.tool_call_id : null;
          const command = typeof u.command === "string" ? u.command : null;
          upsertTask(id, { kind: "shell", tool_use_id: toolUseId, command: command ? clip(command, 300) : null, description: command ? clip(command, 120) : "" });
          return;
        }
        case "background_tasks": {
          for (const entry of Array.isArray(u.tasks) ? u.tasks as Array<Record<string, unknown>> : []) {
            const id = typeof entry.task_id === "string" ? entry.task_id : null;
            if (!id) continue;
            const known = live.tasks.get(id);
            const kind = entry.kind === "monitor" ? "monitor" : "shell";
            if (typeof entry.output_file === "string" && (entry.status === "running" || !known)) live.taskFiles.set(id, entry.output_file);
            if (!known && entry.status !== "running") continue;
            if (known && known.status !== "running") continue;
            const description = typeof entry.description === "string" && entry.description ? entry.description : typeof entry.command === "string" ? clip(entry.command, 120) : "";
            upsertTask(id, {
              kind, description, command: typeof entry.command === "string" ? clip(entry.command, 300) : null,
              started_at: snapshotTime(entry.started_at) ?? known?.started_at ?? new Date().toISOString(),
            });
          }
          return;
        }
        case "task_completed": {
          const snapshot = (u.task_snapshot ?? {}) as Record<string, unknown>;
          const id = typeof snapshot.task_id === "string" ? snapshot.task_id : null;
          if (id && u.will_wake !== false) live.wakes.add(`task-completed-${id}`);
          // Ended by a kill (`explicitly_killed`, a `signal`) or a non-zero exit: failed (measured 1.0.89).
          const exit = snapshot.exit_code;
          taskEnded(snapshot, snapshot.explicitly_killed === true || (typeof snapshot.signal === "string" && snapshot.signal !== "") || (typeof exit === "number" && exit !== 0));
          return;
        }
        case "subagent_spawned": {
          const child = typeof u.child_session_id === "string" ? u.child_session_id : typeof u.subagent_id === "string" ? u.subagent_id : null;
          if (!child) return;
          const description = typeof u.description === "string" ? u.description : "";
          const at = spawns.findIndex((spawn) => spawn.description === description);
          const spawn = at >= 0 ? spawns.splice(at, 1)[0] : spawns.shift();
          upsertTask(child, {
            kind: "subagent", tool_use_id: spawn?.id ?? null, description, agent_type: typeof u.subagent_type === "string" ? u.subagent_type : null,
          });
          return;
        }
        case "subagent_progress": {
          const child = typeof u.child_session_id === "string" ? u.child_session_id : null;
          const task = child ? live.tasks.get(child) : undefined;
          if (!child || !task || task.status !== "running") return;
          upsertTask(child, { kind: "subagent", tool_uses: typeof u.tool_call_count === "number" ? u.tool_call_count : task.tool_uses, tokens: typeof u.tokens_used === "number" ? u.tokens_used : task.tokens });
          return;
        }
        case "subagent_finished": {
          const child = typeof u.child_session_id === "string" ? u.child_session_id : null;
          const task = child ? live.tasks.get(child) : undefined;
          if (!child || !task) return;
          if (u.will_wake !== false) live.wakes.add(`subagent-completed-${child}`);
          const status = u.status === "completed" ? "completed" : u.status === "cancelled" ? "stopped" : "failed";
          upsertTask(child, {
            kind: "subagent", status, ended_at: new Date().toISOString(),
            summary: firstLine(typeof u.output === "string" ? u.output : typeof u.error === "string" ? u.error : "") ?? null,
            tool_uses: typeof u.tool_calls === "number" ? u.tool_calls : task.tool_uses, tokens: typeof u.tokens_used === "number" ? u.tokens_used : task.tokens,
          });
          live.wake?.();
          return;
        }
        case "turn_completed": {
          bill(sessionId, u);
          if (!mine) return;
          const promptId = typeof u.prompt_id === "string" ? u.prompt_id : "";
          live.wakes.delete(promptId);
          // A turn of its own ended: what it said is posted now.
          if (!live.prompting) {
            live.selfTurn = false;
            const said = selfText.trim();
            selfText = "";
            if (said && !live.stopped) {
              postLine(live.sessionId, "bot", said);
              live.said = "";
              update(live.runId, { partial: null, activity: null });
            }
            live.wake?.();
          }
          return;
        }
      }
    };

    rpc.onNotification((method, params) => {
      const p = (params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
      if (!p.update || typeof p.sessionId !== "string") return;
      if (method === "session/update") onSessionUpdate(p.sessionId, p.update);
      else if (method.startsWith("_x.ai/")) onGrokNote(p.sessionId, p.update);
    });

    rpc.onRequest(async (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === "_x.ai/hooks/run" || method === "x.ai/hooks/run") {
        if (p.hookCallbackId !== GROK_HOOK_ID || p.hookEventName !== "pre_tool_use") return { decision: "continue" };
        return hook(p);
      }
      // Its plan for you to approve (`exit_plan_mode`): the card Claude Code's plans make.
      if (method === "_x.ai/exit_plan_mode" || method === "x.ai/exit_plan_mode") {
        // A consultant never plans: it looks and answers.
        if (consultant) return { outcome: "cancelled", feedback: en ? "You are consulted, not asked to plan: look and answer." : "你是被请教的，不用做计划：看一看，答就是了。" };
        const content = typeof p.planContent === "string" ? p.planContent : "";
        const dir = mainDir();
        const answer = await new Promise<{ answer: Answer; words?: string }>((settle) => {
          waitOn(live, { approval: { kind_key: PLAN_APPROVAL_KIND, target: dir ? join(dir, "plan.md") : project.dir, summary: content }, resolve: (answer, words) => settle({ answer, words }) });
        });
        afterAnswer(live);
        if (live.stopped) return { outcome: "cancelled" };
        if (answer.answer === "allow") {
          live.mode = "default";
          store.tuneProjectSession(live.sessionId, { mode: null });
          return { outcome: "approved" };
        }
        if (answer.answer === "revise") return { outcome: "cancelled", feedback: answer.words ?? "" };
        return { outcome: "cancelled", feedback: en ? "Not approved yet: keep working on the plan." : "还没批准：接着完善计划。" };
      }
      // Its questions for you (`ask_user_question`): a card each, and Grok waits for every answer.
      if (method === "_x.ai/ask_user_question" || method === "x.ai/ask_user_question") {
        const asked = Array.isArray(p.questions) ? p.questions as Array<{ question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown }> : [];
        const questions = asked.flatMap((question) => (typeof question.question === "string" && question.question.trim() ? [{
          question: question.question, header: typeof question.header === "string" ? question.header : null, multiSelect: question.multiSelect === true,
          options: (Array.isArray(question.options) ? question.options as Array<{ label?: unknown; description?: unknown }> : [])
            .flatMap((option) => (typeof option.label === "string" ? [{ label: option.label, description: typeof option.description === "string" ? option.description : null }] : [])),
        }] : []));
        if (questions.length === 0) return { outcome: "cancelled" };
        const answers = await live.questions.ask(questions);
        if (!answers) return { outcome: "cancelled" };
        return {
          outcome: "accepted",
          answers: Object.fromEntries(questions.map((question, index) => [question.question, [...(answers[index]?.selected ?? []), ...(answers[index]?.custom ? [answers[index]!.custom!] : [])]])),
        };
      }
      // An MCP server's form, which Grok passes on: a card each, as agy's questions are.
      if (method === "elicitation/create") {
        const questions = p.mode === "form" || p.mode === undefined ? agyQuestionsOf(p.requestedSchema) : null;
        if (!questions) return { action: "decline" };
        const answers = await live.questions.ask(questions.map((question) => question.question));
        return answers ? { action: "accept", content: agyContentOf(questions, answers) } : { action: "cancel" };
      }
      // Grok asks only where your settings say to; the hook already decided each call it asks about.
      if (method === "session/request_permission") {
        const tool = (p.toolCall ?? {}) as Record<string, unknown>;
        const id = typeof tool.toolCallId === "string" ? tool.toolCallId : "";
        let allow = id !== "" && live.passed.has(id);
        if (!allow) {
          const raw = (tool.rawInput && typeof tool.rawInput === "object" ? tool.rawInput : {}) as Record<string, unknown>;
          const action = grokActionOf(grokToolName(tool), raw, project.dir);
          const decision = isConsultCall(action) ? { kind: "allow" as const } : decide(action, live.mode === "plan", null);
          allow = decision.kind === "allow";
          if (decision.kind === "ask") {
            const answer = await new Promise<Answer>((settle) => waitOn(live, { approval: decision.approval, resolve: (answer) => settle(answer) }));
            afterAnswer(live);
            allow = answer === "allow" && !live.stopped;
          }
        }
        const options = Array.isArray(p.options) ? p.options as Array<{ optionId?: string; kind?: string }> : [];
        // Only ever the once options: the others would be kept in your Grok's own grants.
        const pick = options.find((option) => option.kind === (allow ? "allow_once" : "reject_once")) ?? options.find((option) => option.optionId === (allow ? "allow-once" : "reject-once"));
        return pick?.optionId ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } };
      }
      throw new Error(`${method} is not offered by Deskfolk`);
    });

    const byCategory = (category: string) => configOptions.find((option) => option.category === category || option.id === category);
    const setOption = async (option: Record<string, unknown> | undefined, value: string | null) => {
      if (!option || !value || typeof option.id !== "string" || !live.acpSession) return;
      const answer = await rpc.request<{ configOptions?: Array<Record<string, unknown>> }>("session/set_config_option", { sessionId: live.acpSession, configId: option.id, value }, REQUEST_TIMEOUT_MS).catch(() => null);
      if (Array.isArray(answer?.configOptions) && answer.configOptions.length > 0) configOptions = answer.configOptions;
    };
    /** The session's model, level and mode as they are now, set on Grok's session; a run going now takes them at its next step. */
    const configure = async (change: { model?: string | null; effort?: string | null; mode?: "plan" | null }) => {
      if (change.model) {
        const option = byCategory("model");
        const value = option ? offers(option, change.model) : change.model;
        if (value) await setOption(option, value);
        model = value ?? model;
      }
      if (change.effort) {
        const option = byCategory("thought_level");
        // A model without this level (grok-4.5 has no xhigh) keeps its own.
        const value = option ? offers(option, change.effort) : null;
        if (value) await setOption(option, value);
      }
      if (change.mode !== undefined) {
        const wanted = change.mode === "plan" ? "plan" : "default";
        // A prompt going now switches at once; the next prompt says its mode anyway.
        if (live.prompting && wanted !== live.mode && live.acpSession) rpc.notify("_x.ai/toggle_plan_mode", { sessionId: live.acpSession });
        live.mode = wanted;
      }
    };
    tuning.set(live.runId, configure);

    let failure: string | null = null;
    /** The prompt was turned away by the account's usage limit (ADR 0110), with Grok's own words for it. */
    let limitHit = false;
    let limitWords = "";
    try {
      const caps = await initializeGrok(rpc, REQUEST_TIMEOUT_MS);
      if (!caps.hooks || !caps.resume) {
        return fail(live, en ? "this grok cannot hold its calls for the app's permission mode: update it (grok update)" : "这个 grok 太旧，没法让应用在每次调用前把关：先更新它（grok update）");
      }
      if (caps.commands.length > 0 && !commands.get(project.dir)) commands.set(project.dir, caps.commands);
      if (live.stopped) return;
      type Opened = { sessionId?: string; configOptions?: Array<Record<string, unknown>>; models?: { currentModelId?: string } };
      const meta = { _meta: grokHooks() };
      const opened = async (sessionId: string, answer: Opened | null) => {
        live.acpSession = sessionId;
        configOptions = Array.isArray(answer?.configOptions) ? answer.configOptions : [];
        model = project.model ?? answer?.models?.currentModelId ?? model;
      };
      const open = async (): Promise<void> => {
        const answer = await rpc.request<Opened>("session/new", { cwd: project.dir, mcpServers, ...meta }, REQUEST_TIMEOUT_MS * 2);
        if (!answer?.sessionId) throw new Error(en ? "grok opened no session" : "grok 没有开出会话");
        store.recordProjectAgentSession(live.sessionId, answer.sessionId);
        await opened(answer.sessionId, answer);
      };
      /** The terminal session carried on, branched (ADR 0115): yours stays as it was, this one goes on. */
      const fork = async (source: string): Promise<void> => {
        const ask = (sourceCwd: string) => rpc.request<{ newSessionId?: string; result?: { newSessionId?: string } }>("_x.ai/session/fork", { sourceSessionId: source, sourceCwd, newCwd: project.dir }, REQUEST_TIMEOUT_MS);
        let answer = await ask(project.dir).catch(() => null);
        if (!answer?.newSessionId && !answer?.result?.newSessionId) {
          // Grok keeps a session under the directory as it was spelled then (`/tmp` or `/private/tmp`): asked by its own listing.
          const row = (await listGrokSessions(rpc).catch(() => [])).find((one) => one.sessionId === source);
          if (row?.cwd) answer = await ask(row.cwd);
        }
        const id = answer?.newSessionId ?? answer?.result?.newSessionId;
        if (!id) throw new Error(en ? "grok could not branch the terminal session" : "grok 没能从终端里的会话分出来");
        const resumed = await rpc.request<Opened>("session/resume", { sessionId: id, cwd: project.dir, mcpServers, ...meta }, REQUEST_TIMEOUT_MS * 2);
        store.recordProjectAgentSession(live.sessionId, id);
        await opened(id, resumed);
      };
      /**
       * The session from another of your Grok accounts: each keeps its own sessions, so the
       * conversation is read there and a new session opened here, told what was said; earlier tool
       * calls do not come along.
       */
      const carry = async (sessionId: string): Promise<boolean> => {
        for (const other of [null, ...store.agentConfigDirs("grok")]) {
          if (other === live.configDir) continue;
          const there = await resolve(other).catch(() => null);
          if (!there?.ok) continue;
          const records = await withGrokAcp(there, project.dir, (peer) => grokUpdates(peer, sessionId, project.dir)).catch(() => []);
          const lines = grokConversationOf(records);
          if (lines.length === 0) continue;
          await open();
          live.queue.unshift({ blocks: [{ type: "text", text: grokCarryNote(lines, en) }], command: null, messageId: null });
          postLine(live.sessionId, "system", en
            ? "The conversation came over from your other Grok account: what was said is here as a summary; earlier tool calls did not come along"
            : "这段对话从你的另一个 Grok 账号接了过来：说过的话作为摘要带过来了，之前的工具调用没有带过来");
          return true;
        }
        return false;
      };
      if (project.agentSession) {
        try {
          const answer = await rpc.request<Opened>("session/resume", { sessionId: project.agentSession, cwd: project.dir, mcpServers, ...meta }, REQUEST_TIMEOUT_MS * 2);
          await opened(project.agentSession, answer);
        } catch (error) {
          // Grok has no such session under this account: "Path not found." / FS_NOT_FOUND (measured 1.0.89).
          const missing = error instanceof RpcError && ((error.data as { code?: unknown } | undefined)?.code === "FS_NOT_FOUND" || /not found/i.test(error.message));
          if (!missing) throw error;
          // Not under this account (moved since), or a branch never kept: carried over, or branched again.
          if (!(await carry(project.agentSession))) {
            if (!project.source) throw error;
            await fork(project.source);
          }
        }
      } else if (project.source) await fork(project.source);
      else await open();
      await configure({ model: project.model, effort: project.effort });
      live.mode = project.mode === "plan" ? "plan" : "default";

      /** One prompt: its reply posted. False when the run ends here. */
      const prompt = async (line: Queued): Promise<boolean> => {
        turnText = "";
        sawUsageUpdate = false;
        if (line.command === "compact") update(live.runId, { activity: COMPACTING[en ? "en" : "zh"] });
        live.inTurn = line.messageId ? [line.messageId] : [];
        live.prompting = true;
        let result: { stopReason?: string } | null = null;
        try {
          result = await Promise.race([
            rpc.request<{ stopReason?: string }>("session/prompt", { sessionId: live.acpSession, prompt: line.blocks, _meta: { mode: live.mode === "plan" ? "plan" : "agent" } }),
            exited.then(() => null),
          ]);
        } catch (error) {
          live.prompting = false;
          if (live.stopped) return false;
          const classified = classifyAcpError(error);
          if (classified.failKind === "agent_limit" || (error instanceof RpcError && error.code === -32003) || /free-usage-exhausted/i.test(String(error))) {
            limitHit = true;
            failure = classified.detail ?? (en ? "usage limit reached" : "用量额度用完了");
            limitWords = error instanceof RpcError ? `${error.message} ${JSON.stringify(error.data ?? "")}` : String(error);
          } else if (classified.failKind === "agent_signed_out") failure = en ? `Grok is not signed in: run ${signIn} in a terminal` : `Grok 还没登录：在终端里运行 ${signIn}`;
          else failure = classified.detail ?? "error";
          return false;
        }
        live.prompting = false;
        if (live.stopped) return false;
        if (!result) {
          failure = firstLine(stderr.split("\n").filter(Boolean).at(-1) ?? "") ?? (en ? "grok exited" : "grok 退出了");
          return false;
        }
        const reply = turnText.trim();
        if (reply) postLine(live.sessionId, "bot", reply);
        else if (line.command) postLine(live.sessionId, "system", commandRan(line.command, en));
        live.said = "";
        update(live.runId, { partial: null, activity: null });
        return true;
      };

      const running = () => [...live.tasks.values()].filter((task) => task.status === "running").length;
      while (!live.stopped) {
        const next = takeNext(live.queue);
        if (next && next.blocks.length > 0) {
          setIdle(live, false);
          if (!(await prompt(next))) break;
          lastActivity = Date.now();
          continue;
        }
        const waitingOnGrok = running() > 0 || live.wakes.size > 0 || live.selfTurn;
        // A card Grok was told waits keeps the run open too: approving it sends Grok on.
        if (!waitingOnGrok && live.waiting.length === 0) break;
        // Only what it runs in the background keeps it open: a line you send is answered at once.
        setIdle(live, waitingOnGrok);
        const quietFor = running() > 0 || live.waiting.length > 0 ? null : Math.max(0, (deps.settleMs ?? SETTLE_MS) - (Date.now() - lastActivity));
        const timedOut = await new Promise<boolean>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          live.wake = () => {
            if (timer) clearTimeout(timer);
            resolve(false);
          };
          if (quietFor !== null) timer = setTimeout(() => resolve(true), quietFor);
          if (live.queue.length > 0) live.wake();
        });
        live.wake = null;
        // Nothing in the background and Grok quiet past the wait: a turn it said it would take is not coming.
        if (timedOut && running() === 0 && Date.now() - lastActivity >= (deps.settleMs ?? SETTLE_MS)) {
          live.wakes.clear();
          live.selfTurn = false;
        }
      }
      // What it said in a turn of its own that never closed.
      if (!live.stopped && selfText.trim()) {
        postLine(live.sessionId, "bot", selfText.trim());
        live.said = "";
      }
    } catch (error) {
      if (!live.stopped) {
        const classified = classifyAcpError(error);
        failure ??= classified.failKind === "agent_signed_out" && /auth/i.test(String(error))
          ? (en ? `Grok is not signed in: run ${signIn} in a terminal` : `Grok 还没登录：在终端里运行 ${signIn}`)
          : classified.detail ?? firstLine(stderr.split("\n").filter(Boolean).at(-1) ?? "") ?? "error";
      }
    } finally {
      tuning.delete(live.runId);
      mount?.close();
      for (const id of [...frames.keys()]) endFrame(id, false);
      live.closing = true;
    }
    // Out of usage: the billing says whether the plan is used up, before Grok goes.
    const out = limitHit && !live.stopped ? await (deps.billing ?? askBilling)(rpc).catch(() => ({ percent: null, end: null })) : null;
    rpc.close();
    live.abort.abort();
    if (live.stopped) return;
    if (failure && limitHit && out) return outOfUsage(live, failure, out, limitWords);
    if (failure) return fail(live, failure);
    update(live.runId, { status: "completed", activity: null, partial: null, approval: null, idle: false });
  }
  /**
   * The run's prompt was turned away for usage (ADR 0110): with the plan used up (the billing says
   * so, or Grok's own words), the account is out until the period ends; another 429 is a rate
   * limit, held out an hour and tried again. With another of your Grok accounts not out, the
   * session moves there and goes on, told what was left unanswered; with none and a known end, it
   * picks up then; else it stops as any failure does.
   */
  function outOfUsage(live: Live, detail: string, billing: { percent: number | null; end: number | null }, error: string): void {
    const en = locale() === "en";
    const usedUp = /free-usage-exhausted/i.test(error) || (billing.percent !== null && billing.percent >= 100);
    const known = usedUp && billing.end !== null && billing.end > Date.now();
    store.markAccountOut({ runner: "grok", dir: grokHome(live.configDir), email: null, until: known ? billing.end! : Date.now() + LIMIT_GUESS_MS, known });
    // A consultant's run only fails: its asker is told, and it is not moved to another account or picked up later.
    if (store.projectOf(live.sessionId)?.parentId) return fail(live, detail);
    const unanswered = [...live.inTurn, ...live.queue.flatMap((line) => (line.messageId ? [line.messageId] : []))];
    const outs = new Set(store.accountsOut().filter((row) => row.runner === "grok").map((row) => row.dir));
    const next = [null, ...store.agentConfigDirs("grok")].find((dir) => dir !== live.configDir && !outs.has(grokHome(dir)));
    const reset = known ? (en ? `resets ${lineTime(billing.end!, "en")}` : `${lineTime(billing.end!, "zh")} 重置`) : null;
    if (next !== undefined) {
      keepSaid(live);
      update(live.runId, { status: "failed", activity: null, partial: null, approval: null, error: detail });
      store.tuneProjectSession(live.sessionId, { configDir: next });
      postLine(live.sessionId, "system", switchedLine(locale(), accountName(live.configDir, en), accountName(next, en), reset, "Grok"));
      startRun(live.sessionId, () => ({ blocks: [{ type: "text", text: continueNote(locale(), "switched", messagesOf(unanswered), "Grok") }], command: null, messageId: null }));
      return;
    }
    if (!known) return fail(live, detail);
    fail(live, outOfUsageLine(locale(), pickUpDetail(locale(), reset, billing.end!), "Grok"));
    store.addProjectResume({ session_id: live.sessionId, run_id: live.runId, at: billing.end! + RESUME_MARGIN_MS, lines: unanswered });
  }

  /** Your lines by id, those still there. */
  function messagesOf(ids: readonly string[]): Message[] {
    return ids.flatMap((id) => {
      try {
        return [store.getMessage(id)];
      } catch {
        return [];
      }
    });
  }

  function liveRun(runId: string): Live | null {
    for (const live of lives.values()) if (live.runId === runId) return live;
    return null;
  }

  function stopLive(live: Live): void {
    live.stopped = true;
    keepSaid(live);
    for (const asking of live.waiting.splice(0)) asking.resolve("deny");
    live.questions.close();
    live.wake?.();
    const { rpc, acpSession } = live;
    // The prompt is told to stop first, its subagents with it, so Grok keeps a session it can resume; then its process goes.
    if (rpc && !rpc.closed && acpSession) rpc.notify("session/cancel", { sessionId: acpSession, _meta: { cancelSubagents: true } });
    setTimeout(() => live.abort.abort(), 500).unref?.();
  }

  return {
    heard,
    resumeAfterLimits(now = new Date()) {
      for (const due of store.projectResumes()) {
        if (due.at > now.getTime()) break;
        const project = store.projectOf(due.session_id);
        if (!project || project.agent !== "grok") continue;
        store.dropProjectResume(due.session_id);
        // You spoke since, or a run is going: the session has moved on.
        if (lives.has(due.session_id) || store.latestAgentRun(due.session_id)?.id !== due.run_id) continue;
        startRun(due.session_id, () => ({ blocks: [{ type: "text", text: continueNote(locale(), "reset", messagesOf(due.lines), "Grok") }], command: null, messageId: null }));
      }
    },
    answerAsk(sessionId, askId, input) {
      const live = lives.get(sessionId);
      if (!live || live.stopped) throw new HttpError(422, "invalid_args", "ask is no longer pending");
      return live.questions.answer(askId, input);
    },
    answer(runId, allow) {
      const run = store.getAgentRun(runId);
      const live = liveRun(runId);
      const head = live && run.status === "waiting_approval" ? live.waiting.shift() : undefined;
      if (!live || !head) return run;
      head.resolve(allow ? "allow" : "deny");
      afterAnswer(live);
      return store.getAgentRun(runId);
    },
    stop(runId) {
      const run = store.getAgentRun(runId);
      const live = liveRun(runId);
      if (!live) return run;
      stopLive(live);
      return update(runId, { status: "stopped", activity: null, partial: null, approval: null, idle: false });
    },
    stopSession(sessionId) {
      const live = lives.get(sessionId);
      if (live && !live.stopped) this.stop(live.runId);
    },
    tune(sessionId, change) {
      const live = lives.get(sessionId);
      if (!live || live.stopped || live.closing) return;
      void tuning.get(live.runId)?.({ ...(change.model !== undefined ? { model: change.model } : {}), ...(change.effort !== undefined ? { effort: change.effort } : {}), ...(change.mode !== undefined ? { mode: change.mode } : {}) });
    },
    // One command, monitor or subagent ended alone (`_x.ai/task/kill`, `_x.ai/subagent/cancel`); its own update says when.
    stopTask(runId, taskId) {
      const run = store.getAgentRun(runId);
      const live = liveRun(runId);
      const task = live?.tasks.get(taskId);
      if (!live || !task || task.status !== "running" || !live.rpc || live.rpc.closed || !live.acpSession) return run;
      if (task.kind === "subagent") void live.rpc.request("_x.ai/subagent/cancel", { subagentId: taskId }, REQUEST_TIMEOUT_MS).catch(() => undefined);
      else void live.rpc.request("_x.ai/task/kill", { sessionId: live.acpSession, taskId }, REQUEST_TIMEOUT_MS).catch(() => undefined);
      return run;
    },
    async taskOutput(runId, taskId) {
      const live = liveRun(runId);
      const file = live?.taskFiles.get(taskId);
      return file ? tailOf(file) ?? { output: "", total_bytes: 0 } : null;
    },
    async idle() {
      while (settling.size > 0) await Promise.all([...settling]);
    },
    close() {
      for (const live of lives.values()) stopLive(live);
    },
  };
}
