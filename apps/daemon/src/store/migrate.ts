/**
 * Schema catch-up for databases created by earlier builds. `SCHEMA_SQL` only creates what is
 * missing, so every column or table added after a table first shipped is patched in here.
 * Runs once per open, before the store hands out any row.
 */
import type { Database } from "bun:sqlite";
import { sortThinkingLevels, THINKING_LEVELS } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { taskDirName, taskTitle, TASK_QUIET_MS } from "./tasks";
import { parseStoredCatalog } from "../models";
import { pickThinkingLevel } from "../route-decision";

export function migrateSchema(db: Database): void {
  const turnCols = db.query<{ name: string }, []>("PRAGMA table_info(turns)").all();
  if (!turnCols.some((column) => column.name === "partial_text")) db.run("ALTER TABLE turns ADD COLUMN partial_text TEXT");
  const remoteDeviceCols = db.query<{ name: string }, []>("PRAGMA table_info(remote_devices)").all();
  if (!remoteDeviceCols.some((column) => column.name === "last_active_at")) {
    db.run("ALTER TABLE remote_devices ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0");
  }
  const keyCols = db.query<{ name: string }, []>("PRAGMA table_info(pending_keys)").all().map((row) => row.name);
  for (const column of ["operation_id", "device_id", "request_id"]) {
    if (!keyCols.includes(column)) db.run(`ALTER TABLE pending_keys ADD COLUMN ${column} TEXT`);
  }
  for (const row of db.query<{ name: string }, []>("SELECT name FROM pending_keys WHERE operation_id IS NULL").all()) {
    db.run("UPDATE pending_keys SET operation_id = ? WHERE name = ?", [ulid(), row.name]);
  }
  for (const receipt of db.query<{ device_id: string; request_id: string; key_ops: string }, []>("SELECT device_id, request_id, key_ops FROM request_receipts WHERE state = 'pending_keys'").all()) {
    for (const op of JSON.parse(receipt.key_ops) as Array<{ name: string }>) {
      db.run("UPDATE pending_keys SET device_id = ?, request_id = ? WHERE name = ? AND device_id IS NULL", [receipt.device_id, receipt.request_id, op.name]);
    }
  }
  for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    db.run(`CREATE TRIGGER IF NOT EXISTS provider_settings_rev_${event.toLowerCase()} AFTER ${event} ON providers
      BEGIN UPDATE request_meta SET settings_rev = settings_rev + 1 WHERE singleton = 1; END`);
  }
  const botCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(bots)`)
    .all()
    .map((row) => row.name);
  if (!botCols.includes("model")) {
    db.run(`ALTER TABLE bots ADD COLUMN model TEXT`);
  }
  if (!botCols.includes("avatar")) {
    db.run(`ALTER TABLE bots ADD COLUMN avatar TEXT`);
  }
  if (!botCols.includes("provider_id")) {
    db.run(`ALTER TABLE bots ADD COLUMN provider_id TEXT`);
  }
  if (!botCols.includes("thinking_level")) {
    db.run(`ALTER TABLE bots ADD COLUMN thinking_level TEXT`);
  }
  const revCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(profile_revisions)`)
    .all()
    .map((row) => row.name);
  if (!revCols.includes("avatar")) {
    db.run(`ALTER TABLE profile_revisions ADD COLUMN avatar TEXT`);
  }
  const sessionCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(sessions)`)
    .all()
    .map((row) => row.name);
  if (!sessionCols.includes("last_read_at")) {
    db.run(`ALTER TABLE sessions ADD COLUMN last_read_at TEXT`);
    db.run(`UPDATE sessions SET last_read_at = updated_at WHERE last_read_at IS NULL`);
  }
  if (!sessionCols.includes("archived_at")) {
    db.run(`ALTER TABLE sessions ADD COLUMN archived_at TEXT`);
  }
  // A Bot↔Bot direct records the message that opened it; sessions made before this have none.
  if (!sessionCols.includes("origin_session_id")) {
    db.run(`ALTER TABLE sessions ADD COLUMN origin_session_id TEXT`);
  }
  if (!sessionCols.includes("origin_message_id")) {
    db.run(`ALTER TABLE sessions ADD COLUMN origin_message_id TEXT`);
  }
  db.run(
    `CREATE INDEX IF NOT EXISTS sessions_origin_message ON sessions (origin_message_id)`,
  );
  const tables = db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((row) => row.name);
  if (!tables.includes("providers")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        models TEXT NOT NULL,
        available_models TEXT NOT NULL DEFAULT '[]',
        default_model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }
  const providerCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(providers)`)
    .all()
    .map((row) => row.name);
  if (!providerCols.includes("available_models")) {
    db.run(`ALTER TABLE providers ADD COLUMN available_models TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!tables.includes("turn_route_decisions")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS turn_route_decisions (
        turn_id TEXT PRIMARY KEY REFERENCES turns (id),
        session_id TEXT NOT NULL REFERENCES sessions (id),
        trigger_message_id TEXT NOT NULL REFERENCES messages (id),
        model TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }
  const mcpCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(mcp_servers)`)
    .all()
    .map((row) => row.name);
  if (!mcpCols.includes("instructions")) {
    db.run(`ALTER TABLE mcp_servers ADD COLUMN instructions TEXT`);
  }
  if (!mcpCols.includes("tool_catalog")) {
    db.run(`ALTER TABLE mcp_servers ADD COLUMN tool_catalog TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!mcpCols.includes("usage_note")) {
    db.run(`ALTER TABLE mcp_servers ADD COLUMN usage_note TEXT`);
  }
  if (!mcpCols.includes("transport")) {
    db.run(`ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'stdio'`);
  }
  if (!mcpCols.includes("url")) {
    db.run(`ALTER TABLE mcp_servers ADD COLUMN url TEXT`);
  }
  if (!mcpCols.includes("headers")) {
    db.run(`ALTER TABLE mcp_servers ADD COLUMN headers TEXT NOT NULL DEFAULT '[]'`);
  }
  const approvalCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(approvals)`)
    .all()
    .map((row) => row.name);
  if (!approvalCols.includes("requires_api_key")) {
    db.run(`ALTER TABLE approvals ADD COLUMN requires_api_key INTEGER NOT NULL DEFAULT 0`);
  }
  if (!tables.includes("skills")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots (id),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        body TEXT NOT NULL,
        uses TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS skills_bot_name ON skills (bot_id, lower(name))`);
  }
  if (!tables.includes("memories")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots (id),
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        source_session_id TEXT,
        source_message_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS memories_bot_subject ON memories (bot_id, lower(subject))`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS memories_bot_recent ON memories (bot_id, updated_at)`);
  const skillCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(skills)`)
    .all()
    .map((row) => row.name);
  if (!skillCols.includes("uses")) {
    db.run(`ALTER TABLE skills ADD COLUMN uses TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!tables.includes("route_feedback")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS route_feedback (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns (id),
        message_id TEXT NOT NULL REFERENCES messages (id),
        model TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        signature TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }
  migrateRouteTables(db, tables);
  migrateBotThinkingPins(db);
  if (!tables.includes("terminals")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS terminals (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        rows INTEGER NOT NULL,
        cols INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        scrollback BLOB NOT NULL
      )
    `);
  }
  if (!tables.includes("remote_push_subs")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS remote_push_subs (
        device_id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        endpoint_hash TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expires_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS remote_push_subs_hash ON remote_push_subs(endpoint_hash)`);
  }
  migrateNotifications(db);
}

/**
 * A thinking level belongs to a model, so a Bot is either automatic about both or explicit about
 * both. Databases written before that rule can hold half a pin: a level with no model (nothing for
 * it to apply to) or a model with no level. The first is dropped; the second lands on the level the
 * router would have picked for an ordinary message on that model.
 */
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

function migrateNotifications(db: Database): void {
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

function migrateBotThinkingPins(db: Database): void {
  db.run(`UPDATE bots SET thinking_level = NULL WHERE model IS NULL AND thinking_level IS NOT NULL`);
  const halfPinned = db
    .query<{ id: string; model: string; provider_id: string | null }, []>(
      `SELECT id, model, provider_id FROM bots WHERE model IS NOT NULL AND thinking_level IS NULL`,
    )
    .all();
  if (halfPinned.length === 0) return;
  const providers = db
    .query<{ id: string; models: string }, []>(`SELECT id, models FROM providers`)
    .all();
  for (const bot of halfPinned) {
    const rows = bot.provider_id ? providers.filter((row) => row.id === bot.provider_id) : providers;
    const levels: string[] = [];
    for (const row of rows) {
      for (const entry of parseStoredCatalog(row.models)) {
        if (entry.name !== bot.model) continue;
        levels.push(...(entry.thinking_levels.length > 0 ? entry.thinking_levels : THINKING_LEVELS));
      }
    }
    const supported = levels.length > 0 ? sortThinkingLevels(levels) : [...THINKING_LEVELS];
    db.run(`UPDATE bots SET thinking_level = ? WHERE id = ?`, [
      pickThinkingLevel("general", supported),
      bot.id,
    ]);
  }
}

type LegacyPenalty = { signature: string; model: string; thinkingLevel: string; penalty: number };

/**
 * Model-choice records gained the Bot and endpoint they belonged to, plus how the turn ended.
 * The roster-wide `route_learned` settings blob becomes per-Bot rows: every Bot alive at upgrade
 * time inherits the old penalties as its own starting experience, so no Bot's routing changes on
 * the day of the upgrade; from then on only its own turns move its rows.
 */
/**
 * Jobs for the turns that happened before jobs existed.
 *
 * Without this the trace of anything older than the work-dir release is not merely incomplete,
 * it is wrong: the turns that do carry a job show up, the ones that do not are missing, and a
 * turn whose waker is missing reads as though **you** sent the message that woke it. Reading the
 * picture then means reading a handoff as your own instruction.
 *
 * The rule is the one `resolveTurnTask` already uses, walked in order: inherit the waking turn's
 * job, else join the session's open job if it was still warm, else start one. Nothing is written
 * to disk — a backfilled job names a folder that was never created, which is the same state a
 * job that only talked is in today, since a work dir is made the first time something uses it.
 * They are closed, so nothing new joins them.
 */
function backfillTaskAttribution(db: Database): void {
  type Pending = { id: string; session_id: string; created_at: string; waker: string | null; body: string };
  const pending = db
    .query<Pending, []>(
      `SELECT t.id, t.session_id, t.created_at, m.turn_id AS waker, m.body AS body
       FROM turns t JOIN messages m ON m.id = t.trigger_message_id
       WHERE t.task_id IS NULL
       ORDER BY t.created_at ASC, t.id ASC`,
    )
    .all();
  if (!pending.length) return;

  const taskOfTurn = new Map<string, string>();
  for (const row of db.query<{ id: string; task_id: string }, []>(
    `SELECT id, task_id FROM turns WHERE task_id IS NOT NULL`,
  ).all()) {
    taskOfTurn.set(row.id, row.task_id);
  }

  const taken = new Set<string>(
    db.query<{ dir: string }, []>(`SELECT dir FROM tasks`).all().map((row) => row.dir),
  );
  /** The job this pass last opened for a session, and when its newest turn ran. */
  const openPerSession = new Map<string, { id: string; lastAt: string }>();
  const assign = db.prepare(`UPDATE turns SET task_id = ? WHERE id = ?`);
  const insert = db.prepare(
    `INSERT INTO tasks (id, session_id, title, dir, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const turn of pending) {
      const inherited = turn.waker ? taskOfTurn.get(turn.waker) : undefined;
      let taskId = inherited;
      if (!taskId) {
        const open = openPerSession.get(turn.session_id);
        const warm =
          open && Date.parse(turn.created_at) - Date.parse(open.lastAt) <= TASK_QUIET_MS;
        if (warm && open) taskId = open.id;
      }
      if (!taskId) {
        const at = new Date(Date.parse(turn.created_at) || Date.now());
        const id = ulid(at.getTime());
        const title = taskTitle(turn.body);
        let dir = "";
        for (const suffixLength of [4, 8, 26]) {
          dir = taskDirName({ title, id, at, suffixLength });
          if (!taken.has(dir)) break;
        }
        taken.add(dir);
        insert.run(id, turn.session_id, title, dir, turn.created_at, turn.created_at);
        taskId = id;
      }
      assign.run(taskId, turn.id);
      taskOfTurn.set(turn.id, taskId);
      const open = openPerSession.get(turn.session_id);
      if (!inherited || !open || open.id === taskId) {
        openPerSession.set(turn.session_id, { id: taskId, lastAt: turn.created_at });
      }
    }
    // A message belongs to the job its turn does. User messages have no turn and stay unassigned,
    // which is what the runtime does with them too.
    db.run(
      `UPDATE messages SET task_id = (SELECT task_id FROM turns WHERE turns.id = messages.turn_id)
       WHERE task_id IS NULL AND turn_id IS NOT NULL`,
    );
  })();
}

function migrateRouteTables(db: Database, tables: string[]): void {
  // Work dirs: every turn and every message it produced belong to one job's folder. Old rows have
  // none, so their artifacts stay where they were written and nothing is moved under `work/`.
  const turnCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(turns)`)
    .all()
    .map((row) => row.name);
  if (!turnCols.includes("task_id")) {
    db.run(`ALTER TABLE turns ADD COLUMN task_id TEXT`);
  }
  const messageTaskCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(messages)`)
    .all()
    .map((row) => row.name);
  if (!messageTaskCols.includes("task_id")) {
    db.run(`ALTER TABLE messages ADD COLUMN task_id TEXT`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS messages_task ON messages (task_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS turns_task ON turns (task_id, last_activity_at)`);
  backfillTaskAttribution(db);

  const decisionCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(turn_route_decisions)`)
    .all()
    .map((row) => row.name);
  if (!decisionCols.includes("bot_id")) {
    db.run(`ALTER TABLE turn_route_decisions ADD COLUMN bot_id TEXT NOT NULL DEFAULT ''`);
    db.run(
      `UPDATE turn_route_decisions
       SET bot_id = COALESCE((SELECT bot_id FROM turns WHERE turns.id = turn_route_decisions.turn_id), '')
       WHERE bot_id = ''`,
    );
  }
  if (!decisionCols.includes("provider_id")) {
    db.run(`ALTER TABLE turn_route_decisions ADD COLUMN provider_id TEXT`);
  }
  if (!decisionCols.includes("outcome")) {
    db.run(
      `ALTER TABLE turn_route_decisions ADD COLUMN outcome TEXT CHECK (
         outcome IS NULL OR outcome IN ('completed', 'failed', 'stopped', 'redirected', 'interrupted')
       )`,
    );
  }
  if (!decisionCols.includes("fail_kind")) {
    db.run(`ALTER TABLE turn_route_decisions ADD COLUMN fail_kind TEXT`);
  }
  if (!decisionCols.includes("finished_at")) {
    db.run(`ALTER TABLE turn_route_decisions ADD COLUMN finished_at TEXT`);
  }
  // The agent that picks now says why, and marks whether a message continued the one before it.
  if (!decisionCols.includes("reason")) {
    db.run(`ALTER TABLE turn_route_decisions ADD COLUMN reason TEXT`);
  }
  if (!decisionCols.includes("chain_id")) {
    db.run(`ALTER TABLE turn_route_decisions ADD COLUMN chain_id TEXT`);
    // Old decisions were never chained; each stands alone so nothing reviews them as a group.
    db.run(`UPDATE turn_route_decisions SET chain_id = turn_id WHERE chain_id IS NULL`);
  }
  // Counts of what the turn actually did. Left null on rows a previous build already closed:
  // a review treats null as "not counted", never as a clean zero.
  for (const column of ["hops", "tool_calls", "tool_errors", "repeated_failures", "files_written"]) {
    if (!decisionCols.includes(column)) {
      db.run(`ALTER TABLE turn_route_decisions ADD COLUMN ${column} INTEGER`);
    }
  }
  db.run(
    `CREATE INDEX IF NOT EXISTS turn_route_decisions_chain ON turn_route_decisions (chain_id)`,
  );
  // Decisions written before `outcome` existed still know how their turn ended: the turn does.
  // A live turn's row stays open. `failed` is a judgement about the completion, not the turn,
  // so an old row that failed reads as its turn's terminal state instead of being invented.
  db.run(
    `UPDATE turn_route_decisions
     SET outcome = (SELECT status FROM turns WHERE turns.id = turn_route_decisions.turn_id),
         finished_at = COALESCE(
           finished_at,
           (SELECT updated_at FROM turns WHERE turns.id = turn_route_decisions.turn_id)
         )
     WHERE outcome IS NULL
       AND (SELECT status FROM turns WHERE turns.id = turn_route_decisions.turn_id)
           IN ('completed', 'redirected', 'interrupted', 'stopped')`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS turn_route_decisions_session ON turn_route_decisions (session_id, created_at)`,
  );
  const feedbackCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(route_feedback)`)
    .all()
    .map((row) => row.name);
  if (tables.includes("route_feedback") && !feedbackCols.includes("bot_id")) {
    db.run(`ALTER TABLE route_feedback ADD COLUMN bot_id TEXT NOT NULL DEFAULT ''`);
    db.run(
      `UPDATE route_feedback
       SET bot_id = COALESCE((SELECT bot_id FROM turns WHERE turns.id = route_feedback.turn_id), '')
       WHERE bot_id = ''`,
    );
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS route_learned (
      bot_id TEXT NOT NULL REFERENCES bots (id),
      signature TEXT NOT NULL,
      model TEXT NOT NULL,
      thinking_level TEXT NOT NULL,
      negative REAL NOT NULL DEFAULT 0,
      positive REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, signature, model, thinking_level)
    )
  `);
  const reviewCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(route_reviews)`)
    .all()
    .map((row) => row.name);
  if (tables.includes("route_reviews") && !reviewCols.includes("chain_id")) {
    db.run(`ALTER TABLE route_reviews ADD COLUMN chain_id TEXT`);
    db.run(`UPDATE route_reviews SET chain_id = turn_id WHERE chain_id IS NULL OR chain_id = ''`);
  }
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS route_reviews_chain ON route_reviews (chain_id)`);
  const retiredCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(route_reviews)`)
    .all()
    .map((row) => row.name);
  if (tables.includes("route_reviews") && !retiredCols.includes("retired_at")) {
    db.run(`ALTER TABLE route_reviews ADD COLUMN retired_at TEXT`);
  }
  // Which closed chain a learning hop wrote this from. Turns that write their own row leave it null.
  const memoryCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(memories)`)
    .all()
    .map((row) => row.name);
  if (tables.includes("memories") && !memoryCols.includes("learned_chain_id")) {
    db.run(`ALTER TABLE memories ADD COLUMN learned_chain_id TEXT`);
  }
  const skillCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(skills)`)
    .all()
    .map((row) => row.name);
  if (tables.includes("skills") && !skillCols.includes("learned_chain_id")) {
    db.run(`ALTER TABLE skills ADD COLUMN learned_chain_id TEXT`);
  }
  const legacy = db
    .query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`)
    .get("route_learned");
  if (!legacy) return;
  const penalties = parseLegacyPenalties(legacy.value);
  const bots = db
    .query<{ id: string }, []>(`SELECT id FROM bots WHERE deleted_at IS NULL`)
    .all()
    .map((row) => row.id);
  const now = isoNow();
  db.transaction(() => {
    for (const botId of bots) {
      for (const row of penalties) {
        db.run(
          `INSERT INTO route_learned (bot_id, signature, model, thinking_level, negative, positive, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(bot_id, signature, model, thinking_level) DO UPDATE SET
             negative = route_learned.negative + excluded.negative,
             updated_at = excluded.updated_at`,
          [botId, row.signature, row.model, row.thinkingLevel, row.penalty, now],
        );
      }
    }
    db.run(`DELETE FROM settings WHERE key = ?`, ["route_learned"]);
  })();
}

function parseLegacyPenalties(raw: string): LegacyPenalty[] {
  try {
    const parsed = JSON.parse(raw) as { penalties?: unknown };
    if (!parsed || !Array.isArray(parsed.penalties)) return [];
    return parsed.penalties.filter(
      (row): row is LegacyPenalty =>
        Boolean(row) &&
        typeof row.signature === "string" &&
        typeof row.model === "string" &&
        typeof row.thinkingLevel === "string" &&
        typeof row.penalty === "number" &&
        row.penalty > 0,
    );
  } catch {
    return [];
  }
}
