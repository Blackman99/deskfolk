/**
 * A turn's life from the moment it is created to the moment its row says so: opening (fresh,
 * redirected over another live turn, or forked beside it), the hop loop that talks to the model
 * and hands tool calls off to `tools.ts`, and every way it can end — completed, interrupted,
 * crashed, stalled. This is the engine's busiest file because a turn's hop loop touches nearly
 * everything else: routing for where it runs, spend for what it costs, chains for what it belongs
 * to, tools for what it does, closing for what it is allowed to say, plan-watch for what it moves.
 */
import {
  attachmentLinePaths,
  USER_MEMBER,
  type ClientEvent,
  type Message,
  type Turn,
} from "@real-bot/protocol";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  extractWorkspacePathsFromBody,
  mergeCitedPaths,
  resolveBodyPathsToWorkDir,
} from "../artifact-paths";
import { pathExists } from "../collab-tools";
import type { CompletionsClient } from "../completions";
import { assembleTurnMessages, planTagger, sessionLabel, type PlanRef } from "../context";
import { HttpError } from "../errors";
import { continueNote, hopLimits, isRetriedFailure, replyFailure, retryNote } from "../hop-limits";
import { troubleCount } from "./trouble";
import { completionFailBody, builtinTools, type FailKind } from "../prompts";
import { readBotLineByWords, readsAsNoWork, type BotLineReading } from "../line-reading";
import type { McpHost } from "../mcp-host";
import type { TurnAdmission } from "../quiesce";
import { isoNow } from "../ids";
import { MODEL_FAIL_SHAPES } from "../store/quality";
import type { TurnExecution } from "../store/routing";
import { ENGINE_LEVELS } from "../store/schema-gate";
import type { Store } from "../store";
import { checkInNote, emptyReplyNote, lastHopNote, turnPace } from "../turn-pace";
import { inboxLabel, inTicketDir } from "../store";
import { heardNote, recentToolCalls, redirectCarryNote, type HeardItem } from "../turn-inbox";
import { recordHeard } from "./inbox-record";
import type { WakeWatch } from "../wake";
import type { Chains } from "./chains";
import type { Closing } from "./closing";
import { heldWake, mayWake, wakeOn, type WakeCause } from "./control";
import type { Participation } from "./participation";
import type { PlanWatch } from "./plan-watch";
import type { Routing } from "./routing";
import type { SpendTracker } from "./spend";
import { readOnlyTools, type Tools } from "./tools";
import type { InboxEntry, Live } from "./types";
import type { Spend } from "@real-bot/protocol";
import type { ClaudeCodeProbe } from "../claude-code/probe";
import { createAgentRunner, type AgentQuery } from "./agent-runner";

/** How many of a segment's written files are hashed for progress, newest first, and up to what size each. */
const ARTIFACTS_HASHED_MAX = 50;
const ARTIFACT_HASH_BYTES_MAX = 2 * 1024 ** 3;
/** Claude Agent failures only the user can clear (ADR 0061): the supervisor does not retry them. */
const USER_FIX_FAILS: ReadonlySet<FailKind> = new Set<FailKind>(["agent_missing", "agent_signed_out", "agent_limit"]);

export type LifecycleDeps = {
  store: Store;
  publish: (event: ClientEvent) => void;
  publishMessage: (message: Message) => void;
  publishTurn: (turn: Turn, partial?: string | null) => void;
  occurred: () => string;
  wake: WakeWatch;
  mcp: McpHost | undefined;
  admission: TurnAdmission | undefined;
  completions: CompletionsClient;
  lives: Map<string, Live>;
  tasks: Set<Promise<unknown>>;
  active: (turnId: string, live: Live) => boolean;
  track: <T>(promise: Promise<T>) => Promise<T>;
  trackTurn: <T>(turnId: string, promise: Promise<T>) => Promise<T>;
  credentials: Routing["credentials"];
  agentRoute: Routing["agentRoute"];
  targetFor: Routing["targetFor"];
  decideRoute: Routing["decideRoute"];
  routingTarget: Routing["routingTarget"];
  spendOwner: SpendTracker["spendOwner"];
  callOf: SpendTracker["callOf"];
  recordSpend: SpendTracker["recordSpend"];
  closeChain: Chains["closeChain"];
  holdChain: Chains["holdChain"];
  chainTurnEnded: Chains["turnEnded"];
  clearChainTimers: Chains["clearTimers"];
  clearDirectTimers: () => void;
  clearOrganizerTimers: () => void;
  clearPlanTimers: () => void;
  inspectForTurn: Tools["inspectForTurn"];
  executeTools: Tools["executeTools"];
  closingCheck: Closing["closingCheck"];
  /** A Bot's line, read for what the app acts on (ADR 0055, `reader.ts`); absent, the word lists read it. */
  readBotLine?: (body: string, sessionId: string | null) => Promise<BotLineReading>;
  publishCitedBotMessage: Closing["publishCitedBotMessage"];
  completeSilent: Closing["completeSilent"];
  observeTicket: PlanWatch["observeTicket"];
  handleParticipation: Participation["handleParticipation"];
  /**
   * Late-bound: the engine's `replyAsk`. A line of yours that reaches a segment waiting on your
   * answer to its question is that answer (ADR 0040 §3.3), written as text of your own.
   */
  answerAsk: (askId: string, sessionId: string, custom: string) => void;
  /**
   * Late-bound: the stops' `unanswered`. A read-only answer under a stop that ended without a word
   * to you leaves your line unanswered; the app says why in its place, with the buttons to go on.
   */
  readOnlyUnanswered?: (turn: Turn) => void;
  /**
   * Late-bound: the implicit submission (ADR 0046, engine level 5) — new files the segment cited
   * in its ticket's folder, handed over for it, checked, and moved on. Resolves once settled.
   */
  implicitSubmission: (turnId: string, opts?: { cite?: string[]; tell?: boolean }) => Promise<{ state: string; failures: Array<{ item: string; detail: string }> } | null>;
  /** For a Claude Agent turn's spend rows (ADR 0061). */
  publishSpend: (row: Spend) => void;
  /** What the daemon knows of the user's own Claude Code; absent, a Claude Agent turn finds none. */
  claudeCode?: ClaudeCodeProbe;
  /** Stands in for the Agent SDK in tests. */
  agentQuery?: AgentQuery;
  openApprovalCard: Tools["openApprovalCard"];
  beforeEffect: Tools["beforeEffect"];
  noteWrittenPaths: Tools["noteWrittenPaths"];
};

export type Lifecycle = {
  /** Null when a hold turns the wake away (see engine/control.ts). */
  startTurn: (
    sessionId: string,
    botId: string,
    trigger: Message,
    mode: "redirect" | "fork",
    opts: {
      cause: WakeCause;
      routineId?: string | null;
      routineDueAt?: string | null;
      taskId?: string | null;
      ticketId?: string | null;
    },
  ) => Turn | null;
  /** Null when a hold turns the wake away. */
  hearOrStart: (
    sessionId: string,
    botId: string,
    trigger: Message,
    entry: Omit<InboxEntry, "message">,
    opts: { cause: WakeCause; taskId?: string | null; ticketId?: string | null; otherwise?: "redirect" | "fork" },
  ) => Turn | null;
  hearAcross: (message: Message, opts?: { turnIds?: readonly string[] }) => Turn[];
  dispatchQueued: () => void;
  attachLive: (turn: Turn, carry?: string | null) => void;
  continueFromInterrupt: (messageId: string) => Turn;
  abortLive: (turnId: string) => void;
  drainLives: () => Promise<void>;
  executionOf: (live: Live | undefined) => TurnExecution | null;
  interruptTurn: (current: Turn) => void;
  failTurn: (turnId: string, kind: FailKind, detail?: string | null) => void;
  sweepStalledTurns: (at?: Date) => void;
};

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const {
    store,
    publish,
    publishMessage,
    publishTurn,
    occurred,
    wake,
    mcp,
    admission,
    completions,
    lives,
    tasks,
    active,
    track,
    trackTurn,
    credentials,
    agentRoute,
    targetFor,
    decideRoute,
    routingTarget,
    spendOwner,
    callOf,
    recordSpend,
    closeChain,
    holdChain,
    chainTurnEnded,
    clearChainTimers,
    clearDirectTimers,
    clearOrganizerTimers,
    clearPlanTimers,
    inspectForTurn,
    executeTools,
    closingCheck,
    readBotLine = readBotLineByWords,
    publishCitedBotMessage,
    completeSilent,
    observeTicket,
    handleParticipation,
    answerAsk,
    readOnlyUnanswered,
    implicitSubmission,
  } = deps;

  function runsOnClaudeCode(botId: string): boolean {
    try {
      return store.getBot(botId).runner === "claude_code";
    } catch {
      return false;
    }
  }

  /**
   * The segment's last word to the user (the closing reply about to go out, else its newest
   * message) and the sentence in which it says the work is still going, as it reads (ADR 0055):
   * what the end contract weighs an ending against. Undefined when it said nothing.
   */
  async function readLastWord(turnId: string, turn: Turn, closing: string): Promise<{ said: string; later: string | null } | undefined> {
    const said = store.segmentLastWord(turnId, closing);
    if (!said?.trim()) return undefined;
    return { said, later: (await readBotLine(said, turn.session_id)).later };
  }

  /**
   * Nothing in a hop may legitimately go this long without touching the turn: a shell is bounded by
   * its own timeout, an MCP call by its idle cap, and both ends of every tool call touch the row.
   * Past this the turn is wedged. A completion in flight is not measured here: its own time limit
   * bounds it (hop-limits.ts), and on a slow model that can be longer than this.
   */
  const STALE_TURN_MS = 20 * 60_000;

  function startTurn(
    sessionId: string,
    botId: string,
    trigger: Message,
    mode: "redirect" | "fork",
    opts: {
      /** What wakes the Bot, for the work log when a hold turns it away. */
      cause: WakeCause;
      routineId?: string | null;
      routineDueAt?: string | null;
      /** The plan this turn continues outright, when the trigger cannot say (a check-back's note, a routine). */
      taskId?: string | null;
      ticketId?: string | null;
    },
  ): Turn | null {
    admission?.assertNew();
    const wake = wakeOn(store, opts.cause, { sessionId, botId, trigger, taskId: opts.taskId, ticketId: opts.ticketId });
    // Your line to a Bot a hold covers still gets an answer: a read-only turn beside whatever it
    // was doing, which can read and reply and nothing else (ADR 0040 I2's one exemption). What it
    // answers it cannot act on: each hold keeps the line, and the go on that lifts it hands the
    // line back to the Bot (stop.ts `resumeLifted`).
    const holding = opts.cause === "user_line" && trigger.kind === "user" ? heldWake(store, wake) : [];
    if (holding.length > 0) {
      const readOnly = store.createTurn({ sessionId, botId, triggerMessageId: trigger.id, mode: "readonly" });
      for (const hold of holding) store.addHoldEffect(hold.id, { answered_lines: [{ message_id: trigger.id, bot_id: botId, turn_id: readOnly.id }] });
      attachLive(readOnly);
      return readOnly;
    }
    // Before a live turn is redirected for it: a wake a hold turns away changes nothing.
    if (!mayWake(store, wake)) return null;
    // One live turn per Bot per plan (ADR 0040 I1b): a second line about a plan this Bot is already
    // working on, in any conversation, is heard by that turn instead of opening another.
    if (store.capabilities().engine_level >= ENGINE_LEVELS.work_items) {
      const landing = store.turnLanding({ sessionId, botId, trigger, taskId: opts.taskId, ticketId: opts.ticketId });
      if (landing.taskId) {
        const onPlan = store.listLiveTurns({ botId }).find((row) => row.task_id === landing.taskId && row.mode !== "readonly");
        const live = onPlan ? lives.get(onPlan.id) : undefined;
        if (onPlan && live && !live.abort.signal.aborted && store.turnHeldBy(onPlan.id).length === 0) {
          hearIn(onPlan, live, trigger, { item: { author: "", body: trigger.body, checkBack: false } }, landing);
          return onPlan;
        }
      } else {
        // A line on no job, for a Bot whose desk segment in this conversation is still open: that
        // segment hears it, as in a direct. A second desk segment here would be the same work item
        // (I1), and the refusal would lose the line. A desk this process does not run, or one being
        // cut off, still gets the row: it reads it at its next step, or leaves it for the next one.
        const desk = store.listLiveTurns({ sessionId, botId }).find((row) => row.mode === "desk");
        if (desk) {
          hearIn(desk, lives.get(desk.id), trigger, { item: { author: "", body: trigger.body, checkBack: false } }, landing);
          return desk;
        }
      }
    }
    // Already at its limit of jobs: this one waits, and the conversation says where in line it is.
    if (store.capabilities().engine_level >= ENGINE_LEVELS.work_items) {
      const landing = store.turnLanding({ sessionId, botId, trigger, taskId: opts.taskId, ticketId: opts.ticketId });
      const place = store.workItemQueuePlace({ botId, taskId: landing.taskId });
      if (place !== null) {
        // In line: yours first, then results and the supervisor's wakes, then a Bot's own appointments (§5.3.1).
        const queued = store.queueWork({ botId, sessionId, taskId: landing.taskId, ticketId: landing.ticketId,
          messageId: trigger.id, author: trigger.author, body: trigger.body,
          source: trigger.kind === "user" ? "user" : "system", kind: "change",
          priority: trigger.kind === "user" ? 1 : opts.cause === "check_back" || opts.cause === "routine" ? 4 : 3 });
        if (queued.message) publishMessage(queued.message);
        return null;
      }
    }
    // Deterministic work is never redirected into a different job. Same-job lines were merged
    // above; another job has its own segment, subject to the parallel limit.
    if (store.capabilities().engine_level >= ENGINE_LEVELS.work_items) mode = "fork";
    let carry: { written: string[]; recent: string[]; unread: HeardItem[]; previous: PlanRef | null } | null = null;
    if (mode === "redirect") {
      // A turn a hold covers is left to the hold, and the new one opens beside it: redirecting it
      // would carry its work, and lines the hold kept from it, into a turn the hold does not cover.
      // A read-only turn answering you is left to finish its answer, beside the new one.
      const livesForBot = store
        .listLiveTurns({ sessionId, botId })
        .filter((row) => row.mode !== "readonly" && store.turnHeldBy(row.id).length === 0);
      let sessionKind: string | null = null;
      try {
        sessionKind = store.getSession(sessionId).kind;
      } catch {
        sessionKind = null;
      }
      const toRedirect = sessionKind === "group" ? livesForBot : livesForBot.slice(0, 1);
      const written: string[] = [];
      const recent: string[] = [];
      const unread: HeardItem[] = [];
      const first = toRedirect[0];
      const previous = first ? { taskId: first.task_id ?? null, ticketId: first.ticket_id ?? null } : null;
      for (const current of toRedirect) {
        const old = lives.get(current.id);
        if (old) {
          written.push(...old.writtenPaths);
          recent.push(...recentToolCalls(old.loop));
          unread.push(...old.inbox.map((entry) => entry.item));
          // Carried into the new turn's first note below; the old turn must not reopen them.
          old.inbox = [];
        }
        const counted = executionOf(old);
        abortLive(current.id);
        const redirected = store.redirectTurn(current.id, counted);
        publishTurn(redirected);
      }
      carry = { written: [...new Set(written)], recent, unread, previous };
    }
    const turn = store.createTurn({
      sessionId,
      botId,
      triggerMessageId: trigger.id,
      routineId: opts.routineId,
      routineDueAt: opts.routineDueAt,
      taskId: opts.taskId,
      ticketId: opts.ticketId,
    });
    // Rendered once the new turn has its plan, so the note can say the old one was on another.
    let note: string | null = null;
    if (carry) {
      const locale = store.settingsCached().locale;
      const previous = carry.previous
        ? planTagger(store, { taskId: turn.task_id ?? null, ticketId: turn.ticket_id ?? null }, locale)(carry.previous)
        : "";
      note = redirectCarryNote(locale, { ...carry, previous: previous || undefined });
    }
    attachLive(turn, note, { planNudge: opts.cause === "plan_nudge" });
    return turn;
  }

  let dispatching = false;
  let closing = false;
  function dispatchQueued(): void {
    if (closing || dispatching || admission?.draining || store.capabilities().engine_level < ENGINE_LEVELS.work_items) return;
    dispatching = true;
    try {
      const queued = store.dispatchableWork();
      for (const item of queued) {
        if (store.workItemQueuePlace({ botId: item.bot_id, taskId: item.task_id }) !== null) continue;
        if (store.listLiveTurns({ botId: item.bot_id }).some((turn) => turn.task_id === item.task_id && turn.mode !== "readonly")) continue;
        if (store.holdsCovering({ botId: item.bot_id, sessionId: item.home_session_id, taskId: item.task_id, ticketId: item.ticket_id }).length) continue;
        try {
          store.transaction(() => {
            const trigger = store.prepareQueuedTrigger(item.id);
            if (!trigger) return;
            const turn = startTurn(item.home_session_id, item.bot_id, trigger, "fork", { cause: "unheard", taskId: item.task_id, ticketId: item.ticket_id });
            if (turn) store.markWorkRunning(item.id);
          });
        } catch (error) {
          console.error(`[queue ${item.id}] could not dispatch`, error);
        }
      }
    } finally { dispatching = false; }
  }

  /**
   * Puts a line into a live turn's inbox: tagged with the plan it is about, and with where it was
   * said when that is another conversation.
   */
  function hearIn(
    turn: Turn,
    live: Live | undefined,
    trigger: Message,
    entry: Omit<InboxEntry, "message">,
    about: { taskId: string | null; ticketId: string | null },
  ): void {
    if (live && answersAsk(turn, live, trigger)) return;
    const locale = store.settingsCached().locale;
    const tag = planTagger(store, { taskId: turn.task_id ?? null, ticketId: turn.ticket_id ?? null }, locale)(about);
    const where = trigger.session_id === turn.session_id ? entry.item.where : sessionLabel(store, trigger.session_id, turn.bot_id, locale) ?? undefined;
    let author = entry.item.author || trigger.author;
    if (!entry.item.author) {
      try {
        author = trigger.author === USER_MEMBER ? "user" : store.getBot(trigger.author).name;
      } catch {
        author = trigger.author;
      }
    }
    const heard = recordHeard(store, turn, {
      ...entry,
      item: { ...entry.item, author, tag: tag || undefined, where },
      message: trigger,
      ...(trigger.session_id === turn.session_id ? {} : { elsewhere: true }),
    });
    if (live && !live.abort.signal.aborted) live.inbox.push(heard);
  }

  /**
   * Your line reaching a segment that waits on your answer to its question, said where it asked:
   * from the work items' level that line is the answer (ADR 0040 §3.3) — text of your own rather
   * than one of its choices — and the segment goes on with it, instead of the line waiting in an
   * inbox the waiting segment never reads. A line with files, a Bot's line, or one said elsewhere
   * still goes to the inbox. True when it answered.
   */
  function answersAsk(turn: Turn, live: Live, trigger: Message): boolean {
    if (store.capabilities().engine_level < ENGINE_LEVELS.work_items || !live.ask || live.abort.signal.aborted) return false;
    if (trigger.kind !== "user" || trigger.author !== USER_MEMBER || trigger.attachments.length > 0 || !trigger.body.trim()) return false;
    try {
      const current = store.getTurn(turn.id);
      if (current.status !== "waiting_ask" || current.session_id !== trigger.session_id) return false;
      answerAsk(live.ask.id, trigger.session_id, trigger.body);
      // Your answer now, written on the question: a question is answered once, so the line stays as it was (ADR 0063).
      store.markLineTaken(trigger.id, "answer");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A Bot's line for a Bot that is already working in this session is heard inside that turn
   * rather than ending it: it waits in the turn's inbox for the next hop. Only when there is no
   * live turn here that this process runs, and that no hold covers, does a new one open. Returns
   * the turn that got it; null when a hold turns it away, heard or not.
   */
  function hearOrStart(
    sessionId: string,
    botId: string,
    trigger: Message,
    entry: Omit<InboxEntry, "message">,
    /** `otherwise`: how a turn opens when none here can hear it; a direct with you forks, never cuts one of yours off. */
    opts: { cause: WakeCause; taskId?: string | null; ticketId?: string | null; otherwise?: "redirect" | "fork" },
  ): Turn | null {
    const { otherwise = "redirect", cause, ...lands } = opts;
    // Asked once, of the plan the line would open a turn in: a line a hold turns away is not heard either.
    if (!mayWake(store, wakeOn(store, cause, { sessionId, botId, trigger, ...lands }))) return null;
    // One live turn per Bot per plan (ADR 0040 I1b), whichever conversation the line came in: the
    // turn already on that plan hears it.
    const about = entry.checkBack ?? { taskId: lands.taskId ?? trigger.task_id ?? null, ticketId: lands.ticketId ?? trigger.ticket_id ?? null };
    if (store.capabilities().engine_level >= ENGINE_LEVELS.work_items && about.taskId) {
      const onPlan = store.listLiveTurns({ botId }).find((row) => row.task_id === about.taskId && row.mode !== "readonly");
      const living = onPlan ? lives.get(onPlan.id) : undefined;
      if (onPlan && living && !living.abort.signal.aborted && store.turnHeldBy(onPlan.id).length === 0) {
        hearIn(onPlan, living, trigger, entry, about);
        return onPlan;
      }
    }
    // A group turn hears lines about other jobs too; the tag says which one this is about. With
    // more than one turn here, the one already on that job hears it.
    const rows = store.listLiveTurns({ sessionId, botId });
    const onJob = rows.filter((row) => about.taskId !== null && row.task_id === about.taskId);
    // A line about one job is not heard by a turn on another once work items are on: that turn
    // would do the wrong job, and the line queues or opens its own instead.
    const hearable = store.capabilities().engine_level >= ENGINE_LEVELS.work_items
      ? (about.taskId ? onJob : rows.filter((row) => row.mode === "desk"))
      : [...onJob, ...rows.filter((row) => !onJob.includes(row))];
    for (const current of hearable) {
      const live = lives.get(current.id);
      if (!live || live.abort.signal.aborted) continue;
      // A held turn hears nothing new, not even about work beside the hold: it could not act on the
      // line, and the line would be spent there instead of opening a turn that can. Nor does a
      // read-only turn answering you, which can act on nothing.
      if (current.mode === "readonly" || store.turnHeldBy(current.id).length > 0) continue;
      if (answersAsk(current, live, trigger)) return current;
      const tag = planTagger(
        store,
        { taskId: current.task_id ?? null, ticketId: current.ticket_id ?? null },
        store.settingsCached().locale,
      )(about);
      live.inbox.push(recordHeard(store, current, { ...entry, item: { ...entry.item, tag: tag || undefined }, message: trigger }));
      return current;
    }
    return startTurn(sessionId, botId, trigger, otherwise, { cause, ...lands });
  }

  /**
   * Your line, once filed under a plan, reaches every turn working in that plan in another session:
   * you tell a Bot in your direct what to change about the job it is doing in a group, and the
   * group's turns on that job — its own and its teammates' — read it on their next hop without being
   * interrupted. Turns in the line's own session already have it in their transcript, and a turn a
   * hold covers does not get it. Returns the turns that got it.
   */
  function hearAcross(message: Message, opts?: { turnIds?: readonly string[] }): Turn[] {
    if (!message.task_id) return [];
    const locale = store.settingsCached().locale;
    let author = "user";
    if (message.author !== USER_MEMBER) {
      try {
        author = store.getBot(message.author).name;
      } catch {
        author = message.author;
      }
    }
    // The hearing turn cannot see that session's transcript, so the files come along by path.
    const body = [message.body, ...message.attachments.map((att) => `附件：${att.workspace_relpath}`)].join("\n");
    const got: Turn[] = [];
    for (const current of store.listLiveTurns()) {
      if (current.task_id !== message.task_id || current.session_id === message.session_id) continue;
      if (opts?.turnIds && !opts.turnIds.includes(current.id)) continue;
      const live = lives.get(current.id);
      if (!live || live.abort.signal.aborted) continue;
      const wake = {
        cause: "heard_across" as const,
        botId: current.bot_id,
        sessionId: current.session_id,
        taskId: current.task_id ?? null,
        ticketId: current.ticket_id ?? null,
        turnId: current.id,
      };
      if (!mayWake(store, wake)) continue;
      const tag = planTagger(store, { taskId: current.task_id ?? null, ticketId: current.ticket_id ?? null }, locale)({
        taskId: message.task_id,
        ticketId: message.ticket_id ?? null,
      });
      const where = sessionLabel(store, message.session_id, current.bot_id, locale) ?? undefined;
      live.inbox.push(recordHeard(store, current, {
        item: { author, body, checkBack: false, tag: tag || undefined, where },
        message,
        elsewhere: true,
      }));
      got.push(current);
    }
    return got;
  }

  /**
   * A turn that ended before reading its inbox leaves those lines unanswered, so one more turn
   * opens on the last of them — the others are in its transcript. Only a turn that finished does
   * this: Stop means leave it, a redirect already carried them over, an interruption is yours to
   * pick up.
   */
  /**
   * A turn that ended with lines it never read opens one more, on the newest of them. Each line is
   * put to the holds on its own (ADR 0040): one about held work is a wake turned away, recorded as
   * such, and stays in the transcript for after the lift — an appointment among them is given back
   * to fire then — while the turn opens on the newest line about unheld work, and only those ride
   * along into it.
   */
  function reopenForUnheard(turn: Turn, live: Live): void {
    if (live.inbox.length === 0 || admission?.draining) return;
    // What it had not read says what the rows now say: a line you changed meanwhile (ADR 0063).
    for (const entry of live.inbox) {
      if (entry.seq === undefined) continue;
      const row = store.getInboxItem(entry.seq);
      if (row && row.body_snapshot !== entry.item.body) entry.item = { ...entry.item, body: row.body_snapshot };
    }
    // A line heard from another session was answered there; it opens nothing here.
    const pending = live.inbox.filter((entry) => !entry.elsewhere);
    live.inbox = [];
    if (pending.length === 0) return;
    let status: Turn["status"];
    try {
      status = store.getTurn(turn.id).status;
    } catch {
      return;
    }
    if (status !== "completed") return;
    const lands = (entry: InboxEntry) => (entry.checkBack ? { taskId: entry.checkBack.taskId, ticketId: entry.checkBack.ticketId } : {});
    const turnedAway = new Set(
      pending.filter(
        (entry) => !mayWake(store, wakeOn(store, "unheard", { sessionId: turn.session_id, botId: turn.bot_id, trigger: entry.message, ...lands(entry) })),
      ),
    );
    // The newest appointment a hold turned away fires again on the lift, or on the next tick if no
    // hold covers its own row.
    const giveBack = () => {
      const booked = [...pending].reverse().find((entry) => entry.checkBack && turnedAway.has(entry));
      if (booked) store.returnUnreadCheckBack(booked.message.id, isoNow());
    };
    const unheld = pending.filter((entry) => !turnedAway.has(entry));
    const last = unheld.at(-1);
    if (!last) return giveBack();
    try {
      const reopened = hearOrStart(
        turn.session_id,
        turn.bot_id,
        last.message,
        { item: last.item, ...(last.checkBack ? { checkBack: last.checkBack } : {}) },
        { cause: "unheard", ...lands(last) },
      );
      if (!reopened) for (const entry of unheld) turnedAway.add(entry);
      giveBack();
      if (!reopened) return;
      for (const entry of unheld.slice(0, -1)) {
        if (!entry.checkBack) continue;
        // an earlier check-back line is its own reminder; it rides along in the new turn's inbox
        lives.get(reopened.id)?.inbox.unshift(entry);
      }
    } catch (error) {
      console.error(`[turn ${turn.id}] could not reopen for what it had not read`, error);
    }
  }

  function attachLive(turn: Turn, carry: string | null = null, opts: { planNudge?: boolean } = {}): void {
    if (turn.status !== "running") { publishTurn(turn); return; }
    if (store.capabilities().engine_level >= ENGINE_LEVELS.work_items && turn.mode !== "readonly") {
      store.adoptWaitingInbox({ botId: turn.bot_id, sessionId: turn.session_id, turnId: turn.id });
    }
    const live: Live = {
      abort: new AbortController(),
      loop: carry ? [{ role: "user", content: carry }] : [],
      inbox: [],
      interrupt: store.pendingInterrupt(turn.bot_id),
      burned: false,
      partial: "",
      parentId: null,
      writtenPaths: [],
      planDir: store.turnPlanDir(turn.id),
      workDir: store.turnWorkDir(turn.id),
      mentionWarned: new Set(),
      toolNames: new Set(),
      mcpTools: new Map(),
      spoke: false,
      drainRejection: false,
      closingChecked: false,
      planNudge: opts.planNudge,
      routing: null,
      locale: "zh",
      hops: 0,
      toolCalls: 0,
      toolErrors: 0,
      repeatedFailures: 0,
      failedCalls: new Set(),
      trouble: troubleCount(),
      failures: [],
    };
    store.afterCommit(() => {
      lives.set(turn.id, live);
      const run = async (): Promise<void> => {
        try {
          publishTurn(turn);
          // A Claude Agent Bot's turns are Claude Code's to work (ADR 0061); everything around them is shared.
          if (runsOnClaudeCode(turn.bot_id)) await agentRunner.runAgentTurn(turn.id);
          else await runTurn(turn.id);
        } catch (error) {
          if (!live.abort.signal.aborted) await crashTurn(turn.id, error);
        } finally {
          try {
            const current = store.getTurn(turn.id);
            if (["running", "waiting_ask", "waiting_approval"].includes(current.status)) {
              if (live.abort.signal.aborted) {
                interruptTurn(current);
              } else {
                failTurn(turn.id, "endpoint_error");
              }
            }
          } finally {
            lives.delete(turn.id);
            // Lines of yours this turn read and never answered for are unacked; what it never read
            // waits for the next turn here (ADR 0040 P4a).
            try {
              store.releaseTurnInbox(turn.id);
              // The work it ran stops saying `running` (ADR 0040 §2.6), after its unread lines
              // had their say: a line still waiting for it leaves the work queued instead.
              store.settleEndedSegment(turn.id);
              if (store.capabilities().engine_level >= ENGINE_LEVELS.supervision) {
                for (const pending of store.pendingToolExecutions({ turnId: turn.id })) {
                  store.finishToolExecution({ turnId: turn.id, toolCallId: pending.tool_call_id, outcome: "unknown", errorCode: "segment_ended" });
                }
              }
            } catch {
              // the store is already gone with the turn
            }
            reopenForUnheard(turn, live);
            chainTurnEnded(turn.id);
            dispatchQueued();
            await noteArtifacts(turn, live);
            await submitAtEnd(turn.id);
          }
        }
      };
      void trackTurn(turn.id, run()).catch((error) => console.error("turn cleanup failed", error));
    });
  }

  /**
   * What the segment wrote into its job's folder, by content hash, for the supervisor's progress
   * (ADR 0045): read once the turn is over, streamed so a large render does not stall the daemon,
   * and recorded only where the hash is new. A file too large or gone by then is left out.
   */
  async function noteArtifacts(turn: Turn, live: Live): Promise<void> {
    const paths = (live.producedPaths ?? []).slice(-ARTIFACTS_HASHED_MAX);
    if (paths.length === 0 || !turn.task_id) return;
    let root: string | null;
    try {
      if (store.capabilities().engine_level < ENGINE_LEVELS.supervision) return;
      root = store.workspacePath();
    } catch {
      return; // the store closed with the daemon
    }
    if (!root) return;
    const artifacts: Array<{ path: string; sha256: string }> = [];
    for (const path of paths) {
      try {
        const file = Bun.file(join(root, path));
        if (file.size > ARTIFACT_HASH_BYTES_MAX || !statSync(join(root, path)).isFile()) continue;
        const hasher = new Bun.CryptoHasher("sha256");
        for await (const chunk of file.stream()) hasher.update(chunk);
        artifacts.push({ path, sha256: hasher.digest("hex") });
      } catch {
        // gone, or not readable: nothing to say about it
      }
    }
    try {
      if (artifacts.length > 0) store.recordArtifactProgress({ turnId: turn.id, artifacts });
    } catch (error) {
      console.error(`[turn ${turn.id}] could not record its artifacts`, error);
    }
  }

  /** Whether a closing reply hands over a file of the segment's ticket: one it wrote, or one its words cite. */
  function handsOver(turn: Turn, live: Live, body: string): boolean {
    if (!turn.ticket_id) return false;
    let dir: string;
    try {
      dir = store.getTicket(turn.ticket_id).dir;
    } catch {
      return false;
    }
    return [...live.writtenPaths, ...attachmentLinePaths(body), ...extractWorkspacePathsFromBody(body)].some((path) => inTicketDir(dir, path));
  }

  /**
   * From engine level 5, a segment that ended doing its work hands over what it cited in its
   * ticket's folder and had not handed over yet (§5.2's implicit submission): one that ended on a
   * send_message, a wait or a request, as much as one that said end_turn. One that ended blocked,
   * gave up, or was cut off hands nothing over.
   */
  async function submitAtEnd(turnId: string): Promise<void> {
    try {
      if (store.capabilities().engine_level < ENGINE_LEVELS.submissions) return;
      const ended = store.getTurn(turnId);
      if (ended.status !== "completed" || ["blocked", "gave_up", "needs_attention"].includes(ended.end_reason ?? "")) return;
      // The segment is over: a hand-over whose checks fail goes back to its producer as a line.
      await implicitSubmission(turnId, { tell: true });
    } catch (error) {
      console.error(`[turn ${turnId}] could not hand its files over`, error);
    }
  }

  /**
   * The hop loop runs detached, so a throw used to vanish and leave the row `running` for good:
   * the sidebar said Thinking until the next boot and the Bot waiting on the other side of a
   * handoff never heard back. Close the turn instead, and say so in the transcript.
   */
  async function crashTurn(turnId: string, error: unknown): Promise<void> {
    console.error(`[turn ${turnId}] crashed`, error);
    try {
      failTurn(turnId, "crashed");
    } catch {
      // the turn or the store is already gone; the sweep and the next boot still catch the row
    }
  }

  /**
   * Continue on an interrupted or failed turn: a new turn on the same job, from the line it left. A
   * hold over that job answers 409 `held` instead, so the button can ask whether to lift it; the
   * database refuses the row too (I2), since this path writes it without `createTurn`.
   */
  function continueFromInterrupt(messageId: string): Turn {
    admission?.assertNew();
    const note = store.getMessage(messageId);
    let cut: Turn | null = null;
    try {
      cut = note.turn_id ? store.getTurn(note.turn_id) : null;
    } catch {
      // no turn to continue: the claim below says so
    }
    const wake = {
      cause: "continue" as const,
      botId: cut?.bot_id ?? note.author,
      sessionId: note.session_id,
      taskId: cut?.task_id ?? null,
      ticketId: cut?.ticket_id ?? null,
      turnId: note.turn_id,
    };
    if (!mayWake(store, wake)) {
      throw new HttpError(409, "held", "a stop of yours covers this job: lift it before continuing");
    }
    const turn = store.claimInterruptContinue(messageId);
    attachLive(turn);
    return turn;
  }

  function abortLive(turnId: string): void {
    const live = lives.get(turnId);
    if (live) store.afterCommit(() => live.abort.abort());
  }

  async function drainLives(): Promise<void> {
    closing = true;
    clearChainTimers();
    clearDirectTimers();
    clearOrganizerTimers();
    clearPlanTimers();
    while (tasks.size > 0) {
      for (const id of [...lives.keys()]) abortLive(id);
      await Promise.allSettled([...tasks]);
    }
  }

  async function runTurn(turnId: string): Promise<void> {
    const live = lives.get(turnId);
    if (!live) return;
    const creds = await credentials();
    if (!active(turnId, live)) return;
    if (!creds) {
      failTurn(turnId, "unreachable");
      return;
    }
    let botId: string;
    try {
      botId = store.getTurn(turnId).bot_id;
    } catch {
      lives.delete(turnId);
      return;
    }
    let triggerBody = "";
    try {
      const turn = store.getTurn(turnId);
      triggerBody = store.getMessage(turn.trigger_message_id).body;
    } catch {
      triggerBody = "";
    }
    // From level 7 no model picks what a turn runs on (ADR 0048): your pin, the Bot's default or the endpoint's.
    const decided = store.routingOn();
    const agent = decided ? null : await agentRoute(turnId, botId, creds, triggerBody, live.abort.signal);
    if (!active(turnId, live)) return;
    const routed = decided ? decideRoute(botId, creds, triggerBody, turnId) : (agent?.routed ?? targetFor(botId, creds, triggerBody));
    if (!routed) {
      failTurn(turnId, "no_model");
      return;
    }
    const target = routed.target;
    live.target = { providerId: target.providerId, model: target.model };
    // A step up from trouble inside this turn (ADR 0054) moves only the thinking level of the hops
    // left: a model the ladder climbs to waits for the job's next turn, not the middle of this loop.
    live.restep = () => {
      const again = decideRoute(botId, creds, triggerBody, turnId);
      if (!again || again.target.providerId !== target.providerId || again.target.model !== target.model) return;
      if (again.target.thinkingLevel === target.thinkingLevel) return;
      target.thinkingLevel = again.target.thinkingLevel;
      store.stepTurnRoute(turnId, again.target.thinkingLevel);
    };
    const limits = hopLimits(
      store.catalogEntries().find((row) => row.providerId === target.providerId && row.name === target.model),
    );
    live.routing = routingTarget(creds);
    live.locale = target.locale;
    let sessionId: string | null = null;
    try {
      sessionId = store.getTurn(turnId).session_id;
    } catch {
      sessionId = null;
    }
    const turnOwner = spendOwner(sessionId ?? "", botId);
    // A turn the agent did not tie to the one before it starts a new chain, so the old one is done.
    if (sessionId && !agent?.pick.continuesPrevious) closeChain(sessionId, botId);
    try {
      store.recordTurnRoute({
        turnId,
        decision: routed.decision,
        reason: agent?.pick.reason ?? null,
        continuesPrevious: agent?.pick.continuesPrevious ?? false,
      });
    } catch {
      // route row is best-effort; the completion still carries the chosen fields
    }
    // The chain's quiet clock waits while this turn runs; its end starts it (`chainTurnEnded`).
    if (sessionId) holdChain(sessionId, botId);
    const drop = (): void => {
      lives.delete(turnId);
    };
    if (mcp) {
      for (const server of store.listMcpServers()) {
        if (!server.enabled) continue;
        if (server.instructions || server.tool_catalog.length > 0) continue;
        try {
          if (!active(turnId, live)) return;
          const next = await inspectForTurn(turnId, live, server);
          if (!active(turnId, live)) return;
          if (next && next.updated_at !== server.updated_at) {
            publish({ event: "mcp.upsert", occurred_at: occurred(), ...next });
          }
        } catch {
          // handshake catalog is best-effort
        }
      }
    }
    while (true) {
      let current: Turn;
      try {
        current = store.getTurn(turnId);
      } catch {
        drop();
        return;
      }
      live.hops += 1;
      if (current.status !== "running") {
        drop();
        return;
      }
      if (live.abort.signal.aborted) {
        drop();
        return;
      }
      store.touchTurn(turnId);
      // A long run of tool calls is asked, now and then, whether it is getting anywhere; past the
      // limit the tools go and the next reply is the turn's last (see turn-pace.ts).
      const pace = turnPace(live.hops);
      if (pace === "check_in") {
        live.loop.push({ role: "user", content: checkInNote(target.locale, live.hops - 1) });
      } else if (pace === "last" && !live.lastHopNoted) {
        live.lastHopNoted = true;
        live.loop.push({ role: "user", content: lastHopNote(target.locale) });
      }
      // The rows are authoritative: merges, corrections and recovery can queue mail without
      // touching this process's cache. Refresh at the boundary before delivering any item.
      const cached = new Set(live.inbox.flatMap((entry) => entry.seq === undefined ? [] : [entry.seq]));
      const queued = store.queuedForTurn(turnId);
      const stillQueued = new Set(queued.map((item) => item.seq));
      live.inbox = live.inbox.filter((entry) => entry.seq === undefined || stillQueued.has(entry.seq));
      // A line you changed before this turn read it reads as it now does (ADR 0063): the rows hold the words.
      const words = new Map(queued.map((item) => [item.seq, item.body_snapshot] as const));
      for (const entry of live.inbox) {
        const now = entry.seq === undefined ? undefined : words.get(entry.seq);
        if (now !== undefined && now !== entry.item.body) entry.item = { ...entry.item, body: now };
      }
      for (const item of queued) {
        if (cached.has(item.seq)) continue;
        let message: Message;
        try { message = item.message_id ? store.getMessage(item.message_id) : store.getMessage(current.trigger_message_id); }
        catch { continue; }
        live.inbox.push({ seq: item.seq, message, item: { author: item.author, body: item.body_snapshot,
          checkBack: item.source === "timer", ...(item.said_in ? { where: item.said_in } : {}) } });
      }
      // What was said to this Bot since the last hop, read out now: the turn goes on with it.
      // What was said to this Bot since the last hop. The tool loop delivers at the end of a hop, so
      // this only reads what arrived with no hop between — before the first one, or while a hop waited.
      if (live.inbox.length > 0) {
        const heard = live.inbox.splice(0);
        const seqs = heard.flatMap((entry) => (entry.seq === undefined ? [] : [entry.seq]));
        const { delivered } = seqs.length > 0 ? store.deliverInboxItems(seqs, turnId, live.hops) : { delivered: [] };
        const kept = new Set(delivered.map((row) => row.seq));
        const shown = heard.filter((entry) => entry.seq === undefined || kept.has(entry.seq));
        if (shown.length > 0) {
          const labels = new Map(delivered.map((row) => [row.seq, inboxLabel(row)]));
          live.loop.push({
            role: "user",
            content: heardNote(target.locale, shown.map((entry) => ({ ...entry.item, ...(entry.seq !== undefined ? { label: labels.get(entry.seq) } : {}) }))),
          });
        }
      }
      const listed = mcp ? await mcp.listForTurn() : { tools: [], guides: [] };
      if (!active(turnId, live)) return;
      const messages = assembleTurnMessages(store, {
        sessionId: current.session_id,
        botId: current.bot_id,
        turnId,
        triggerMessageId: current.trigger_message_id,
        locale: target.locale,
        interrupt: live.interrupt,
        loop: live.loop,
        mcpGuides: listed.guides,
      });
      const offered = pace === "last" ? [] : [...builtinTools(target.locale, store.capabilities().engine_level), ...listed.tools];
      // A read-only turn is not shown what it may not call (ADR 0040 I3); the gate refuses them anyway.
      const tools = current.mode === "readonly" ? readOnlyTools(offered, listed.guides) : offered;
      live.toolNames = new Set(tools.map((tool) => tool.function.name));
      // Each tool's argument names too: the external-job adapter reads which one a check takes the job's id in.
      const params = new Map(listed.tools.map((tool) => [tool.function.name,
        Object.keys(((tool.function.parameters ?? {}) as { properties?: Record<string, unknown> }).properties ?? {})] as const));
      live.mcpTools = new Map(listed.guides.flatMap((guide) =>
        guide.tools.map((tool) => [tool.modelName, { server: guide.name, tool: tool.toolName ?? tool.modelName, readOnly: tool.readOnly === true,
          params: params.get(tool.modelName) ?? [] }] as const)));
      // What it last said while working stays up through the next hop, as a Claude Agent Bot's
      // does: a hop that only calls tools does not wipe the line above them (2026-10-06).
      publishTurn(current, live.partial);
      let result;
      // Tokens no longer count as progress: a hop that streamed one sentence for 17 minutes looked
      // alive the whole time. The stream's own time limit bounds it instead, and the stale sweep
      // leaves the turn alone while it runs.
      live.streaming = true;
      try {
        result = await completions.complete({
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          thinkingLevel: target.thinkingLevel,
          messages,
          tools,
          signal: live.abort.signal,
          maxTokens: limits.maxTokens,
          wallMs: limits.wallMs,
          onEvent(chunk) {
            if (!active(turnId, live)) return;
            const choices = chunk.choices;
            if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return;
            const delta = ((choices[0] as { delta?: { tool_calls?: unknown } }).delta ?? {}) as {
              tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
            };
            if (!Array.isArray(delta.tool_calls)) return;
            for (const call of delta.tool_calls) {
              if (!call.id) continue;
              publish({
                event: "turn.tool",
                occurred_at: occurred(),
                turn_id: turnId,
                id: call.id,
                name: call.function?.name,
                arguments: call.function?.arguments,
                phase: "announced",
              });
            }
          },
        });
      } catch (error) {
        // Stop and redirect already wrote the turn's end state; anything else is a crash.
        if (live.abort.signal.aborted) {
          drop();
          return;
        }
        throw error;
      } finally {
        live.streaming = false;
      }
      recordSpend("turn", current.id, result.usage, result.missingReason, callOf(target), turnOwner);
      if (live.abort.signal.aborted) {
        drop();
        return;
      }
      try {
        if (store.getTurn(turnId).status !== "running") {
          drop();
          return;
        }
      } catch {
        drop();
        return;
      }
      // The sweep measures from here again, now that the stream no longer holds it off.
      store.touchTurn(turnId);

      if (result.hadChoices && live.interrupt && !live.burned) {
        live.burned = true;
        store.clearInterruptPending(current.bot_id);
      }

      if (!result.ok) {
        if (retryOrFail(turnId, live, result.failKind)) continue;
        return;
      }
      const failure = replyFailure(result);
      if (failure) {
        if (retryOrFail(turnId, live, failure)) continue;
        return;
      }
      live.retried = false;

      // Cut off at the output cap without looping: one more hop carries on from it. Nothing of the
      // cut reply is posted; cut again in a row, the turn fails.
      if (result.finishReason === "length" && result.toolCalls.length === 0) {
        if (live.continued) {
          failTurn(turnId, "truncated");
          return;
        }
        live.continued = true;
        if (result.content.trim()) live.loop.push({ role: "assistant", content: result.content });
        live.loop.push({ role: "user", content: continueNote(live.locale, result.toolArgsCut === true) });
        continue;
      }
      live.continued = false;

      if (result.toolCalls.length > 0) {
        live.loop.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls,
        });
        // What it says beside its tool calls ("let me check the file first") is shown while it
        // works, the same as a Claude Agent Bot's narration. Only these lines: a reply with no
        // calls is the closing one, which shows once its checks pass.
        if (result.content.trim()) {
          live.partial = result.content;
          publishTurn(store.getTurn(turnId), result.content);
        }
        const outcome = await executeTools(turnId, result.toolCalls);
        if (!active(turnId, live)) return;
        if (outcome === "wait") {
          if (live.abort.signal.aborted) drop();
          return;
        }
        if (outcome === "noop" || outcome === "spoke") {
          completeSilent(turnId);
          saidNothing(current, live);
          return;
        }
        continue;
      }

      // Nothing at all came back: ask once for the next step rather than end the turn silently
      // (see emptyReplyNote). The empty answer itself is not kept in the loop.
      if (!result.content.trim() && !live.emptyNudged) {
        live.emptyNudged = true;
        live.loop.push({ role: "user", content: emptyReplyNote(live.locale) });
        continue;
      }
      live.loop.push({ role: "assistant", content: result.content });
      const settled = await settleClosingReply(turnId, live, current, result.content);
      if (settled.kind === "bounce") {
        live.loop.push({ role: "user", content: settled.note });
        continue;
      }
      if (settled.kind === "inactive" && live.abort.signal.aborted) drop();
      return;
    }
  }

  /**
   * A closing reply — words with no tool call — taken through everything that has to pass before
   * it goes out: the no-work reading, the closing check, the level-5 hand-over of the files it cites,
   * the end contract, then the post, the completed status and whoever it wakes. Shared by the app's
   * own hop loop and a Claude Agent turn (ADR 0061). `bounce` is a line the Bot answers in one more
   * step; `ended` means the reply went out and the turn is completed; `inactive` means the turn
   * stopped meanwhile, and whatever stopped it wrote its end.
   */
  async function settleClosingReply(
    turnId: string,
    live: Live,
    current: Turn,
    content: string,
  ): Promise<{ kind: "bounce"; note: string } | { kind: "ended" } | { kind: "inactive" }> {
    const closer = await readsAsNoWork(content, (text) => readBotLine(text, current.session_id));
    if (!active(turnId, live)) return { kind: "inactive" };
    const rawBody = closer ? "" : content;
    // A delivery to the user goes out only after one look at what the job asked for. The note
    // comes back as a user line in the loop, and the next reply is final whatever it says.
    const closingBody = resolveBodyPathsToWorkDir(rawBody, live.workDir, (relpath) => pathExists(store, relpath));
    const bounce = await closingCheck(turnId, live, current, {
      body: closingBody,
      said: rawBody,
      paths: mergeCitedPaths(live.writtenPaths, [
        ...attachmentLinePaths(closingBody),
        ...extractWorkspacePathsFromBody(closingBody),
      ]),
      sessionId: current.session_id,
    });
    if (!active(turnId, live)) return { kind: "inactive" };
    if (bounce) return { kind: "bounce", note: bounce };
    // From level 5 a closing reply that hands files over goes out first, so what it cites is
    // handed over (the implicit submission) before the ending is weighed (§5.2). Words alone
    // are never inferred from a plain-text closing reply — that verbal hand-over once let
    // "母带剪好了" approve a ticket nobody checked (ADR 0046): a ticket whose work
    // is words closes only through an explicit `end_turn(done, answer)` (engine/tools.ts).
    let posted: Message | null | undefined;
    const files = store.capabilities().engine_level >= ENGINE_LEVELS.submissions && handsOver(current, live, closingBody);
    if (files) {
      posted = publishCitedBotMessage(current, live, turnId, rawBody);
      const produced = live.producedPaths ?? [];
      live.writtenPaths = [];
      let settled: Awaited<ReturnType<typeof implicitSubmission>> = null;
      try {
        settled = await implicitSubmission(turnId);
        // Files of a ticket someone else owns: not handed over for this Bot, which hears so once.
        const hint = !settled ? store.handOverHint({ turnId, paths: produced }) : null;
        if (hint) {
          if (posted && !live.parentId && current.mode !== "readonly") void track(handleParticipation(posted, { fromUser: false }));
          return { kind: "bounce", note: hint };
        }
      } catch (error) {
        console.error(`[turn ${turnId}] could not hand its files over`, error);
      }
      if (!active(turnId, live)) return { kind: "inactive" };
      // Handed over and sent back by its checks: the Bot hears why, and goes on (handing the same
      // bytes over again hands nothing over, so the next ending is weighed as usual).
      if (settled?.state === "checks_failed") {
        const lines = settled.failures.map((check) => live.locale === "en" ? `"${check.item}": ${check.detail || "fail"}` : `「${check.item}」：${check.detail || "不通过"}`);
        if (posted && !live.parentId && current.mode !== "readonly") void track(handleParticipation(posted, { fromUser: false }));
        return { kind: "bounce", note: live.locale === "en"
          ? `(app) What you handed over failed its checks, so the ticket did not move: ${lines.join("; ")}. Fix it, or end_turn saying what blocks you.`
          : `（应用）你交出的东西没过检查，任务没往前走：${lines.join("；")}。改好再交，或者用 end_turn 说明卡在哪。` };
      }
    }
    let endingLine: string | null = null;
    if (store.capabilities().engine_level >= ENGINE_LEVELS.delegation) {
      const lastWord = await readLastWord(turnId, current, rawBody);
      if (!active(turnId, live)) return { kind: "inactive" };
      const finished = store.finishWork({ turnId, reason: "done" }, { pureText: true, closing: rawBody, lastWord, written: live.producedPaths ?? live.writtenPaths });
      if (finished.bounce) {
        if (posted && !live.parentId && current.mode !== "readonly") void track(handleParticipation(posted, { fromUser: false }));
        return { kind: "bounce", note: finished.bounce };
      }
      if (finished.notice || finished.ask) endingLine = finished.ask?.body ?? finished.notice!.body;
    }
    const message = posted !== undefined ? posted : publishCitedBotMessage(current, live, turnId, rawBody);
    // The line about how it ended reads after the reply it is about (「它说了『…』，但这一轮已经结束了」).
    if (endingLine) {
      publishMessage(store.insertMessage({ sessionId: current.session_id, turnId, kind: "system", author: current.bot_id,
        body: endingLine, hiddenFromBots: true }));
    }
    if (message && live.writtenPaths.length > 0) observeTicket(turnId, current.bot_id, "delivered");
    const completed = store.setTurnStatus(turnId, "completed", executionOf(live));
    lives.delete(turnId);
    publishTurn(completed, null);
    // A closing reply goes out the way send_message would: in a group it wakes whoever it
    // names, in a Bot↔Bot direct the other Bot. A you↔Bot direct has no one else to wake. A
    // read-only turn's answer is for you and wakes nobody (ADR 0040 I2's exemption goes no further).
    if (message && !live.parentId && current.mode !== "readonly") {
      void track(handleParticipation(message, { fromUser: false }));
    }
    saidNothing(current, live);
    return { kind: "ended" };
  }

  /**
   * A read-only answer that ended having said nothing (2026-10-03: nine hops of reading, then an
   * empty reply): your line would sit there unanswered under a stop you might not know still holds.
   */
  function saidNothing(turn: Turn, live: Live): void {
    if (turn.mode !== "readonly" || live.spoke) return;
    // Ended as an answer, not stopped or cut off: those say so themselves.
    if (store.getTurn(turn.id).status === "completed") readOnlyUnanswered?.(turn);
  }

  /**
   * The counts a live turn has accumulated. Null when this process was not running the turn, so
   * the route row stays unknown instead of claiming a clean zero.
   */
  function executionOf(live: Live | undefined): TurnExecution | null {
    if (!live) return null;
    return {
      hops: live.hops,
      toolCalls: live.toolCalls,
      toolErrors: live.toolErrors,
      repeatedFailures: live.repeatedFailures,
      filesWritten: live.writtenPaths.length,
      failures: live.failures,
    };
  }

  function interruptTurn(current: Turn): void {
    const result = store.interruptTurnRecord(current.id, executionOf(lives.get(current.id)));
    if (result) {
      publishMessage(result.note);
      publishTurn(result.turn);
    }
  }

  /**
   * A hop that loops, is a canned refusal, arrives in half or runs past its time limit failed; it
   * is not a reply (ADR 0040 P1). None of it is posted or kept in the loop, so it wakes nobody. The
   * same model gets one more go with a note, and failing again in a row ends the turn with a failure
   * line in the session. The endpoint failing outright ends the turn at once: the client has already
   * asked again. True when the hop goes again.
   */
  function retryOrFail(turnId: string, live: Live, kind: FailKind): boolean {
    if (isRetriedFailure(kind) && !live.retried) {
      live.retried = true;
      live.loop.push({ role: "user", content: retryNote(live.locale, kind) });
      return true;
    }
    failTurn(turnId, kind);
    return false;
  }

  function failTurn(turnId: string, kind: FailKind, detail?: string | null): void {
    const live = lives.get(turnId);
    const current = store.getTurn(turnId);
    if (live?.abort.signal.aborted || !["running", "waiting_ask", "waiting_approval"].includes(current.status)) return;
    const locale = store.settingsCached().locale;
    const now = isoNow();
    const { message, completed } = store.transaction(() => {
      const message = store.insertMessage({
        sessionId: current.session_id,
        turnId,
        parentId: live?.parentId ?? null,
        kind: "system",
        author: current.bot_id,
        body: completionFailBody(locale, kind, detail),
      });
      store.voidPendingTurnActions(turnId, "turn_failed", now);
      store.finishTurnRoute(turnId, "failed", kind, executionOf(live));
      // A reply that failed again after its retry steps its job up for the next turn (ADR 0054).
      if (MODEL_FAIL_SHAPES.has(kind)) store.stepUpForTrouble(turnId, "failure_shape", now);
      // From level 8 how the turn failed is filed by its shape: a loop or a refusal is the model's (ADR 0050).
      if (store.learningOn()) {
        store.recordWorkEvent({ kind: "turn.failed", actor: "app", botId: current.bot_id, taskId: current.task_id, ticketId: current.ticket_id,
          turnId, sessionId: current.session_id, payload: { fail_kind: kind } });
      }
      // From the supervisor's level the job needs attention; its 「继续」 line is this failure line.
      // What only you can fix — Claude Code missing, signed out, out of usage — is not retried for
      // you: it would fail the same way until you do (ADR 0061).
      if (!USER_FIX_FAILS.has(kind)) store.markSegmentCutOff(turnId, kind);
      // Work the supervisor takes up is retried without you; it tells you when it stops retrying.
      if (store.isPresent(current.session_id, USER_MEMBER) && !store.supervisorTakesUp(turnId)) {
        store.createNotification({
          semantic_key: `failure:${turnId}`,
          kind: "failure",
          session_id: current.session_id,
          turn_id: turnId,
          message_id: message.id,
          created_at: now,
          action_state: "open",
          fail_kind: kind,
        });
      }
      return { message, completed: store.setTurnStatus(turnId, "completed") };
    });
    publishMessage(message);
    publishTurn(completed, null);
  }

  /**
   * Closes turns that stopped making progress. Without it a wedged turn sat at `running` until the
   * next boot: Thinking forever in the sidebar, and silence for whoever was waiting on the handoff.
   */
  function sweepStalledTurns(at: Date = new Date()): void {
    for (const turn of store.listLiveTurns()) {
      // waiting_approval and waiting_ask are waiting on you, so they never go stale.
      if (turn.status !== "running") continue;
      // A completion in flight has its own time limit, which the client enforces.
      if (lives.get(turn.id)?.streaming) continue;
      // A shut lid froze the turn along with everything else; that is not a turn getting nowhere.
      const last = Date.parse(turn.last_activity_at);
      const idle = at.getTime() - last - wake.sleptBetween(last, at.getTime());
      if (idle < STALE_TURN_MS) continue;
      abortLive(turn.id);
      try {
        failTurn(turn.id, "stuck");
      } catch {
        // the turn or the store is already gone; the next boot still closes the row
      }
    }
  }

  const agentRunner = createAgentRunner({
    store,
    publish,
    publishMessage,
    publishTurn,
    publishSpend: deps.publishSpend,
    occurred,
    lives,
    active,
    mcp,
    claudeCode: deps.claudeCode,
    agentQuery: deps.agentQuery,
    closeChain,
    holdChain,
    spendOwner,
    executeTools,
    openApprovalCard: deps.openApprovalCard,
    beforeEffect: deps.beforeEffect,
    noteWrittenPaths: deps.noteWrittenPaths,
    settleClosingReply,
    completeSilent,
    saidNothing,
    failTurn,
  });

  return {
    startTurn,
    hearOrStart,
    hearAcross,
    dispatchQueued,
    attachLive,
    continueFromInterrupt,
    abortLive,
    drainLives,
    executionOf,
    interruptTurn,
    failTurn,
    sweepStalledTurns,
  };
}
