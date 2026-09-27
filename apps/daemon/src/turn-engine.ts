import {
  USER_MEMBER,
  type ClientEvent,
  type ComposerSuggestion,
  type Message,
  type PendingJudgement,
  type Turn,
} from "@real-bot/protocol";
import { parseAskAnswer } from "./ask";
import { createCompletionsClient, type CompletionsClient } from "./completions";
import { createChains } from "./engine/chains";
import { createClosing } from "./engine/closing";
import { createComposer } from "./engine/composer";
import { createCore } from "./engine/core";
import { createDirectReport } from "./engine/direct-report";
import { createFire } from "./engine/fire";
import { createLifecycle } from "./engine/lifecycle";
import { createParticipation } from "./engine/participation";
import { createPlanWatch } from "./engine/plan-watch";
import { createRouting } from "./engine/routing";
import { createSpend } from "./engine/spend";
import { createTools } from "./engine/tools";
import { HttpError } from "./errors";
import { isoNow } from "./ids";
import type { McpHost } from "./mcp-host";
import { createOrganizer } from "./organizer";
import type { TurnAdmission } from "./quiesce";
import type { Store } from "./store";
import type { TurnExecution } from "./store/routing";
import { dropToolResults } from "./tool-results";
import { processWake, type WakeWatch } from "./wake";
import type { ShellStream } from "./workspace-tools";

export type TurnEngine = {
  handleInboundMessage: (
    message: Message,
    opts?: { fork?: boolean; fromUser?: boolean },
  ) => Promise<void>;
  fireRoutine: (routineId: string, now?: Date) => Turn | null;
  /** Wakes a Bot at a check-back it booked; null when it was voided, already fired, or nobody to wake. */
  fireCheckBack: (id: string, now?: Date) => Turn | null;
  /** Files a plan now, when nothing is running in it and something happened since its last version. */
  settlePlan: (taskId: string) => Promise<boolean>;
  /** Rewrites a plan's `map.md` and its tickets' `ticket.md` from what the store holds. */
  renderPlanMirrors: (taskId: string) => void;
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
  stop: (turnId?: string, opts?: { allowGroup?: boolean }) => Turn | null;
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
  /** How long a plan stays quiet after its last turn before the organizer files it. Tests shorten it. */
  settleQuietMs?: number;
  /** How long a Bot↔Bot direct stays quiet after its last turn before its opener is called back. Tests shorten it. */
  directQuietMs?: number;
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

  const core = createCore({
    store,
    publish,
    noteTurnEnded: (turn) => organizer.noteTurnEnded(turn),
    noteDirectTurnEnded: (turn) => directReport.noteDirectTurnEnded(turn),
  });

  const spend = createSpend({ store, publishSpend: core.publishSpend });

  const routing = createRouting({
    store,
    completions,
    recordResponseSpend: spend.recordResponseSpend,
    spendOwner: spend.spendOwner,
  });

  const organizer = createOrganizer({
    store,
    completions,
    async routing() {
      const creds = await routing.credentials().catch(() => null);
      return creds ? routing.routingTarget(creds) : null;
    },
    recordSpend({ sessionId, target, usage, responded }) {
      spend.recordResponseSpend({
        kind: "organize",
        owner: spend.spendOwner(sessionId, null),
        target: spend.callOf(target),
        usage,
        responded,
      });
    },
    draining: () => Boolean(options.admission?.draining),
    settleQuietMs: options.settleQuietMs,
    onQuiet: (taskId) => planWatch.reconcilePlan(taskId),
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
  });

  const directReport = createDirectReport({
    store,
    admission: options.admission,
    directQuietMs: options.directQuietMs,
    fireCheckBack: (id, now) => fire.fireCheckBack(id, now),
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
  });

  const tools = createTools({
    store,
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
    publishMessage: core.publishMessage,
    renderMirrors: organizer.renderMirrors,
    fireCheckBack: fire.fireCheckBack,
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
    routingTarget: routing.routingTarget,
    spendOwner: spend.spendOwner,
    callOf: spend.callOf,
    recordSpend: spend.recordSpend,
    closeChain: chains.closeChain,
    touchChain: chains.touchChain,
    clearChainTimers: chains.clearTimers,
    clearDirectTimers: directReport.clearTimers,
    clearOrganizerTimers: organizer.clearTimers,
    inspectForTurn: tools.inspectForTurn,
    executeTools: tools.executeTools,
    closingCheck: closing.closingCheck,
    publishCitedBotMessage: closing.publishCitedBotMessage,
    completeSilent: closing.completeSilent,
    observeTicket: planWatch.observeTicket,
    handleParticipation: participation.handleParticipation,
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

  return {
    async handleInboundMessage(message, opts) {
      const fromUser = opts?.fromUser ?? message.author === USER_MEMBER;
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
          if (store.collectRouteFeedback(message)) {
            const owner = store.feedbackOwner(message.id);
            if (owner) chains.touchChain(message.session_id, owner);
          }
          // Filed before any turn opens, so the turns it opens know their plan and ticket from
          // their first hop. The message itself is already published; only the Bots wait.
          await core.track(organizer.organizeMessage(message));
          // Read back with its stamp: a judgement weighs the plan the line was filed in.
          try {
            filed = store.getMessage(message.id);
          } catch {
            filed = message;
          }
          // The job's turns in other sessions hear it before any turn opens here, so the one that
          // opens can be told they already have it.
          lifecycle.hearAcross(filed);
        }
        await core.track(participation.handleParticipation(filed, { fromUser, fork: opts?.fork, opened: handOver }));
      } finally {
        handOver();
      }
    },
    settlePlan(taskId) {
      return organizer.settlePlan(taskId);
    },
    renderPlanMirrors(taskId) {
      organizer.renderMirrors(taskId);
    },
    sweepStaleChains: chains.sweepStaleChains,
    executionOf(turnId) {
      return lifecycle.executionOf(core.lives.get(turnId));
    },
    sweepToolResults,
    sweepStalledTurns: lifecycle.sweepStalledTurns,
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
      });
      return answered;
    },
    stop(turnId, opts) {
      const turn = store.stopTurn(turnId, {
        ...opts,
        execution: turnId ? lifecycle.executionOf(core.lives.get(turnId)) : null,
      });
      if (turn) {
        lifecycle.abortLive(turn.id);
        core.publishTurn(turn, null);
      }
      return turn;
    },
    continueFromInterrupt: lifecycle.continueFromInterrupt,
    abortAll() {
      chains.clearTimers();
      directReport.clearTimers();
      organizer.clearTimers();
      for (const id of [...core.lives.keys()]) lifecycle.abortLive(id);
    },
    unsettledTurnIds() {
      return [...core.turnTasks.keys()];
    },
    async drain() {
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
      await lifecycle.drainLives();
      for (const pending of [...participation.pendingJudges.values()]) participation.dropPendingJudgement(pending, true);
      await mcp?.close();
    },
  };
}
