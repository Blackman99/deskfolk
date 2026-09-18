import type { Judgement } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { sessionRow, type StoreContext } from "./shared";

export function insertJudgement(
  ctx: StoreContext,
  input: {
    sessionId: string;
    messageId: string;
    botId: string;
    decision: Judgement["decision"];
    reason?: string | null;
    error?: Judgement["error"];
  },
): Judgement {
  const row: Judgement = {
    id: ulid(),
    session_id: input.sessionId,
    message_id: input.messageId,
    bot_id: input.botId,
    decision: input.decision,
    reason: input.reason ?? null,
    error: input.error ?? null,
    created_at: isoNow(),
  };
  ctx.db.run(
    `INSERT INTO judgements (id, session_id, message_id, bot_id, decision, reason, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.session_id,
      row.message_id,
      row.bot_id,
      row.decision,
      row.reason,
      row.error,
      row.created_at,
    ],
  );
  return row;
}

export function listJudgements(ctx: StoreContext, sessionId: string): Judgement[] {
  sessionRow(ctx, sessionId);
  return ctx.db
    .query<Judgement, [string]>(
      `SELECT * FROM judgements WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(sessionId);
}
