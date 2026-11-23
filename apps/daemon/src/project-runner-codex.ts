/**
 * A project session's agent when it is Codex (ADR 0099): your own Codex in the session's
 * directory, through its app-server, as in Codex's own app — your config, AGENTS.md, MCP servers
 * and skills come along, and the app adds no instructions and none of its tools. As with Claude
 * Code (`project-runner.ts`), the app keeps two things. Every command and file change waits for
 * it: the thread runs with a read-only sandbox and approval `untrusted`, as a Bot's Codex does
 * (`engine/agent/drivers/codex.ts`), and the app's permission mode answers (`decideAction`), with
 * a card under ask first. Stop ends the run and what it started. Each run is an app-server of its
 * own: the first starts a thread Codex keeps — or branches the terminal thread the session carries
 * on (`agents/codex-sessions.ts`) — and every later one resumes it, so a run is sent only your new
 * line. Codex's app-server runs no slash command, so the app carries out the few it can
 * (`agents/codex-commands.ts`): `/compact`, `/review`, `/new`, and a skill by its name. What else a
 * session has is `PROJECT_AGENT_CAPS`'s to say.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isAgentEffort, PLAN_APPROVAL_KIND, type AgentRunApproval, type AgentRunToolInfo, type AgentTask, type Message, type ToolFrame } from "@real-bot/protocol";
import daemonPackage from "../package.json";
import { askSkills, codexBuiltinOf, type CodexBuiltin, type CodexSkill } from "./agents/codex-commands";
import { estimateAgentCost } from "./agents/agent-prices";
import { agentAnnotations, type AnnotationCropBytes } from "./annotation-context";
import { resolveAgent, type ResolvedAgent } from "./agents/runtime";
import { placeOfCall } from "./claude-code/tool-place";
import { claudeLaunch, killsTree } from "./claude-code/spawn";
import { classifyCodexError } from "./engine/agent/drivers/codex";
import { LIMIT_GUESS_MS, resetMs, RESUME_MARGIN_MS } from "./engine/agent/account-switch";
import { lineTime, pickUpDetail } from "./prompts/transcript-copy";
import { continueNote, outOfUsageLine, switchedLine } from "./project-limits";
import { tildeDir } from "./claude-code/account";
import { withCodexAppServer } from "./agents/codex-app-server";
import { historyOf, rebuildThread } from "./agents/codex-history";
import { readThread } from "./agents/codex-sessions";
import { rpcPeer, type RpcPeer } from "./engine/agent/jsonrpc";
import { absoluteFrom, decideAction, unwrapShell, type AppAction } from "./engine/agent/policy";
import { agentTrace } from "./engine/agent/trace";
import { HttpError } from "./errors";
import { recordLiveProc } from "./live-procs";
import { pictureMime } from "./loop-pictures";
import { changeVerdict } from "./permission-gate";
import { questionDesk, type AgentQuestion, type QuestionDesk } from "./project-asks";
import { clip, COMPACTING, firstLine, slashCommandOf, targetText, type ProjectRunner } from "./project-runner";
import { CONSULT_CODEX_TIMEOUT_S, CONSULT_SERVER, type ConsultDesk } from "./project-consult";
import type { Store } from "./store";

export type CodexProjectDeps = {
  store: Store;
  /** The consult tool each run of a session of yours gets (ADR 0116). */
  consult?: ConsultDesk;
  /** The Codex a run starts, found as a Bot's is; a test brings its stand-in. */
  resolve?: (configDir: string | null) => Promise<ResolvedAgent>;
  /** Each call starting and ending, with where it works, for the task map (ADR 0095): never stored. */
  onTool?: (frame: ToolFrame) => void;
};

/** One of your lines as Codex's `turn/start` takes it: pictures by their path, then your words, and a skill you named. */
type CodexInput = { type: "text"; text: string; text_elements: [] } | { type: "localImage"; path: string } | { type: "skill"; name: string; path: string };
type Item = Record<string, unknown> & { id: string; type: string };
type TurnEnd = { status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null };

/** A line Codex has not been sent yet: what it says, and the command it starts with (`/compact`, a skill's `/pdf:pdf`), if any. */
type Queued = { input: CodexInput[]; command: { name: string; rest: string } | null; messageIds: string[] };

type Live = {
  runId: string;
  sessionId: string;
  /** Your lines Codex has not been sent yet, oldest first: the next turn takes the words up to a command, a command goes on its own. */
  queue: Queued[];
  /** Lines being added to the turn going now (`turn/steer`); one Codex turns down joins the queue. */
  steering: Set<Promise<void>>;
  /** The approvals waiting on you, oldest first: the first is the card; answering it brings the next. */
  waiting: Array<{ approval: AgentRunApproval; resolve: (allow: boolean) => void }>;
  /**
   * What it has said in the turn going now, whole, its answer so far included: the working bubble
   * shows the start of its words beside the work, and a turn cut short before its end keeps it all as its line.
   */
  said: string;
  stopped: boolean;
  /** Nothing more to send (everything answered, or stopped): a new line waits for the next run. */
  closing: boolean;
  done: Promise<void>;
  abort: AbortController;
  rpc: RpcPeer | null;
  threadId: string | null;
  /** The turn going now; null between turns. */
  turnId: string | null;
  /** Your lines the turn going now carries: one its plan's limit turned away is still unanswered (ADR 0110). */
  inTurn: string[];
  /** Its subagents and the commands it left running in the background, by id (ADR 0095, 25). */
  tasks: Map<string, AgentTask>;
  /** What each background command has printed so far. */
  outputs: Map<string, string>;
  /** Its turn is over and only its background commands keep the run open. */
  idle: boolean;
  /** Wakes the run waiting on its background commands: a new line, or a command's end. */
  wake: (() => void) | null;
  /** What Codex asks you (`request_user_input`, plan mode): question cards it waits on. */
  questions: QuestionDesk;
};

const INIT_TIMEOUT_MS = 60_000;
const STEER_TIMEOUT_MS = 10_000;
const INTERRUPT_TIMEOUT_MS = 3_000;
const STDERR_KEEP = 8 * 1024;
const ACTIVITY_MAX = 160;
const PARTIAL_MAX = 4000;
/** The words a plan's approval goes on with: Codex takes the next turn in its default mode. */
const PLAN_GO = { en: "The plan is approved. Implement it now.", zh: "计划已批准，现在按计划去做。" };

/**
 * Where an annotation's crop goes for Codex, which takes a picture by its path only: written out
 * under the system's temporary folder, one file per annotation. Null when it cannot be written.
 */
function cropFile(crop: AnnotationCropBytes): string | null {
  try {
    const dir = join(tmpdir(), "deskfolk-annotation-crops");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${crop.id}.${crop.mime === "image/png" ? "png" : "jpg"}`);
    writeFileSync(path, crop.bytes);
    return path;
  } catch {
    return null;
  }
}

/**
 * Your line as Codex reads it: its pictures by their path on this computer (Codex opens them
 * itself, as a picture pasted into it), then your words, with any other file named by its path —
 * the app keeps what you send in its inbox, not in the session's directory. A batch of annotations
 * (ADR 0095 decision 28) adds each one after your words and its crop among the pictures.
 */
function lineInput(store: Store, message: Message, en: boolean): CodexInput[] {
  const notes = agentAnnotations(store, message.id, en ? "en" : "zh");
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
  for (const crop of notes?.crops ?? []) {
    const path = cropFile(crop);
    if (path) pictures.push({ type: "localImage", path });
  }
  const text = [message.body.trim() ? message.body : "", ...named, notes?.text ?? ""].filter(Boolean).join("\n\n");
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

/** What the next turn takes: a command on its own, or else every line of words up to the next command, at once. */
function takeNext(queue: Queued[]): Queued | null {
  const first = queue[0];
  if (!first) return null;
  if (first.command) return queue.shift()!;
  const command = queue.findIndex((line) => line.command);
  const words = queue.splice(0, command === -1 ? queue.length : command);
  return { input: words.flatMap((line) => line.input), command: null, messageIds: words.flatMap((line) => line.messageIds) };
}

/** The line with its leading `/name` written as `word` instead: `$name` for a skill, as Codex's own `$` writes it. */
function withCommandWord(input: CodexInput[], name: string, word: string): CodexInput[] {
  const head = new RegExp(`^(\\s*)/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)\\s*`);
  return input.flatMap((part) => {
    if (part.type !== "text" || !head.test(part.text)) return [part];
    const text = part.text.replace(head, (_, lead: string) => (word ? `${lead}${word} ` : lead)).trimEnd();
    return text.trim() ? [{ ...part, text }] : [];
  });
}

/** The card `/review` waits on under ask first: Codex runs a review's commands itself, so it is asked once, before it starts. */
const REVIEW_APPROVAL_KIND = "codex-review";

/** The app's line for a command that answered nothing, by the name you typed it with. */
function commandRan(command: CodexBuiltin, typed: string, en: boolean): string {
  if (command === "new") return en ? `Ran /${typed}: Codex starts a new conversation with an empty context; the lines here stay` : `已执行 /${typed}：Codex 开了一个新会话，从空的上下文重新开始，这里的记录还在`;
  if (command === "compact") return en ? "Ran /compact: Codex keeps a summary of the conversation so far" : "已执行 /compact：Codex 把之前的对话压成了摘要";
  return en ? `Ran /${typed}` : `已执行 /${typed}`;
}

/**
 * The Codex a project session starts, found as a Bot's is — the path you set in Settings, or the
 * one on this computer — on one of your Codex accounts (`CODEX_HOME`; null: the daemon's own).
 */
export function projectCodexOf(store: Store): (configDir?: string | null) => Promise<ResolvedAgent> {
  return (configDir = null) => resolveAgent({ runner: "codex", custom: null, setting: store.agentPath("codex"), configDir });
}

/** The Codex home an account runs in: its own directory, or the daemon's (`CODEX_HOME`, else the one under your home folder). */
export function codexHome(configDir: string | null): string {
  return configDir ?? (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
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
  const resolve = deps.resolve ?? projectCodexOf(store);
  /** Sessions whose thread was last told plan mode, with the thinking level it had before (to go back to it). */
  const planned = new Map<string, string | null>();

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
    if (!store.projectOf(sessionId)) return;
    const command = slashCommandOf(message.body);
    // Codex waits on its questions: your words are the answer to each (a command still goes as one).
    const live = lives.get(sessionId);
    if (!command && live && !live.stopped && live.questions.takeLine(message)) return;
    // A command names nothing: the session takes its name from the first thing you ask.
    if (!command) store.nameProjectSessionIfUnnamed(sessionId, message.body);
    startRun(sessionId, () => ({
      input: lineInput(store, message, locale() === "en"),
      messageIds: [message.id],
      command: command ? { name: command, rest: message.body.trim().slice(command.length + 1).trim() } : null,
    }));
  }

  /** Into the session's live run, or the start of a new one: your line, or what the app says to go on after a limit (ADR 0110). */
  function startRun(sessionId: string, lineOf: () => Queued): void {
    if (!store.projectOf(sessionId)) return;
    const live = lives.get(sessionId);
    if (live && (live.stopped || live.closing)) {
      // Winding down: the line opens the next run once this one is gone.
      void live.done.then(() => startRun(sessionId, lineOf));
      return;
    }
    const line = lineOf();
    if (live) {
      // A plan waiting on you is not approved by what you say next: it is what to change.
      if (live.waiting[0]?.approval.kind_key === PLAN_APPROVAL_KIND) live.waiting.shift()!.resolve(false);
      // A turn going now takes words at its next step, as Codex's own steer does. A command, and
      // anything sent after one still waiting, waits for the turn's end: it is a turn of its own.
      if (!line.command && live.queue.length === 0 && live.rpc && live.threadId && live.turnId) steer(live, live.rpc, live.threadId, live.turnId, line.input, line.messageIds);
      else live.queue.push(line);
      live.wake?.();
      return;
    }
    const run = store.createAgentRun(sessionId);
    let finish!: () => void;
    const fresh: Live = {
      runId: run.id, sessionId, queue: [line], steering: new Set(), waiting: [], said: "", stopped: false, closing: false,
      done: new Promise<void>((resolve) => { finish = resolve; }), abort: new AbortController(), rpc: null, threadId: null, turnId: null, inTurn: [], tasks: new Map(), outputs: new Map(), idle: false, wake: null,
      questions: questionDesk(store, sessionId, (open) => {
        if (!fresh.stopped) update(run.id, { asks: open, status: open.length > 0 || fresh.waiting.length > 0 ? "waiting_approval" : "running" });
      }),
    };
    lives.set(sessionId, fresh);
    const running = runSession(fresh).catch((error) => {
      console.error(`[project ${sessionId}] Codex run failed`, error);
      if (!fresh.stopped) fail(fresh, firstLine(String(error)) ?? "error");
    }).finally(() => {
      fresh.closing = true;
      fresh.questions.close();
      fresh.abort.abort();
      if (lives.get(sessionId) === fresh) lives.delete(sessionId);
      finish();
    });
    settling.add(running);
    void running.finally(() => settling.delete(running));
  }

  function steer(live: Live, rpc: RpcPeer, threadId: string, turnId: string, input: CodexInput[], ids: string[]): void {
    const going = rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input }, STEER_TIMEOUT_MS).then(
      () => {
        live.inTurn.push(...ids);
      },
      // The turn ended first: the line starts the next one, ahead of a command sent after it.
      () => {
        const command = live.queue.findIndex((line) => line.command);
        live.queue.splice(command === -1 ? live.queue.length : command, 0, { input, command: null, messageIds: ids });
      },
    );
    live.steering.add(going);
    void going.finally(() => live.steering.delete(going));
  }

  function setIdle(live: Live, idle: boolean): void {
    if (live.idle === idle) return;
    live.idle = idle;
    update(live.runId, { idle });
  }

  /** What it said in a turn that ends before its end (Stop, a failure, the daemon going down) stays on the record, as the bubble showed it. */
  function keepSaid(live: Live): void {
    const said = live.said.trim();
    live.said = "";
    if (!said) return;
    try {
      postLine(live.sessionId, "bot", said);
    } catch (error) {
      // The run still has to end: a session gone meanwhile has nowhere to keep it.
      console.error(`[project ${live.sessionId}] could not keep what Codex said`, error);
    }
  }

  function fail(live: Live, detail: string): void {
    const run = store.getAgentRun(live.runId);
    if (!["running", "waiting_approval"].includes(run.status)) return;
    keepSaid(live);
    update(live.runId, { status: "failed", activity: null, partial: null, approval: null, error: detail });
    postLine(live.sessionId, "system", locale() === "en" ? `Codex stopped: ${detail}` : `Codex 出错停下了：${detail}`);
  }

  async function runSession(live: Live): Promise<void> {
    const en = locale() === "en";
    const project = store.projectOf(live.sessionId);
    if (!project) return;
    const resolved = await resolve(project.configDir);
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

    const permission = store.projectPermissionMode(live.sessionId);
    const configDirs = store.allAgentConfigDirs();
    /**
     * Codex's own folders it works with (ADR 0099 addendum 2026-11-17): the memories it writes itself,
     * the skills and plugins it reads by command. As any folder outside, by the permission mode; its
     * sign-in beside them stays shut.
     */
    const ownDirs = ["memories", "skills", "plugins"].map((name) => join(codexHome(project.configDir), name));
    const home = homedir();
    const items = new Map<string, Item>();
    /** The calls under way, by item id: when each started and what it was, for its exited frame. */
    const started = new Map<string, { at: number; name: string; info: AgentRunToolInfo; command?: string; target?: string; mcp?: { server: string; tool: string } }>();
    let model: string | null = project.model;
    let partial = "";
    const said = (text: string) => {
      if (text.trim()) live.said = live.said ? `${live.said}\n\n${text}` : text;
    };
    let finalText = "";
    let lastText = "";
    /** What a review found, as Codex closes it (`exitedReviewMode`): the reply to `/review`. */
    let reviewText: string | null = null;
    /** The plan a plan-mode turn closed with (an item of its own, `plan`): a card for you. */
    let planText: string | null = null;
    /** The thinking level the thread runs at, as Codex last said it (the answer opening it, then its settings updates). */
    let threadEffort: string | null = null;
    /** Each subagent thread's model and what it said last, by thread id. */
    const subagents = new Map<string, { model: string | null; last: string | null }>();
    let failure: string | null = null;
    /** Its plan's limit stopped the turn (ADR 0110), and when it resets, when Codex said. */
    let limitHit = false;
    let resetsAt: number | null = null;
    let turnDone: ((turn: TurnEnd) => void) | null = null;
    /** The skills Codex loads here, asked the first time a line names one. */
    let skills: CodexSkill[] | null = null;
    /** The turns this run started, a subagent's included: only their usage is this run's. */
    const ours = new Set<string>();
    /** Per thread, the usage update last billed: the same one again bills nothing. */
    const billedUsage = new Map<string, string>();

    /** Whose call it is: Codex's own thread, or a subagent's thread of its own. */
    const agentOf = (p: Record<string, unknown>): string | null => (typeof p.threadId === "string" && live.threadId && p.threadId !== live.threadId ? p.threadId : null);

    /** A card that waits on you; any other call already asking keeps the card until it is answered. */
    const askYou = async (approval: AgentRunApproval): Promise<boolean> => {
      const allow = await new Promise<boolean>((resolve) => {
        live.waiting.push({ approval, resolve });
        if (live.waiting.length === 1) update(live.runId, { status: "waiting_approval", approval });
      });
      if (live.stopped) return false;
      // The next call still asking is the card now; with none, the run is at work again, or waits on its questions.
      const next = live.waiting[0];
      update(live.runId, next ? { status: "waiting_approval", approval: next.approval } : { status: live.questions.open().length > 0 ? "waiting_approval" : "running", approval: null });
      return allow;
    };

    /** The app's rules for one command or file change: allowed, refused, or a card that waits on you. */
    const gate = async (action: AppAction): Promise<boolean> => {
      if (live.stopped) return false;
      const decision = decideAction(action, { mode: "work", workspace: project.dir, configDirs, permission, openDirs: ownDirs });
      if (decision.kind === "deny") return false;
      if (decision.kind === "allow") return true;
      return askYou(decision.approval);
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
        // Its questions for you (plan mode): a card each, and Codex waits for every answer. A refusal
        // here would reach it as `{"answers":{}}` — no answers, as if you had been shown nothing.
        case "item/tool/requestUserInput":
          return askedOf(p);
        default:
          throw new Error(`${method} is not supported by Deskfolk`);
      }
    });

    /**
     * Codex's questions as cards, its answers as it takes them: per question id what you picked,
     * then your words. A question it marks secret gets no card: the conversation keeps no secrets,
     * so it is told none came, and you see that it asked.
     */
    const askedOf = async (p: Record<string, unknown>): Promise<{ answers: Record<string, { answers: string[] }> }> => {
      const raw = Array.isArray(p.questions) ? (p.questions as Array<Record<string, unknown>>) : [];
      const asked: Array<{ id: string; question: AgentQuestion }> = [];
      for (const q of raw) {
        const id = typeof q.id === "string" ? q.id : "";
        const text = typeof q.question === "string" ? q.question : "";
        const header = typeof q.header === "string" ? q.header : null;
        if (!id) continue;
        if (q.isSecret === true) {
          postLine(live.sessionId, "system", en
            ? `Codex asked for something secret (${header || text}): the conversation keeps no secrets, so it was not answered here`
            : `Codex 问了一项需要保密的内容（${header || text}）：对话里不收密码和密钥，这一项没有在这里回答`);
          continue;
        }
        const options = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>).map((option) => ({ label: String(option.label ?? ""), description: typeof option.description === "string" ? option.description : null })) : [];
        asked.push({ id, question: { question: text, header, options, multiSelect: false } });
      }
      const answers = await live.questions.ask(asked.map((one) => one.question));
      const out: Record<string, { answers: string[] }> = {};
      asked.forEach((one, index) => {
        const answer = answers?.[index];
        if (answer) out[one.id] = { answers: [...answer.selected, ...(answer.custom ? [answer.custom] : [])] };
      });
      return { answers: out };
    };

    const setTask = (task: AgentTask) => {
      live.tasks.set(task.id, task);
      update(live.runId, { tasks: [...live.tasks.values()] });
    };
    const countCall = (agentId: string) => {
      const task = live.tasks.get(agentId);
      if (task) setTask({ ...task, tool_uses: (task.tool_uses ?? 0) + 1 });
    };
    /** A `spawnAgent` call: each thread it sends is a subagent task; its model is the one asked for. */
    const noteSubagents = (item: Item, completed: boolean) => {
      if (item.tool !== "spawnAgent" || !completed) return;
      const ids = Array.isArray(item.receiverThreadIds) ? (item.receiverThreadIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
      const prompt = typeof item.prompt === "string" ? item.prompt : "";
      for (const id of ids) {
        if (live.tasks.has(id)) continue;
        subagents.set(id, { model: typeof item.model === "string" && item.model ? item.model : subagents.get(id)?.model ?? null, last: null });
        setTask({
          id, tool_use_id: item.id, kind: "subagent", status: "running", description: clip(firstLine(prompt) ?? "subagent", 120), command: null, agent_type: null,
          activity: null, summary: null, tool_uses: 0, tokens: null, started_at: new Date().toISOString(), ended_at: null, output_file: null,
        });
      }
    };
    /** A background command's end: its task ends, what it printed kept where the tasks list reads it. */
    const backgroundEnded = (id: string, ok: boolean, output: string, exitCode: number | null) => {
      const task = live.tasks.get(id);
      if (!task) return;
      let outputFile: string | null = null;
      try {
        const dir = join(tmpdir(), "deskfolk-codex-tasks");
        mkdirSync(dir, { recursive: true });
        outputFile = join(dir, `${live.runId}-${id}.log`);
        writeFileSync(outputFile, output);
      } catch {
        outputFile = null;
      }
      setTask({ ...task, status: ok ? "completed" : "failed", ended_at: new Date().toISOString(), output_file: outputFile, summary: exitCode !== null ? `exit ${exitCode}` : task.summary });
      live.wake?.();
    };

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

    /**
     * One call's usage as a row of the spend ledger's `project` line (ADR 0095, 2026-10-27), from
     * `last`: `total` starts over after a compaction, and a resumed thread may first repeat a turn
     * of an earlier run's, which is not this run's to bill. Codex reports no price.
     */
    const bill = (p: Record<string, unknown>) => {
      const usage = (p.tokenUsage ?? {}) as { total?: Record<string, number>; last?: Record<string, number> };
      if (!usage.last || typeof p.turnId !== "string" || !ours.has(p.turnId)) return;
      const thread = typeof p.threadId === "string" ? p.threadId : "";
      const key = JSON.stringify([usage.total, usage.last]);
      if (billedUsage.get(thread) === key) return;
      billedUsage.set(thread, key);
      const input = usage.last.inputTokens ?? 0;
      const output = usage.last.outputTokens ?? 0;
      if (input <= 0 && output <= 0) return;
      try {
        store.insertSpend({
          kind: "turn", purpose: "project", sessionId: live.sessionId, botId: null, turnId: live.runId, providerId: "", providerName: "Codex",
          model, thinkingLevel: null, inputTokens: input, outputTokens: output, totalTokens: input + output, cachedTokens: usage.last.cachedInputTokens ?? 0,
          // Codex reports no price: an estimate from the model's public API price, when the table has it.
          reasoningTokens: usage.last.reasoningOutputTokens ?? null, costUsdTicks: null,
          estimatedCostUsdTicks: estimateAgentCost(model, { inputTokens: input, outputTokens: output, cachedTokens: usage.last.cachedInputTokens ?? 0 }), missingReason: null,
        });
      } catch (error) {
        console.error(`[project ${live.sessionId}] could not record spend`, error);
      }
    };

    rpc.onNotification((method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === "thread/tokenUsage/updated") return bill(p);
      if (method === "account/rateLimits/updated") {
        const limits = (p.rateLimits ?? {}) as { rateLimitReachedType?: unknown; primary?: { resetsAt?: number } };
        if (limits.rateLimitReachedType) resetsAt = resetMs(limits.primary?.resetsAt);
        return;
      }
      if (method === "turn/started") {
        const turn = (p.turn ?? {}) as { id?: unknown };
        if (typeof turn.id === "string") ours.add(turn.id);
      }
      // An item is noted at once, before an approval request that follows it in the same read is
      // answered: a file change's request names only the item, and its paths are in the item.
      if (method === "item/started" || method === "item/completed") {
        const item = p.item as Item | undefined;
        if (!item?.id) return;
        items.set(item.id, { ...(items.get(item.id) ?? {}), ...item });
        const agentId = agentOf(p);
        // Once stopped, what it says winding down is not on the record: what it had said is kept already.
        if (live.stopped && (item.type === "exitedReviewMode" || item.type === "agentMessage")) return;
        if (item.type === "exitedReviewMode") {
          if (method === "item/completed" && !agentId && typeof item.review === "string") {
            reviewText = item.review;
            said(item.review);
          }
          return;
        }
        if (item.type === "plan") {
          if (method === "item/completed" && !agentId && typeof item.text === "string" && item.text.trim()) planText = item.text;
          return;
        }
        // A subagent it sends (`spawnAgent`): a task on the run, under its own thread.
        if (item.type === "collabAgentToolCall") {
          noteSubagents(item, method === "item/completed");
          return;
        }
        if (item.type === "agentMessage" && agentId) {
          const sub = subagents.get(agentId);
          if (sub && method === "item/completed" && typeof item.text === "string" && item.text.trim()) sub.last = item.text.trim();
          return;
        }
        if (item.type === "agentMessage") {
          if (method !== "item/completed" || agentId) return;
          const text = typeof item.text === "string" ? item.text : "";
          lastText = text;
          // Its final answer is the reply; words beside its work are what it has said so far. A
          // review's findings come once more as a message of their own: they are the reply already.
          if (item.phase === "final_answer") {
            finalText = text;
            said(text);
          } else if (reviewText !== null && text.trim() === reviewText.trim()) return;
          else if (text.trim()) {
            partial = clip(partial ? `${partial}\n\n${text}` : text, PARTIAL_MAX);
            update(live.runId, { partial });
            said(text);
          }
          return;
        }
        const call = callOf(item, project.dir);
        if (!call) return;
        if (method === "item/started" && !started.has(item.id)) {
          const { place, action } = placeOfCall(call.place.tool, call.place.input, { projectDir: project.dir, cwd: typeof item.cwd === "string" && item.cwd ? item.cwd : project.dir, home, configDirs });
          // A subagent's call is made by its own model.
          const info: AgentRunToolInfo = { session_id: live.sessionId, agent_id: agentId, place, ...(action ? { action } : {}), model: (agentId ? subagents.get(agentId)?.model : null) ?? model, at: new Date().toISOString() };
          if (agentId) countCall(agentId);
          started.set(item.id, { at: Date.now(), name: call.name, info, ...(call.command ? { command: call.command } : {}), ...(call.target ? { target: call.target } : {}), ...(call.mcp ? { mcp: call.mcp } : {}) });
          if (!agentId) update(live.runId, { activity: clip(call.activity, ACTIVITY_MAX) });
          deps.onTool?.({ type: "tool", turn_id: live.runId, id: item.id, name: call.name, phase: "started",
            ...(call.command ? { command: call.command, target: call.command } : { target: call.target ?? targetText(place) }),
            ...(call.mcp ? { mcp_server: call.mcp.server, mcp_tool: call.mcp.tool } : {}), agent_run: info });
        } else if (method === "item/completed") {
          const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
          const ok = item.status === "completed" && (exitCode === null || exitCode === 0);
          // A command it left running past its turn: its end ends its task.
          if (live.tasks.get(item.id)?.status === "running") backgroundEnded(item.id, ok, typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : live.outputs.get(item.id) ?? "", exitCode);
          ended(item.id, ok, exitCode);
        }
        return;
      }
      if (method === "item/commandExecution/outputDelta" && typeof p.itemId === "string" && typeof p.delta === "string" && live.tasks.has(p.itemId)) {
        live.outputs.set(p.itemId, `${live.outputs.get(p.itemId) ?? ""}${p.delta}`.slice(-64_000));
        return;
      }
      if (method === "thread/settings/updated" && !agentOf(p)) {
        const settings = (p.threadSettings ?? {}) as { effort?: string | null; collaborationMode?: { mode?: string } };
        if (settings.collaborationMode?.mode !== "plan") threadEffort = settings.effort ?? threadEffort;
        return;
      }
      if (method === "thread/started") {
        // A subagent's thread says its model and the name Codex gave it.
        const thread = (p.thread ?? {}) as { id?: string; model?: string | null; agentNickname?: string | null; parentThreadId?: string | null };
        if (typeof thread.id === "string" && thread.parentThreadId) {
          const sub = subagents.get(thread.id) ?? { model: null, last: null };
          sub.model = thread.model ?? sub.model;
          subagents.set(thread.id, sub);
          const task = live.tasks.get(thread.id);
          if (task && thread.agentNickname) setTask({ ...task, agent_type: thread.agentNickname });
        }
        return;
      }
      if (method === "turn/completed" && agentOf(p)) {
        // A subagent's turn over: its task ends with what it said last.
        const agentId = agentOf(p)!;
        const task = live.tasks.get(agentId);
        const turnEnd = (p.turn ?? {}) as TurnEnd;
        if (task?.status === "running") setTask({ ...task, status: turnEnd.status === "completed" ? "completed" : "failed", ended_at: new Date().toISOString(), summary: subagents.get(agentId)?.last ?? task.summary });
        return;
      }
      if (method === "error") {
        const error = (p.error ?? {}) as { message?: string; codexErrorInfo?: unknown };
        if (p.willRetry !== true && !agentOf(p)) {
          failure = codexFailure(error);
          if (classifyCodexError(error).failKind === "agent_limit") limitHit = true;
        }
        return;
      }
      // A compaction's turn is named only here: Stop needs it to interrupt.
      if (method === "turn/started" && !agentOf(p)) {
        const turn = (p.turn ?? {}) as { id?: unknown };
        if (turnDone && !live.turnId && typeof turn.id === "string") live.turnId = turn.id;
        return;
      }
      if (method === "turn/completed" && !agentOf(p)) {
        const turn = (p.turn ?? {}) as TurnEnd & { id?: string };
        if (live.turnId && turn.id && turn.id !== live.turnId) return;
        live.turnId = null;
        turnDone?.(turn);
      }
    });

    // A session of yours gets the `consult` tool (ADR 0116); a consultant's own run gets none.
    const consultant = project.parentId !== null;
    const mount = consultant ? null : (deps.consult?.mount(live.sessionId, live.runId) ?? null);
    /** A consultant's thread switches your own MCP servers off by name; filled in once Codex is signed in. */
    const mcpOff: Record<string, { enabled: false }> = {};

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
      // The session's model as it is now: `/new` opens its thread with the one picked by then.
      // A consultant only looks (ADR 0116): never asks, and the OS sandbox keeps it read-only.
      // The `consult` server rides in the thread's config override, which start, resume and fork all take
      // (dynamic tools exist on `thread/start` only) and which Codex does not save into the thread.
      if (consultant) {
        // Your own MCP servers, as a Bot's thread switches them off (`engine/agent/drivers/codex.ts`).
        const servers = await rpc.request<{ data?: Array<{ name?: string; pluginId?: string | null }> }>("mcpServerStatus/list", {}, INIT_TIMEOUT_MS).catch(() => ({ data: [] }));
        for (const server of servers.data ?? []) if (typeof server.name === "string" && !server.pluginId) mcpOff[server.name] = { enabled: false };
      }
      const asks = () => {
        const now = store.projectOf(live.sessionId) ?? project;
        const shim = mount?.stdio();
        const servers = shim
          ? { [CONSULT_SERVER]: { command: shim.command, args: shim.args, env: shim.env, tool_timeout_sec: CONSULT_CODEX_TIMEOUT_S, startup_timeout_sec: 60 } }
          : Object.keys(mcpOff).length > 0 ? mcpOff : null;
        // Under `never` nothing else holds an MCP call, and those run outside the sandbox: a consultant's
        // thread also has the servers plugins bring and your apps switched off, as a Bot's has.
        const isolation = consultant ? { features: { plugins: false, apps: false } } : {};
        const config = { ...isolation, ...(servers ? { mcp_servers: servers } : {}) };
        return {
          cwd: project.dir,
          approvalPolicy: consultant ? "never" : "untrusted",
          sandbox: "read-only",
          ...(now.model ? { model: now.model } : {}),
          ...(Object.keys(config).length > 0 ? { config } : {}),
        };
      };
      /** A request that carries `asks()`; a server name Codex cannot take an override for is dropped from the consultant's list and asked again. */
      const open = async <T>(method: string, params: () => Record<string, unknown>): Promise<T> => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await rpc.request<T>(method, params(), INIT_TIMEOUT_MS);
          } catch (error) {
            const named = /in `mcp_servers\.([^`]+)`/.exec(error instanceof Error ? error.message : "")?.[1];
            if (!named || !(named in mcpOff) || attempt >= 8) throw error;
            delete mcpOff[named];
          }
        }
      };
      /** The thread a turn goes on: the one open, or else a new one Codex keeps, recorded so every later run resumes it. */
      const thread = async (): Promise<string> => {
        if (live.threadId) return live.threadId;
        const opened = await open<{ thread?: { id?: string }; model?: string; reasoningEffort?: string | null }>("thread/start", () => ({ ...asks(), ephemeral: false, serviceName: "deskfolk" }));
        threadEffort = opened?.reasoningEffort ?? threadEffort;
        const id = opened?.thread?.id;
        if (!id) throw new Error(en ? "Codex opened no thread" : "Codex 没有开出会话");
        live.threadId = id;
        store.recordProjectAgentSession(live.sessionId, id);
        model = opened?.model ?? model;
        return id;
      };
      /**
       * A branch of the terminal thread the session carries on (ADR 0099 addendum 2026-11-17), as
       * Claude Code's first run branches its session: yours stays as it was, this one goes on.
       */
      const fork = async (source: string): Promise<void> => {
        const opened = await open<{ thread?: { id?: string }; model?: string }>("thread/fork", () => ({ threadId: source, ...asks() }));
        const id = opened?.thread?.id;
        if (!id) throw new Error(en ? "Codex could not branch the thread" : "Codex 没能从那个会话分出来");
        live.threadId = id;
        store.recordProjectAgentSession(live.sessionId, id);
        model = opened?.model ?? model;
      };
      /**
       * The session's thread from another of your Codex accounts (ADR 0099 addendum 2026-11-17):
       * each keeps its own threads, so the conversation is read there and opened here anew from its
       * history (`agents/codex-history.ts`); what was said comes along, earlier tool calls do not.
       */
      const carry = async (threadId: string): Promise<boolean> => {
        for (const home of [null, ...store.agentConfigDirs("codex")]) {
          if (home === project.configDir) continue;
          const other = await resolve(home).catch(() => null);
          if (!other?.ok) continue;
          const thread = await withCodexAppServer(other, project.dir, (peer) => readThread(peer, threadId)).catch(() => null);
          if (!thread) continue;
          const rebuilt = await rebuildThread(rpc, historyOf(thread), asks(), INIT_TIMEOUT_MS);
          if (!rebuilt) return false;
          live.threadId = rebuilt.id;
          store.recordProjectAgentSession(live.sessionId, rebuilt.id);
          model = rebuilt.model ?? model;
          postLine(live.sessionId, "system", en
            ? "The conversation came over from your other Codex account: everything said is here; earlier tool calls did not come along"
            : "这段对话从你的另一个 Codex 账号接了过来：说过的话都在，之前的工具调用没有带过来");
          return true;
        }
        return false;
      };
      // The first run starts a thread Codex keeps, or branches the one carried on; every later one resumes its own.
      if (project.agentSession) {
        try {
          const opened = await open<{ thread?: { id?: string }; model?: string; reasoningEffort?: string | null }>("thread/resume", () => ({ threadId: project.agentSession, ...asks(), excludeTurns: true }));
          threadEffort = opened?.reasoningEffort ?? threadEffort;
          live.threadId = opened?.thread?.id ?? project.agentSession;
          model = opened?.model ?? model;
        } catch (error) {
          if (!/no rollout found/i.test(error instanceof Error ? error.message : String(error))) throw error;
          // Moved to another of your accounts since, which does not keep it: carried over from the one that does.
          if (!(await carry(project.agentSession))) {
            // A branch whose first turn never ran was never kept: branch the terminal thread again.
            if (!project.source) throw error;
            await fork(project.source);
          }
        }
      } else if (project.source) await fork(project.source);
      else await thread();

      /**
       * One turn of Codex's: `start` asks for it and gives its id when the answer names one (a
       * compaction's comes with `turn/started`), then the turn is waited out and its reply posted,
       * or `ran` when it said nothing. False when the run ends here: stopped, Codex gone, or the
       * turn failed.
       */
      const turn = async (start: () => Promise<string | null | undefined>, ran?: string): Promise<boolean> => {
        finalText = "";
        lastText = "";
        reviewText = null;
        planText = null;
        const finished = new Promise<TurnEnd>((resolve) => { turnDone = resolve; });
        try {
          const id = await start();
          if (id) {
            live.turnId = id;
            ours.add(id);
          }
        } catch (error) {
          turnDone = null;
          throw error;
        }
        const end = await Promise.race([finished, exited.then((): TurnEnd => ({ status: "exited" }))]);
        turnDone = null;
        live.turnId = null;
        if (live.stopped) return false;
        if (end.status === "exited") {
          failure ??= firstLine(stderr.split("\n").filter(Boolean).at(-1) ?? "") ?? (en ? "Codex exited" : "Codex 退出了");
          return false;
        }
        if (end.status !== "completed") {
          failure ??= end.error ? codexFailure(end.error) : end.status ?? "error";
          if (end.error && classifyCodexError(end.error).failKind === "agent_limit") limitHit = true;
          return false;
        }
        // Commands it left running past its turn are tasks the run stays open for (ADR 0095, 25).
        for (const [id, call] of started) {
          if (call.command === undefined || call.info.agent_id || live.tasks.has(id)) continue;
          setTask({
            id, tool_use_id: id, kind: "shell", status: "running", description: clip(call.command, 120), command: clip(call.command, 300), agent_type: null,
            activity: null, summary: null, tool_uses: null, tokens: null, started_at: new Date(call.at).toISOString(), ended_at: null, output_file: null,
          });
        }
        // A plan closes a plan-mode turn: its words beside the work are not the reply, the plan is.
        const plan = (planText as string | null)?.trim() || null;
        const reply = (reviewText ?? (finalText || (plan ? "" : lastText))).trim();
        if (reply) postLine(live.sessionId, "bot", reply);
        else if (ran) postLine(live.sessionId, "system", ran);
        partial = "";
        live.said = "";
        update(live.runId, { partial: null, activity: null });
        if (plan) {
          // The same card as Claude Code's plan: approved, plan mode goes off and Codex carries it out.
          const approved = await askYou({ kind_key: PLAN_APPROVAL_KIND, target: project.dir, summary: plan });
          if (live.stopped) return false;
          if (approved) {
            store.tuneProjectSession(live.sessionId, { mode: null });
            live.queue.unshift({ input: [{ type: "text", text: PLAN_GO[en ? "en" : "zh"], text_elements: [] }], command: null, messageIds: [] });
          }
        }
        return true;
      };

      /** A turn on your words, with the session's model and level as they are now: a change reaches the next turn. */
      const words = (input: CodexInput[]) => turn(async () => {
        const now = store.projectOf(live.sessionId) ?? project;
        const threadId = await thread();
        // Plan mode is Codex's collaboration mode, which the thread keeps once said, effort and all
        // (measured: default with no effort clears your config's level). So it is said while plan
        // mode is on, and default once after, with the level the thread had before it planned.
        const settingsModel = now.model ?? model;
        const ownEffort = now.effort && isAgentEffort("codex", now.effort) ? now.effort : null;
        let collaborationMode: Record<string, unknown> | null = null;
        if (settingsModel && now.mode === "plan") {
          if (!planned.has(live.sessionId)) planned.set(live.sessionId, threadEffort);
          collaborationMode = { mode: "plan", settings: { model: settingsModel, reasoning_effort: ownEffort ?? "medium", developer_instructions: null } };
        } else if (settingsModel && planned.has(live.sessionId)) {
          collaborationMode = { mode: "default", settings: { model: settingsModel, reasoning_effort: ownEffort ?? planned.get(live.sessionId) ?? null, developer_instructions: null } };
          planned.delete(live.sessionId);
        }
        const started = await rpc.request<{ turn?: { id?: string } }>("turn/start", {
          threadId, input,
          ...(now.model ? { model: now.model } : {}),
          ...(now.effort && isAgentEffort("codex", now.effort) ? { effort: now.effort } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
        }, INIT_TIMEOUT_MS);
        if (now.model) model = now.model;
        return started?.turn?.id;
      });

      /** What a review looks at: what you wrote after `/review`, or else the changes not yet committed. */
      const review = async (rest: string, typed: string): Promise<boolean> => {
        const verdict = changeVerdict(permission);
        // Codex runs a review's commands itself, asking nobody (in its read-only sandbox): the app's mode decides once, before it starts.
        if (verdict === "refuse") {
          postLine(live.sessionId, "system", en ? `/${typed} is not available under read-only: Codex runs a review's commands itself, without the app's say` : `只读模式下不能用 /${typed}：审查时 Codex 自己跑命令，不经过应用`);
          return true;
        }
        const what = rest || (en ? "the uncommitted changes" : "未提交的改动");
        const note = en ? "While it reviews, Codex runs its own commands in a read-only sandbox, without asking for each" : "审查时 Codex 自己跑只看不改的命令（只读沙盒），不再逐条问你";
        if (verdict === "ask" && !(await askYou({ kind_key: REVIEW_APPROVAL_KIND, target: project.dir, summary: `review ${what}\n${note}` }))) {
          if (!live.stopped) postLine(live.sessionId, "system", en ? `Did not run /${typed}: you said no` : `没有执行 /${typed}：你拒绝了`);
          return !live.stopped;
        }
        const target = rest ? { type: "custom", instructions: rest } : { type: "uncommittedChanges" };
        return turn(async () => (await rpc.request<{ turn?: { id?: string } }>("review/start", { threadId: await thread(), target, delivery: "inline" }, INIT_TIMEOUT_MS))?.turn?.id);
      };

      /** A line that starts with a command: Codex's own the app carries out, a skill by its name, or else your words as you wrote them. */
      const command = async (line: Queued & { command: NonNullable<Queued["command"]> }): Promise<boolean> => {
        const { name, rest } = line.command;
        const builtin = codexBuiltinOf(name);
        try {
          if (builtin === "compact") {
            update(live.runId, { activity: COMPACTING[en ? "en" : "zh"] });
            return await turn(async () => {
              await rpc.request("thread/compact/start", { threadId: await thread() }, INIT_TIMEOUT_MS);
              return null;
            }, commandRan("compact", name, en));
          }
          if (builtin === "review") return await review(rest, name);
          if (builtin === "new") {
            // A new thread from the next turn on, not before: Codex keeps a thread only once it has
            // had a turn, so one opened now and left unused could not be resumed. What you wrote
            // after it is that thread's first line.
            live.threadId = null;
            // A new thread, not another branch of the terminal thread the session carried on.
            store.recordProjectAgentSession(live.sessionId, null, true);
            postLine(live.sessionId, "system", commandRan("new", name, en));
            const after = withCommandWord(line.input, name, "");
            if (after.length > 0) live.queue.unshift({ input: after, command: null, messageIds: line.messageIds });
            return true;
          }
        } catch (error) {
          if (rpc.closed || live.stopped) throw error;
          // Codex said no to the command itself: the session says so and goes on.
          update(live.runId, { activity: null });
          postLine(live.sessionId, "system", en ? `Codex could not run /${name}: ${firstLine(error instanceof Error ? error.message : String(error)) ?? "error"}` : `Codex 没能执行 /${name}：${firstLine(error instanceof Error ? error.message : String(error)) ?? "error"}`);
          return true;
        }
        skills ??= await askSkills(rpc, project.dir).catch(() => []);
        const skill = skills.find((one) => one.name === name);
        // A skill goes as Codex's own `$` sends one: its name in your words, and the skill itself.
        if (skill) return words([...withCommandWord(line.input, name, `$${name}`), { type: "skill", name: skill.name, path: skill.path }]);
        return words(line.input);
      };

      while (!live.stopped) {
        // Lines being added to the turn that just ended either made it in or wait in the queue now.
        while (live.steering.size > 0) await Promise.all([...live.steering]);
        const next = takeNext(live.queue);
        if (live.stopped) break;
        if (!next || next.input.length === 0) {
          // Only its background commands keep it open: a line you send is answered at once.
          if (![...live.tasks.values()].some((task) => task.status === "running" && task.kind === "shell")) break;
          setIdle(live, true);
          await new Promise<void>((resolve) => {
            live.wake = resolve;
            if (live.queue.length > 0 || ![...live.tasks.values()].some((task) => task.status === "running" && task.kind === "shell")) resolve();
          });
          live.wake = null;
          setIdle(live, false);
          continue;
        }
        live.inTurn = next.messageIds;
        const going = next.command ? await command({ ...next, command: next.command }) : await words(next.input);
        if (going) live.inTurn = [];
        if (!going) break;
      }
    } catch (error) {
      if (!live.stopped) failure ??= firstLine(error instanceof Error ? error.message : String(error)) ?? firstLine(stderr.split("\n").filter(Boolean).at(-1) ?? "") ?? "error";
    } finally {
      mount?.close();
      // A call cut by Stop or a crash never reports its end: it ends with the run.
      for (const id of [...started.keys()]) ended(id, false);
      live.closing = true;
      rpc.close();
      live.abort.abort();
    }
    if (live.stopped) return;
    if (failure && limitHit) return outOfUsage(live, project.configDir, failure, resetsAt);
    if (failure) return fail(live, failure);
    update(live.runId, { status: "completed", activity: null, partial: null, approval: null });
  }

  /** An account by the name a line gives it. */
  function accountName(dir: string | null, en: boolean): string {
    return dir ? tildeDir(dir) : en ? "the default account" : "默认账号";
  }

  /**
   * The run's turn was turned away by its account's plan limit (ADR 0110): the account is noted out;
   * with another of your Codex accounts not out, the session moves there and goes on, told what was
   * left unanswered; with none, and a reset Codex said, the line says when it picks up, and it does
   * then. With neither, it stops as any failure does.
   */
  function outOfUsage(live: Live, from: string | null, detail: string, resetsAt: number | null): void {
    const en = locale() === "en";
    const known = resetsAt !== null && resetsAt > Date.now();
    store.markAccountOut({ runner: "codex", dir: codexHome(from), email: null, until: known ? resetsAt! : Date.now() + LIMIT_GUESS_MS, known });
    // A consultant's run only fails: the session that asked decides what to do (ADR 0116).
    if (store.projectOf(live.sessionId)?.parentId) return fail(live, detail);
    const unanswered = [...live.inTurn, ...live.queue.flatMap((line) => line.messageIds)];
    const outs = new Set(store.accountsOut().filter((row) => row.runner === "codex").map((row) => row.dir));
    const next = [null, ...store.agentConfigDirs("codex")].find((dir) => dir !== from && !outs.has(codexHome(dir)));
    const reset = known ? (en ? `resets ${lineTime(resetsAt!, "en")}` : `${lineTime(resetsAt!, "zh")} 重置`) : null;
    if (next !== undefined) {
      keepSaid(live);
      update(live.runId, { status: "failed", activity: null, partial: null, approval: null, error: detail });
      store.tuneProjectSession(live.sessionId, { configDir: next });
      postLine(live.sessionId, "system", switchedLine(locale(), accountName(from, en), accountName(next, en), reset, "Codex"));
      // Once this run is gone: the next starts on the account moved to, and carries the thread over.
      startRun(live.sessionId, () => ({ input: [{ type: "text", text: continueNote(locale(), "switched", messagesOf(unanswered), "Codex"), text_elements: [] }], command: null, messageIds: [] }));
      return;
    }
    if (!known) return fail(live, detail);
    fail(live, outOfUsageLine(locale(), pickUpDetail(locale(), reset, resetsAt!), "Codex"));
    store.addProjectResume({ session_id: live.sessionId, run_id: live.runId, at: resetsAt! + RESUME_MARGIN_MS, lines: unanswered });
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
    // Before the run reads as stopped, and so before a line you send next.
    keepSaid(live);
    for (const asking of live.waiting.splice(0)) asking.resolve(false);
    live.questions.close();
    live.wake?.();
    const { rpc, threadId, turnId } = live;
    // The turn is told to stop first, so Codex keeps a thread it can resume; then its process goes.
    if (rpc && !rpc.closed && threadId && turnId) {
      void rpc.request("turn/interrupt", { threadId, turnId }, INTERRUPT_TIMEOUT_MS).catch(() => undefined).finally(() => live.abort.abort());
    } else live.abort.abort();
  }

  return {
    heard,
    resumeAfterLimits(now = new Date()) {
      for (const due of store.projectResumes()) {
        if (due.at > now.getTime()) break;
        const project = store.projectOf(due.session_id);
        if (!project || project.agent !== "codex") continue;
        store.dropProjectResume(due.session_id);
        // You spoke since, or a run is going: the session has moved on.
        if (lives.has(due.session_id) || store.latestAgentRun(due.session_id)?.id !== due.run_id) continue;
        startRun(due.session_id, () => ({ input: [{ type: "text", text: continueNote(locale(), "reset", messagesOf(due.lines), "Codex"), text_elements: [] }], command: null, messageIds: [] }));
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
      if (!head) return run;
      head.resolve(allow);
      return store.getAgentRun(runId);
    },
    stop(runId) {
      const run = store.getAgentRun(runId);
      const live = liveRun(runId);
      if (!live) return run;
      stopLive(live);
      return update(runId, { status: "stopped", activity: null, partial: null, approval: null });
    },
    stopSession(sessionId) {
      const live = lives.get(sessionId);
      if (live && !live.stopped) this.stop(live.runId);
    },
    // The model and level are read again at each turn's start; plan mode is Claude Code's only.
    tune() {},
    // Codex offers no way to end one subagent or command alone: Stop ends them all with the run.
    stopTask(runId) {
      return store.getAgentRun(runId);
    },
    async taskOutput(runId, taskId) {
      const live = liveRun(runId);
      if (!live?.tasks.has(taskId)) return null;
      const output = live.outputs.get(taskId) ?? "";
      return { output, total_bytes: Buffer.byteLength(output) };
    },
    async idle() {
      while (settling.size > 0) await Promise.all([...settling]);
    },
    close() {
      for (const live of lives.values()) stopLive(live);
    },
  };
}
