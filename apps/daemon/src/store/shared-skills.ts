/**
 * Project skills (ADR 0052, engine level 8): a Bot's own skill you chose to share becomes one every
 * Bot of the workspace reads in its catalog — a review procedure the reviewer wrote, read by the
 * producer before it generates. Sharing is yours alone (a skill can hold what the Bot learned about
 * you, ADR 0021), and what is shared is a copy as it stood when you shared it: the owner's later
 * edits reach the others only when you share it again. A Bot's own skill of the same name comes first.
 */
import type { Database } from "bun:sqlite";
import type { SharedSkill } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { learningOn } from "./quality";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

/** At most this many project skills on at once: each one is in every Bot's system prompt. */
export const SHARED_SKILLS_MAX = 20;

export const SHARED_SKILLS_SQL = `CREATE TABLE IF NOT EXISTS shared_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  uses TEXT NOT NULL DEFAULT '[]',
  source_skill_id TEXT,
  source_bot_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export function migrateSharedSkills(db: Database): void {
  db.run(SHARED_SKILLS_SQL);
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS shared_skills_name ON shared_skills(name COLLATE NOCASE)");
}

type SharedSkillRow = Omit<SharedSkill, "uses" | "enabled" | "source_changed" | "source_bot_name"> & { uses: string; enabled: number };

function toShared(ctx: StoreContext, row: SharedSkillRow): SharedSkill {
  const source = row.source_skill_id
    ? ctx.db.query<{ updated_at: string }, [string]>("SELECT updated_at FROM skills WHERE id = ?").get(row.source_skill_id)
    : null;
  // A deleted owner's copy stays shared (you shared it; stop sharing it to take it back), from a deleted Bot.
  const owner = row.source_bot_id ? ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ? AND deleted_at IS NULL").get(row.source_bot_id) : null;
  return { ...row, uses: JSON.parse(row.uses) as string[], enabled: row.enabled === 1, source_bot_name: owner?.name ?? null,
    // Changed since you shared it: the copy others read is older than the owner's skill.
    source_changed: Boolean(source && source.updated_at > row.confirmed_at) };
}

export function listSharedSkills(ctx: StoreContext, opts: { enabledOnly?: boolean } = {}): SharedSkill[] {
  return ctx.db.query<SharedSkillRow, []>(`SELECT * FROM shared_skills ${opts.enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY name COLLATE NOCASE`).all()
    .map((row) => toShared(ctx, row));
}

export function getSharedSkill(ctx: StoreContext, id: string): SharedSkill {
  const row = ctx.db.query<SharedSkillRow, [string]>("SELECT * FROM shared_skills WHERE id = ?").get(id);
  if (!row) throw new HttpError(404, "not_found", "shared skill not found");
  return toShared(ctx, row);
}

/** The project skills a Bot reads, less those it has one of its own by the same name. */
export function sharedSkillsFor(ctx: StoreContext, botId: string): SharedSkill[] {
  if (!learningOn(ctx)) return [];
  // Only a skill of its own that is on stands in front: a turned-off one leaves the project's in its catalog, as read_skill does.
  const own = new Set(ctx.db.query<{ name: string }, [string]>("SELECT name FROM skills WHERE bot_id = ? AND enabled = 1").all(botId).map((row) => row.name.toLowerCase()));
  return listSharedSkills(ctx, { enabledOnly: true }).filter((skill) => !own.has(skill.name.toLowerCase()));
}

export function findSharedSkillByName(ctx: StoreContext, name: string): SharedSkill | null {
  if (!learningOn(ctx)) return null;
  const row = ctx.db.query<SharedSkillRow, [string]>("SELECT * FROM shared_skills WHERE enabled = 1 AND name = ? COLLATE NOCASE").get(name.trim());
  return row ? toShared(ctx, row) : null;
}

/**
 * Your 共享 on a Bot's skill: a project copy of it as it stands now, or — shared before — the copy
 * brought up to date. Another project skill of the same name from elsewhere is refused.
 */
export function shareSkill(ctx: StoreContext, skillId: string, now: string = isoNow()): SharedSkill {
  if (!learningOn(ctx)) throw new HttpError(409, "conflict", "sharing a skill needs engine level 8");
  return ctx.commit(() => {
    const skill = ctx.db.query<{ id: string; bot_id: string; name: string; description: string; body: string; uses: string }, [string]>(
      "SELECT s.id, s.bot_id, s.name, s.description, s.body, s.uses FROM skills s JOIN bots b ON b.id = s.bot_id WHERE s.id = ? AND b.deleted_at IS NULL").get(skillId);
    if (!skill) throw new HttpError(404, "not_found", "skill not found");
    const existing = ctx.db.query<{ id: string }, [string]>("SELECT id FROM shared_skills WHERE source_skill_id = ?").get(skill.id);
    const clash = ctx.db.query<{ id: string; source_skill_id: string | null }, [string]>("SELECT id, source_skill_id FROM shared_skills WHERE name = ? COLLATE NOCASE").get(skill.name);
    if (clash && clash.source_skill_id !== skill.id) throw new HttpError(409, "conflict", "a project skill of that name is already shared");
    if (!existing && ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shared_skills WHERE enabled = 1").get()!.n >= SHARED_SKILLS_MAX) {
      throw new HttpError(409, "conflict", `at most ${SHARED_SKILLS_MAX} project skills can be on at once`);
    }
    if (existing) {
      ctx.db.run("UPDATE shared_skills SET name = ?, description = ?, body = ?, uses = ?, confirmed_at = ?, updated_at = ? WHERE id = ?",
        [skill.name, skill.description, skill.body, skill.uses, now, now, existing.id]);
    } else {
      ctx.db.run(`INSERT INTO shared_skills (id, name, description, body, uses, source_skill_id, source_bot_id, enabled, confirmed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`, [ulid(Date.parse(now)), skill.name, skill.description, skill.body, skill.uses, skill.id, skill.bot_id, now, now, now]);
    }
    const id = existing?.id ?? ctx.db.query<{ id: string }, [string]>("SELECT id FROM shared_skills WHERE source_skill_id = ?").get(skill.id)!.id;
    recordWorkEvent(ctx, { kind: existing ? "skill.share_updated" : "skill.shared", actor: "user", botId: skill.bot_id, payload: { skill_id: skill.id, shared_skill_id: id } });
    return getSharedSkill(ctx, id);
  });
}

/** Turning a project skill off for every Bot, or back on. */
export function setSharedSkillEnabled(ctx: StoreContext, id: string, enabled: boolean, now: string = isoNow()): SharedSkill {
  const skill = getSharedSkill(ctx, id);
  if (enabled && !skill.enabled && ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shared_skills WHERE enabled = 1").get()!.n >= SHARED_SKILLS_MAX) {
    throw new HttpError(409, "conflict", `at most ${SHARED_SKILLS_MAX} project skills can be on at once`);
  }
  ctx.db.run("UPDATE shared_skills SET enabled = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, now, id]);
  return getSharedSkill(ctx, id);
}

/** No longer shared: the copy goes; the owner's own skill is untouched. */
export function unshareSkill(ctx: StoreContext, id: string): void {
  const skill = getSharedSkill(ctx, id);
  ctx.db.run("DELETE FROM shared_skills WHERE id = ?", [id]);
  recordWorkEvent(ctx, { kind: "skill.unshared", actor: "user", botId: skill.source_bot_id, payload: { shared_skill_id: id, skill_id: skill.source_skill_id } });
}
