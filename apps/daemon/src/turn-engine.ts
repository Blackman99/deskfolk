import {
  USER_MEMBER,
  type ClientEvent,
  type ComposerSuggestion,
  type ControlActionResult,
  type Hold,
  type Message,
  type PendingJudgement,
  type RestartCause,
  type Turn,
} from "@real-bot/protocol";
import { ablationList, NO_ABLATION, type Ablation } from "./ablation";
import { parseAskAnswer } from "./ask";
import { createCompletionsClient, type CompletionsClient } from "./completions";
import { createChains } from "./engine/chains";
import { createPlanChecks } from "./engine/checks";
import { createClosing } from "./engine/closing";
import { createSeamsJudge } from "./engine/seams-judge";
import { createComposer } from "./engine/composer";
import { HELD_CALL, mayAct } from "./engine/control";
import { createCore } from "./engine/core";
import { createDerivedChecks } from "./engine/derived-checks";
import { createSubmissions } from "./engine/submissions";
import { createRequirementCards } from "./engine/requirement-cards";
import { createDirectReport } from "./engine/direct-report";
import { createFire } from "./engine/fire";
import { createLifecycle } from "./engine/lifecycle";
import { createParticipation } from "./engine/participation";
import { createPlanWatch } from "./engine/plan-watch";
import { createRestart, type RestartSummary } from "./engine/restart";
import { createRouting } from "./engine/routing";
import { createSpend } from "./engine/spend";
import { createStatusQuestion } from "./engine/status-question";
import { createStop, type HoldRequest } from "./engine/stop";
import { createTools } from "./engine/tools";
import { HttpError } from "./errors";
import { isoNow } from "./ids";
import type { McpHost } from "./mcp-host";
import { createOrganizer } from "./organizer";
import { createScribe } from "./scribe";
import { createJobPoller } from "./engine/jobs";
import type { TurnAdmission } from "./quiesce";
import type { Store } from "./store";
import { ENGINE_LEVELS } from "./store/schema-gate";
import type { TurnExecution } from "./store/routing";
import { dropToolResults } from "./tool-results";
import { processWake, type WakeWatch } from "./wake";
import type { ShellStream } from "./workspace-tools";

export type TurnEngine = {
  handleInboundMessage: (
    message: Message,
    /** `ordinary`: a line of yours sent on again as any line, not read for a stop or a go on (a stop you undid). */
    opts?: { fork?: boolean; fromUser?: boolean; ordinary?: boolean },
  ) => Promise<void>;
  fireRoutine: (routineId: string, now?: Date) => Turn | null;
  /** Wakes a Bot at a check-back it booked; null when it was voided, already fired, or nobody to wake. */
  fireCheckBack: (id: string, now?: Date) => Turn | null;
  /** Files a plan now, when nothing is running in it and something happened since its last version. */
  settlePlan: (taskId: string) => Promise<boolean>;
  /** Rewrites a plan's `map.md` and its tickets' `ticket.md` from what the store holds. */
  renderPlanMirrors: (taskId: string) => void;
  /** Runs a plan's acceptance checks (all of them, or just `checkIds`) and rewrites its mirrors once done. */
  runPlanChecks: (taskId: string, opts?: { cause?: "settle" | "user" | "edit"; checkIds?: string[] }) => Promise<void>;
  /** Brings a plan's checks from your words in line after you changed its words, or one of them, on the board (ADR 0040 P3). */
  syncDerivedChecks: (taskId: string) => void;
  /** Puts a check from your words in force on your word from the board, runs it if it has a file, and syncs its plan. */
  confirmDerivedCheck: (checkId: string) => void;
  /**
   * These plans were set aside with their conversation's history, cleared or deleted (ADR 0040):
   * the settle and the look-again pending for each are dropped, so nothing fires into a cleared
   * conversation.
   */
  forgetPlans: (taskIds: readonly string[]) => void;
  assertAskPending: (askId: string, sessionId: string) => void;
  /**
   * Records your answer on the question and lets its turn go on. Choices are checked against the
   * ones it offered; returns the question as it now reads.
   */
  replyAsk: (askId: string, sessionId: string, answer: { selected?: unknown; custom?: unknown }) => Message;
  resolveApproval: (
    id: string,
    action: "allow_once" | "deny" | "always_allow",
    scope?: string,
    apiKey?: string,
  ) => unknown;
  /**
   * Ends a live turn. `button`: your Stop on its card, which from the engine level that brings holds
   * is a hold on this Bot's work in the plan that your next line about it lifts (ADR 0040 P2), so
   * the Bot goes on from what you say; without it — a conversation cleared, deleted or archived —
   * the turn only ends.
   */
  stop: (turnId?: string, opts?: { allowGroup?: boolean; button?: boolean }) => Turn | null;
  /** `POST /v1/holds`: a stop of yours from a button or a menu, and the live turns it covers ended. */
  createHold: (input: HoldRequest) => Hold;
  /** `POST /v1/holds/:id/lift`: your lift, and the work the hold ended opened again. */
  liftHold: (id: string) => Hold;
  /**
   * `POST /v1/messages/:id/control`: a button on a line about your stops (undo, widen, narrow, go
   * on), or on a restart notice (继续, 不续).
   */
  control: (messageId: string, input: { action: unknown; taskId?: unknown }) => ControlActionResult;
  /** Called once at boot, after recovery: a line per job the restart cut off, in the conversation it belongs to where you are (ADR 0041). */
  announceRestart: (cause: RestartCause) => RestartSummary;
  /** Ends every live turn a hold covers, after a write that may have made one (a plan parked on the board). */
  enforceHolds: () => void;
  continueFromInterrupt: (messageId: string) => Turn;
  abortAll: () => void;
  /** Includes interrupted runners and approved effects that have not settled yet. */
  unsettledTurnIds: () => string[];
  partialText: (turnId: string) => string | null;
  pendingJudgements: (sessionId?: string) => PendingJudgement[];
  /** Reviews chains the last run left open; called once after boot. */
  sweepStaleChains: () => void;
  /**
   * Counts a live turn has accumulated, so a shutdown that closes the row from outside the engine
   * can still record them. Null when this process is not running that turn.
   */
  executionOf: (turnId: string) => TurnExecution | null;
  sweepToolResults: (now?: Date) => void;
  /** Closes turns that stopped making progress; called on every scheduler tick. */
  sweepStalledTurns: (now?: Date) => void;
  /** Starts queued work that may start now (a durable answer queued it, say); nothing else. */
  dispatchQueuedWork: () => void;
  /**
   * A line of yours was filed under a job after it arrived (your correction of where it belongs):
   * the scribe reads it against that job's requirements now, once per line (ADR 0040 P3).
   */
  noteFiled: (messageId: string) => void;
  /**
   * One supervisor tick (ADR 0045), from the scheduler's: the store's repairs, pick-ups and
   * call-backs, then the segments it continues and the queue it dispatches. Off below the
   * supervisor's level and while draining.
   */
  supervise: (now?: Date) => void;
  /** One round of the external-job poller (ADR 0047), from the scheduler's tick: off below level 6. */
  pollJobs: (now?: Date) => void;
  suggestComposer: (sessionId: string, signal?: AbortSignal, guard?: () => void) => Promise<ComposerSuggestion[]>;
  drain: () => Promise<void>;
  close: () => Promise<void>;
};

export type TurnEngineOptions = {
  store: Store;
  publish: (event: ClientEvent) => void;
  completions?: CompletionsClient;
  sleep?: (ms: number) => Promise<void>;
  mcp?: McpHost;
  admission?: TurnAdmission;
  /** Where a running command's output goes while it runs; absent means nobody can watch. */
  streams?: ShellStream;
  /** What the process saw of macOS sleep; the daemon's own watch unless a test brings one. */
  wake?: WakeWatch;
  /** Overrides the shell's 10-minute timeout; tests use a short one. */
  shellTimeoutMs?: number;
  /** How long a plan stays quiet after its last turn before the organizer files it. Tests shorten it. */
  settleQuietMs?: number;
  /** How long a Bot↔Bot direct stays quiet after its last turn before its opener is called back. Tests shorten it. */
  directQuietMs?: number;
  /** How long a Bot's chain stays quiet after its last turn before it is reviewed. Tests shorten it. */
  chainQuietMs?: number;
  /** Side-calls switched off for a benchmark (see `ablation.ts`). The daemon never sets it. */
  ablation?: Ablation;
  /**
   * How long a group plan with everything handed over but work still in its progress, and its
   * session, stay quiet before the Bot that spoke last in it is called back. Tests shorten it.
   */
  planLeftQuietMs?: number;
  /** A test waits here, between one tool call returning and the next being looked at. */
  betweenCalls?: (turnId: string, live: { inbox: Array<{ seq?: number; item: { author: string; body: string; checkBack: boolean }; message: import("@real-bot/protocol").Message }> }) => Promise<void> | void;
};

/** Long enough to still be debugging last week's turn, short enough not to hoard. */
const TOOL_RESULTS_KEEP_MS = 7 * 24 * 60 * 60_000;
const TOOL_RESULTS_SWEEP_LIMIT = 200;

/**
 * Builds the turn engine: a bundle of modules under `./engine/` wired together over one shared
 * `store` and `publish`. The pieces have a natural dependency order (spend and routing first,
 * since nearly everything bills a call or picks a target; lifecycle last, since a turn's hop loop
 * is the one place that legitimately needs almost everything else). Where the *real* call graph
 * loops back — a turn's end notifying the organizer, a tool call re-entering participation, a
 * closing check reaching into lifecycle for `executionOf` — the earlier module takes a small
 * arrow function that only calls into the later module's `const` once the whole engine is built.
 */
export function createTurnEngine(options: TurnEngineOptions): TurnEngine {
  const store = options.store;
  const publish = options.publish;
  const wake = options.wake ?? processWake();
  const completions =
    options.completions ??
    createCompletionsClient({ ...(options.sleep ? { clock: { sleep: options.sleep } } : {}), wake });
  const mcp = options.mcp;
  const ablation = options.ablation ?? NO_ABLATION;
  if (ablation.size > 0) console.error(`[ablation] off: ${ablationList(ablation).join(", ")}`);

  const core = createCore({
    store,
    publish,
    noteTurnEnded: (turn) => {
      organizer.noteTurnEnded(turn);
      derivedChecks.noteTurnEnded(turn);
    },
    noteTurnStopped: (turn) => {
      organizer.noteTurnStopped(turn);
      if (turn.task_id) planWatch.forgetPlan(turn.task_id);
      // Measuring what was delivered before the stop wakes nobody.
      derivedChecks.noteTurnEnded(turn);
    },
    noteDirectTurnEnded: (turn) => directReport.noteDirectTurnEnded(turn),
  });

  const spend = createSpend({ store, publishSpend: core.publishSpend });

  const routing = createRouting({
    store,
    completions,
    recordResponseSpend: spend.recordResponseSpend,
    spendOwner: spend.spendOwner,
    ablation,
  });

  const organizer = createOrganizer({
    store,
    completions,
    async routing() {
      const creds = await routing.credentials().catch(() => null);
      return creds ? routing.routingTarget(creds) : null;
    },
    recordSpend({ sessionId, target, usage, responded }) {
      return spend.recordResponseSpend({
        kind: "organize",
        owner: spend.spendOwner(sessionId, null),
        target: spend.callOf(target),
        usage,
        responded,
      })?.id ?? null;
    },
    draining: () => Boolean(options.admission?.draining),
    settleQuietMs: options.settleQuietMs,
    onQuiet: (taskId) => planWatch.reconcilePlan(taskId),
    // Late-bound: `checks` is built after `organizer`, since it renders through
    // `organizer.renderMirrors`. Neither method is called until the engine is fully wired.
    checks: {
      beforeSettle: (taskId) => checks.beforeSettle(taskId),
      afterSettle: (taskId) => checks.afterSettle(taskId),
    },
    ablation,
  });

  const requirementCards = createRequirementCards({ store, publishMessage: core.publishMessage });

  const scribe = createScribe({
    store,
    completions,
    async routing() {
      const creds = await routing.credentials().catch(() => null);
      return creds ? routing.routingTarget(creds) : null;
    },
    // Billed as the organizer's kind (no Bot asked for either), with its own purpose so the spend
    // view shows it apart (ADR 0042).
    recordSpend({ sessionId, target, usage, responded }) {
      spend.recordResponseSpend({
        kind: "organize",
        purpose: "scribe",
        owner: spend.spendOwner(sessionId, null),
        target: spend.callOf(target),
        usage,
        responded,
      });
    },
    draining: () => Boolean(options.admission?.draining),
    // Entries it wrote down or raised may now be ones you asked for in two plans (ADR 0040 P3).
    onFiled: (quote, outcome) => {
      requirementCards.noteFiled(quote, [...outcome.added, ...outcome.raised]);
      // A part-level entry the scribe made of a line about delivered work reads as a complaint (§6.6).
      if (quote.message_id && outcome.added.length > 0) submissions.noteComplaint(quote.message_id, outcome.added);
    },
    ablation,
  });

  const seamsJudge = createSeamsJudge({
    completions,
    async routing() {
      const creds = await routing.credentials().catch(() => null);
      return creds ? routing.routingTarget(creds) : null;
    },
    spend,
  });

  const checks = createPlanChecks({
    store,
    admission: options.admission,
    wake,
    renderMirrors: organizer.renderMirrors,
    judgeContinuity: seamsJudge,
    ablation,
  });

  const derivedChecks = createDerivedChecks({
    store,
    publishMessage: core.publishMessage,
    run: (taskId, checkIds) => checks.run(taskId, { cause: "edit", checkIds }),
    track: core.track,
    renderMirrors: organizer.renderMirrors,
  });

  const chains = createChains({
    store,
    publish,
    occurred: core.occurred,
    completions,
    admission: options.admission,
    track: core.track,
    credentials: routing.credentials,
    routingTarget: routing.routingTarget,
    recordResponseSpend: spend.recordResponseSpend,
    spendOwner: spend.spendOwner,
    ablation,
    quietMs: options.chainQuietMs,
  });

  const directReport = createDirectReport({
    store,
    admission: options.admission,
    directQuietMs: options.directQuietMs,
    fireCheckBack: (id, now) => fire.fireCheckBack(id, now),
    ablation,
  });

  const composer = createComposer({
    store,
    completions,
    credentials: routing.credentials,
    recordResponseSpend: spend.recordResponseSpend,
    spendOwner: spend.spendOwner,
  });

  const closing = createClosing({
    store,
    completions,
    admission: options.admission,
    lives: core.lives,
    active: core.active,
    publishTurn: core.publishTurn,
    publishMessage: core.publishMessage,
    recordResponseSpend: spend.recordResponseSpend,
    spendOwner: spend.spendOwner,
    executionOf: (live) => lifecycle.executionOf(live),
    observeTicket: (turnId, botId, seen) => planWatch.observeTicket(turnId, botId, seen),
    ablation,
  });

  const participation = createParticipation({
    store,
    publish,
    publishMessage: core.publishMessage,
    occurred: core.occurred,
    admission: options.admission,
    completions,
    credentials: routing.credentials,
    targetFor: routing.targetFor,
    callOf: spend.callOf,
    spendOwner: spend.spendOwner,
    recordResponseSpend: spend.recordResponseSpend,
    startTurn: (...args) => lifecycle.startTurn(...args),
    hearOrStart: (...args) => lifecycle.hearOrStart(...args),
    ablation,
  });

  const tools = createTools({
    store,
    ...(options.shellTimeoutMs !== undefined ? { shellTimeoutMs: options.shellTimeoutMs } : {}),
    publish,
    publishMessage: core.publishMessage,
    publishTurn: core.publishTurn,
    occurred: core.occurred,
    wake,
    mcp,
    admission: options.admission,
    streams: options.streams,
    lives: core.lives,
    active: core.active,
    track: core.track,
    closingCheckForSend: closing.closingCheckForSend,
    handleParticipation: participation.handleParticipation,
    fireRoutine: (routineId, now) => fire.fireRoutine(routineId, now),
    observeTicket: (turnId, botId, seen) => planWatch.observeTicket(turnId, botId, seen),
    betweenCalls: options.betweenCalls
      ? async (turnId) => {
          const live = core.lives.get(turnId);
          if (live) await options.betweenCalls!(turnId, live);
        }
      : undefined,
    noteFiled: (messageId) => noteFiled(messageId),
    submissions: () => submissions,
  });

  const fire = createFire({
    store,
    publish,
    occurred: core.occurred,
    publishMessage: core.publishMessage,
    admission: options.admission,
    startTurn: (...args) => lifecycle.startTurn(...args),
    hearOrStart: (...args) => lifecycle.hearOrStart(...args),
    attachLive: (turn, carry) => lifecycle.attachLive(turn, carry),
  });

  const planWatch = createPlanWatch({
    store,
    admission: options.admission,
    renderMirrors: organizer.renderMirrors,
    fireCheckBack: fire.fireCheckBack,
    ablation,
    planLeftQuietMs: options.planLeftQuietMs,
  });

  const statusQuestion = createStatusQuestion({
    store,
    publishMessage: core.publishMessage,
    admission: options.admission,
    // Late-bound: `stops` is built after lifecycle; a status question only arrives once it is.
    heldLines: (taskId) => stops.heldLines(taskId),
  });

  const lifecycle = createLifecycle({
    store,
    publish,
    publishMessage: core.publishMessage,
    publishTurn: core.publishTurn,
    occurred: core.occurred,
    wake,
    mcp,
    admission: options.admission,
    completions,
    lives: core.lives,
    tasks: core.tasks,
    active: core.active,
    track: core.track,
    trackTurn: core.trackTurn,
    credentials: routing.credentials,
    agentRoute: routing.agentRoute,
    targetFor: routing.targetFor,
    decideRoute: routing.decideRoute,
    routingTarget: routing.routingTarget,
    spendOwner: spend.spendOwner,
    callOf: spend.callOf,
    recordSpend: spend.recordSpend,
    closeChain: chains.closeChain,
    holdChain: chains.holdChain,
    chainTurnEnded: chains.turnEnded,
    clearChainTimers: chains.clearTimers,
    clearDirectTimers: directReport.clearTimers,
    clearOrganizerTimers: organizer.clearTimers,
    clearPlanTimers: () => planWatch.clearTimers(),
    inspectForTurn: tools.inspectForTurn,
    executeTools: tools.executeTools,
    closingCheck: closing.closingCheck,
    publishCitedBotMessage: closing.publishCitedBotMessage,
    completeSilent: closing.completeSilent,
    observeTicket: planWatch.observeTicket,
    handleParticipation: participation.handleParticipation,
    // Late-bound: the engine below; a line only reaches a waiting segment once it is built.
    answerAsk: (askId, sessionId, custom) => { engine.replyAsk(askId, sessionId, { custom }); },
    implicitSubmission: (turnId, opts) => submissions.implicit(turnId, opts),
  });

  // Level 5's hand-overs and reviews (ADR 0046): checks run as a settle would, through the plan's runner.
  const jobPoller = createJobPoller({ store, mcp, track: core.track, dispatchQueued: () => lifecycle.dispatchQueued() });
  const submissions = createSubmissions({
    store,
    runChecks: (taskId, checkIds) => checks.run(taskId, { cause: "settle", checkIds }),
    syncDerived: (taskId) => derivedChecks.sync(taskId),
    citePaths: closing.citePaths,
    dispatchQueued: () => lifecycle.dispatchQueued(),
    workDir: (turnId) => core.lives.get(turnId)?.workDir ?? store.turnWorkDir(turnId),
    publishMessage: core.publishMessage,
    track: core.track,
  });

  const stops = createStop({
    store,
    publishMessage: core.publishMessage,
    publishTurn: core.publishTurn,
    admission: options.admission,
    lives: core.lives,
    executionOf: lifecycle.executionOf,
    abortLive: lifecycle.abortLive,
    startTurn: lifecycle.startTurn,
    hearOrStart: lifecycle.hearOrStart,
    // Late-bound: a button that sends a line on only arrives once the engine below exists. Sent
    // once the button's own write is in, the way a new line of yours is.
    redeliver: (message) => store.afterCommit(() => void core.track(engine.handleInboundMessage(message, { fromUser: true, ordinary: true }))),
    wakes: participation.botsToWake,
  });

  const restart = createRestart({
    store,
    publishMessage: core.publishMessage,
    continueFromInterrupt: lifecycle.continueFromInterrupt,
  });

  /**
   * Drops the daemon's own spill from work dirs whose job ended a week ago. Only `tool-results/`
   * goes: it is ours, it is large, and after the turn nothing reads it. Everything else in a work
   * dir is the user's, including the folder itself — a workspace is a computer, not a cache.
   */
  function sweepToolResults(now: Date = new Date()): void {
    const root = store.workspacePath();
    if (!root) return;
    let stale;
    try {
      stale = store.tasksClosedBefore(
        new Date(now.getTime() - TOOL_RESULTS_KEEP_MS).toISOString(),
        TOOL_RESULTS_SWEEP_LIMIT,
      );
    } catch {
      return;
    }
    dropToolResults(root, stale.flatMap((task) => [task.dir, ...store.listTicketDirs(task.id)]));
  }

  function assertAskPending(askId: string, sessionId: string): void {
    const ask = store.getMessage(askId);
    if (ask.kind !== "ask" || !ask.turn_id) {
      throw new HttpError(422, "invalid_args", "ask replies need a running turn");
    }
    if (sessionId !== ask.session_id) {
      throw new HttpError(422, "invalid_args", "ask reply must be in its session");
    }
    const turn = store.getTurn(ask.turn_id);
    if (turn.status !== "waiting_ask" || (turn.pending_ask_id && turn.pending_ask_id !== askId)) {
      throw new HttpError(422, "invalid_args", "ask is no longer pending");
    }
    const live = core.lives.get(turn.id);
    if (!live?.ask || live.ask.id !== askId) {
      throw new HttpError(422, "invalid_args", "ask replies need a running turn");
    }
  }

  // A committed authority revocation must also cancel an already-running completion/tool,
  // not merely prevent its next hop. The journal publishes only after the transaction commits.
  const stopAuthorityWatch = store.onCommit((event) => {
    if (event.event === "bot.upsert" && (event.archived_at || event.deleted_at)) {
      for (const turnId of [...core.lives.keys()]) {
        try { if (store.getTurn(turnId).bot_id === event.id) lifecycle.abortLive(turnId); } catch { lifecycle.abortLive(turnId); }
      }
    } else if (event.event === "turn.upsert" && !["running", "waiting_ask", "waiting_approval"].includes(event.status)) {
      if (event.end_reason === "bot_archived" || event.end_reason === "bot_deleted") lifecycle.abortLive(event.id);
    }
  });

  /**
   * A line of yours filed under a job after the arrival path ran (a desk segment opening one for it,
   * `work_on`, your correction): the scribe only reads a filed line, so it reads this one now. The
   * scribe reads each line once, so a line filed when it arrived is not read again.
   */
  function noteFiled(messageId: string): void {
    let body: string;
    try {
      const message = store.getMessage(messageId);
      if (message.kind !== "user") return;
      body = message.body;
    } catch {
      return;
    }
    store.afterCommit(() => void core.track(scribe.noteLine(messageId, scribe.handedOverAt(body))));
    store.afterCommit(() => submissions.noteComplaint(messageId));
  }

  const engine: TurnEngine = {
    async handleInboundMessage(message, opts) {
      const fromUser = opts?.fromUser ?? message.author === USER_MEMBER;
      // 进度询问: a status question about a plan this session has one to report on is answered from
      // the store's own rows, right here — before anything below would organize, judge, wake or
      // redirect a turn over it. The message is already stored and published; this only decides
      // what happens next.
      if (fromUser && !opts?.ordinary && statusQuestion.handle(message)) return;
      // 控制句: a line that is only a stop or a go on is carried out here and goes nowhere else — no
      // filing, no turn, no model call (ADR 0040 P2). A line that only might be one is marked with
      // the buttons and goes on below like any other. One sent on again after you undid its stop
      // skips both readings: you said it was neither.
      if (fromUser && !opts?.ordinary && stops.handleLine(message)) return;
      // Read as the line arrives: whether its job had handed something over, which is what a
      // complaint is judged by if the scribe files nothing for it. Its filing, or a turn it wakes,
      // may send that ticket back to doing over the complaint before the scribe gets to it.
      const handedOver = fromUser ? scribe.handedOverAt(message.body) : null;
      // Filing takes a model call, and the Bots it holds back show as thinking under the message
      // meanwhile, in the transcript and the list alike. Each row gives way once its turn or
      // judgement has started, so the Bot never blinks out in between.
      const organizing = fromUser
        ? participation
            .botsToWake(message)
            .map((botId) => participation.startPendingJudgement(message.session_id, message.id, botId, "organizing"))
        : [];
      const handOver = (): void => {
        for (const pending of organizing) participation.dropPendingJudgement(pending, true);
      };
      try {
        let filed = message;
        if (fromUser) {
          // From level 8 a reply is no feedback on the route it answers (ADR 0050): quality events are filed by type.
          if (!store.learningOn() && store.collectRouteFeedback(message)) {
            const owner = store.feedbackOwner(message.id);
            if (owner) chains.touchChain(message.session_id, owner);
          }
          // Filed before any turn opens, so the turns it opens know their plan and ticket from
          // their first hop. Once work items are on, the rows file the line and the organizer's
          // message-time call is gone (ADR 0040 P4b): it held every turn up for a guess.
          if (store.capabilities().engine_level < ENGINE_LEVELS.work_items) {
            await core.track(organizer.organizeMessage(message));
          }
          // Read back with its stamp: a judgement weighs the plan the line was filed in.
          try {
            filed = store.getMessage(message.id);
          } catch {
            filed = message;
          }
          // The rows decide where a line belongs when they can (ADR 0040 P4b), over the organizer's
          // filing: a dormant plan is not a candidate, so a complaint lands on the job still live.
          if (store.capabilities().engine_level >= ENGINE_LEVELS.work_items) {
            store.updatePlanDormancy();
            store.fileMessage(message.id);
            filed = store.getMessage(message.id);
            // A complaint about work handed over or approved sends it back before any turn opens on it.
            submissions.noteComplaint(filed.id);
          }
          // A Stop you pressed on this job goes once you say something more about it to that Bot,
          // before the line wakes anyone: what you say next is what the Bot goes on from.
          stops.liftOnYourLine(filed);
          // The job's turns in other sessions hear it before any turn opens here, so the one that
          // opens can be told they already have it.
          lifecycle.hearAcross(filed);
        }
        const targets = store.capabilities().engine_level >= ENGINE_LEVELS.work_items ? store.filingsOfMessage(filed.id) : [];
        if (targets.length > 1) {
          for (const target of targets) {
            const onJob = { ...filed, task_id: target.taskId, ticket_id: target.ticketId };
            if (fromUser) lifecycle.hearAcross(onJob);
            await core.track(participation.handleParticipation(onJob, { fromUser, fork: opts?.fork, opened: handOver }));
          }
        } else {
          await core.track(participation.handleParticipation(filed, { fromUser, fork: opts?.fork, opened: handOver }));
        }
      } finally {
        handOver();
        // Once the line is filed and has woken whom it wakes: the ledger never holds a turn back.
        if (fromUser) void core.track(scribe.noteLine(message.id, handedOver));
        // Its numbers become checks as soon as it is filed, whatever the scribe makes of it.
        if (fromUser) derivedChecks.noteLine(message.id);
        // Old rules of its plan that nobody found your words for are asked about, once.
        if (fromUser) requirementCards.noteLine(message.id);
      }
    },
    settlePlan(taskId) {
      return organizer.settlePlan(taskId);
    },
    renderPlanMirrors(taskId) {
      organizer.renderMirrors(taskId);
    },
    runPlanChecks(taskId, opts) {
      return checks.run(taskId, { cause: opts?.cause ?? "user", checkIds: opts?.checkIds });
    },
    syncDerivedChecks: derivedChecks.sync,
    confirmDerivedCheck: derivedChecks.confirm,
    forgetPlans(taskIds) {
      for (const taskId of taskIds) {
        organizer.forgetPlan(taskId);
        planWatch.forgetPlan(taskId);
      }
    },
    sweepStaleChains: chains.sweepStaleChains,
    executionOf(turnId) {
      return lifecycle.executionOf(core.lives.get(turnId));
    },
    sweepToolResults,
    dispatchQueuedWork: lifecycle.dispatchQueued,
    noteFiled,
    pollJobs(at = new Date()) {
      if (options.admission?.draining) return;
      jobPoller.poll(at);
    },
    supervise(at = new Date()) {
      if (store.capabilities().engine_level < ENGINE_LEVELS.supervision || options.admission?.draining) return;
      const tick = store.supervisorTick({ now: at.toISOString() });
      for (const message of tick.messages) core.publishMessage(message);
      // Gates a waiting hand-over needs before it can be decided: run now, read at the next tick.
      for (const due of tick.checksToRun ?? []) void core.track(checks.run(due.taskId, { cause: "settle", checkIds: due.checkIds }));
      // A segment cut off picks up from its own 「中断」 or failure line, as its Continue would:
      // same conversation, same stops, the line marked continued.
      const continued: string[] = [];
      for (const wake of tick.wakes) {
        if (!wake.noteId) continue;
        try {
          lifecycle.continueFromInterrupt(wake.noteId);
          continued.push(wake.noteId);
        } catch (error) {
          // Refused: no attempt, so no budget spent; the next tick queues a wake instead (ADR 0045).
          store.refuseSupervisorPickup({ checkBackId: wake.checkBackId, code: error instanceof HttpError ? error.code : "error", now: at.toISOString() });
        }
      }
      if (continued.length > 0) for (const message of store.settleRestartNotices(continued)) core.publishMessage(message);
      lifecycle.dispatchQueued();
    },
    sweepStalledTurns(at) {
      lifecycle.sweepStalledTurns(at);
      lifecycle.dispatchQueued();
    },
    fireRoutine: fire.fireRoutine,
    fireCheckBack: fire.fireCheckBack,
    assertAskPending,
    resolveApproval(id, action, scope, apiKey) {
      const rowForGate = store.getApproval(id);
      const liveForGate = core.lives.get(rowForGate.turn_id);
      const requiresKey =
        Boolean(rowForGate.requires_api_key) ||
        (liveForGate?.approval?.id === id && Boolean(liveForGate.approval.requiresApiKey));
      if (
        action === "allow_once" &&
        requiresKey &&
        !(typeof apiKey === "string" && apiKey.trim().length > 0)
      ) {
        throw new HttpError(422, "invalid_args", "api_key is required");
      }
      const row = store.resolveApproval(id, action, scope);
      publish({ event: "approval.upsert", occurred_at: core.occurred(), ...row });
      if (action === "always_allow" && row.kind_key) {
        const nextScope = row.kind_key === "unconstrained-shell" ? "*" : (scope ?? row.target ?? "*");
        const match = store.listAllowRules().find((r) => r.kind_key === row.kind_key && r.scope === nextScope);
        if (match) publish({ event: "allow_rule.upsert", occurred_at: core.occurred(), ...match });
      }
      store.afterCommit(() => {
        const live = core.lives.get(row.turn_id);
        if (!live?.approval || live.approval.id !== id || live.abort.signal.aborted || store.getTurn(row.turn_id).status !== "waiting_approval") return;
        const pending = live.approval;
        live.approval = undefined;
        const running = store.setTurnStatus(row.turn_id, "running");
        core.publishTurn(running);
        if (action === "deny") {
          pending.waiter({
            ok: false,
            error: { code: "denied", message: "denied" },
            emitted: [],
          });
          return;
        }
        void core.trackTurn(row.turn_id, (async () => {
          try {
            if (!core.active(row.turn_id, live)) return;
            // A stop of yours made while the card waited: the call it was for does not run (I3).
            if (!mayAct(store, row.turn_id)) {
              pending.waiter({ ok: false, error: { code: "held", message: HELD_CALL }, emitted: [] });
              return;
            }
            const result = await pending.run({ api_key: apiKey });
            if (core.active(row.turn_id, live)) pending.waiter(result);
          } catch (error) {
            pending.waiter(
              error instanceof HttpError
                ? { ok: false, error: { code: error.code, message: error.message }, emitted: [] }
                : { ok: false, error: { code: "failed", message: "tool failed" }, emitted: [] },
            );
          }
        })());
      });
      return row;
    },
    replyAsk(askId, sessionId, input) {
      store.assertUserMayPost(sessionId);
      assertAskPending(askId, sessionId);
      const ask = store.getMessage(askId);
      const turn = store.getTurn(ask.turn_id!);
      const live = core.lives.get(turn.id)!;
      const waiter = live.ask!.waiter;
      const now = isoNow();
      const answer = parseAskAnswer(ask.ask ?? null, input.selected, input.custom, now);
      const { answered, running } = store.transaction(() => {
        const answered = store.recordAskAnswer(askId, answer);
        store.db.run(
          "UPDATE turns SET status = 'running', pending_ask_id = NULL, updated_at = ? WHERE id = ?",
          [now, turn.id],
        );
        store.updateNotificationActionState(`ask:${askId}`, "resolved", "answered", true);
        return { answered, running: store.getTurn(turn.id) };
      });
      publish({ event: "message.upsert", occurred_at: core.occurred(), ...answered });
      core.publishTurn(running);
      store.afterCommit(() => {
        live.ask = undefined;
        waiter(answer);
        void core.track(scribe.noteAnswer(askId));
        derivedChecks.noteLine(askId);
        requirementCards.noteLine(askId);
      });
      return answered;
    },
    stop(turnId, opts) {
      // Your Stop names its turn, or it is the latest one live (the menu bar's, with no window open).
      const pressed = opts?.button ? (turnId ?? store.latestStoppableTurn({ allowGroup: opts.allowGroup })) : null;
      if (pressed) {
        const held = stops.stopByButton(pressed);
        if (held) return held;
      }
      const turn = store.stopTurn(turnId, {
        allowGroup: opts?.allowGroup,
        execution: turnId ? lifecycle.executionOf(core.lives.get(turnId)) : null,
      });
      if (turn) {
        lifecycle.abortLive(turn.id);
        core.publishTurn(turn, null);
      }
      return turn;
    },
    createHold: stops.hold,
    liftHold: stops.lift,
    control(messageId, input) {
      // A restart notice's buttons, and those on a line about checks from your words or about the
      // requirements ledger, work at any engine level; every other line's are about stops.
      const message = store.getMessage(messageId);
      if (message.control?.kind === "restart") return restart.act(message, input);
      if (message.control?.kind === "check") return derivedChecks.act(message, input);
      if (message.control?.kind === "requirement") return requirementCards.act(message, input);
      if (message.control?.kind === "review_item") return submissions.act(message, input);
      if (message.control?.kind === "rework") return submissions.answerRework(message, input);
      if (message.control?.kind === "ceiling") return submissions.answerCeiling(message, input);
      if (message.control?.kind === "model_default") {
        store.answerModelDefaultCard(message.id, input.action);
        return { made: [], lifted: [] };
      }
      return stops.act(messageId, input);
    },
    announceRestart: restart.announce,
    enforceHolds: stops.enforce,
    continueFromInterrupt: lifecycle.continueFromInterrupt,
    abortAll() {
      // Only a shutdown or a forced drain ends every turn at once: the next boot says what it cut off.
      store.noteTurnsCutByShutdown();
      chains.clearTimers();
      directReport.clearTimers();
      organizer.clearTimers();
      scribe.stop();
      checks.abortAll();
      planWatch.clearTimers();
      for (const id of [...core.lives.keys()]) lifecycle.abortLive(id);
    },
    unsettledTurnIds() {
      return [...core.turnTasks.keys()];
    },
    async drain() {
      scribe.stop();
      await lifecycle.drainLives();
    },
    partialText(turnId) {
      return core.lives.get(turnId)?.partial ?? null;
    },
    pendingJudgements(sessionId) {
      const rows = [...participation.pendingJudges.values()];
      const filtered = sessionId ? rows.filter((row) => row.session_id === sessionId) : rows;
      return filtered.sort((a, b) => {
        if (a.created_at < b.created_at) return -1;
        if (a.created_at > b.created_at) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    },
    suggestComposer: composer.suggestComposer,
    async close() {
      stopAuthorityWatch();
      store.noteTurnsCutByShutdown();
      checks.abortAll();
      scribe.stop();
      await lifecycle.drainLives();
      for (const pending of [...participation.pendingJudges.values()]) participation.dropPendingJudgement(pending, true);
      await mcp?.close();
    },
  };
  return engine;
}
