import {
  USER_MEMBER,
  attachmentLinePaths,
  INTERRUPT_NOTE_BODY,
  type AskAnswer,
  type ClientEvent,
  type ComposerSuggestion,
  type Locale,
  type Message,
  type McpServer,
  type PendingJudgement,
  type RouteOutcome,
  type Spend,
  type SpendKind,
  type ThinkingLevel,
  type Turn,
} from "@real-bot/protocol";
import { askAnswerText, parseAskAnswer } from "./ask";
import { pathExists, runCollabTool, type ToolResult } from "./collab-tools";
import {
  CLOSING_CHECK_SYSTEM,
  CLOSING_CHECK_TIMEOUT_MS,
  closingCheckNote,
  closingCheckPayload,
  parseClosingCheck,
} from "./closing-check";
import {
  createCompletionsClient,
  type ChatMessage,
  type CompletionsClient,
  type MappedUsage,
  type ToolCall,
} from "./completions";
import { assembleComposerSuggestUser, assembleJudgementUser, assembleTurnMessages, extractJudgement } from "./context";
import { parseComposerSuggestions } from "./composer-suggestions";
import { classifyMessage, messageSignature, type RouteDecision } from "./route-decision";
import { verdictIsClarification, verdictIsExperience } from "./route-agent";
import { chainWarrantsReview } from "./route-learning";
import { type TurnExecution } from "./store/routing";
import { parseRoutePick, parseRouteReview, type RoutePick } from "./route-agent";
import {
  ROUTE_LEARN_SYSTEM,
  ROUTE_PICK_SYSTEM,
  ROUTE_REVIEW_SYSTEM,
  routeLearnPayload,
  routePickPayload,
  routeReviewPayload,
} from "./prompts/routing";
import { toChatTools } from "./prompts/tool-schema";
import { FORGET, REMEMBER } from "./prompts/tools/memory";
import { UPDATE_SKILL } from "./prompts/tools/profile";
import { dropToolResults, serializeToolResult } from "./tool-results";
import { persistMcpInspect, type McpHost } from "./mcp-host";
import { parseMentions } from "./mentions";
import { sessionUpsertFields } from "./session-events";
import { isNoWorkCloser } from "./no-work";
import { checkInNote, lastHopNote, turnPace } from "./turn-pace";
import { createOrganizer } from "./organizer";
import {
  builtinTools,
  checkBackNoteBody,
  COLLAB_TOOL_NAMES,
  COMPOSER_SUGGEST_SYSTEM,
  completionFailBody,
  JUDGEMENT_SYSTEM,
  routineFireBody,
  unknownMentionBody,
  type FailKind,
} from "./prompts";
import { HttpError } from "./errors";
import type { TurnAdmission } from "./quiesce";
import { resolveCompletionTarget } from "./models";
import { isoNow, ulid } from "./ids";
import { isReservedTaskPath, localDate, type Store } from "./store";
import {
  extractWorkspacePathsFromBody,
  linkifyWorkspacePaths,
  mergeCitedPaths,
  resolveBodyPathsToWorkDir,
  writtenPathFromToolData,
} from "./artifact-paths";
import { classifyPath } from "./workspace-paths";
import { isWorkspaceTool, runWorkspaceTool, type ShellStream } from "./workspace-tools";
import { processWake, type WakeWatch } from "./wake";

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
};

type Live = {
  abort: AbortController;
  loop: ChatMessage[];
  interrupt: boolean;
  burned: boolean;
  partial: string;
  parentId: string | null;
  writtenPaths: string[];
  /** The plan dir this turn belongs to, for what is reserved at either level; null on turns from before work dirs. */
  planDir: string | null;
  /** This turn's work dir — its ticket's when it has one — looked up once: neither can change under a live turn. */
  workDir: string | null;
  /** Unknown `@token`s send_message already rejected once this turn. */
  mentionWarned: Set<string>;
  /** Tool names in the current hop's tools array; read_skill flags `mcp_` names a body cites that are missing. */
  toolNames: Set<string>;
  spoke: boolean;
  drainRejection: boolean;
  /** The closing check ran (or was skipped for good) this turn; it never runs twice. */
  closingChecked: boolean;
  /** The default endpoint's default model, for the closing check; null when none is configured. */
  routing: {
    baseUrl: string;
    apiKey: string;
    providerId: string;
    providerName: string;
    model: string;
    thinkingLevel: ThinkingLevel | null;
  } | null;
  /** The turn's locale, so a note handed back mid-loop reads like the rest of the prompt. */
  locale: Locale;
  /** Completion hops this turn has started. Written onto the route row when the turn closes. */
  hops: number;
  /** The hop limit's note is in the loop: it goes in once, and the tools stay away after it. */
  lastHopNoted?: boolean;
  toolCalls: number;
  toolErrors: number;
  /** Failed calls whose name and arguments match an earlier failure in this turn. */
  repeatedFailures: number;
  /** `${name}\n${arguments}` of calls that already failed, so a repeat can be recognised. */
  failedCalls: Set<string>;
  ask?: {
    id: string;
    toolCallId: string;
    waiter: (answer: AskAnswer) => void;
  };
  approval?: {
    id: string;
    toolCallId: string;
    run: (opts?: { api_key?: string }) => Promise<ToolResult> | ToolResult;
    waiter: (result: ToolResult) => void;
    requiresApiKey?: boolean;
  };
};

export function createTurnEngine(options: TurnEngineOptions): TurnEngine {
  const store = options.store;
  const publish = options.publish;
  const wake = options.wake ?? processWake();
  const completions =
    options.completions ??
    createCompletionsClient({ ...(options.sleep ? { clock: { sleep: options.sleep } } : {}), wake });
  const mcp = options.mcp;
  const lives = new Map<string, Live>();
  const tasks = new Set<Promise<unknown>>();
  const turnTasks = new Map<string, Set<Promise<unknown>>>();
  const pendingJudges = new Map<string, PendingJudgement>();
  const organizer = createOrganizer({
    store,
    completions,
    async routing() {
      const creds = await credentials().catch(() => null);
      return creds ? routingTarget(creds) : null;
    },
    recordSpend({ sessionId, target, usage, responded }) {
      recordResponseSpend({ kind: "organize", owner: spendOwner(sessionId, null), target: callOf(target), usage, responded });
    },
    draining: () => Boolean(options.admission?.draining),
    settleQuietMs: options.settleQuietMs,
  });

  function track<T>(promise: Promise<T>): Promise<T> {
    tasks.add(promise);
    void promise.then(() => tasks.delete(promise), () => tasks.delete(promise));
    return promise;
  }

  function trackTurn<T>(turnId: string, promise: Promise<T>): Promise<T> {
    const pending = turnTasks.get(turnId) ?? new Set<Promise<unknown>>();
    turnTasks.set(turnId, pending);
    pending.add(promise);
    const done = () => {
      pending.delete(promise);
      if (pending.size === 0) turnTasks.delete(turnId);
    };
    void promise.then(done, done);
    return track(promise);
  }

  function active(turnId: string, live: Live): boolean {
    if (live.abort.signal.aborted || lives.get(turnId) !== live) return false;
    return store.getTurn(turnId).status === "running";
  }

  function occurred(): string {
    return new Date().toISOString();
  }

  function publishTurn(turn: Turn, partial: string | null = null): void {
    store.setTurnPartial(turn.id, partial);
    publish({ event: "turn.upsert", occurred_at: occurred(), ...turn, partial_text: partial });
    // Every way a turn ends passes through here, so this is where its plan learns to file itself.
    if (turn.status !== "running" && turn.status !== "waiting_ask" && turn.status !== "waiting_approval") {
      organizer.noteTurnEnded(turn);
    }
  }

  function publishMessage(message: Message): void {
    publish({ event: "message.created", occurred_at: occurred(), ...message });
  }

  function publishSpend(row: Spend): void {
    publish({ event: "spend.created", occurred_at: occurred(), ...row });
  }

  type Creds = {
    locale: Locale;
    defaultProviderId: string | null;
    providers: Array<{
      id: string;
      name: string;
      baseUrl: string;
      apiKey: string;
      models: string[];
      defaultModel: string | null;
    }>;
  };

  type ResolvedTarget = {
    baseUrl: string;
    apiKey: string;
    providerId: string;
    providerName: string;
    model: string;
    thinkingLevel: ThinkingLevel;
    locale: Locale;
  };

  /** What one billed call actually ran on. Frozen before the call so a later delete cannot move it. */
  type CallTarget = {
    providerId: string;
    providerName: string;
    model: string;
    thinkingLevel: ThinkingLevel | null;
  };

  /** Session and Bot as they are before the call. Names are snapshotted here; a delete during the call cannot rewrite them. */
  type SpendOwner = {
    sessionId: string;
    sessionName: string | null;
    botId: string | null;
    botName: string | null;
  };

  async function credentials(): Promise<Creds | null> {
    const settings = await store.settings();
    const providers = await store.listProviders();
    const ready: Creds["providers"] = [];
    for (const provider of providers) {
      if (!provider.base_url) continue;
      const apiKey = await store.endpointKey(provider.id);
      if (!apiKey) continue;
      ready.push({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.base_url,
        apiKey,
        models: provider.models,
        defaultModel: provider.default_model,
      });
    }
    if (ready.length === 0) return null;
    return {
      locale: settings.locale,
      defaultProviderId: settings.default_provider_id,
      providers: ready,
    };
  }

  type Routed = { target: ResolvedTarget; decision: RouteDecision };

  /**
   * Has one closed chain judged: was the model the thing at fault, or was it the request, or the
   * job itself? The verdict is recorded either way, because recording it is what closes the chain;
   * only a confident `model` verdict is read back when picking later.
   */
  async function reviewChain(chainId: string): Promise<void> {
    if (options.admission?.draining) return;
    let chain;
    try {
      chain = store.chainForReview(chainId);
    } catch {
      return;
    }
    if (!chain) return;
    // A quiet chain is only worth a review when the model side failed, or the tools failed twice.
    // A clean finish is recorded locally so the chain closes, without paying for a call.
    if (
      !chainWarrantsReview({
        followUps: chain.followUps.length,
        outcome: chain.outcome === "running" ? null : (chain.outcome as RouteOutcome),
        failKind: chain.execution.failKind,
        toolErrors: chain.execution.toolErrors,
      })
    ) {
      try {
        store.recordRouteReview({
          botId: chain.botId,
          chainId,
          turnId: chain.turnId,
          sessionId: chain.sessionId,
          signature: chain.signature,
          model: chain.model,
          thinkingLevel: chain.thinkingLevel,
          verdict: { fault: "none", direction: "same", rounds: 0, confidence: 1, reason: "" },
        });
      } catch {
        // best effort
      }
      return;
    }
    const creds = await credentials().catch(() => null);
    const routing = creds ? routingTarget(creds) : null;
    if (!creds || !routing || options.admission?.draining) return;
    let bot;
    try {
      bot = store.getBot(chain.botId);
    } catch {
      return;
    }
    const owned = spendOwner(chain.sessionId, chain.botId);
    const payload = routeReviewPayload({
      bot: { name: bot.name, duties: bot.duties },
      message: chain.triggerMessage,
      model: chain.model,
      thinkingLevel: chain.thinkingLevel,
      reply: chain.reply,
      outcome: chain.outcome,
      followUps: chain.followUps,
      execution: {
        hops: chain.execution.hops,
        tool_calls: chain.execution.toolCalls,
        tool_errors: chain.execution.toolErrors,
        repeated_failures: chain.execution.repeatedFailures,
        files_written: chain.execution.filesWritten,
        fail_kind: chain.execution.failKind,
        cost_usd_ticks: chain.execution.costUsdTicks,
      },
    });
    let result;
    try {
      result = await completions.judge({
        baseUrl: routing.baseUrl,
        apiKey: routing.apiKey,
        model: routing.model,
        messages: [
          { role: "system", content: ROUTE_REVIEW_SYSTEM },
          { role: "user", content: JSON.stringify(payload) },
        ],
        signal: new AbortController().signal,
      });
    } catch {
      return;
    }
    recordResponseSpend({
      kind: "route_review",
      owner: owned,
      turnId: chain.turnId,
      chainId,
      target: routing,
      usage: result.usage,
      responded: result.failKind === null || result.failKind === "incomplete",
    });
    if (options.admission?.draining || (result.failKind && result.failKind !== "incomplete")) return;
    const verdict = parseRouteReview(result.content ?? "");
    // An unreadable verdict leaves the chain open: better a late review than a wrong conclusion.
    if (!verdict) return;
    try {
      store.recordRouteReview({
        botId: chain.botId,
        chainId,
        turnId: chain.turnId,
        sessionId: chain.sessionId,
        signature: chain.signature,
        model: chain.model,
        thinkingLevel: chain.thinkingLevel,
        verdict,
      });
    } catch {
      return;
    }
    if (options.admission?.draining) return;
    const stumbledAndFinished =
      chain.outcome === "completed" &&
      chain.execution.toolErrors !== null &&
      chain.execution.toolErrors > 0;
    // A request the user had to spell out twice is worth remembering for what they meant; that
    // hop may write a memory but not touch a skill, since nothing about the procedure was wrong.
    const clarification = verdictIsClarification(verdict);
    if (!verdictIsExperience(verdict) && !stumbledAndFinished && !clarification) return;
    await learnFromChain(chain, routing, verdict, clarification ? "clarification" : "experience");
  }

  /**
   * One short call, on the default model, that may write a memory or revise an existing skill.
   * Two tool hops at most. A call that uses no tool writes nothing, and nothing is posted to the
   * transcript either way. After a clarification the skill tool is withheld.
   */
  async function learnFromChain(
    chain: NonNullable<ReturnType<Store["chainForReview"]>>,
    routing: CallTarget & { baseUrl: string; apiKey: string },
    verdict: { fault: string; direction: string; reason: string },
    mode: "experience" | "clarification" = "experience",
  ): Promise<void> {
    const written: { kind: "memory" | "skill"; label: string }[] = [];
    const tools = toChatTools(
      mode === "clarification" ? [REMEMBER, FORGET] : [REMEMBER, FORGET, UPDATE_SKILL],
      "zh",
    );
    const allowed = new Set(tools.map((tool) => tool.function.name));
    let skills: { name: string; description: string }[] = [];
    try {
      skills = store.listSkills(chain.botId).map((skill) => ({
        name: skill.name,
        description: skill.description,
      }));
    } catch {
      skills = [];
    }
    const owned = spendOwner(chain.sessionId, chain.botId);
    const messages: ChatMessage[] = [
      { role: "system", content: ROUTE_LEARN_SYSTEM },
      {
        role: "user",
        content: JSON.stringify(
          routeLearnPayload({
            message: chain.triggerMessage,
            model: chain.model,
            thinkingLevel: chain.thinkingLevel,
            reply: chain.reply,
            outcome: chain.outcome,
            followUps: chain.followUps,
            execution: {
              hops: chain.execution.hops,
              tool_calls: chain.execution.toolCalls,
              tool_errors: chain.execution.toolErrors,
              repeated_failures: chain.execution.repeatedFailures,
              files_written: chain.execution.filesWritten,
              fail_kind: chain.execution.failKind,
              cost_usd_ticks: chain.execution.costUsdTicks,
            },
            verdict,
            skills,
          }),
        ),
      },
    ];
    for (let hop = 0; hop < 2; hop += 1) {
      if (options.admission?.draining) return;
      let result;
      try {
        result = await completions.judge({
          baseUrl: routing.baseUrl,
          apiKey: routing.apiKey,
          model: routing.model,
          messages,
          tools,
          signal: new AbortController().signal,
        });
      } catch {
        return;
      }
      recordResponseSpend({
        kind: "route_learn",
        owner: owned,
        chainId: chain.chainId,
        target: routing,
        usage: result.usage,
        responded: result.failKind === null || result.failKind === "incomplete",
      });
      if (result.failKind && result.failKind !== "incomplete") break;
      const calls = result.toolCalls.filter((call) => allowed.has(call.name));
      if (calls.length === 0) break;
      messages.push({
        role: "assistant",
        content: result.content,
        tool_calls: calls,
      });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = {};
        }
        const ran = await runCollabTool(
          {
            store,
            botId: chain.botId,
            sessionId: chain.sessionId,
            turnId: chain.turnId,
            parentId: null,
            learnedChainId: chain.chainId,
          },
          call.name,
          args,
        );
        for (const item of ran.emitted) {
          if (item.kind === "memory") {
            written.push({ kind: "memory", label: item.memory.subject });
            publish({
              event: "memory.upsert",
              occurred_at: occurred(),
              ...store.memoryWithLearning(item.memory),
            });
          } else if (item.kind === "memory_removed") {
            publish({ event: "memory.removed", occurred_at: occurred(), id: item.id });
          } else if (item.kind === "skill") {
            written.push({ kind: "skill", label: item.skill.name });
            publish({
              event: "skill.upsert",
              occurred_at: occurred(),
              ...store.skillWithLearning(item.skill),
            });
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(ran.ok ? { ok: true, data: ran.data } : { ok: false, error: ran.error }),
        });
      }
    }
    const kept = written.find((item) => item.kind === "memory") ?? written[0] ?? null;
    try {
      store.recordRouteLearning({
        chainId: chain.chainId,
        botId: chain.botId,
        sessionId: chain.sessionId,
        kind: kept?.kind ?? "none",
        label: kept?.label ?? "",
      });
    } catch {
      // the note is for the log; losing it does not undo what was written
    }
  }

  /** Closes whatever chain this Bot has open here, if any. */
  function closeChain(sessionId: string, botId: string): void {
    clearChainTimer(sessionId, botId);
    let chainId: string | null = null;
    try {
      chainId = store.openChain(sessionId, botId, chainFloor());
    } catch {
      return;
    }
    if (chainId) void track(reviewChain(chainId));
  }

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

  /**
   * The quiet timers live in this process, so a daemon that stopped mid-chain would leave the
   * review undone until the user happened to change the subject. On start, chains that went quiet
   * while nobody was running are reviewed — recent ones only, and a bounded number of them.
   */
  function sweepStaleChains(): void {
    let chains: string[] = [];
    try {
      chains = store.staleOpenChains({
        quietBefore: new Date(Date.now() - CHAIN_QUIET_MS).toISOString(),
        notBefore: chainFloor(),
        limit: CHAIN_SWEEP_LIMIT,
      });
    } catch {
      return;
    }
    for (const chainId of chains) void track(reviewChain(chainId));
  }

  function chainKey(sessionId: string, botId: string): string {
    return `${sessionId}:${botId}`;
  }

  function clearChainTimer(sessionId: string, botId: string): void {
    const key = chainKey(sessionId, botId);
    const timer = chainTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    chainTimers.delete(key);
  }

  /** Restarts the quiet clock: every new word about the same thing pushes the review back. */
  function touchChain(sessionId: string, botId: string): void {
    clearChainTimer(sessionId, botId);
    if (options.admission?.draining) return;
    const key = chainKey(sessionId, botId);
    const timer = setTimeout(() => {
      chainTimers.delete(key);
      closeChain(sessionId, botId);
    }, CHAIN_QUIET_MS);
    timer.unref?.();
    chainTimers.set(key, timer);
  }

  /** A chain closes when the user goes quiet, even if they never say so. */
  /** Long enough to still be debugging last week's turn, short enough not to hoard. */
  const TOOL_RESULTS_KEEP_MS = 7 * 24 * 60 * 60_000;
  const TOOL_RESULTS_SWEEP_LIMIT = 200;

  const CHAIN_QUIET_MS = 3 * 60_000;
  /** Past this, a chain is cold: not joined by a new turn, and not worth a review call. */
  const CHAIN_MAX_AGE_MS = 24 * 60 * 60_000;
  /** How many chains one restart is willing to pay to catch up on. */
  const CHAIN_SWEEP_LIMIT = 20;
  const chainTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function chainFloor(): string {
    return new Date(Date.now() - CHAIN_MAX_AGE_MS).toISOString();
  }

  /**
   * The routing agent cannot route itself, so it always runs on the default endpoint's default
   * model. That is the one job the roster-wide default model still has.
   */
  function routingTarget(creds: Creds): (CallTarget & { baseUrl: string; apiKey: string }) | null {
    const provider =
      creds.providers.find((row) => row.id === creds.defaultProviderId) ?? creds.providers[0];
    const model = provider?.defaultModel ?? provider?.models[0] ?? null;
    if (!provider || !model) return null;
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      providerId: provider.id,
      providerName: provider.name,
      model,
      thinkingLevel: null,
    };
  }

  /** The message a reviewed turn was opened by, trimmed to what the picker needs to recognise it. */
  function triggerOf(turnId: string): string {
    try {
      const route = store.getTurnRoute(turnId);
      if (!route) return "";
      return store.getMessage(route.trigger_message_id).body;
    } catch {
      return "";
    }
  }

  /**
   * Asks a model what this message should run on. Everything that could go wrong — no endpoint, a
   * timeout, an answer naming something that does not exist — returns null and the rules take over.
   * The user is waiting; nothing here retries.
   */
  async function agentRoute(
    turnId: string,
    botId: string,
    creds: Creds,
    text: string,
    signal: AbortSignal,
  ): Promise<{ routed: Routed; pick: RoutePick } | null> {
    if (!text.trim()) return null;
    const routing = routingTarget(creds);
    if (!routing) return null;
    let bot;
    try {
      bot = store.getBot(botId);
    } catch {
      return null;
    }
    // A Bot that pinned both has already answered the question.
    if (bot.model && bot.thinking_level) return null;
    const providerIds = creds.providers.map((row) => row.id);
    const candidates = store.routeCandidates({
      botModel: bot.model,
      botProviderId: bot.provider_id,
      providerIds,
    });
    if (candidates.length === 0) return null;

    let previous: { message: string; model: string; thinkingLevel: string } | null = null;
    let payload;
    try {
      previous = store.previousDecisionFor(botId);
      payload = routePickPayload({
        message: text,
        bot: { name: bot.name, duties: bot.duties, boundaries: bot.boundaries },
        candidates,
        previous,
        pastReviews: store.recentRouteReviews(botId).map((row) => ({
          message: triggerOf(row.turn_id),
          signature: row.signature,
          model: row.model,
          thinkingLevel: row.thinking_level,
          direction: row.direction,
          rounds: row.rounds,
          reason: row.reason,
        })),
        cleanCompletions: store.cleanCompletions(botId),
      });
    } catch {
      return null;
    }

    let owned: SpendOwner;
    try {
      owned = spendOwner(store.getTurn(turnId).session_id, botId);
    } catch {
      owned = { sessionId: "", sessionName: null, botId, botName: null };
    }
    let result;
    try {
      result = await completions.judge({
        baseUrl: routing.baseUrl,
        apiKey: routing.apiKey,
        model: routing.model,
        messages: [
          { role: "system", content: ROUTE_PICK_SYSTEM },
          { role: "user", content: JSON.stringify(payload) },
        ],
        signal,
      });
    } catch {
      return null;
    }
    recordResponseSpend({
      kind: "route_pick",
      owner: owned,
      turnId,
      target: routing,
      usage: result.usage,
      responded: result.failKind === null || result.failKind === "incomplete",
    });
    if (result.failKind && result.failKind !== "incomplete") return null;
    const pick = parseRoutePick(result.content ?? "", candidates);
    if (!pick) return null;
    const provider = creds.providers.find((row) => row.id === pick.providerId);
    if (!provider) return null;
    return {
      pick,
      routed: {
        target: {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          providerId: provider.id,
          providerName: provider.name,
          model: pick.model,
          thinkingLevel: pick.thinkingLevel,
          locale: creds.locale,
        },
        decision: {
          model: pick.model,
          thinkingLevel: pick.thinkingLevel,
          providerId: pick.providerId,
          signature: messageSignature(text),
        },
      },
    };
  }

  /**
   * Picks the endpoint, model and thinking level for one turn. The Bot's own experience shapes the
   * pick; the decision is returned alongside so the caller records exactly what ran.
   */
  function targetFor(botId: string, creds: Creds, text: string): Routed | null {
    let botModel: string | null = null;
    let botProviderId: string | null = null;
    let botThinkingLevel: ThinkingLevel | null = null;
    try {
      const bot = store.getBot(botId);
      botModel = bot.model;
      botProviderId = bot.provider_id;
      botThinkingLevel = bot.thinking_level;
    } catch {
      botModel = null;
      botProviderId = null;
      botThinkingLevel = null;
    }
    const providerIds = creds.providers.map((row) => row.id);
    const routed = store.decideTurnRoute({ botId, text, botModel, botProviderId, botThinkingLevel, providerIds });
    if (routed) {
      const provider = creds.providers.find((row) => row.id === routed.providerId);
      if (provider) {
        return {
          target: {
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            providerId: provider.id,
            providerName: provider.name,
            model: routed.model,
            thinkingLevel: routed.thinkingLevel,
            locale: creds.locale,
          },
          decision: routed,
        };
      }
    }
    const resolved = resolveCompletionTarget(creds.providers, {
      botModel,
      botProviderId,
      defaultProviderId: creds.defaultProviderId,
    });
    if (!resolved) return null;
    const provider = creds.providers.find((row) => row.id === resolved.providerId);
    if (!provider) return null;
    const fallback = store.decideTurnRoute({
      botId,
      text,
      botModel: resolved.model,
      botProviderId: resolved.providerId,
      botThinkingLevel,
      providerIds,
    });
    const thinkingLevel = fallback?.thinkingLevel ?? "low";
    return {
      target: {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        providerId: provider.id,
        providerName: provider.name,
        model: resolved.model,
        thinkingLevel,
        locale: creds.locale,
      },
      decision: {
        model: resolved.model,
        thinkingLevel,
        providerId: resolved.providerId,
        signature: fallback?.signature ?? classifyMessage(text),
      },
    };
  }

  function startTurn(
    sessionId: string,
    botId: string,
    trigger: Message,
    mode: "redirect" | "fork",
    opts: {
      routineId?: string | null;
      routineDueAt?: string | null;
      /** The plan this turn continues outright, when the trigger cannot say (a check-back's note, a routine). */
      taskId?: string | null;
      ticketId?: string | null;
    } = {},
  ): Turn {
    options.admission?.assertNew();
    if (mode === "redirect") {
      const livesForBot = store.listLiveTurns({ sessionId, botId });
      let sessionKind: string | null = null;
      try {
        sessionKind = store.getSession(sessionId).kind;
      } catch {
        sessionKind = null;
      }
      const toRedirect = sessionKind === "group" ? livesForBot : livesForBot.slice(0, 1);
      for (const current of toRedirect) {
        const counted = executionOf(lives.get(current.id));
        abortLive(current.id);
        const redirected = store.redirectTurn(current.id, counted);
        publishTurn(redirected);
      }
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
    attachLive(turn);
    return turn;
  }

  function attachLive(turn: Turn): void {
    const live: Live = {
      abort: new AbortController(),
      loop: [],
      interrupt: store.pendingInterrupt(turn.bot_id),
      burned: false,
      partial: "",
      parentId: null,
      writtenPaths: [],
      planDir: store.turnPlanDir(turn.id),
      workDir: store.turnWorkDir(turn.id),
      mentionWarned: new Set(),
      toolNames: new Set(),
      spoke: false,
      drainRejection: false,
      closingChecked: false,
      routing: null,
      locale: "zh",
      hops: 0,
      toolCalls: 0,
      toolErrors: 0,
      repeatedFailures: 0,
      failedCalls: new Set(),
    };
    store.afterCommit(() => {
      lives.set(turn.id, live);
      const run = async (): Promise<void> => {
        try {
          publishTurn(turn);
          await runTurn(turn.id);
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
          }
        }
      };
      void trackTurn(turn.id, run()).catch((error) => console.error("turn cleanup failed", error));
    });
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

  function continueFromInterrupt(messageId: string): Turn {
    options.admission?.assertNew();
    const turn = store.claimInterruptContinue(messageId);
    attachLive(turn);
    return turn;
  }

  function abortLive(turnId: string): void {
    const live = lives.get(turnId);
    if (live) store.afterCommit(() => live.abort.abort());
  }

  async function drainLives(): Promise<void> {
    for (const timer of chainTimers.values()) clearTimeout(timer);
    chainTimers.clear();
    organizer.clearTimers();
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
    const agent = await agentRoute(turnId, botId, creds, triggerBody, live.abort.signal);
    if (!active(turnId, live)) return;
    const routed = agent?.routed ?? targetFor(botId, creds, triggerBody);
    if (!routed) {
      failTurn(turnId, "no_model");
      return;
    }
    const target = routed.target;
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
    if (sessionId) touchChain(sessionId, botId);
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
      const tools = pace === "last" ? [] : [...builtinTools(target.locale), ...listed.tools];
      live.toolNames = new Set(tools.map((tool) => tool.function.name));
      live.partial = "";
      publishTurn(current, "");
      let result;
      // A reply long enough to outlast the stale sweep is still a reply, so tokens count as
      // progress too — cheaply, since this runs per chunk.
      let touchedAt = Date.now();
      try {
        result = await completions.complete({
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          thinkingLevel: target.thinkingLevel,
          messages,
          tools,
          signal: live.abort.signal,
          onToken() {
            const at = Date.now();
            if (at - touchedAt < TOUCH_EVERY_MS) return;
            touchedAt = at;
            store.touchTurn(turnId);
          },
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

      if (result.hadChoices && live.interrupt && !live.burned) {
        live.burned = true;
        store.clearInterruptPending(current.bot_id);
      }

      if (!result.ok) {
        failTurn(turnId, result.failKind);
        return;
      }

      if (result.toolCalls.length > 0) {
        live.loop.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls,
        });
        const outcome = await executeTools(turnId, result.toolCalls);
        if (!active(turnId, live)) return;
        if (outcome === "wait") {
          if (live.abort.signal.aborted) drop();
          return;
        }
        if (outcome === "noop" || outcome === "spoke") {
          completeSilent(turnId);
          return;
        }
        continue;
      }

      live.loop.push({ role: "assistant", content: result.content });
      const closer = isNoWorkCloser(result.content);
      const rawBody = closer ? "" : result.content;
      // A delivery to the user goes out only after one look at what the job asked for. The note
      // comes back as a user line in the loop, and the next reply is final whatever it says.
      const closingBody = resolveBodyPathsToWorkDir(rawBody, live.workDir, (relpath) => pathExists(store, relpath));
      const bounce = await closingCheck(turnId, live, current, {
        body: closingBody,
        paths: mergeCitedPaths(live.writtenPaths, [
          ...attachmentLinePaths(closingBody),
          ...extractWorkspacePathsFromBody(closingBody),
        ]),
        sessionId: current.session_id,
      });
      if (!active(turnId, live)) {
        if (live.abort.signal.aborted) drop();
        return;
      }
      if (bounce) {
        live.loop.push({ role: "user", content: bounce });
        continue;
      }
      const message = publishCitedBotMessage(current, live, turnId, rawBody);
      const completed = store.setTurnStatus(turnId, "completed", executionOf(live));
      lives.delete(turnId);
      publishTurn(completed, null);
      if (message) {
        const session = store.getSession(current.session_id);
        if (session.kind === "group" && !live.parentId) {
          void track(handleParticipation(message, { fromUser: false }));
        }
      }
      return;
    }
  }

  /**
   * Runs the closing check once per turn, when a delivery — a message that cites workspace files —
   * is about to reach a session the user is in. Returns the note to hand back when something in the
   * job's opening request is neither delivered nor accounted for, else null. Fails open: no job,
   * no brief, no default model, draining, a refused call or an unreadable verdict all mean "let it
   * through". The call is billed to the turn, on the default model it ran on.
   */
  async function closingCheck(
    turnId: string,
    live: Live,
    turn: Turn,
    input: { body: string; paths: string[]; sessionId: string },
  ): Promise<string | null> {
    if (live.closingChecked || input.paths.length === 0) return null;
    if (!live.routing || options.admission?.draining) return null;
    let userPresent = false;
    try {
      userPresent = store.isPresent(input.sessionId, USER_MEMBER);
    } catch {
      userPresent = false;
    }
    if (!userPresent) return null;
    const taskId = store.taskOfTurn(turnId);
    if (!taskId) return null;
    live.closingChecked = true;
    const payload = closingCheckPayload(store, {
      taskId,
      ticketId: store.ticketOfTurn(turnId),
      turnId,
      botId: turn.bot_id,
      sessionId: turn.session_id,
      reply: input.body,
      paths: input.paths,
      locale: live.locale,
    });
    if (!payload) return null;
    let result;
    try {
      result = await completions.judge({
        baseUrl: live.routing.baseUrl,
        apiKey: live.routing.apiKey,
        model: live.routing.model,
        messages: [
          { role: "system", content: CLOSING_CHECK_SYSTEM },
          { role: "user", content: JSON.stringify(payload) },
        ],
        signal: live.abort.signal,
        timeoutMs: CLOSING_CHECK_TIMEOUT_MS,
      });
    } catch {
      return null;
    }
    recordResponseSpend({
      kind: "turn",
      owner: spendOwner(turn.session_id, turn.bot_id),
      turnId,
      target: callOf(live.routing),
      usage: result.usage,
      responded: result.failKind === null || result.failKind === "incomplete",
    });
    if (!active(turnId, live)) return null;
    if (result.failKind && result.failKind !== "incomplete") return null;
    const items = parseClosingCheck(result.content ?? "");
    if (!items || items.length === 0) return null;
    return closingCheckNote(live.locale, items);
  }

  /** The closing check for a `send_message`: the body and paths as the tool would resolve them. */
  async function closingCheckForSend(
    turnId: string,
    live: Live,
    turn: Turn,
    args: Record<string, unknown>,
  ): Promise<string | null> {
    const body = typeof args.body === "string" ? args.body : "";
    if (!body.trim() || isNoWorkCloser(body)) return null;
    const sessionId = typeof args.session_id === "string" && args.session_id ? args.session_id : turn.session_id;
    const corrected = resolveBodyPathsToWorkDir(body, live.workDir, (relpath) => pathExists(store, relpath));
    const explicit = Array.isArray(args.paths)
      ? args.paths.filter((item): item is string => typeof item === "string")
      : [];
    const paths = mergeCitedPaths(
      [...live.writtenPaths, ...explicit],
      [...extractWorkspacePathsFromBody(corrected), ...attachmentLinePaths(corrected)],
    );
    return closingCheck(turnId, live, turn, { body: corrected, paths, sessionId });
  }

  function completeSilent(turnId: string): void {
    const live = lives.get(turnId);
    try {
      if (store.getTurn(turnId).status !== "running") {
        lives.delete(turnId);
        return;
      }
    } catch {
      lives.delete(turnId);
      return;
    }
    const current = store.getTurn(turnId);
    if (live && !live.spoke && live.writtenPaths.length > 0) {
      publishCitedBotMessage(current, live, turnId, "");
    }
    const completed = store.setTurnStatus(turnId, "completed", executionOf(live));
    lives.delete(turnId);
    publishTurn(completed, null);
  }

  function publishCitedBotMessage(turn: Turn, live: Live, turnId: string, rawBody: string): Message | null {
    // Same correction `send_message` makes: a file named from the shell's cwd is linked where it is.
    const body = resolveBodyPathsToWorkDir(rawBody, live.workDir, (relpath) => pathExists(store, relpath));
    const linked = linkifyWorkspacePaths(body, live.writtenPaths);
    if (!linked.trim() && live.writtenPaths.length === 0) return null;
    const message = store.insertMessage({
      sessionId: turn.session_id,
      turnId,
      parentId: live.parentId,
      kind: "bot",
      author: turn.bot_id,
      body: linked,
      paths: mergeCitedPaths(live.writtenPaths, attachmentLinePaths(body)),
    });
    publishMessage(message);
    live.spoke = true;
    return message;
  }

  function noteWrittenPaths(live: Live, toolName: string, result: ToolResult): void {
    if (!result.ok) return;
    // `shell` now reports the files it left in the work dir; everything else among the workspace
    // tools only reads, and read paths are not artifacts.
    if (isWorkspaceTool(toolName) && toolName !== "write_file" && toolName !== "shell") return;
    // Reading or resolving an annotation names a file; it does not write one.
    if (toolName === "list_annotations" || toolName === "resolve_annotation") return;
    const root = store.workspacePath();
    if (!root) return;
    for (const raw of writtenPathFromToolData(result.data)) {
      const classified = classifyPath(root, raw);
      if (classified.zone !== "inside") continue;
      // The reserved subdirs are where the daemon spills and where the turn instructions tell the
      // Bot to put throwaway files, and the mirror files are the app's own. None of them is
      // something to hand the user as an artifact, at the plan's level or a ticket's.
      if (live.planDir && isReservedTaskPath(live.planDir, classified.rel)) continue;
      if (live.workDir && isReservedTaskPath(live.workDir, classified.rel)) continue;
      live.writtenPaths = mergeCitedPaths(live.writtenPaths, [classified.rel]);
    }
  }

  async function executeTools(turnId: string, calls: ToolCall[]): Promise<"wait" | "noop" | "more" | "spoke"> {
    const live = lives.get(turnId);
    if (!live) return "wait";
    const turn = store.getTurn(turnId);
    const workDir = live.workDir;
    let posted = false;
    let spoke = false;
    for (const call of calls) {
      if (!active(turnId, live)) return "wait";
      live.toolCalls += 1;
      const fingerprint = `${call.name}\n${call.arguments}`;
      if (live.failedCalls.has(fingerprint)) live.repeatedFailures += 1;
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
      // A tool is the one place a hop can legitimately sit still for minutes, so mark both ends of
      // it: the stale sweep reads `last_activity_at` and must not cut a long shell or MCP call off.
      store.touchTurn(turnId);
      // Bracket the execution so a watcher can tell "still running" from "finished": the
      // announce event only says the model asked for it.
      const streamId = `${turnId}:${call.id}`;
      const startedAt = Date.now();
      // A delivery about to be posted gets the closing check first; a bounce comes back to the
      // Bot as this call's result, and the tool itself does not run.
      const bounce = call.name === "send_message" ? await closingCheckForSend(turnId, live, turn, args) : null;
      if (!active(turnId, live)) return "wait";
      let result: ToolResult;
      if (bounce) {
        result = { ok: false, error: { code: "closing_check", message: bounce }, emitted: [] };
      } else {
        publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id: call.id,
          name: call.name, arguments: call.arguments, phase: "started" });
        result = await dispatchTool(turn, live, call.name, args, streamId);
        publish({ event: "turn.tool", occurred_at: occurred(), turn_id: turnId, id: call.id,
          name: call.name, phase: "exited", duration_ms: Date.now() - startedAt,
          exit_code: typeof result.data?.exit_code === "number" ? result.data.exit_code : null });
      }
      if (!active(turnId, live)) return "wait";
      store.touchTurn(turnId);
      if (result.error?.code === "draining") {
        if (live.drainRejection) {
          const note = store.insertMessage({ sessionId: turn.session_id, turnId, kind: "system", author: turn.bot_id,
            body: "draining: repeated child or handoff admission refused" });
          publishMessage(note);
          return "noop";
        }
        live.drainRejection = true;
      }
      await publishEmitted(turnId, live, result.emitted);
      if (!active(turnId, live)) return "wait";
      result = withLatestMcp(call.name, result);
      noteWrittenPaths(live, call.name, result);
      if (result.waitAsk) {
        const waitAsk = result.waitAsk;
        const { ask, waiting } = store.transaction(() => {
          const ask = store.insertMessage({
            sessionId: turn.session_id,
            turnId,
            parentId: live.parentId,
            kind: "ask",
            author: turn.bot_id,
            body: waitAsk.question,
            ask: waitAsk.spec,
          });
          store.db.run(
            "UPDATE turns SET status = 'waiting_ask', pending_ask_id = ?, updated_at = ? WHERE id = ?",
            [ask.id, isoNow(), turnId],
          );
          const waiting = store.getTurn(turnId);
          store.createNotification({
            semantic_key: `ask:${ask.id}`,
            kind: "ask",
            session_id: turn.session_id,
            message_id: ask.id,
            turn_id: turnId,
            created_at: ask.created_at,
            action_state: "open",
          });
          return { ask, waiting };
        });
        publishMessage(ask);
        publishTurn(waiting, null);
        const answer = await waitForAsk(turnId, ask.id, call.id);
        if (answer == null || !active(turnId, live)) return "wait";
        live.loop.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializeToolResult(
            {
              ok: true,
              data: {
                ask_id: ask.id,
                message_id: ask.id,
                answer: askAnswerText(answer),
                selected: answer.selected,
                custom: answer.custom,
              },
            },
            store.workspacePath(),
            workDir,
          ),
        });
        posted = true;
        continue;
      }
      if (result.waitApproval) {
        const waitApproval = result.waitApproval;
        const { card, approval, waiting } = store.transaction(() => {
          const card = store.insertMessage({
            sessionId: turn.session_id,
            turnId,
            parentId: live.parentId,
            kind: "approval",
            author: turn.bot_id,
            body: waitApproval.summary,
          });
          const approval = store.insertApproval({
            turnId,
            messageId: card.id,
            kind_key: waitApproval.kind_key,
            summary: waitApproval.summary,
            target: waitApproval.target,
            requires_api_key: Boolean(waitApproval.requiresApiKey),
          });
          const waiting = store.setTurnStatus(turnId, "waiting_approval");
          return { card, approval, waiting };
        });
        const pending = waitForApproval(
          turnId,
          approval.id,
          call.id,
          waitApproval.run,
          waitApproval.requiresApiKey,
        );
        publishMessage(card);
        publish({ event: "approval.upsert", occurred_at: occurred(), ...approval });
        publishTurn(waiting, null);
        let resolved = await pending;
        if (resolved == null || !active(turnId, live)) return "wait";
        await publishEmitted(turnId, live, resolved.emitted);
        if (!active(turnId, live)) return "wait";
        resolved = withLatestMcp(call.name, resolved);
        noteWrittenPaths(live, call.name, resolved);
        const payload = resolved.ok
          ? { ok: true, data: resolved.data }
          : { ok: false, error: resolved.error };
        if (!resolved.ok) {
          live.toolErrors += 1;
          live.failedCalls.add(fingerprint);
        }
        live.loop.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializeToolResult(payload, store.workspacePath(), workDir),
        });
        posted = true;
        continue;
      }
      const skipped =
        result.ok && result.data?.skipped === true && result.data?.reason === "no_new_work";
      if (call.name === "send_message" && result.ok && !skipped) {
        spoke = true;
        live.spoke = true;
      }
      if (!skipped) posted = true;
      const payload = result.ok
        ? { ok: true, data: result.data }
        : { ok: false, error: result.error };
      // A closing-check bounce is a nudge, not a tool that failed: the review must not read it as one.
      if (!result.ok && result.error?.code !== "closing_check") {
        live.toolErrors += 1;
        live.failedCalls.add(fingerprint);
      }
      live.loop.push({
        role: "tool",
        tool_call_id: call.id,
        content: serializeToolResult(payload, store.workspacePath(), workDir),
      });
    }
    if (spoke) return "spoke";
    return posted ? "more" : "noop";
  }

  function withLatestMcp(name: string, result: ToolResult): ToolResult {
    if (
      !result.ok ||
      !result.data ||
      typeof result.data.id !== "string" ||
      (name !== "add_mcp_server" && name !== "update_mcp_server")
    ) {
      return result;
    }
    const latest = store.listMcpServers().find((row) => row.id === result.data!.id);
    return latest ? { ...result, data: { ...latest } } : result;
  }

  async function dispatchTool(
    turn: Turn,
    live: Live,
    name: string,
    args: Record<string, unknown>,
    streamId?: string,
  ): Promise<ToolResult> {
    if (isWorkspaceTool(name) || COLLAB_TOOL_NAMES.includes(name)) {
      return isWorkspaceTool(name)
        ? await runWorkspaceTool(
            { store, signal: live.abort.signal, workDir: live.workDir, stream: options.streams, streamId, wake },
            name,
            args,
          )
        : await runCollabTool(
            {
              store,
              botId: turn.bot_id,
              sessionId: turn.session_id,
              turnId: turn.id,
              parentId: live.parentId,
              writtenPaths: live.writtenPaths,
              workDir: live.workDir,
              planDir: live.planDir,
              mentionWarned: live.mentionWarned,
              availableToolNames: live.toolNames,
              admission: options.admission,
              signal: live.abort.signal,
            },
            name,
            args,
          );
    }
    if (!mcp) {
      return { ok: false, error: { code: "failed", message: `unknown tool: ${name}` }, emitted: [] };
    }
    const called = await mcp.call(name, args, live.abort.signal);
    if (called.ok) return { ok: true, data: called.data, emitted: [] };
    return { ok: false, error: called.error, emitted: [] };
  }

  async function inspectForTurn(turnId: string, live: Live, server: McpServer) {
    if (!mcp || !server.enabled || !active(turnId, live)) return null;
    const inspected = await mcp.inspect(server);
    if (!active(turnId, live)) return null;
    return store.applyMcpInspection(server.id, server.updated_at, inspected);
  }

  async function publishEmitted(turnId: string, live: Live, emitted: ToolResult["emitted"]): Promise<void> {
    for (const item of emitted) {
      if (!active(turnId, live)) return;
      if (item.kind === "bot") {
        publish({ event: "bot.upsert", occurred_at: occurred(), ...item.bot, deleted_at: item.deleted_at });
      } else if (item.kind === "session") {
        const s = item.session;
        publish({
          event: "session.upsert",
          occurred_at: occurred(),
          ...sessionUpsertFields(s),
        });
      } else if (item.kind === "message") {
        publishMessage(item.message);
      } else if (item.kind === "participation") {
        void track(handleParticipation(item.message, { fromUser: false }));
      } else if (item.kind === "routine") {
        publish({ event: "routine.upsert", occurred_at: occurred(), ...item.routine });
        if (!options.admission?.draining) fireRoutine(item.routine.id);
      } else if (item.kind === "routine_removed") {
        publish({ event: "routine.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "skill") {
        publish({ event: "skill.upsert", occurred_at: occurred(), ...item.skill });
      } else if (item.kind === "skill_removed") {
        publish({ event: "skill.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "memory") {
        publish({ event: "memory.upsert", occurred_at: occurred(), ...item.memory });
      } else if (item.kind === "memory_removed") {
        publish({ event: "memory.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "provider") {
        publish({ event: "provider.upsert", occurred_at: occurred(), ...item.provider });
      } else if (item.kind === "provider_removed") {
        publish({ event: "provider.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "mcp") {
        let server = item.server;
        if (mcp) {
          try {
            const inspected = await inspectForTurn(turnId, live, server);
            if (!active(turnId, live)) return;
            const current = inspected ?? store.listMcpServers().find((row) => row.id === server.id);
            if (!current) continue;
            server = current;
          } catch {
            // catalog parse is best-effort; the row is already saved
          }
        }
        publish({ event: "mcp.upsert", occurred_at: occurred(), ...server });
      } else if (item.kind === "mcp_removed") {
        publish({ event: "mcp.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "settings") {
        const settings = await store.settings();
        if (!active(turnId, live)) return;
        publish({ event: "settings.changed", occurred_at: occurred(), ...settings });
      }
    }
  }

  function waitForApproval(
    turnId: string,
    approvalId: string,
    toolCallId: string,
    run: (opts?: { api_key?: string }) => Promise<ToolResult> | ToolResult,
    requiresApiKey?: boolean,
  ): Promise<ToolResult | null> {
    const live = lives.get(turnId);
    if (!live) return Promise.resolve(null);
    return new Promise((resolve) => {
      live.approval = {
        id: approvalId,
        toolCallId,
        run,
        requiresApiKey,
        waiter: (result) => resolve(result),
      };
      const abort = () => resolve(null);
      live.abort.signal.addEventListener("abort", abort, { once: true });
    });
  }

  function waitForAsk(turnId: string, askId: string, toolCallId: string): Promise<AskAnswer | null> {
    const live = lives.get(turnId);
    if (!live) return Promise.resolve(null);
    return new Promise((resolve) => {
      live.ask = {
        id: askId,
        toolCallId,
        waiter: (answer) => {
          resolve(answer);
        },
      };
      const abort = () => resolve(null);
      live.abort.signal.addEventListener("abort", abort, { once: true });
    });
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
    };
  }

  /** A Bot's `@token` matched nobody present: say so in the transcript so the miss is visible. */
  async function noteUnknownMentions(message: Message, tokens: string[], members: string[]): Promise<void> {
    const locale = (await store.settings()).locale;
    if (options.admission?.draining) return;
    const note = store.insertMessage({
      sessionId: message.session_id,
      turnId: message.turn_id,
      parentId: null,
      kind: "system",
      author: message.author,
      body: unknownMentionBody(locale, tokens, members),
    });
    publishMessage(note);
  }

  function interruptTurn(current: Turn): void {
    const result = store.interruptTurnRecord(current.id, executionOf(lives.get(current.id)));
    if (result) {
      publishMessage(result.note);
      publishTurn(result.turn);
    }
  }

  function failTurn(turnId: string, kind: FailKind): void {
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
        body: completionFailBody(locale, kind),
      });
      store.voidPendingTurnActions(turnId, "turn_failed", now);
      store.finishTurnRoute(turnId, "failed", kind, executionOf(live));
      if (store.isPresent(current.session_id, USER_MEMBER)) {
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
   * Nothing in a hop may legitimately go this long without touching the turn: a completion is
   * bounded by the client's first-byte and idle timers, a shell by its own timeout, an MCP call by
   * its idle cap, and both ends of every tool call touch the row. Past this the turn is wedged.
   */
  const STALE_TURN_MS = 20 * 60_000;
  /** How often a still-streaming hop bothers the row; small next to {@link STALE_TURN_MS}. */
  const TOUCH_EVERY_MS = 30_000;

  /**
   * Closes turns that stopped making progress. Without it a wedged turn sat at `running` until the
   * next boot: Thinking forever in the sidebar, and silence for whoever was waiting on the handoff.
   */
  function sweepStalledTurns(at: Date = new Date()): void {
    for (const turn of store.listLiveTurns()) {
      // waiting_approval and waiting_ask are waiting on you, so they never go stale.
      if (turn.status !== "running") continue;
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

  function callOf(target: CallTarget): CallTarget {
    return {
      providerId: target.providerId,
      providerName: target.providerName,
      model: target.model,
      thinkingLevel: target.thinkingLevel,
    };
  }

  /**
   * The title the messenger shows: a group's name, the other side of a you↔Bot direct, or
   * `A ↔ B` for a Bot↔Bot direct. Frozen with the Bot's name before the call leaves.
   */
  function spendOwner(sessionId: string, botId: string | null): SpendOwner {
    let sessionName: string | null = null;
    try {
      const session = store.getSession(sessionId);
      if (session.kind === "group") {
        sessionName = session.name;
      } else {
        const names = store
          .presentBotIds(sessionId)
          .map((id) => {
            try {
              return store.getBot(id).name;
            } catch {
              return null;
            }
          })
          .filter((name): name is string => Boolean(name));
        sessionName = names.length <= 1 ? (names[0] ?? null) : names.join(" ↔ ");
      }
    } catch {
      sessionName = null;
    }
    let botName: string | null = null;
    if (botId) {
      try {
        botName = store.getBot(botId).name;
      } catch {
        botName = null;
      }
    }
    return { sessionId, sessionName, botId, botName };
  }

  function usageHasDigits(usage: MappedUsage | null): boolean {
    return Boolean(
      usage &&
        (usage.input_tokens != null ||
          usage.output_tokens != null ||
          usage.total_tokens != null ||
          usage.cached_tokens != null ||
          usage.reasoning_tokens != null ||
          usage.cost_usd_ticks != null),
    );
  }

  /**
   * A short call that returned a body. Success and `incomplete` with no usage are `endpoint_omitted`;
   * an endpoint error is recorded only when it brought usage. A throw never reaches here.
   */
  function recordResponseSpend(input: {
    kind: SpendKind;
    owner: SpendOwner;
    turnId?: string | null;
    judgementId?: string | null;
    chainId?: string | null;
    target: CallTarget;
    usage: MappedUsage | null;
    responded: boolean;
  }): void {
    const hasDigits = usageHasDigits(input.usage);
    if (!hasDigits && !input.responded) return;
    writeSpend({
      kind: input.kind,
      owner: input.owner,
      turnId: input.turnId ?? null,
      judgementId: input.judgementId ?? null,
      chainId: input.chainId ?? null,
      target: input.target,
      usage: hasDigits ? input.usage : null,
      missing: hasDigits ? null : "endpoint_omitted",
    });
  }

  function recordSpend(
    kind: "turn",
    turnId: string,
    usage: MappedUsage | null,
    missing: Spend["missing_reason"],
    target: CallTarget,
    owner: SpendOwner,
  ): void {
    const hasDigits = usageHasDigits(usage);
    if (!hasDigits && !missing) return;
    writeSpend({
      kind,
      owner,
      turnId,
      judgementId: null,
      chainId: null,
      target,
      usage: hasDigits ? usage : null,
      missing: hasDigits ? null : missing,
    });
  }

  function writeSpend(input: {
    kind: SpendKind;
    owner: SpendOwner;
    turnId: string | null;
    judgementId: string | null;
    chainId: string | null;
    target: CallTarget;
    usage: MappedUsage | null;
    missing: Spend["missing_reason"];
  }): void {
    const row = store.insertSpend({
      kind: input.kind,
      sessionId: input.owner.sessionId,
      sessionName: input.owner.sessionName,
      botId: input.owner.botId,
      botName: input.owner.botName,
      turnId: input.turnId,
      judgementId: input.judgementId,
      chainId: input.chainId,
      providerId: input.target.providerId,
      providerName: input.target.providerName,
      model: input.target.model,
      thinkingLevel: input.target.thinkingLevel,
      inputTokens: input.usage?.input_tokens ?? null,
      outputTokens: input.usage?.output_tokens ?? null,
      totalTokens: input.usage?.total_tokens ?? null,
      cachedTokens: input.usage?.cached_tokens ?? null,
      reasoningTokens: input.usage?.reasoning_tokens ?? null,
      costUsdTicks: input.usage?.cost_usd_ticks ?? null,
      missingReason: input.missing,
    });
    publishSpend(row);
  }

  /** Who a message names, read against the whole roster; present members' names may be shortened. */
  function mentionsIn(sessionId: string, body: string) {
    const roster = store.listBots();
    const nameById = new Map(roster.map((b) => [b.id, b.name] as const));
    const presentNames = store
      .presentBotIds(sessionId)
      .map((id) => nameById.get(id))
      .filter((name): name is string => typeof name === "string");
    const parsed = parseMentions(body, roster.map((b) => b.name), { lenient: presentNames });
    return { parsed, nameById, presentNames };
  }

  /**
   * The Bots a message is about to wake, before anything has opened: the other one in a direct;
   * in a group everyone it names (a named Bot outside the group is about to be added), or, naming
   * no one, everyone present — the focused Bot hears it and the rest judge. `handleParticipation`
   * decides for real once the message has been filed.
   */
  function botsToWake(message: Message): string[] {
    if (options.admission?.draining) return [];
    if (message.kind !== "user" && message.kind !== "bot") return [];
    try {
      const session = store.getSession(message.session_id);
      const present = store.presentBotIds(session.id);
      if (session.kind === "direct") return present.filter((id) => id !== message.author).slice(0, 1);
      const { parsed } = mentionsIn(session.id, message.body);
      const named = parsed.mentions
        .map((name) => store.findBotByName(name)?.id)
        .filter((id): id is string => typeof id === "string");
      const woken = parsed.everyone || named.length === 0 ? [...present, ...named] : named;
      return [...new Set(woken)].filter((id) => id !== message.author);
    } catch {
      return [];
    }
  }

  async function handleParticipation(
    message: Message,
    opts: {
      fromUser: boolean;
      fork?: boolean;
      /** Every turn and judgement this message opens has started; the judgements are still out. */
      opened?: () => void;
    },
  ): Promise<void> {
    if (options.admission?.draining) return;
    const session = store.getSession(message.session_id);
    if (message.kind !== "user" && message.kind !== "bot") return;

    if (session.kind === "direct") {
      const bots = store.presentBotIds(session.id);
      const target = bots.find((id) => id !== message.author);
      if (!target) return;
      // Your new message forks by default. With no user in the room, a Bot's second message
      // retunes the live turn instead of cloning it — the way a group already treats Bots.
      const fork = opts.fork !== undefined ? opts.fork : store.isPresent(session.id, USER_MEMBER);
      startTurn(session.id, target, message, fork ? "fork" : "redirect");
      return;
    }

    const { parsed, nameById, presentNames } = mentionsIn(session.id, message.body);
    if (!opts.fromUser && parsed.unresolved.length > 0) {
      const authorName = nameById.get(message.author);
      await noteUnknownMentions(message, parsed.unresolved, presentNames.filter((name) => name !== authorName));
    }
    if (options.admission?.draining) return;
    if (session.kind === "group") {
      for (const name of parsed.mentions) {
        const bot = store.findBotByName(name);
        if (!bot) continue;
        if (!store.isPresent(session.id, bot.id)) {
          const next = store.addMember(session.id, bot.id);
          publish({
            event: "session.upsert",
            occurred_at: occurred(),
            ...sessionUpsertFields(next),
          });
        }
      }
    }

    const present = store.presentBotIds(session.id);
    const mentionedIds = parsed.mentions
      .map((name) => store.findBotByName(name)?.id)
      .filter((id): id is string => typeof id === "string" && present.includes(id));
    const mandatory = new Set<string>();
    if (parsed.everyone) {
      for (const id of present) {
        if (id !== message.author) mandatory.add(id);
      }
    }
    for (const id of mentionedIds) {
      if (id !== message.author) mandatory.add(id);
    }

    const hasMention = parsed.everyone || mentionedIds.length > 0;
    const opened = new Set<string>();
    if (opts.fromUser && !hasMention) {
      const focused = store.listLiveTurns({ sessionId: session.id })[0];
      if (focused) {
        const fork = opts.fork !== undefined ? opts.fork : true;
        startTurn(session.id, focused.bot_id, message, fork ? "fork" : "redirect");
        opened.add(focused.bot_id);
      }
    }

    for (const botId of mandatory) {
      startTurn(session.id, botId, message, opts.fork === true ? "fork" : "redirect");
      opened.add(botId);
    }

    // User text with no @ is a group-wide ask: unmentioned bots judge. A user or
    // Bot @ / @everyone (including an auto-@ on a quote-reply) only opens the
    // named set. Bot text with no @ stays silent. Quote-replies still participate.
    if (!(opts.fromUser && !hasMention)) return;

    const judges = present.filter(
      (id) => id !== message.author && !opened.has(id) && !mandatory.has(id),
    );
    const pendingByBot = new Map<string, PendingJudgement>();
    for (const botId of judges) {
      pendingByBot.set(botId, startPendingJudgement(message.session_id, message.id, botId, "judging"));
    }
    opts.opened?.();
    await Promise.all(
      judges.map((botId) =>
        judge(botId, message, parsed.mentions, parsed.everyone, pendingByBot.get(botId)!),
      ),
    );
  }

  function startPendingJudgement(
    sessionId: string,
    messageId: string,
    botId: string,
    stage: NonNullable<PendingJudgement["stage"]>,
  ): PendingJudgement {
    const pending: PendingJudgement = {
      id: ulid(),
      session_id: sessionId,
      message_id: messageId,
      bot_id: botId,
      stage,
      created_at: isoNow(),
    };
    pendingJudges.set(pending.id, pending);
    publish({ event: "judgement.started", occurred_at: pending.created_at, ...pending });
    return pending;
  }

  function dropPendingJudgement(pending: PendingJudgement, ended: boolean): void {
    if (!pendingJudges.delete(pending.id)) return;
    if (ended) {
      publish({
        event: "judgement.ended",
        occurred_at: occurred(),
        id: pending.id,
        session_id: pending.session_id,
        message_id: pending.message_id,
        bot_id: pending.bot_id,
      });
    }
  }

  async function suggestComposer(
    sessionId: string,
    signal: AbortSignal = new AbortController().signal,
    guard?: () => void,
  ): Promise<ComposerSuggestion[]> {
    store.getSession(sessionId);
    // These draft what the user would send; in a Bot↔Bot direct they have nothing to draft.
    if (!store.isPresent(sessionId, USER_MEMBER)) return [];
    if (signal.aborted) return [];
    let creds: Creds | null;
    try {
      creds = await credentials();
    } catch {
      return [];
    }
    if (!creds || signal.aborted) return [];
    guard?.();
    const resolved = resolveCompletionTarget(creds.providers, {
      botModel: null,
      botProviderId: null,
      defaultProviderId: creds.defaultProviderId,
    });
    if (!resolved) return [];
    const provider = creds.providers.find((row) => row.id === resolved.providerId);
    if (!provider) return [];
    const lightModel =
      provider.models.find((name) => /flash|mini|lite|fast/i.test(name)) ?? resolved.model;
    const target: CallTarget = {
      providerId: provider.id,
      providerName: provider.name,
      model: lightModel,
      thinkingLevel: null,
    };
    const owned = spendOwner(sessionId, null);
    let user: string;
    try {
      user = assembleComposerSuggestUser(store, sessionId);
    } catch {
      return [];
    }
    let result;
    try {
      result = await completions.judge({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: lightModel,
        messages: [
          { role: "system", content: COMPOSER_SUGGEST_SYSTEM },
          { role: "user", content: user },
        ],
        signal,
        // Someone pressed ✨ and is watching it spin. 8s suited the silent fetch this used to
        // be; a thinking "flash" model takes 3-8s, so a press often came back empty.
        timeoutMs: 20_000,
      });
    } catch {
      return [];
    }
    // Typing again aborts the request, but a body that already came back was paid for.
    recordResponseSpend({
      kind: "composer_suggest",
      owner: owned,
      target,
      usage: result.usage,
      responded: result.failKind === null || result.failKind === "incomplete",
    });
    if (signal.aborted) return [];
    if (result.failKind || result.hadToolCalls || !result.content) return [];
    const roster = store
      .presentBotIds(sessionId)
      .map((id) => {
        try {
          return store.getBot(id).name;
        } catch {
          return null;
        }
      })
      .filter((name): name is string => Boolean(name));
    return parseComposerSuggestions(result.content, roster);
  }

  async function judge(
    botId: string,
    message: Message,
    mentions: string[],
    everyone: boolean,
    pending: PendingJudgement,
  ): Promise<void> {
    let settled = false;
    const finish = (row?: { id: string }): void => {
      dropPendingJudgement(pending, !row);
      settled = true;
    };
    try {
      let creds: Creds | null;
      try {
        creds = await credentials();
      } catch {
        return;
      }
      if (options.admission?.draining) return;
      const target = creds ? (targetFor(botId, creds, message.body)?.target ?? null) : null;
      if (!creds || !target) {
        try {
          const row = store.insertJudgement({
            sessionId: message.session_id,
            messageId: message.id,
            botId,
            decision: "pass",
            error: "endpoint_error",
          });
          finish(row);
          publish({ event: "judgement.created", occurred_at: occurred(), ...row });
        } catch {
          return;
        }
        return;
      }
      let user: string;
      try {
        user = assembleJudgementUser(store, {
          sessionId: message.session_id,
          botId,
          message,
          mentions,
          everyone,
        });
      } catch {
        return;
      }
      const billed = { ...callOf(target), thinkingLevel: null };
      const owned = spendOwner(message.session_id, botId);
      const result = await completions.judge({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        messages: [
          { role: "system", content: JUDGEMENT_SYSTEM },
          { role: "user", content: user },
        ],
        signal: new AbortController().signal,
      });
      if (options.admission?.draining) {
        recordResponseSpend({
          kind: "judgement",
          owner: owned,
          judgementId: pending.id,
          target: billed,
          usage: result.usage,
          responded: result.failKind === null || result.failKind === "incomplete",
        });
        return;
      }
      let decision: "join" | "pass" = "pass";
      let reason: string | null = null;
      let error: "timeout" | "invalid_output" | "endpoint_error" | null = null;
      if (result.failKind === "first_byte") error = "timeout";
      else if (result.failKind === "incomplete") {
        const extracted = extractJudgement(result.content, result.hadToolCalls);
        decision = extracted.decision;
        reason = extracted.reason;
        error = extracted.error ?? "invalid_output";
      } else if (result.failKind) error = "endpoint_error";
      else {
        const extracted = extractJudgement(result.content, result.hadToolCalls);
        decision = extracted.decision;
        reason = extracted.reason;
        error = extracted.error;
      }
      let row;
      try {
        row = store.insertJudgement({
          sessionId: message.session_id,
          messageId: message.id,
          botId,
          decision,
          reason,
          error,
        });
      } catch {
        recordResponseSpend({
          kind: "judgement",
          owner: owned,
          judgementId: pending.id,
          target: billed,
          usage: result.usage,
          responded: result.failKind === null || result.failKind === "incomplete",
        });
        return;
      }
      recordResponseSpend({
        kind: "judgement",
        owner: owned,
        judgementId: row.id,
        target: billed,
        usage: result.usage,
        responded: result.failKind === null || result.failKind === "incomplete",
      });
      if (decision === "join") startTurn(message.session_id, botId, message, "redirect");
      finish(row);
      publish({ event: "judgement.created", occurred_at: occurred(), ...row });
    } finally {
      if (!settled) finish();
    }
  }

  /**
   * Wakes a Bot at an appointment it made with itself. The note it left becomes a system line in
   * the same session, seen only by the turn it wakes and the flow board, and opens a turn in the
   * job the appointment was made in: in a group the Bot's live turn there is retuned like a mention
   * would, in a direct a new turn forks like a message from the user. Nothing fires while draining;
   * a Bot since archived or gone from the session just has its appointment consumed, since there is
   * nobody to wake.
   */
  function fireCheckBack(id: string, now: Date = new Date()): Turn | null {
    if (options.admission?.draining) return null;
    const result = store.transaction(() => {
      const claimed = store.claimCheckBack(id, now);
      if (!claimed) return null;
      let session;
      try {
        session = store.getSession(claimed.session_id);
      } catch {
        return null;
      }
      let archived: string | null;
      try {
        archived = store.getBot(claimed.bot_id).archived_at;
      } catch {
        return null;
      }
      if (archived || !store.isPresent(session.id, claimed.bot_id)) return null;
      let bookedBy: string | null = null;
      if (claimed.turn_id) {
        try {
          bookedBy = store.getTurn(claimed.turn_id).id;
        } catch {
          bookedBy = null;
        }
      }
      // Hung on the turn that booked it, so the trace draws the Bot waking itself, and the woken
      // turn inherits the job the way a handoff does even before `taskId` says so.
      const trigger = store.insertMessage({
        sessionId: session.id,
        turnId: bookedBy,
        kind: "system",
        author: claimed.bot_id,
        body: checkBackNoteBody(store.settingsCached().locale, claimed.note),
      });
      // The Bot's reminder to itself: the turn reads it, the conversation never shows it.
      store.recordCheckBackLine(claimed.id, trigger.id);
      return { claimed, session, trigger };
    });
    if (!result) return null;
    const fork = result.session.kind === "group" ? false : store.isPresent(result.session.id, USER_MEMBER);
    const turn = startTurn(result.session.id, result.claimed.bot_id, result.trigger, fork ? "fork" : "redirect", {
      taskId: result.claimed.task_id,
    });
    store.markCheckBackFired(id, turn.id);
    return turn;
  }

  function fireRoutine(routineId: string, now: Date = new Date()): Turn | null {
    options.admission?.assertNew();
    const result = store.transaction(() => {
      const claimed = store.claimRoutineDue(routineId, now);
      if (!claimed) return null;
      const existing = store.findDirectSession(USER_MEMBER, claimed.bot_id);
      const session = existing ?? store.createDirect(USER_MEMBER, claimed.bot_id);
      // A system line under the Bot, the way a check-back wakes it: you did not send this, and a
      // line in your name would also read to the organizer as something you just asked for.
      const trigger = store.insertMessage({
        sessionId: session.id,
        kind: "system",
        author: claimed.bot_id,
        body: routineFireBody(store.settingsCached().locale, claimed.title, claimed.instruction),
      });
      // Every routine has one standing plan, and every fire is a ticket of it, so a daily's days
      // sit side by side and its rules and precedents accumulate. No model call decides this.
      const plan =
        store.routineTask(claimed.id) ??
        store.openTask({
          sessionId: session.id,
          title: claimed.title,
          brief: claimed.instruction,
          kind: claimed.title,
          spec: {
            kind: claimed.title,
            goal: claimed.title,
            acceptance: [],
            rules: [],
            process: [],
            progress: { done: [], open: [], blocked: [] },
            status: "active",
          },
          routineId: claimed.id,
          now,
        });
      const ticket = store.createTicket({
        taskId: plan.id,
        title: localDate(now),
        spec: claimed.instruction,
        status: "doing",
        worker: claimed.bot_id,
        now,
      });
      const turn = store.createTurn({
        sessionId: session.id,
        botId: claimed.bot_id,
        triggerMessageId: trigger.id,
        routineId: claimed.id,
        routineDueAt: claimed.last_fired_for_due_at,
        taskId: plan.id,
        ticketId: ticket.id,
      });
      return {
        claimed,
        session,
        isNewSession: !existing,
        trigger,
        turn,
      };
    });

    if (!result) return null;

    if (result.isNewSession) {
      publish({
        event: "session.upsert",
        occurred_at: occurred(),
        ...sessionUpsertFields(result.session),
      });
    }
    publishMessage(result.trigger);
    publish({
      event: "routine.upsert",
      occurred_at: occurred(),
      ...result.claimed,
    });
    attachLive(result.turn);
    return result.turn;
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
    const live = lives.get(turn.id);
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
        ? botsToWake(message).map((botId) => startPendingJudgement(message.session_id, message.id, botId, "organizing"))
        : [];
      const handOver = (): void => {
        for (const pending of organizing) dropPendingJudgement(pending, true);
      };
      try {
        if (fromUser) {
          if (store.collectRouteFeedback(message)) {
            const owner = store.feedbackOwner(message.id);
            if (owner) touchChain(message.session_id, owner);
          }
          // Filed before any turn opens, so the turns it opens know their plan and ticket from
          // their first hop. The message itself is already published; only the Bots wait.
          await track(organizer.organizeMessage(message));
        }
        await track(handleParticipation(message, { fromUser, fork: opts?.fork, opened: handOver }));
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
    sweepStaleChains,
    executionOf(turnId) {
      return executionOf(lives.get(turnId));
    },
    sweepToolResults,
    sweepStalledTurns,
    fireRoutine,
    fireCheckBack,
    assertAskPending,
    resolveApproval(id, action, scope, apiKey) {
      const rowForGate = store.getApproval(id);
      const liveForGate = lives.get(rowForGate.turn_id);
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
      publish({ event: "approval.upsert", occurred_at: occurred(), ...row });
      if (action === "always_allow" && row.kind_key) {
        const nextScope = row.kind_key === "unconstrained-shell" ? "*" : (scope ?? row.target ?? "*");
        const match = store.listAllowRules().find((r) => r.kind_key === row.kind_key && r.scope === nextScope);
        if (match) publish({ event: "allow_rule.upsert", occurred_at: occurred(), ...match });
      }
      store.afterCommit(() => {
        const live = lives.get(row.turn_id);
        if (!live?.approval || live.approval.id !== id || live.abort.signal.aborted || store.getTurn(row.turn_id).status !== "waiting_approval") return;
        const pending = live.approval;
        live.approval = undefined;
        const running = store.setTurnStatus(row.turn_id, "running");
        publishTurn(running);
        if (action === "deny") {
          pending.waiter({
            ok: false,
            error: { code: "denied", message: "denied" },
            emitted: [],
          });
          return;
        }
        void trackTurn(row.turn_id, (async () => {
          try {
            if (!active(row.turn_id, live)) return;
            const result = await pending.run({ api_key: apiKey });
            if (active(row.turn_id, live)) pending.waiter(result);
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
      const live = lives.get(turn.id)!;
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
      publish({ event: "message.upsert", occurred_at: occurred(), ...answered });
      publishTurn(running);
      store.afterCommit(() => {
        live.ask = undefined;
        waiter(answer);
      });
      return answered;
    },
    stop(turnId, opts) {
      const turn = store.stopTurn(turnId, {
        ...opts,
        execution: turnId ? executionOf(lives.get(turnId)) : null,
      });
      if (turn) {
        abortLive(turn.id);
        publishTurn(turn, null);
      }
      return turn;
    },
    continueFromInterrupt,
    abortAll() {
      for (const timer of chainTimers.values()) clearTimeout(timer);
      chainTimers.clear();
      organizer.clearTimers();
      for (const id of [...lives.keys()]) abortLive(id);
    },
    unsettledTurnIds() { return [...turnTasks.keys()]; },
    async drain() {
      await drainLives();
    },
    partialText(turnId) {
      return lives.get(turnId)?.partial ?? null;
    },
    pendingJudgements(sessionId) {
      const rows = [...pendingJudges.values()];
      const filtered = sessionId ? rows.filter((row) => row.session_id === sessionId) : rows;
      return filtered.sort((a, b) => {
        if (a.created_at < b.created_at) return -1;
        if (a.created_at > b.created_at) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    },
    suggestComposer,
    async close() {
      await drainLives();
      for (const pending of [...pendingJudges.values()]) dropPendingJudgement(pending, true);
      await mcp?.close();
    },
  };
}
