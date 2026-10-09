/** The app's own hop loop: a turn's model calls, tool calls and what it is told between them, until its closing reply. */
import { isLocalEndpoint, type Turn, type Message } from "@real-bot/protocol";
import type { ChatMessage, CompletionOk, CompletionResult } from "../../completions";
import { nearWindow, planCompaction, capacityBytes, compactNote, hopsIn } from "../../compaction";
import { assembleTurnMessages } from "../../context";
import { hopLimits, replyFailure, continueNote, type HopLimits } from "../../hop-limits";
import { builtinTools, contextFullDetail, type ChatTool } from "../../prompts";
import { promptBytes } from "../../local-model";
import { turnPace, checkInNote, lastHopNote, emptyReplyNote, type TurnPace } from "../../turn-pace";
import { inboxLabel } from "../../store";
import { heardNote } from "../../turn-inbox";
import { readOnlyTools } from "../tools";
import type { Live, ResolvedTarget, SpendOwner } from "../types";
import { summarizeLoop } from "../compaction";
import { editedToolDescription, promptPage } from "../../prompts/book";
import { codePointCount, takeCodePoints } from "../../text";
import type { LifecycleDeps } from "../lifecycle";
import type { McpHost } from "../../mcp-host";
import type { TurnEndings } from "./endings";
import type { ClosingReply } from "./closing-reply";

/** What a turn runs on for all its hops, once it is routed. */
type Run = { target: ResolvedTarget; limits: HopLimits; turnOwner: SpendOwner };
/** What a hop's reply leaves the loop to do: go round again, end here, or end and let go of the live turn. */
type Hop = "next" | "end" | "drop";
/** The MCP tools offered to a hop, with their servers' guides. */
type Listed = Awaited<ReturnType<McpHost["listForTurn"]>>;

export function createHopLoop(deps: LifecycleDeps, endings: TurnEndings, closingReply: ClosingReply) {
  const { store, publish, publishTurn, occurred, mcp, completions, lives, active, credentials, agentRoute, targetFor, decideRoute, routingTarget, spendOwner, callOf, recordSpend, recordResponseSpend, closeChain, holdChain, inspectForTurn, executeTools, completeSilent } = deps;
  const { failTurn, retryOrFail } = endings;
  const { settleClosingReply } = closingReply;

  async function runTurn(turnId: string): Promise<void> {
    const live = lives.get(turnId);
    if (!live) return;
    const run = await openRun(turnId, live);
    if (!run) return;
    const { target, limits, turnOwner } = run;
    const drop = (): void => {
      lives.delete(turnId);
    };
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
      const pace = notePace(live, target);
      readInbox(turnId, live, current, target);
      const listed = mcp ? await mcp.listForTurn() : { tools: [], guides: [] };
      if (!active(turnId, live)) return;
      const assemble = () => assembleTurnMessages(store, {
        sessionId: current.session_id,
        botId: current.bot_id,
        turnId,
        triggerMessageId: current.trigger_message_id,
        locale: target.locale,
        interrupt: live.interrupt,
        loop: live.loop,
        mcpGuides: listed.guides,
      });
      let messages = assemble();
      const tools = offerTools(live, current, target, listed, pace);
      let sentBytes = promptBytes(messages, tools);
      // Near the window the model's entry names, the older hops are condensed before this one goes (ADR 0068).
      if (!live.compacted && nearWindow(sentBytes, store.contextWindowOf(target.baseUrl, target.model), live.bytesPerToken)) {
        const compacted = await compactTurn(turnId, live, current, target, turnOwner, sentBytes, "near");
        if (!active(turnId, live)) return;
        if (compacted) {
          messages = assemble();
          sentBytes = promptBytes(messages, tools);
        }
      }
      // What it last said while working stays up through the next hop, as a Claude Agent Bot's
      // does: a hop that only calls tools does not wipe the line above them (2026-10-06).
      publishTurn(current, live.partial);
      const result = await callModel(turnId, live, current, target, limits, messages, tools);
      if (!result) {
        drop();
        return;
      }
      // Cut for a line of yours (直接插入, ADR 0069): the next hop opens by reading it.
      if (result === "cut") continue;
      const next = await takeReply(turnId, live, current, target, turnOwner, sentBytes, result);
      if (next === "drop") drop();
      if (next !== "next") return;
    }
  }

  /**
   * What a turn settles once, before its first hop: the credentials, where it runs and with which
   * limits, whose spend it is, its chain, and the catalogs of MCP servers that have none yet. Null
   * when the turn stopped meanwhile or cannot run; a failure it cannot run with is already written.
   */
  async function openRun(turnId: string, live: Live): Promise<Run | null> {
    const creds = await credentials();
    if (!active(turnId, live)) return null;
    if (!creds) {
      failTurn(turnId, "unreachable");
      return null;
    }
    let botId: string;
    try {
      botId = store.getTurn(turnId).bot_id;
    } catch {
      lives.delete(turnId);
      return null;
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
    if (!active(turnId, live)) return null;
    const routed = decided ? decideRoute(botId, creds, triggerBody, turnId) : (agent?.routed ?? targetFor(botId, creds, triggerBody));
    if (!routed) {
      failTurn(turnId, "no_model");
      return null;
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
      (deps.localEndpoint ?? isLocalEndpoint)(target.baseUrl),
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
    if (mcp) {
      for (const server of store.listMcpServers()) {
        if (!server.enabled) continue;
        if (server.instructions || server.tool_catalog.length > 0) continue;
        try {
          if (!active(turnId, live)) return null;
          const next = await inspectForTurn(turnId, live, server);
          if (!active(turnId, live)) return null;
          if (next && next.updated_at !== server.updated_at) {
            publish({ event: "mcp.upsert", occurred_at: occurred(), ...next });
          }
        } catch {
          // handshake catalog is best-effort
        }
      }
    }
    return { target, limits, turnOwner };
  }

  /**
   * A long run of tool calls is asked, now and then, whether it is getting anywhere; past the
   * limit the tools go and the next reply is the turn's last (see turn-pace.ts).
   */
  function notePace(live: Live, target: ResolvedTarget): TurnPace {
    const pace = turnPace(live.hops);
    if (pace === "check_in") {
      live.loop.push({ role: "user", content: checkInNote(target.locale, live.hops - 1) });
    } else if (pace === "last" && !live.lastHopNoted) {
      live.lastHopNoted = true;
      live.loop.push({ role: "user", content: lastHopNote(target.locale) });
    }
    return pace;
  }

  /** Brings the turn's inbox up to its rows and reads out to the loop what arrived since the last hop. */
  function readInbox(turnId: string, live: Live, current: Turn, target: ResolvedTarget): void {
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
    // A line you asked to be read now (直接插入) is read here, so the ask is spent.
    live.readNow = false;
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
  }

  /** The tools this hop offers, recorded on the live turn with the MCP tools' servers and arguments. */
  function offerTools(live: Live, current: Turn, target: ResolvedTarget, listed: Listed, pace: TurnPace): ChatTool[] {
    // Tool descriptions you edited (ADR 0064) replace the shipped ones from this hop on.
    const offered = pace === "last" ? [] : [...builtinTools(target.locale, store.capabilities().engine_level, editedToolDescription(promptPage(store, target.locale))), ...listed.tools];
    // A read-only turn is not shown what it may not call (ADR 0040 I3); the gate refuses them anyway.
    const tools = current.mode === "readonly" ? readOnlyTools(offered, listed.guides) : offered;
    live.toolNames = new Set(tools.map((tool) => tool.function.name));
    // Each tool's argument names too: the external-job adapter reads which one a check takes the job's id in.
    const params = new Map(listed.tools.map((tool) => [tool.function.name,
      Object.keys(((tool.function.parameters ?? {}) as { properties?: Record<string, unknown> }).properties ?? {})] as const));
    live.mcpTools = new Map(listed.guides.flatMap((guide) =>
      guide.tools.map((tool) => [tool.modelName, { server: guide.name, tool: tool.toolName ?? tool.modelName, readOnly: tool.readOnly === true,
        params: params.get(tool.modelName) ?? [] }] as const)));
    return tools;
  }

  /**
   * One hop's model call, announcing tool calls as they stream. Null when a stop or redirect aborted
   * it; `cut` when 直接插入 cut this one call short (ADR 0069), whose output is not kept.
   */
  async function callModel(
    turnId: string,
    live: Live,
    current: Turn,
    target: ResolvedTarget,
    limits: HopLimits,
    messages: ChatMessage[],
    tools: ChatTool[],
  ): Promise<CompletionResult | "cut" | null> {
    // Tokens no longer count as progress: a hop that streamed one sentence for 17 minutes looked
    // alive the whole time. The stream's own time limit bounds it instead, and the stale sweep
    // leaves the turn alone while it runs.
    live.streaming = true;
    // 直接插入 cuts this one completion, not the turn: `signal` stays the turn's own.
    const step = new AbortController();
    live.step = step;
    try {
      const result = await completions.complete({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        apiFormat: target.apiFormat,
        model: target.model,
        thinkingLevel: target.thinkingLevel,
        messages,
        tools,
        signal: live.abort.signal,
        cut: step.signal,
        maxTokens: limits.maxTokens,
        wallMs: limits.wallMs,
        // One Bot's conversation in one session stays on one account of a proxy, so each hop
        // reuses the prompt cache the hop before it left there.
        affinity: `deskfolk-${current.session_id}-${current.bot_id}`,
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
      return step.signal.aborted && !live.abort.signal.aborted ? "cut" : result;
    } catch (error) {
      // Stop and redirect already wrote the turn's end state; anything else is a crash.
      if (live.abort.signal.aborted) return null;
      if (step.signal.aborted) return "cut";
      throw error;
    } finally {
      live.streaming = false;
      live.step = undefined;
    }
  }

  /**
   * What the loop does with a hop's reply once it is in: its spend recorded, then a failed hop retried
   * or the turn failed, a reply cut at the output cap carried on, tool calls run, an empty reply asked
   * about once, and a closing reply taken through its checks.
   */
  async function takeReply(
    turnId: string,
    live: Live,
    current: Turn,
    target: ResolvedTarget,
    turnOwner: SpendOwner,
    sentBytes: number,
    result: CompletionResult,
  ): Promise<Hop> {
    recordSpend("turn", current.id, result.usage, result.missingReason, callOf(target), turnOwner);
    if (live.abort.signal.aborted) {
      return "drop";
    }
    try {
      if (store.getTurn(turnId).status !== "running") {
        return "drop";
      }
    } catch {
      return "drop";
    }
    // The sweep measures from here again, now that the stream no longer holds it off.
    store.touchTurn(turnId);
    // What went through is known to fit, and says how many bytes this model reads to a token (ADR 0068).
    if (result.ok) {
      live.fitBytes = Math.max(live.fitBytes ?? 0, sentBytes);
      const read = result.usage?.input_tokens;
      if (read && read > 0) live.bytesPerToken = sentBytes / read;
      live.compacted = false;
    }

    if (result.hadChoices && live.interrupt && !live.burned) {
      live.burned = true;
      store.clearInterruptPending(current.bot_id);
    }

    if (!result.ok) {
      if (result.failKind === "context_full") {
        // Over the model's context: the older hops are condensed and the hop goes again (ADR 0068).
        // Over it again before a hop went through, the turn fails: the same prompt is not sent
        // again, as it would meet the same window (ADR 0067).
        if (!live.compacted && (await compactTurn(turnId, live, current, target, turnOwner, sentBytes, "full"))) {
          if (!active(turnId, live)) return "end";
          return "next";
        }
        if (!active(turnId, live)) return "end";
        failTurn(turnId, "context_full", contextFullDetail(live.locale, result.contextFull));
        return "end";
      }
      if (retryOrFail(turnId, live, result.failKind)) return "next";
      return "end";
    }
    const failure = replyFailure(result);
    if (failure) {
      if (retryOrFail(turnId, live, failure)) return "next";
      return "end";
    }
    live.retried = false;

    // Cut off at the output cap without looping: one more hop carries on from it. Nothing of the
    // cut reply is posted; cut again in a row, the turn fails.
    if (result.finishReason === "length" && result.toolCalls.length === 0) {
      if (live.continued) {
        failTurn(turnId, "truncated");
        return "end";
      }
      live.continued = true;
      if (result.content.trim()) live.loop.push({ role: "assistant", content: result.content });
      live.loop.push({ role: "user", content: continueNote(live.locale, result.toolArgsCut === true) });
      return "next";
    }
    live.continued = false;

    if (result.toolCalls.length > 0) return runToolCalls(turnId, live, current, result);

    // Nothing at all came back: ask once for the next step rather than end the turn silently
    // (see emptyReplyNote). The empty answer itself is not kept in the loop.
    if (!result.content.trim() && !live.emptyNudged) {
      live.emptyNudged = true;
      live.loop.push({ role: "user", content: emptyReplyNote(live.locale) });
      return "next";
    }
    live.loop.push({ role: "assistant", content: result.content });
    const settled = await settleClosingReply(turnId, live, current, result.content);
    if (settled.kind === "bounce") {
      live.loop.push({ role: "user", content: settled.note });
      return "next";
    }
    if (settled.kind === "inactive" && live.abort.signal.aborted) return "drop";
    return "end";
  }

  /** A reply with tool calls: kept in the loop, its words shown while it works, and the calls run. */
  async function runToolCalls(turnId: string, live: Live, current: Turn, result: CompletionOk): Promise<Hop> {
    live.loop.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
      // An Anthropic-format model that thought before these calls wants its thinking back with them.
      ...(result.carry ? { carry: result.carry } : {}),
    });
    // What it says beside its tool calls ("let me check the file first") is shown while it
    // works, the same as a Claude Agent Bot's narration. Only these lines: a reply with no
    // calls is the closing one, which shows once its checks pass.
    if (result.content.trim()) {
      live.partial = result.content;
      publishTurn(store.getTurn(turnId), result.content);
    }
    const outcome = await executeTools(turnId, result.toolCalls);
    if (!active(turnId, live)) return "end";
    if (outcome === "wait") {
      if (live.abort.signal.aborted) return "drop";
      return "end";
    }
    if (outcome === "noop" || outcome === "spoke") {
      completeSilent(turnId);
      return "end";
    }
    return "next";
  }

  /**
   * Condenses the older hops of a turn's loop into a summary on the turn's own model, and puts the
   * summary in their place at the head of the loop (ADR 0068). True when the loop changed; false
   * when nothing there was worth condensing, compacting could not make room, or the summary call
   * gave nothing back.
   */
  async function compactTurn(
    turnId: string,
    live: Live,
    current: Turn,
    target: ResolvedTarget,
    owner: SpendOwner,
    sentBytes: number,
    why: "near" | "full",
  ): Promise<boolean> {
    const plan = planCompaction(live.loop, {
      capacity: capacityBytes(store.contextWindowOf(target.baseUrl, target.model), live.bytesPerToken, live.fitBytes ?? 0),
      fixed: Math.max(0, sentBytes - promptBytes(live.loop, [])),
      bytesPerToken: live.bytesPerToken,
    });
    if (!plan) return false;
    let trigger = "";
    try {
      trigger = store.getMessage(current.trigger_message_id).body;
    } catch {
      trigger = "";
    }
    store.touchTurn(turnId);
    live.streaming = true;
    let summary: string | null;
    try {
      summary = await summarizeLoop({ completions, recordResponseSpend, callOf }, {
        turnId,
        target,
        owner,
        locale: live.locale,
        signal: live.abort.signal,
        page: promptPage(store, live.locale),
        plan,
        trigger,
        earlier: live.summary ?? null,
      });
    } catch {
      summary = null;
    } finally {
      live.streaming = false;
    }
    if (!summary || !active(turnId, live)) return false;
    const note: ChatMessage = { role: "user", content: compactNote(live.locale, summary) };
    live.loop.splice(0, live.loop.length, note, ...plan.tail);
    live.summary = note;
    live.compacted = true;
    store.touchTurn(turnId);
    if (store.learningOn()) {
      try {
        store.recordWorkEvent({ kind: "turn.compacted", actor: "app", botId: current.bot_id, taskId: current.task_id, ticketId: current.ticket_id,
          turnId, sessionId: current.session_id,
          payload: { why, hops: hopsIn(plan.old), kept_hops: hopsIn(plan.tail), bytes_before: sentBytes, summary_chars: codePointCount(summary),
            // What the Bot was left with, for when it later seems to have forgotten something.
            summary: takeCodePoints(summary, 8_000).text } });
      } catch {
        // the work log is best effort
      }
    }
    return true;
  }

  return { runTurn };
}

export type HopLoop = ReturnType<typeof createHopLoop>;
