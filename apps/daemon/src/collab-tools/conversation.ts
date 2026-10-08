/** Tools that speak, open conversations, hand work over or end a turn. */
import { attachmentLinePaths, USER_MEMBER, type SessionSummary } from "@real-bot/protocol";
import { extractWorkspacePathsFromBody, linkifyWorkspacePaths, mergeCitedPaths, resolveBodyPathsToWorkDir } from "../artifact-paths";
import { parseAskSpec } from "../ask";
import type { ToolCtx, ToolResult } from "../collab-tools";
import { HttpError } from "../errors";
import { parseMentions } from "../mentions";
import { isNoWorkCloser } from "../no-work";
import type { Store } from "../store";
import { goAheadBounce } from "../store/end-contract";
import { ENGINE_LEVELS } from "../store/schema-gate";
import { toolFail as fail } from "../tool-result";
import { memberNames, optionalString, optionalStringArray, pathExists, presentMemberNames, requireString, resolveCitedPaths, turnOrigin, unknownMentionError } from "./args";

export function sendMessage(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const body = requireString(args.body, "body");
  if (ctx.read?.noWork ?? isNoWorkCloser(body)) {
    return { ok: true, data: { skipped: true, reason: "no_new_work" }, emitted: [] };
  }
  const sessionId = optionalString(args.session_id) ?? ctx.sessionId;
  const parentId = optionalString(args.parent_id);
  if (!ctx.store.isPresent(sessionId, ctx.botId)) {
    return fail("not_a_member", "you are not in that session");
  }
  const session = ctx.store.getSession(sessionId);
  if (ctx.store.capabilities().engine_level >= 3 && ctx.store.isPresent(sessionId, "user") && !parentId
    && ctx.store.progressMessagesSent(ctx.turnId) >= 3) {
    return fail("progress_limit", "this segment already posted three progress lines; continue the work without another progress post");
  }
  const roster = ctx.store.listBots();
  const selfName = roster.find((b) => b.id === ctx.botId)?.name;
  const presentNames = presentMemberNames(ctx.store, sessionId, roster);
  // Mentions are checked on the body as it will be stored, with cited paths resolved into the
  // work dir and linked: that is the text participation reads when it decides who to wake.
  const corrected = resolveBodyPathsToWorkDir(body, ctx.workDir, (relpath) =>
    pathExists(ctx.store, relpath),
  );
  const cited = mergeCitedPaths(
    [...(ctx.writtenPaths ?? []), ...(optionalStringArray(args.paths, "paths") ?? [])],
    [...extractWorkspacePathsFromBody(corrected), ...attachmentLinePaths(corrected)],
  );
  const resolved = resolveCitedPaths(ctx.store, cited);
  const linked = linkifyWorkspacePaths(corrected, resolved.paths);
  // Stored replies have their file paths linked; compare the same body on both sending paths.
  if (
    (ctx.writtenPaths?.length ?? 0) === 0 &&
    !(optionalStringArray(args.paths, "paths") ?? []).length &&
    ctx.store.repeatsPlanAnswer({ turnId: ctx.turnId, sessionId, author: ctx.botId, body: linked, planNudge: ctx.planNudge === true })
  ) {
    return { ok: true, data: { skipped: true, reason: "no_new_work" }, emitted: [] };
  }
  const parsed = parseMentions(linked, roster.map((b) => b.name), { lenient: presentNames });
  const emitted: ToolResult["emitted"] = [];
  if (ctx.store.capabilities().engine_level >= 3 && session.kind === "direct" && !ctx.store.isPresent(sessionId, "user")) {
    const absent = parsed.mentions.some((name) => {
      const bot = roster.find((candidate) => candidate.name === name);
      return !bot || !ctx.store.isPresent(sessionId, bot.id);
    });
    if (absent || parsed.everyone || parsed.unresolved.some((name) => name !== "everyone")) {
      return fail("use_delegate", "要它动手用 delegate / To ask another teammate to work, use delegate.");
    }
  }
  if (ctx.admission?.draining && (sessionId !== ctx.sessionId || parsed.everyone || parsed.mentions.some(name => name !== selfName))) {
    return fail("draining", "new handoffs and child turns are paused; finish this turn without delegation");
  }
  if (session.kind === "group") {
    for (const name of parsed.mentions) {
      const bot = ctx.store.findBotByName(name);
      if (!bot) continue;
      if (!ctx.store.isPresent(sessionId, bot.id)) {
        const next = ctx.store.addMember(sessionId, bot.id);
        emitted.push({ kind: "session", session: next });
      }
    }
  }
  const unresolved = parsed.unresolved.filter((token) => token !== "everyone");
  if (session.kind === "group" && unresolved.length > 0) {
    const fresh = unresolved.filter((token) => !ctx.mentionWarned?.has(token));
    if (fresh.length > 0) {
      for (const token of fresh) ctx.mentionWarned?.add(token);
      const members = presentNames.filter((name) => name !== selfName);
      return fail("unknown_mention", unknownMentionError(fresh, members));
    }
  }
  const message = ctx.store.insertMessage({
    sessionId,
    turnId: ctx.turnId,
    parentId: parentId ?? null,
    kind: "bot",
    author: ctx.botId,
    body: linked,
    sourceTurnId: ctx.turnId,
    paths: resolved.paths,
  });
  const stored = parseMentions(message.body, roster.map((b) => b.name), { lenient: presentNames });
  emitted.push({ kind: "message", message });
  emitted.push({ kind: "participation", message });
  return {
    ok: true,
    data: {
      message_id: message.id,
      session_id: sessionId,
      mentions: stored.mentions,
      corrected_mentions: stored.corrected,
      unresolved_mentions: stored.unresolved.filter((token) => token !== "everyone"),
      paths: resolved.paths,
      unresolved_paths: resolved.unresolved,
    },
    emitted,
  };
}

/** Bot↔Bot directs pile up one per trigger, so this stops at the ones a Bot touched last. */
const LISTED_SESSIONS = 30;

export function listSessions(ctx: ToolCtx): ToolResult {
  const items = ctx.store
    .listSessions()
    .filter((s) => s.participants.some((p) => p.member === ctx.botId && p.left_at === null))
    .slice(0, LISTED_SESSIONS)
    .map((s) => serializeSession(ctx.store, s));
  return { ok: true, data: { sessions: items }, emitted: [] };
}

export function createGroup(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const name = requireString(args.name, "name");
  if (!Array.isArray(args.members)) return fail("invalid_args", "members is required");
  const names = args.members.map((n) => {
    if (typeof n !== "string") throw new HttpError(422, "invalid_args", "members must be names");
    return n;
  });
  const ids = new Set<string>([ctx.botId]);
  for (const n of names) {
    const bot = ctx.store.findBotByName(n);
    if (!bot) return fail("invalid_args", "members must exist on the roster");
    ids.add(bot.id);
  }
  if (ids.size < 2) return fail("invalid_args", "a group needs at least two bots");
  const session = ctx.store.createGroup({ name, members: [...ids] });
  return {
    ok: true,
    data: {
      session_id: session.id,
      name: session.name,
      members: memberNames(ctx.store, session),
    },
    emitted: [{ kind: "session", session }],
  };
}

export function createDirect(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const other = ctx.store.requireBotByName(requireString(args.name, "name"));
  const session = ctx.store.createBotDirect(ctx.botId, other.id, turnOrigin(ctx));
  return {
    ok: true,
    data: {
      session_id: session.id,
      members: memberNames(ctx.store, session),
    },
    emitted: [{ kind: "session", session }],
  };
}

export function addMember(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const sessionId = requireString(args.session_id, "session_id");
  if (!ctx.store.isPresent(sessionId, ctx.botId)) {
    return fail("not_a_member", "you are not in that session");
  }
  const bot = ctx.store.requireBotByName(requireString(args.name, "name"));
  const session = ctx.store.addMember(sessionId, bot.id);
  return {
    ok: true,
    data: { session_id: session.id, members: memberNames(ctx.store, session) },
    emitted: [{ kind: "session", session }],
  };
}

export function removeMember(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const sessionId = requireString(args.session_id, "session_id");
  if (!ctx.store.isPresent(sessionId, ctx.botId)) {
    return fail("not_a_member", "you are not in that session");
  }
  const bot = ctx.store.requireBotByName(requireString(args.name, "name"));
  try {
    const session = ctx.store.removeMember(sessionId, bot.id);
    return {
      ok: true,
      data: { session_id: session.id, members: memberNames(ctx.store, session) },
      emitted: [{ kind: "session", session }],
    };
  } catch (error) {
    if (error instanceof HttpError && error.message === "a group needs at least two bots") {
      return fail("failed", error.message);
    }
    throw error;
  }
}

export function askUser(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const question = requireString(args.question, "question");
  const spec = parseAskSpec(args.options, args.multi_select);
  // A Bot↔Bot direct is the user's to read, not to answer in. Parking a turn on a question
  // nobody can reach would hang it for good, so send the Bot back to where the user is.
  if (!ctx.store.isPresent(ctx.sessionId, USER_MEMBER)) {
    return fail("not_a_member", "the user is not in this session; ask where they are");
  }
  // Only the user's OK to go on (ADR 0058): sent back once, as a blocked ending asking it is.
  if (ctx.read?.goAhead) {
    const turn = ctx.store.getTurn(ctx.turnId);
    ctx.store.recordWorkEvent({ kind: "ask.go_ahead_refused", actor: "app", botId: ctx.botId, taskId: turn.task_id, ticketId: turn.ticket_id,
      turnId: ctx.turnId, sessionId: ctx.sessionId, payload: { question } });
    return fail("asks_go_ahead", goAheadBounce(question));
  }
  return { ok: true, data: {}, waitAsk: { question, spec }, emitted: [] };
}

/**
 * Binds this turn to a job (ADR 0040 P4b): an existing one by id, or a new one opened from a line
 * of the user's the Bot quotes. A job this Bot is already working on takes the line instead, and
 * this turn ends.
 */
export function delegate(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  if (ctx.store.capabilities().engine_level < 3) return fail("delegation_unavailable", "durable delegation is not enabled at this engine level");
  ctx.admission?.assertNew();
  const to = requireString(args.to, "to");
  const bot = ctx.store.listBots().find((candidate) => candidate.id === to || candidate.name === to);
  if (!bot) return fail("invalid_args", "delegate to a present Bot by id or exact name");
  const delegated = ctx.store.delegateWork({ fromTurnId: ctx.turnId, toBotId: bot.id,
    ask: requireString(args.ask, "ask"), expects: args.expects as "deliverable" | "review" | "answer",
    ...(args.ticket === undefined ? {} : { ticketId: requireString(args.ticket, "ticket") }),
    partKeys: optionalStringArray(args.parts, "parts"), requirementIds: optionalStringArray(args.requirement_ids, "requirement_ids"),
    ...(args.continue === undefined ? {} : { continue: args.continue as boolean }) });
  return { ok: true, data: { delegation_id: delegated.delegation.id, thread_session_id: delegated.delegation.thread_session_id,
    work_item_id: delegated.delegation.to_work_item_id, waiting: !!delegated.wait, ended: !!delegated.wait },
    emitted: [{ kind: "session", session: ctx.store.getSession(delegated.delegation.thread_session_id) }] };
}

export function workOn(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const selected = ctx.store.workOn({ turnId: ctx.turnId, plan: args.plan, ticket: args.ticket,
    also: args.also, writtenPaths: ctx.writtenPaths });
  const data: Record<string, unknown> = selected.mergedInto
    ? { merged: true, ended: true, turn_id: selected.mergedInto }
    : { task_id: selected.taskId, ticket_id: selected.ticketId, work_item_id: selected.workItemId,
        ...(selected.ended ? { ended: true } : {}), ...(selected.queued ? { queued: true } : {}) };
  return { ok: true, data, emitted: selected.messages.map((message) => ({ kind: "message", message })), filed: selected.filed };
}

/**
 * The Bot says the turn is over, and what it did with each line it read. The engine ends the turn
 * once the hop's other calls are done; the dispositions are recorded here, on the inbox rows.
 */
export function endTurn(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  if (ctx.store.capabilities().engine_level >= ENGINE_LEVELS.delegation) {
    const finished = ctx.store.finishWork({ turnId: ctx.turnId, reason: args.reason, note: args.note,
      needsFromUser: args.needs_from_user, answer: args.answer, inbox: args.inbox },
      { ...(ctx.read?.lastWord ? { lastWord: ctx.read.lastWord } : {}), ...(ctx.read?.goAhead ? { goAhead: true } : {}),
        written: ctx.producedPaths ?? ctx.writtenPaths ?? [] });
    if (finished.bounce) return { ok: false, error: { code: finished.code ?? "end_contract", message: finished.bounce }, emitted: [] };
    const emitted: ToolResult["emitted"] = [];
    if (finished.notice || finished.ask) {
      // From the supervisor's level a blocked job's question is a card that outlives the segment,
      // answered where you are (ADR 0045); below it, a line saying what the Bot needs from you.
      const message = finished.ask && ctx.store.capabilities().engine_level >= ENGINE_LEVELS.supervision
        ? ctx.store.createWorkQuestion({ turnId: ctx.turnId, body: finished.ask.body })
        : ctx.store.insertMessage({ sessionId: ctx.sessionId, turnId: ctx.turnId, kind: "system", author: ctx.botId,
            body: finished.ask?.body ?? finished.notice!.body, hiddenFromBots: true });
      emitted.push({ kind: "message", message });
    }
    return { ok: true, data: { ended: finished.ended, reason: finished.endReason, state: finished.state,
      inbox: { recorded: finished.dispositions.recorded, not_recorded: finished.dispositions.notRecorded } }, emitted };
  }
  const { recorded, notRecorded } = ctx.store.disposeInboxItems(ctx.turnId, args.inbox);
  return { ok: true, data: { ended: true, inbox: { recorded, not_recorded: notRecorded } }, emitted: [] };
}

/**
 * The Bot books itself a wake-up in this session. The store keeps one per Bot per session and
 * says whether this one replaced an earlier appointment; the scheduler fires it, and the turn it
 * opens lands in this turn's job.
 */
export function checkBack(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const { row, replaced } = ctx.store.scheduleCheckBack({
    botId: ctx.botId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    note: args.note,
    afterMinutes: args.after_minutes,
  });
  return {
    ok: true,
    data: { id: row.id, due_at: row.due_at, after_minutes: args.after_minutes, replaced },
    emitted: [],
  };
}

function serializeSession(store: Store, session: SessionSummary) {
  return {
    id: session.id,
    kind: session.kind,
    name: session.name,
    members: memberNames(store, session),
    updated_at: session.updated_at,
  };
}
