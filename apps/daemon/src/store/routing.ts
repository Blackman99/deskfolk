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
 *
 * Closing a turn also writes how the work went — hops, tool calls, tool errors, repeated
 * failures, files written. Those counts are null when the process stopped before it could count,
 * and a review treats null as unknown rather than as a clean run.
 */
import { USER_MEMBER, type RouteFeedback, type RouteOutcome, type RouteRecord, type RouteReviewEffect, type ThinkingLevel } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { parseMentions } from "../mentions";
import { candidateRows, decideCompletion, type CatalogEntry, type RouteDecision } from "../route-decision";
import { REVIEW_CONFIDENCE_FLOOR, type RouteReviewVerdict } from "../route-agent";
import { chainIsCleaner, choiceFollowed, shouldRetire, taskIsShorter, type ChainWork, type ReviewSubject } from "../route-learning";
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
  hops: number | null;
  tool_calls: number | null;
  tool_errors: number | null;
  repeated_failures: number | null;
  files_written: number | null;
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

/** Counts the engine kept while the turn ran. Absent means the process never got to count. */
export type TurnExecution = {
  hops: number;
  toolCalls: number;
  toolErrors: number;
  repeatedFailures: number;
  filesWritten: number;
};

/**
 * Closes the turn's decision with its outcome. The first outcome wins: a turn that failed is closed
 * as `failed` by the engine before its status flips to `completed`, so the later status hook does
 * not overwrite it with a success. Nothing is learned here — a completion failure is one input the
 * review weighs, not a score on its own.
 *
 * `execution` is written in the same update. A close that has no counts (a turn the engine was not
 * running, or a process that died first) leaves the columns null.
 */
export function finishTurnRoute(
  ctx: StoreContext,
  turnId: string,
  outcome: RouteOutcome,
  failKind: string | null = null,
  execution: TurnExecution | null = null,
): void {
  const row = decisionRow(ctx, turnId);
  if (!row || row.outcome) return;
  ctx.db.run(
    `UPDATE turn_route_decisions
     SET outcome = ?, fail_kind = ?, finished_at = ?,
         hops = ?, tool_calls = ?, tool_errors = ?, repeated_failures = ?, files_written = ?
     WHERE turn_id = ? AND outcome IS NULL`,
    [
      outcome,
      outcome === "failed" ? failKind : null,
      isoNow(),
      execution?.hops ?? null,
      execution?.toolCalls ?? null,
      execution?.toolErrors ?? null,
      execution?.repeatedFailures ?? null,
      execution?.filesWritten ?? null,
      turnId,
    ],
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
  return withFeedback(rows, feedback);
}

/**
 * Every decision a job's turns ran on, oldest first, each with the critiques it drew. A job spans
 * sessions — a handoff into a Bot↔Bot direct is still the same job — so this goes by the turns'
 * job, not by any one session.
 */
export function listTaskRoutes(ctx: StoreContext, taskId: string): RouteRecord[] {
  const rows = ctx.db
    .query<DecisionRow, [string]>(
      `SELECT d.* FROM turn_route_decisions d
       JOIN turns t ON t.id = d.turn_id
       WHERE t.task_id = ?
       ORDER BY d.created_at ASC, d.turn_id ASC`,
    )
    .all(taskId);
  if (rows.length === 0) return [];
  const feedback = ctx.db
    .query<FeedbackRow, [string]>(
      `SELECT f.* FROM route_feedback f
       JOIN turns t ON t.id = f.turn_id
       WHERE t.task_id = ?
       ORDER BY f.created_at ASC, f.id ASC`,
    )
    .all(taskId);
  return withFeedback(rows, feedback);
}

function withFeedback(rows: DecisionRow[], feedback: FeedbackRow[]): RouteRecord[] {
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
  retired_at: string | null;
};

/**
 * What this Bot has learned the hard way, newest first, as conclusions rather than scores. The
 * picker reads them and weighs them itself; nothing here adds, decays or caps a number.
 */
export function recentRouteReviews(ctx: StoreContext, botId: string, limit = 12): RouteReviewRow[] {
  return ctx.db
    .query<RouteReviewRow, [string, number, number]>(
      `SELECT * FROM route_reviews
       WHERE bot_id = ? AND fault = 'model' AND confidence >= ? AND retired_at IS NULL
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

/** Every verdict on a chain one of this job's turns started, for the flow board. Nothing filtered. */
export function listTaskReviews(ctx: StoreContext, taskId: string): RouteReviewRow[] {
  return ctx.db
    .query<RouteReviewRow, [string]>(
      `SELECT r.* FROM route_reviews r
       JOIN turns t ON t.id = r.turn_id
       WHERE t.task_id = ?
       ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(taskId);
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

/**
 * Recent finishes the picker can treat as "this kind of message already worked at this size":
 * completed, no tool errors, no user follow-up, at most one per message kind, newest first.
 */
export function cleanCompletions(
  ctx: StoreContext,
  botId: string,
  limit = 4,
): { message: string; signature: string; model: string; thinkingLevel: string }[] {
  const rows = ctx.db
    .query<DecisionRow, [string]>(
      `SELECT * FROM turn_route_decisions
       WHERE bot_id = ? AND outcome = 'completed' AND tool_errors = 0
       ORDER BY created_at DESC, turn_id DESC`,
    )
    .all(botId);
  const seen = new Set<string>();
  const out: { message: string; signature: string; model: string; thinkingLevel: string }[] = [];
  for (const row of rows) {
    if (seen.has(row.signature) || out.length >= limit) continue;
    const followed = ctx.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM route_feedback WHERE turn_id = ?`)
      .get(row.turn_id);
    if ((followed?.n ?? 0) > 0) continue;
    const message = ctx.db
      .query<{ body: string }, [string]>(`SELECT body FROM messages WHERE id = ?`)
      .get(row.trigger_message_id);
    if (!message) continue;
    seen.add(row.signature);
    out.push({
      message: message.body,
      signature: row.signature,
      model: row.model,
      thinkingLevel: row.thinking_level,
    });
  }
  return out;
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
       fault, direction, rounds, confidence, reason, created_at, retired_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
  // The new conclusion is itself the "later choice" for the one it follows.
  weighOpenReviews(ctx, input.botId);
}

/**
 * Recomputes, for this Bot, whether each still-active model conclusion was followed by a later
 * same-kind choice the routing agent actually made, and whether that work was cleaner. Two follows
 * that were not cleaner retire it. A choice the rules made (no agent reason) is unknown: a pinned
 * Bot, or a fallback, did not follow the conclusion.
 */
export function weighOpenReviews(ctx: StoreContext, botId: string): void {
  const reviews = ctx.db
    .query<RouteReviewRow, [string, number]>(
      `SELECT * FROM route_reviews
       WHERE bot_id = ? AND fault = 'model' AND confidence >= ? AND retired_at IS NULL
       ORDER BY created_at ASC, id ASC`,
    )
    .all(botId, REVIEW_CONFIDENCE_FLOOR);
  if (reviews.length === 0) return;
  const works = chainWorks(ctx, botId);
  const now = isoNow();
  for (const review of reviews) {
    const followed = laterWorks(review, works).map((work) => ({
      followed: work.agentPicked
        ? choiceFollowed(subjectOf(review, works), followedChoice(ctx, review, work))
        : ("unknown" as const),
      cleaner: chainIsCleaner(subjectOf(review, works), work),
    }));
    if (shouldRetire(followed)) {
      ctx.db.run(`UPDATE route_reviews SET retired_at = ? WHERE id = ? AND retired_at IS NULL`, [
        now,
        review.id,
      ]);
    }
  }
}

/**
 * Chains of the same kind that started after the reviewed chain. Compared on the chain's own
 * start, not the review row's time: the turn that closes a chain is recorded before the review
 * call comes back.
 */
function laterWorks(
  review: RouteReviewRow,
  works: readonly ChainWorkRow[],
): ChainWorkRow[] {
  const own = works.find((work) => work.chainId === review.chain_id);
  const after = own?.createdAt ?? review.created_at;
  return works.filter(
    (work) =>
      work.chainId !== review.chain_id &&
      work.signature === review.signature &&
      work.createdAt > after,
  );
}

function subjectOf(review: RouteReviewRow, works: readonly ChainWorkRow[]): ReviewSubject {
  const own = works.find((work) => work.chainId === review.chain_id);
  return {
    chainId: review.chain_id,
    signature: review.signature,
    model: review.model,
    thinkingLevel: review.thinking_level,
    direction: review.direction as ReviewSubject["direction"],
    rounds: own?.rounds ?? review.rounds,
    toolErrors: own?.toolErrors ?? null,
  };
}

function followedChoice(
  ctx: StoreContext,
  review: RouteReviewRow,
  work: ChainWork,
): { model: string; thinkingLevel: string; price: number | null; reviewedPrice: number | null } {
  const priceOf = (model: string): number | null => {
    const rows = catalogEntries(ctx).filter((row) => row.name === model);
    const priced = rows.find((row) => row.price !== null);
    return priced?.price ?? null;
  };
  return {
    model: work.model,
    thinkingLevel: work.thinkingLevel,
    price: priceOf(work.model),
    reviewedPrice: priceOf(review.model),
  };
}

/**
 * One row per chain this Bot has closed, oldest first: the model its first turn ran, and the
 * summed execution of every turn in it.
 */
type ChainWorkRow = ChainWork & { createdAt: string; agentPicked: boolean };

function chainWorks(ctx: StoreContext, botId: string): ChainWorkRow[] {
  const decisions = ctx.db
    .query<DecisionRow, [string]>(
      `SELECT * FROM turn_route_decisions
       WHERE bot_id = ? AND chain_id IS NOT NULL
       ORDER BY created_at ASC, turn_id ASC`,
    )
    .all(botId);
  const byChain = new Map<string, DecisionRow[]>();
  for (const row of decisions) {
    const list = byChain.get(row.chain_id!) ?? [];
    list.push(row);
    byChain.set(row.chain_id!, list);
  }
  const out: ChainWorkRow[] = [];
  for (const [chainId, rows] of byChain) {
    const head = rows[0]!;
    const execution = executionOf(rows, null);
    const followUps = ctx.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM route_feedback WHERE turn_id IN (
           SELECT turn_id FROM turn_route_decisions WHERE chain_id = ?
         )`,
      )
      .get(chainId);
    out.push({
      chainId,
      signature: head.signature,
      model: head.model,
      thinkingLevel: head.thinking_level,
      hops: execution.hops,
      toolErrors: execution.toolErrors,
      rounds: followUps?.n ?? 0,
      hardFailed: rows.some((row) => row.outcome === "failed" && (row.fail_kind === "refused" || row.fail_kind === "incomplete")),
      createdAt: head.created_at,
      agentPicked: Boolean(head.reason?.trim()),
    });
  }
  return out;
}

/** The next same-kind chain after a review, and whether it followed and got cleaner. */
export function reviewEffect(
  ctx: StoreContext,
  review: RouteReviewRow,
): { followed: RouteReviewEffect; cleaner: boolean } | null {
  const works = chainWorks(ctx, review.bot_id);
  const later = laterWorks(review, works)[0];
  if (!later) return null;
  const subject = subjectOf(review, works);
  return {
    followed: later.agentPicked
      ? choiceFollowed(subject, followedChoice(ctx, review, later))
      : "unknown",
    cleaner: chainIsCleaner(subject, later),
  };
}

/** A deleted Bot takes its conclusions with it. Decisions stay on the turns for the record. */
export function forgetBotRoutes(ctx: StoreContext, botId: string): void {
  ctx.db.run(`DELETE FROM route_reviews WHERE bot_id = ?`, [botId]);
  ctx.db.run(`DELETE FROM route_learnings WHERE bot_id = ?`, [botId]);
}

export type RouteLearningRow = {
  chain_id: string;
  bot_id: string;
  session_id: string;
  kind: "memory" | "skill" | "none";
  label: string;
  created_at: string;
};

/** What the learning hop wrote for one chain. A second note for the same chain is ignored. */
export function recordRouteLearning(
  ctx: StoreContext,
  input: { chainId: string; botId: string; sessionId: string; kind: RouteLearningRow["kind"]; label: string },
): void {
  ctx.db.run(
    `INSERT INTO route_learnings (chain_id, bot_id, session_id, kind, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain_id) DO NOTHING`,
    [input.chainId, input.botId, input.sessionId, input.kind, input.label, isoNow()],
  );
}

/**
 * How the same kind of task went after a learning hop wrote this memory or skill. Chains the hop
 * did not count, and chains of another kind, are left out. Zero later chains is "no later task yet".
 */
export function learningOutcome(
  ctx: StoreContext,
  input: { botId: string; chainId: string },
): { later: number; shorter: number } | null {
  const works = chainWorks(ctx, input.botId);
  const own = works.find((work) => work.chainId === input.chainId);
  if (!own) return null;
  const later = works.filter(
    (work) => work.chainId !== own.chainId && work.signature === own.signature && work.createdAt > own.createdAt,
  );
  return {
    later: later.length,
    shorter: later.filter((work) =>
      taskIsShorter(
        { hops: own.hops, toolErrors: own.toolErrors },
        { hops: work.hops, toolErrors: work.toolErrors },
      ),
    ).length,
  };
}

/** Every learning note in a session, oldest first. */
export function listSessionLearnings(ctx: StoreContext, sessionId: string): RouteLearningRow[] {
  return ctx.db
    .query<RouteLearningRow, [string]>(
      `SELECT * FROM route_learnings WHERE session_id = ? ORDER BY created_at ASC, chain_id ASC`,
    )
    .all(sessionId);
}

/** Every learning note for a chain one of this job's turns started. A chain's id is that turn's. */
export function listTaskLearnings(ctx: StoreContext, taskId: string): RouteLearningRow[] {
  return ctx.db
    .query<RouteLearningRow, [string]>(
      `SELECT l.* FROM route_learnings l
       JOIN turns t ON t.id = l.chain_id
       WHERE t.task_id = ?
       ORDER BY l.created_at ASC, l.chain_id ASC`,
    )
    .all(taskId);
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
  /** Summed across the chain. Null when any turn was never counted. */
  execution: {
    hops: number | null;
    toolCalls: number | null;
    toolErrors: number | null;
    repeatedFailures: number | null;
    filesWritten: number | null;
    failKind: string | null;
    costUsdTicks: number | null;
  };
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
  const spend = ctx.db
    .query<{ cost: number | null }, string[]>(
      `SELECT SUM(cost_usd_ticks) AS cost FROM spend WHERE turn_id IN (${placeholders}) AND kind = 'turn'`,
    )
    .get(...turnIds);
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
    execution: executionOf(rows, spend?.cost ?? null),
  };
}

/** Sums the counted columns. One uncounted turn makes the sum unknown rather than a partial zero. */
function executionOf(
  rows: readonly DecisionRow[],
  costUsdTicks: number | null,
): ChainForReview["execution"] {
  const sum = (pick: (row: DecisionRow) => number | null): number | null => {
    let total = 0;
    for (const row of rows) {
      const value = pick(row);
      if (value === null) return null;
      total += value;
    }
    return total;
  };
  const failed = [...rows].reverse().find((row) => row.outcome === "failed");
  return {
    hops: sum((row) => row.hops),
    toolCalls: sum((row) => row.tool_calls),
    toolErrors: sum((row) => row.tool_errors),
    repeatedFailures: sum((row) => row.repeated_failures),
    filesWritten: sum((row) => row.files_written),
    failKind: failed?.fail_kind ?? null,
    costUsdTicks,
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
    hops: row.hops,
    tool_calls: row.tool_calls,
    tool_errors: row.tool_errors,
    repeated_failures: row.repeated_failures,
    files_written: row.files_written,
    feedback: feedback.map(
      (item): RouteFeedback => ({ message_id: item.message_id, body: item.body, created_at: item.created_at }),
    ),
  };
}
