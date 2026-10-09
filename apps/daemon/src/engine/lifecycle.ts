/**
 * A turn's life from the moment it is created to the moment its row says so: opening (fresh,
 * redirected over another live turn, or forked beside it), the hop loop that talks to the model
 * and hands tool calls off to `tools.ts`, and every way it can end — completed, interrupted,
 * crashed, stalled. This is the engine's busiest file because a turn's hop loop touches nearly
 * everything else: routing for where it runs, spend for what it costs, chains for what it belongs
 * to, tools for what it does, closing for what it is allowed to say, plan-watch for what it moves.
 */
import type {
  ClientEvent,
  Message,
  Turn,
} from "@real-bot/protocol";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { CompletionsClient } from "../completions";
import { planTagger, type PlanRef } from "../context/transcript";
import { HttpError } from "../errors";
import { troubleCount } from "./trouble";
import type { FailKind } from "../prompts";
import type { BotLineContext, BotLineReading } from "../line-reading";
import type { McpHost } from "../mcp-host";
import type { TurnAdmission } from "../quiesce";
import { isoNow } from "../ids";
import type { TurnExecution } from "../store/routing";
import { ENGINE_LEVELS } from "../store/schema-gate";
import type { Store } from "../store";
import { recentToolCalls, redirectCarryNote, type HeardItem } from "../turn-inbox";
import { recordHeard } from "./inbox-record";
import type { WakeWatch } from "../wake";
import type { Chains } from "./chains";
import type { Closing } from "./closing";
import { heldWake, mayWake, wakeOn, type WakeCause } from "./control";
import type { Participation } from "./participation";
import type { PlanWatch } from "./plan-watch";
import type { Routing } from "./routing";
import type { SpendTracker } from "./spend";
import type { Tools } from "./tools";
import type { InboxEntry, Live } from "./types";
import type { Spend } from "@real-bot/protocol";
import type { ClaudeCodeProbe } from "../claude-code/probe";
import { createAgentRunner, type AgentQuery } from "./agent-runner";
import { createTurnEndings } from "./lifecycle/endings";
import { createClosingReply } from "./lifecycle/closing-reply";
import { createHopLoop } from "./lifecycle/hop-loop";
import { createHearing } from "./lifecycle/hearing";

/** How many of a segment's written files are hashed for progress, newest first, and up to what size each. */
const ARTIFACTS_HASHED_MAX = 50;
const ARTIFACT_HASH_BYTES_MAX = 2 * 1024 ** 3;

export type LifecycleDeps = {
  store: Store;
  /** Which endpoints are model servers on this computer or network (ADR 0067). */
  localEndpoint?: (baseUrl: string) => boolean;
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
  /** A short call's spend: the context compaction's summary call bills to its turn this way (ADR 0068). */
  recordResponseSpend: SpendTracker["recordResponseSpend"];
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
  readBotLine?: (body: string, sessionId: string | null, context?: BotLineContext) => Promise<BotLineReading>;
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
  noteWrites: Tools["noteWrites"];
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
  const { store, publish, publishMessage, publishTurn, occurred, wake, mcp, admission, lives, tasks, active, trackTurn, spendOwner, closeChain, holdChain, chainTurnEnded, clearChainTimers, clearDirectTimers, clearOrganizerTimers, clearPlanTimers, executeTools, completeSilent, implicitSubmission } = deps;
  const endings = createTurnEndings(deps);
  const closingReply = createClosingReply(deps, endings);
  const hopLoop = createHopLoop(deps, endings, closingReply);
  const hearing = createHearing(deps);
  const { executionOf, crashTurn, interruptTurn, failTurn } = endings;
  const { settleClosingReply, saidNothing } = closingReply;
  const { runTurn } = hopLoop;
  const { hearIn, answersAsk, hearAcross } = hearing;

  function runsOnClaudeCode(botId: string): boolean {
    try {
      return store.getBot(botId).runner === "claude_code";
    } catch {
      return false;
    }
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
    // What it had not read says what the rows now say: a line you changed meanwhile (ADR 0063). A
    // line read after all, or one you took back (ADR 0069), leaves nothing to open a turn for.
    live.inbox = live.inbox.filter((entry) => {
      if (entry.seq === undefined) return true;
      const row = store.getInboxItem(entry.seq);
      if (row && row.state !== "queued" && row.state !== "held") return false;
      if (row && row.body_snapshot !== entry.item.body) entry.item = { ...entry.item, body: row.body_snapshot };
      return true;
    });
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
      // A segment that failed (`failTurn`) also reads `completed`: on 2026-10-08 视频导演's segment
      // died on an endpoint error mid-rework, and the scripts it had cited so far went to a 放行 card.
      if (store.getTurnRoute(turnId)?.outcome === "failed") return;
      // The segment is over: a hand-over whose checks fail goes back to its producer as a line.
      await implicitSubmission(turnId, { tell: true });
    } catch (error) {
      console.error(`[turn ${turnId}] could not hand its files over`, error);
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
    noteWrites: deps.noteWrites,
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
