import {
  USER_MEMBER,
  type ClientEvent,
  type Locale,
  type Message,
  type PendingJudgement,
  type Spend,
  type ThinkingLevel,
  type Turn,
} from "@real-bot/protocol";
import { runCollabTool, type ToolResult } from "./collab-tools";
import {
  createCompletionsClient,
  type ChatMessage,
  type CompletionsClient,
  type MappedUsage,
  type ToolCall,
} from "./completions";
import { assembleJudgementUser, assembleTurnMessages, extractJudgement } from "./context";
import { classifyMessage, type RouteDecision } from "./route-decision";
import { serializeToolResult } from "./tool-results";
import { persistMcpInspect, type McpHost } from "./mcp-host";
import { parseMentions } from "./mentions";
import { isNoWorkCloser } from "./no-work";
import {
  builtinTools,
  COLLAB_TOOL_NAMES,
  completionFailBody,
  JUDGEMENT_SYSTEM,
  unknownMentionBody,
  type FailKind,
} from "./prompts";
import { HttpError } from "./errors";
import { resolveCompletionTarget } from "./models";
import { isoNow, ulid } from "./ids";
import { type Store } from "./store";
import { linkifyWorkspacePaths, mergeCitedPaths, writtenPathFromToolData } from "./artifact-paths";
import { classifyPath } from "./workspace-paths";
import { isWorkspaceTool, runWorkspaceTool } from "./workspace-tools";

export type TurnEngine = {
  handleInboundMessage: (
    message: Message,
    opts?: { fork?: boolean; fromUser?: boolean },
  ) => Promise<void>;
  fireRoutine: (routineId: string, now?: Date) => Turn | null;
  replyAsk: (askId: string, answer: Message) => Promise<void>;
  resolveApproval: (
    id: string,
    action: "allow_once" | "deny" | "always_allow",
    scope?: string,
    apiKey?: string,
  ) => Promise<unknown>;
  stop: (turnId?: string, opts?: { allowGroup?: boolean }) => Turn | null;
  continueFromInterrupt: (messageId: string) => Turn;
  abortAll: () => void;
  partialText: (turnId: string) => string | null;
  pendingJudgements: (sessionId?: string) => PendingJudgement[];
  drain: () => Promise<void>;
  close: () => Promise<void>;
};

export type TurnEngineOptions = {
  store: Store;
  publish: (event: ClientEvent) => void;
  completions?: CompletionsClient;
  sleep?: (ms: number) => Promise<void>;
  mcp?: McpHost;
};

type Live = {
  abort: AbortController;
  loop: ChatMessage[];
  interrupt: boolean;
  burned: boolean;
  partial: string;
  parentId: string | null;
  writtenPaths: string[];
  /** Unknown `@token`s send_message already rejected once this turn. */
  mentionWarned: Set<string>;
  /** Tool names in the current hop's tools array; read_skill flags `mcp_` names a body cites that are missing. */
  toolNames: Set<string>;
  spoke: boolean;
  running: Promise<void>;
  ask?: {
    id: string;
    toolCallId: string;
    waiter: (answer: string) => void;
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
  const completions =
    options.completions ??
    createCompletionsClient(options.sleep ? { clock: { sleep: options.sleep } } : {});
  const mcp = options.mcp;
  const lives = new Map<string, Live>();
  const tasks = new Set<Promise<unknown>>();
  const pendingJudges = new Map<string, PendingJudgement>();

  function track<T>(promise: Promise<T>): Promise<T> {
    tasks.add(promise);
    void promise.finally(() => tasks.delete(promise));
    return promise;
  }

  function occurred(): string {
    return new Date().toISOString();
  }

  function publishTurn(turn: Turn, partial: string | null = null): void {
    publish({ event: "turn.upsert", occurred_at: occurred(), ...turn, partial_text: partial });
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
      baseUrl: string;
      apiKey: string;
      models: string[];
      defaultModel: string | null;
    }>;
  };

  type ResolvedTarget = {
    baseUrl: string;
    apiKey: string;
    model: string;
    thinkingLevel: ThinkingLevel;
    locale: Locale;
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

  function startTurn(sessionId: string, botId: string, trigger: Message, mode: "redirect" | "fork"): Turn {
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
        abortLive(current.id);
        const redirected = store.redirectTurn(current.id);
        publishTurn(redirected);
      }
    }
    const turn = store.createTurn({ sessionId, botId, triggerMessageId: trigger.id });
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
      mentionWarned: new Set(),
      toolNames: new Set(),
      spoke: false,
      running: Promise.resolve(),
    };
    lives.set(turn.id, live);
    publishTurn(turn);
    live.running = track(runTurn(turn.id).catch(() => undefined));
  }

  function continueFromInterrupt(messageId: string): Turn {
    const turn = store.claimInterruptContinue(messageId);
    attachLive(turn);
    return turn;
  }

  function abortLive(turnId: string): void {
    const live = lives.get(turnId);
    if (live) live.abort.abort();
  }

  async function drainLives(): Promise<void> {
    while (tasks.size > 0 || lives.size > 0) {
      for (const id of [...lives.keys()]) abortLive(id);
      await Promise.allSettled([
        ...tasks,
        ...[...lives.values()].map((live) => live.running),
      ]);
    }
  }

  async function runTurn(turnId: string): Promise<void> {
    const live = lives.get(turnId);
    if (!live) return;
    const creds = await credentials();
    if (!creds) {
      await failTurn(turnId, "unreachable");
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
    const routed = targetFor(botId, creds, triggerBody);
    if (!routed) {
      await failTurn(turnId, "no_model");
      return;
    }
    const target = routed.target;
    try {
      store.recordTurnRoute({ turnId, decision: routed.decision });
    } catch {
      // route row is best-effort; the completion still carries the chosen fields
    }
    const drop = (): void => {
      lives.delete(turnId);
    };
    if (mcp) {
      for (const server of store.listMcpServers()) {
        if (!server.enabled) continue;
        if (server.instructions || server.tool_catalog.length > 0) continue;
        try {
          const next = await persistMcpInspect(store, mcp, server);
          if (next.updated_at !== server.updated_at) {
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
      if (current.status !== "running") {
        drop();
        return;
      }
      if (live.abort.signal.aborted) {
        drop();
        return;
      }
      store.touchTurn(turnId);
      const listed = mcp ? await mcp.listForTurn() : { tools: [], guides: [] };
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
      const tools = [...builtinTools(target.locale), ...listed.tools];
      live.toolNames = new Set(tools.map((tool) => tool.function.name));
      live.partial = "";
      publishTurn(current, "");
      let result;
      try {
        result = await completions.complete({
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          thinkingLevel: target.thinkingLevel,
          messages,
          tools,
          signal: live.abort.signal,
          onEvent(chunk) {
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
              });
            }
          },
        });
      } catch {
        drop();
        return;
      }
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
      recordSpend(current, result.usage, result.missingReason, null);

      if (!result.ok) {
        await failTurn(turnId, result.failKind);
        return;
      }

      if (result.toolCalls.length > 0) {
        live.loop.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls,
        });
        const outcome = await executeTools(turnId, result.toolCalls);
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
      const message = publishCitedBotMessage(current, live, turnId, rawBody);
      const completed = store.setTurnStatus(turnId, "completed");
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
    const completed = store.setTurnStatus(turnId, "completed");
    lives.delete(turnId);
    publishTurn(completed, null);
  }

  function publishCitedBotMessage(turn: Turn, live: Live, turnId: string, body: string): Message | null {
    const linked = linkifyWorkspacePaths(body, live.writtenPaths);
    if (!linked.trim()) return null;
    const message = store.insertMessage({
      sessionId: turn.session_id,
      turnId,
      parentId: live.parentId,
      kind: "bot",
      author: turn.bot_id,
      body: linked,
      paths: live.writtenPaths,
    });
    publishMessage(message);
    live.spoke = true;
    return message;
  }

  function noteWrittenPaths(live: Live, result: ToolResult): void {
    if (!result.ok) return;
    const root = store.workspacePath();
    if (!root) return;
    for (const raw of writtenPathFromToolData(result.data)) {
      const classified = classifyPath(root, raw);
      if (classified.zone !== "inside") continue;
      live.writtenPaths = mergeCitedPaths(live.writtenPaths, [classified.rel]);
    }
  }

  async function executeTools(turnId: string, calls: ToolCall[]): Promise<"wait" | "noop" | "more" | "spoke"> {
    const live = lives.get(turnId);
    if (!live) return "wait";
    const turn = store.getTurn(turnId);
    let posted = false;
    let spoke = false;
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
      let result = await dispatchTool(turn, live, call.name, args);
      await publishEmitted(result.emitted);
      result = withLatestMcp(call.name, result);
      noteWrittenPaths(live, result);
      if (result.waitAsk) {
        const ask = store.insertMessage({
          sessionId: turn.session_id,
          turnId,
          parentId: live.parentId,
          kind: "ask",
          author: turn.bot_id,
          body: result.waitAsk.question,
        });
        publishMessage(ask);
        const waiting = store.setTurnStatus(turnId, "waiting_ask");
        publishTurn(waiting, null);
        const answer = await waitForAsk(turnId, ask.id, call.id);
        if (answer == null) return "wait";
        live.loop.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializeToolResult({ ok: true, data: { ask_id: ask.id, message_id: ask.id, answer } }, store.workspacePath()),
        });
        posted = true;
        continue;
      }
      if (result.waitApproval) {
        const card = store.insertMessage({
          sessionId: turn.session_id,
          turnId,
          parentId: live.parentId,
          kind: "approval",
          author: turn.bot_id,
          body: result.waitApproval.summary,
        });
        const approval = store.insertApproval({
          turnId,
          messageId: card.id,
          kind_key: result.waitApproval.kind_key,
          summary: result.waitApproval.summary,
          target: result.waitApproval.target,
          requires_api_key: Boolean(result.waitApproval.requiresApiKey),
        });
        const pending = waitForApproval(
          turnId,
          approval.id,
          call.id,
          result.waitApproval.run,
          result.waitApproval.requiresApiKey,
        );
        publishMessage(card);
        publish({ event: "approval.upsert", occurred_at: occurred(), ...approval });
        const waiting = store.setTurnStatus(turnId, "waiting_approval");
        publishTurn(waiting, null);
        let resolved = await pending;
        if (resolved == null) return "wait";
        await publishEmitted(resolved.emitted);
        resolved = withLatestMcp(call.name, resolved);
        noteWrittenPaths(live, resolved);
        const payload = resolved.ok
          ? { ok: true, data: resolved.data }
          : { ok: false, error: resolved.error };
        live.loop.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializeToolResult(payload, store.workspacePath()),
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
      live.loop.push({
        role: "tool",
        tool_call_id: call.id,
        content: serializeToolResult(payload, store.workspacePath()),
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
  ): Promise<ToolResult> {
    if (isWorkspaceTool(name) || COLLAB_TOOL_NAMES.includes(name)) {
      return isWorkspaceTool(name)
        ? await runWorkspaceTool({ store, signal: live.abort.signal }, name, args)
        : await runCollabTool(
            {
              store,
              botId: turn.bot_id,
              sessionId: turn.session_id,
              turnId: turn.id,
              parentId: live.parentId,
              writtenPaths: live.writtenPaths,
              mentionWarned: live.mentionWarned,
              availableToolNames: live.toolNames,
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

  async function publishEmitted(emitted: ToolResult["emitted"]): Promise<void> {
    for (const item of emitted) {
      if (item.kind === "bot") {
        publish({ event: "bot.upsert", occurred_at: occurred(), ...item.bot, deleted_at: item.deleted_at });
      } else if (item.kind === "session") {
        const s = item.session;
        publish({
          event: "session.upsert",
          occurred_at: occurred(),
          id: s.id,
          kind: s.kind,
          name: s.name,
          last_read_at: s.last_read_at ?? null,
          created_at: s.created_at,
          updated_at: s.updated_at,
          participants: s.participants,
          unread_count: s.unread_count ?? 0,
        });
      } else if (item.kind === "message") {
        publishMessage(item.message);
      } else if (item.kind === "participation") {
        void track(handleParticipation(item.message, { fromUser: false }));
      } else if (item.kind === "routine") {
        publish({ event: "routine.upsert", occurred_at: occurred(), ...item.routine });
        fireRoutine(item.routine.id);
      } else if (item.kind === "routine_removed") {
        publish({ event: "routine.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "skill") {
        publish({ event: "skill.upsert", occurred_at: occurred(), ...item.skill });
      } else if (item.kind === "skill_removed") {
        publish({ event: "skill.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "provider") {
        publish({ event: "provider.upsert", occurred_at: occurred(), ...item.provider });
      } else if (item.kind === "provider_removed") {
        publish({ event: "provider.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "mcp") {
        let server = item.server;
        if (mcp) {
          try {
            server = await persistMcpInspect(store, mcp, server);
          } catch {
            // catalog parse is best-effort; the row is already saved
          }
        }
        publish({ event: "mcp.upsert", occurred_at: occurred(), ...server });
      } else if (item.kind === "mcp_removed") {
        publish({ event: "mcp.removed", occurred_at: occurred(), id: item.id });
      } else if (item.kind === "settings") {
        publish({ event: "settings.changed", occurred_at: occurred(), ...(await store.settings()) });
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

  function waitForAsk(turnId: string, askId: string, toolCallId: string): Promise<string | null> {
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

  /** A Bot's `@token` matched nobody present: say so in the transcript so the miss is visible. */
  async function noteUnknownMentions(message: Message, tokens: string[], members: string[]): Promise<void> {
    const locale = (await store.settings()).locale;
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

  async function failTurn(turnId: string, kind: FailKind): Promise<void> {
    const live = lives.get(turnId);
    const current = store.getTurn(turnId);
    if (current.status !== "running") {
      lives.delete(turnId);
      return;
    }
    const locale = (await store.settings()).locale;
    const message = store.insertMessage({
      sessionId: current.session_id,
      turnId,
      parentId: live?.parentId ?? null,
      kind: "system",
      author: current.bot_id,
      body: completionFailBody(locale, kind),
    });
    publishMessage(message);
    store.finishTurnRoute(turnId, "failed", kind);
    const completed = store.setTurnStatus(turnId, "completed");
    lives.delete(turnId);
    publishTurn(completed, null);
  }

  function recordSpend(
    turn: Turn,
    usage: MappedUsage | null,
    missing: Spend["missing_reason"],
    judgementId: string | null,
  ): void {
    const hasDigits = Boolean(
      usage &&
        (usage.input_tokens != null ||
          usage.output_tokens != null ||
          usage.total_tokens != null ||
          usage.cached_tokens != null ||
          usage.reasoning_tokens != null ||
          usage.cost_usd_ticks != null),
    );
    if (!hasDigits && !missing) return;
    const row = store.insertSpend({
      sessionId: turn.session_id,
      botId: turn.bot_id,
      turnId: judgementId ? null : turn.id,
      judgementId,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
      cachedTokens: usage?.cached_tokens ?? null,
      reasoningTokens: usage?.reasoning_tokens ?? null,
      costUsdTicks: usage?.cost_usd_ticks ?? null,
      missingReason: hasDigits ? null : missing,
    });
    publishSpend(row);
  }

  async function handleParticipation(message: Message, opts: { fromUser: boolean; fork?: boolean }): Promise<void> {
    const session = store.getSession(message.session_id);
    if (message.kind !== "user" && message.kind !== "bot") return;

    if (session.kind === "direct") {
      const bots = store.presentBotIds(session.id);
      const target = bots.find((id) => id !== message.author);
      if (!target) return;
      const fork = opts.fork !== undefined ? opts.fork : true;
      startTurn(session.id, target, message, fork ? "fork" : "redirect");
      return;
    }

    const roster = store.listBots();
    const nameById = new Map(roster.map((b) => [b.id, b.name] as const));
    const presentNames = store
      .presentBotIds(session.id)
      .map((id) => nameById.get(id))
      .filter((name): name is string => typeof name === "string");
    const parsed = parseMentions(message.body, roster.map((b) => b.name), { lenient: presentNames });
    if (!opts.fromUser && parsed.unresolved.length > 0) {
      const authorName = nameById.get(message.author);
      await noteUnknownMentions(message, parsed.unresolved, presentNames.filter((name) => name !== authorName));
    }
    if (session.kind === "group") {
      for (const name of parsed.mentions) {
        const bot = store.findBotByName(name);
        if (!bot) continue;
        if (!store.isPresent(session.id, bot.id)) {
          const next = store.addMember(session.id, bot.id);
          publish({
            event: "session.upsert",
            occurred_at: occurred(),
            id: next.id,
            kind: next.kind,
            name: next.name,
            last_read_at: next.last_read_at ?? null,
            created_at: next.created_at,
            updated_at: next.updated_at,
            participants: next.participants,
            unread_count: next.unread_count ?? 0,
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
      pendingByBot.set(botId, startPendingJudgement(message.session_id, message.id, botId));
    }
    await Promise.all(
      judges.map((botId) =>
        judge(botId, message, parsed.mentions, parsed.everyone, pendingByBot.get(botId)!),
      ),
    );
  }

  function startPendingJudgement(sessionId: string, messageId: string, botId: string): PendingJudgement {
    const pending: PendingJudgement = {
      id: ulid(),
      session_id: sessionId,
      message_id: messageId,
      bot_id: botId,
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
      const turnStub: Turn = {
        id: "",
        session_id: message.session_id,
        bot_id: botId,
        status: "running",
        trigger_message_id: message.id,
        last_activity_at: message.created_at,
        created_at: message.created_at,
        updated_at: message.created_at,
      };
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
        return;
      }
      if (decision === "join") startTurn(message.session_id, botId, message, "redirect");
      finish(row);
      publish({ event: "judgement.created", occurred_at: occurred(), ...row });
      if (result.usage) {
        recordSpend(turnStub, result.usage, null, row.id);
      } else if (result.failKind === null || result.failKind === "incomplete") {
        recordSpend(turnStub, null, "endpoint_omitted", row.id);
      }
    } finally {
      if (!settled) finish();
    }
  }

  function fireRoutine(routineId: string, now: Date = new Date()): Turn | null {
    const claimed = store.claimRoutineDue(routineId, now);
    if (!claimed) return null;
    const existing = store.findDirectSession(USER_MEMBER, claimed.bot_id);
    const session = existing ?? store.createDirect(USER_MEMBER, claimed.bot_id);
    if (!existing) {
      publish({
        event: "session.upsert",
        occurred_at: occurred(),
        id: session.id,
        kind: session.kind,
        name: session.name,
        last_read_at: session.last_read_at ?? null,
        created_at: session.created_at,
        updated_at: session.updated_at,
        participants: session.participants,
        unread_count: session.unread_count ?? 0,
      });
    }
    const trigger = store.insertMessage({
      sessionId: session.id,
      kind: "user",
      author: USER_MEMBER,
      body: claimed.instruction,
    });
    publishMessage(trigger);
    publish({
      event: "routine.upsert",
      occurred_at: occurred(),
      ...claimed,
    });
    return startTurn(session.id, claimed.bot_id, trigger, "fork");
  }

  return {
    async handleInboundMessage(message, opts) {
      if (opts?.fromUser ?? message.author === USER_MEMBER) {
        store.collectRouteFeedback(message);
      }
      await track(
        handleParticipation(message, {
          fromUser: opts?.fromUser ?? message.author === USER_MEMBER,
          fork: opts?.fork,
        }),
      );
    },
    fireRoutine,
    async resolveApproval(id, action, scope, apiKey) {
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
      const live = lives.get(row.turn_id);
      if (!live?.approval || live.approval.id !== id) {
        return row;
      }
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
        return row;
      }
      try {
        const result = await pending.run({ api_key: apiKey });
        pending.waiter(result);
      } catch (error) {
        pending.waiter(
          error instanceof HttpError
            ? { ok: false, error: { code: error.code, message: error.message }, emitted: [] }
            : { ok: false, error: { code: "failed", message: "tool failed" }, emitted: [] },
        );
      }
      return row;
    },
    async replyAsk(askId, answer) {
      const ask = store.getMessage(askId);
      if (ask.kind !== "ask" || !ask.turn_id) {
        throw new HttpError(422, "invalid_args", "ask replies need a running turn");
      }
      const turn = store.getTurn(ask.turn_id);
      if (turn.status !== "waiting_ask") {
        throw new HttpError(422, "invalid_args", "ask is no longer pending");
      }
      const live = lives.get(turn.id);
      if (!live?.ask || live.ask.id !== askId) {
        throw new HttpError(422, "invalid_args", "ask replies need a running turn");
      }
      const waiter = live.ask.waiter;
      live.ask = undefined;
      const running = store.setTurnStatus(turn.id, "running");
      publishTurn(running);
      waiter(answer.body);
    },
    stop(turnId, opts) {
      const turn = store.stopTurn(turnId, opts);
      if (turn) {
        abortLive(turn.id);
        publishTurn(turn, null);
      }
      return turn;
    },
    continueFromInterrupt,
    abortAll() {
      for (const id of [...lives.keys()]) abortLive(id);
    },
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
    async close() {
      await drainLives();
      for (const pending of [...pendingJudges.values()]) dropPendingJudgement(pending, true);
      await mcp?.close();
    },
  };
}
