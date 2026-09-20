import { INTERRUPT_NOTE_BODY, type RouteOutcome, type Turn } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { getMessage } from "./messages";
import { finishTurnRoute } from "./routing";
import { isPresent } from "./sessions";
import {
  aliveBot,
  isLive,
  messageRow,
  sessionRow,
  setSetting,
  toTurn,
  touchSession,
  type SettingRow,
  type StoreContext,
  type TurnRow,
} from "./shared";

export function createTurn(
  ctx: StoreContext,
  input: { sessionId: string; botId: string; triggerMessageId: string },
): Turn {
  sessionRow(ctx, input.sessionId);
  aliveBot(ctx, input.botId);
  messageRow(ctx, input.triggerMessageId);
  const now = isoNow();
  const id = ulid();
  ctx.db.run(
    `INSERT INTO turns
      (id, session_id, bot_id, status, trigger_message_id, last_activity_at, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    [id, input.sessionId, input.botId, input.triggerMessageId, now, now, now],
  );
  return getTurn(ctx, id);
}

export function getTurn(ctx: StoreContext, id: string): Turn {
  const row = ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "turn not found");
  return toTurn(row);
}

export function listLiveTurns(
  ctx: StoreContext,
  filter: { sessionId?: string; botId?: string } = {},
): Turn[] {
  let sql = `SELECT * FROM turns WHERE status IN ('running', 'waiting_approval', 'waiting_ask')`;
  const args: string[] = [];
  if (filter.sessionId) {
    sql += ` AND session_id = ?`;
    args.push(filter.sessionId);
  }
  if (filter.botId) {
    sql += ` AND bot_id = ?`;
    args.push(filter.botId);
  }
  sql += ` ORDER BY last_activity_at DESC, id DESC`;
  return ctx.db.query<TurnRow, string[]>(sql).all(...args).map((row) => toTurn(row));
}

export function setTurnStatus(ctx: StoreContext, id: string, status: Turn["status"]): Turn {
  const row = ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "turn not found");
  const now = isoNow();
  ctx.db.run(
    `UPDATE turns SET status = ?, last_activity_at = ?, updated_at = ? WHERE id = ?`,
    [status, now, now, id],
  );
  const outcome = outcomeFor(status);
  if (outcome) finishTurnRoute(ctx, id, outcome);
  return getTurn(ctx, id);
}

/** Terminal turn statuses map one-to-one onto route outcomes; live statuses close nothing. */
function outcomeFor(status: Turn["status"]): RouteOutcome | null {
  switch (status) {
    case "completed":
    case "redirected":
    case "interrupted":
    case "stopped":
      return status;
    default:
      return null;
  }
}

export function setTurnPartial(ctx: StoreContext, id: string, partial: string | null): void {
  ctx.db.run("UPDATE turns SET partial_text = ? WHERE id = ? AND status IN ('running', 'waiting_approval', 'waiting_ask') AND partial_text IS NOT ?", [partial, id, partial]);
}

export function touchTurn(ctx: StoreContext, id: string): Turn {
  const now = isoNow();
  ctx.db.run(`UPDATE turns SET last_activity_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
  return getTurn(ctx, id);
}

export function redirectTurn(ctx: StoreContext, id: string): Turn {
  const row = ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "turn not found");
  if (!isLive(row.status)) return toTurn(row);
  const now = isoNow();
  ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE turns SET status = 'redirected', last_activity_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
    ctx.db.run(
      `UPDATE approvals SET status = 'voided', resolved_at = ? WHERE turn_id = ? AND status = 'pending'`,
      [now, id],
    );
    finishTurnRoute(ctx, id, "redirected");
  })();
  return getTurn(ctx, id);
}

export function pendingInterrupt(ctx: StoreContext, botId: string): boolean {
  return pendingInterruptSet(ctx).has(botId);
}

export function markInterruptPending(ctx: StoreContext, botId: string): void {
  const set = pendingInterruptSet(ctx);
  set.add(botId);
  writePendingInterrupts(ctx, set);
}

export function clearInterruptPending(ctx: StoreContext, botId: string): void {
  const set = pendingInterruptSet(ctx);
  if (!set.delete(botId)) return;
  writePendingInterrupts(ctx, set);
}

export function recoverInterruptedTurns(ctx: StoreContext): void {
  interruptRunningTurns(ctx);
}

export function stopTurn(
  ctx: StoreContext,
  turnId?: string,
  opts: { allowGroup?: boolean } = {},
): Turn | null {
  const row = turnId
    ? ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(turnId)
    : ctx.db
        .query<TurnRow, []>(
          opts.allowGroup
            ? `SELECT * FROM turns
               WHERE status IN ('running', 'waiting_approval', 'waiting_ask')
               ORDER BY last_activity_at DESC LIMIT 1`
            : `SELECT t.* FROM turns t
               JOIN sessions s ON s.id = t.session_id
               WHERE t.status IN ('running', 'waiting_approval', 'waiting_ask')
                 AND s.kind = 'direct'
               ORDER BY t.last_activity_at DESC LIMIT 1`,
        )
        .get();
  if (!row) {
    if (turnId) throw new HttpError(404, "not_found", "turn not found");
    return null;
  }
  if (!isLive(row.status)) {
    throw new HttpError(422, "invalid_args", "turn is not in progress");
  }
  if (!opts.allowGroup) {
    const session = ctx.db
      .query<{ kind: string }, [string]>(`SELECT kind FROM sessions WHERE id = ?`)
      .get(row.session_id);
    if (session?.kind === "group") {
      throw new HttpError(422, "invalid_args", "group turns cannot be stopped");
    }
  }
  const now = isoNow();
  ctx.db.transaction(() => {
    ctx.db.run(`UPDATE turns SET status = 'stopped', updated_at = ? WHERE id = ?`, [now, row.id]);
    ctx.db.run(
      `UPDATE approvals SET status = 'voided', resolved_at = ? WHERE turn_id = ? AND status = 'pending'`,
      [now, row.id],
    );
    finishTurnRoute(ctx, row.id, "stopped");
  })();
  return { ...row, status: "stopped", updated_at: now, partial_text: null };
}

export function interruptRunningTurns(ctx: StoreContext): void {
  const now = isoNow();
  const live = ctx.db
    .query<TurnRow, []>(
      `SELECT * FROM turns WHERE status IN ('running', 'waiting_approval', 'waiting_ask')`,
    )
    .all();
  ctx.db.transaction(() => {
    for (const turn of live) {
      ctx.db.run(`UPDATE turns SET status = 'interrupted', updated_at = ? WHERE id = ?`, [
        now,
        turn.id,
      ]);
      ctx.db.run(
        `UPDATE approvals SET status = 'voided', resolved_at = ? WHERE turn_id = ? AND status = 'pending'`,
        [now, turn.id],
      );
      ctx.db.run(
        `INSERT INTO messages (id, session_id, turn_id, parent_id, kind, author, body, source_turn_id, created_at)
         VALUES (?, ?, ?, NULL, 'system', ?, ?, NULL, ?)`,
        [ulid(), turn.session_id, turn.id, turn.bot_id, INTERRUPT_NOTE_BODY, now],
      );
      markInterruptPending(ctx, turn.bot_id);
      finishTurnRoute(ctx, turn.id, "interrupted");
    }
  })();
}

export function claimInterruptContinue(ctx: StoreContext, messageId: string): Turn {
  const note = getMessage(ctx, messageId);
  if (note.kind !== "system" || note.body !== INTERRUPT_NOTE_BODY || !note.turn_id) {
    throw new HttpError(422, "invalid_args", "message is not an interrupted turn");
  }
  if (note.source_turn_id) {
    throw new HttpError(422, "invalid_args", "interrupted turn already continued");
  }
  const cut = getTurn(ctx, note.turn_id);
  if (cut.status !== "interrupted" || cut.bot_id !== note.author) {
    throw new HttpError(422, "invalid_args", "turn is not interrupted");
  }
  const session = sessionRow(ctx, note.session_id);
  if (session.archived_at) {
    throw new HttpError(422, "invalid_args", "session is archived");
  }
  const bot = aliveBot(ctx, cut.bot_id);
  if (bot.archived_at) {
    throw new HttpError(422, "invalid_args", "bot is archived");
  }
  if (!isPresent(ctx, note.session_id, cut.bot_id)) {
    throw new HttpError(422, "invalid_args", "bot is not in this session");
  }
  if (listLiveTurns(ctx, { sessionId: note.session_id, botId: cut.bot_id }).length > 0) {
    throw new HttpError(422, "invalid_args", "bot already has a live turn");
  }
  const now = isoNow();
  const id = ulid();
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO turns
        (id, session_id, bot_id, status, trigger_message_id, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
      [id, note.session_id, cut.bot_id, note.id, now, now, now],
    );
    const updated = ctx.db.query<{ id: string }, [string, string]>(
      `UPDATE messages SET source_turn_id = ? WHERE id = ? AND source_turn_id IS NULL RETURNING id`,
    ).get(id, note.id);
    if (!updated) {
      throw new HttpError(422, "invalid_args", "interrupted turn already continued");
    }
  })();
  touchSession(ctx, note.session_id, now);
  return getTurn(ctx, id);
}

export function pendingInterruptSet(ctx: StoreContext): Set<string> {
  const raw = ctx.db
    .query<SettingRow, [string]>(`SELECT key, value FROM settings WHERE key = ?`)
    .get("_pending_interrupt_bots");
  if (!raw?.value) return new Set();
  try {
    const parsed = JSON.parse(raw.value) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function writePendingInterrupts(ctx: StoreContext, set: Set<string>): void {
  setSetting(ctx, "_pending_interrupt_bots", JSON.stringify([...set]));
}
