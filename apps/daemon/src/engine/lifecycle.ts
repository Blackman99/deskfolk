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
import {
  extractWorkspacePathsFromBody,
  mergeCitedPaths,
  resolveBodyPathsToWorkDir,
} from "../artifact-paths";
import { pathExists } from "../collab-tools";
import type { CompletionsClient } from "../completions";
import { assembleTurnMessages, planTagger, sessionLabel, type PlanRef } from "../context";
import { completionFailBody, builtinTools, type FailKind } from "../prompts";
import { isNoWorkCloser } from "../no-work";
import type { McpHost } from "../mcp-host";
import type { TurnAdmission } from "../quiesce";
import { isoNow } from "../ids";
import type { TurnExecution } from "../store/routing";
import type { Store } from "../store";
import { checkInNote, lastHopNote, turnPace } from "../turn-pace";
import { heardNote, recentToolCalls, redirectCarryNote, type HeardItem } from "../turn-inbox";
import type { WakeWatch } from "../wake";
import type { Chains } from "./chains";
import type { Closing } from "./closing";
import type { Participation } from "./participation";
import type { PlanWatch } from "./plan-watch";
import type { Routing } from "./routing";
import type { SpendTracker } from "./spend";
import type { Tools } from "./tools";
import type { InboxEntry, Live } from "./types";

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
  routingTarget: Routing["routingTarget"];
  spendOwner: SpendTracker["spendOwner"];
  callOf: SpendTracker["callOf"];
  recordSpend: SpendTracker["recordSpend"];
  closeChain: Chains["closeChain"];
  touchChain: Chains["touchChain"];
  clearChainTimers: Chains["clearTimers"];
  clearDirectTimers: () => void;
  clearOrganizerTimers: () => void;
  inspectForTurn: Tools["inspectForTurn"];
  executeTools: Tools["executeTools"];
  closingCheck: Closing["closingCheck"];
  publishCitedBotMessage: Closing["publishCitedBotMessage"];
  completeSilent: Closing["completeSilent"];
  observeTicket: PlanWatch["observeTicket"];
  handleParticipation: Participation["handleParticipation"];
};

export type Lifecycle = {
  startTurn: (
    sessionId: string,
    botId: string,
    trigger: Message,
    mode: "redirect" | "fork",
    opts?: {
      routineId?: string | null;
      routineDueAt?: string | null;
      taskId?: string | null;
      ticketId?: string | null;
    },
  ) => Turn;
  hearOrStart: (
    sessionId: string,
    botId: string,
    trigger: Message,
    entry: Omit<InboxEntry, "message">,
    opts?: { taskId?: string | null; ticketId?: string | null },
  ) => Turn;
  hearAcross: (message: Message) => Turn[];
  attachLive: (turn: Turn, carry?: string | null) => void;
  continueFromInterrupt: (messageId: string) => Turn;
  abortLive: (turnId: string) => void;
  drainLives: () => Promise<void>;
  executionOf: (live: Live | undefined) => TurnExecution | null;
  interruptTurn: (current: Turn) => void;
  failTurn: (turnId: string, kind: FailKind) => void;
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
    routingTarget,
    spendOwner,
    callOf,
    recordSpend,
    closeChain,
    touchChain,
    clearChainTimers,
    clearDirectTimers,
    clearOrganizerTimers,
    inspectForTurn,
    executeTools,
    closingCheck,
    publishCitedBotMessage,
    completeSilent,
    observeTicket,
    handleParticipation,
  } = deps;

  /**
   * Nothing in a hop may legitimately go this long without touching the turn: a completion is
   * bounded by the client's first-byte and idle timers, a shell by its own timeout, an MCP call by
   * its idle cap, and both ends of every tool call touch the row. Past this the turn is wedged.
   */
  const STALE_TURN_MS = 20 * 60_000;
  /** How often a still-streaming hop bothers the row; small next to {@link STALE_TURN_MS}. */
  const TOUCH_EVERY_MS = 30_000;

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
    admission?.assertNew();
    let carry: { written: string[]; recent: string[]; unread: HeardItem[]; previous: PlanRef | null } | null = null;
    if (mode === "redirect") {
      const livesForBot = store.listLiveTurns({ sessionId, botId });
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
    attachLive(turn, note);
    return turn;
  }

  /**
   * A Bot's line for a Bot that is already working in this session is heard inside that turn
   * rather than ending it: it waits in the turn's inbox for the next hop. Only when there is no
   * live turn here that this process runs does a new one open. Returns the turn that got it.
   */
  function hearOrStart(
    sessionId: string,
    botId: string,
    trigger: Message,
    entry: Omit<InboxEntry, "message">,
    opts: { taskId?: string | null; ticketId?: string | null } = {},
  ): Turn {
    for (const current of store.listLiveTurns({ sessionId, botId })) {
      const live = lives.get(current.id);
      if (!live || live.abort.signal.aborted) continue;
      // A group turn hears lines about other jobs too; the tag says which one this is about.
      const about = entry.checkBack ?? { taskId: trigger.task_id ?? null, ticketId: trigger.ticket_id ?? null };
      const tag = planTagger(
        store,
        { taskId: current.task_id ?? null, ticketId: current.ticket_id ?? null },
        store.settingsCached().locale,
      )(about);
      live.inbox.push({ ...entry, item: { ...entry.item, tag: tag || undefined }, message: trigger });
      return current;
    }
    return startTurn(sessionId, botId, trigger, "redirect", opts);
  }

  /**
   * Your line, once filed under a plan, reaches every turn working in that plan in another session:
   * you tell a Bot in your direct what to change about the job it is doing in a group, and the
   * group's turns on that job — its own and its teammates' — read it on their next hop without being
   * interrupted. Turns in the line's own session already have it in their transcript. Returns the
   * turns that got it.
   */
  function hearAcross(message: Message): Turn[] {
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
      const live = lives.get(current.id);
      if (!live || live.abort.signal.aborted) continue;
      const tag = planTagger(store, { taskId: current.task_id ?? null, ticketId: current.ticket_id ?? null }, locale)({
        taskId: message.task_id,
        ticketId: message.ticket_id ?? null,
      });
      const where = sessionLabel(store, message.session_id, current.bot_id, locale) ?? undefined;
      live.inbox.push({
        item: { author, body, checkBack: false, tag: tag || undefined, where },
        message,
        elsewhere: true,
      });
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
  function reopenForUnheard(turn: Turn, live: Live): void {
    if (live.inbox.length === 0 || admission?.draining) return;
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
    const last = pending[pending.length - 1]!;
    try {
      const reopened = hearOrStart(
        turn.session_id,
        turn.bot_id,
        last.message,
        { item: last.item, ...(last.checkBack ? { checkBack: last.checkBack } : {}) },
        last.checkBack ? { taskId: last.checkBack.taskId, ticketId: last.checkBack.ticketId } : {},
      );
      for (const entry of pending.slice(0, -1)) {
        if (!entry.checkBack) continue;
        // an earlier check-back line is its own reminder; it rides along in the new turn's inbox
        lives.get(reopened.id)?.inbox.unshift(entry);
      }
    } catch (error) {
      console.error(`[turn ${turn.id}] could not reopen for what it had not read`, error);
    }
  }

  function attachLive(turn: Turn, carry: string | null = null): void {
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
            reopenForUnheard(turn, live);
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
    admission?.assertNew();
    const turn = store.claimInterruptContinue(messageId);
    attachLive(turn);
    return turn;
  }

  function abortLive(turnId: string): void {
    const live = lives.get(turnId);
    if (live) store.afterCommit(() => live.abort.abort());
  }

  async function drainLives(): Promise<void> {
    clearChainTimers();
    clearDirectTimers();
    clearOrganizerTimers();
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
      // What was said to this Bot since the last hop, read out now: the turn goes on with it.
      if (live.inbox.length > 0) {
        const heard = live.inbox.splice(0);
        live.loop.push({ role: "user", content: heardNote(target.locale, heard.map((entry) => entry.item)) });
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
      live.mcpTools = new Map(listed.guides.flatMap((guide) =>
        guide.tools.map((tool) => [tool.modelName, { server: guide.name, tool: tool.toolName ?? tool.modelName }] as const)));
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
      if (message && live.writtenPaths.length > 0) observeTicket(turnId, current.bot_id, "delivered");
      const completed = store.setTurnStatus(turnId, "completed", executionOf(live));
      lives.delete(turnId);
      publishTurn(completed, null);
      // A closing reply goes out the way send_message would: in a group it wakes whoever it
      // names, in a Bot↔Bot direct the other Bot. A you↔Bot direct has no one else to wake.
      if (message && !live.parentId) {
        void track(handleParticipation(message, { fromUser: false }));
      }
      return;
    }
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

  return {
    startTurn,
    hearOrStart,
    hearAcross,
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
