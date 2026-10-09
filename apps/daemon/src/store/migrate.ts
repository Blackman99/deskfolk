/**
 * Schema catch-up for databases created by earlier builds. `SCHEMA_SQL` only creates what is
 * missing, so every column or table added after a table first shipped is patched in here.
 * Runs once per open, before the store hands out any row.
 */
import type { Database } from "bun:sqlite";
import { ulid } from "../ids";
import { migrateDelegations } from "./delegation-migration";
import { migrateEndReasons } from "./end-reason-migration";
import { migrateExternalJobs, migrateStrayExternalJobs } from "./external-jobs-migration";
import { migrateFiling } from "./filing-migration";
import { HELD_TURN_TRIGGERS, migrateStopsForNow } from "./holds";
import { migrateLargeJobs } from "./large-job-migration";
import { migrateLessons } from "./lessons";
import { migrateMessageEdits } from "./message-edits";
import { migrateMessageWithdraw } from "./message-withdraw";
import { backfillQuotes, migrateAnnotations, migrateAskChoices, migrateMessageControl } from "./message-migration";
import { migrateModelDefaults } from "./model-defaults";
import { migrateNotifications } from "./notification-migration";
import { migrateAcceptanceCheckKinds, migrateDerivedChecks, migrateNullableTaskSession, migratePlans, migrateRequirements, migrateTaskBriefs } from "./plan-migration";
import { REQUIREMENT_CARD_TRIGGERS, settleAnsweredLegacyCards } from "./plan-requirements";
import { migratePrompts } from "./prompts";
import { migrateQuality } from "./quality";
import { QUOTE_TRIGGERS } from "./quotes";
import { migrateReflections } from "./reflection";
import { REQUIREMENT_TRIGGERS } from "./requirements";
import { migrateRetrospectives } from "./retrospectives";
import { migrateBotThinkingPins, migrateRouteTables } from "./route-migration";
import { migrateSharedSkills } from "./shared-skills";
import { migrateSpendLedger, migrateSpendPurpose } from "./spend-migration";
import { migrateSubmissions, SUBMISSION_TRIGGERS } from "./submission-migration";
import { migrateSupervisor } from "./supervisor-migration";
import { DORMANT_PLAN_TRIGGERS } from "./tasks";
import { migrateToolExecutions } from "./tool-execution-migration";
import { lapseSupersededWorkQuestions, WORK_QUESTION_TRIGGERS } from "./work-questions";

export function migrateSchema(db: Database): void {
  const turnCols = db.query<{ name: string }, []>("PRAGMA table_info(turns)").all();
  if (!turnCols.some((column) => column.name === "partial_text")) db.run("ALTER TABLE turns ADD COLUMN partial_text TEXT");
  // First, before anything below writes a turn: the hold triggers read it, and a trigger naming a
  // column the table lacks fails every write it fires on.
  if (!turnCols.some((column) => column.name === "mode")) {
    db.run("ALTER TABLE turns ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('work', 'desk', 'readonly'))");
  }
  const participantCols = db.query<{ name: string }, []>("PRAGMA table_info(session_participants)").all();
  if (participantCols.length > 0 && !participantCols.some((column) => column.name === "is_lead")) {
    db.run("ALTER TABLE session_participants ADD COLUMN is_lead INTEGER NOT NULL DEFAULT 0");
  }
  if (!turnCols.some((column) => column.name === "work_item_id")) {
    db.run("ALTER TABLE turns ADD COLUMN work_item_id TEXT");
  }
  // I1 only needs work_item_id. I1b also needs task_id, added later in migrateRouteTables.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS turns_one_live_per_item ON turns (work_item_id)
    WHERE work_item_id IS NOT NULL AND status IN ('running', 'waiting_approval', 'waiting_ask')`);
  // `acceptance_checks`/`acceptance_check_runs` are new tables, so SCHEMA_SQL's own
  // `CREATE TABLE IF NOT EXISTS` brings them up (and indexes) on an old database too. `turn_runs`
  // already existed, so its new column needs the same guarded ALTER every other one here gets.
  const turnRunCols = db.query<{ name: string }, []>("PRAGMA table_info(turn_runs)").all().map((column) => column.name);
  if (turnRunCols.length > 0 && !turnRunCols.includes("cwd")) db.run("ALTER TABLE turn_runs ADD COLUMN cwd TEXT");
  // What the command card under a finished turn's reply reads (2026-10-06).
  for (const [column, type] of [["tool_call_id", "TEXT"], ["duration_ms", "INTEGER"], ["output", "TEXT"]] as const) {
    if (turnRunCols.length > 0 && !turnRunCols.includes(column)) db.run(`ALTER TABLE turn_runs ADD COLUMN ${column} ${type}`);
  }
  // The status line the app writes for a 进度询问 is a `system` message like any other — visible in
  // the conversation, search and unread — except no Bot's context window or the organizer's payload
  // should ever read it back: it is the app answering you, not something anyone here said. This
  // column is that mark; `listMainMessages` and `taskMessagesSince` filter on it.
  const statusLineCols = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((column) => column.name);
  if (!statusLineCols.includes("hidden_from_bots")) {
    db.run("ALTER TABLE messages ADD COLUMN hidden_from_bots INTEGER NOT NULL DEFAULT 0");
  }
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
  // Who runs the Bot's turns (ADR 0061): NULL is the app's own hop loop on an endpoint. Existing
  // rows get NULL, which the CHECK lets through, so SQLite accepts it on ADD COLUMN.
  if (!botCols.includes("runner")) {
    db.run(`ALTER TABLE bots ADD COLUMN runner TEXT CHECK (runner IS NULL OR runner IN ('claude_code'))`);
  }
  // Its Claude model and effort, apart from the endpoint pin: the app's own calls about this Bot
  // (whether to join a group line, say) still run on an endpoint.
  if (!botCols.includes("agent_model")) db.run(`ALTER TABLE bots ADD COLUMN agent_model TEXT`);
  if (!botCols.includes("agent_effort")) {
    db.run(`ALTER TABLE bots ADD COLUMN agent_effort TEXT CHECK (agent_effort IS NULL OR agent_effort IN ('low', 'medium', 'high', 'xhigh', 'max'))`);
  }
  // Which of your Claude accounts its turns spend: NULL is whichever Claude Code finds in the daemon's environment.
  if (!botCols.includes("agent_config_dir")) db.run(`ALTER TABLE bots ADD COLUMN agent_config_dir TEXT`);
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
        api_format TEXT NOT NULL DEFAULT 'openai',
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
  // Every endpoint before this column spoke Chat Completions.
  if (!providerCols.includes("api_format")) {
    db.run(`ALTER TABLE providers ADD COLUMN api_format TEXT NOT NULL DEFAULT 'openai'`);
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
  migrateTaskBriefs(db);
  migratePlans(db);
  migrateBotThinkingPins(db);
  migrateSpendLedger(db);
  migrateSpendPurpose(db);
  migrateAcceptanceCheckKinds(db);
  migrateDerivedChecks(db);
  migrateAnnotations(db);
  migrateAskChoices(db);
  migrateMessageControl(db);
  migrateMessageEdits(db);
  migrateMessageWithdraw(db);
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
  if (!tables.includes("remote_screen")) {
    // The remote screen's switch and ICE servers: the window's to set, never a phone's.
    db.run(`
      CREATE TABLE IF NOT EXISTS remote_screen (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        ice_servers TEXT NOT NULL DEFAULT '[]'
      )
    `);
  }
  migrateNotifications(db);
  backfillQuotes(db);
  migrateRequirements(db);
  migrateFiling(db);
  migrateDelegations(db);
  migrateEndReasons(db);
  migrateSupervisor(db);
  migrateToolExecutions(db);
  migrateSubmissions(db);
  // Before anything reads it: a draft's table of that name, without the columns readers use.
  migrateStrayExternalJobs(db);
  migrateExternalJobs(db);
  migrateModelDefaults(db);
  migrateQuality(db);
  migrateLessons(db);
  migrateReflections(db);
  migrateRetrospectives(db);
  migrateSharedSkills(db);
  migrateLargeJobs(db);
  // Built-in prompts you edited and every change to them (ADR 0064).
  migratePrompts(db);
  // After every column tasks gains above (the rebuild copies the table as it then stands), and
  // before the triggers below, which are made again over the rebuilt table.
  migrateNullableTaskSession(db);
  // Every stop of yours is a stop for now (ADR 0071).
  migrateStopsForNow(db);
  // Made again on every open rather than if missing, so the triggers are always this build's own.
  // Last, after every column they read (tasks.dormant_since comes in migratePlans).
  for (const trigger of [...HELD_TURN_TRIGGERS, ...QUOTE_TRIGGERS, ...REQUIREMENT_TRIGGERS, ...DORMANT_PLAN_TRIGGERS, ...SUBMISSION_TRIGGERS, ...WORK_QUESTION_TRIGGERS, ...REQUIREMENT_CARD_TRIGGERS]) {
    db.run(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    db.run(trigger.sql);
  }
  lapseSupersededWorkQuestions(db);
  settleAnsweredLegacyCards(db);
}
