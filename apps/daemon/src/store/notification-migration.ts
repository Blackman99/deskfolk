/** Schema catch-up for notifications: the tables, columns and first rows older databases lack. */
import type { Database } from "bun:sqlite";
import { ulid } from "../ids";

function backfillInitialNotifications(db: Database): void {
  const pendingApprovals = db.query<{
    id: string;
    turn_id: string;
    message_id: string | null;
    created_at: string;
    session_id: string;
  }, []>(`
    SELECT a.id, a.turn_id, a.message_id, a.created_at, t.session_id
    FROM approvals a
    JOIN turns t ON t.id = a.turn_id
    WHERE a.status = 'pending'
  `).all();

  for (const app of pendingApprovals) {
    const semKey = `approval:${app.id}`;
    const exists = db.query("SELECT 1 FROM notifications WHERE semantic_key = ?").get(semKey);
    if (!exists) {
      db.run("UPDATE notification_counters SET val = val + 1 WHERE name = 'ordinal'");
      const ord = db.query<{ val: number }, []>("SELECT val FROM notification_counters WHERE name = 'ordinal'").get()!.val;
      db.run(`
        INSERT INTO notifications (
          id, ordinal, semantic_key, kind, session_id, message_id, turn_id, approval_id, created_at, action_state, revision
        ) VALUES (?, ?, ?, 'approval', ?, ?, ?, ?, ?, 'open', 1)
      `, [ulid(), ord, semKey, app.session_id, app.message_id, app.turn_id, app.id, app.created_at]);
    }
  }
}

export function migrateNotifications(db: Database): void {
  const tables = db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((row) => row.name);

  if (!tables.includes("notification_counters")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS notification_counters (
        name TEXT PRIMARY KEY,
        val INTEGER NOT NULL
      )
    `);
  }
  db.run(`INSERT OR IGNORE INTO notification_counters (name, val) VALUES ('ordinal', 0), ('message_seq', 0), ('cleanup_revision', 1)`);

  const messageCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(messages)`)
    .all()
    .map((row) => row.name);
  if (!messageCols.includes("message_seq")) {
    db.run(`ALTER TABLE messages ADD COLUMN message_seq INTEGER NOT NULL DEFAULT 0`);
  }
  const unsequenced = db
    .query<{ id: string }, []>(`SELECT id FROM messages WHERE message_seq = 0 ORDER BY created_at ASC, id ASC`)
    .all();
  if (unsequenced.length > 0) {
    const currentMax = db.query<{ max_seq: number | null }, []>(`SELECT MAX(message_seq) as max_seq FROM messages`).get()?.max_seq ?? 0;
    let seq = currentMax;
    db.transaction(() => {
      for (const row of unsequenced) {
        seq += 1;
        db.run(`UPDATE messages SET message_seq = ? WHERE id = ?`, [seq, row.id]);
      }
      db.run(`UPDATE notification_counters SET val = MAX(val, ?) WHERE name = 'message_seq'`, [seq]);
    })();
  }
  db.run(`CREATE INDEX IF NOT EXISTS messages_session_seq ON messages (session_id, message_seq)`);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_assign_seq AFTER INSERT ON messages
    WHEN NEW.message_seq IS NULL OR NEW.message_seq = 0
    BEGIN
      UPDATE notification_counters SET val = val + 1 WHERE name = 'message_seq';
      UPDATE messages SET message_seq = (SELECT val FROM notification_counters WHERE name = 'message_seq')
        WHERE id = NEW.id;
    END
  `);

  const sessionCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(sessions)`)
    .all()
    .map((row) => row.name);
  if (!sessionCols.includes("read_through_seq")) {
    db.run(`ALTER TABLE sessions ADD COLUMN read_through_seq INTEGER NOT NULL DEFAULT 0`);
    db.run(`
      UPDATE sessions
      SET read_through_seq = COALESCE(
        (SELECT MAX(message_seq) FROM messages WHERE messages.session_id = sessions.id AND messages.created_at <= sessions.last_read_at),
        0
      )
      WHERE last_read_at IS NOT NULL
    `);
  }

  const turnCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(turns)`)
    .all()
    .map((row) => row.name);
  if (!turnCols.includes("pending_ask_id")) {
    db.run(`ALTER TABLE turns ADD COLUMN pending_ask_id TEXT REFERENCES messages (id) ON DELETE SET NULL`);
  }
  if (!turnCols.includes("routine_id")) {
    db.run(`ALTER TABLE turns ADD COLUMN routine_id TEXT REFERENCES routines (id) ON DELETE SET NULL`);
  }
  if (!turnCols.includes("routine_due_at")) {
    db.run(`ALTER TABLE turns ADD COLUMN routine_due_at TEXT`);
  }

  const pushCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(remote_push_subs)`)
    .all()
    .map((row) => row.name);
  if (!pushCols.includes("generation")) {
    db.run(`ALTER TABLE remote_push_subs ADD COLUMN generation INTEGER NOT NULL DEFAULT 1`);
  }
  if (!pushCols.includes("vapid_fingerprint")) {
    db.run(`ALTER TABLE remote_push_subs ADD COLUMN vapid_fingerprint TEXT`);
  }
  if (!pushCols.includes("last_diagnostics")) {
    db.run(`ALTER TABLE remote_push_subs ADD COLUMN last_diagnostics TEXT`);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE,
      semantic_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('approval', 'ask', 'failure', 'interrupted', 'reply', 'routine_result')),
      session_id TEXT REFERENCES sessions (id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages (id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns (id) ON DELETE CASCADE,
      approval_id TEXT REFERENCES approvals (id) ON DELETE CASCADE,
      routine_id TEXT REFERENCES routines (id) ON DELETE SET NULL,
      routine_due_at TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT,
      terminal_at TEXT,
      action_state TEXT NOT NULL CHECK (action_state IN ('none', 'open', 'resolved', 'voided')),
      resolution_reason TEXT,
      fail_kind TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS notifications_ordinal ON notifications (ordinal)`);
  db.run(`CREATE INDEX IF NOT EXISTS notifications_kind_action ON notifications (kind, action_state)`);
  db.run(`CREATE INDEX IF NOT EXISTS notifications_unread ON notifications (read_at, ordinal)`);
  db.run(`CREATE INDEX IF NOT EXISTS notifications_session ON notifications (session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS notifications_retention ON notifications (terminal_at, ordinal) WHERE action_state != 'open'`);

  db.run(`
    CREATE TABLE IF NOT EXISTS notification_retention_notice (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      pruned_at TEXT NOT NULL,
      read_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notification_policy (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL DEFAULT 1,
      cat_approval INTEGER NOT NULL DEFAULT 1,
      cat_ask INTEGER NOT NULL DEFAULT 1,
      cat_failure INTEGER NOT NULL DEFAULT 1,
      cat_interrupted INTEGER NOT NULL DEFAULT 1,
      cat_reply INTEGER NOT NULL DEFAULT 1,
      cat_routine_result INTEGER NOT NULL DEFAULT 1,
      quiet_enabled INTEGER NOT NULL DEFAULT 0,
      quiet_start TEXT NOT NULL DEFAULT '22:00',
      quiet_end TEXT NOT NULL DEFAULT '08:00',
      quiet_tz TEXT NOT NULL DEFAULT 'UTC'
    )
  `);
  db.run(`
    INSERT OR IGNORE INTO notification_policy (singleton, revision, cat_approval, cat_ask, cat_failure, cat_interrupted, cat_reply, cat_routine_result, quiet_enabled, quiet_start, quiet_end, quiet_tz)
    VALUES (1, 1, 1, 1, 1, 1, 1, 1, 0, '22:00', '08:00', 'UTC')
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notification_push_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      contact_uri TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.run(`
    INSERT OR IGNORE INTO notification_push_config (singleton, contact_uri, revision)
    VALUES (1, NULL, 1)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS session_notification_preferences (
      session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
      muted INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notification_devices (
      receiver_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 0,
      sound TEXT NOT NULL DEFAULT 'default',
      preview TEXT NOT NULL DEFAULT 'generic',
      badge INTEGER NOT NULL DEFAULT 1,
      push_generation INTEGER NOT NULL DEFAULT 1,
      planned_ordinal INTEGER NOT NULL DEFAULT 0,
      last_invalid_endpoint_hash TEXT,
      last_invalid_reason TEXT,
      last_attempt_at INTEGER,
      next_send_at INTEGER,
      last_diagnostics TEXT
    )
  `);

  const devCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(notification_devices)`)
    .all()
    .map((row) => row.name);
  if (!devCols.includes("planned_ordinal")) {
    db.run(`ALTER TABLE notification_devices ADD COLUMN planned_ordinal INTEGER NOT NULL DEFAULT 0`);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      delivery_id TEXT PRIMARY KEY,
      receiver_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      batch_key TEXT NOT NULL,
      upper_ordinal INTEGER NOT NULL,
      click_ref TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'accepted', 'retry_wait', 'suppressed', 'expired', 'failed', 'unknown')),
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      absolute_expires_at INTEGER NOT NULL,
      claim_token TEXT,
      claim_expires_at INTEGER,
      permit TEXT,
      push_generation INTEGER NOT NULL DEFAULT 1,
      trust_generation INTEGER NOT NULL DEFAULT 1,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(receiver_id, channel, batch_key)
    )
  `);
  const deliveryCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(notification_deliveries)`)
    .all()
    .map((row) => row.name);
  if (!deliveryCols.includes("permit")) {
    db.run(`ALTER TABLE notification_deliveries ADD COLUMN permit TEXT`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS notification_deliveries_state ON notification_deliveries (state, next_attempt_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS notification_deliveries_receiver ON notification_deliveries (receiver_id, channel)`);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_active
      ON notification_deliveries (receiver_id, channel)
      WHERE state IN ('pending', 'claimed', 'retry_wait')
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notification_delivery_items (
      delivery_id TEXT NOT NULL REFERENCES notification_deliveries (delivery_id) ON DELETE CASCADE,
      notification_id TEXT NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
      PRIMARY KEY (delivery_id, notification_id)
    )
  `);

  backfillInitialNotifications(db);
}
