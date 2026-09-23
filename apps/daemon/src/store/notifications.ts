import type {
  AcknowledgeNotificationRequest,
  ListNotificationsResponse,
  NotificationActionState,
  NotificationDevice,
  NotificationPushConfig,
  NotificationFilter,
  NotificationItem,
  NotificationKind,
  NotificationPolicy,
  NotificationSummary,
  ReadNotificationsRequest,
  SessionNotificationPreference,
  UpdateNotificationPolicyRequest,
} from "@real-bot/protocol";
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { renderNotificationDisplay } from "../notification-policy";
import type { StoreContext } from "./shared";
import { USER_MEMBER } from "@real-bot/protocol";

export type NotificationRow = {
  id: string;
  ordinal: number;
  semantic_key: string;
  kind: NotificationKind;
  session_id: string | null;
  message_id: string | null;
  turn_id: string | null;
  approval_id: string | null;
  routine_id: string | null;
  routine_due_at: string | null;
  created_at: string;
  read_at: string | null;
  terminal_at: string | null;
  action_state: NotificationActionState;
  resolution_reason: string | null;
  fail_kind: string | null;
  revision: number;
};

export type NotificationCreateInput = {
  id?: string;
  semantic_key: string;
  kind: NotificationKind;
  session_id?: string | null;
  message_id?: string | null;
  turn_id?: string | null;
  approval_id?: string | null;
  routine_id?: string | null;
  routine_due_at?: string | null;
  created_at?: string;
  action_state?: NotificationActionState;
  fail_kind?: string | null;
};

export const MAX_NON_OPEN_NOTIFICATIONS = 10_000;
export const MAX_RETENTION_DAYS = 30;
export const MAX_DELIVERY_RECORDS = 2_000;
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function bumpCleanupRevision(ctx: StoreContext): void {
  ctx.db.run(
    "UPDATE notification_counters SET val = val + 1 WHERE name = 'cleanup_revision'",
  );
}

export function getCleanupRevision(ctx: StoreContext): number {
  return (
    ctx.db
      .query<{ val: number }, []>(
        "SELECT val FROM notification_counters WHERE name = 'cleanup_revision'",
      )
      .get()?.val ?? 1
  );
}

export function createNotification(
  ctx: StoreContext,
  input: NotificationCreateInput,
): NotificationRow {
  const existing = ctx.db
    .query<NotificationRow, [string]>("SELECT * FROM notifications WHERE semantic_key = ?")
    .get(input.semantic_key);
  if (existing) {
    return existing;
  }

  ctx.db.run("UPDATE notification_counters SET val = val + 1 WHERE name = 'ordinal'");
  const ordinal = ctx.db
    .query<{ val: number }, []>("SELECT val FROM notification_counters WHERE name = 'ordinal'")
    .get()!.val;

  const id = input.id ?? ulid();
  const createdAt = input.created_at ?? isoNow();
  const defaultActionState: NotificationActionState =
    input.kind === "approval" ||
    input.kind === "ask" ||
    input.kind === "failure" ||
    input.kind === "interrupted"
      ? "open"
      : "none";
  const actionState = input.action_state ?? defaultActionState;

  ctx.db.run(
    `INSERT INTO notifications (
      id, ordinal, semantic_key, kind, session_id, message_id, turn_id, approval_id,
      routine_id, routine_due_at, created_at, read_at, terminal_at, action_state,
      resolution_reason, fail_kind, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, 1)`,
    [
      id,
      ordinal,
      input.semantic_key,
      input.kind,
      input.session_id ?? null,
      input.message_id ?? null,
      input.turn_id ?? null,
      input.approval_id ?? null,
      input.routine_id ?? null,
      input.routine_due_at ?? null,
      createdAt,
      actionState,
      input.fail_kind ?? null,
    ],
  );

  pruneNotificationsRetention(ctx);
  bumpCleanupRevision(ctx);

  return ctx.db
    .query<NotificationRow, [string]>("SELECT * FROM notifications WHERE id = ?")
    .get(id)!;
}

export function getNotificationRow(
  ctx: StoreContext,
  id: string,
): NotificationRow | null {
  return (
    ctx.db
      .query<NotificationRow, [string]>("SELECT * FROM notifications WHERE id = ?")
      .get(id) ?? null
  );
}

export function getNotificationBySemanticKey(
  ctx: StoreContext,
  key: string,
): NotificationRow | null {
  return (
    ctx.db
      .query<NotificationRow, [string]>("SELECT * FROM notifications WHERE semantic_key = ?")
      .get(key) ?? null
  );
}

export function getNotification(
  ctx: StoreContext,
  id: string,
): NotificationItem | null {
  const row = getNotificationRow(ctx, id);
  return row ? hydrateNotification(ctx, row) : null;
}

export function updateNotificationActionState(
  ctx: StoreContext,
  lookup: { id?: string; semantic_key?: string } | string,
  state: NotificationActionState,
  reason?: string | null,
  markRead?: boolean,
): void {
  let row: NotificationRow | null = null;
  if (typeof lookup === "string") {
    row = ctx.db
      .query<NotificationRow, [string]>("SELECT * FROM notifications WHERE semantic_key = ?")
      .get(lookup) ?? null;
  } else if (lookup.id) {
    row = ctx.db
      .query<NotificationRow, [string]>("SELECT * FROM notifications WHERE id = ?")
      .get(lookup.id) ?? null;
  } else if (lookup.semantic_key) {
    row = ctx.db
      .query<NotificationRow, [string]>("SELECT * FROM notifications WHERE semantic_key = ?")
      .get(lookup.semantic_key) ?? null;
  }
  if (!row) return;

  const now = isoNow();
  const terminalAt =
    (state === "resolved" || state === "voided") && !row.terminal_at ? now : row.terminal_at;
  const readAt = markRead || reason === "acknowledged" ? (row.read_at ?? now) : row.read_at;

  ctx.db.run(
    `UPDATE notifications
     SET action_state = ?, resolution_reason = COALESCE(?, resolution_reason),
         terminal_at = ?, read_at = ?, revision = revision + 1
     WHERE id = ?`,
    [state, reason ?? null, terminalAt, readAt, row.id],
  );

  bumpCleanupRevision(ctx);

  if (state === "resolved" || state === "voided") {
    pruneNotificationsRetention(ctx);
  }
}

export function markNotificationRead(
  ctx: StoreContext,
  id: string,
  readAt?: string,
): void {
  const now = readAt ?? isoNow();
  ctx.db.run(
    "UPDATE notifications SET read_at = COALESCE(read_at, ?), revision = revision + 1 WHERE id = ? AND read_at IS NULL",
    [now, id],
  );
  bumpCleanupRevision(ctx);
}

export function markNotificationsReadBatch(
  ctx: StoreContext,
  req: ReadNotificationsRequest,
): void {
  const now = isoNow();
  if ("ids" in req) {
    if (!req.ids.length) return;
    const placeholders = req.ids.map(() => "?").join(",");
    ctx.db.run(
      `UPDATE notifications SET read_at = COALESCE(read_at, ?), revision = revision + 1
       WHERE id IN (${placeholders}) AND read_at IS NULL`,
      [now, ...req.ids],
    );
  } else if ("through_ordinal" in req) {
    ctx.db.run(
      `UPDATE notifications SET read_at = COALESCE(read_at, ?), revision = revision + 1
       WHERE ordinal <= ? AND read_at IS NULL`,
      [now, req.through_ordinal],
    );
  }
  bumpCleanupRevision(ctx);
}

export function markNotificationsReadThroughMessage(
  ctx: StoreContext,
  sessionId: string,
  messageSeq: number,
  readAt: string,
): void {
  ctx.db.run(
    `UPDATE notifications
     SET read_at = COALESCE(read_at, ?), revision = revision + 1
     WHERE session_id = ?
       AND message_id IN (
         SELECT id FROM messages WHERE session_id = ? AND message_seq <= ?
       )
       AND read_at IS NULL`,
    [readAt, sessionId, sessionId, messageSeq],
  );
  bumpCleanupRevision(ctx);
}

export function acknowledgeNotification(
  ctx: StoreContext,
  id: string,
  ifRevision: number,
): NotificationItem {
  const row = getNotificationRow(ctx, id);
  if (!row) {
    throw new HttpError(404, "not_found", "notification not found");
  }
  if (row.kind !== "failure" && row.kind !== "interrupted") {
    throw new HttpError(
      422,
      "invalid_action",
      "only failure and interrupted notifications can be acknowledged",
    );
  }
  if (row.revision !== ifRevision) {
    throw new HttpError(
      409,
      "revision_conflict",
      `notification revision conflict: expected ${ifRevision}, actual ${row.revision}`,
    );
  }

  const now = isoNow();
  ctx.db.run(
    `UPDATE notifications
     SET action_state = 'resolved', resolution_reason = 'acknowledged',
         terminal_at = COALESCE(terminal_at, ?), read_at = COALESCE(read_at, ?),
         revision = revision + 1
     WHERE id = ?`,
    [now, now, id],
  );

  bumpCleanupRevision(ctx);
  pruneNotificationsRetention(ctx);
  return getNotification(ctx, id)!;
}

export function hydrateNotification(
  ctx: StoreContext,
  row: NotificationRow,
): NotificationItem {
  let botName: string | null = null;
  let sessionName: string | null = null;
  let routineTitle: string | null = null;
  let bodySnippet: string | null = null;
  let approvalSummary: string | null = null;

  if (row.session_id) {
    const session = ctx.db
      .query<{ name: string | null; kind: string }, [string]>(
        "SELECT name, kind FROM sessions WHERE id = ?",
      )
      .get(row.session_id);
    if (session) sessionName = session.name;
  }

  if (row.turn_id) {
    const turn = ctx.db
      .query<{ bot_id: string }, [string]>("SELECT bot_id FROM turns WHERE id = ?")
      .get(row.turn_id);
    if (turn) {
      const bot = ctx.db
        .query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?")
        .get(turn.bot_id);
      if (bot) botName = bot.name;
    }
  }

  if (row.routine_id) {
    const routine = ctx.db
      .query<{ title: string }, [string]>("SELECT title FROM routines WHERE id = ?")
      .get(row.routine_id);
    if (routine) routineTitle = routine.title;
  }

  if (row.approval_id) {
    const app = ctx.db
      .query<{ summary: string | null }, [string]>("SELECT summary FROM approvals WHERE id = ?")
      .get(row.approval_id);
    if (app) approvalSummary = app.summary;
  }

  if (row.message_id) {
    const msg = ctx.db
      .query<{ body: string; author: string }, [string]>(
        "SELECT body, author FROM messages WHERE id = ?",
      )
      .get(row.message_id);
    if (msg) {
      bodySnippet = msg.body;
      if (!botName && msg.author !== USER_MEMBER) {
        const bot = ctx.db
          .query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?")
          .get(msg.author);
        botName = bot?.name ?? msg.author;
      }
    }
  }

  const display = renderNotificationDisplay({
    kind: row.kind,
    botName,
    sessionName,
    routineTitle,
    bodySnippet,
    approvalSummary,
    failKind: row.fail_kind,
    resolutionReason: row.resolution_reason,
  });

  return {
    id: row.id,
    ordinal: row.ordinal,
    semantic_key: row.semantic_key,
    kind: row.kind,
    session_id: row.session_id,
    message_id: row.message_id,
    turn_id: row.turn_id,
    approval_id: row.approval_id,
    routine_id: row.routine_id,
    routine_due_at: row.routine_due_at,
    created_at: row.created_at,
    read_at: row.read_at,
    terminal_at: row.terminal_at,
    action_state: row.action_state,
    resolution_reason: row.resolution_reason,
    fail_kind: row.fail_kind,
    revision: row.revision,
    display,
    target: {
      session_id: row.session_id,
      message_id: row.message_id,
      approval_id: row.approval_id,
      turn_id: row.turn_id,
    },
  };
}

export function listNotifications(
  ctx: StoreContext,
  options: { filter: NotificationFilter; limit?: number; cursor?: string | null },
): ListNotificationsResponse {
  const filter = options.filter;
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));

  let upperOrdinal: number;
  let beforeOrdinal: number | undefined;

  if (options.cursor) {
    const decoded = decodeNotificationCursor(options.cursor);
    if (!decoded || decoded.filter !== filter) {
      throw new HttpError(400, "invalid_cursor", "invalid notification pagination cursor");
    }
    upperOrdinal = decoded.upper_ordinal;
    beforeOrdinal = decoded.before_ordinal;
  } else {
    const maxRow = ctx.db
      .query<{ max_ord: number | null }, []>("SELECT MAX(ordinal) as max_ord FROM notifications")
      .get();
    upperOrdinal = maxRow?.max_ord ?? 0;
  }

  let sql = "SELECT * FROM notifications WHERE ordinal <= ?";
  const params: Array<string | number> = [upperOrdinal];

  if (beforeOrdinal !== undefined) {
    sql += " AND ordinal < ?";
    params.push(beforeOrdinal);
  }

  if (filter === "actionable") {
    sql += " AND action_state = 'open'";
  } else if (filter === "unread") {
    sql += " AND read_at IS NULL";
  }

  sql += " ORDER BY ordinal DESC LIMIT ?";
  params.push(limit + 1);

  const rows = ctx.db.query<NotificationRow, typeof params>(sql).all(...params);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastRow = page[page.length - 1];

  const next =
    hasMore && lastRow
      ? encodeNotificationCursor({
          v: 1,
          filter,
          upper_ordinal: upperOrdinal,
          before_ordinal: lastRow.ordinal,
        })
      : null;

  const items = page.map((row) => hydrateNotification(ctx, row));
  const summary = getNotificationSummary(ctx);

  return {
    items,
    next,
    summary,
    upper_ordinal: upperOrdinal,
    event_instance_id: "",
    watermark_seq: 0,
  };
}

/**
 * What the badge counts: anything unread, plus approvals and asks still waiting on you. A seen
 * interruption or failure stays open for Continue, but with no inbox there is nowhere to dismiss
 * it, so it would hold the badge up forever.
 */
export const NEEDS_ATTENTION_SQL =
  "(read_at IS NULL OR (action_state = 'open' AND kind IN ('approval', 'ask')))";

export function getNotificationSummary(ctx: StoreContext): NotificationSummary {
  const counts = ctx.db
    .query<{ unread_count: number; open_count: number; attention_count: number }, []>(`
      SELECT
        COUNT(CASE WHEN read_at IS NULL THEN 1 END) as unread_count,
        COUNT(CASE WHEN action_state = 'open' THEN 1 END) as open_count,
        COUNT(CASE WHEN ${NEEDS_ATTENTION_SQL} THEN 1 END) as attention_count
      FROM notifications
    `)
    .get();

  const noticeRow = ctx.db
    .query<{ pruned_at: string; read_at: string | null }, []>(
      "SELECT pruned_at, read_at FROM notification_retention_notice WHERE singleton = 1",
    )
    .get();

  return {
    unread_count: counts?.unread_count ?? 0,
    open_count: counts?.open_count ?? 0,
    attention_count: counts?.attention_count ?? 0,
    retention_notice: noticeRow
      ? { pruned_at: noticeRow.pruned_at, read_at: noticeRow.read_at }
      : null,
  };
}

export function markRetentionNoticeRead(ctx: StoreContext): void {
  const now = isoNow();
  ctx.db.run("UPDATE notification_retention_notice SET read_at = ? WHERE singleton = 1", [now]);
  bumpCleanupRevision(ctx);
}

export function pruneNotificationsRetention(ctx: StoreContext): void {
  const cutoffTime = new Date(Date.now() - MAX_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Find non-open rows that exceed 30 days
  const agedIds = ctx.db
    .query<{ id: string; read_at: string | null }, [string, string]>(`
      SELECT id, read_at FROM notifications
      WHERE action_state != 'open'
        AND (
          (action_state = 'none' AND created_at < ?)
          OR (action_state IN ('resolved', 'voided') AND terminal_at IS NOT NULL AND terminal_at < ?)
        )
    `)
    .all(cutoffTime, cutoffTime);

  // Find non-open rows exceeding MAX_NON_OPEN_NOTIFICATIONS capacity
  const nonOpenCount = ctx.db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM notifications WHERE action_state != 'open'",
    )
    .get()?.count ?? 0;

  let excessIds: Array<{ id: string; read_at: string | null }> = [];
  if (nonOpenCount > MAX_NON_OPEN_NOTIFICATIONS) {
    const excessLimit = nonOpenCount - MAX_NON_OPEN_NOTIFICATIONS;
    excessIds = ctx.db
      .query<{ id: string; read_at: string | null }, [number]>(`
        SELECT id, read_at FROM notifications
        WHERE action_state != 'open'
        ORDER BY COALESCE(terminal_at, created_at) ASC, ordinal ASC
        LIMIT ?
      `)
      .all(excessLimit);
  }

  const allToPrune = new Map<string, { id: string; read_at: string | null }>();
  for (const row of [...agedIds, ...excessIds]) {
    allToPrune.set(row.id, row);
  }

  if (allToPrune.size === 0) return;

  const hasUnreadPruned = Array.from(allToPrune.values()).some((r) => r.read_at === null);
  const now = isoNow();

  if (hasUnreadPruned) {
    ctx.db.run(
      `INSERT INTO notification_retention_notice (singleton, pruned_at, read_at)
       VALUES (1, ?, NULL)
       ON CONFLICT(singleton) DO UPDATE SET pruned_at = excluded.pruned_at, read_at = NULL`,
      [now],
    );
  }

  const ids = Array.from(allToPrune.keys());
  const placeholders = ids.map(() => "?").join(",");
  ctx.db.run(`DELETE FROM notifications WHERE id IN (${placeholders})`, ids);
  bumpCleanupRevision(ctx);
}

const LIVE_DELIVERY_STATES = "('pending', 'claimed', 'retry_wait')";

export function pruneNotificationDeliveriesRetention(
  ctx: StoreContext,
  now: number = Date.now(),
): void {
  const cutoff = now - DELIVERY_RETENTION_MS;
  const aged = ctx.db.run(
    `DELETE FROM notification_deliveries
     WHERE state NOT IN ${LIVE_DELIVERY_STATES}
       AND created_at < ?`,
    [cutoff],
  );

  const total =
    ctx.db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM notification_deliveries")
      .get()?.count ?? 0;

  let excessChanges = 0;
  if (total > MAX_DELIVERY_RECORDS) {
    const excess = total - MAX_DELIVERY_RECORDS;
    const excessIds = ctx.db
      .query<{ delivery_id: string }, [number]>(
        `SELECT delivery_id FROM notification_deliveries
         WHERE state NOT IN ${LIVE_DELIVERY_STATES}
         ORDER BY created_at ASC, delivery_id ASC
         LIMIT ?`,
      )
      .all(excess)
      .map((row) => row.delivery_id);
    if (excessIds.length > 0) {
      const placeholders = excessIds.map(() => "?").join(",");
      const deleted = ctx.db.run(
        `DELETE FROM notification_deliveries WHERE delivery_id IN (${placeholders})`,
        excessIds,
      );
      excessChanges = deleted.changes;
    }
  }

  if (aged.changes + excessChanges > 0) {
    bumpCleanupRevision(ctx);
  }
}

// -----------------------------------------------------------------------------------------
// Policy & Settings
// -----------------------------------------------------------------------------------------

export function getNotificationPolicy(ctx: StoreContext): NotificationPolicy {
  const row = ctx.db
    .query<{
      revision: number;
      cat_approval: number;
      cat_ask: number;
      cat_failure: number;
      cat_interrupted: number;
      cat_reply: number;
      cat_routine_result: number;
      quiet_enabled: number;
      quiet_start: string;
      quiet_end: string;
      quiet_tz: string;
    }, []>("SELECT * FROM notification_policy WHERE singleton = 1")
    .get();

  if (!row) {
    return {
      revision: 1,
      categories: {
        approval: true,
        ask: true,
        failure: true,
        interrupted: true,
        reply: true,
        routine_result: true,
      },
      quiet_hours: {
        enabled: false,
        start: "22:00",
        end: "08:00",
        time_zone: "UTC",
      },
    };
  }

  return {
    revision: row.revision,
    categories: {
      approval: Boolean(row.cat_approval),
      ask: Boolean(row.cat_ask),
      failure: Boolean(row.cat_failure),
      interrupted: Boolean(row.cat_interrupted),
      reply: Boolean(row.cat_reply),
      routine_result: Boolean(row.cat_routine_result),
    },
    quiet_hours: {
      enabled: Boolean(row.quiet_enabled),
      start: row.quiet_start,
      end: row.quiet_end,
      time_zone: row.quiet_tz,
    },
  };
}

export function updateNotificationPolicy(
  ctx: StoreContext,
  patch: UpdateNotificationPolicyRequest,
): NotificationPolicy {
  const current = getNotificationPolicy(ctx);
  if (current.revision !== patch.if_revision) {
    throw new HttpError(
      409,
      "revision_conflict",
      `policy revision conflict: expected ${patch.if_revision}, actual ${current.revision}`,
    );
  }

  const updatedCategories = {
    ...current.categories,
    ...(patch.categories ?? {}),
  };

  const updatedQuiet = {
    ...current.quiet_hours,
    ...(patch.quiet_hours ?? {}),
  };

  if (updatedQuiet.start === updatedQuiet.end) {
    throw new HttpError(422, "invalid_time", "quiet hours start and end must differ");
  }

  try {
    Intl.DateTimeFormat(undefined, { timeZone: updatedQuiet.time_zone });
  } catch {
    throw new HttpError(422, "invalid_timezone", `invalid IANA timezone: ${updatedQuiet.time_zone}`);
  }

  const newRevision = current.revision + 1;

  ctx.db.run(
    `UPDATE notification_policy
     SET revision = ?,
         cat_approval = ?, cat_ask = ?, cat_failure = ?, cat_interrupted = ?,
         cat_reply = ?, cat_routine_result = ?,
         quiet_enabled = ?, quiet_start = ?, quiet_end = ?, quiet_tz = ?
     WHERE singleton = 1`,
    [
      newRevision,
      updatedCategories.approval ? 1 : 0,
      updatedCategories.ask ? 1 : 0,
      updatedCategories.failure ? 1 : 0,
      updatedCategories.interrupted ? 1 : 0,
      updatedCategories.reply ? 1 : 0,
      updatedCategories.routine_result ? 1 : 0,
      updatedQuiet.enabled ? 1 : 0,
      updatedQuiet.start,
      updatedQuiet.end,
      updatedQuiet.time_zone,
    ],
  );

  return getNotificationPolicy(ctx);
}

export function getSessionNotificationPreference(
  ctx: StoreContext,
  sessionId: string,
): SessionNotificationPreference {
  const row = ctx.db
    .query<{ muted: number; revision: number }, [string]>(
      "SELECT muted, revision FROM session_notification_preferences WHERE session_id = ?",
    )
    .get(sessionId);

  return {
    muted: Boolean(row?.muted ?? 0),
    revision: row?.revision ?? 0,
  };
}

export function setSessionNotificationPreference(
  ctx: StoreContext,
  sessionId: string,
  muted: boolean,
  ifRevision: number,
): SessionNotificationPreference {
  const current = getSessionNotificationPreference(ctx, sessionId);
  if (current.revision !== ifRevision) {
    throw new HttpError(
      409,
      "revision_conflict",
      `session notification preference revision conflict: expected ${ifRevision}, actual ${current.revision}`,
    );
  }

  const nextRevision = current.revision + 1;
  ctx.db.run(
    `INSERT INTO session_notification_preferences (session_id, muted, revision)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET muted = excluded.muted, revision = excluded.revision`,
    [sessionId, muted ? 1 : 0, nextRevision],
  );

  return { muted, revision: nextRevision };
}

export type NotificationDeviceRow = {
  receiver_id: string;
  revision: number;
  enabled: number;
  sound: string;
  preview: string;
  badge: number;
  push_generation: number;
  planned_ordinal: number;
  last_invalid_endpoint_hash: string | null;
  last_invalid_reason: string | null;
  last_attempt_at: number | null;
  next_send_at: number | null;
  last_diagnostics: string | null;
};

export function getNotificationDeviceRow(
  ctx: StoreContext,
  receiverId: string,
): NotificationDeviceRow | null {
  return (
    ctx.db
      .query<NotificationDeviceRow, [string]>(
        "SELECT * FROM notification_devices WHERE receiver_id = ?",
      )
      .get(receiverId) ?? null
  );
}

export function getNotificationDevice(
  ctx: StoreContext,
  receiverId: string,
): NotificationDevice {
  const row = ctx.db
    .query<{
      receiver_id: string;
      revision: number;
      enabled: number;
      sound: string;
      preview: string;
      badge: number;
    }, [string]>("SELECT * FROM notification_devices WHERE receiver_id = ?")
    .get(receiverId);

  if (!row) {
    return {
      receiver_id: receiverId,
      revision: 0,
      enabled: false,
      sound: "default",
      preview: "generic",
      badge: true,
    };
  }

  return {
    receiver_id: row.receiver_id,
    revision: row.revision,
    enabled: Boolean(row.enabled),
    sound: (row.sound as "off" | "default" | "system") || "default",
    preview: (row.preview as "generic" | "reply_excerpt") || "generic",
    badge: Boolean(row.badge),
  };
}

export function updateNotificationDevice(
  ctx: StoreContext,
  receiverId: string,
  patch: Partial<NotificationDevice> & { if_revision: number },
): NotificationDevice {
  const current = getNotificationDevice(ctx, receiverId);
  if (current.revision !== patch.if_revision) {
    throw new HttpError(
      409,
      "revision_conflict",
      `device revision conflict: expected ${patch.if_revision}, actual ${current.revision}`,
    );
  }

  const nextRevision = current.revision + 1;
  const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
  const sound = patch.sound ?? current.sound;
  const preview = patch.preview ?? current.preview;
  const badge = patch.badge !== undefined ? patch.badge : current.badge;

  if (sound !== "off" && sound !== "default" && sound !== "system") {
    throw new HttpError(422, "invalid_arg", `invalid sound value: ${sound}`);
  }
  if (preview !== "generic" && preview !== "reply_excerpt") {
    throw new HttpError(422, "invalid_arg", `invalid preview value: ${preview}`);
  }

  ctx.db.run(
    `INSERT INTO notification_devices (receiver_id, revision, enabled, sound, preview, badge)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(receiver_id) DO UPDATE SET
       revision = excluded.revision,
       enabled = excluded.enabled,
       sound = excluded.sound,
       preview = excluded.preview,
       badge = excluded.badge`,
    [receiverId, nextRevision, enabled ? 1 : 0, sound, preview, badge ? 1 : 0],
  );

  return getNotificationDevice(ctx, receiverId);
}

export function validateContactUri(uri: string | null): string | null {
  if (uri === null || uri === "") return null;
  if (typeof uri !== "string") {
    throw new HttpError(422, "invalid_args", "contact_uri must be a string or null");
  }
  if (Buffer.byteLength(uri, "utf-8") > 512) {
    throw new HttpError(422, "invalid_args", "contact_uri must not exceed 512 bytes");
  }
  if (/[\x00-\x1f\x7f]/.test(uri)) {
    throw new HttpError(422, "invalid_args", "contact_uri must not contain control characters");
  }
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("mailto:")) {
    const email = trimmed.slice(7);
    if (email.includes(" ") || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(email)) {
      throw new HttpError(422, "invalid_args", "invalid mailto address");
    }
    return trimmed;
  }
  if (trimmed.startsWith("https://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new HttpError(422, "invalid_args", "invalid https contact url");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new HttpError(422, "invalid_args", "invalid https contact url");
    }
    return trimmed;
  }
  throw new HttpError(422, "invalid_args", "contact_uri must start with https:// or mailto:");
}

export function getNotificationPushConfig(ctx: StoreContext): NotificationPushConfig {
  const row = ctx.db
    .query<{ contact_uri: string | null; revision: number }, []>(
      "SELECT contact_uri, revision FROM notification_push_config WHERE singleton = 1",
    )
    .get();
  if (!row) {
    return { contact_uri: null, revision: 1, contact_configured: false };
  }
  return {
    contact_uri: row.contact_uri,
    revision: row.revision,
    contact_configured: Boolean(row.contact_uri && row.contact_uri.length > 0),
  };
}

export function updateNotificationPushConfig(
  ctx: StoreContext,
  contactUri: string | null,
  ifRevision: number,
): NotificationPushConfig {
  const current = getNotificationPushConfig(ctx);
  if (current.revision !== ifRevision) {
    throw new HttpError(
      409,
      "revision_conflict",
      `push config revision conflict: expected ${ifRevision}, actual ${current.revision}`,
    );
  }
  const validated = validateContactUri(contactUri);
  const nextRevision = current.revision + 1;
  ctx.db.run(
    `INSERT INTO notification_push_config (singleton, contact_uri, revision)
     VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       contact_uri = excluded.contact_uri,
       revision = excluded.revision`,
    [validated, nextRevision],
  );
  return getNotificationPushConfig(ctx);
}
