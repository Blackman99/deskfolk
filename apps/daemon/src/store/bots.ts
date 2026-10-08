import {
  CLAUDE_EFFORTS,
  USER_MEMBER,
  folkHash,
  generateBoringAvatar,
  isBotRunner,
  isClaudeEffort,
  isClaudeModelName,
  type Bot,
  type BotRunner,
  type ClaudeEffort,
  type CreateBotRequest,
  type ProfileRevision,
  type SessionDetail,
  type ThinkingLevel,
} from "@real-bot/protocol";
import { normalizeConfigDir, sameConfigDir } from "../claude-code/account";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { claudeCodeConfigDirs } from "./claude-code";
import {
  carriedThinkingLevel,
  defaultThinkingLevelFor,
  resolveIncomingBotTarget,
  resolveIncomingThinkingLevel,
} from "./providers";
import { voidCheckBacks } from "./check-backs";
import { cancelDelegationsForBot } from "./delegations";
import { forgetBotMemories } from "./memories";
import { bumpCleanupRevision } from "./notifications";
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
  LIVE_TURN_STATUSES,
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

/** `runner` as a request gives it: absent or null is the app's own loop, anything else must be a known runner. */
function incomingRunner(value: unknown): BotRunner | null {
  if (value === undefined || value === null) return null;
  if (!isBotRunner(value)) throw new HttpError(422, "invalid_args", "runner must be claude_code or null");
  return value;
}

/** A Claude model name or alias for `agent_model` (ADR 0061); null or "" leaves it to Claude Code. */
function incomingAgentModel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "agent_model must be a string or null");
  const trimmed = value.trim();
  if (trimmed && !isClaudeModelName(trimmed)) throw new HttpError(422, "invalid_args", "agent_model is not a Claude model name");
  return trimmed || null;
}

/** One of Claude Code's effort levels for `agent_effort`; null leaves it to Claude Code. */
function incomingAgentEffort(value: unknown): ClaudeEffort | null {
  if (value === undefined || value === null) return null;
  const trimmed = typeof value === "string" ? value.trim() : value;
  if (!isClaudeEffort(trimmed)) {
    throw new HttpError(422, "invalid_args", `agent_effort must be one of ${CLAUDE_EFFORTS.join(", ")} or null`);
  }
  return trimmed;
}

/**
 * The account a Claude Agent's turns spend (ADR 0061): null or "" for the daemon's own environment,
 * otherwise one of the config directories listed in Settings, kept as the list keeps it.
 */
function incomingAgentConfigDir(ctx: StoreContext, value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "agent_config_dir must be a string or null");
  const dir = normalizeConfigDir(value);
  const listed = dir ? claudeCodeConfigDirs(ctx).find((kept) => sameConfigDir(kept, dir)) : undefined;
  if (!listed) throw new HttpError(422, "invalid_args", "agent_config_dir must be one of the Claude accounts listed in Settings");
  return listed;
}

/**
 * Which runs a Bot, and on whose account, is yours to choose (ADR 0061): a Claude Agent's turns
 * spend your Claude account, so a Bot can neither switch itself or another Bot to it nor off it,
 * nor move it to another account.
 */
function assertRunnerActor(actor: string, changed: boolean): void {
  if (changed && actor !== USER_MEMBER) {
    throw new HttpError(403, "forbidden", "only the user can choose what runs a bot");
  }
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
  const runner = incomingRunner(input.runner);
  assertRunnerActor(actor, runner !== null);
  const agentModel = incomingAgentModel(input.agent_model);
  const agentEffort = incomingAgentEffort(input.agent_effort);
  const agentConfigDir = incomingAgentConfigDir(ctx, input.agent_config_dir);
  assertRunnerActor(actor, agentConfigDir !== null);
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
      `INSERT INTO bots (id, name, duties, boundaries, avatar, model, provider_id, thinking_level, runner, agent_model, agent_effort, agent_config_dir, archived_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [botId, name, duties, boundaries, avatar, model, providerId, thinkingLevel, runner, agentModel, agentEffort, agentConfigDir, now, now],
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
    runner?: BotRunner | null;
    agent_model?: string | null;
    agent_effort?: ClaudeEffort | null;
    agent_config_dir?: string | null;
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
    // The panel sends back the folk it was shown, in the small form: the same folk is no change.
    const same = folkHash(avatar);
    if (avatar !== row.avatar && same !== null && same === folkHash(row.avatar)) avatar = row.avatar;
  }
  const runner = "runner" in patch ? incomingRunner(patch.runner) : (isBotRunner(row.runner) ? row.runner : null);
  assertRunnerActor(actor, runner !== (isBotRunner(row.runner) ? row.runner : null));
  const agentModel = "agent_model" in patch ? incomingAgentModel(patch.agent_model) : row.agent_model;
  const agentEffort = "agent_effort" in patch ? incomingAgentEffort(patch.agent_effort) : (isClaudeEffort(row.agent_effort) ? row.agent_effort : null);
  // The account it already has, sent back with the rest of the profile, is no change: it stays even
  // if the list no longer reads the same.
  const storedDir = row.agent_config_dir ?? null;
  const sentDir = patch.agent_config_dir;
  const keepsDir = !("agent_config_dir" in patch)
    || (storedDir === null ? sentDir === null || sentDir === "" : typeof sentDir === "string" && normalizeConfigDir(sentDir) === storedDir);
  const agentConfigDir = keepsDir ? storedDir : incomingAgentConfigDir(ctx, sentDir);
  assertRunnerActor(actor, agentConfigDir !== storedDir);
  // The pin it already has, sent back with the rest of the profile (the Bot panel sends it whole, and
  // without the endpoint when it does not know it), is no change. From level 7 a pin outlives its
  // model leaving every list (ADR 0048), and checking it against the lists again here refused every
  // other edit of that Bot.
  const unchangedPin = row.model !== null && patch.model === row.model
    && (patch.provider_id === undefined || patch.provider_id === null || patch.provider_id === row.provider_id);
  const nextTarget =
    ("model" in patch || "provider_id" in patch) && !unchangedPin
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
      `UPDATE bots SET name = ?, duties = ?, boundaries = ?, avatar = ?, model = ?, provider_id = ?, thinking_level = ?, runner = ?, agent_model = ?, agent_effort = ?, agent_config_dir = ?, updated_at = ? WHERE id = ?`,
      [name, duties, boundaries, avatar, model, providerId, thinkingLevel, runner, agentModel, agentEffort, agentConfigDir, now, id],
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
  return ctx.commit(() => {
    const row = aliveBot(ctx, id);
    if (row.archived_at) return toBot(row);
    const now = isoNow();
    cancelDelegationsForBot(ctx, { botId: id, now });
    ctx.db.run(`UPDATE turns SET status = 'interrupted', end_reason = 'bot_archived', updated_at = ? WHERE bot_id = ? AND status IN ${LIVE_TURN_STATUSES}`, [now, id]);
    ctx.db.run(`UPDATE bots SET archived_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
    ctx.db.run("UPDATE work_items SET state = 'closed', closed_at = ?, updated_at = ? WHERE bot_id = ? AND state <> 'closed'", [now, now, id]);
    return getBot(ctx, id);
  });
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
    cancelDelegationsForBot(ctx, { botId: id, now });
    ctx.db.run(`UPDATE turns SET status = 'interrupted', end_reason = 'bot_deleted', updated_at = ? WHERE bot_id = ? AND status IN ${LIVE_TURN_STATUSES}`, [now, id]);
    ctx.db.run("UPDATE work_items SET state = 'closed', closed_at = ?, updated_at = ? WHERE bot_id = ? AND state <> 'closed'", [now, now, id]);
    ctx.db.run(`UPDATE bots SET deleted_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
    ctx.db.run(
      `DELETE FROM notifications
       WHERE turn_id IN (SELECT id FROM turns WHERE bot_id = ?)
          OR session_id IN (
            SELECT session_id FROM session_participants
            WHERE member = ? AND session_id IN (SELECT id FROM sessions WHERE kind = 'direct')
          )`,
      [id, id],
    );
    ctx.db.run(
      `DELETE FROM session_notification_preferences
       WHERE session_id IN (
         SELECT session_id FROM session_participants
         WHERE member = ? AND session_id IN (SELECT id FROM sessions WHERE kind = 'direct')
       )`,
      [id],
    );
    bumpCleanupRevision(ctx);
    forgetBotRoutes(ctx, id);
    forgetBotMemories(ctx, id);
    voidCheckBacks(ctx, { botId: id }, now);
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
