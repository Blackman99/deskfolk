/**
 * Where a job is worked on with you (2026-10-03): its home conversation, and every conversation you
 * have said something about it in. A job opened in your direct with one Bot is often taken up later
 * in a group — the 《一拳超人》 job opened in your direct with 审片员 and went on in AI影视创作组 —
 * so whatever asks who may work on a job, who leads it, or where to tell you about it asks all of
 * them, not only the home.
 */
import type { StoreContext } from "./shared";

export type JobConversations = {
  /** The plan's own conversation; null once that conversation was deleted. */
  home: string | null;
  /** The conversations you spoke about it in, the one you spoke in last first; the home among them when you did. */
  spoken: string[];
};

export function jobConversations(ctx: Pick<StoreContext, "db">, taskId: string): JobConversations {
  const home = ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(taskId)?.session_id ?? null;
  const spoken = ctx.db.query<{ session_id: string }, [string]>(`SELECT m.session_id FROM messages m
    WHERE m.kind = 'user' AND m.id IN (SELECT message_id FROM message_filings WHERE task_id = ?1 UNION SELECT id FROM messages WHERE task_id = ?1)
    GROUP BY m.session_id ORDER BY MAX(m.created_at) DESC, m.session_id`).all(taskId).map((row) => row.session_id);
  return { home, spoken };
}

/**
 * Where a line about `botId`'s work on the job may go to you, where you spoke about the job last
 * first: the groups you are still in, and your direct with that Bot — never your direct with another
 * of its Bots, where a card about this one would sit in the wrong conversation. A job opened in a
 * group and taken up in your direct with one of its Bots asked you to sign off there while its
 * cards went to the group (2026-10-04).
 */
export function spokenFor(ctx: Pick<StoreContext, "db">, taskId: string, botId: string | null): string[] {
  return jobConversations(ctx, taskId).spoken.filter((sessionId) => Boolean(ctx.db.query(`SELECT 1 FROM sessions s
    JOIN session_participants u ON u.session_id = s.id AND u.member = 'user' AND u.left_at IS NULL
    WHERE s.id = ?1 AND s.archived_at IS NULL AND (s.kind = 'group' OR (s.kind = 'direct' AND EXISTS (SELECT 1
      FROM session_participants b WHERE b.session_id = s.id AND b.member = ?2 AND b.left_at IS NULL)))`).get(sessionId, botId)));
}

/** Home first, then where you spoke about it, each once. */
export function allJobConversations(conversations: JobConversations): string[] {
  return [...new Set([...(conversations.home ? [conversations.home] : []), ...conversations.spoken])];
}

/** A Bot that can take work in this job: not archived or deleted, and a member of one of its conversations. */
export function eligibleInJob(ctx: Pick<StoreContext, "db">, botId: string | null | undefined, taskId: string, conversations = jobConversations(ctx, taskId)): string | null {
  if (!botId) return null;
  const sessions = allJobConversations(conversations);
  if (sessions.length === 0) return null;
  return ctx.db.query<{ id: string }, [string, string]>(`SELECT b.id FROM bots b WHERE b.id = ?1 AND b.archived_at IS NULL AND b.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM session_participants p WHERE p.member = b.id AND p.left_at IS NULL AND p.session_id IN (SELECT value FROM json_each(?2)))`)
    .get(botId, JSON.stringify(sessions))?.id ?? null;
}

/** The leads you confirmed in the job's groups, home first, then where you spoke about it last. */
export function confirmedLeadsOf(ctx: Pick<StoreContext, "db">, conversations: JobConversations): string[] {
  const leads: string[] = [];
  for (const sessionId of allJobConversations(conversations)) {
    const lead = ctx.db.query<{ member: string }, [string]>(`SELECT member FROM session_participants WHERE session_id = ? AND is_lead = 1
      AND left_at IS NULL ORDER BY joined_at, member LIMIT 1`).get(sessionId)?.member;
    if (lead && !leads.includes(lead)) leads.push(lead);
  }
  return leads;
}

/**
 * Where to wake a Bot on this job when it has no work item to say: the first of the job's
 * conversations it is a member of, where you spoke about the job last first, then its home; null
 * when it is in none. Waking it in the home it is no member of opens nothing, and the call-back
 * sits queued for good (2026-10-03).
 */
export function conversationFor(ctx: Pick<StoreContext, "db">, botId: string, taskId: string, conversations = jobConversations(ctx, taskId)): string | null {
  for (const sessionId of [...conversations.spoken, ...(conversations.home ? [conversations.home] : [])]) {
    if (ctx.db.query(`SELECT 1 FROM sessions s JOIN session_participants p ON p.session_id = s.id AND p.member = ? AND p.left_at IS NULL
      WHERE s.id = ? AND s.archived_at IS NULL`).get(botId, sessionId)) return sessionId;
  }
  return null;
}
