/**
 * An in-process scenario harness: one Store and one turn engine, wired the way `local-api.ts`
 * wires them, with every model call answered from a script. A scenario creates Bots and sessions,
 * says what each Bot answers, posts your lines, waits for everything to go quiet, and asserts on
 * what the store recorded. Nothing leaves the process except the media MCP server, which is
 * `mcp-fixture.ts` over stdio; there is no network, and the only waits are the engine's own quiet
 * timers, which the harness shortens.
 *
 * Replies are routed by Bot and session, not handed out in one queue. The incidents worth replaying
 * (ADR 0040's fixtures F-a…F-g) are several Bots working at once in several sessions, and a single
 * queue gives each answer to whichever hop happens to ask first. A hop is matched to the turn that
 * made it: the Bot by the name in its system prompt, the turn by that Bot's running row (by the
 * trigger line when it has two, and the scenario fails when that line cannot tell them apart). It
 * takes the next reply scripted for that Bot in that session, else the next one for that Bot
 * anywhere, else a handler, the session's before the Bot's. A hop nobody scripted is answered with
 * `end_turn` and listed in `unscripted()`, so a wake the scenario did not expect shows up instead
 * of passing silently.
 *
 * There is one clock, the wall clock: the store stamps rows with `isoNow()` and the engine reads
 * `Date.now()` throughout, so a second clock beside it would disagree with every row written after
 * it moved. `advance(ms)` makes time pass by ageing what the scheduler compares against the wall
 * clock — every check-back still to come falls due `ms` sooner and every running turn's last
 * activity is `ms` older — then ticks. A check-back booked after an advance comes due its full
 * `after_minutes` later, a turn stuck across the advance is swept, a fresh one is not. A hop whose
 * handler is still out is not swept but runs out of time: once advances take it past the hop's
 * `wallMs` it is answered `overtime`, as the completions client ends such an attempt (ADR 0040 P1).
 * Nothing else is aged: messages, plans and ended turns keep their stamps, so what compares those
 * with the wall clock (a chain's age, a memory's, a plan's quiet) does not see the advance.
 * Routines fire at a time of day and do not follow it either; a scenario that needs one fires it
 * with `engine.fireRoutine(id, at)`.
 *
 * The engine's quiet timers (settle, a Bot↔Bot direct's report, chain review, a plan left with
 * work) are real `setTimeout`s, injected short, and `advance` cannot move them. `waitIdle` waits out
 * the longest of those, but not a timer the engine arms with a longer delay of its own: the plan
 * watch, when the Bot it would call back already has an appointment in that session for another
 * plan, looks again only once that one is due plus the quiet, in real time. `waitIdle` returns
 * while that look is pending, so "no call-back happened" proves nothing in that case.
 *
 * `durable: true` keeps the store in a file, so `restart()` can take the daemon down and bring a
 * second engine up on what it left, the way `runtime.ts` boots. A clean restart goes through the
 * same shutdown steps as a quit. A crash writes nothing more: the next boot reads a copy of the file
 * taken at that instant, and the dying engine is taken down on the original. The Bots' scripts and
 * every record carry across; the media server is a new process, so its job counters start over.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER, type ApprovalStatus, type Bot, type ClientEvent, type Message, type Turn } from "@real-bot/protocol";
import type { Ablation } from "../ablation";
import type {
  CompletionFail,
  CompletionOk,
  CompletionRequest,
  CompletionResult,
  CompletionsClient,
  JudgeRequest,
  JudgeResult,
  MappedUsage,
  ToolCall,
} from "../completions";
import { TRIGGER_FLAG } from "../context";
import { classifyRestart } from "../engine/restart";
import { isoNow } from "../ids";
import { createMcpHost, type McpCallResult, type McpHost } from "../mcp-host";
import { COLLAB_TOOL_NAMES, COMPOSER_SUGGEST_SYSTEM, JUDGEMENT_SYSTEM, type FailKind } from "../prompts";
import { ORGANIZER_SYSTEM, ORGANIZER_SYSTEM_UNDER_HOLDS } from "../prompts/organizer";
import { ROUTE_LEARN_SYSTEM, ROUTE_PICK_SYSTEM, ROUTE_REVIEW_SYSTEM } from "../prompts/routing";
import { SCRIBE_SYSTEM } from "../prompts/scribe";
import { TurnAdmission } from "../quiesce";
import { startScheduler, type Scheduler } from "../scheduler";
import { memoryKeyStore } from "../secrets";
import { Store, type WorkEvent } from "../store";
import { ENGINE_LEVELS, SCHEMA_LEVEL } from "../store/schema-gate";
import type { TurnRun } from "../store/turn-runs";
import { createTurnEngine, type TurnEngine } from "../turn-engine";
import type { WakeWatch } from "../wake";

/** The media server's name, so its tools are `mcp_media_submit_video` and so on. */
export const MEDIA_SERVER = "media";

const MCP_FIXTURE = join(import.meta.dir, "..", "mcp-fixture.ts");

/**
 * Calls that change nothing outside the conversation: reading, and answering (ADR 0040 I3 checks
 * holds only before side-effecting calls, and I2's one exemption is the read-only turn your
 * question opens, so a held Bot may still read and reply). Every other call a turn dispatches, MCP
 * ones included, is a side effect. A per-call side-effect flag on `turn_runs` (ADR 0040 P2)
 * replaces this list once it exists.
 */
const NO_SIDE_EFFECT: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "list_bots",
  "list_sessions",
  "list_routines",
  "list_skills",
  "read_skill",
  "list_endpoints",
  "list_mcp_servers",
  "list_annotations",
  "send_message",
  "ask_user",
  "end_turn",
]);

/**
 * Error codes a call comes back with when it was turned away before it did anything: you denied
 * it, its arguments did not validate, the runtime was draining, a static guard (the recursive
 * search guard, ADR 0040 P1) turned it away outright, or a hold did (ADR 0040 I3; a call that
 * waited on your approval is refused only once you give it). The engine announces a call as
 * started before these, so they have to be taken out again — by the result the engine reports as
 * the call exits, which a refused call on a turn's last hop has too.
 */
const REFUSED: ReadonlySet<string> = new Set(["denied", "invalid_args", "draining", "refused", "held"]);

// ── Replies ─────────────────────────────────────────────────────────────────────────────────────

/** One tool call to script: the model-facing name and its arguments. The harness gives it an id. */
export type ScriptedCall = { name: string; args?: Record<string, unknown>; id?: string };

/** A plain reply with no tool calls; the turn posts it and ends. */
export function say(content: string, usage: MappedUsage | null = null): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage, missingReason: null };
}

/** A hop that calls tools, all in one go, in the order given. */
export function call(...calls: ScriptedCall[]): CompletionOk {
  return {
    ok: true,
    content: "",
    toolCalls: calls.map((spec) => ({ id: spec.id ?? "", name: spec.name, arguments: JSON.stringify(spec.args ?? {}) })),
    finishReason: "tool_calls",
    hadChoices: true,
    usage: null,
    missingReason: null,
  };
}

/** A reply the endpoint cut off at its token cap (`finish_reason: "length"`). */
export function truncated(content: string, usage: MappedUsage | null = null): CompletionOk {
  return { ...say(content, usage), finishReason: "length" };
}

/** A call that failed the way the completions client reports it. */
export function failed(failKind: FailKind = "unreachable"): CompletionFail {
  return { ok: false, failKind, hadChoices: false, usage: null, missingReason: null };
}

export function tool(name: string, args: Record<string, unknown> = {}): ScriptedCall {
  return { name, args };
}

export function shell(command: string, extra: Record<string, unknown> = {}): ScriptedCall {
  return tool("shell", { command, ...extra });
}

export function sendMessage(body: string, extra: Record<string, unknown> = {}): ScriptedCall {
  return tool("send_message", { body, ...extra });
}

export function writeFile(path: string, content: string): ScriptedCall {
  return tool("write_file", { path, content });
}

export function checkBack(afterMinutes: number, note: string): ScriptedCall {
  return tool("check_back", { after_minutes: afterMinutes, note });
}

export function endTurn(): ScriptedCall {
  return tool("end_turn", { reason: "nothing_new" });
}

/** A tool of the media server: `submit_video`, `check_video` or `generate_image`. */
export function media(name: "submit_video" | "check_video" | "generate_image", args: Record<string, unknown>): ScriptedCall {
  return tool(`mcp_${MEDIA_SERVER}_${name}`, args);
}

// ── Scripts ─────────────────────────────────────────────────────────────────────────────────────

/** A scripted answer, or a function that decides it when the call arrives (and may wait). */
export type Step<C, R> = R | ((ctx: C) => R | Promise<R>);

/**
 * What one Bot answers, in one session or anywhere: queued replies, each used once, then a handler
 * for every hop after them. Both are optional; without either the hop falls through.
 */
export class Script<C, R> {
  readonly queue: Array<Step<C, R>> = [];
  handler: ((ctx: C) => R | Promise<R>) | null = null;

  reply(...steps: Array<Step<C, R>>): this {
    this.queue.push(...steps);
    return this;
  }

  handle(fn: (ctx: C) => R | Promise<R>): this {
    this.handler = fn;
    return this;
  }
}

/** What a scripted turn hop is told about itself. */
export type HopContext = {
  bot: Bot;
  sessionId: string | null;
  turn: Turn | null;
  /** 1 for the turn's first hop. */
  hop: number;
  request: CompletionRequest;
  /** What the previous hop's calls returned, in call order. Empty on a first hop. */
  results: ToolOutcome[];
};

export type ToolOutcome = { id: string; name: string; ok: boolean | null; error: string | null; content: string };

export type JudgeKind = "organizer" | "scribe" | "judgement" | "route_pick" | "route_review" | "route_learn" | "composer" | "other";

/** What a scripted side-call is told: its kind, the parsed payload, and whose it is when that shows. */
export type JudgeContext = {
  kind: JudgeKind;
  request: JudgeRequest;
  /** The last user message, parsed as JSON; null when it is not JSON. */
  payload: unknown;
  /** A judgement's Bot, from `payload.you.name`; null for the other kinds. */
  bot: Bot | null;
  /** From `payload.session.id` (organizer, judgement, scribe); null when the payload names none. */
  sessionId: string | null;
};

/**
 * A side-call's answer: the text the model would have written (an object is stringified), or a
 * whole `JudgeResult`. For a judgement, `"join"` and `"pass"` are shorthand, as in fake-openai.
 */
export type JudgeAnswer = string | Record<string, unknown> | JudgeResult;

// ── Records ─────────────────────────────────────────────────────────────────────────────────────

export type HopRecord = {
  botId: string | null;
  sessionId: string | null;
  turnId: string | null;
  hop: number;
  /**
   * How the hop was tied to its turn: `signal` for a turn an earlier hop already matched, `only`
   * when its Bot had one running turn not yet matched, `trigger` when its trigger line picked one
   * of several, `ambiguous` when it could not (the scenario then fails), null when no Bot matched.
   */
  matchedBy: "signal" | "only" | "trigger" | "ambiguous" | null;
  /** False when nothing was scripted for it and the harness answered `end_turn`. */
  scripted: boolean;
  /** What the hop sent: system prompt, transcript and the turn's loop so far (see `requestText`). */
  request: CompletionRequest;
  reply: CompletionResult;
  at: string;
};

export type ToolCallRecord = {
  botId: string;
  sessionId: string | null;
  turnId: string | null;
  hop: number;
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** `isoNow()` when the engine started running it; null if it never did (a bounce, a turn that ended first). */
  dispatchedAt: string | null;
  /** Its approval card's state when it asked for one (`allowed_once` is the only one that runs it); null when it needed none. */
  approval: ApprovalStatus | null;
  /**
   * What it returned: read off the engine's `exited` event as it came back, so a refusal on a
   * turn's last hop is known too. A call that waited on an approval or an answer gets its outcome
   * from the next hop instead, which carries it back; null until one of the two shows it.
   */
  result: { ok: boolean | null; error: string | null } | null;
};

export type JudgeRecord = { kind: JudgeKind; botId: string | null; sessionId: string | null; scripted: boolean; answer: JudgeResult; at: string };

export type McpCallRecord = {
  /** The server's own name for the tool: `submit_video`. */
  tool: string;
  modelName: string;
  args: Record<string, unknown>;
  botId: string | null;
  turnId: string | null;
  at: string;
  /** Null while the call is out. */
  result: McpCallResult | null;
};

// ── Harness ─────────────────────────────────────────────────────────────────────────────────────

export type BotRef = string | { id: string };
export type SessionRef = string | { id: string };

export type ScenarioOptions = {
  /** How long a plan stays quiet after its last turn before the organizer files it. */
  settleQuietMs?: number;
  /** How long a Bot↔Bot direct stays quiet before its opener is called back. */
  directQuietMs?: number;
  /** How long a Bot's chain stays quiet before it is reviewed. */
  chainQuietMs?: number;
  /** How long a group plan with work left stays quiet before its last speaker is called back. */
  planLeftQuietMs?: number;
  /** Ticks the scheduler on its own this often (real ms). Absent, it ticks only on `tick()` / `advance()`. */
  tickMs?: number;
  /** Starts the media MCP server; `videoPolls` is how many `check_video` calls a job answers `running` first. */
  media?: boolean | { videoPolls?: number };
  locale?: "zh" | "en";
  ablation?: Ablation;
  /** Keeps the store in a file instead of memory, so `restart()` can boot a second engine on it. */
  durable?: boolean;
  /**
   * Takes the engine level up to holds (ADR 0040 P2), as a daemon does at boot once no installed
   * app older than the version gate shares its database; a store starts below it.
   */
  holds?: boolean;
  /** Takes the engine level up to work items (ADR 0040 P4b), which includes holds. */
  workItems?: boolean;
  /** Activates P4c's durable delegation and end-contract engine on this fixture only. */
  delegation?: boolean;
  /** Takes the engine level up to P4c's supervisor (ADR 0045), which includes delegation. */
  supervision?: boolean;
  /** Takes the engine level up to P4e's submissions and reviews (ADR 0046), which includes the supervisor. */
  submissions?: boolean;
  /** Takes the engine level up to P4d's external jobs (ADR 0047), which includes submissions. */
  jobs?: boolean;
  /** Takes the engine level up to P5's default models instead of a per-turn pick (ADR 0048), which includes jobs. */
  routing?: boolean;
  /** Takes the engine level up to P5's quality events and lessons instead of chain reviews (ADR 0050), which includes routing. */
  learning?: boolean;
  /** Overrides the shell's 10-minute timeout, so a command can run into it within a test. */
  shellTimeoutMs?: number;
};

export type Scenario = {
  /** The running daemon's store, engine and admission: after `restart()`, the new ones. */
  readonly store: Store;
  readonly engine: TurnEngine;
  readonly admission: TurnAdmission;
  /** The workspace root, a fresh temp dir removed on `close()`. */
  root: string;
  /** Everything the engine published, in order. */
  events: ClientEvent[];

  createBots: (...bots: Array<string | { name: string; duties?: string; boundaries?: string }>) => Bot[];
  /** Your direct with a Bot. */
  direct: (bot: BotRef) => string;
  group: (name: string, bots: BotRef[]) => string;
  /** A Bot↔Bot direct, opened from `origin` when given (the way a handoff opens one). */
  botDirect: (a: BotRef, b: BotRef, origin?: { sessionId: string; messageId: string }) => string;

  /** What a Bot answers on its turn hops: in `session` only, or anywhere when it is left out. */
  script: (bot: BotRef, session?: SessionRef) => Script<HopContext, CompletionResult>;
  /** What a side-call answers, optionally only for one Bot's judgement or one session. Unscripted ones answer "" and fail open. */
  judge: (kind: JudgeKind, filter?: { bot?: BotRef; session?: SessionRef }) => Script<JudgeContext, JudgeAnswer>;

  /** Posts your line the way the local API does, and returns it; what it wakes runs in the background. */
  postUser: (session: SessionRef, body: string, opts?: { parentId?: string; fork?: boolean }) => Message;
  /**
   * Posts a line in a Bot's name, the way a handoff or a Bot↔Bot opener lands, filed under a plan
   * (and ticket) when given, and routes it as a Bot's line; what it wakes runs in the background.
   * No turn wrote it: `turn_id` and `source_turn_id` are null, which no Bot's line in the app is.
   * What reads the turn behind a line treats it differently: the nod rule of a Bot↔Bot direct
   * (`isNodToANod`) never takes it, or an answer to it, for a nod; and its notification has no
   * turn, so in a group, where only a line your own line woke notifies you, it raises none. A
   * scenario that depends on either has a Bot's turn send the line with `send_message`.
   */
  postBot: (bot: BotRef, session: SessionRef, body: string, opts?: { taskId?: string | null; ticketId?: string | null }) => Message;
  /** Resolves once every line posted so far has been routed: filed, and every turn it opens started. */
  routed: () => Promise<void>;
  /**
   * Resolves once nothing is running and nothing is in flight, and it has stayed that way longer
   * than the longest quiet timer. A turn waiting on an ask or an approval counts as quiet. Past
   * `timeoutMs` it throws with what is still busy.
   */
  waitIdle: (opts?: { timeoutMs?: number }) => Promise<void>;
  /** Polls until `predicate` holds; for acting in the middle of a turn. */
  waitFor: (predicate: () => boolean, opts?: { timeoutMs?: number; what?: string }) => Promise<void>;
  /** One scheduler tick, now or at `at` (what the supervisor and due appointments are read against). */
  tick: (at?: Date) => void;
  /** Lets `ms` pass for check-backs and running turns (see the module header), then ticks. */
  advance: (ms: number) => void;

  /** Every tool call a Bot's model asked for, oldest first, optionally only one tool's. */
  toolCalls: (bot: BotRef, name?: string) => ToolCallRecord[];
  /**
   * Calls that ran and change something (see NO_SIDE_EFFECT), after `since` when given: not one
   * refused before it did anything (REFUSED), nor one whose approval you have not given.
   */
  sideEffectCalls: (bot: BotRef, since?: string | { created_at: string }) => ToolCallRecord[];
  /** Calls that reached the media server, oldest first. */
  mcpCalls: (bot?: BotRef) => McpCallRecord[];
  hops: (bot?: BotRef) => HopRecord[];
  unscripted: () => HopRecord[];
  judgeCalls: (kind?: JudgeKind) => JudgeRecord[];

  /** A session's messages in transcript order, threads included. */
  messages: (session: SessionRef) => Message[];
  /** A Bot's turns, oldest first. */
  turns: (bot: BotRef) => Turn[];
  /** A Bot's `turn_runs` rows (shell commands and MCP calls), oldest first. */
  runs: (bot: BotRef) => TurnRun[];
  /** The wakes a hold turned away (`wake.suppressed` in the work log), oldest first, a Bot's only when given. */
  suppressedWakes: (bot?: BotRef) => WorkEvent[];

  /**
   * Takes the daemon down and boots a new one on the same file (needs `durable`): `clean` as a quit
   * does, otherwise a crash (see the module header). `dev`: the new daemon runs the way `bun --watch`
   * does, so the restart reads as a development one. The new engine has said what the restart cut
   * off (ADR 0041), and its scheduler has ticked once.
   */
  restart: (opts: { clean: boolean; dev?: boolean }) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Longer than any one step of the engine takes here, and under bun's 5 s per-test default so the
 * reason for not going idle shows instead of bun's bare timeout. A scenario that needs more raises
 * both.
 */
const IDLE_TIMEOUT_MS = 4_000;
const POLL_MS = 5;
/** Slack on top of the longest quiet timer before quiet counts as idle. */
const IDLE_MARGIN_MS = 25;

const PROFILE_NAME = /# (?:人设|Profile)\n\n## (?:名字|Name)\n\n([^\n]+)/;

function textOf(content: CompletionRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** Every message of a hop's request as plain text, in order: what the model read on that hop. */
export function requestText(request: CompletionRequest): string {
  return request.messages.map((message) => textOf(message.content)).join("\n");
}

function judgeKindOf(request: JudgeRequest): JudgeKind {
  const system = textOf(request.messages.find((m) => m.role === "system")?.content ?? "");
  if (system === ORGANIZER_SYSTEM || system === ORGANIZER_SYSTEM_UNDER_HOLDS) return "organizer";
  if (system === SCRIBE_SYSTEM) return "scribe";
  if (system === JUDGEMENT_SYSTEM) return "judgement";
  if (system === ROUTE_PICK_SYSTEM) return "route_pick";
  if (system === ROUTE_REVIEW_SYSTEM) return "route_review";
  if (system === ROUTE_LEARN_SYSTEM) return "route_learn";
  if (system === COMPOSER_SUGGEST_SYSTEM) return "composer";
  return "other";
}

function isJudgeResult(answer: JudgeAnswer): answer is JudgeResult {
  return typeof answer === "object" && "hadToolCalls" in answer && "failKind" in answer;
}

function asJudgeResult(kind: JudgeKind, answer: JudgeAnswer): JudgeResult {
  if (typeof answer === "object" && isJudgeResult(answer)) return answer;
  const verdict = kind === "judgement" && (answer === "join" || answer === "pass") ? { decision: answer, reason: "scripted" } : answer;
  const content = typeof verdict === "string" ? verdict : JSON.stringify(verdict);
  return { content, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
}

/** Waits for a handler's answer, but gives up the way the real client does once the turn is stopped. */
function untilAborted<T>(value: T | Promise<T>, signal: AbortSignal, aborted: () => T): Promise<T> {
  if (!(value instanceof Promise)) return Promise.resolve(signal.aborted ? aborted() : value);
  if (signal.aborted) return Promise.resolve(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => resolve(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function createScenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const root = mkdtempSync(join(tmpdir(), "scenario-"));
  // Kept apart from the workspace: a file-backed store keeps its inbox beside the database.
  const dbDir = options.durable ? mkdtempSync(join(tmpdir(), "scenario-db-")) : null;
  let dbFile = dbDir ? join(dbDir, "state.sqlite") : null;
  // One key store for every store this scenario opens, as the keychain outlives a restart.
  const keys = memoryKeyStore();
  let store = new Store({ ...(dbFile ? { filename: dbFile } : {}), endpointKey: keys });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "scenario",
    endpoint_models: ["scenario"],
    endpoint_default_model: "scenario",
    ...(options.locale ? { locale: options.locale } : {}),
  });
  // Phase fixtures pin their own level rather than taking the database up to this build's: later
  // levels change the filing, wake and ending paths they exercise.
  const pinned = options.learning ? ENGINE_LEVELS.learning : options.routing ? ENGINE_LEVELS.routing : options.jobs ? ENGINE_LEVELS.jobs : options.submissions ? ENGINE_LEVELS.submissions : options.supervision ? ENGINE_LEVELS.supervision : options.delegation ? ENGINE_LEVELS.delegation : options.workItems ? ENGINE_LEVELS.work_items : options.holds ? ENGINE_LEVELS.holds : 0;
  if (pinned > 0) {
    for (const key of ["engine_level", "schema_min_compatible"]) {
      // A level may leave the floor where the one below set it (level 7's is 6): never above what this build reads.
      const value = key === "schema_min_compatible" ? Math.min(pinned, SCHEMA_LEVEL) : pinned;
      store.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
    }
  }

  // The Mac never sleeps in a scenario; a shell's timeout still has to fire, so it keeps real time.
  const wake: WakeWatch = {
    sleptBetween: () => 0,
    settled: () => true,
    untilSettled: async () => true,
    awakeTimeout(ms, fn) {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    stop: () => {},
  };

  const settleQuietMs = options.settleQuietMs ?? 20;
  const directQuietMs = options.directQuietMs ?? 40;
  const chainQuietMs = options.chainQuietMs ?? 40;
  const planLeftQuietMs = options.planLeftQuietMs ?? 40;
  const idleQuietMs = Math.max(settleQuietMs, directQuietMs, chainQuietMs, planLeftQuietMs) + IDLE_MARGIN_MS;

  const events: ClientEvent[] = [];
  const hopLog: HopRecord[] = [];
  const callLog: ToolCallRecord[] = [];
  const callsById = new Map<string, ToolCallRecord>();
  /** Each turn's call that started last, so an approval card finds the call it is for. */
  const startedByTurn = new Map<string, ToolCallRecord>();
  const approvalCalls = new Map<string, ToolCallRecord>();
  const judgeLog: JudgeRecord[] = [];
  const mcpLog: McpCallRecord[] = [];
  const turnScripts = new Map<string, Script<HopContext, CompletionResult>>();
  const judgeScripts = new Map<string, Script<JudgeContext, JudgeAnswer>>();
  /** A live turn's abort signal is the same object on every hop and on its MCP calls. */
  const signalTurns = new WeakMap<AbortSignal, { turnId: string; botId: string; sessionId: string }>();
  const mappedTurns = new Set<string>();
  const hopsByTurn = new Map<string, number>();
  /** Lines still being routed by the running engine; a restart starts a fresh set. */
  let inbound = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  let inflight = 0;
  let callSeq = 0;
  /** How far `advance` has moved time so far, in ms. */
  let advanced = 0;
  /** Hops whose handler is still out, and how far `advanced` may go before their time limit runs out. */
  const outstanding = new Set<{ until: number; expire: () => void }>();

  function botOf(ref: BotRef): Bot {
    if (typeof ref !== "string") return store.getBot(ref.id);
    try {
      return store.getBot(ref);
    } catch {
      return store.requireBotByName(ref);
    }
  }

  const sessionIdOf = (ref: SessionRef): string => (typeof ref === "string" ? ref : ref.id);

  /**
   * What the transcript line marked as this hop's trigger says, after the mark. The English system
   * prompt quotes the mark too, so only transcript lines count, and only where the mark heads a line.
   */
  function flaggedBodies(request: CompletionRequest): string[] {
    const mark = `${TRIGGER_FLAG}\n`;
    return request.messages.flatMap((m) => {
      if (m.role === "system") return [];
      const text = textOf(m.content);
      const at = text.indexOf(mark);
      return at === 0 || (at > 0 && text[at - 1] === "\n") ? [text.slice(at + mark.length)] : [];
    });
  }

  /** The running turn that made this hop: by its signal once seen, else by the Bot's running rows. */
  function turnOf(request: CompletionRequest): { bot: Bot | null; turn: Turn | null; matchedBy: HopRecord["matchedBy"] } {
    const seen = signalTurns.get(request.signal);
    if (seen) return { bot: store.getBot(seen.botId), turn: store.getTurn(seen.turnId), matchedBy: "signal" };
    const system = textOf(request.messages.find((m) => m.role === "system")?.content ?? "");
    const name = PROFILE_NAME.exec(system)?.[1];
    const bot = name ? store.findBotByName(name) : null;
    if (!bot) return { bot: null, turn: null, matchedBy: null };
    const running = store.listLiveTurns({ botId: bot.id }).filter((turn) => turn.status === "running");
    const fresh = running.filter((turn) => !mappedTurns.has(turn.id));
    const pool = fresh.length > 0 ? fresh : running;
    let turn: Turn | null = pool.length === 1 ? pool[0]! : null;
    let matchedBy: HopRecord["matchedBy"] = turn ? "only" : null;
    if (!turn && pool.length > 1) {
      // Two turns of one Bot at once: the trigger line this hop was opened on tells them apart. The
      // line carries the body as written, then attachments or annotations on lines of their own.
      const flagged = flaggedBodies(request);
      const byTrigger = pool.filter((row) => {
        let body: string;
        try {
          body = store.getMessage(row.trigger_message_id).body;
        } catch {
          return false;
        }
        return flagged.some((text) => text === body || text.startsWith(`${body}\n`));
      });
      if (byTrigger.length === 1) {
        turn = byTrigger[0]!;
        matchedBy = "trigger";
      } else {
        // Guessing would hand one turn's replies to the other and still pass, so the scenario fails.
        failures.push(
          new Error(
            `a hop of ${bot.name} matches ${byTrigger.length} of its running turns (${pool.map((row) => row.id).join(", ")}) by trigger line; ` +
              `open them with lines that differ, so neither body is the other's first line`,
          ),
        );
        return { bot, turn: null, matchedBy: "ambiguous" };
      }
    }
    if (turn) {
      signalTurns.set(request.signal, { turnId: turn.id, botId: bot.id, sessionId: turn.session_id });
      mappedTurns.add(turn.id);
    }
    return { bot, turn, matchedBy };
  }

  /** Files what the previous hop's calls returned onto their records, and hands them to the handler. */
  function outcomesOf(request: CompletionRequest): ToolOutcome[] {
    let lastAssistant = -1;
    request.messages.forEach((message, index) => {
      if (message.role === "assistant") lastAssistant = index;
    });
    const outcomes: ToolOutcome[] = [];
    request.messages.forEach((message, index) => {
      if (message.role !== "tool" || !message.tool_call_id) return;
      const content = textOf(message.content);
      let ok: boolean | null = null;
      let error: string | null = null;
      try {
        const parsed = JSON.parse(content) as { ok?: unknown; error?: { code?: unknown } };
        ok = typeof parsed.ok === "boolean" ? parsed.ok : null;
        error = typeof parsed.error?.code === "string" ? parsed.error.code : null;
      } catch {
        // a result the engine had to cut down is not JSON; its status is unknown here
      }
      const record = callsById.get(message.tool_call_id);
      if (record && !record.result) record.result = { ok, error };
      if (index > lastAssistant) outcomes.push({ id: message.tool_call_id, name: record?.name ?? "", ok, error, content });
    });
    return outcomes;
  }

  function nextStep<C, R>(scripts: Array<Script<C, R> | undefined>): Step<C, R> | null {
    for (const script of scripts) if (script && script.queue.length > 0) return script.queue.shift()!;
    for (const script of scripts) if (script?.handler) return script.handler;
    return null;
  }

  /**
   * A handler's answer, or `overtime` once `advance` has taken the hop past its `wallMs`: the
   * completions client ends an attempt that streams that long, and the stale sweep leaves a hop in
   * flight to it.
   */
  function withinLimit(value: CompletionResult | Promise<CompletionResult>, wallMs: number | undefined): CompletionResult | Promise<CompletionResult> {
    if (!(value instanceof Promise) || !wallMs) return value;
    return new Promise<CompletionResult>((resolve, reject) => {
      const entry = { until: advanced + wallMs, expire: () => resolve(failed("overtime")) };
      outstanding.add(entry);
      value.then(
        (result) => {
          outstanding.delete(entry);
          resolve(result);
        },
        (error: unknown) => {
          outstanding.delete(entry);
          reject(error);
        },
      );
    });
  }

  /** A step's answer, copied so a reply queued twice gets fresh call ids, with ids filled in. */
  function withIds(result: CompletionResult): CompletionResult {
    if (!result.ok || result.toolCalls.length === 0) return result;
    const toolCalls: ToolCall[] = result.toolCalls.map((row) => ({ ...row, id: row.id || `call_${++callSeq}` }));
    return { ...result, toolCalls };
  }

  const completions: CompletionsClient = {
    async complete(request) {
      inflight += 1;
      try {
        const { bot, turn, matchedBy } = turnOf(request);
        const hop = turn ? (hopsByTurn.get(turn.id) ?? 0) + 1 : 1;
        if (turn) hopsByTurn.set(turn.id, hop);
        const results = outcomesOf(request);
        const sessionId = turn?.session_id ?? null;
        // A hop it could not place takes nobody's script: whichever it took would be the wrong one half the time.
        const step = bot && matchedBy !== "ambiguous"
          ? nextStep([
              sessionId ? turnScripts.get(`${bot.id}|${sessionId}`) : undefined,
              turnScripts.get(`${bot.id}|*`),
            ])
          : null;
        const offersEndTurn = (request.tools as Array<{ function?: { name?: string } }>).some((row) => row.function?.name === "end_turn");
        // Nothing scripted: end the turn saying nothing, which wakes nobody and posts nothing.
        const fallback = offersEndTurn ? call(endTurn()) : say("");
        const answered = step === null
          ? fallback
          : typeof step === "function"
            ? await untilAborted(
                withinLimit(step({ bot: bot!, sessionId, turn, hop, request, results }), request.wallMs),
                request.signal,
                () => failed(),
              )
            : step;
        const reply = withIds(answered);
        const at = isoNow();
        hopLog.push({ botId: bot?.id ?? null, sessionId, turnId: turn?.id ?? null, hop, matchedBy, scripted: step !== null, request, reply, at });
        if (bot && reply.ok) {
          for (const row of reply.toolCalls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(row.arguments) as Record<string, unknown>;
            } catch {
              args = {};
            }
            const record: ToolCallRecord = {
              botId: bot.id,
              sessionId,
              turnId: turn?.id ?? null,
              hop,
              id: row.id,
              name: row.name,
              args,
              dispatchedAt: null,
              approval: null,
              result: null,
            };
            callLog.push(record);
            callsById.set(row.id, record);
          }
        }
        return reply;
      } finally {
        inflight -= 1;
      }
    },
    async judge(request) {
      inflight += 1;
      try {
        const kind = judgeKindOf(request);
        let payload: unknown = null;
        try {
          payload = JSON.parse(textOf(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""));
        } catch {
          payload = null;
        }
        const fields = (payload ?? {}) as { you?: { name?: unknown }; session?: { id?: unknown } };
        const bot = kind === "judgement" && typeof fields.you?.name === "string" ? store.findBotByName(fields.you.name) : null;
        const sessionId = typeof fields.session?.id === "string" ? fields.session.id : null;
        const step = nextStep([
          bot && sessionId ? judgeScripts.get(`${kind}|${bot.id}|${sessionId}`) : undefined,
          bot ? judgeScripts.get(`${kind}|${bot.id}|*`) : undefined,
          sessionId ? judgeScripts.get(`${kind}|*|${sessionId}`) : undefined,
          judgeScripts.get(`${kind}|*|*`),
        ]);
        const raw = step === null ? "" : typeof step === "function" ? await step({ kind, request, payload, bot, sessionId }) : step;
        const answer = asJudgeResult(kind, raw);
        judgeLog.push({ kind, botId: bot?.id ?? null, sessionId, scripted: step !== null, answer, at: isoNow() });
        return answer;
      } finally {
        inflight -= 1;
      }
    },
  };

  if (options.media) {
    const polls = typeof options.media === "object" ? (options.media.videoPolls ?? 0) : 0;
    store.createMcpServerSync({
      name: MEDIA_SERVER,
      command: process.execPath,
      args: [MCP_FIXTURE, "--media", ...(polls > 0 ? [`--video-polls=${polls}`] : [])],
      enabled: true,
    });
  }

  /** The daemon's own MCP host over the media server; only `call` is wrapped, to log what reached the server and for whom. */
  function mediaHost(): McpHost {
    const host = createMcpHost({
      listServers: () => store.listMcpServers(),
      authFor: (id) => store.mcpAuth(id),
      builtinNames: COLLAB_TOOL_NAMES,
      shutdownWaitMs: 200,
    });
    return {
      ...host,
      async call(modelName, args, signal) {
        const owner = signal ? signalTurns.get(signal) : undefined;
        const record: McpCallRecord = {
          tool: modelName.replace(`mcp_${MEDIA_SERVER}_`, ""),
          modelName,
          args,
          botId: owner?.botId ?? null,
          turnId: owner?.turnId ?? null,
          at: isoNow(),
          result: null,
        };
        mcpLog.push(record);
        inflight += 1;
        try {
          record.result = await host.call(modelName, args, signal);
          return record.result;
        } finally {
          inflight -= 1;
        }
      },
    };
  }

  function buildEngine(host: McpHost | undefined, gate: TurnAdmission): TurnEngine {
    return createTurnEngine({
      store,
      publish(event) {
        events.push(event);
        if (event.event === "turn.tool" && event.phase === "started") {
          const record = callsById.get(event.id);
          if (record && !record.dispatchedAt) {
            record.dispatchedAt = isoNow();
            startedByTurn.set(event.turn_id, record);
          }
        } else if (event.event === "turn.tool" && event.phase === "exited" && event.ok !== undefined) {
          const record = callsById.get(event.id);
          if (record && !record.result) record.result = { ok: event.ok, error: event.error_code ?? null };
        } else if (event.event === "approval.upsert") {
          // A card goes up right after the call that asked for it, before the turn starts another.
          const record = approvalCalls.get(event.id) ?? (event.status === "pending" ? startedByTurn.get(event.turn_id) : undefined);
          if (record) {
            record.approval = event.status;
            approvalCalls.set(event.id, record);
          }
        }
      },
      completions,
      mcp: host,
      admission: gate,
      wake,
      settleQuietMs,
      directQuietMs,
      chainQuietMs,
      planLeftQuietMs,
      ...(options.ablation ? { ablation: options.ablation } : {}),
      ...(options.shellTimeoutMs !== undefined ? { shellTimeoutMs: options.shellTimeoutMs } : {}),
    });
  }

  // Ticks only when told to, unless the scenario asked for a real interval: an interval longer
  // than any scenario runs stands in for "never" (setInterval treats anything past 2^31-1 as 1).
  function buildScheduler(): Scheduler {
    return startScheduler({
      store,
      engine,
      intervalMs: options.tickMs ?? 2 ** 31 - 1,
      wake,
    });
  }

  let mcp = options.media ? mediaHost() : undefined;
  let admission = new TurnAdmission();
  let engine = buildEngine(mcp, admission);
  let scheduler = buildScheduler();

  /**
   * Time passing, for what the scheduler reads: appointments still to come fall due `ms` sooner,
   * and running turns last did something `ms` earlier. See the module header for what is not aged.
   */
  function age(ms: number): void {
    const earlier = (iso: string): string => new Date(Date.parse(iso) - ms).toISOString();
    store.transaction(() => {
      const due = store.db
        .query<{ id: string; due_at: string }, []>(`SELECT id, due_at FROM check_backs WHERE fired_at IS NULL AND voided_at IS NULL`)
        .all();
      for (const row of due) store.db.run(`UPDATE check_backs SET due_at = ? WHERE id = ?`, [earlier(row.due_at), row.id]);
      for (const turn of store.listLiveTurns()) {
        if (turn.status !== "running") continue;
        store.db.run(`UPDATE turns SET last_activity_at = ? WHERE id = ?`, [earlier(turn.last_activity_at), turn.id]);
      }
      // External jobs (ADR 0047): the next ask falls due sooner, and the job is older.
      if (store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_jobs'").get()) {
        for (const job of store.db.query<{ id: string; next_poll_at: string; created_at: string }, []>(
          "SELECT id, next_poll_at, created_at FROM external_jobs WHERE state = 'pending'").all()) {
          store.db.run("UPDATE external_jobs SET next_poll_at = ?, created_at = ? WHERE id = ?", [earlier(job.next_poll_at), earlier(job.created_at), job.id]);
        }
      }
    });
  }

  function busy(): string | null {
    if (inflight > 0) return `${inflight} model or MCP call(s) in flight`;
    if (inbound.size > 0) return `${inbound.size} line(s) still being routed`;
    const running = store.listLiveTurns().filter((turn) => turn.status === "running");
    if (running.length > 0) return `running turns: ${running.map((turn) => `${botOf({ id: turn.bot_id }).name}@${turn.id}`).join(", ")}`;
    // A turn parked on your answer or approval has a runner waiting on you, not on the engine.
    const unsettled = engine.unsettledTurnIds().filter((id) => {
      try {
        const status = store.getTurn(id).status;
        return status !== "waiting_ask" && status !== "waiting_approval";
      } catch {
        return true;
      }
    });
    if (unsettled.length > 0) return `unsettled turns: ${unsettled.join(", ")}`;
    const pending = engine.pendingJudgements();
    if (pending.length > 0) return `${pending.length} pending judgement(s)`;
    // An acceptance check the app is running (a file read, a command, ffprobe) is not a model call.
    const checking = store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM acceptance_check_runs WHERE finished_at IS NULL`).get()!.n;
    if (checking > 0) return `${checking} acceptance check run(s) in flight`;
    return null;
  }

  function rethrow(): void {
    if (failures.length > 0) throw failures[0];
  }

  /** Routes a stored line through the running engine; a line the engine fails on fails the scenario. */
  function route(message: Message, opts: { fork?: boolean; fromUser: boolean }): void {
    const routed = engine.handleInboundMessage(message, opts);
    // A line the crashed engine was still routing belongs to that process, not to this one.
    const routing = inbound;
    routing.add(routed);
    routed.then(
      () => routing.delete(routed),
      (error: unknown) => {
        if (routing.delete(routed) && routing === inbound) failures.push(error);
      },
    );
  }

  /** What `runtime.ts` does with a store it has just opened, before and after the engine exists. */
  function boot(filename: string, dev: boolean): void {
    store = new Store({ filename, endpointKey: keys });
    store.recoverInterruptedTurns();
    store.recoverInterruptedCheckRuns();
    inbound = new Set();
    mcp = options.media ? mediaHost() : undefined;
    admission = new TurnAdmission();
    engine = buildEngine(mcp, admission);
    engine.announceRestart(classifyRestart(store.previousShutdown, { execArgv: dev ? ["--watch"] : [], env: {} }));
    scheduler = buildScheduler();
    engine.sweepStaleChains();
  }

  const scenario: Scenario = {
    get store() {
      return store;
    },
    get engine() {
      return engine;
    },
    get admission() {
      return admission;
    },
    root,
    events,

    createBots(...bots) {
      return bots.map((spec) => {
        const input = typeof spec === "string" ? { name: spec } : spec;
        return store.createBot({
          name: input.name,
          duties: input.duties ?? `${input.name} 的职责`,
          boundaries: input.boundaries ?? "只在工作区里干活",
        }).bot;
      });
    },
    direct(bot) {
      return store.createDirect(USER_MEMBER, botOf(bot).id).id;
    },
    group(name, bots) {
      return store.createGroup({ name, members: bots.map((bot) => botOf(bot).id) }).id;
    },
    botDirect(a, b, origin) {
      return store.createBotDirect(botOf(a).id, botOf(b).id, origin ?? null).id;
    },

    script(bot, session) {
      const key = `${botOf(bot).id}|${session ? sessionIdOf(session) : "*"}`;
      let script = turnScripts.get(key);
      if (!script) {
        script = new Script<HopContext, CompletionResult>();
        turnScripts.set(key, script);
      }
      return script;
    },
    judge(kind, filter) {
      const key = `${kind}|${filter?.bot ? botOf(filter.bot).id : "*"}|${filter?.session ? sessionIdOf(filter.session) : "*"}`;
      let script = judgeScripts.get(key);
      if (!script) {
        script = new Script<JudgeContext, JudgeAnswer>();
        judgeScripts.set(key, script);
      }
      return script;
    },

    postUser(session, body, opts) {
      admission.assertNew();
      const sessionId = sessionIdOf(session);
      const message = store.transaction(() => store.postMessage(sessionId, { body, parent_id: opts?.parentId ?? null }));
      events.push({ event: "message.created", occurred_at: new Date().toISOString(), ...message });
      route(message, { fork: opts?.fork, fromUser: true });
      return message;
    },
    postBot(bot, session, body, opts) {
      admission.assertNew();
      const author = botOf(bot).id;
      const sessionId = sessionIdOf(session);
      const message = store.transaction(() => {
        const inserted = store.insertMessage({ sessionId, kind: "bot", author, body });
        if (!opts?.taskId) return inserted;
        store.db.run(`UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?`, [opts.taskId, opts.ticketId ?? null, inserted.id]);
        return store.getMessage(inserted.id);
      });
      events.push({ event: "message.created", occurred_at: new Date().toISOString(), ...message });
      route(message, { fromUser: false });
      return message;
    },
    async routed() {
      while (inbound.size > 0) {
        await Promise.allSettled([...inbound]);
        rethrow();
      }
      rethrow();
    },
    async waitIdle(opts) {
      const deadline = Date.now() + (opts?.timeoutMs ?? IDLE_TIMEOUT_MS);
      let quietSince: number | null = null;
      while (true) {
        rethrow();
        const reason = busy();
        const now = Date.now();
        if (reason) quietSince = null;
        else if (quietSince === null) quietSince = now;
        else if (now - quietSince >= idleQuietMs) return;
        if (now > deadline) throw new Error(`scenario never went idle: ${reason ?? "quiet, but not for long enough"}`);
        await Bun.sleep(POLL_MS);
      }
    },
    async waitFor(predicate, opts) {
      const deadline = Date.now() + (opts?.timeoutMs ?? IDLE_TIMEOUT_MS);
      while (!predicate()) {
        rethrow();
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts?.what ?? "a condition"}; ${busy() ?? "nothing is running"}`);
        await Bun.sleep(POLL_MS);
      }
    },
    tick(at) {
      scheduler.tick(at);
    },
    advance(ms) {
      advanced += ms;
      for (const entry of [...outstanding]) {
        if (advanced < entry.until) continue;
        outstanding.delete(entry);
        entry.expire();
      }
      age(ms);
      scheduler.tick();
    },

    toolCalls(bot, name) {
      const id = botOf(bot).id;
      return callLog.filter((row) => row.botId === id && (name === undefined || row.name === name));
    },
    sideEffectCalls(bot, since) {
      const id = botOf(bot).id;
      const after = since === undefined ? null : typeof since === "string" ? since : since.created_at;
      return callLog.filter(
        (row) =>
          row.botId === id &&
          row.dispatchedAt !== null &&
          !NO_SIDE_EFFECT.has(row.name) &&
          (row.approval === null || row.approval === "allowed_once") &&
          !(row.result?.ok === false && row.result.error !== null && REFUSED.has(row.result.error)) &&
          (after === null || row.dispatchedAt > after),
      );
    },
    mcpCalls(bot) {
      const id = bot === undefined ? null : botOf(bot).id;
      return mcpLog.filter((row) => id === null || row.botId === id);
    },
    hops(bot) {
      const id = bot === undefined ? null : botOf(bot).id;
      return hopLog.filter((row) => id === null || row.botId === id);
    },
    unscripted() {
      return hopLog.filter((row) => !row.scripted);
    },
    judgeCalls(kind) {
      return judgeLog.filter((row) => kind === undefined || row.kind === kind);
    },

    messages(session) {
      return store.db
        .query<{ id: string }, [string]>(`SELECT id FROM messages WHERE session_id = ? ORDER BY message_seq, created_at, rowid`)
        .all(sessionIdOf(session))
        .map((row) => store.getMessage(row.id));
    },
    turns(bot) {
      return store.db
        .query<{ id: string }, [string]>(`SELECT id FROM turns WHERE bot_id = ? ORDER BY created_at, rowid`)
        .all(botOf(bot).id)
        .map((row) => store.getTurn(row.id));
    },
    runs(bot) {
      return store.db
        .query<TurnRun, [string]>(`SELECT * FROM turn_runs WHERE bot_id = ? ORDER BY created_at, rowid`)
        .all(botOf(bot).id);
    },
    suppressedWakes(bot) {
      const id = bot === undefined ? null : botOf(bot).id;
      return store.listWorkEvents({ kind: "wake.suppressed" }).filter((row) => id === null || row.bot_id === id);
    },

    async restart({ clean, dev = false }) {
      if (!dbFile || !dbDir) throw new Error("restart() needs createScenario({ durable: true })");
      scheduler.stop();
      let reopen = dbFile;
      if (clean) {
        // runtime.ts's stop(): the flag first, then the engine drains, then what is still live is interrupted.
        store.recordCleanShutdown();
        await engine.close();
        store.interruptRunningTurns((turnId) => engine.executionOf(turnId));
        store.close();
      } else {
        // Nothing the dying process does from here on reaches the disk the next boot reads.
        reopen = join(dbDir, `crash-${crypto.randomUUID()}.sqlite`);
        store.db.run(`VACUUM INTO ?`, [reopen]);
        engine.abortAll();
        await engine.close();
        store.close();
      }
      dbFile = reopen;
      boot(reopen, dev);
    },
    async close() {
      scheduler.stop();
      engine.abortAll();
      await engine.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
      if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    },
  };
  return scenario;
}
