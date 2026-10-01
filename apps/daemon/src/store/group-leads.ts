/** A seven-day handoff count is a suggestion, never an assignment (ADR 0040 D22). */
import { parseMentions, USER_MEMBER, type GroupLeadState } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import type { StoreContext } from "./shared";

type Context = Pick<StoreContext, "db">;
type Member = { id: string; name: string; is_lead: number };

function members(ctx: Context, sessionId: string): Member[] {
  const session = ctx.db.query<{ kind: string }, [string]>("SELECT kind FROM sessions WHERE id = ?").get(sessionId);
  if (!session) throw new HttpError(404, "not_found", "session not found");
  if (session.kind !== "group") throw new HttpError(422, "invalid_args", "only a group has a lead");
  return ctx.db.query<Member, [string]>(
    `SELECT b.id, b.name, p.is_lead FROM session_participants p JOIN bots b ON b.id = p.member
     WHERE p.session_id = ? AND p.left_at IS NULL AND b.deleted_at IS NULL AND b.archived_at IS NULL ORDER BY b.id`,
  ).all(sessionId);
}

/** Confirmed means an actual present member's stored flag, not the highest count. */
export function groupLead(ctx: Context, sessionId: string): string | null {
  return members(ctx, sessionId).find((member) => member.is_lead === 1)?.id ?? null;
}

/** Count real, turn-sent handoffs to another member, not ordinary chatter or mentions by a user. */
export function groupLeadState(ctx: Context, sessionId: string, now = Date.now()): GroupLeadState {
  const present = members(ctx, sessionId);
  const confirmed = present.find((member) => member.is_lead === 1)?.id ?? null;
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const messages = ctx.db.query<{ author: string; body: string }, [string, string]>(
    `SELECT m.author, m.body FROM messages m JOIN turns t ON t.id = m.source_turn_id AND t.bot_id = m.author
     WHERE m.session_id = ? AND m.created_at >= ? AND m.kind = 'bot' AND m.source_turn_id IS NOT NULL`,
  ).all(sessionId, since);
  const counts = new Map<string, number>();
  // A recipient leaving today does not erase a real handoff the remaining Bot made this week.
  const names = ctx.db.query<{ name: string }, [string]>(
    "SELECT b.name FROM session_participants p JOIN bots b ON b.id = p.member WHERE p.session_id = ?",
  ).all(sessionId).map((member) => member.name);
  for (const message of messages) {
    const author = present.find((member) => member.id === message.author);
    if (!author) continue;
    const mentions = parseMentions(message.body, names);
    if (!mentions.everyone && !mentions.mentions.some((name) => name !== author.name && names.includes(name))) continue;
    counts.set(author.id, (counts.get(author.id) ?? 0) + 1);
  }
  // Legacy private delegations have one thread per trigger. The first actual sent line identifies
  // the initiator; empty threads and subsequent discussion are not additional handoffs.
  const privateHandoffs = ctx.db.query<{ author: string }, [string, string]>(
    `SELECT first.author FROM sessions s JOIN messages first ON first.id = (
       SELECT m.id FROM messages m JOIN turns t ON t.id = m.source_turn_id AND t.bot_id = m.author
       WHERE m.session_id = s.id AND m.kind = 'bot' AND m.source_turn_id IS NOT NULL
       ORDER BY m.created_at, m.id LIMIT 1)
     WHERE s.kind = 'direct' AND s.origin_session_id = ? AND first.created_at >= ?
       AND NOT EXISTS (SELECT 1 FROM session_participants p WHERE p.session_id = s.id AND p.member = 'user')`,
  ).all(sessionId, since);
  for (const handoff of privateHandoffs) {
    if (present.some((member) => member.id === handoff.author)) counts.set(handoff.author, (counts.get(handoff.author) ?? 0) + 1);
  }
  const ranked = [...counts].sort(([a, na], [b, nb]) => nb - na || a.localeCompare(b));
  // Equal evidence cannot identify a lead: do not make a random-looking suggestion.
  const top = ranked[0];
  const suggestion = top && (!ranked[1] || top[1] > ranked[1][1])
    ? { bot_id: top[0], handoffs: top[1], since }
    : null;
  return { session_id: sessionId, confirmed_bot_id: confirmed, suggestion };
}

/** Only the authenticated user's explicit confirmation may write the flag; no model tool calls this. */
export function confirmGroupLead(ctx: Context, sessionId: string, botId: string | null): GroupLeadState {
  const present = members(ctx, sessionId);
  if (botId !== null && !present.some((member) => member.id === botId)) {
    throw new HttpError(422, "invalid_args", "the lead must be a present Bot in this group");
  }
  const before = present.find((member) => member.is_lead === 1)?.id ?? null;
  ctx.db.run("UPDATE session_participants SET is_lead = 0 WHERE session_id = ?", [sessionId]);
  if (botId !== null) ctx.db.run("UPDATE session_participants SET is_lead = 1 WHERE session_id = ? AND member = ? AND left_at IS NULL", [sessionId, botId]);
  ctx.db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [isoNow(), sessionId]);
  ctx.db.run(
    "INSERT INTO work_events (at, kind, actor, bot_id, session_id, payload) VALUES (?, 'group_lead.confirmed', ?, ?, ?, ?)",
    [isoNow(), USER_MEMBER, botId, sessionId, JSON.stringify({ previous_bot_id: before, bot_id: botId, user_action_id: ulid() })],
  );
  return groupLeadState(ctx, sessionId);
}
