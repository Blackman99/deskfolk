/** Schema catch-up for model routing: route tables, task attribution of old rows, legacy penalties and Bots' thinking pins. */
import { sortThinkingLevels, THINKING_LEVELS } from "@real-bot/protocol";
import type { Database } from "bun:sqlite";
import { isoNow, ulid } from "../ids";
import { parseStoredCatalog } from "../models";
import { pickThinkingLevel } from "../route-decision";
import { idSuffix, localDate, slugify, taskTitle, WORK_ROOT } from "./tasks";

/**
 * A thinking level belongs to a model, so a Bot is either automatic about both or explicit about
 * both. Databases written before that rule can hold half a pin: a level with no model (nothing for
 * it to apply to) or a model with no level. The first is dropped; the second lands on the level the
 * router would have picked for an ordinary message on that model.
 */
export function migrateBotThinkingPins(db: Database): void {
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
/** The quiet window jobs were split by, back when a clock did that. Kept here for the record it rebuilds. */
const LEGACY_QUIET_MS = 6 * 60 * 60_000;

/** `work/2026-09-21-导出季度报表-7f3k`, the dated shape jobs from before plans were named in. */
function legacyDatedDirName(input: { title: string; id: string; at: Date; suffixLength: number }): string {
  const parts = [localDate(input.at)];
  const slug = slugify(input.title);
  if (slug) parts.push(slug);
  parts.push(idSuffix(input.id, input.suffixLength));
  return `${WORK_ROOT}/${parts.join("-")}`;
}

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
          open && Date.parse(turn.created_at) - Date.parse(open.lastAt) <= LEGACY_QUIET_MS;
        if (warm && open) taskId = open.id;
      }
      if (!taskId) {
        const at = new Date(Date.parse(turn.created_at) || Date.now());
        const id = ulid(at.getTime());
        const title = taskTitle(turn.body);
        let dir = "";
        for (const suffixLength of [4, 8, 26]) {
          dir = legacyDatedDirName({ title, id, at, suffixLength });
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

export function migrateRouteTables(db: Database, tables: string[]): void {
  // Work dirs: every turn and every message it produced belong to one job's folder. Old rows have
  // none, so their artifacts stay where they were written and nothing is moved under `work/`.
  const turnCols = db
    .query<{ name: string }, []>(`PRAGMA table_info(turns)`)
    .all()
    .map((row) => row.name);
  if (!turnCols.includes("task_id")) {
    db.run(`ALTER TABLE turns ADD COLUMN task_id TEXT`);
  }
  // I1b needs both columns; pre-work-dir databases get task_id here.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS turns_one_live_per_bot_plan ON turns (bot_id, task_id)
    WHERE work_item_id IS NOT NULL AND task_id IS NOT NULL AND status IN ('running', 'waiting_approval', 'waiting_ask')`);
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
  if (!decisionCols.includes("tool_failures")) {
    db.run(`ALTER TABLE turn_route_decisions ADD COLUMN tool_failures TEXT`);
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
