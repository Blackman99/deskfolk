import {
  AGENT_KINDS,
  BOT_RUNNERS,
  USER_MEMBER,
  folkHash,
  generateBoringAvatar,
  isAgentEffort,
  isAgentModelName,
  isBotRunner,
  isClaudeModelName,
  type Bot,
  type BotRunner,
  type CreateBotRequest,
  type ProfileRevision,
  type SessionDetail,
  type ThinkingLevel,
} from "@real-bot/protocol";
import { normalizeConfigDir } from "../claude-code/account";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { customAgent, listedAgentConfigDir, listedCustomAgent } from "./agents";
import { claudeOnlyAccount } from "./settings";
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
  if (!isBotRunner(value)) throw new HttpError(422, "invalid_args", `runner must be one of ${BOT_RUNNERS.join(", ")} or null`);
  return value;
}

/**
 * A model name or alias for `agent_model` (ADR 0061, ADR 0079), as the runner names its models;
 * null or "" leaves it to the agent. Claude Code's are checked as before.
 */
function incomingAgentModel(runner: BotRunner | null, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "agent_model must be a string or null");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ((runner ?? "claude_code") === "claude_code" ? !isClaudeModelName(trimmed) : !isAgentModelName(trimmed)) {
    throw new HttpError(422, "invalid_args", `agent_model is not a ${(runner ?? "claude_code") === "claude_code" ? "Claude" : AGENT_KINDS[runner!].label} model name`);
  }
  return trimmed;
}

/** One of the runner's effort levels for `agent_effort`; null leaves it to the agent. */
function incomingAgentEffort(runner: BotRunner | null, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const trimmed = typeof value === "string" ? value.trim() : value;
  const kind = AGENT_KINDS[runner ?? "claude_code"];
  if (!isAgentEffort(kind.runner, trimmed)) {
    throw new HttpError(422, "invalid_args", kind.efforts.length > 0
      ? `agent_effort must be one of ${kind.efforts.join(", ")} or null`
      : `${kind.label} takes no effort level: agent_effort must be null`);
  }
  return trimmed;
}

/**
 * The account a local agent's turns spend (ADR 0061, ADR 0079): null or "" for the daemon's own
 * environment, otherwise one of the config directories listed in Settings for that runner, kept as
 * the list keeps it.
 */
function incomingAgentConfigDir(ctx: StoreContext, runner: BotRunner | null, value: unknown): string | null {
  return listedAgentConfigDir(ctx, runner ?? "claude_code", value, "agent_config_dir");
}

/** For `runner: "custom"`, which of your ACP agents; nothing for any other runner. */
function incomingCustomId(ctx: StoreContext, runner: BotRunner | null, value: unknown): string | null {
  if (runner !== "custom") return null;
  return listedCustomAgent(ctx, value, "agent_custom_id");
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
  const asked = incomingRunner(input.runner);
  assertRunnerActor(actor, asked !== null);
  const agentModel = incomingAgentModel(asked, input.agent_model);
  const agentEffort = incomingAgentEffort(asked, input.agent_effort);
  const askedConfigDir = incomingAgentConfigDir(ctx, asked, input.agent_config_dir);
  assertRunnerActor(actor, askedConfigDir !== null);
  const agentCustomId = incomingCustomId(ctx, asked, input.agent_custom_id);
  // Set up on Claude Code alone (ADR 0078): with no endpoint, a Bot made without saying what runs it
  // — a teammate another Bot hires included — is a Claude Agent on the account the app's own calls
  // use; on the app's own runner it could not take a single turn. You set that up, so a Bot asking
  // for nothing is not a Bot choosing your account.
  const claudeOnly = input.runner === undefined ? claudeOnlyAccount(ctx) : null;
  const runner = claudeOnly ? claudeOnly.runner : asked;
  const agentConfigDir = claudeOnly && input.agent_config_dir === undefined ? claudeOnly.configDir : askedConfigDir;
  const setupCustomId = claudeOnly?.runner === "custom" ? claudeOnly.customId : null;
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
      `INSERT INTO bots (id, name, duties, boundaries, avatar, model, provider_id, thinking_level, runner, agent_model, agent_effort, agent_config_dir, agent_custom_id, archived_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [botId, name, duties, boundaries, avatar, model, providerId, thinkingLevel, runner, agentModel, agentEffort, agentConfigDir, runner === "custom" ? (agentCustomId ?? setupCustomId) : null, now, now],
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
    agent_effort?: string | null;
    agent_config_dir?: string | null;
    agent_custom_id?: string | null;
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
  const storedRunner = isBotRunner(row.runner) ? row.runner : null;
  const runner = "runner" in patch ? incomingRunner(patch.runner) : storedRunner;
  assertRunnerActor(actor, runner !== storedRunner);
  // Moved to another agent, what was chosen for the last one means nothing to this one: its model,
  // effort and account start over unless the request names this one's.
  const moved = runner !== storedRunner && runner !== null && storedRunner !== null;
  const agentModel = "agent_model" in patch ? incomingAgentModel(runner, patch.agent_model) : (moved ? null : row.agent_model);
  const storedEffort = isAgentEffort(runner ?? "claude_code", row.agent_effort) ? row.agent_effort : null;
  const agentEffort = "agent_effort" in patch ? incomingAgentEffort(runner, patch.agent_effort) : storedEffort;
  // The account it already has, sent back with the rest of the profile, is no change: it stays even
  // if the list no longer reads the same.
  const storedDir = moved ? null : row.agent_config_dir ?? null;
  const sentDir = patch.agent_config_dir;
  const keepsDir = !("agent_config_dir" in patch)
    || (storedDir === null ? sentDir === null || sentDir === "" : typeof sentDir === "string" && normalizeConfigDir(sentDir) === storedDir);
  const agentConfigDir = keepsDir ? storedDir : incomingAgentConfigDir(ctx, runner, sentDir);
  assertRunnerActor(actor, agentConfigDir !== (row.agent_config_dir ?? null));
  const storedCustom = runner === "custom" && storedRunner === "custom" && customAgent(ctx, row.agent_custom_id) ? row.agent_custom_id : null;
  const agentCustomId = runner !== "custom" ? null
    : "agent_custom_id" in patch && patch.agent_custom_id !== storedCustom ? incomingCustomId(ctx, runner, patch.agent_custom_id)
    : storedCustom ?? incomingCustomId(ctx, runner, patch.agent_custom_id);
  assertRunnerActor(actor, agentCustomId !== (row.agent_custom_id ?? null));
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
      `UPDATE bots SET name = ?, duties = ?, boundaries = ?, avatar = ?, model = ?, provider_id = ?, thinking_level = ?, runner = ?, agent_model = ?, agent_effort = ?, agent_config_dir = ?, agent_custom_id = ?, updated_at = ? WHERE id = ?`,
      [name, duties, boundaries, avatar, model, providerId, thinkingLevel, runner, agentModel, agentEffort, agentConfigDir, agentCustomId, now, id],
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
