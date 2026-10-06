/**
 * What a Bot wrote down to carry into later sessions.
 *
 * The shape follows `skills.ts` — per-Bot rows, hard caps, a case-insensitive unique handle —
 * with two deliberate differences. `subject` is an upsert key, not a 409: a memory is one
 * sentence and the newer version of a fact is the true one, so re-remembering a subject replaces
 * it. And a full memory is refused rather than evicted, because the cap is the only thing that
 * makes the Bot weigh what is worth keeping; nothing behind its back knows better.
 */
import { type Memory } from "@real-bot/protocol";
import { learningOutcome } from "./routing";
import { retrospectiveOrigin } from "./retrospective-origin";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { codePointCount } from "../text";
import { aliveBot, requireNonEmpty, type MemoryRow, type StoreContext } from "./shared";

export const MEMORY_SUBJECT_MAX = 40;
export const MEMORY_BODY_MAX = 160;
/** Enabled rows — what every hop of every turn pays for. */
export const MEMORY_MAX_PER_BOT = 20;
/** All rows. Only bites when a user parks a large pile of disabled ones. */
export const MEMORY_ROWS_PER_BOT = 64;

export function parseMemorySubject(value: unknown): string {
  const subject = requireNonEmpty("subject", value);
  if (codePointCount(subject) > MEMORY_SUBJECT_MAX) {
    throw new HttpError(422, "invalid_args", `subject must be at most ${MEMORY_SUBJECT_MAX} characters`);
  }
  return subject;
}

export function parseMemoryBody(value: unknown): string {
  const body = requireNonEmpty("body", value);
  if (codePointCount(body) > MEMORY_BODY_MAX) {
    throw new HttpError(422, "invalid_args", `body must be at most ${MEMORY_BODY_MAX} characters`);
  }
  return body;
}

/**
 * Fills the learning counts a snapshot shows, and which retrospective wrote the memory as it now
 * reads (ADR 0062). The prompt digest reads the row without them.
 */
export function withLearning(ctx: StoreContext, memory: Memory): Memory {
  const row = ctx.db
    .query<{ learned_chain_id: string | null; retrospective_id?: string | null }, [string]>(`SELECT * FROM memories WHERE id = ?`)
    .get(memory.id);
  const retrospective = retrospectiveOrigin(ctx, row?.retrospective_id);
  const withOrigin = retrospective ? { ...memory, retrospective } : memory;
  if (!row?.learned_chain_id) return withOrigin;
  const outcome = learningOutcome(ctx, { botId: memory.bot_id, chainId: row.learned_chain_id });
  return outcome ? { ...withOrigin, learning: outcome } : withOrigin;
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    bot_id: row.bot_id,
    subject: row.subject,
    body: row.body,
    source_session_id: row.source_session_id,
    source_message_id: row.source_message_id,
    learning: null,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listMemories(ctx: StoreContext, botId?: string): Memory[] {
  if (botId) {
    aliveBot(ctx, botId);
    return ctx.db
      .query<MemoryRow, [string]>(
        `SELECT * FROM memories WHERE bot_id = ? ORDER BY subject COLLATE NOCASE ASC, id ASC`,
      )
      .all(botId)
      .map(toMemory);
  }
  return ctx.db
    .query<MemoryRow, []>(`SELECT * FROM memories ORDER BY bot_id ASC, subject COLLATE NOCASE ASC, id ASC`)
    .all()
    .map(toMemory);
}

/**
 * Newest-written first: that is the order the prompt cuts by when the render budget bites.
 * The survivors are re-sorted by subject before rendering, so the text itself stays stable.
 */
export function listEnabledMemories(ctx: StoreContext, botId: string): Memory[] {
  return ctx.db
    .query<MemoryRow, [string]>(
      `SELECT * FROM memories WHERE bot_id = ? AND enabled = 1 ORDER BY updated_at DESC, id DESC`,
    )
    .all(botId)
    .map(toMemory);
}

export function getMemory(ctx: StoreContext, id: string): Memory {
  const row = ctx.db.query<MemoryRow, [string]>(`SELECT * FROM memories WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "memory not found");
  return toMemory(row);
}

export function findMemoryBySubject(ctx: StoreContext, botId: string, subject: string): Memory | null {
  const normalized = requireNonEmpty("subject", subject);
  const row = ctx.db
    .query<MemoryRow, [string, string]>(
      `SELECT * FROM memories WHERE bot_id = ? AND lower(subject) = lower(?) LIMIT 1`,
    )
    .get(botId, normalized);
  return row ? toMemory(row) : null;
}

/**
 * This Bot's other enabled memories written from one session since `since`, newest first. A
 * preference revised a few times in one conversation tends to come back under a new subject each
 * time instead of as an overwrite; a remember that opens a new subject is shown these.
 */
export function sessionMemoriesSince(
  ctx: StoreContext,
  input: { botId: string; sessionId: string; since: string; exceptId: string; limit?: number },
): Memory[] {
  return ctx.db
    .query<MemoryRow, [string, string, string, string, number]>(
      `SELECT * FROM memories
       WHERE bot_id = ? AND source_session_id = ? AND enabled = 1 AND updated_at >= ? AND id != ?
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(input.botId, input.sessionId, input.since, input.exceptId, input.limit ?? 5)
    .map(toMemory);
}

/** The subject that has gone longest without being rewritten — what a full Bot should drop first. */
export function stalestMemory(ctx: StoreContext, botId: string): Memory | null {
  const row = ctx.db
    .query<MemoryRow, [string]>(
      `SELECT * FROM memories WHERE bot_id = ? AND enabled = 1 ORDER BY updated_at ASC, id ASC LIMIT 1`,
    )
    .get(botId);
  return row ? toMemory(row) : null;
}

/**
 * Write a fact. Re-using a subject replaces that memory instead of adding a second one, which is
 * both how a Bot corrects itself and the main reason the cap is rarely reached.
 */
export function rememberMemory(
  ctx: StoreContext,
  input: {
    bot_id: string;
    subject: string;
    body: string;
    source_session_id?: string | null;
    source_message_id?: string | null;
    /** Set only by the learning hop. A turn's own remember leaves it null. */
    learned_chain_id?: string | null;
  },
): Memory {
  aliveBot(ctx, input.bot_id);
  const subject = parseMemorySubject(input.subject);
  const body = parseMemoryBody(input.body);
  const now = isoNow();
  const chain = input.learned_chain_id ?? null;
  const existing = findMemoryBySubject(ctx, input.bot_id, subject);
  if (existing) {
    // Rewritten in a turn, it is no longer what a retrospective wrote (ADR 0062).
    ctx.db.run(
      `UPDATE memories SET subject = ?, body = ?, source_session_id = ?, source_message_id = ?,
         learned_chain_id = ?, retrospective_id = NULL, updated_at = ?
       WHERE id = ?`,
      [subject, body, input.source_session_id ?? null, input.source_message_id ?? null, chain, now, existing.id],
    );
    return getMemory(ctx, existing.id);
  }
  assertMemoryRowCapacity(ctx, input.bot_id);
  assertMemoryCapacity(ctx, input.bot_id);
  const id = ulid();
  ctx.db.run(
    `INSERT INTO memories
       (id, bot_id, subject, body, source_session_id, source_message_id, learned_chain_id, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      input.bot_id,
      subject,
      body,
      input.source_session_id ?? null,
      input.source_message_id ?? null,
      chain,
      now,
      now,
    ],
  );
  return getMemory(ctx, id);
}

/** The user's correction path. Only they toggle `enabled`; the Bot has no such tool. */
export function patchMemory(
  ctx: StoreContext,
  id: string,
  patch: Partial<{ subject: string; body: string; enabled: boolean }>,
): Memory {
  const current = ctx.db.query<MemoryRow, [string]>(`SELECT * FROM memories WHERE id = ?`).get(id);
  if (!current) throw new HttpError(404, "not_found", "memory not found");
  const subject = patch.subject !== undefined ? parseMemorySubject(patch.subject) : current.subject;
  const body = patch.body !== undefined ? parseMemoryBody(patch.body) : current.body;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
  if (subject.toLowerCase() !== current.subject.toLowerCase()) {
    const clash = findMemoryBySubject(ctx, current.bot_id, subject);
    if (clash && clash.id !== id) {
      throw new HttpError(409, "conflict", "that subject already has a memory");
    }
  }
  // Your words now, not a retrospective's: its tag goes once the text changes (ADR 0062).
  const rewritten = subject !== current.subject || body !== current.body;
  ctx.db.run(`UPDATE memories SET subject = ?, body = ?, enabled = ?, updated_at = ?${rewritten ? ", retrospective_id = NULL" : ""} WHERE id = ?`, [
    subject,
    body,
    enabled,
    isoNow(),
    id,
  ]);
  return getMemory(ctx, id);
}

export function deleteMemory(ctx: StoreContext, id: string): void {
  const deleted = ctx.db.query("DELETE FROM memories WHERE id = ? RETURNING id").get(id);
  if (!deleted) throw new HttpError(404, "not_found", "memory not found");
}

/**
 * A full Bot is told which memory has gone longest without being rewritten, so the next hop can
 * drop that one rather than guess. Nothing is evicted behind its back.
 */
export function assertMemoryCapacity(ctx: StoreContext, botId: string): void {
  const row = ctx.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM memories WHERE bot_id = ? AND enabled = 1`,
    )
    .get(botId);
  if ((row?.n ?? 0) < MEMORY_MAX_PER_BOT) return;
  const stalest = stalestMemory(ctx, botId);
  const hint = stalest ? ` The one longest without an update is "${stalest.subject}".` : "";
  throw new HttpError(
    422,
    "failed",
    `a bot can have at most ${MEMORY_MAX_PER_BOT} memories; forget one first.${hint}`,
  );
}

export function assertMemoryRowCapacity(ctx: StoreContext, botId: string): void {
  const row = ctx.db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM memories WHERE bot_id = ?`)
    .get(botId);
  if ((row?.n ?? 0) >= MEMORY_ROWS_PER_BOT) {
    throw new HttpError(422, "failed", `a bot can hold at most ${MEMORY_ROWS_PER_BOT} memories in total`);
  }
}

/** A deleted Bot takes its memories with it, the way it takes its route conclusions (ADR 0018). */
export function forgetBotMemories(ctx: StoreContext, botId: string): void {
  ctx.db.run(`DELETE FROM memories WHERE bot_id = ?`, [botId]);
}
