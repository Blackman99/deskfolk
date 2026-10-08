/** Schema catch-up for the spend ledger: its columns, purposes and indexes. */
import { SPEND_PURPOSE_KIND, type SpendPurpose } from "@real-bot/protocol";
import type { Database } from "bun:sqlite";

const SPEND_LEDGER_COLUMNS = [
  "session_name",
  "bot_name",
  "kind",
  "chain_id",
  "provider_id",
  "provider_name",
  "model",
  "thinking_level",
  "estimated_cost_usd_ticks",
];

/**
 * Spend became a ledger: every row carries the names and the model it was billed on, and nothing
 * that is deleted afterwards removes it. SQLite cannot drop a foreign key or a CHECK in place, so
 * an older table is copied into the new shape. A turn row takes its model from the route decision
 * that still exists; a judgement, or a turn whose history was cleared, keeps a blank model.
 */
export function migrateSpendLedger(db: Database): void {
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(spend)`)
    .all()
    .map((row) => row.name);
  // The kinds are a CHECK, which SQLite cannot widen in place: a ledger from before the organizer
  // (or, later, before acceptance checks could spend) is rebuilt the same way the pre-ledger table was.
  const shape = db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'spend'`).get()?.sql ?? "";
  if (
    cols.includes("kind") &&
    SPEND_LEDGER_COLUMNS.every((name) => cols.includes(name)) &&
    shape.includes("'organize'") &&
    shape.includes("'acceptance_check'")
  ) {
    createSpendIndexes(db);
    return;
  }
  // Create, copy, drop, and rename are one transaction. A crash after CREATE TABLE spend_ledger
  // would otherwise leave the old rows behind a table the next open treats as the new ledger.
  db.transaction(() => {
    db.run(`
      CREATE TABLE spend_ledger (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_name TEXT,
        bot_id TEXT,
        bot_name TEXT,
        turn_id TEXT,
        judgement_id TEXT,
        kind TEXT NOT NULL CHECK (
          kind IN ('turn', 'judgement', 'route_pick', 'route_review', 'route_learn', 'composer_suggest', 'organize', 'acceptance_check')
        ),
        chain_id TEXT,
        provider_id TEXT,
        provider_name TEXT,
        model TEXT,
        thinking_level TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        cached_tokens INTEGER,
        reasoning_tokens INTEGER,
        cost_usd_ticks INTEGER,
        estimated_cost_usd_ticks INTEGER,
        missing_reason TEXT CHECK (
          missing_reason IS NULL OR missing_reason IN ('stream_interrupted', 'endpoint_omitted')
        ),
        created_at TEXT NOT NULL,
        CHECK (
          (kind = 'turn' AND turn_id IS NOT NULL)
          OR (kind = 'judgement' AND judgement_id IS NOT NULL)
          OR (kind = 'route_pick' AND turn_id IS NOT NULL)
          OR (kind = 'route_review' AND chain_id IS NOT NULL AND turn_id IS NOT NULL)
          OR (kind = 'route_learn' AND chain_id IS NOT NULL)
          OR kind = 'composer_suggest'
          OR kind = 'organize'
          OR kind = 'acceptance_check'
        )
      )
    `);
    const has = (name: string) => cols.includes(name);
    const pick = (name: string, fallback: string) => (has(name) ? `spend.${name}` : fallback);
    db.run(`
      INSERT INTO spend_ledger (
        id, session_id, session_name, bot_id, bot_name, turn_id, judgement_id, kind, chain_id,
        provider_id, provider_name, model, thinking_level,
        input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens,
        cost_usd_ticks, estimated_cost_usd_ticks, missing_reason, created_at
      )
      SELECT
        spend.id,
        spend.session_id,
        ${pick("session_name", "session_title.session_name")},
        spend.bot_id,
        ${pick("bot_name", "bots.name")},
        spend.turn_id,
        spend.judgement_id,
        ${pick("kind", "CASE WHEN spend.turn_id IS NOT NULL THEN 'turn' ELSE 'judgement' END")},
        ${pick("chain_id", "NULL")},
        ${pick("provider_id", "decision.provider_id")},
        ${pick("provider_name", "providers.name")},
        ${pick("model", "decision.model")},
        ${pick("thinking_level", "decision.thinking_level")},
        spend.input_tokens,
        spend.output_tokens,
        spend.total_tokens,
        spend.cached_tokens,
        spend.reasoning_tokens,
        spend.cost_usd_ticks,
        ${pick("estimated_cost_usd_ticks", "NULL")},
        spend.missing_reason,
        spend.created_at
      FROM spend
      LEFT JOIN turn_route_decisions AS decision ON decision.turn_id = spend.turn_id
      LEFT JOIN providers ON providers.id = decision.provider_id
      LEFT JOIN bots ON bots.id = spend.bot_id
      LEFT JOIN (
        SELECT
          sessions.id AS session_id,
          CASE
            WHEN sessions.kind = 'group' THEN sessions.name
            ELSE (
              SELECT CASE
                WHEN COUNT(bots.name) <= 1 THEN MIN(bots.name)
                ELSE GROUP_CONCAT(bots.name, ' ↔ ')
              END
              FROM session_participants
              JOIN bots ON bots.id = session_participants.member
              WHERE session_participants.session_id = sessions.id
                AND session_participants.left_at IS NULL
                AND session_participants.member != 'user'
            )
          END AS session_name
        FROM sessions
      ) AS session_title ON session_title.session_id = spend.session_id
    `);
    db.run(`DROP TABLE spend`);
    db.run(`ALTER TABLE spend_ledger RENAME TO spend`);
    createSpendIndexes(db);
  })();
}

/**
 * What a call was for, where two uses share a kind (ADR 0042): a nullable column with its own
 * CHECK, added after the ledger rebuild above, which copies only the columns it knows. The rows
 * already there have none: before the scribe, every `organize` row was the organizer's.
 */
/** Every purpose a ledger row may carry: the protocol's list, so a new one widens the stored CHECK on the next open. */
const SPEND_PURPOSES = Object.keys(SPEND_PURPOSE_KIND) as SpendPurpose[];

export function migrateSpendPurpose(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(spend)").all().map((row) => row.name);
  if (!cols.includes("purpose")) {
    db.run(`ALTER TABLE spend ADD COLUMN purpose TEXT CHECK (purpose IS NULL OR purpose IN (${SPEND_PURPOSES.map((purpose) => `'${purpose}'`).join(", ")}))`);
  }
  widenSpendPurposes(db);
}

/**
 * `spend.purpose` gained `reader` (ADR 0055: reading a line for what the app acts on), then
 * `retrospect` (ADR 0062: a Bot's retrospective of a delivered plan), then `compact` (ADR 0068: a
 * turn's context compaction). Its CHECK is a fixed
 * `IN (...)` list, which SQLite cannot widen with `ALTER TABLE`, so a ledger whose list lacks one
 * of {@link SPEND_PURPOSES} is rebuilt the way `migrateNullableTaskSession` rebuilds tasks: the
 * stored definition with the missing ones added to the list, every row copied into it in one
 * transaction, its indexes made again. The ledger has no foreign keys either way.
 */
function widenSpendPurposes(db: Database): void {
  const table = db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spend'`).get()?.sql;
  if (!table) return;
  const list = /purpose\s+TEXT\s+CHECK\s*\(\s*purpose\s+IS\s+NULL\s+OR\s+purpose\s+IN\s*\(([^)]*)\)\s*\)/i.exec(table);
  if (!list) throw new Error("spend.purpose has a definition this migration does not know how to widen");
  const missing = SPEND_PURPOSES.filter((purpose) => !new RegExp(`'${purpose}'`).test(list[1]!));
  if (missing.length === 0) return;
  const widened = table.replace(list[0], list[0].replace(list[1]!, `${list[1]!.trimEnd()}, ${missing.map((purpose) => `'${purpose}'`).join(", ")}`));
  // A table that was ever renamed is stored as CREATE TABLE "spend".
  const createNew = widened.replace(/^CREATE TABLE\s+(?:"spend"|spend\b)/i, "CREATE TABLE spend_new");
  if (createNew === widened) throw new Error("spend has a definition this migration does not know how to copy");
  const own = db
    .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE tbl_name = 'spend' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all();
  const columns = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('spend')`)
    .all()
    .map((col) => `"${col.name}"`)
    .join(", ");
  db.run(`PRAGMA legacy_alter_table = ON`);
  try {
    db.transaction(() => {
      db.run(createNew);
      db.run(`INSERT INTO spend_new (${columns}) SELECT ${columns} FROM spend`);
      db.run(`DROP TABLE spend`);
      db.run(`ALTER TABLE spend_new RENAME TO spend`);
      for (const { sql } of own) db.run(sql);
    })();
  } finally {
    db.run(`PRAGMA legacy_alter_table = OFF`);
  }
}

function createSpendIndexes(db: Database): void {
  db.run(`CREATE INDEX IF NOT EXISTS spend_created ON spend (created_at, id)`);
  db.run(`CREATE INDEX IF NOT EXISTS spend_bot_created ON spend (bot_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS spend_session_created ON spend (session_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS spend_model_created ON spend (model, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS spend_kind_created ON spend (kind, created_at)`);
}
