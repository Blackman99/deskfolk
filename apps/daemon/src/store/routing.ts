/**
 * Model choice per turn, and the record a Bot keeps of when a choice turned out wrong.
 *
 * A turn gets one decision (model + thinking level, picked by the routing agent or by the rules
 * when that call is unusable), written down with the Bot and endpoint it belonged to and closed
 * with how the turn ended. Decisions the user kept pushing back on share a `chain_id`: a correction
 * chain. Every user follow-up attributed to a chain is kept verbatim — no keyword decides what
 * counts, because «这里不对» and «还是不行» never matched one.
 *
 * When the chain closes, the engine has it reviewed and the verdict lands in `route_reviews`.
 * Only a verdict that blames the model is kept, and it is kept as a conclusion, not a score: the
 * next pick reads the recent ones and weighs them itself.
 */
import { USER_MEMBER, type RouteFeedback, type RouteOutcome, type RouteRecord, type ThinkingLevel } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { parseMentions } from "../mentions";
import { candidateRows, decideCompletion, type CatalogEntry, type RouteDecision } from "../route-decision";
import { REVIEW_CONFIDENCE_FLOOR, type RouteReviewVerdict } from "../route-agent";
import { catalogEntries } from "./providers";
import { defaultProviderId, providerRows, type StoreContext, type TurnRow } from "./shared";

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
  reason: string | null;
  chain_id: string | null;
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
  });
}

/**
 * Writes the decision a turn ran on; the Bot, session and trigger come from the turn itself.
 *
 * `continuesPrevious` decides whether this turn joins the Bot's open correction chain here or
 * starts a new one. A turn the rules picked (no agent answer) always starts a new chain: nothing
 * judged it to be about the same thing.
 */
export function recordTurnRoute(
  ctx: StoreContext,
  input: {
    turnId: string;
    decision: RouteDecision;
    reason?: string | null;
    continuesPrevious?: boolean;
  },
): void {
  const turn = ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(input.turnId);
  if (!turn) return;
  const open = input.continuesPrevious ? openChain(ctx, turn.session_id, turn.bot_id) : null;
  ctx.db.run(
    `INSERT INTO turn_route_decisions (
       turn_id, session_id, bot_id, trigger_message_id, provider_id, model, thinking_level, signature,
       reason, chain_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.reason?.trim() || null,
      open ?? input.turnId,
      isoNow(),
    ],
  );
}

/**
 * The chain a Bot still has open in this session: the most recent decision that no review has
 * closed yet. A reviewed chain is finished, so the next turn opens a fresh one. `notBefore` keeps
 * a chain nobody has touched in a long time out of it — neither joined nor reviewed.
 */
export function openChain(
  ctx: StoreContext,
  sessionId: string,
  botId: string,
  notBefore?: string,
): string | null {
  const row = ctx.db
    .query<{ chain_id: string | null }, [string, string, string]>(
      `SELECT d.chain_id FROM turn_route_decisions d
       WHERE d.session_id = ? AND d.bot_id = ?
         AND d.chain_id IS NOT NULL
         AND d.created_at >= ?
         AND NOT EXISTS (SELECT 1 FROM route_reviews r WHERE r.chain_id = d.chain_id)
       ORDER BY d.created_at DESC, d.turn_id DESC
       LIMIT 1`,
    )
    .get(sessionId, botId, notBefore ?? "");
  return row?.chain_id ?? null;
}

/**
 * Chains left open by a daemon that stopped before their quiet timer fired. The timers live in
 * memory, so a restart would otherwise leave a correction chain unreviewed until the user happens
 * to change the subject. `notBefore` bounds how far back a restart digs: a chain nobody has touched
 * in a long time is not worth paying a completion for.
 */
export function staleOpenChains(
  ctx: StoreContext,
  input: { quietBefore: string; notBefore: string; limit?: number },
): string[] {
  return ctx.db
    .query<{ chain_id: string }, [string, string, string, number]>(
      `SELECT d.chain_id AS chain_id, MAX(COALESCE(f.created_at, d.created_at)) AS last_at
       FROM turn_route_decisions d
       LEFT JOIN route_feedback f ON f.turn_id = d.turn_id
       WHERE d.chain_id IS NOT NULL
         AND d.created_at >= ?
         AND NOT EXISTS (SELECT 1 FROM route_reviews r WHERE r.chain_id = d.chain_id)
       GROUP BY d.chain_id
       HAVING last_at < ? AND last_at >= ?
       ORDER BY last_at DESC
       LIMIT ?`,
    )
    .all(input.notBefore, input.quietBefore, input.notBefore, input.limit ?? 20)
    .map((row) => row.chain_id);
}

/**
 * Closes the turn's decision with its outcome. The first outcome wins: a turn that failed is closed
 * as `failed` by the engine before its status flips to `completed`, so the later status hook does
 * not overwrite it with a success. Nothing is learned here — a completion failure is one input the
 * review weighs, not a score on its own.
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
export type RouteReviewRow = {
  id: string;
  bot_id: string;
  chain_id: string;
  turn_id: string;
  session_id: string;
  signature: string;
  model: string;
  thinking_level: string;
  fault: string;
  direction: string;
  rounds: number;
  confidence: number;
  reason: string;
  created_at: string;
};

/**
 * What this Bot has learned the hard way, newest first, as conclusions rather than scores. The
 * picker reads them and weighs them itself; nothing here adds, decays or caps a number.
 */
export function recentRouteReviews(ctx: StoreContext, botId: string, limit = 12): RouteReviewRow[] {
  return ctx.db
    .query<RouteReviewRow, [string, number, number]>(
      `SELECT * FROM route_reviews
       WHERE bot_id = ? AND fault = 'model' AND confidence >= ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(botId, REVIEW_CONFIDENCE_FLOOR, limit);
}

/** Every verdict in a session, for the log. Unlike the picker's read, nothing is filtered out. */
export function listSessionReviews(ctx: StoreContext, sessionId: string): RouteReviewRow[] {
  return ctx.db
    .query<RouteReviewRow, [string]>(
      `SELECT * FROM route_reviews WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId);
}

/** Which Bot a follow-up was filed against, so the engine knows whose chain to keep alive. */
export function feedbackOwner(ctx: StoreContext, messageId: string): string | null {
  const row = ctx.db
    .query<{ bot_id: string }, [string]>(`SELECT bot_id FROM route_feedback WHERE message_id = ?`)
    .get(messageId);
  return row?.bot_id ?? null;
}

/** The Bot's last decision anywhere, so the picker can say whether this message continues it. */
export function previousDecisionFor(
  ctx: StoreContext,
  botId: string,
): { message: string; model: string; thinkingLevel: string } | null {
  const row = ctx.db
    .query<{ trigger_message_id: string; model: string; thinking_level: string }, [string]>(
      `SELECT trigger_message_id, model, thinking_level FROM turn_route_decisions
       WHERE bot_id = ? ORDER BY created_at DESC, turn_id DESC LIMIT 1`,
    )
    .get(botId);
  if (!row) return null;
  const message = ctx.db
    .query<{ body: string }, [string]>(`SELECT body FROM messages WHERE id = ?`)
    .get(row.trigger_message_id);
  if (!message) return null;
  return { message: message.body, model: row.model, thinkingLevel: row.thinking_level };
}

/** The models this turn may pick from, as the routing agent is shown them. */
export function routeCandidates(
  ctx: StoreContext,
  input: { botModel: string | null; botProviderId: string | null; providerIds?: readonly string[] },
): CatalogEntry[] {
  const catalog = catalogEntries(ctx).filter((row) =>
    input.providerIds ? input.providerIds.includes(row.providerId) : true,
  );
  return candidateRows({
    catalog,
    botModel: input.botModel,
    botProviderId: input.botProviderId,
    defaultProviderId: defaultProviderId(ctx) ?? providerRows(ctx)[0]?.id ?? null,
  });
}

/** Records one closed chain's verdict. A chain is reviewed once; a second verdict is ignored. */
export function recordRouteReview(
  ctx: StoreContext,
  input: {
    botId: string;
    chainId: string;
    turnId: string;
    sessionId: string;
    signature: string;
    model: string;
    thinkingLevel: string;
    verdict: RouteReviewVerdict;
  },
): void {
  ctx.db.run(
    `INSERT INTO route_reviews (
       id, bot_id, chain_id, turn_id, session_id, signature, model, thinking_level,
       fault, direction, rounds, confidence, reason, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain_id) DO NOTHING`,
    [
      ulid(),
      input.botId,
      input.chainId,
      input.turnId,
      input.sessionId,
      input.signature,
      input.model,
      input.thinkingLevel,
      input.verdict.fault,
      input.verdict.direction,
      input.verdict.rounds,
      input.verdict.confidence,
      input.verdict.reason,
      isoNow(),
    ],
  );
}

/** A deleted Bot takes its conclusions with it. Decisions stay on the turns for the record. */
export function forgetBotRoutes(ctx: StoreContext, botId: string): void {
  ctx.db.run(`DELETE FROM route_reviews WHERE bot_id = ?`, [botId]);
}

/**
 * Every user follow-up is kept against the decision it is answering — no keyword decides what
 * counts. «这里不对» and «还是不行» never matched a pattern, and «@导演 你 @ 的分镜不对» matched one
 * it had no business matching. Whether any of it was the model's fault is the review's call, and
 * the review can only make it if the words are all still here.
 *
 * The decision it lands on, in order: the turn of the message being replied to; the latest turn of
 * the one Bot the message @-mentions; otherwise the latest turn any Bot ran here.
 */
export function collectRouteFeedback(
  ctx: StoreContext,
  message: { id: string; session_id: string; author: string; body: string; parent_id?: string | null },
): boolean {
  if (message.author !== USER_MEMBER) return false;
  if (!message.body.trim()) return false;
  const already = ctx.db
    .query<{ id: string }, [string]>(`SELECT id FROM route_feedback WHERE message_id = ?`)
    .get(message.id);
  if (already) return false;
  const prior = attributeCritique(ctx, message);
  if (!prior) return false;
  ctx.db.run(
    `INSERT INTO route_feedback (
       id, turn_id, message_id, bot_id, model, thinking_level, signature, body, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ulid(), prior.turn_id, message.id, prior.bot_id, prior.model, prior.thinking_level, prior.signature, message.body, isoNow()],
  );
  return true;
}

/** Everything one closed chain gives the reviewer: what ran, what it answered, what came back. */
export type ChainForReview = {
  chainId: string;
  botId: string;
  sessionId: string;
  turnId: string;
  triggerMessage: string;
  model: string;
  thinkingLevel: string;
  signature: string;
  outcome: string;
  reply: string;
  followUps: string[];
};

/**
 * Reads a chain back for review: the decision that started it, the reply the user actually saw, and
 * every follow-up across the whole chain in order.
 */
export function chainForReview(ctx: StoreContext, chainId: string): ChainForReview | null {
  const rows = ctx.db
    .query<DecisionRow, [string]>(
      `SELECT * FROM turn_route_decisions WHERE chain_id = ? ORDER BY created_at ASC, turn_id ASC`,
    )
    .all(chainId);
  const head = rows[0];
  if (!head) return null;
  const trigger = ctx.db
    .query<{ body: string }, [string]>(`SELECT body FROM messages WHERE id = ?`)
    .get(head.trigger_message_id);
  const reply = ctx.db
    .query<{ body: string }, [string]>(
      `SELECT body FROM messages WHERE turn_id = ? AND kind = 'bot' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(head.turn_id);
  const turnIds = rows.map((row) => row.turn_id);
  const placeholders = turnIds.map(() => "?").join(", ");
  const followUps = ctx.db
    .query<{ body: string }, string[]>(
      `SELECT body FROM route_feedback WHERE turn_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    )
    .all(...turnIds);
  return {
    chainId,
    botId: head.bot_id,
    sessionId: head.session_id,
    turnId: head.turn_id,
    triggerMessage: trigger?.body ?? "",
    model: head.model,
    thinkingLevel: head.thinking_level,
    signature: head.signature,
    outcome: head.outcome ?? "running",
    reply: reply?.body ?? "",
    followUps: followUps.map((row) => row.body),
  };
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
    reason: row.reason,
    chain_id: row.chain_id,
    created_at: row.created_at,
    finished_at: row.finished_at,
    feedback: feedback.map(
      (item): RouteFeedback => ({ message_id: item.message_id, body: item.body, created_at: item.created_at }),
    ),
  };
}
