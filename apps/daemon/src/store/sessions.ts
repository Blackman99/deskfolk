import {
  USER_MEMBER,
  type CreateGroupRequest,
  type Message,
  type SessionDetail,
  type SessionParticipant,
  type SessionSummary,
  type Turn,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { hydrateMessage, listMessages } from "./messages";

export { isPresent } from "./shared";
import {
  aliveBot,
  isPresent,
  requireNonEmpty,
  sessionRow,
  toTurn,
  touchSession,
  type MessageRow,
  type ParticipantRow,
  type SessionRow,
  type StoreContext,
  type TurnRow,
} from "./shared";

export function listSessions(ctx: StoreContext): SessionSummary[] {
  const deletedBotIds = new Set(
    ctx.db
      .query<{ id: string }, []>(`SELECT id FROM bots WHERE deleted_at IS NOT NULL`)
      .all()
      .map((r) => r.id),
  );
  const sessions = ctx.db
    .query<SessionRow, []>(`SELECT * FROM sessions ORDER BY updated_at DESC, id DESC`)
    .all();
  const participants = ctx.db
    .query<ParticipantRow, []>(`SELECT * FROM session_participants`)
    .all();
  const bySession = new Map<string, SessionParticipant[]>();
  for (const p of participants) {
    const list = bySession.get(p.session_id) ?? [];
    list.push({ member: p.member, joined_at: p.joined_at, left_at: p.left_at });
    bySession.set(p.session_id, list);
  }
  const lastMsgRows = ctx.db
    .query<MessageRow, []>(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, id DESC) as rn
         FROM messages
         WHERE kind != 'profile_change'
       ) WHERE rn = 1`,
    )
    .all();
  const lastMessagesBySession = new Map<string, Message>();
  for (const row of lastMsgRows) {
    lastMessagesBySession.set(row.session_id, hydrateMessage(ctx, row));
  }
  const liveTurnRows = ctx.db
    .query<TurnRow, []>(
      `SELECT * FROM turns
       WHERE status IN ('running', 'waiting_approval', 'waiting_ask')
       ORDER BY last_activity_at DESC, id DESC`,
    )
    .all();
  const liveTurnsBySession = new Map<string, Turn[]>();
  for (const row of liveTurnRows) {
    const list = liveTurnsBySession.get(row.session_id) ?? [];
    list.push(toTurn(row));
    liveTurnsBySession.set(row.session_id, list);
  }
  const unreadBySession = unreadCountsBySession(ctx);
  return sessions
    .filter((s) => {
      const parts = bySession.get(s.id) ?? [];
      const active = parts.filter((p) => p.left_at === null).map((p) => p.member);
      if (s.kind === "direct") {
        const peer = active.find((m) => m !== USER_MEMBER);
        if (peer && deletedBotIds.has(peer)) return false;
        // For bot-bot direct, if any bot is deleted, hide
        if (active.some((m) => deletedBotIds.has(m))) return false;
      }
      return true;
    })
    .map((s) => ({
      ...s,
      last_read_at: s.last_read_at ?? null,
      archived_at: s.archived_at ?? null,
      participants: bySession.get(s.id) ?? [],
      last_message: lastMessagesBySession.get(s.id) ?? null,
      live_turns: liveTurnsBySession.get(s.id) ?? [],
      unread_count: unreadBySession.get(s.id) ?? 0,
    }));
}

export function getSession(ctx: StoreContext, id: string): SessionDetail {
  const session = sessionRow(ctx, id);
  const participants = listParticipants(ctx, id);
  const messages = listMessages(ctx, id, { limit: 50 });
  const turns = ctx.db
    .query<TurnRow, [string]>(
      `SELECT * FROM turns
       WHERE session_id = ? AND status IN ('running', 'waiting_approval', 'waiting_ask')
       ORDER BY last_activity_at DESC`,
    )
    .all(id)
    .map((t) => ({ ...t, partial_text: null }));
  return {
    ...session,
    last_read_at: session.last_read_at ?? null,
    archived_at: session.archived_at ?? null,
    participants,
    messages,
    turns,
    unread_count: unreadCount(ctx, id),
  };
}

export function markSessionRead(ctx: StoreContext, id: string, at: string = isoNow()): SessionDetail {
  sessionRow(ctx, id);
  ctx.db.run(`UPDATE sessions SET last_read_at = ? WHERE id = ?`, [at, id]);
  return getSession(ctx, id);
}

export function createGroup(ctx: StoreContext, input: CreateGroupRequest): SessionDetail {
  const name = requireNonEmpty("name", input.name);
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new HttpError(422, "invalid_args", "members must include at least two bots");
  }
  const unique = [...new Set(input.members)];
  const bots = unique.map((id) => aliveBot(ctx, id));
  if (bots.length < 2) {
    throw new HttpError(422, "invalid_args", "a group needs at least two bots");
  }
  const now = isoNow();
  const sessionId = ulid();
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO sessions (id, kind, name, last_read_at, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?)`,
      [sessionId, name, now, now, now],
    );
    ctx.db.run(
      `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
      [sessionId, USER_MEMBER, now],
    );
    for (const bot of bots) {
      ctx.db.run(
        `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
        [sessionId, bot.id, now],
      );
    }
  })();
  return getSession(ctx, sessionId);
}

export function renameSession(ctx: StoreContext, id: string, name: string): SessionDetail {
  const session = sessionRow(ctx, id);
  if (session.kind !== "group") {
    throw new HttpError(422, "invalid_args", "only groups have a name");
  }
  const next = requireNonEmpty("name", name);
  const now = isoNow();
  ctx.db.run(`UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?`, [next, now, id]);
  return getSession(ctx, id);
}

export function archiveSession(ctx: StoreContext, id: string): SessionDetail {
  const session = sessionRow(ctx, id);
  if (session.archived_at) return getSession(ctx, id);
  const now = isoNow();
  ctx.db.run(`UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
  return getSession(ctx, id);
}

export function restoreSession(ctx: StoreContext, id: string): SessionDetail {
  const session = sessionRow(ctx, id);
  if (!session.archived_at) return getSession(ctx, id);
  const now = isoNow();
  ctx.db.run(`UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ?`, [now, id]);
  return getSession(ctx, id);
}

export function deleteSession(ctx: StoreContext, id: string): void {
  const session = sessionRow(ctx, id);
  if (session.kind !== "group") {
    throw new HttpError(422, "invalid_args", "only groups can be deleted");
  }
  ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE profile_revisions SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
      [id],
    );
    ctx.db.run(
      `DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
      [id],
    );
    ctx.db.run(
      `DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
      [id],
    );
    ctx.db.run(
      `DELETE FROM approvals WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?) OR message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
      [id, id],
    );
    ctx.db.run(
      `DELETE FROM route_feedback WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)`,
      [id],
    );
    // Reviews FK the turn and session; leaving them rolls the whole delete back.
    ctx.db.run(`DELETE FROM route_reviews WHERE session_id = ?`, [id]);
    ctx.db.run(`DELETE FROM turn_route_decisions WHERE session_id = ?`, [id]);
    ctx.db.run(`DELETE FROM judgements WHERE session_id = ?`, [id]);
    ctx.db.run(`DELETE FROM turns WHERE session_id = ?`, [id]);
    ctx.db.run(`DELETE FROM messages WHERE session_id = ?`, [id]);
    ctx.db.run(`DELETE FROM spend WHERE session_id = ?`, [id]);
    // Work dirs opened here: the ones only this session's turns belonged to go with it. A dir a
    // handoff carried into another session outlives it and just loses the session link, the way
    // an origin does — the folder on disk is the user's either way.
    ctx.db.run(`${UNREFERENCED_TASKS} AND session_id = ?`, [id]);
    ctx.db.run(`UPDATE tasks SET session_id = NULL WHERE session_id = ?`, [id]);
    ctx.db.run(
      `UPDATE sessions SET origin_session_id = NULL, origin_message_id = NULL WHERE origin_session_id = ?`,
      [id],
    );
    // Memories formed here outlive the session; only the receipt they point at is gone.
    ctx.db.run(
      `UPDATE memories SET source_session_id = NULL, source_message_id = NULL WHERE source_session_id = ?`,
      [id],
    );
    ctx.db.run(`DELETE FROM session_participants WHERE session_id = ?`, [id]);
    ctx.db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
  })();
}

/** Work dirs no surviving turn or message belongs to. Run only after those rows are gone. */
const UNREFERENCED_TASKS = `DELETE FROM tasks
   WHERE NOT EXISTS (SELECT 1 FROM turns WHERE turns.task_id = tasks.id)
     AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.task_id = tasks.id)`;

export function clearSessionMessages(ctx: StoreContext, id: string): void {
  sessionRow(ctx, id);
  const now = isoNow();
  ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE profile_revisions SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
      [id],
    );
    ctx.db.run(
      `DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
      [id],
    );
    ctx.db.run(
      `DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
      [id],
    );
    ctx.db.run(
      `DELETE FROM approvals WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?) OR message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
      [id, id],
    );
    ctx.db.run(
      `DELETE FROM route_feedback WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)`,
      [id],
    );
    // Reviews FK the turn and session; leaving them rolls the whole clear back.
    ctx.db.run(`DELETE FROM route_reviews WHERE session_id = ?`, [id]);
    ctx.db.run(`DELETE FROM turn_route_decisions WHERE session_id = ?`, [id]);
    ctx.db.run(`DELETE FROM judgements WHERE session_id = ?`, [id]);
    ctx.db.run(`DELETE FROM turns WHERE session_id = ?`, [id]);
    ctx.db.run(`DELETE FROM messages WHERE session_id = ?`, [id]);
    // Clearing history ends the jobs it held: dirs nothing else belongs to go, the rest close.
    ctx.db.run(`${UNREFERENCED_TASKS} AND session_id = ?`, [id]);
    ctx.db.run(
      `UPDATE tasks SET closed_at = COALESCE(closed_at, ?) WHERE session_id = ?`,
      [now, id],
    );
    // The directs this session spawned keep their source; only the message to jump to is gone.
    ctx.db.run(`UPDATE sessions SET origin_message_id = NULL WHERE origin_session_id = ?`, [id]);
    ctx.db.run(`UPDATE memories SET source_message_id = NULL WHERE source_session_id = ?`, [id]);
    ctx.db.run(`UPDATE sessions SET last_read_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
  })();
}

export function addMember(ctx: StoreContext, sessionId: string, botId: string): SessionDetail {
  const session = sessionRow(ctx, sessionId);
  if (session.kind !== "group") {
    throw new HttpError(422, "invalid_args", "only groups have members you can add");
  }
  aliveBot(ctx, botId);
  const existing = ctx.db
    .query<ParticipantRow, [string, string]>(
      `SELECT * FROM session_participants WHERE session_id = ? AND member = ?`,
    )
    .get(sessionId, botId);
  const now = isoNow();
  if (!existing) {
    ctx.db.run(
      `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
      [sessionId, botId, now],
    );
  } else if (existing.left_at) {
    ctx.db.run(
      `UPDATE session_participants SET left_at = NULL, joined_at = ? WHERE session_id = ? AND member = ?`,
      [now, sessionId, botId],
    );
  }
  touchSession(ctx, sessionId, now);
  return getSession(ctx, sessionId);
}

export function removeMember(ctx: StoreContext, sessionId: string, botId: string): SessionDetail {
  const session = sessionRow(ctx, sessionId);
  if (session.kind !== "group") {
    throw new HttpError(422, "invalid_args", "only groups have members you can remove");
  }
  if (botId === USER_MEMBER) {
    throw new HttpError(422, "invalid_args", "you stay in every group");
  }
  const existing = ctx.db
    .query<ParticipantRow, [string, string]>(
      `SELECT * FROM session_participants WHERE session_id = ? AND member = ?`,
    )
    .get(sessionId, botId);
  if (!existing || existing.left_at) {
    throw new HttpError(404, "not_found", "member not in this group");
  }
  const presentBots = ctx.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM session_participants
       WHERE session_id = ? AND member != 'user' AND left_at IS NULL`,
    )
    .get(sessionId);
  if ((presentBots?.n ?? 0) <= 2) {
    throw new HttpError(422, "invalid_args", "a group needs at least two bots");
  }
  const now = isoNow();
  ctx.db.run(
    `UPDATE session_participants SET left_at = ? WHERE session_id = ? AND member = ?`,
    [now, sessionId, botId],
  );
  touchSession(ctx, sessionId, now);
  return getSession(ctx, sessionId);
}

export function listParticipants(ctx: StoreContext, sessionId: string): SessionParticipant[] {
  return ctx.db
    .query<ParticipantRow, [string]>(
      `SELECT * FROM session_participants WHERE session_id = ? ORDER BY joined_at ASC`,
    )
    .all(sessionId)
    .map((p) => ({ member: p.member, joined_at: p.joined_at, left_at: p.left_at }));
}

export function presentParticipants(ctx: StoreContext, sessionId: string): SessionParticipant[] {
  return listParticipants(ctx, sessionId).filter((p) => p.left_at === null);
}

export function presentBotIds(ctx: StoreContext, sessionId: string): string[] {
  return presentParticipants(ctx, sessionId)
    .map((p) => p.member)
    .filter((m) => m !== USER_MEMBER);
}

export function findDirectSession(
  ctx: StoreContext,
  memberA: string,
  memberB: string,
): SessionDetail | null {
  const row = ctx.db
    .query<SessionRow, [string, string]>(
      `SELECT s.* FROM sessions s
       JOIN session_participants p1
         ON p1.session_id = s.id AND p1.member = ? AND p1.left_at IS NULL
       JOIN session_participants p2
         ON p2.session_id = s.id AND p2.member = ? AND p2.left_at IS NULL
       WHERE s.kind = 'direct'
         AND (
           SELECT COUNT(*) FROM session_participants p
           WHERE p.session_id = s.id AND p.left_at IS NULL
         ) = 2
       ORDER BY s.created_at ASC, s.id ASC
       LIMIT 1`,
    )
    .get(memberA, memberB);
  return row ? getSession(ctx, row.id) : null;
}

export function createDirect(ctx: StoreContext, memberA: string, memberB: string): SessionDetail {
  if (memberA === memberB) {
    throw new HttpError(422, "invalid_args", "a direct session needs two different members");
  }
  // You keep one direct per Bot. Two Bots open one per trigger instead, so that door is shut
  // here rather than re-opened by a future caller reaching for the nearest function.
  if (memberA !== USER_MEMBER && memberB !== USER_MEMBER) {
    throw new HttpError(422, "invalid_args", "a Bot↔Bot direct opens per trigger; use createBotDirect");
  }
  const existing = findDirectSession(ctx, memberA, memberB);
  if (existing) return existing;
  if (memberA !== USER_MEMBER) aliveBot(ctx, memberA);
  if (memberB !== USER_MEMBER) aliveBot(ctx, memberB);
  const now = isoNow();
  const sessionId = ulid();
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO sessions (id, kind, name, last_read_at, created_at, updated_at) VALUES (?, 'direct', NULL, ?, ?, ?)`,
      [sessionId, now, now, now],
    );
    ctx.db.run(
      `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
      [sessionId, memberA, now],
    );
    ctx.db.run(
      `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
      [sessionId, memberB, now],
    );
  })();
  return getSession(ctx, sessionId);
}

function findDirectByOrigin(
  ctx: StoreContext,
  botA: string,
  botB: string,
  originMessageId: string,
): SessionDetail | null {
  const row = ctx.db
    .query<SessionRow, [string, string, string]>(
      `SELECT s.* FROM sessions s
       JOIN session_participants p1
         ON p1.session_id = s.id AND p1.member = ? AND p1.left_at IS NULL
       JOIN session_participants p2
         ON p2.session_id = s.id AND p2.member = ? AND p2.left_at IS NULL
       WHERE s.kind = 'direct'
         AND s.origin_message_id = ?
         AND (
           SELECT COUNT(*) FROM session_participants p
           WHERE p.session_id = s.id AND p.left_at IS NULL
         ) = 2
       ORDER BY s.created_at ASC, s.id ASC
       LIMIT 1`,
    )
    .get(botA, botB, originMessageId);
  return row ? getSession(ctx, row.id) : null;
}

/**
 * A Bot↔Bot direct is one session per trigger, not one thread per pair: each time a Bot opens
 * one it gets a fresh session stamped with the message that set it off, and the entry point to
 * it hangs under that message.
 *
 * Asking twice off the same trigger returns the one already open, so a Bot that calls the tool
 * twice in a turn — or retries it — does not litter the sidebar with duplicates.
 */
export function createBotDirect(
  ctx: StoreContext,
  botA: string,
  botB: string,
  origin: { sessionId: string; messageId: string } | null,
): SessionDetail {
  if (botA === botB) {
    throw new HttpError(422, "invalid_args", "a direct session needs two different members");
  }
  if (botA === USER_MEMBER || botB === USER_MEMBER) {
    throw new HttpError(422, "invalid_args", "createBotDirect takes two bots");
  }
  aliveBot(ctx, botA);
  aliveBot(ctx, botB);
  const again = origin ? findDirectByOrigin(ctx, botA, botB, origin.messageId) : null;
  if (again) return again;
  const now = isoNow();
  const sessionId = ulid();
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO sessions
         (id, kind, name, last_read_at, origin_session_id, origin_message_id, created_at, updated_at)
       VALUES (?, 'direct', NULL, ?, ?, ?, ?, ?)`,
      [sessionId, now, origin?.sessionId ?? null, origin?.messageId ?? null, now, now],
    );
    for (const member of [botA, botB]) {
      ctx.db.run(
        `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
        [sessionId, member, now],
      );
    }
  })();
  return getSession(ctx, sessionId);
}

export function unreadCount(ctx: StoreContext, sessionId: string): number {
  sessionRow(ctx, sessionId);
  const row = ctx.db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.session_id = ?
         AND m.kind != 'profile_change'
         AND m.author != ?
         AND (s.last_read_at IS NULL OR m.created_at > s.last_read_at)`,
    )
    .get(sessionId, USER_MEMBER);
  return row?.n ?? 0;
}

export function unreadCountsBySession(ctx: StoreContext): Map<string, number> {
  const rows = ctx.db
    .query<{ session_id: string; n: number }, [string]>(
      `SELECT m.session_id AS session_id, COUNT(*) AS n
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.kind != 'profile_change'
         AND m.author != ?
         AND (s.last_read_at IS NULL OR m.created_at > s.last_read_at)
       GROUP BY m.session_id`,
    )
    .all(USER_MEMBER);
  return new Map(rows.map((row) => [row.session_id, row.n]));
}
