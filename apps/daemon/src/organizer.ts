/**
 * The organizer (整理跳), engine side.
 *
 * Two moments. After the user speaks and before any turn opens, one short call files the line:
 * does it continue the session's current plan, start another, or go back to an earlier one; what
 * the plan is for now; which tickets exist and which one this line is about. The message is
 * stamped with the answer, so every turn it opens — a mention, a judgement that joined, a fork —
 * lands in the same plan and ticket. Once a plan's turns have all ended and it has been quiet for
 * a moment, a second call files what was handed over: ticket states, workers, progress. A settle
 * only ever files that handover: the goal and what each ticket is for stay as they were, whatever
 * it answers. It has no line of yours to go on; yours are filed, and noted by the scribe, when you
 * say them. Neither call writes the rules or Done when any more (ADR 0042): whatever the answer
 * says, a plan keeps its own (`filedSpec` in store/plan-spec.ts), and what you ask is noted by the
 * scribe (scribe.ts) into the requirements ledger.
 *
 * It fails open. No default model, a refused call, an unreadable answer, a store that refuses the
 * change: the plan stays as it was and turns open where they would have anyway, and the log says
 * which of those it was. The call is billed as its own spend kind so the cost of keeping plans in
 * order is visible.
 *
 * The plan's spec and tickets are mirrored into the workspace as `map.md` and `ticket.md`, the
 * app's own files, so a Bot can read the whole thing and a person can browse it.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { USER_MEMBER, traceNodeSaidNothing, type AcceptanceCheck, type ApiFormat, type AcceptanceCheckOutcome, type Message, type OrganizerRun, type ThinkingLevel, type Ticket, type Turn } from "@real-bot/protocol";
import { NO_ABLATION, type Ablation } from "./ablation";
import { describeCheck } from "./acceptance-eval";
import type { CompletionsClient, MappedUsage } from "./completions";
import { HttpError } from "./errors";
import { atomicWrite } from "./file-integrity";
import { organizerPayload, parseOrganizerResult } from "./prompts/organizer";
import { promptPage } from "./prompts/book";
import { derivedNotGate, parsePlanSpec, PLAN_MAP_FILE, TICKET_FILE, type OrganizerResult, type PlanSpec, type Store, type Task } from "./store";
import { ENGINE_LEVELS } from "./store/schema-gate";
import { classifyPath } from "./workspace-paths";

/**
 * Everything `call()` knows about one organizer call before its filing's fate is decided: the
 * model's raw answer, what it could have picked from and what it actually picked. The caller adds
 * the last piece — whether the filing landed, and where — and hands the whole thing to
 * `finishOrganizerRun` exactly once (`store.recordOrganizerRun` has no update path).
 */
type PendingOrganizerRun = {
  sessionId: string;
  taskId: string | null;
  mode: "message" | "settle";
  messageId: string | null;
  spendId: string | null;
  rawAnswer: string | null;
  failKind: string | null;
  decision: OrganizerRun["decision"];
  candidatesPayload: OrganizerRun["candidates_payload"];
  candidatesApply: OrganizerRun["candidates_apply"];
  candidatesAtParse: OrganizerRun["candidates_at_parse"];
  downgradeReason: string | null;
};

/** Records one organizer run. Best-effort, like the spend ledger: a write that fails does not undo the filing it describes. */
function finishOrganizerRun(
  store: Store,
  pending: PendingOrganizerRun,
  outcome: { applied: boolean; rejectReason: string | null; held: string[] | null; appliedTaskId: string | null; appliedTicketId: string | null },
): void {
  try {
    store.recordOrganizerRun({ ...pending, ...outcome });
  } catch {
    // observability only; the filing it describes already happened (or didn't) either way
  }
}

export type OrganizerRouting = {
  baseUrl: string;
  apiKey: string;
  apiFormat: ApiFormat;
  workspaceId: string | null;
  providerId: string;
  providerName: string;
  model: string;
  thinkingLevel: ThinkingLevel | null;
};

export type OrganizerDeps = {
  store: Store;
  completions: CompletionsClient;
  /** The default endpoint's default model, resolved when a call is about to be made. */
  routing: () => Promise<OrganizerRouting | null>;
  /** Returns the ledger row's id it billed the call as, or null when nothing was billable (see `engine/spend.ts`). */
  recordSpend: (input: { sessionId: string; target: OrganizerRouting; usage: MappedUsage | null; responded: boolean }) => string | null;
  draining: () => boolean;
  /** How long a plan has to be quiet after its last turn before it is filed. Tests shorten it. */
  settleQuietMs?: number;
  /** Where a filing that came to nothing says why. Defaults to stderr. */
  log?: (line: string) => void;
  /**
   * A plan's quiet clock ran out and its settle is over, whether it filed anything or not: the
   * engine checks whether the plan stopped with work left, tickets still open or, in a group, work
   * its progress still lists (see `reconcilePlan` in engine/plan-watch.ts).
   */
  onQuiet?: (taskId: string) => void;
  /**
   * The plan's acceptance checks, run around its settle: stale ones before (so the settle sees
   * their result), unrun ones after (so a check the settle itself just added still gets a run this
   * stretch). Absent skips both — tests that do not care about checks, mainly.
   */
  checks?: {
    beforeSettle: (taskId: string) => Promise<void>;
    afterSettle: (taskId: string) => Promise<void>;
  };
  /** Benchmark switches (see `ablation.ts`): `organize-message` / `organize-settle` skip that call. */
  ablation?: Ablation;
};

export type Organizer = {
  /** Files a user message; resolves to where the turns it opens should land. Never rejects. */
  organizeMessage(message: Message): Promise<{ taskId: string | null; ticketId: string | null }>;
  /** A turn reached a terminal state other than a Stop: its plan is filed once it has been quiet for a moment. */
  noteTurnEnded(turn: Turn): void;
  /**
   * A turn was stopped: the settle an earlier turn of its plan armed is dropped, and a quiet
   * stretch of that plan already under way calls nobody back when it ends. Other plans keep theirs.
   */
  noteTurnStopped(turn: Turn): void;
  /**
   * Files a plan now, if nothing is running in it and something happened since the last version.
   * `evidence: true` skips that "something happened" guard and drops the answer's own `checks` —
   * it exists only to give a `done` held open for lack of a check run a fresh look once that run
   * has landed (see `quietStretch`), never to let the organizer touch checks a second time.
   */
  settlePlan(taskId: string, opts?: { evidence?: boolean }): Promise<boolean>;
  renderMirrors(taskId: string): void;
  /**
   * The plan was set aside (its conversation cleared or deleted, ADR 0040): the settle its last turn
   * armed is dropped, and a quiet stretch of it already under way calls nobody back when it ends.
   */
  forgetPlan(taskId: string): void;
  clearTimers(): void;
};

/**
 * How long a message's filing may take, answer included: the call does not stream. The turns the
 * line opens wait on it, and the Bots it wakes already show as thinking meanwhile. Twenty seconds
 * cut off real answers — a reasoning model spent nineteen of them before its first word.
 */
export const ORGANIZER_TIMEOUT_MS = 60_000;
/** A settle has nobody waiting on it. */
export const ORGANIZER_SETTLE_TIMEOUT_MS = 120_000;
/**
 * Room for the plan and its tickets. A short call's default is sized for a verdict, and 256 tokens
 * stopped every plan partway through its JSON, so nothing was ever filed.
 */
export const ORGANIZER_MAX_TOKENS = 4096;
/** Quiet time after a plan's last turn before it is filed, so a fan-out is filed once. */
export const SETTLE_QUIET_MS = 30_000;
/** Whether the plan and its tickets are rendered into the workspace. */
export const MIRROR_FILES = true;
/** Turns of the plan the organizer sees as "so far". */
const TRACE_LIMIT = 12;

const STOP_CUE = /停下|停掉|停止|停一下|停手|停工|暂停|叫停|没停|先停|都停|全停|中止|终止|别再生成|不要再生成|别再做|不要再做|别做了|不要做了|先别做|别弄了|\b(?:stop|stopped|pause|halt)\b|hold off/i;
const GO_ON_CUE = /继续|接着|恢复|重新开始|往下做|别停|不要停|不用停|开工|\b(?:continue|resume|unpause|keep going|go on|carry on)\b|don'?t stop/i;

/**
 * A line that asks the Bots to stop, or tells them they have not stopped (「停下你所有的工作」
 * 「私聊里的也停掉」「你私聊里的没停」). One that also says to go on (「停了的接着做」「不要停」)
 * does not, and neither does 「别再 / 不要再 + what」: that is a requirement
 * (「别再用冻帧补时长」), not a stop. Only read below the engine level that brings holds; from
 * there the control-line reader (control-line.ts) decides what a stop is, and a hold, not the
 * organizer, keeps a stopped plan parked (ADR 0041).
 */
export function asksToStop(body: string): boolean {
  return STOP_CUE.test(body) && !GO_ON_CUE.test(body);
}

export function createOrganizer(deps: OrganizerDeps): Organizer {
  const store = deps.store;
  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const chains = new Map<string, Promise<unknown>>();
  const log = deps.log ?? ((line: string) => console.error(line));
  const ablation = deps.ablation ?? NO_ABLATION;
  /**
   * Holds are on (ADR 0041): a stop is the app's to carry out and a hold's to keep, so the organizer
   * is told nothing about stopping and its answers are not second-guessed for it. Below that level
   * the organizer's own stop handling from before holds is all there is.
   */
  const holdsOn = (): boolean => store.capabilities().engine_level >= ENGINE_LEVELS.holds;
  /**
   * Plans a filing held `done` open only for lack of a run yet on some check (never a failed one):
   * the quiet stretch that set this runs the check once more (`afterSettle`) and, once, files the
   * plan again so the organizer's `done` gets a fresh look at real evidence instead of waiting for
   * the next thing to happen in the plan.
   */
  const awaitingEvidence = new Set<string>();
  /**
   * Set when the engine clears the timers (draining, quitting, closing): a settle still in flight
   * must not call back into an engine that is going away. The next turn end clears it, since a
   * cancelled drain carries on.
   */
  let stopped = false;
  /**
   * How many Stops each plan has seen. A quiet stretch notes the count when it starts and calls
   * `onQuiet` only if no Stop came since: the call-back after it would put stopped work back in
   * progress (ADR 0040 P1).
   */
  const stopsSeen = new Map<string, number>();

  /** Set aside with its conversation's history (ADR 0040), or gone: either way nothing is filed into it. */
  function isDormant(taskId: string): boolean {
    try {
      return Boolean(store.getTask(taskId).dormant_since);
    } catch {
      return true;
    }
  }

  /**
   * The plan's last cards as the organizer reads them: who, and what they said. A Bot's turn that
   * said nothing is said to have said nothing — its summary is the line that woke it, which read as
   * the Bot saying 「（应用）用户把交付…退回」 itself — and one that only handed over files says so.
   */
  function traceLines(taskId: string): string[] {
    try {
      return store
        .taskTrace(taskId)
        .nodes.slice(-TRACE_LIMIT)
        .map((node) => {
          if (node.actor === USER_MEMBER) return `【user】${node.summary}`;
          const who = nameOf(node.actor);
          if (traceNodeSaidNothing(node)) return `【${who}】（这一轮没说话，状态 ${node.status}）`;
          if (!node.summary && node.artifacts.length > 0) return `【${who}】（只交出 ${node.artifacts.length} 个文件）`;
          return `【${who}】${node.summary}`;
        });
    } catch {
      return [];
    }
  }

  function nameOf(id: string): string {
    try {
      return store.getBot(id).name;
    } catch {
      return id;
    }
  }

  /**
   * One organizer call, message or settle. Returns null for every way it can come to nothing —
   * no routing, a throw, a failed or truncated or unreadable answer — and records why in
   * `organizer_runs` for all but the first (there was no call yet to record). A parsed answer is
   * not itself a filing: the caller still decides whether it applies, and records that outcome
   * itself once it knows it, onto the `pending` row this returns.
   */
  async function call(input: {
    mode: "message" | "settle";
    sessionId: string;
    message: Message | null;
    current: Task | null;
  }): Promise<{ parsed: OrganizerResult; pending: PendingOrganizerRun } | null> {
    const routing = await deps.routing();
    if (!routing || deps.draining()) return null;
    const payload = organizerPayload(store, {
      mode: input.mode,
      sessionId: input.sessionId,
      message: input.message,
      current: input.current,
      trace: input.current ? traceLines(input.current.id) : [],
    });
    // Which filing this was, for the line that says why it came to nothing.
    const what = input.mode === "message" ? `message ${input.message?.id}` : `plan ${input.current?.id}`;
    const base = {
      sessionId: input.sessionId,
      taskId: input.current?.id ?? null,
      mode: input.mode,
      messageId: input.message?.id ?? null,
      candidatesPayload: {
        recent_plan_ids: payload.recent_plans.map((plan) => plan.id),
        elsewhere_plan_ids: payload.elsewhere_plans.map((plan) => plan.id),
        existing_check_ids: payload.current_plan?.checks.map((check) => check.id) ?? [],
      },
    };
    // Your version of the organizer's prompt when you edited it (ADR 0064); its answer format stays fixed.
    const prompt = promptPage(store, "zh").resolve("call.organizer");
    let result;
    try {
      result = await deps.completions.judge({
        baseUrl: routing.baseUrl,
        apiKey: routing.apiKey,
        apiFormat: routing.apiFormat,
        workspaceId: routing.workspaceId,
        model: routing.model,
        prompt: prompt.ref,
        messages: [
          { role: "system", content: prompt.text },
          { role: "user", content: JSON.stringify(payload) },
        ],
        signal: new AbortController().signal,
        timeoutMs: input.mode === "message" ? ORGANIZER_TIMEOUT_MS : ORGANIZER_SETTLE_TIMEOUT_MS,
        maxTokens: ORGANIZER_MAX_TOKENS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[organizer] filing ${what}: the call threw, nothing filed: ${message}`);
      finishOrganizerRun(
        store,
        { ...base, spendId: null, rawAnswer: null, failKind: "call_error", decision: null, candidatesApply: null, candidatesAtParse: null, downgradeReason: null },
        { applied: false, rejectReason: `the call threw: ${message}`, held: null, appliedTaskId: null, appliedTicketId: null },
      );
      return null;
    }
    let spendId: string | null = null;
    try {
      spendId = deps.recordSpend({
        sessionId: input.sessionId,
        target: routing,
        usage: result.usage,
        responded: result.failKind === null || result.failKind === "incomplete",
      });
    } catch {
      // the ledger is best-effort; the answer still counts
    }
    // Every way this comes to nothing is said, not swallowed: a filing that never lands looks,
    // from the board, exactly like one that has not been tried.
    if (result.failKind && result.failKind !== "incomplete") {
      log(`[organizer] filing ${what}: the call failed (${result.failKind}), nothing filed`);
      finishOrganizerRun(
        store,
        { ...base, spendId, rawAnswer: result.content ?? null, failKind: result.failKind, decision: null, candidatesApply: null, candidatesAtParse: null, downgradeReason: null },
        { applied: false, rejectReason: `the call failed (${result.failKind})`, held: null, appliedTaskId: null, appliedTicketId: null },
      );
      return null;
    }
    // A cut-off plan is not a shorter plan: its tickets and progress would be whatever fit.
    if (result.truncated) {
      log(`[organizer] filing ${what}: the answer stopped at the ${ORGANIZER_MAX_TOKENS}-token cap, nothing filed`);
      finishOrganizerRun(
        store,
        { ...base, spendId, rawAnswer: result.content ?? null, failKind: "truncated", decision: null, candidatesApply: null, candidatesAtParse: null, downgradeReason: null },
        { applied: false, rejectReason: `the answer stopped at the ${ORGANIZER_MAX_TOKENS}-token cap`, held: null, appliedTaskId: null, appliedTicketId: null },
      );
      return null;
    }
    // Read once, right before validating the answer against them, so the run row can show whether
    // they had shifted since the payload was built (the resume/join race: a target that stops
    // qualifying while the call is out files nothing, see `organizeOne`).
    const recentPlanIds = new Set(store.sessionRecentTasks(input.sessionId).map((task) => task.id));
    const elsewherePlanIds = new Set(input.mode === "message" ? store.elsewherePlans(input.sessionId).map((task) => task.id) : []);
    const existingCheckIds = new Set(input.current ? store.listChecks(input.current.id).map((check) => check.id) : []);
    const candidatesAtParse: OrganizerRun["candidates_at_parse"] = {
      recent_plan_ids: [...recentPlanIds],
      elsewhere_plan_ids: [...elsewherePlanIds],
      existing_check_ids: [...existingCheckIds],
    };
    const parsed = parseOrganizerResult(result.content ?? "", {
      mode: input.mode,
      recentPlanIds,
      elsewherePlanIds,
      roster: store.listBots().map((bot) => ({ id: bot.id, name: bot.name })),
      existingCheckIds,
    });
    if (!parsed) {
      log(`[organizer] filing ${what}: the answer did not read as a plan, nothing filed`);
      store.notePromptParseFailure({ prompt: prompt.ref.id, locale: prompt.ref.locale, revision: prompt.ref.revision_id, reason: "unparseable", sessionId: input.sessionId, taskId: input.current?.id ?? null });
      finishOrganizerRun(
        store,
        { ...base, spendId, rawAnswer: result.content ?? null, failKind: "unparseable", decision: null, candidatesApply: null, candidatesAtParse, downgradeReason: null },
        { applied: false, rejectReason: "the answer did not read as a plan", held: null, appliedTaskId: null, appliedTicketId: null },
      );
      return null;
    }
    const pending: PendingOrganizerRun = {
      ...base,
      spendId,
      rawAnswer: result.content ?? null,
      failKind: null,
      decision: parsed.decision,
      // The answer's own picks, before validation — what it actually asked for, not what survived.
      candidatesApply: {
        decision: parsed.raw?.decision ?? "",
        resume_plan_id: parsed.raw?.resumePlanId ?? null,
        join_plan_id: parsed.raw?.joinPlanId ?? null,
        ticket_ids: parsed.tickets.map((ticket) => ticket.id),
        message_ticket: parsed.raw?.messageTicket ?? null,
        check_ids: (parsed.checks ?? []).map((check) => check.id),
      },
      candidatesAtParse,
      downgradeReason: parsed.downgradeReason ?? null,
    };
    return { parsed, pending };
  }

  /** The parked plan an answer would put back to work: the one it resumes, joins or continues. */
  function parkedPlanReopened(parsed: OrganizerResult, current: Task | null): string | null {
    if (parsed.spec.status === "parked") return null;
    const id =
      parsed.decision === "resume" ? parsed.resumePlanId
      : parsed.decision === "join" ? (parsed.joinPlanId ?? null)
      : parsed.decision === "continue" ? (current?.id ?? null)
      : null;
    if (!id) return null;
    try {
      return store.getTask(id).status === "parked" ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * A plan called done over open tickets stays active; the log says which tickets kept it, and the
   * same note (without the `[organizer] plan …:` prefix) goes on the run row's `held`.
   */
  function noteHeldOpen(taskId: string, held: readonly Ticket[]): string[] {
    if (held.length === 0) return [];
    const which = held.map((ticket) => `${String(ticket.seq).padStart(2, "0")} ${ticket.status}`).join(", ");
    const note = `called done while tickets are still open (${which}); kept active`;
    log(`[organizer] plan ${taskId}: ${note}`);
    return [note];
  }

  function shouldFile(message: Message): boolean {
    if (message.kind !== "user" || message.author !== USER_MEMBER) return false;
    if (!message.body.trim() && message.attachments.length === 0) return false;
    try {
      // A batch of annotations continues the plan that delivered the artifact; filing it would
      // stamp a competing one.
      if (store.annotationsOfMessage(message.id).length > 0) return false;
      if (store.presentBotIds(message.session_id).length === 0) return false;
    } catch {
      return false;
    }
    return true;
  }

  async function organizeOne(message: Message): Promise<{ taskId: string | null; ticketId: string | null }> {
    const current = store.sessionCurrentTask(message.session_id);
    const fallback = { taskId: current?.id ?? null, ticketId: null };
    if (deps.draining() || ablation.has("organize-message") || !shouldFile(message)) return fallback;
    const outcome = await call({ mode: "message", sessionId: message.session_id, message, current });
    if (!outcome) return fallback;
    const { parsed, pending } = outcome;
    // A resume or join whose plan is not one this line can go to by the time the answer is read —
    // most often the job it joins ended while the call was out — was written for that plan: its
    // goal and tickets are that plan's. Continuing with them would write them over the current
    // plan, or, with none, open a copy of the job nobody asked for (ADR 0040 P1). The line keeps
    // the filing it has. One that names the plan this session is on is a continue in other words
    // (neither candidate set lists the current plan): its goal and tickets are this plan's, so it
    // lands as the continue it was read as.
    const rawTarget = parsed.raw?.decision === "resume" ? parsed.raw.resumePlanId : parsed.raw?.decision === "join" ? parsed.raw.joinPlanId : null;
    const namesCurrent = rawTarget !== null && rawTarget === current?.id;
    const lost =
      parsed.raw && (parsed.raw.decision === "resume" || parsed.raw.decision === "join") && parsed.decision !== parsed.raw.decision && !namesCurrent;
    if (lost) {
      const reason = parsed.downgradeReason ?? `${parsed.raw!.decision} named no plan it can go to`;
      log(`[organizer] filing message ${message.id}: ${reason}, nothing filed`);
      finishOrganizerRun(store, pending, { applied: false, rejectReason: reason, held: null, appliedTaskId: null, appliedTicketId: null });
      return fallback;
    }
    // 「你私聊里的没停」 once came back as 「私聊里这件还没停，接着做完」 and put a stopped video
    // job back to work: a line asking to stop never reopens a parked plan, whatever the answer says.
    // Under holds this guard is off. Only a pure control line, one the control reader takes and
    // answers itself (a stop, a go-on, a status question), is kept from the organizer; a mixed one —
    // 「你私聊里的没停，第三镜换成夜景」 — still reaches it and is filed, and the hold, not this guard,
    // keeps a stopped plan parked.
    const reopened = holdsOn() ? null : parkedPlanReopened(parsed, current);
    if (reopened && asksToStop(message.body)) {
      log(`[organizer] filing message ${message.id}: a line asking to stop would have reopened parked plan ${reopened}, nothing filed`);
      finishOrganizerRun(store, pending, {
        applied: false,
        rejectReason: `a line asking to stop would have reopened parked plan ${reopened}`,
        held: null,
        appliedTaskId: null,
        appliedTicketId: null,
      });
      return fallback;
    }
    let applied;
    try {
      applied = store.transaction(() =>
        store.applyOrganizerResult({
          sessionId: message.session_id,
          current,
          result: parsed,
          source: { messageId: message.id, turnId: null, messageBody: message.body },
        }),
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      log(`[organizer] could not apply the filing of ${message.id}: ${messageText}`);
      finishOrganizerRun(store, pending, { applied: false, rejectReason: `could not apply the filing: ${messageText}`, held: null, appliedTaskId: null, appliedTicketId: null });
      return fallback;
    }
    const heldNotes = noteHeldOpen(applied.task.id, applied.heldOpenBy);
    finishOrganizerRun(store, pending, {
      applied: true,
      rejectReason: null,
      held: heldNotes.length > 0 ? heldNotes : null,
      appliedTaskId: applied.task.id,
      appliedTicketId: applied.messageTicketId,
    });
    if (applied.awaitingEvidence) awaitingEvidence.add(applied.task.id);
    else awaitingEvidence.delete(applied.task.id);
    renderMirrors(applied.task.id);
    return { taskId: applied.task.id, ticketId: applied.messageTicketId };
  }

  async function organizeMessage(message: Message): Promise<{ taskId: string | null; ticketId: string | null }> {
    // One session's messages are filed in the order they arrived: the second waits for the first's decision.
    const previous = chains.get(message.session_id) ?? Promise.resolve();
    const run = previous.then(
      () => organizeOne(message),
      () => organizeOne(message),
    );
    chains.set(message.session_id, run.catch(() => undefined));
    try {
      return await run;
    } catch {
      return { taskId: store.sessionCurrentTask(message.session_id)?.id ?? null, ticketId: null };
    } finally {
      if (chains.get(message.session_id) === run) chains.delete(message.session_id);
    }
  }

  async function settlePlan(taskId: string, opts?: { evidence?: boolean }): Promise<boolean> {
    // Off, the quiet timer still runs and `onQuiet` still reconciles the plan: only the filing is skipped.
    if (deps.draining() || ablation.has("organize-settle") || inFlight.has(taskId)) return false;
    let task: Task;
    try {
      task = store.getTask(taskId);
    } catch {
      return false;
    }
    // Set aside with its conversation's history (ADR 0040): nothing is filed until something of yours wakes it.
    if (!task.session_id || task.dormant_since) return false;
    if (store.taskLiveTurnCount(taskId) > 0) return false;
    const since = store.lastSpecRevisionAt(taskId);
    // The evidence follow-up settle has nothing new to file since the last revision by design — the
    // checks `afterSettle` just ran are the only thing that changed — so it skips this guard.
    if (!opts?.evidence && store.taskMessagesSince(taskId, since, 1).length === 0 && store.taskArtifactsSince(taskId, since, 1).length === 0) {
      return false;
    }
    // Read before the call: the version it builds on. A line or an edit of yours that lands while the
    // call is out moves the plan past it, and the answer is then not filed.
    const revision = store.currentRevision(taskId);
    inFlight.add(taskId);
    try {
      const outcome = await call({ mode: "settle", sessionId: task.session_id, message: null, current: task });
      if (!outcome) return false;
      const { parsed, pending } = outcome;
      // Everything from here on can throw (the lastTurn lookup, the apply itself), and
      // every path — success or failure — must finish this pending row exactly once: a throw that
      // slipped past `finishOrganizerRun` left it stuck open, and a second write onto an already-
      // finished row would leave two contradictory ones for the same call (there is no update path).
      let ok = false;
      let rejectReason: string | null = null;
      let held: string[] | null = null;
      let appliedTaskId: string | null = null;
      try {
        // Its conversation was cleared or deleted while the call was out: the answer is about a plan
        // that has been set aside since, and filing it would write into it as if nothing happened.
        if (isDormant(taskId)) {
          log(`[organizer] plan ${taskId}: set aside while it was being settled; nothing filed`);
          rejectReason = "the plan was set aside while it was being settled";
          return false;
        }
        const lastTurn = store.db
          .query<{ id: string }, [string]>(`SELECT id FROM turns WHERE task_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`)
          .get(taskId);
        // A settle files what the Bots handed over; putting a parked plan back to work is yours to say.
        // Under holds, a hold keeps the plan you stopped parked whatever the settle says.
        const reopens = !holdsOn() && task.status === "parked" && parsed.spec.status === "active";
        if (reopens) log(`[organizer] plan ${taskId}: the settle called it active; kept parked`);
        const kept = reopens ? { ...parsed, spec: { ...parsed.spec, status: "parked" as const } } : parsed;
        // The evidence settle is only for re-reading checks that just ran; it must not also let this
        // pass add, edit or remove checks of its own — that would never stop giving itself one more look.
        const answer = opts?.evidence ? { ...kept, checks: undefined } : kept;
        // Only the handover lands, whatever the answer says (ADR 0042): the store keeps the goal,
        // a plan it would park and each ticket's title and description, and says what it kept.
        const applied = store.transaction(() =>
          store.applyOrganizerResult({
            sessionId: task.session_id!,
            current: task,
            result: { ...answer, decision: "continue", resumePlanId: null, messageTicket: null },
            source: { messageId: null, turnId: lastTurn?.id ?? null, messageBody: "" },
            ifRevision: revision,
            settle: true,
          }),
        );
        const handover = applied.kept.map((what) => `a settle files only the handover; ${what}`);
        for (const note of handover) log(`[organizer] plan ${taskId}: ${note}`);
        const ticketHeldNotes = noteHeldOpen(taskId, applied.heldOpenBy);
        const notes = [...(reopens ? ["the settle called it active; kept parked"] : []), ...handover, ...ticketHeldNotes];
        held = notes.length > 0 ? notes : null;
        if (applied.awaitingEvidence) awaitingEvidence.add(taskId);
        else awaitingEvidence.delete(taskId);
        appliedTaskId = applied.task.id;
        ok = true;
      } catch (error) {
        // A line or an edit of yours moved the plan while this settle was out: its answer was built
        // on the older version and would undo that. Tickets' files still show the handover.
        if (error instanceof HttpError && error.status === 409) {
          log(`[organizer] plan ${taskId}: the plan changed while it was being settled; nothing filed`);
          rejectReason = "the plan changed while it was being settled";
        } else {
          const messageText = error instanceof Error ? error.message : String(error);
          log(`[organizer] could not apply the settling of ${taskId}: ${messageText}`);
          rejectReason = `could not apply the settling: ${messageText}`;
        }
      } finally {
        finishOrganizerRun(store, pending, { applied: ok, rejectReason, held, appliedTaskId, appliedTicketId: null });
      }
      if (!ok) return false;
      renderMirrors(taskId);
      return true;
    } finally {
      inFlight.delete(taskId);
    }
  }

  /**
   * A plan's quiet stretch: its stale checks before the settle (so the settle's own read of the
   * plan sees their result), the settle itself, then whatever check still has no run this stretch
   * (an organizer-added one, mainly) after it. If that settle held a `done` open only because some
   * check had never run — and `afterSettle` just ran it — one more settle gives the organizer a
   * fresh look at the result, so a plan does not sit open until something else happens to it; at
   * most one of these per stretch, and it never lets the organizer touch checks a second time.
   * `onQuiet` (the reconcile) runs whether or not any of this filed or found anything — that call
   * is `noteTurnEnded`'s own, below.
   */
  async function quietStretch(taskId: string): Promise<void> {
    if (isDormant(taskId)) return;
    await deps.checks?.beforeSettle(taskId);
    if (stopped || deps.draining()) return;
    await settlePlan(taskId);
    if (stopped || deps.draining()) return;
    await deps.checks?.afterSettle(taskId);
    if (stopped || deps.draining()) return;
    if (awaitingEvidence.delete(taskId)) await settlePlan(taskId, { evidence: true });
  }

  function noteTurnEnded(turn: Turn): void {
    if (!turn.task_id || deps.draining()) return;
    if (turn.status === "running" || turn.status === "waiting_ask" || turn.status === "waiting_approval") return;
    stopped = false;
    const taskId = turn.task_id;
    const existing = settleTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      settleTimers.delete(taskId);
      const stops = stopsSeen.get(taskId) ?? 0;
      void quietStretch(taskId)
        .catch((error) => console.error(`[organizer] settling ${taskId} failed`, error))
        .then(() => {
          if (!stopped && !deps.draining() && (stopsSeen.get(taskId) ?? 0) === stops) deps.onQuiet?.(taskId);
        });
    }, deps.settleQuietMs ?? SETTLE_QUIET_MS);
    timer.unref?.();
    settleTimers.set(taskId, timer);
  }

  function noteTurnStopped(turn: Turn): void {
    if (!turn.task_id) return;
    const taskId = turn.task_id;
    clearTimeout(settleTimers.get(taskId));
    settleTimers.delete(taskId);
    stopsSeen.set(taskId, (stopsSeen.get(taskId) ?? 0) + 1);
  }

  function forgetPlan(taskId: string): void {
    clearTimeout(settleTimers.get(taskId));
    settleTimers.delete(taskId);
    awaitingEvidence.delete(taskId);
    // A stretch already under way reaches `onQuiet` only while this count is what it saw.
    stopsSeen.set(taskId, (stopsSeen.get(taskId) ?? 0) + 1);
  }

  function renderMirrors(taskId: string): void {
    if (!MIRROR_FILES) return;
    const root = store.workspacePath();
    if (!root) return;
    let task: Task;
    try {
      task = store.getTask(taskId);
    } catch {
      return;
    }
    const spec = parsePlanSpec(task.spec);
    if (!spec) return;
    const tickets = store.listTickets(taskId);
    const checks = store.listChecks(taskId);
    const planDir = classifyPath(root, task.dir);
    if (planDir.zone !== "inside") return;
    try {
      mkdirSync(planDir.abs, { recursive: true });
      atomicWrite(join(planDir.abs, PLAN_MAP_FILE), renderPlanMap(task, spec, tickets, checks, nameOf));
    } catch (error) {
      console.error(`[organizer] could not write ${task.dir}/${PLAN_MAP_FILE}`, error);
    }
    for (const ticket of tickets) {
      const dir = classifyPath(root, ticket.dir);
      if (dir.zone !== "inside") continue;
      try {
        mkdirSync(dir.abs, { recursive: true });
        atomicWrite(join(dir.abs, TICKET_FILE), renderTicketFile(task, spec, ticket, checks, nameOf));
      } catch (error) {
        console.error(`[organizer] could not write ${ticket.dir}/${TICKET_FILE}`, error);
      }
    }
    void existsSync;
  }

  function clearTimers(): void {
    stopped = true;
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
  }

  return { organizeMessage, noteTurnEnded, noteTurnStopped, settlePlan, renderMirrors, forgetPlan, clearTimers };
}

const PLAN_STATUS_ZH: Record<PlanSpec["status"], string> = { active: "进行中", done: "已完成", parked: "搁置" };
const TICKET_STATUS_ZH: Record<Ticket["status"], string> = { todo: "待做", doing: "进行中", review: "待验收", done: "已完成", parked: "搁置" };
const CHECK_OUTCOME_ZH: Record<AcceptanceCheckOutcome, string> = { pass: "通过", fail: "不通过", blocked: "受阻", error: "出错" };
/** The line under the 验收 section that holds checks whose item no longer matches any acceptance line. */
const ORPHAN_CHECKS_LABEL = "「其他验收检查」";

function bullets(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- （无）";
}

function number(seq: number): string {
  return String(seq).padStart(2, "0");
}

function checkStatusZh(check: AcceptanceCheck): string {
  if (check.running) return "运行中";
  // Not confirmed yet: measured for information, holds nothing back.
  if (check.origin === "derived" && check.derived_state !== "active") return check.last_run ? `未确认，${CHECK_OUTCOME_ZH[check.last_run.outcome ?? "error"]}` : "未确认";
  if (derivedNotGate(check)) return "未绑定";
  if (!check.last_run) return "未跑";
  return CHECK_OUTCOME_ZH[check.last_run.outcome ?? "error"];
}

function checkLine(check: AcceptanceCheck): string {
  return `  - [${checkStatusZh(check)}] ${describeCheck(check, "zh")}`;
}

/**
 * The 验收 section: each line from `spec.acceptance`, with the checks proving it indented under
 * it; a check whose `item` matches none of those lines — the plan's spec moved out from under it —
 * still runs and still counts, so it is shown too, grouped under {@link ORPHAN_CHECKS_LABEL}
 * instead of silently dropped.
 */
function acceptanceSection(spec: PlanSpec, checks: readonly AcceptanceCheck[]): string {
  const known = new Set(spec.acceptance);
  const byItem = new Map<string, AcceptanceCheck[]>();
  const orphans: AcceptanceCheck[] = [];
  for (const check of checks) {
    if (!known.has(check.item)) {
      orphans.push(check);
      continue;
    }
    const list = byItem.get(check.item) ?? [];
    list.push(check);
    byItem.set(check.item, list);
  }
  if (spec.acceptance.length === 0 && orphans.length === 0) return "- （无）";
  const lines: string[] = [];
  for (const item of spec.acceptance) {
    lines.push(`- ${item}`);
    for (const check of byItem.get(item) ?? []) lines.push(checkLine(check));
  }
  if (orphans.length > 0) {
    lines.push(`- ${ORPHAN_CHECKS_LABEL}`);
    for (const check of orphans) lines.push(checkLine(check));
  }
  return lines.join("\n");
}

/** `map.md`: the plan's spec and its ticket index, as the app last organized them. */
export function renderPlanMap(
  task: Task,
  spec: PlanSpec,
  tickets: readonly Ticket[],
  checks: readonly AcceptanceCheck[],
  nameOf: (id: string) => string,
): string {
  const rows = tickets.map((ticket) => {
    const who = ticket.worker ? nameOf(ticket.worker) : "";
    const rel = ticket.dir.startsWith(`${task.dir}/`) ? ticket.dir.slice(task.dir.length + 1) : ticket.dir;
    return `| ${number(ticket.seq)} | ${ticket.title.replace(/\|/g, "\\|")} | ${TICKET_STATUS_ZH[ticket.status]} | ${who} | ${rel}/ |`;
  });
  return [
    `# ${spec.goal}`,
    "",
    // The name it goes by in the app and in every turn's picture, which you can change on the board.
    `- 名字：${task.title}`,
    `- 类别：${spec.kind ?? "（未定）"}`,
    `- 状态：${PLAN_STATUS_ZH[spec.status]}`,
    `- 目录：${task.dir}/`,
    ...(task.brief ? [`- 开头的要求：${task.brief.replace(/\s+/g, " ").trim()}`] : []),
    "",
    "## 验收",
    acceptanceSection(spec, checks),
    "",
    "## 规则",
    bullets(spec.rules),
    "",
    "## 流程与分工",
    bullets(spec.process),
    "",
    "## 进展",
    `- 已完成：${spec.progress.done.join("、") || "（无）"}`,
    `- 待做：${spec.progress.open.join("、") || "（无）"}`,
    `- 卡住：${spec.progress.blocked.join("、") || "（无）"}`,
    "",
    "## 任务",
    "",
    ...(rows.length > 0 ? ["| # | 任务 | 状态 | 谁在做 | 目录 |", "|---|---|---|---|---|", ...rows] : ["（还没有拆出任务）"]),
    "",
    "_由应用整理，每次整理后重写；改要点请在流程图里改，不要手改这个文件。_",
    "",
  ].join("\n");
}

/** `ticket.md`: one ticket, with the plan's acceptance and rules it is measured against. */
export function renderTicketFile(
  task: Task,
  spec: PlanSpec,
  ticket: Ticket,
  checks: readonly AcceptanceCheck[],
  nameOf: (id: string) => string,
): string {
  return [
    `# ${number(ticket.seq)} ${ticket.title}`,
    "",
    `- 规划：${spec.goal}（${task.dir}/${PLAN_MAP_FILE}）`,
    `- 状态：${TICKET_STATUS_ZH[ticket.status]}`,
    `- 谁在做：${ticket.worker ? nameOf(ticket.worker) : "（还没人接）"}`,
    `- 目录：${ticket.dir}/`,
    "",
    "## 要点",
    ticket.spec.trim() || "（还没写）",
    "",
    "## 规划的验收",
    acceptanceSection(spec, checks),
    "",
    "## 规划的规则",
    bullets(spec.rules),
    "",
    "_由应用整理，每次整理后重写；不要手改这个文件。_",
    "",
  ].join("\n");
}
