import type { Spend } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import type { StoreContext } from "./shared";

export function insertSpend(
  ctx: StoreContext,
  input: {
    sessionId: string;
    botId: string;
    turnId?: string | null;
    judgementId?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    cachedTokens?: number | null;
    reasoningTokens?: number | null;
    costUsdTicks?: number | null;
    missingReason?: Spend["missing_reason"];
  },
): Spend {
  const now = isoNow();
  const row: Spend = {
    id: ulid(),
    session_id: input.sessionId,
    bot_id: input.botId,
    turn_id: input.turnId ?? null,
    judgement_id: input.judgementId ?? null,
    input_tokens: input.inputTokens ?? null,
    output_tokens: input.outputTokens ?? null,
    total_tokens: input.totalTokens ?? null,
    cached_tokens: input.cachedTokens ?? null,
    reasoning_tokens: input.reasoningTokens ?? null,
    cost_usd_ticks: input.costUsdTicks ?? null,
    missing_reason: input.missingReason ?? null,
    created_at: now,
  };
  ctx.db.run(
    `INSERT INTO spend (
       id, session_id, bot_id, turn_id, judgement_id,
       input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens,
       cost_usd_ticks, missing_reason, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.session_id,
      row.bot_id,
      row.turn_id,
      row.judgement_id,
      row.input_tokens,
      row.output_tokens,
      row.total_tokens,
      row.cached_tokens,
      row.reasoning_tokens,
      row.cost_usd_ticks,
      row.missing_reason,
      row.created_at,
    ],
  );
  return row;
}

export function listSpend(
  ctx: StoreContext,
  filter: { session_id?: string; bot_id?: string; turn_id?: string },
): Spend[] {
  let sql = `SELECT * FROM spend`;
  const where: string[] = [];
  const args: string[] = [];
  if (filter.session_id) {
    where.push("session_id = ?");
    args.push(filter.session_id);
  }
  if (filter.bot_id) {
    where.push("bot_id = ?");
    args.push(filter.bot_id);
  }
  if (filter.turn_id) {
    where.push("turn_id = ?");
    args.push(filter.turn_id);
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += ` ORDER BY created_at ASC`;
  return ctx.db.query<Spend, string[]>(sql).all(...args);
}
