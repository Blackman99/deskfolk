import { type Skill } from "@real-bot/protocol";
import { learningOutcome } from "./routing";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { codePointCount } from "../text";
import { aliveBot, requireNonEmpty, type SkillRow, type StoreContext } from "./shared";

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 500;
export const SKILL_BODY_MAX = 32_000;
export const SKILL_MAX_PER_BOT = 32;

export function parseSkillName(value: unknown): string {
  const name = requireNonEmpty("name", value);
  if (codePointCount(name) > SKILL_NAME_MAX) {
    throw new HttpError(422, "invalid_args", `name must be at most ${SKILL_NAME_MAX} characters`);
  }
  return name;
}

export function parseSkillDescription(value: unknown): string {
  const description = requireNonEmpty("description", value);
  if (codePointCount(description) > SKILL_DESCRIPTION_MAX) {
    throw new HttpError(422, "invalid_args", `description must be at most ${SKILL_DESCRIPTION_MAX} characters`);
  }
  return description;
}

export function parseSkillBody(value: unknown): string {
  const body = requireNonEmpty("body", value);
  if (codePointCount(body) > SKILL_BODY_MAX) {
    throw new HttpError(422, "invalid_args", `body must be at most ${SKILL_BODY_MAX} characters`);
  }
  return body;
}

export const SKILL_USES_MAX = 16;
export const SKILL_USE_NAME_MAX = 64;

/** MCP server names a skill relies on: trimmed, deduped case-insensitively, empty entries dropped. */
export function parseSkillUses(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(422, "invalid_args", "uses must be an array of MCP server names");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value as string[]) {
    const name = item.trim();
    if (name.length === 0) continue;
    if (codePointCount(name) > SKILL_USE_NAME_MAX) {
      throw new HttpError(422, "invalid_args", `each uses entry must be at most ${SKILL_USE_NAME_MAX} characters`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (out.length > SKILL_USES_MAX) {
    throw new HttpError(422, "invalid_args", `uses may list at most ${SKILL_USES_MAX} MCP servers`);
  }
  return out;
}

export function parseSkillUsesJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Fills the learning counts a snapshot shows. A skill a turn wrote itself stays null. */
export function withLearning(ctx: StoreContext, skill: Skill): Skill {
  const chain = ctx.db
    .query<{ learned_chain_id: string | null }, [string]>(`SELECT learned_chain_id FROM skills WHERE id = ?`)
    .get(skill.id);
  if (!chain?.learned_chain_id) return skill;
  const outcome = learningOutcome(ctx, { botId: skill.bot_id, chainId: chain.learned_chain_id });
  return outcome ? { ...skill, learning: outcome } : skill;
}

export function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    bot_id: row.bot_id,
    name: row.name,
    description: row.description,
    body: row.body,
    uses: parseSkillUsesJson(row.uses),
    enabled: row.enabled === 1,
    learning: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listSkills(ctx: StoreContext, botId?: string): Skill[] {
  if (botId) {
    aliveBot(ctx, botId);
    return ctx.db
      .query<SkillRow, [string]>(`SELECT * FROM skills WHERE bot_id = ? ORDER BY name COLLATE NOCASE ASC, id ASC`)
      .all(botId)
      .map(toSkill);
  }
  return ctx.db
    .query<SkillRow, []>(`SELECT * FROM skills ORDER BY bot_id ASC, name COLLATE NOCASE ASC, id ASC`)
    .all()
    .map(toSkill);
}

export function listEnabledSkills(ctx: StoreContext, botId: string): Skill[] {
  return listSkills(ctx, botId).filter((skill) => skill.enabled);
}

export function getSkill(ctx: StoreContext, id: string): Skill {
  const row = ctx.db.query<SkillRow, [string]>(`SELECT * FROM skills WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "skill not found");
  return toSkill(row);
}

export function findSkillByName(ctx: StoreContext, botId: string, name: string): Skill | null {
  const normalized = requireNonEmpty("name", name);
  const row = ctx.db
    .query<SkillRow, [string, string]>(
      `SELECT * FROM skills WHERE bot_id = ? AND lower(name) = lower(?) LIMIT 1`,
    )
    .get(botId, normalized);
  return row ? toSkill(row) : null;
}

export function createSkill(
  ctx: StoreContext,
  input: {
    bot_id: string;
    name: string;
    description: string;
    body: string;
    uses?: string[];
    enabled?: boolean;
  },
): Skill {
  aliveBot(ctx, input.bot_id);
  const name = parseSkillName(input.name);
  const description = parseSkillDescription(input.description);
  const body = parseSkillBody(input.body);
  const uses = JSON.stringify(parseSkillUses(input.uses));
  assertSkillNameFree(ctx, input.bot_id, name);
  assertSkillCapacity(ctx, input.bot_id);
  const now = isoNow();
  const id = ulid();
  ctx.db.run(
    `INSERT INTO skills (id, bot_id, name, description, body, uses, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.bot_id, name, description, body, uses, input.enabled === false ? 0 : 1, now, now],
  );
  return getSkill(ctx, id);
}

export function patchSkill(
  ctx: StoreContext,
  id: string,
  patch: Partial<{ name: string; description: string; body: string; uses: string[]; enabled: boolean }>,
  opts: { learnedChainId?: string | null } = {},
): Skill {
  const current = ctx.db.query<SkillRow, [string]>(`SELECT * FROM skills WHERE id = ?`).get(id);
  if (!current) throw new HttpError(404, "not_found", "skill not found");
  const name = patch.name !== undefined ? parseSkillName(patch.name) : current.name;
  const description =
    patch.description !== undefined ? parseSkillDescription(patch.description) : current.description;
  const body = patch.body !== undefined ? parseSkillBody(patch.body) : current.body;
  const uses = patch.uses !== undefined ? JSON.stringify(parseSkillUses(patch.uses)) : (current.uses ?? "[]");
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
  if (name.toLowerCase() !== current.name.toLowerCase()) {
    assertSkillNameFree(ctx, current.bot_id, name, id);
  }
  const now = isoNow();
  const chain = opts.learnedChainId === undefined ? (current.learned_chain_id ?? null) : opts.learnedChainId;
  ctx.db.run(
    `UPDATE skills SET name = ?, description = ?, body = ?, uses = ?, enabled = ?, learned_chain_id = ?, updated_at = ? WHERE id = ?`,
    [name, description, body, uses, enabled, chain, now, id],
  );
  return getSkill(ctx, id);
}

export function deleteSkill(ctx: StoreContext, id: string): void {
  const deleted = ctx.db.query("DELETE FROM skills WHERE id = ? RETURNING id").get(id);
  if (!deleted) throw new HttpError(404, "not_found", "skill not found");
}

export function assertSkillNameFree(ctx: StoreContext, botId: string, name: string, exceptId?: string): void {
  const row = ctx.db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM skills WHERE bot_id = ? AND lower(name) = lower(?) LIMIT 1`,
    )
    .get(botId, name);
  if (row && row.id !== exceptId) throw new HttpError(409, "conflict", "that skill name is already used");
}

export function assertSkillCapacity(ctx: StoreContext, botId: string): void {
  const row = ctx.db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM skills WHERE bot_id = ?`)
    .get(botId);
  if ((row?.n ?? 0) >= SKILL_MAX_PER_BOT) {
    throw new HttpError(422, "failed", `a bot can have at most ${SKILL_MAX_PER_BOT} skills`);
  }
}
