/**
 * Model choice per turn, and what each Bot learns from it.
 *
 * A turn opened by a user message gets one decision (model + thinking level) from the Bot's
 * candidate list; the decision is written down with the Bot and endpoint it belonged to, and is
 * closed with how the turn ended. Experience is per Bot: a critique aimed at the Reviewer only
 * moves the Reviewer's rows, never the Writer's. Signals are
 *
 * - a user follow-up about the model itself (`isCritiqueMessage`) → negative `CRITIQUE_WEIGHT`;
 * - a completion the model itself botched (refused, incomplete) → negative `FAILURE_WEIGHT`;
 * - a turn that finished cleanly on the pick → positive 1, which pays the penalty back slowly.
 *
 * Endpoint-level failures (unreachable, busy, 5xx, stalls) are recorded on the turn but do not
 * teach anything: they say nothing about the model.
 */
import { USER_MEMBER, type RouteFeedback, type RouteOutcome, type RouteRecord, type ThinkingLevel } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { parseMentions } from "../mentions";
import {
  CRITIQUE_WEIGHT,
  FAILURE_WEIGHT,
  decideCompletion,
  isCritiqueMessage,
  type RouteDecision,
  type RouteLearnedState,
  type RouteSignal,
} from "../route-decision";
import { catalogEntries } from "./providers";
import { defaultProviderId, providerRows, type StoreContext, type TurnRow } from "./shared";

/** Completion failures the model itself is responsible for; the rest are the endpoint's. */
const MODEL_FAULT_FAIL_KINDS = new Set(["refused", "incomplete"]);

type DecisionRow = {
  turn_id: string;
  session_id: string;
  bot_id: string;
  trigger_message_id: string;
  provider_id: string | null;
  model: string;
  thinking_level: string;
  signature: string;
  outcome: RouteOutcome | null;
  fail_kind: string | null;
  created_at: string;
  finished_at: string | null;
};

type FeedbackRow = {
  id: string;
  turn_id: string;
  message_id: string;
  bot_id: string;
  model: string;
  thinking_level: string;
  signature: string;
  body: string;
  created_at: string;
};

type LearnedRow = {
  bot_id: string;
  signature: string;
  model: string;
  thinking_level: string;
  negative: number;
  positive: number;
  updated_at: string;
};

export type DecideRouteInput = {
  /** Whose experience applies. */
  botId: string;
  text: string;
  botModel: string | null;
  botProviderId: string | null;
  botThinkingLevel?: ThinkingLevel | null;
  /** Endpoints that actually have a key this turn; others cannot be picked. */
  providerIds?: readonly string[];
};

export function decideTurnRoute(ctx: StoreContext, input: DecideRouteInput): RouteDecision | null {
  const catalog = catalogEntries(ctx).filter((row) =>
    input.providerIds ? input.providerIds.includes(row.providerId) : true,
  );
  const defaultId = defaultProviderId(ctx) ?? providerRows(ctx)[0]?.id ?? null;
  return decideCompletion({
    text: input.text,
    catalog,
    botModel: input.botModel,
    botProviderId: input.botProviderId,
    defaultProviderId: defaultId,
    botThinkingLevel: input.botThinkingLevel ?? null,
    learned: routeLearnedState(ctx, input.botId),
  });
}

/** Writes the decision a turn ran on; the Bot, session and trigger come from the turn itself. */
export function recordTurnRoute(ctx: StoreContext, input: { turnId: string; decision: RouteDecision }): void {
  const turn = ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(input.turnId);
  if (!turn) return;
  ctx.db.run(
    `INSERT INTO turn_route_decisions (
       turn_id, session_id, bot_id, trigger_message_id, provider_id, model, thinking_level, signature, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(turn_id) DO NOTHING`,
    [
      input.turnId,
      turn.session_id,
      turn.bot_id,
      turn.trigger_message_id,
      input.decision.providerId || null,
      input.decision.model,
      input.decision.thinkingLevel,
      input.decision.signature,
      isoNow(),
    ],
  );
}

/**
 * Closes the turn's decision with its outcome and teaches the Bot. The first outcome wins: a turn
 * that failed is closed as `failed` by the engine before its status flips to `completed`, so the
 * later status hook does not overwrite it with a success.
 */
export function finishTurnRoute(
  ctx: StoreContext,
  turnId: string,
  outcome: RouteOutcome,
  failKind: string | null = null,
): void {
  const row = decisionRow(ctx, turnId);
  if (!row || row.outcome) return;
  ctx.db.run(
    `UPDATE turn_route_decisions SET outcome = ?, fail_kind = ?, finished_at = ? WHERE turn_id = ? AND outcome IS NULL`,
    [outcome, outcome === "failed" ? failKind : null, isoNow(), turnId],
  );
  const key = { signature: row.signature, model: row.model, thinkingLevel: row.thinking_level };
  if (outcome === "completed") {
    applyLearned(ctx, row.bot_id, key, { positive: 1 });
  } else if (outcome === "failed" && failKind && MODEL_FAULT_FAIL_KINDS.has(failKind)) {
    applyLearned(ctx, row.bot_id, key, { negative: FAILURE_WEIGHT });
  }
}

export function getTurnRoute(ctx: StoreContext, turnId: string): RouteRecord | null {
  const row = decisionRow(ctx, turnId);
  if (!row) return null;
  const feedback = ctx.db
    .query<FeedbackRow, [string]>(`SELECT * FROM route_feedback WHERE turn_id = ? ORDER BY created_at ASC, id ASC`)
    .all(turnId);
  return toRecord(row, feedback);
}

/** Every decision made in a session, oldest first, each with the critiques it drew. */
export function listSessionRoutes(ctx: StoreContext, sessionId: string): RouteRecord[] {
  const rows = ctx.db
    .query<DecisionRow, [string]>(
      `SELECT * FROM turn_route_decisions WHERE session_id = ? ORDER BY created_at ASC, turn_id ASC`,
    )
    .all(sessionId);
  if (rows.length === 0) return [];
  const feedback = ctx.db
    .query<FeedbackRow, [string]>(
      `SELECT f.* FROM route_feedback f
       JOIN turn_route_decisions d ON d.turn_id = f.turn_id
       WHERE d.session_id = ?
       ORDER BY f.created_at ASC, f.id ASC`,
    )
    .all(sessionId);
  const byTurn = new Map<string, FeedbackRow[]>();
  for (const item of feedback) {
    const list = byTurn.get(item.turn_id) ?? [];
    list.push(item);
    byTurn.set(item.turn_id, list);
  }
  return rows.map((row) => toRecord(row, byTurn.get(row.turn_id) ?? []));
}

export function listRouteFeedback(ctx: StoreContext, filter: { botId?: string } = {}): FeedbackRow[] {
  if (filter.botId) {
    return ctx.db
      .query<FeedbackRow, [string]>(`SELECT * FROM route_feedback WHERE bot_id = ? ORDER BY created_at ASC, id ASC`)
      .all(filter.botId);
  }
  return ctx.db.query<FeedbackRow, []>(`SELECT * FROM route_feedback ORDER BY created_at ASC, id ASC`).all();
}

/** One Bot's accumulated experience; other Bots' rows never enter its decisions. */
export function routeLearnedState(ctx: StoreContext, botId: string): RouteLearnedState {
  const rows = ctx.db
    .query<LearnedRow, [string]>(
      `SELECT * FROM route_learned WHERE bot_id = ? ORDER BY signature, model, thinking_level`,
    )
    .all(botId);
  return {
    entries: rows.map((row) => ({
      signature: row.signature,
      model: row.model,
      thinkingLevel: row.thinking_level,
      negative: row.negative,
      positive: row.positive,
    })),
  };
}

/** A deleted Bot takes its experience with it. Decisions stay on the turns for the record. */
export function forgetBotRoutes(ctx: StoreContext, botId: string): void {
  ctx.db.run(`DELETE FROM route_learned WHERE bot_id = ?`, [botId]);
}

/**
 * A user follow-up that talks about the model itself becomes feedback on one earlier decision in
 * the same session. The decision it lands on, in order: the turn of the message being replied to;
 * the latest turn of the one Bot the message @-mentions; otherwise the latest turn any Bot ran
 * here. Only that Bot learns from it.
 */
export function collectRouteFeedback(
  ctx: StoreContext,
  message: { id: string; session_id: string; author: string; body: string; parent_id?: string | null },
): boolean {
  if (message.author !== USER_MEMBER) return false;
  if (!isCritiqueMessage(message.body)) return false;
  const already = ctx.db
    .query<{ id: string }, [string]>(`SELECT id FROM route_feedback WHERE message_id = ?`)
    .get(message.id);
  if (already) return false;
  const prior = attributeCritique(ctx, message);
  if (!prior) return false;
  const now = isoNow();
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO route_feedback (
         id, turn_id, message_id, bot_id, model, thinking_level, signature, body, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ulid(), prior.turn_id, message.id, prior.bot_id, prior.model, prior.thinking_level, prior.signature, message.body, now],
    );
    applyLearned(
      ctx,
      prior.bot_id,
      { signature: prior.signature, model: prior.model, thinkingLevel: prior.thinking_level },
      { negative: CRITIQUE_WEIGHT },
    );
  })();
  return true;
}

function attributeCritique(
  ctx: StoreContext,
  message: { id: string; session_id: string; body: string; parent_id?: string | null },
): DecisionRow | null {
  if (message.parent_id) {
    const parent = ctx.db
      .query<{ turn_id: string | null }, [string]>(`SELECT turn_id FROM messages WHERE id = ?`)
      .get(message.parent_id);
    if (parent?.turn_id) {
      const quoted = decisionRow(ctx, parent.turn_id);
      if (quoted) return quoted;
    }
  }
  const mentioned = mentionedBotIds(ctx, message.session_id, message.body);
  if (mentioned.length === 1) {
    const own = latestDecisionBefore(ctx, message.session_id, message.id, mentioned[0]!);
    if (own) return own;
  }
  return latestDecisionBefore(ctx, message.session_id, message.id, null);
}

function mentionedBotIds(ctx: StoreContext, sessionId: string, body: string): string[] {
  if (!body.includes("@")) return [];
  const present = ctx.db
    .query<{ id: string; name: string }, [string]>(
      `SELECT b.id, b.name FROM session_participants p
       JOIN bots b ON b.id = p.member
       WHERE p.session_id = ? AND p.left_at IS NULL AND b.deleted_at IS NULL`,
    )
    .all(sessionId);
  if (present.length === 0) return [];
  const names = present.map((row) => row.name);
  const parsed = parseMentions(body, names, { lenient: names });
  const byName = new Map(present.map((row) => [row.name, row.id]));
  return [...new Set(parsed.mentions.map((name) => byName.get(name)).filter((id): id is string => Boolean(id)))];
}

/**
 * The decision whose turn was most recently visible before `beforeMessageId`: the turn's own
 * transcript lines (reply, ask, approval, failure note) and its trigger all count as visibility,
 * so a turn still streaming is the one a "太慢" refers to, and a silent completed turn is still
 * found through its trigger.
 */
function latestDecisionBefore(
  ctx: StoreContext,
  sessionId: string,
  beforeMessageId: string,
  botId: string | null,
): DecisionRow | null {
  const sql = `
    SELECT d.*, MAX(m.rowid) AS pos
    FROM turn_route_decisions d
    JOIN messages m ON (m.turn_id = d.turn_id OR m.id = d.trigger_message_id)
    JOIN messages cur ON cur.id = ?
    WHERE d.session_id = ?
      AND m.session_id = d.session_id
      AND m.rowid < cur.rowid
      ${botId ? "AND d.bot_id = ?" : ""}
    GROUP BY d.turn_id
    ORDER BY pos DESC
    LIMIT 1`;
  const args = botId ? [beforeMessageId, sessionId, botId] : [beforeMessageId, sessionId];
  const row = ctx.db.query<DecisionRow & { pos: number }, string[]>(sql).get(...args);
  if (!row) return null;
  const { pos: _pos, ...decision } = row;
  return decision;
}

function decisionRow(ctx: StoreContext, turnId: string): DecisionRow | null {
  return ctx.db.query<DecisionRow, [string]>(`SELECT * FROM turn_route_decisions WHERE turn_id = ?`).get(turnId) ?? null;
}

function applyLearned(
  ctx: StoreContext,
  botId: string,
  key: { signature: string; model: string; thinkingLevel: string },
  signal: RouteSignal,
): void {
  ctx.db.run(
    `INSERT INTO route_learned (bot_id, signature, model, thinking_level, negative, positive, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bot_id, signature, model, thinking_level) DO UPDATE SET
       negative = route_learned.negative + excluded.negative,
       positive = route_learned.positive + excluded.positive,
       updated_at = excluded.updated_at`,
    [botId, key.signature, key.model, key.thinkingLevel, signal.negative ?? 0, signal.positive ?? 0, isoNow()],
  );
}

function toRecord(row: DecisionRow, feedback: FeedbackRow[]): RouteRecord {
  return {
    turn_id: row.turn_id,
    session_id: row.session_id,
    bot_id: row.bot_id,
    trigger_message_id: row.trigger_message_id,
    provider_id: row.provider_id,
    model: row.model,
    thinking_level: row.thinking_level as ThinkingLevel,
    signature: row.signature,
    outcome: row.outcome,
    fail_kind: row.fail_kind,
    created_at: row.created_at,
    finished_at: row.finished_at,
    feedback: feedback.map(
      (item): RouteFeedback => ({ message_id: item.message_id, body: item.body, created_at: item.created_at }),
    ),
  };
}
