import type { Database } from "bun:sqlite";
import { USER_MEMBER, type AgentRun, type AgentRunApproval, type AgentRunStatus, type Message, type ProjectAgent, type SessionDetail } from "@real-bot/protocol";
import type { ClaudeSessionRead } from "../claude-code/sessions";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { getMessage } from "./messages";
import { getSession } from "./sessions";
import { sessionRow, type StoreContext } from "./shared";

/** Who a project session's agent lines are by: no Bot, so no Bot id (ADR 0095). */
export const AGENT_AUTHOR = "agent";

/**
 * Project sessions (ADR 0095). A `sessions` table made before them says `kind IN ('direct',
 * 'group')`; SQLite cannot widen a CHECK in place, so the table is made again with `project` in
 * it, the way `migrateAgentRunners` rebuilds `bots`: the definition as it stands with the one CHECK
 * widened, every row copied, its own indexes and triggers made again, no foreign key left dangling
 * that was not already. Then the project columns, additive. `agent_runs` is in schema.ts.
 */
export function migrateProjectSessions(db: Database): void {
  const table = db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`).get()?.sql;
  if (table && !/'project'/.test(table)) {
    const widened = table.replace(/CHECK\s*\(\s*kind\s+IN\s*\(\s*'direct'\s*,\s*'group'\s*\)\s*\)/i, "CHECK (kind IN ('direct', 'group', 'project'))");
    if (widened === table) throw new Error("sessions has a kind CHECK this migration does not know how to widen");
    // A table that was ever renamed is stored as CREATE TABLE "sessions".
    const createNew = widened.replace(/^CREATE TABLE\s+(?:"sessions"|sessions\b)/i, "CREATE TABLE sessions_new");
    if (createNew === widened) throw new Error("sessions has a definition this migration does not know how to copy");
    const own = db
      .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE tbl_name = 'sessions' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
      .all();
    const columns = db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('sessions')`)
      .all()
      .map((col) => `"${col.name}"`)
      .join(", ");
    const dangling = () => db.query(`PRAGMA foreign_key_check`).all().length;
    db.run(`PRAGMA foreign_keys = OFF`);
    db.run(`PRAGMA legacy_alter_table = ON`);
    try {
      db.transaction(() => {
        const before = dangling();
        db.run(createNew);
        db.run(`INSERT INTO sessions_new (${columns}) SELECT ${columns} FROM sessions`);
        db.run(`DROP TABLE sessions`);
        db.run(`ALTER TABLE sessions_new RENAME TO sessions`);
        for (const { sql } of own) db.run(sql);
        if (dangling() > before) throw new Error("sessions rebuild broke a foreign key");
      })();
    } finally {
      db.run(`PRAGMA legacy_alter_table = OFF`);
      db.run(`PRAGMA foreign_keys = ON`);
    }
  }
  const names = db.query<{ name: string }, []>(`PRAGMA table_info(sessions)`).all().map((row) => row.name);
  for (const name of ["project_dir", "project_agent", "project_config_dir", "project_agent_session", "project_source"]) {
    if (!names.includes(name)) db.run(`ALTER TABLE sessions ADD COLUMN ${name} TEXT`);
  }
}

export type ProjectOf = {
  dir: string;
  agent: ProjectAgent;
  configDir: string | null;
  agentSession: string | null;
  source: string | null;
};

/** A project session's directory and agent, or null for any other conversation. */
export function projectOf(ctx: StoreContext, sessionId: string): ProjectOf | null {
  const row = ctx.db
    .query<{ kind: string; project_dir: string | null; project_agent: string | null; project_config_dir: string | null; project_agent_session: string | null; project_source: string | null }, [string]>(
      `SELECT kind, project_dir, project_agent, project_config_dir, project_agent_session, project_source FROM sessions WHERE id = ?`,
    )
    .get(sessionId);
  if (!row || row.kind !== "project" || !row.project_dir) return null;
  return { dir: row.project_dir, agent: (row.project_agent ?? "claude_code") as ProjectAgent, configDir: row.project_config_dir,
    agentSession: row.project_agent_session, source: row.project_source };
}

/** The agent's own session id, once a run has one: every later run resumes it. */
export function recordProjectAgentSession(ctx: StoreContext, sessionId: string, agentSession: string): void {
  ctx.db.run(`UPDATE sessions SET project_agent_session = ? WHERE id = ? AND kind = 'project'`, [agentSession, sessionId]);
}

/** A new session's name is your first line, until something names it otherwise. */
export function nameProjectSessionIfUnnamed(ctx: StoreContext, sessionId: string, line: string): boolean {
  const name = line.replace(/\s+/g, " ").trim().slice(0, 60).trim();
  if (!name) return false;
  return ctx.db.run(`UPDATE sessions SET name = ? WHERE id = ? AND kind = 'project' AND name IS NULL`, [name, sessionId]).changes > 0;
}

/**
 * A project session in `dir`, or one carrying a terminal session on: what you said and Claude's
 * text land at their own times, then a line saying where it came from. Everything in it is read:
 * the history is yours already.
 */
export function createProjectSession(
  ctx: StoreContext,
  input: { dir: string; agent: ProjectAgent; configDir: string | null; imported?: ClaudeSessionRead | null; locale: "zh" | "en" },
): SessionDetail {
  if (!input.dir.trim()) throw new HttpError(422, "invalid_args", "dir is required");
  const imported = input.imported ?? null;
  if (imported && imported.lines.length === 0) throw new HttpError(422, "invalid_args", "the session has nothing to carry on");
  const en = input.locale === "en";
  const now = isoNow();
  const id = ulid();
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO sessions (id, kind, name, last_read_at, project_dir, project_agent, project_config_dir, project_source, created_at, updated_at)
       VALUES (?, 'project', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, imported?.title ?? null, now, input.dir, input.agent, input.configDir, imported?.session_id ?? null, now, now],
    );
    ctx.db.run(`INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`, [id, USER_MEMBER, now]);
    if (!imported) return;
    const insert = ctx.db.prepare(`INSERT INTO messages (id, session_id, kind, author, body, hidden_from_bots, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`);
    for (const line of imported.lines) {
      insert.run(ulid(), id, line.role === "user" ? "user" : "bot", line.role === "user" ? USER_MEMBER : AGENT_AUTHOR, line.text, line.at);
    }
    const note = en
      ? `Carried on from the Claude Code session "${imported.title}": ${imported.lines.length} lines above${imported.tool_calls > 0 ? `, ${imported.tool_calls} tool calls not shown` : ""}. Claude Code remembers all of it; your terminal's session is left as it was.`
      : `从 Claude Code 会话「${imported.title}」接过来：上面 ${imported.lines.length} 条${imported.tool_calls > 0 ? `，${imported.tool_calls} 次工具调用没有列出` : ""}。Claude Code 记得这些全部内容；终端里的原会话不受影响。`;
    insert.run(ulid(), id, "system", "app", note, now);
    const maxSeq = ctx.db.query<{ seq: number | null }, [string]>(`SELECT MAX(message_seq) AS seq FROM messages WHERE session_id = ?`).get(id)?.seq ?? 0;
    ctx.db.run(`UPDATE sessions SET read_through_seq = ? WHERE id = ?`, [maxSeq, id]);
  })();
  return getSession(ctx, id);
}

/** The agent's reply (or a line it failed with), as the session's next line. */
export function insertAgentLine(ctx: StoreContext, sessionId: string, input: { kind: "bot" | "system"; body: string }): Message {
  sessionRow(ctx, sessionId);
  const id = ulid();
  const now = isoNow();
  ctx.db.run(
    `INSERT INTO messages (id, session_id, kind, author, body, hidden_from_bots, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [id, sessionId, input.kind, input.kind === "bot" ? AGENT_AUTHOR : "app", input.body, now],
  );
  ctx.db.run(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [now, sessionId]);
  return getMessage(ctx, id);
}

type AgentRunRow = Omit<AgentRun, "approval"> & { approval: string | null };

function toAgentRun(row: AgentRunRow): AgentRun {
  let approval: AgentRunApproval | null = null;
  try {
    approval = row.approval ? (JSON.parse(row.approval) as AgentRunApproval) : null;
  } catch {
    approval = null;
  }
  return { ...row, approval };
}

export function createAgentRun(ctx: StoreContext, sessionId: string): AgentRun {
  const id = ulid();
  const now = isoNow();
  ctx.db.run(`INSERT INTO agent_runs (id, session_id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)`, [id, sessionId, now, now]);
  return getAgentRun(ctx, id);
}

export function getAgentRun(ctx: StoreContext, id: string): AgentRun {
  const row = ctx.db.query<AgentRunRow, [string]>(`SELECT * FROM agent_runs WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "run not found");
  return toAgentRun(row);
}

/** The session's newest run, live or not; null before its first. */
export function latestAgentRun(ctx: StoreContext, sessionId: string): AgentRun | null {
  const row = ctx.db.query<AgentRunRow, [string]>(`SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(sessionId);
  return row ? toAgentRun(row) : null;
}

export function updateAgentRun(
  ctx: StoreContext,
  id: string,
  patch: { status?: AgentRunStatus; activity?: string | null; partial?: string | null; approval?: AgentRunApproval | null; error?: string | null },
): AgentRun {
  const sets: string[] = [];
  const values: Array<string | null> = [];
  for (const key of ["status", "activity", "partial", "error"] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(patch[key] ?? null);
    }
  }
  if (patch.approval !== undefined) {
    sets.push(`approval = ?`);
    values.push(patch.approval ? JSON.stringify(patch.approval) : null);
  }
  sets.push(`updated_at = ?`);
  values.push(isoNow());
  ctx.db.run(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
  return getAgentRun(ctx, id);
}

/** At boot nothing runs yet: a run still marked live was cut by the last shutdown. */
export function interruptLiveAgentRuns(ctx: StoreContext): number {
  return ctx.db.run(
    `UPDATE agent_runs SET status = 'interrupted', activity = NULL, approval = NULL, updated_at = ? WHERE status IN ('running', 'waiting_approval')`,
    [isoNow()],
  ).changes;
}
