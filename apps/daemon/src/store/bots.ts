import {
  USER_MEMBER,
  generateBoringAvatar,
  type Bot,
  type CreateBotRequest,
  type ProfileRevision,
  type SessionDetail,
  type ThinkingLevel,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import {
  carriedThinkingLevel,
  defaultThinkingLevelFor,
  resolveIncomingBotTarget,
  resolveIncomingThinkingLevel,
} from "./providers";
import { forgetBotRoutes } from "./routing";
import { getSession } from "./sessions";
import {
  aliveBot,
  assertNameFree,
  requireNonEmpty,
  requireString,
  toBot,
  type BotRow,
  type StoreContext,
} from "./shared";

export function listBots(ctx: StoreContext): Bot[] {
  const rows = ctx.db
    .query<BotRow, []>(
      `SELECT * FROM bots WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id`,
    )
    .all();
  return rows.map(toBot);
}

export function getBot(ctx: StoreContext, id: string): Bot {
  const row = aliveBot(ctx, id);
  return toBot(row);
}

export function createBot(
  ctx: StoreContext,
  input: CreateBotRequest,
  actor: string = USER_MEMBER,
): { bot: Bot; direct_session: SessionDetail } {
  const name = requireNonEmpty("name", input.name);
  const duties = requireString("duties", input.duties);
  const boundaries = requireString("boundaries", input.boundaries);
  const avatar =
    typeof input.avatar === "string" && input.avatar.trim().length > 0
      ? input.avatar.trim()
      : generateBoringAvatar({ name });
  const { model, providerId } = resolveIncomingBotTarget(ctx, input.model, input.provider_id);
  // Pinning a model pins a level too: a Bot is either on automatic for both or explicit about both.
  const thinkingLevel =
    resolveIncomingThinkingLevel(ctx, input.thinking_level, model, providerId) ??
    defaultThinkingLevelFor(ctx, model, providerId);
  assertNameFree(ctx, name);
  const now = isoNow();
  const botId = ulid();
  const sessionId = ulid();
  const revisionId = ulid();
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO bots (id, name, duties, boundaries, avatar, model, provider_id, thinking_level, archived_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [botId, name, duties, boundaries, avatar, model, providerId, thinkingLevel, now, now],
    );
    ctx.db.run(
      `INSERT INTO profile_revisions (id, bot_id, name, duties, boundaries, avatar, actor, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [revisionId, botId, name, duties, boundaries, avatar, actor, now],
    );
    ctx.db.run(
      `INSERT INTO sessions (id, kind, name, last_read_at, created_at, updated_at) VALUES (?, 'direct', NULL, ?, ?, ?)`,
      [sessionId, now, now, now],
    );
    ctx.db.run(
      `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
      [sessionId, USER_MEMBER, now],
    );
    ctx.db.run(
      `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
      [sessionId, botId, now],
    );
  })();
  return {
    bot: getBot(ctx, botId),
    direct_session: getSession(ctx, sessionId),
  };
}

export function patchBot(
  ctx: StoreContext,
  id: string,
  patch: {
    name?: string;
    duties?: string;
    boundaries?: string;
    avatar?: string | null;
    model?: string | null;
    provider_id?: string | null;
    thinking_level?: ThinkingLevel | null;
  },
  actor: string = USER_MEMBER,
): Bot {
  const row = aliveBot(ctx, id);
  const name = patch.name !== undefined ? requireNonEmpty("name", patch.name) : row.name;
  const duties = patch.duties !== undefined ? requireString("duties", patch.duties) : row.duties;
  const boundaries =
    patch.boundaries !== undefined ? requireString("boundaries", patch.boundaries) : row.boundaries;
  let avatar = row.avatar;
  if ("avatar" in patch) {
    if (typeof patch.avatar === "string" && patch.avatar.trim().length > 0) {
      avatar = patch.avatar.trim();
    } else if (patch.avatar === null || (typeof patch.avatar === "string" && patch.avatar.trim().length === 0)) {
      avatar = generateBoringAvatar({ name });
    }
  }
  const nextTarget =
    "model" in patch || "provider_id" in patch
      ? resolveIncomingBotTarget(
          ctx,
          "model" in patch ? patch.model : row.model,
          "provider_id" in patch ? patch.provider_id : row.provider_id,
        )
      : { model: row.model, providerId: row.provider_id };
  const model = nextTarget.model;
  const providerId = nextTarget.providerId;
  const thinkingLevel =
    ("thinking_level" in patch
      ? resolveIncomingThinkingLevel(ctx, patch.thinking_level, model, providerId)
      : carriedThinkingLevel(ctx, row.thinking_level, model, providerId)) ??
    defaultThinkingLevelFor(ctx, model, providerId);
  if (name !== row.name) assertNameFree(ctx, name);
  const now = isoNow();
  ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE bots SET name = ?, duties = ?, boundaries = ?, avatar = ?, model = ?, provider_id = ?, thinking_level = ?, updated_at = ? WHERE id = ?`,
      [name, duties, boundaries, avatar, model, providerId, thinkingLevel, now, id],
    );
    ctx.db.run(
      `INSERT INTO profile_revisions (id, bot_id, name, duties, boundaries, avatar, actor, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [ulid(), id, name, duties, boundaries, avatar, actor, now],
    );
  })();
  return getBot(ctx, id);
}

export function archiveBot(ctx: StoreContext, id: string): Bot {
  const row = aliveBot(ctx, id);
  if (row.archived_at) return toBot(row);
  const now = isoNow();
  ctx.db.run(`UPDATE bots SET archived_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
  return getBot(ctx, id);
}

export function restoreBot(ctx: StoreContext, id: string): Bot {
  const row = aliveBot(ctx, id);
  if (!row.archived_at) return toBot(row);
  const now = isoNow();
  ctx.db.run(`UPDATE bots SET archived_at = NULL, updated_at = ? WHERE id = ?`, [now, id]);
  return getBot(ctx, id);
}

export function deleteBot(ctx: StoreContext, id: string): void {
  aliveBot(ctx, id);
  const now = isoNow();
  ctx.db.transaction(() => {
    ctx.db.run(`UPDATE bots SET deleted_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
    forgetBotRoutes(ctx, id);
  })();
}

export function listProfileRevisions(ctx: StoreContext, botId: string): ProfileRevision[] {
  aliveBot(ctx, botId);
  return ctx.db
    .query<ProfileRevision, [string]>(
      `SELECT id, bot_id, name, duties, boundaries, avatar, actor, message_id, created_at
       FROM profile_revisions WHERE bot_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(botId);
}

export function attachLatestRevisionMessage(ctx: StoreContext, botId: string, messageId: string): void {
  const latest = ctx.db
    .query<{ id: string }, [string]>(
      `SELECT id FROM profile_revisions WHERE bot_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(botId);
  if (!latest) return;
  ctx.db.run(`UPDATE profile_revisions SET message_id = ? WHERE id = ?`, [messageId, latest.id]);
}

export function findBotByName(ctx: StoreContext, name: string): Bot | null {
  const row = ctx.db
    .query<BotRow, [string]>(`SELECT * FROM bots WHERE name = ? AND deleted_at IS NULL`)
    .get(name);
  return row ? toBot(row) : null;
}

export function requireBotByName(ctx: StoreContext, name: string): Bot {
  const bot = findBotByName(ctx, name);
  if (!bot) throw new HttpError(404, "not_found", "bot not found");
  return bot;
}
