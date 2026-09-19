/**
 * Schema catch-up for databases created by earlier builds. `SCHEMA_SQL` only creates what is
 * missing, so every column or table added after a table first shipped is patched in here.
 * Runs once per open, before the store hands out any row.
 */
import type { Database } from "bun:sqlite";
import { sortThinkingLevels, THINKING_LEVELS } from "@real-bot/protocol";
import { isoNow } from "../ids";
import { parseStoredCatalog } from "../models";
import { pickThinkingLevel } from "../route-decision";

export function migrateSchema(db: Database): void {
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
}

/**
 * A thinking level belongs to a model, so a Bot is either automatic about both or explicit about
 * both. Databases written before that rule can hold half a pin: a level with no model (nothing for
 * it to apply to) or a model with no level. The first is dropped; the second lands on the level the
 * router would have picked for an ordinary message on that model.
 */
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
function migrateRouteTables(db: Database, tables: string[]): void {
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
