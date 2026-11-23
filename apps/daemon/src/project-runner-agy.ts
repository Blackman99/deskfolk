/**
 * A project session's agent when it is Antigravity (ADR 0111): your own `agy` in the session's
 * directory over the Agent Client Protocol (`agy acp`), as in its terminal — your settings, rules,
 * skills and MCP servers come along, and the app adds no instructions and none of its tools. Each
 * run is an `agy acp` of its own: the first opens a session `agy` keeps (`session/new`), every
 * later one resumes it (`session/resume`), a carried-on one goes on in the terminal's own, so a run
 * is sent only your new line. `agy` cannot be made to ask first (`agy acp` takes no settings, and
 * your settings may let it do anything), so the app checks each call as `agy` reports it under way
 * and stops the turn at one the permission mode would not let through; what it does ask about is
 * answered by the same rules, on a card under ask first. Stop ends the run and what it started.
 * A command it sends to the background keeps the run open, as Claude Code's do (ADR 0095, 25):
 * `agy` reports the command's end when it comes and may go on to say something about it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_APPROVAL_KIND, type AgentRunApproval, type AgentRunToolInfo, type AgentTask, type Message, type ToolFrame } from "@real-bot/protocol";
import { agyServesAcp, agyTooOld } from "./agents/agy-version";
import { estimateAgentCost } from "./agents/agent-prices";
import { acpContextUsage, agentContextWindow } from "./agents/agent-context";
import { initializeAgy } from "./agents/agy-acp";
import { resolveAgent, type ResolvedAgent } from "./agents/runtime";
import { inMemoryDir, type AgentDecision } from "./claude-code/policy";
import { AGENT_CREDENTIALS_REFUSAL, agentRecordDirs } from "./engine/agent/credentials";
import { READ_ONLY_REFUSAL } from "./permission-gate";
import { placeOfCall } from "./claude-code/tool-place";
import { classifyAcpError, offers, pathsOf, textOfContent, textOfRaw, usageOf } from "./engine/agent/drivers/acp";
import { agyFailure, agyVersionText } from "./engine/agent/drivers/agy";
import { rpcPeer, type RpcPeer } from "./engine/agent/jsonrpc";
import { absoluteFrom, decideAction, type AppAction, type AppActionName } from "./engine/agent/policy";
import { agentTrace } from "./engine/agent/trace";
import { HttpError } from "./errors";
import { acpCommandsOf, createCommandMemory, frameOf, lineBlocks, spawnRecorded, takeNext, type Block, type CommandMemory, type Queued } from "./project-acp";
import { nodePathHost } from "./workspace-paths";
import { questionDesk, type AgentAnswer, type AgentQuestion, type QuestionDesk } from "./project-asks";
import { clip, COMPACTING, firstLine, slashCommandOf, targetText, type ProjectRunner } from "./project-runner";
import { CONSULT_SERVER, CONSULT_TOOL, type ConsultDesk } from "./project-consult";
import type { Store } from "./store";

export type AgyProjectDeps = {
  store: Store;
  /** The consult tool each run of a session of yours gets (ADR 0116). */
  consult?: ConsultDesk;
  /** The `agy` a run starts, found as a Bot's is; a test brings its stand-in. */
  resolve?: () => Promise<ResolvedAgent>;
  /** `agy --version`; a test's stand-in. */
  version?: (executable: string, env: Record<string, string>) => Promise<string>;
  /** Each call starting and ending, with where it works, for the task map (ADR 0095): never stored. */
  onTool?: (frame: ToolFrame) => void;
  /** How long `agy` may go quiet after a background command ended before the run closes; a test's is short. */
  settleMs?: number;
  /** The commands `agy` offered in a directory, as its runs heard them (`GET …/commands` reads these). */
  commands?: CommandMemory;
};

type Answer = "allow" | "deny" | "revise";

/** One of `agy`'s calls as it reported it so far. */
type Tool = {
  id: string;
  name: string;
  kind: string | null;
  title: string;
  rawInput: Record<string, unknown>;
  locations: string[];
  status: string | null;
  output: string;
  /** It asked for permission (`session/request_permission`): the answer was the check. */
  asked: boolean;
  checked: boolean;
  /** Its started frame went out: when, and what it said. */
  frame: { at: number; name: string; info: AgentRunToolInfo; command?: string; target?: string } | null;
};

type Live = {
  runId: string;
  sessionId: string;
  queue: Queued[];
  waiting: Array<{ approval: AgentRunApproval; resolve: (answer: Answer) => void }>;
  /** What it has said since its last reply, whole: the bubble shows its start, a run cut short keeps it as its line. */
  said: string;
  stopped: boolean;
  closing: boolean;
  done: Promise<void>;
  abort: AbortController;
  rpc: RpcPeer | null;
  /** `agy`'s own session id, once opened or resumed. */
  acpSession: string | null;
  /** A prompt is under way. */
  prompting: boolean;
  /** Wakes the run waiting on its background commands: a new line, a command's end, `agy` done saying something. */
  wake: (() => void) | null;
  /** Its background commands, by call id. */
  tasks: Map<string, AgentTask>;
  idle: boolean;
  /** What each background command printed, as `agy` last reported it. */
  outputs: Map<string, string>;
  /** Its select options as `agy` last gave them (model, thinking level, mode). */
  configOptions: Array<Record<string, unknown>>;
  models: string[];
  mode: "default" | "plan";
  /** What `agy` asks you (`ask_question`, sent as `elicitation/create`): question cards it waits on. */
  questions: QuestionDesk;
};

const ACTIVITY_MAX = 160;
/** How `agy` titles a call of an MCP tool: `Run mcp_<server>_<tool>`. */
const MCP_CALL = "Run mcp_";
/** The consult tool's call (ADR 0116): `Run mcp_deskfolk_consult`. */
const CONSULT_CALL = `${MCP_CALL}${CONSULT_SERVER}_${CONSULT_TOOL}`;
const PARTIAL_MAX = 4000;
const STDERR_KEEP = 8 * 1024;
const SETTLE_MS = 2500;
const REQUEST_TIMEOUT_MS = 60_000;
/** The words a plan's approval goes on with (ADR 0111): `agy` takes the next step in its default mode. */
const PLAN_GO = { en: "The plan is approved. Carry it out now.", zh: "计划已批准，现在按计划去做。" };


/** A step longer than this, or of several lines, goes under the line's words, whole: it is the only record of what ran. */
const STEP_IN_LINE_MAX = 120;

/**
 * The line a turn stopped at a call it made without asking ends with: what it did, why that needed
 * asking, and that it may have run. A short step is quoted in the sentence; a long command follows it
 * on lines of its own, so the reason is not lost at the end of a screenful of shell.
 */
export function overstepLine(what: string, why: string, en: boolean): string {
  if (what.includes("\n") || what.length > STEP_IN_LINE_MAX) {
    return en
      ? `Antigravity went ahead with the step below without asking (${why}); the turn was stopped there, and that step may have run already:\n${what}`
      : `Antigravity 没先问就做了下面这一步（${why}），这一轮停在这里；那一步可能已经执行了：\n${what}`;
  }
  return en
    ? `Antigravity went ahead with ${what} without asking (${why}); the turn was stopped there, and that step may have run already`
    : `Antigravity 没先问就做了「${what}」（${why}），这一轮停在这里；那一步可能已经执行了`;
}

/** Why a call needed asking, in your words: the rules' own reasons are written for the agent. */
function stopReason(decision: AgentDecision, en: boolean): string {
  if (decision.kind !== "deny") return en ? "the permission mode asks first" : "权限模式要求先问你";
  if (decision.reason === AGENT_CREDENTIALS_REFUSAL) return en ? "your agents' own settings and credentials are off limits" : "本机 Agent 自己的设置和凭据碰不得";
  if (decision.reason === READ_ONLY_REFUSAL) return en ? "the permission mode is read-only" : "权限模式是只读";
  return decision.reason;
}

/** The `agy` a project session starts, found as a Bot's is: the path you set in Settings, or the one on this computer. */
export function projectAgyOf(store: Store): () => Promise<ResolvedAgent> {
  return () => resolveAgent({ runner: "antigravity", custom: null, setting: store.agentPath("antigravity"), configDir: null });
}

/** Where `agy` keeps a session's own notes and plans (`brain/<session>`), under its default data folder. */
export function agyBrainDir(session: string, home = homedir()): string {
  return join(home, ".gemini", "antigravity-cli", "brain", session);
}


/** What a call does, as the app's rules count it: by its kind, the files it names and its input (`CommandLine`, `Path`, …). */
export function agyActionOf(tool: Pick<Tool, "kind" | "title" | "rawInput" | "locations">, cwd: string): AppAction {
  const raw = tool.rawInput;
  // The app's own consult call is never a shell command or a file read, whatever its arguments are
  // called (ADR 0116); any other MCP tool is read by what it names, as before.
  if (tool.title === CONSULT_CALL) return { appName: "other", vendorTool: tool.title, paths: [], cwd };
  const command = typeof raw.CommandLine === "string" ? raw.CommandLine : typeof raw.command === "string" ? raw.command : null;
  const where = typeof raw.Cwd === "string" && raw.Cwd ? raw.Cwd : cwd;
  const paths = tool.locations.length > 0 ? tool.locations : pathsOf(raw);
  const name: AppActionName = tool.kind === "execute" || (command && tool.kind !== "read")
    ? "shell"
    : tool.kind === "edit" || tool.kind === "delete" || tool.kind === "move" ? "write_file"
    : tool.kind === "read" ? "read_file"
    : tool.kind === "search" ? "list_dir"
    : tool.kind === "fetch" ? "web"
    : paths.length > 0 ? "read_file" : "other";
  return {
    appName: name, vendorTool: tool.title || tool.kind || "tool",
    paths: name === "shell" ? [] : paths.map((path) => absoluteFrom(where, path)),
    ...(name === "shell" ? { command: command ?? tool.title } : {}),
    cwd: where,
  };
}


/** One question of an `elicitation/create` form: its field, the field for words of your own, and each option's value. */
type FormQuestion = { key: string; other: string | null; multi: boolean; values: Map<string, string>; question: AgentQuestion };

/**
 * `agy`'s questions (`ask_question`) as it sends them, a form (`elicitation/create`, measured on
 * 1.5.10): per question a field `qN`, one choice (a string, `oneOf` of `{const, title}`) or several
 * (an array, `items.anyOf`), and beside it `qN_other` for words of your own. A field with no choices
 * is a question in words. Null for a form this cannot show as questions (a number, a yes/no).
 */
export function agyQuestionsOf(schema: unknown): FormQuestion[] | null {
  const properties = (schema as { properties?: unknown } | null)?.properties;
  if (!properties || typeof properties !== "object") return null;
  const fields = properties as Record<string, Record<string, unknown>>;
  const choicesOf = (field: Record<string, unknown> | undefined): Array<{ value: string; label: string }> => {
    if (!field) return [];
    const listed = (field.oneOf ?? field.anyOf) as Array<{ const?: unknown; title?: unknown }> | undefined;
    if (Array.isArray(listed)) return listed.flatMap((choice) => (choice.const === undefined ? [] : [{ value: String(choice.const), label: typeof choice.title === "string" && choice.title ? choice.title : String(choice.const) }]));
    if (Array.isArray(field.enum)) return (field.enum as unknown[]).map((value) => ({ value: String(value), label: String(value) }));
    return [];
  };
  const out: FormQuestion[] = [];
  for (const [key, field] of Object.entries(fields)) {
    if (!field || typeof field !== "object") return null;
    // The words-of-your-own field of the question it names.
    if (key.endsWith("_other") && fields[key.slice(0, -"_other".length)]) continue;
    const multi = field.type === "array";
    if (!multi && field.type !== "string") return null;
    const choices = choicesOf(multi ? (field.items as Record<string, unknown> | undefined) : field);
    const words = typeof field.title === "string" && field.title ? field.title : typeof field.description === "string" && field.description ? field.description : key;
    out.push({
      key, other: fields[`${key}_other`] ? `${key}_other` : null, multi,
      values: new Map(choices.map((choice) => [choice.label, choice.value])),
      question: { question: words, options: choices.map((choice) => ({ label: choice.label })), multiSelect: multi },
    });
  }
  return out.length > 0 ? out : null;
}

/** Your answers as the form's content: each pick by its value, your words in the question's own field for them. */
export function agyContentOf(questions: FormQuestion[], answers: AgentAnswer[]): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  questions.forEach((question, index) => {
    const answer = answers[index];
    if (!answer) return;
    const picked = answer.selected.map((label) => question.values.get(label) ?? label);
    if (question.values.size === 0) {
      if (answer.custom) content[question.key] = question.multi ? [answer.custom] : answer.custom;
      return;
    }
    if (picked.length > 0) content[question.key] = question.multi ? picked : picked[0];
    if (answer.custom && question.other) content[question.other] = answer.custom;
  });
  return content;
}

/** The plan `agy` writes in plan mode for you to review: a note in its own folder that asks for feedback. */
function planOf(tool: Tool): { path: string; content: string } | null {
  const meta = tool.rawInput.ArtifactMetadata as { RequestFeedback?: unknown } | undefined;
  const path = typeof tool.rawInput.Path === "string" ? tool.rawInput.Path : tool.locations[0];
  const content = typeof tool.rawInput.Content === "string" ? tool.rawInput.Content : null;
  return meta?.RequestFeedback === true && path && content !== null ? { path, content } : null;
}

/** The app's line for a command that answered nothing. */
function commandRan(command: string, en: boolean): string {
  if (command === "compact") return en ? "Ran /compact: Antigravity keeps a summary of the conversation so far" : "已执行 /compact：Antigravity 把之前的对话压成了摘要";
  return en ? `Ran /${command}` : `已执行 /${command}`;
}


export function createAgyProjectRunner(deps: AgyProjectDeps): ProjectRunner {
  const { store } = deps;
  const lives = new Map<string, Live>();
  const settling = new Set<Promise<void>>();
  const commands = deps.commands ?? createCommandMemory();
  const resolve = deps.resolve ?? projectAgyOf(store);
  const update = (runId: string, patch: Parameters<Store["updateAgentRun"]>[1]) => store.updateAgentRun(runId, patch);
  const postLine = (sessionId: string, kind: "bot" | "system", body: string) => {
    store.insertAgentLine(sessionId, { kind, body });
  };
  const locale = () => store.settingsCached().locale;
  /** A live run's way to set the model, level or mode on `agy`'s session now. */
  const tuning = new Map<string, (change: { model?: string | null; effort?: string | null; mode?: "plan" | null }) => Promise<void>>();


  function heard(message: Message): void {
    const sessionId = message.session_id;
    if (!store.projectOf(sessionId)) return;
    const command = slashCommandOf(message.body);
    // `agy` waits on its questions: your words are the answer to each (a command still goes as one).
    const live = lives.get(sessionId);
    if (!command && live && !live.stopped && live.questions.takeLine(message)) return;
    if (!command) store.nameProjectSessionIfUnnamed(sessionId, message.body);
    startRun(sessionId, () => ({ blocks: lineBlocks(store, message, locale() === "en"), command, messageId: message.id }));
  }

  /** Into the session's live run, or the start of a new one. */
  function startRun(sessionId: string, lineOf: () => Queued): void {
    if (!store.projectOf(sessionId)) return;
    const live = lives.get(sessionId);
    if (live && (live.stopped || live.closing)) {
      void live.done.then(() => startRun(sessionId, lineOf));
      return;
    }
    if (live) {
      // A plan waiting on you is not approved by what you say next: it is what to change.
      if (live.waiting[0]?.approval.kind_key === PLAN_APPROVAL_KIND) live.waiting.shift()!.resolve("revise");
      // ACP has no steer: the line goes with the next prompt, once this one is answered.
      live.queue.push(lineOf());
      live.wake?.();
      return;
    }
    const run = store.createAgentRun(sessionId);
    let finish!: () => void;
    const fresh: Live = {
      runId: run.id, sessionId, queue: [lineOf()], waiting: [], said: "", stopped: false, closing: false,
      done: new Promise<void>((resolve) => { finish = resolve; }), abort: new AbortController(), rpc: null, acpSession: null,
      prompting: false, wake: null, tasks: new Map(), outputs: new Map(), idle: false, configOptions: [], models: [], mode: "default",
      questions: questionDesk(store, sessionId, (open) => {
        if (!fresh.stopped) update(run.id, { asks: open, status: open.length > 0 || fresh.waiting.length > 0 ? "waiting_approval" : "running" });
      }),
    };
    lives.set(sessionId, fresh);
    const running = runSession(fresh).catch((error) => {
      console.error(`[project ${sessionId}] Antigravity run failed`, error);
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
      console.error(`[project ${live.sessionId}] could not keep what Antigravity said`, error);
    }
  }

  function fail(live: Live, detail: string): void {
    const run = store.getAgentRun(live.runId);
    if (!["running", "waiting_approval"].includes(run.status)) return;
    keepSaid(live);
    update(live.runId, { status: "failed", activity: null, partial: null, approval: null, error: detail });
    postLine(live.sessionId, "system", locale() === "en" ? `Antigravity stopped: ${detail}` : `Antigravity 出错停下了：${detail}`);
  }

  /** A card that waits on you; any other call already asking keeps the card until it is answered. */
  async function askYou(live: Live, approval: AgentRunApproval): Promise<Answer> {
    const answer = await new Promise<Answer>((resolve) => {
      live.waiting.push({ approval, resolve });
      if (live.waiting.length === 1) update(live.runId, { status: "waiting_approval", approval });
    });
    if (live.stopped) return "deny";
    const next = live.waiting[0];
    update(live.runId, next ? { status: "waiting_approval", approval: next.approval } : { status: live.questions.open().length > 0 ? "waiting_approval" : "running", approval: null });
    return answer;
  }

  async function runSession(live: Live): Promise<void> {
    const en = locale() === "en";
    const project = store.projectOf(live.sessionId);
    if (!project) return;
    const resolved = await resolve();
    if (!resolved.ok) return fail(live, en ? `agy was not found on this computer (${resolved.error})` : `这台电脑上没找到 agy（${resolved.error}）`);
    const version = await (deps.version ?? agyVersionText)(resolved.executable, resolved.env);
    if (!agyServesAcp(version)) return fail(live, agyTooOld(version, locale()) ?? "agy is too old");
    if (!existsSync(project.dir)) return fail(live, en ? `${project.dir} is no longer there` : `${project.dir} 已经不在了`);
    if (live.stopped) return;

    // Its terminal sandbox on, as a Bot's `agy` runs: the app cannot make it ask first.
    const child = spawnRecorded(store, live.abort, resolved.executable, [...resolved.args, "--sandbox"], project.dir, resolved.env);
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
    void exited.then(() => rpc.close(new Error("agy exited")));
    live.rpc = rpc;

    const permission = store.projectPermissionMode(live.sessionId);
    // A session of yours gets the consult tool through a stdio shim; a consultant's run gets no tools of its own (ADR 0116).
    const consultant = project.parentId !== null;
    const mount = consultant ? null : (deps.consult?.mount(live.sessionId, live.runId) ?? null);
    const mcpServers = (() => {
      if (!mount) return [];
      const { command, args, env } = mount.stdio();
      return [{ name: CONSULT_SERVER, command, args, env: Object.entries(env).map(([name, value]) => ({ name, value })) }];
    })();
    const configDirs = store.allAgentConfigDirs();
    const home = homedir();
    /** Your agents' conversation records: read, never written, in every mode (ADR 0095 addendum 2026-11-23). */
    const records = agentRecordDirs(home, (runner) => store.agentConfigDirs(runner));
    const tools = new Map<string, Tool>();
    let turnText = "";
    /** What it says after a background command ended, outside any prompt: posted once it goes quiet. */
    let selfText = "";
    let selfTimer: ReturnType<typeof setTimeout> | null = null;
    /** A call it made without asking that the permission mode would not let through: the turn stops on it. */
    let overstep: string | null = null;
    /** The plan it wrote in plan mode for you to review, this turn. */
    let plan: { path: string; content: string } | null = null;
    /** Read through a call: TypeScript cannot see the notification handler set it. */
    const planned = (): { path: string; content: string } | null => plan;
    let model: string | null = project.model;
    /** Whether `agy` reported context occupancy directly via `usage_update` during the current prompt. */
    let sawUsageUpdate = false;
    /** While a resumed session is replayed (`session/load`), what it replays is history, not this run. */
    let replaying = false;

    const brain = () => (live.acpSession ? [agyBrainDir(live.acpSession, home)] : []);
    const decide = (tool: Tool) => {
      const action = agyActionOf(tool, project.dir);
      const own = brain();
      // The consult tool of a session of yours always passes; a consultant only looks, so no MCP tool passes for it (ADR 0116).
      if (mount && tool.title === CONSULT_CALL) return { action, decision: { kind: "allow" as const, effect: false, appName: action.appName } };
      if (consultant && tool.title.startsWith(MCP_CALL)) {
        return { action, decision: { kind: "deny" as const, reason: en ? "a consultant only looks: it may not call tools" : "参谋只看不动：不能调用工具" } };
      }
      // Its own notes and plans are its to write, as Claude Code's plan file and to-do list are, in every mode.
      if (action.appName === "write_file" && action.paths.length > 0 && action.paths.every((path) => inMemoryDir(path, own, nodePathHost))) {
        return { action, decision: { kind: "allow" as const, effect: false, appName: action.appName } };
      }
      // Plan mode: nothing changes before the plan is approved.
      if (live.mode === "plan" && action.appName === "write_file") {
        return { action, decision: { kind: "deny" as const, reason: en ? "plan mode is on: nothing changes before the plan is approved" : "计划模式开着：计划批准前什么都不改" } };
      }
      return { action, decision: decideAction(action, { mode: "work", workspace: project.dir, configDirs, permission, openDirs: own, readableDirs: records }) };
    };

    const ended = (tool: Tool, ok: boolean, exitCode?: number | null) => {
      const call = tool.frame;
      if (!call) return;
      tool.frame = null;
      update(live.runId, { activity: null });
      deps.onTool?.({ type: "tool", turn_id: live.runId, id: tool.id, name: call.name, phase: "exited",
        ...(call.command !== undefined ? { command: call.command, target: call.command, exit_code: exitCode ?? (ok ? 0 : 1) } : { target: call.target ?? targetText(call.info.place) }),
        duration_ms: Date.now() - call.at, agent_run: { ...call.info, at: new Date().toISOString(), ok } });
    };

    /** A background command's end: its task ends, its output kept where the tasks route reads it. */
    const taskEnded = (tool: Tool) => {
      const task = live.tasks.get(tool.id);
      if (!task || task.status !== "running") return;
      const ok = tool.status === "completed";
      let outputFile: string | null = null;
      try {
        const dir = join(tmpdir(), "deskfolk-agy-tasks");
        mkdirSync(dir, { recursive: true });
        outputFile = join(dir, `${live.runId}-${tool.id}.log`);
        writeFileSync(outputFile, tool.output);
      } catch {
        outputFile = null;
      }
      live.tasks.set(tool.id, { ...task, status: ok ? "completed" : "failed", ended_at: new Date().toISOString(), output_file: outputFile, summary: firstLine(tool.output.split("\n").slice(-3).join("\n")) });
      publishTasks(live);
      ended(tool, ok);
      live.wake?.();
    };

    const noteTool = (u: Record<string, unknown>): Tool => {
      const id = String(u.toolCallId ?? `agy_tool_${tools.size + 1}`);
      let tool = tools.get(id);
      if (!tool) {
        tool = { id, name: typeof u.name === "string" ? u.name : "", kind: null, title: "", rawInput: {}, locations: [], status: null, output: "", asked: false, checked: false, frame: null };
        tools.set(id, tool);
      }
      if (typeof u.kind === "string") tool.kind = u.kind;
      if (typeof u.title === "string" && u.title) tool.title = u.title;
      const raw = (u.rawInput ?? u.args) as Record<string, unknown> | undefined;
      if (raw && typeof raw === "object") tool.rawInput = { ...tool.rawInput, ...raw };
      if (Array.isArray(u.locations) && u.locations.length > 0) {
        tool.locations = (u.locations as Array<{ path?: unknown }>).flatMap((location) => (typeof location.path === "string" ? [location.path] : []));
      }
      if (typeof u.status === "string") tool.status = u.status;
      const text = textOfRaw(u.rawOutput) ?? textOfContent(u.content);
      if (text) {
        tool.output = text;
        if (live.tasks.has(id)) live.outputs.set(id, text);
      }
      return tool;
    };

    const onToolUpdate = (u: Record<string, unknown>) => {
      const tool = noteTool(u);
      // Its question is the card it asks with: no step of its own on the record.
      if (tool.name === "ask_question") return;
      if (!tool.frame && !live.tasks.has(tool.id) && tool.status !== "completed" && tool.status !== "failed") {
        const action = agyActionOf(tool, project.dir);
        const frame = frameOf(action);
        const { place, action: shellAction } = placeOfCall(frame.place.tool, frame.place.input, { projectDir: project.dir, cwd: action.cwd, home, configDirs });
        const info: AgentRunToolInfo = { session_id: live.sessionId, agent_id: null, place, ...(shellAction ? { action: shellAction } : {}), model, at: new Date().toISOString() };
        tool.frame = { at: Date.now(), name: frame.name, info, ...(frame.command !== undefined ? { command: frame.command } : {}), ...(frame.target ? { target: frame.target } : {}) };
        update(live.runId, { activity: clip(frame.command ?? `${frame.name} ${frame.target ?? ""}`.trim(), ACTIVITY_MAX) });
        deps.onTool?.({ type: "tool", turn_id: live.runId, id: tool.id, name: frame.name, phase: "started",
          ...(frame.command !== undefined ? { command: frame.command, target: frame.command } : { target: frame.target ?? targetText(place) }), agent_run: info });
      }
      // Under way and never asked about: checked now, by the rules a question would have met.
      if (!tool.asked && !tool.checked && tool.status && tool.status !== "pending") {
        tool.checked = true;
        const { action, decision } = decide(tool);
        // Outside a prompt too: after a background command ended, agy may go on by itself.
        if (decision.kind !== "allow" && !overstep) {
          const what = action.appName === "shell" ? (action.command ?? tool.title) : `${tool.title || action.vendorTool}`;
          overstep = overstepLine(what, stopReason(decision, en), en);
          live.rpc?.notify("session/cancel", { sessionId: live.acpSession });
          // Between prompts nothing else will end the run: it ends here, with that line.
          if (!live.prompting) {
            failure = overstep;
            overstepped = true;
            live.wake?.();
          }
        }
      }
      if (live.mode === "plan" && tool.kind === "edit") plan = planOf(tool) ?? plan;
      if (tool.status === "completed" || tool.status === "failed") {
        if (live.tasks.has(tool.id)) taskEnded(tool);
        else ended(tool, tool.status === "completed");
      }
    };

    rpc.onNotification((method, params) => {
      const p = (params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
      if (method !== "session/update" || !p.update || replaying) return;
      if (live.acpSession && p.sessionId && p.sessionId !== live.acpSession) return;
      const u = p.update;
      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          const content = u.content as { type?: string; text?: string } | undefined;
          if (content?.type !== "text" || typeof content.text !== "string" || live.stopped) return;
          if (live.prompting) turnText += content.text;
          else {
            // On its own, after a background command ended: kept until it goes quiet.
            selfText += content.text;
            if (selfTimer) clearTimeout(selfTimer);
            selfTimer = setTimeout(() => { selfTimer = null; live.wake?.(); }, deps.settleMs ?? SETTLE_MS);
          }
          live.said += content.text;
          update(live.runId, { partial: clip(live.said, PARTIAL_MAX) });
          return;
        }
        case "tool_call":
        case "tool_call_update":
          return onToolUpdate(u);
        case "available_commands_update":
          commands.set(project.dir, acpCommandsOf(u.availableCommands));
          return;
        case "current_mode_update":
          if (typeof u.currentModeId === "string") live.mode = u.currentModeId === "plan" ? "plan" : "default";
          return;
        case "config_option_update":
          if (Array.isArray(u.configOptions)) live.configOptions = u.configOptions as Array<Record<string, unknown>>;
          return;
        case "usage_update": {
          const ctx = acpContextUsage(u, model);
          if (ctx) {
            sawUsageUpdate = true;
            store.recordProjectContext(live.sessionId, ctx);
          }
          return;
        }
      }
    });

    rpc.onRequest(async (method, params) => {
      const p = (params ?? {}) as { toolCall?: Record<string, unknown>; options?: Array<{ optionId?: string; kind?: string }>; requestedSchema?: unknown; mode?: unknown };
      // Its questions for you (`ask_question`): a card each, and `agy` waits for every answer.
      if (method === "elicitation/create") {
        const questions = p.mode === "form" || p.mode === undefined ? agyQuestionsOf(p.requestedSchema) : null;
        if (!questions) return { action: "decline" };
        const answers = await live.questions.ask(questions.map((question) => question.question));
        return answers ? { action: "accept", content: agyContentOf(questions, answers) } : { action: "cancel" };
      }
      if (method !== "session/request_permission") throw new Error(`${method} is not offered by Deskfolk`);
      const tool = noteTool(p.toolCall ?? {});
      tool.asked = true;
      const { decision } = decide(tool);
      const allow = decision.kind === "allow" || (decision.kind === "ask" && (await askYou(live, decision.approval)) === "allow");
      const pick = (p.options ?? []).find((option) => option.kind === (allow ? "allow_once" : "reject_once"))
        ?? (p.options ?? []).find((option) => option.kind?.startsWith(allow ? "allow" : "reject"));
      return pick?.optionId ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } };
    });

    const byCategory = (category: string) => live.configOptions.find((option) => option.category === category || option.id === category);
    const setOption = async (option: Record<string, unknown> | undefined, value: string | null) => {
      if (!option || !value || typeof option.id !== "string" || !live.acpSession) return;
      const answer = await rpc.request<{ configOptions?: Array<Record<string, unknown>> }>("session/set_config_option", { sessionId: live.acpSession, configId: option.id, value }, REQUEST_TIMEOUT_MS).catch(() => null);
      if (Array.isArray(answer?.configOptions) && answer.configOptions.length > 0) live.configOptions = answer.configOptions;
    };
    /** The session's model, level and mode as they are now, set on `agy`'s session; a run going now takes them at its next step. */
    const configure = async (change: { model?: string | null; effort?: string | null; mode?: "plan" | null }) => {
      if (change.model) {
        const option = byCategory("model");
        if (option && offers(option, change.model) === change.model) await setOption(option, change.model);
        // `gemini-3.8-flash-high`: the model and its level in one, as its model list names them.
        else if (live.models.includes(change.model) && live.acpSession) await rpc.request("session/set_model", { sessionId: live.acpSession, modelId: change.model }, REQUEST_TIMEOUT_MS).catch(() => null);
        else if (option) await setOption(option, change.model);
        model = change.model;
      }
      if (change.effort) {
        const option = byCategory("thought_level");
        const value = option ? offers(option, change.effort) : null;
        if (value) await setOption(option, value);
      }
      if (change.mode !== undefined) {
        const wanted = change.mode === "plan" ? "plan" : "default";
        live.mode = wanted;
        const option = byCategory("mode");
        if (option) await setOption(option, wanted);
        else if (live.acpSession) await rpc.request("session/set_mode", { sessionId: live.acpSession, modeId: wanted }, REQUEST_TIMEOUT_MS).catch(() => null);
      }
    };
    tuning.set(live.runId, configure);

    let failure: string | null = null;
    /** The turn was stopped at a call the mode would not let through: its own line says so, not as a failure of agy's. */
    let overstepped = false;
    try {
      const caps = await initializeAgy(rpc, REQUEST_TIMEOUT_MS);
      if (!caps.resume && !caps.load) return fail(live, en ? "this agy cannot carry a session on: update it (agy update)" : "这个 agy 接不上会话：先更新它（agy update）");
      if (live.stopped) return;
      type Opened = { sessionId?: string; configOptions?: Array<Record<string, unknown>>; models?: { availableModels?: Array<{ modelId?: string }>; currentModelId?: string }; modes?: { currentModeId?: string } };
      let opened: Opened;
      if (project.agentSession) {
        live.acpSession = project.agentSession;
        const asked = { sessionId: project.agentSession, cwd: project.dir, mcpServers };
        if (caps.resume) opened = await rpc.request<Opened>("session/resume", asked, REQUEST_TIMEOUT_MS * 2);
        else {
          // `session/load` replays the whole conversation first: that is history, not this run.
          replaying = true;
          try {
            opened = await rpc.request<Opened>("session/load", asked, REQUEST_TIMEOUT_MS * 2);
          } finally {
            replaying = false;
          }
        }
      } else {
        opened = await rpc.request<Opened>("session/new", { cwd: project.dir, mcpServers }, REQUEST_TIMEOUT_MS * 2);
        if (!opened?.sessionId) throw new Error(en ? "agy opened no session" : "agy 没有开出会话");
        live.acpSession = opened.sessionId;
        store.recordProjectAgentSession(live.sessionId, opened.sessionId);
      }
      live.configOptions = Array.isArray(opened?.configOptions) ? opened.configOptions : [];
      live.models = (opened?.models?.availableModels ?? []).flatMap((entry) => (typeof entry.modelId === "string" ? [entry.modelId] : []));
      model = project.model ?? opened?.models?.currentModelId ?? null;
      live.mode = opened?.modes?.currentModeId === "plan" ? "plan" : "default";
      await configure({ model: project.model, effort: project.effort, mode: project.mode === "plan" ? "plan" : null });

      /** One prompt: its reply posted, a plan put on a card. False when the run ends here. */
      const prompt = async (line: Queued): Promise<boolean> => {
        turnText = "";
        overstep = null;
        plan = null;
        sawUsageUpdate = false;
        if (line.command === "compact") update(live.runId, { activity: COMPACTING[en ? "en" : "zh"] });
        live.prompting = true;
        let result: { stopReason?: string; usage?: Record<string, number> } | null = null;
        try {
          result = await Promise.race([
            rpc.request<{ stopReason?: string; usage?: Record<string, number> }>("session/prompt", { sessionId: live.acpSession, prompt: line.blocks }),
            exited.then(() => null),
          ]);
        } finally {
          live.prompting = false;
        }
        if (live.stopped) return false;
        if (!result) {
          failure = firstLine(stderr.split("\n").filter(Boolean).at(-1) ?? "") ?? (en ? "agy exited" : "agy 退出了");
          return false;
        }
        bill(result.usage);
        if (overstep) {
          failure = overstep;
          overstepped = true;
          return false;
        }
        const reply = turnText.trim();
        const failed = agyFailure(reply);
        if (failed) {
          failure = failed;
          return false;
        }
        // Commands it sends to the background go on past the reply: each a task the run stays open for.
        for (const tool of tools.values()) {
          if (tool.frame && (tool.status === "in_progress" || tool.status === "pending") && agyActionOf(tool, project.dir).appName === "shell" && !live.tasks.has(tool.id)) {
            const command = agyActionOf(tool, project.dir).command ?? tool.title;
            live.tasks.set(tool.id, {
              id: tool.id, tool_use_id: tool.id, kind: "shell", status: "running", description: typeof tool.rawInput.toolSummary === "string" ? tool.rawInput.toolSummary : clip(command, 120),
              command: clip(command, 300), agent_type: null, activity: null, summary: null, tool_uses: null, tokens: null,
              started_at: new Date(tool.frame.at).toISOString(), ended_at: null, output_file: null,
            });
          }
        }
        if (live.tasks.size > 0) publishTasks(live);
        if (reply) postLine(live.sessionId, "bot", reply);
        else if (line.command) postLine(live.sessionId, "system", commandRan(line.command, en));
        live.said = "";
        update(live.runId, { partial: null, activity: null });
        // A plan to review: a card of its own; approved, it goes on in its default mode and carries it out.
        const written = planned();
        if (written && live.mode === "plan") {
          const answer = await askYou(live, { kind_key: PLAN_APPROVAL_KIND, target: written.path, summary: written.content });
          if (live.stopped) return false;
          if (answer === "allow") {
            store.tuneProjectSession(live.sessionId, { mode: null });
            await configure({ mode: null });
            live.queue.unshift({ blocks: [{ type: "text", text: PLAN_GO[en ? "en" : "zh"] }], command: null, messageId: null });
          }
        }
        return true;
      };

      const bill = (usage: Record<string, number> | undefined) => {
        const used = usageOf(usage);
        if (!used) return;
        if (!sawUsageUpdate && used.input > 0) {
          store.recordProjectContext(live.sessionId, { used: used.input, limit: agentContextWindow(model), model });
        }
        try {
          store.insertSpend({
            kind: "turn", purpose: "project", sessionId: live.sessionId, botId: null, turnId: live.runId, providerId: "", providerName: "Antigravity",
            model, thinkingLevel: null, inputTokens: used.input, outputTokens: used.output, totalTokens: used.input + used.output, cachedTokens: used.cached,
            // agy reports no price: an estimate from the model's public API price, when the table has it.
            reasoningTokens: null, costUsdTicks: null,
            estimatedCostUsdTicks: estimateAgentCost(model, { inputTokens: used.input, outputTokens: used.output, cachedTokens: used.cached }), missingReason: null,
          });
        } catch (error) {
          console.error(`[project ${live.sessionId}] could not record spend`, error);
        }
      };

      const running = () => [...live.tasks.values()].filter((task) => task.status === "running").length;
      while (!live.stopped) {
        const next = takeNext(live.queue);
        if (next && next.blocks.length > 0) {
          setIdle(live, false);
          if (!(await prompt(next))) break;
          continue;
        }
        // What it said by itself after a background command ended, once it went quiet.
        if (!selfTimer && selfText.trim()) {
          postLine(live.sessionId, "bot", selfText.trim());
          selfText = "";
          live.said = "";
          update(live.runId, { partial: null });
        }
        if (running() === 0 && !selfTimer) break;
        // Only its background commands keep it open: a line you send is answered at once.
        setIdle(live, true);
        await new Promise<void>((resolve) => {
          live.wake = resolve;
          // A command's end that came meanwhile, or a quiet that already passed.
          if (live.queue.length > 0 || (running() === 0 && !selfTimer)) resolve();
        });
        live.wake = null;
        if (overstepped) break;
        // A last word may follow a command's end: give it the quiet before closing.
        if (running() === 0 && !selfTimer && live.queue.length === 0 && !selfText) {
          await new Promise<void>((resolve) => setTimeout(resolve, deps.settleMs ?? SETTLE_MS));
        }
      }
    } catch (error) {
      if (!live.stopped) failure ??= classifyAcpError(error).detail ?? firstLine(stderr.split("\n").filter(Boolean).at(-1) ?? "") ?? "error";
    } finally {
      mount?.close();
      tuning.delete(live.runId);
      if (selfTimer) clearTimeout(selfTimer);
      for (const tool of tools.values()) ended(tool, false);
      live.closing = true;
      rpc.close();
      live.abort.abort();
    }
    if (live.stopped) return;
    if (failure && overstepped) {
      keepSaid(live);
      update(live.runId, { status: "failed", activity: null, partial: null, approval: null, error: failure, idle: false });
      postLine(live.sessionId, "system", failure);
      return;
    }
    if (failure) return fail(live, failure);
    update(live.runId, { status: "completed", activity: null, partial: null, approval: null, idle: false });
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
    // The prompt is told to stop first, so `agy` keeps a session it can resume; then its process goes.
    if (rpc && !rpc.closed && acpSession) rpc.notify("session/cancel", { sessionId: acpSession });
    setTimeout(() => live.abort.abort(), 500).unref?.();
  }

  return {
    heard,
    resumeAfterLimits() {
      // `agy` says no reset time: a run its plan's limit stopped says so and waits for you.
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
      head.resolve(allow ? "allow" : "deny");
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
      // Asked of `agy` at once, mid-prompt too: it takes the change at its next step (measured 2026-11-17).
      void tuning.get(live.runId)?.({ ...(change.model !== undefined ? { model: change.model } : {}), ...(change.effort !== undefined ? { effort: change.effort } : {}), ...(change.mode !== undefined ? { mode: change.mode } : {}) });
    },
    // `agy` offers no way to end one background command: Stop ends them all with the run.
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
