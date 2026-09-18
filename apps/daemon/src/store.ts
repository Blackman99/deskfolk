import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  APP_SUPPORT_DIRNAME,
  INTERRUPT_NOTE_BODY,
  KEYCHAIN_NAME,
  KEYCHAIN_REF,
  USER_MEMBER,
  generateBoringAvatar,
  isHiddenTranscriptKind,
  mcpAuthKeychainName,
  providerKeychainName,
  type McpHeader,
  type McpTransport,
  type Approval,
  type Attachment,
  type Bot,
  type ThinkingLevel,
  type CreateBotRequest,
  type CreateGroupRequest,
  type CreateProviderRequest,
  type Judgement,
  type Message,
  type PatchProviderRequest,
  type ProfileRevision,
  type Provider,
  type Reaction,
  type Routine,
  type Skill,
  type SearchHit,
  type SessionDetail,
  type SessionKind,
  type SessionParticipant,
  type SessionSummary,
  type Settings,
  type SettingsPatch,
  type Spend,
  type Theme,
  type Turn,
} from "@real-bot/protocol";
import { attachmentMime } from "./artifact-mime";
import { HttpError } from "./errors";
import { isoNow, ulid } from "./ids";
import { classifyPath } from "./workspace-paths";
import {
  catalogNames,
  normalizeAvailableModels,
  normalizeBotModel,
  normalizeBotThinkingLevel,
  normalizeDefaultModel,
  normalizeModelCatalog,
  parseStoredAvailableModels,
  parseStoredCatalog,
  parseStoredModels,
  parseStoredThinkingLevel,
  resolveProviderForModel,
  serializeCatalog,
  unionProviderModels,
} from "./models";
import {
  applyFeedbackToLearned,
  decideCompletion,
  emptyLearnedState,
  isCritiqueMessage,
  type CatalogEntry,
  type RouteDecision,
  type RouteLearnedState,
} from "./route-decision";
import { dueIso, isWeekday, latestDueAt, parseClockTime } from "./schedule";
import { SCHEMA_SQL } from "./schema";
import { codePointCount } from "./text";
import { ensureReplyMention } from "./mentions";

export { HttpError } from "./errors";

export type StoreOptions = {
  filename?: string;
  endpointKey?: EndpointKeyStore;
};

export type EndpointKeyStore = {
  get(name?: string): Promise<string | null>;
  set(value: string, name?: string): Promise<void>;
  delete(name?: string): Promise<void>;
};

type BotRow = {
  id: string;
  name: string;
  duties: string;
  boundaries: string;
  avatar: string | null;
  model: string | null;
  provider_id: string | null;
  thinking_level: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  kind: SessionKind;
  name: string | null;
  last_read_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type ParticipantRow = {
  session_id: string;
  member: string;
  joined_at: string;
  left_at: string | null;
};

export type AttachmentInput = {
  originalFilename: string;
  buffer: Uint8Array | Buffer;
};

type AttachmentRow = {
  id: string;
  message_id: string;
  workspace_relpath: string;
  original_filename: string;
  created_at: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  turn_id: string | null;
  parent_id: string | null;
  kind: Message["kind"];
  author: string;
  body: string;
  source_turn_id: string | null;
  created_at: string;
};

type TurnRow = {
  id: string;
  session_id: string;
  bot_id: string;
  status: Turn["status"];
  trigger_message_id: string;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
};

type SettingRow = { key: string; value: string };

const KNOWN_SETTING_KEYS = [
  "workspace_path",
  "endpoint_base_url",
  "endpoint_key_ref",
  "endpoint_models",
  "endpoint_default_model",
  "default_provider_id",
  "route_learned",
  "launch_at_login",
  "locale",
  "theme",
] as const;

type ProviderRow = {
  id: string;
  name: string;
  base_url: string;
  models: string;
  available_models?: string | null;
  default_model: string | null;
  created_at: string;
  updated_at: string;
};

const ALLOWED_KIND_KEYS = new Set([
  "outside-read",
  "outside-write",
  "unconstrained-shell",
  "outbound-http",
]);

export class Store {
  readonly db: Database;
  private readonly keys: EndpointKeyStore;
  private readonly cachedKeys = new Map<string, string | null>();
  private copiedLegacyKey = false;

  constructor(options: StoreOptions = {}) {
    this.db = new Database(options.filename ?? ":memory:", { create: true, strict: true });
    this.db.run("PRAGMA foreign_keys = ON");
    if (options.filename && options.filename !== ":memory:") {
      this.db.run("PRAGMA journal_mode = WAL");
    }
    this.db.exec(SCHEMA_SQL);
    migrateSchema(this.db);
    if (options.filename && options.filename !== ":memory:") {
      try {
        chmodSync(options.filename, 0o600);
      } catch {
        // ignore if the host filesystem rejects chmod
      }
    }
    this.keys = options.endpointKey ?? memoryKeyStore();
    this.ensureLegacyProviderRow();
  }

  close(): void {
    this.db.close();
  }

  async settings(): Promise<Settings> {
    await this.ensureLegacyProvider();
    const map = this.settingsMap();
    const workspace_path = emptyToNull(map.get("workspace_path"));
    const providers = await this.listProviders();
    const defaultProvider = this.defaultProviderRow(providers, emptyToNull(map.get("default_provider_id")));
    const endpoint_base_url = defaultProvider?.base_url ?? emptyToNull(map.get("endpoint_base_url"));
    const endpoint_model_catalog = defaultProvider
      ? defaultProvider.model_catalog
      : providers.flatMap((provider) => provider.model_catalog);
    const endpoint_models = defaultProvider
      ? defaultProvider.models
      : unionProviderModels(
          providers.map((provider) => ({
            id: provider.id,
            models: provider.models,
            defaultModel: provider.default_model,
          })),
        );
    const endpoint_default_model = defaultProvider?.default_model ?? null;
    const keySet = defaultProvider
      ? defaultProvider.key_set
      : providers.some((provider) => provider.key_set);
    const locale = map.get("locale") === "en" ? "en" : "zh";
    const themeRaw = map.get("theme");
    const theme: Theme = themeRaw === "light" || themeRaw === "dark" ? themeRaw : "system";
    const launch_at_login = map.get("launch_at_login") !== "0";
    return {
      workspace_path,
      endpoint_base_url,
      endpoint_key_set: keySet,
      endpoint_models,
      endpoint_model_catalog,
      endpoint_default_model,
      default_provider_id: defaultProvider?.id ?? null,
      launch_at_login,
      locale,
      theme,
      wizard_complete: Boolean(workspace_path && providers.some((provider) => provider.base_url && provider.key_set)),
    };
  }

  async patchSettings(patch: SettingsPatch | Record<string, unknown>): Promise<Settings> {
    await this.ensureLegacyProvider();
    const nowKeys = Object.keys(patch);
    if (nowKeys.length === 0) {
      throw new HttpError(422, "invalid_args", "PATCH body must include at least one field");
    }
    for (const key of nowKeys) {
      if (
        key !== "workspace_path" &&
        key !== "endpoint_base_url" &&
        key !== "endpoint_api_key" &&
        key !== "endpoint_models" &&
        key !== "endpoint_default_model" &&
        key !== "default_provider_id" &&
        key !== "launch_at_login" &&
        key !== "locale" &&
        key !== "theme"
      ) {
        throw new HttpError(422, "invalid_args", `unknown settings field: ${key}`);
      }
    }
    if ("workspace_path" in patch) {
      this.setSetting("workspace_path", resolveWorkspacePath(patch.workspace_path));
    }
    if ("launch_at_login" in patch) {
      if (typeof patch.launch_at_login !== "boolean") {
        throw new HttpError(422, "invalid_args", "launch_at_login must be a boolean");
      }
      this.setSetting("launch_at_login", patch.launch_at_login ? "1" : "0");
    }
    if ("locale" in patch) {
      if (patch.locale !== "zh" && patch.locale !== "en") {
        throw new HttpError(422, "invalid_args", "locale must be zh or en");
      }
      this.setSetting("locale", patch.locale);
    }
    if ("theme" in patch) {
      if (patch.theme !== "system" && patch.theme !== "light" && patch.theme !== "dark") {
        throw new HttpError(422, "invalid_args", "theme must be system, light, or dark");
      }
      this.setSetting("theme", patch.theme);
    }
    if ("default_provider_id" in patch) {
      const nextId = normalizeOptionalId(patch.default_provider_id, "default_provider_id");
      if (nextId) this.requireProvider(nextId);
      this.setSetting("default_provider_id", nextId ?? "");
    }
    const touchesEndpoint =
      "endpoint_base_url" in patch ||
      "endpoint_api_key" in patch ||
      "endpoint_models" in patch ||
      "endpoint_default_model" in patch;
    if (touchesEndpoint) {
      const current = this.settingsMap();
      const providers = await this.listProviders();
      const target =
        this.defaultProviderRow(providers, emptyToNull(current.get("default_provider_id"))) ??
        providers[0] ??
        null;
      const providerPatch: PatchProviderRequest = {};
      if ("endpoint_base_url" in patch) {
        providerPatch.base_url = resolveEndpointUrl(patch.endpoint_base_url);
      }
      if ("endpoint_models" in patch) providerPatch.models = normalizeModelCatalog(patch.endpoint_models);
      if ("endpoint_default_model" in patch) {
        providerPatch.default_model = typeof patch.endpoint_default_model === "string"
          ? patch.endpoint_default_model
          : "";
      }
      if ("endpoint_api_key" in patch) {
        if (typeof patch.endpoint_api_key !== "string") {
          throw new HttpError(422, "invalid_args", "endpoint_api_key must be a string");
        }
        providerPatch.api_key = patch.endpoint_api_key;
      }
      if (target) {
        await this.patchProvider(target.id, providerPatch);
      } else {
        const created = await this.createProvider({
          name: "Default",
          base_url: providerPatch.base_url ?? "",
          api_key: providerPatch.api_key,
          models: providerPatch.models,
          default_model: providerPatch.default_model,
        });
        this.setSetting("default_provider_id", created.id);
        this.mirrorDefaultProvider();
      }
    }
    return this.settings();
  }

  async endpointKey(providerId?: string | null): Promise<string | null> {
    await this.ensureLegacyProvider();
    const id = providerId ?? this.defaultProviderId();
    if (!id) return this.readKey(KEYCHAIN_NAME);
    return this.readKey(providerKeychainName(id));
  }

  workspacePath(): string | null {
    return emptyToNull(this.settingsMap().get("workspace_path"));
  }

  listBots(): Bot[] {
    const rows = this.db
      .query<BotRow, []>(
        `SELECT * FROM bots WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id`,
      )
      .all();
    return rows.map(toBot);
  }

  getBot(id: string): Bot {
    const row = this.aliveBot(id);
    return toBot(row);
  }

  createBot(
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
    const { model, providerId } = this.resolveIncomingBotTarget(input.model, input.provider_id);
    const thinkingLevel = this.resolveIncomingThinkingLevel(input.thinking_level, model, providerId);
    this.assertNameFree(name);
    const now = isoNow();
    const botId = ulid();
    const sessionId = ulid();
    const revisionId = ulid();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO bots (id, name, duties, boundaries, avatar, model, provider_id, thinking_level, archived_at, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [botId, name, duties, boundaries, avatar, model, providerId, thinkingLevel, now, now],
      );
      this.db.run(
        `INSERT INTO profile_revisions (id, bot_id, name, duties, boundaries, avatar, actor, message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [revisionId, botId, name, duties, boundaries, avatar, actor, now],
      );
      this.db.run(
        `INSERT INTO sessions (id, kind, name, last_read_at, created_at, updated_at) VALUES (?, 'direct', NULL, ?, ?, ?)`,
        [sessionId, now, now, now],
      );
      this.db.run(
        `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
        [sessionId, USER_MEMBER, now],
      );
      this.db.run(
        `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
        [sessionId, botId, now],
      );
    })();
    return {
      bot: this.getBot(botId),
      direct_session: this.getSession(sessionId),
    };
  }

  patchBot(
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
    const row = this.aliveBot(id);
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
        ? this.resolveIncomingBotTarget(
            "model" in patch ? patch.model : row.model,
            "provider_id" in patch ? patch.provider_id : row.provider_id,
          )
        : { model: row.model, providerId: row.provider_id };
    const model = nextTarget.model;
    const providerId = nextTarget.providerId;
    const thinkingLevel =
      "thinking_level" in patch
        ? this.resolveIncomingThinkingLevel(patch.thinking_level, model, providerId)
        : this.carriedThinkingLevel(row.thinking_level, model, providerId);
    if (name !== row.name) this.assertNameFree(name);
    const now = isoNow();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE bots SET name = ?, duties = ?, boundaries = ?, avatar = ?, model = ?, provider_id = ?, thinking_level = ?, updated_at = ? WHERE id = ?`,
        [name, duties, boundaries, avatar, model, providerId, thinkingLevel, now, id],
      );
      this.db.run(
        `INSERT INTO profile_revisions (id, bot_id, name, duties, boundaries, avatar, actor, message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [ulid(), id, name, duties, boundaries, avatar, actor, now],
      );
    })();
    return this.getBot(id);
  }

  archiveBot(id: string): Bot {
    const row = this.aliveBot(id);
    if (row.archived_at) return toBot(row);
    const now = isoNow();
    this.db.run(`UPDATE bots SET archived_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
    return this.getBot(id);
  }

  restoreBot(id: string): Bot {
    const row = this.aliveBot(id);
    if (!row.archived_at) return toBot(row);
    const now = isoNow();
    this.db.run(`UPDATE bots SET archived_at = NULL, updated_at = ? WHERE id = ?`, [now, id]);
    return this.getBot(id);
  }

  deleteBot(id: string): void {
    this.aliveBot(id);
    const now = isoNow();
    this.db.run(`UPDATE bots SET deleted_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
  }

  listProfileRevisions(botId: string): ProfileRevision[] {
    this.aliveBot(botId);
    return this.db
      .query<ProfileRevision, [string]>(
        `SELECT id, bot_id, name, duties, boundaries, avatar, actor, message_id, created_at
         FROM profile_revisions WHERE bot_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(botId);
  }

  attachLatestRevisionMessage(botId: string, messageId: string): void {
    const latest = this.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM profile_revisions WHERE bot_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(botId);
    if (!latest) return;
    this.db.run(`UPDATE profile_revisions SET message_id = ? WHERE id = ?`, [messageId, latest.id]);
  }

  listSessions(): SessionSummary[] {
    const deletedBotIds = new Set(
      this.db
        .query<{ id: string }, []>(`SELECT id FROM bots WHERE deleted_at IS NOT NULL`)
        .all()
        .map((r) => r.id),
    );
    const sessions = this.db
      .query<SessionRow, []>(`SELECT * FROM sessions ORDER BY updated_at DESC, id DESC`)
      .all();
    const participants = this.db
      .query<ParticipantRow, []>(`SELECT * FROM session_participants`)
      .all();
    const bySession = new Map<string, SessionParticipant[]>();
    for (const p of participants) {
      const list = bySession.get(p.session_id) ?? [];
      list.push({ member: p.member, joined_at: p.joined_at, left_at: p.left_at });
      bySession.set(p.session_id, list);
    }
    const lastMsgRows = this.db
      .query<MessageRow, []>(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, id DESC) as rn
           FROM messages
           WHERE kind != 'profile_change'
         ) WHERE rn = 1`,
      )
      .all();
    const lastMessagesBySession = new Map<string, Message>();
    for (const row of lastMsgRows) {
      lastMessagesBySession.set(row.session_id, this.hydrateMessage(row));
    }
    const liveTurnRows = this.db
      .query<TurnRow, []>(
        `SELECT * FROM turns
         WHERE status IN ('running', 'waiting_approval', 'waiting_ask')
         ORDER BY last_activity_at DESC, id DESC`,
      )
      .all();
    const liveTurnsBySession = new Map<string, Turn[]>();
    for (const row of liveTurnRows) {
      const list = liveTurnsBySession.get(row.session_id) ?? [];
      list.push(toTurn(row));
      liveTurnsBySession.set(row.session_id, list);
    }
    const unreadBySession = this.unreadCountsBySession();
    return sessions
      .filter((s) => {
        const parts = bySession.get(s.id) ?? [];
        const active = parts.filter((p) => p.left_at === null).map((p) => p.member);
        if (s.kind === "direct") {
          const peer = active.find((m) => m !== USER_MEMBER);
          if (peer && deletedBotIds.has(peer)) return false;
          // For bot-bot direct, if any bot is deleted, hide
          if (active.some((m) => deletedBotIds.has(m))) return false;
        }
        return true;
      })
      .map((s) => ({
        ...s,
        last_read_at: s.last_read_at ?? null,
        archived_at: s.archived_at ?? null,
        participants: bySession.get(s.id) ?? [],
        last_message: lastMessagesBySession.get(s.id) ?? null,
        live_turns: liveTurnsBySession.get(s.id) ?? [],
        unread_count: unreadBySession.get(s.id) ?? 0,
      }));
  }

  getSession(id: string): SessionDetail {
    const session = this.sessionRow(id);
    const participants = this.listParticipants(id);
    const messages = this.listMessages(id, { limit: 50 });
    const turns = this.db
      .query<TurnRow, [string]>(
        `SELECT * FROM turns
         WHERE session_id = ? AND status IN ('running', 'waiting_approval', 'waiting_ask')
         ORDER BY last_activity_at DESC`,
      )
      .all(id)
      .map((t) => ({ ...t, partial_text: null }));
    return {
      ...session,
      last_read_at: session.last_read_at ?? null,
      archived_at: session.archived_at ?? null,
      participants,
      messages,
      turns,
      unread_count: this.unreadCount(id),
    };
  }

  markSessionRead(id: string, at: string = isoNow()): SessionDetail {
    this.sessionRow(id);
    this.db.run(`UPDATE sessions SET last_read_at = ? WHERE id = ?`, [at, id]);
    return this.getSession(id);
  }

  createGroup(input: CreateGroupRequest): SessionDetail {
    const name = requireNonEmpty("name", input.name);
    if (!Array.isArray(input.members) || input.members.length === 0) {
      throw new HttpError(422, "invalid_args", "members must include at least two bots");
    }
    const unique = [...new Set(input.members)];
    const bots = unique.map((id) => this.aliveBot(id));
    if (bots.length < 2) {
      throw new HttpError(422, "invalid_args", "a group needs at least two bots");
    }
    const now = isoNow();
    const sessionId = ulid();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO sessions (id, kind, name, last_read_at, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?)`,
        [sessionId, name, now, now, now],
      );
      this.db.run(
        `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
        [sessionId, USER_MEMBER, now],
      );
      for (const bot of bots) {
        this.db.run(
          `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
          [sessionId, bot.id, now],
        );
      }
    })();
    return this.getSession(sessionId);
  }

  renameSession(id: string, name: string): SessionDetail {
    const session = this.sessionRow(id);
    if (session.kind !== "group") {
      throw new HttpError(422, "invalid_args", "only groups have a name");
    }
    const next = requireNonEmpty("name", name);
    const now = isoNow();
    this.db.run(`UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?`, [next, now, id]);
    return this.getSession(id);
  }

  archiveSession(id: string): SessionDetail {
    const session = this.sessionRow(id);
    if (session.archived_at) return this.getSession(id);
    const now = isoNow();
    this.db.run(`UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
    return this.getSession(id);
  }

  restoreSession(id: string): SessionDetail {
    const session = this.sessionRow(id);
    if (!session.archived_at) return this.getSession(id);
    const now = isoNow();
    this.db.run(`UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ?`, [now, id]);
    return this.getSession(id);
  }

  deleteSession(id: string): void {
    const session = this.sessionRow(id);
    if (session.kind !== "group") {
      throw new HttpError(422, "invalid_args", "only groups can be deleted");
    }
    this.db.transaction(() => {
      this.db.run(
        `UPDATE profile_revisions SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
        [id],
      );
      this.db.run(
        `DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
        [id],
      );
      this.db.run(
        `DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
        [id],
      );
      this.db.run(
        `DELETE FROM approvals WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?) OR message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
        [id, id],
      );
      this.db.run(
        `DELETE FROM route_feedback WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)`,
        [id],
      );
      this.db.run(`DELETE FROM turn_route_decisions WHERE session_id = ?`, [id]);
      this.db.run(`DELETE FROM judgements WHERE session_id = ?`, [id]);
      this.db.run(`DELETE FROM turns WHERE session_id = ?`, [id]);
      this.db.run(`DELETE FROM messages WHERE session_id = ?`, [id]);
      this.db.run(`DELETE FROM spend WHERE session_id = ?`, [id]);
      this.db.run(`DELETE FROM session_participants WHERE session_id = ?`, [id]);
      this.db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
    })();
  }

  clearSessionMessages(id: string): void {
    this.sessionRow(id);
    const now = isoNow();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE profile_revisions SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
        [id],
      );
      this.db.run(
        `DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
        [id],
      );
      this.db.run(
        `DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
        [id],
      );
      this.db.run(
        `DELETE FROM approvals WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?) OR message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
        [id, id],
      );
      this.db.run(
        `DELETE FROM route_feedback WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)`,
        [id],
      );
      this.db.run(`DELETE FROM turn_route_decisions WHERE session_id = ?`, [id]);
      this.db.run(`DELETE FROM judgements WHERE session_id = ?`, [id]);
      this.db.run(`DELETE FROM turns WHERE session_id = ?`, [id]);
      this.db.run(`DELETE FROM messages WHERE session_id = ?`, [id]);
      this.db.run(`UPDATE sessions SET last_read_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
    })();
  }

  addMember(sessionId: string, botId: string): SessionDetail {
    const session = this.sessionRow(sessionId);
    if (session.kind !== "group") {
      throw new HttpError(422, "invalid_args", "only groups have members you can add");
    }
    this.aliveBot(botId);
    const existing = this.db
      .query<ParticipantRow, [string, string]>(
        `SELECT * FROM session_participants WHERE session_id = ? AND member = ?`,
      )
      .get(sessionId, botId);
    const now = isoNow();
    if (!existing) {
      this.db.run(
        `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
        [sessionId, botId, now],
      );
    } else if (existing.left_at) {
      this.db.run(
        `UPDATE session_participants SET left_at = NULL, joined_at = ? WHERE session_id = ? AND member = ?`,
        [now, sessionId, botId],
      );
    }
    this.touchSession(sessionId, now);
    return this.getSession(sessionId);
  }

  removeMember(sessionId: string, botId: string): SessionDetail {
    const session = this.sessionRow(sessionId);
    if (session.kind !== "group") {
      throw new HttpError(422, "invalid_args", "only groups have members you can remove");
    }
    if (botId === USER_MEMBER) {
      throw new HttpError(422, "invalid_args", "you stay in every group");
    }
    const existing = this.db
      .query<ParticipantRow, [string, string]>(
        `SELECT * FROM session_participants WHERE session_id = ? AND member = ?`,
      )
      .get(sessionId, botId);
    if (!existing || existing.left_at) {
      throw new HttpError(404, "not_found", "member not in this group");
    }
    const presentBots = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM session_participants
         WHERE session_id = ? AND member != 'user' AND left_at IS NULL`,
      )
      .get(sessionId);
    if ((presentBots?.n ?? 0) <= 2) {
      throw new HttpError(422, "invalid_args", "a group needs at least two bots");
    }
    const now = isoNow();
    this.db.run(
      `UPDATE session_participants SET left_at = ? WHERE session_id = ? AND member = ?`,
      [now, sessionId, botId],
    );
    this.touchSession(sessionId, now);
    return this.getSession(sessionId);
  }

  listMessages(
    sessionId: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ): { items: Message[]; next: string | null } {
    this.sessionRow(sessionId);
    const limit = clampLimit(opts.limit);
    const cursor = opts.cursor ?? null;
    const rows = cursor
      ? this.db
          .query<MessageRow, [string, string, string, string, number]>(
            `SELECT * FROM messages
             WHERE session_id = ? AND kind != 'profile_change'
               AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(sessionId, cursorTime(cursor), cursorTime(cursor), cursorId(cursor), limit + 1)
      : this.db
          .query<MessageRow, [string, number]>(
            `SELECT * FROM messages
             WHERE session_id = ? AND kind != 'profile_change'
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(sessionId, limit + 1);
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? `${page[page.length - 1]!.created_at}|${page[page.length - 1]!.id}` : null;
    const items = page.map((row) => this.hydrateMessage(row));
    return { items, next };
  }

  postMessage(
    sessionId: string,
    input: { body: string; parent_id?: string | null; attachments?: AttachmentInput[] },
  ): Message {
    this.sessionRow(sessionId);
    const parentId = input.parent_id ?? null;
    const parent = parentId ? this.requireMainParent(sessionId, parentId) : null;
    const body = this.withReplyMention(requireString("body", input.body), parent, USER_MEMBER);
    const now = isoNow();
    const id = ulid();
    this.db.run(
      `INSERT INTO messages (id, session_id, turn_id, parent_id, kind, author, body, source_turn_id, created_at)
       VALUES (?, ?, NULL, ?, 'user', ?, ?, NULL, ?)`,
      [id, sessionId, parentId, USER_MEMBER, body, now],
    );

    if (input.attachments && input.attachments.length > 0) {
      const ws = this.workspacePath();
      const inboxDir = ws
        ? join(ws, "inbox")
        : join(homedir(), "Library", "Application Support", APP_SUPPORT_DIRNAME, "inbox");
      mkdirSync(inboxDir, { recursive: true });

      for (const att of input.attachments) {
        const rawName =
          basename(att.originalFilename).replace(/[^\w.\- \u4e00-\u9fa5]/g, "_").trim() || "attachment";
        const ext = extname(rawName);
        const base = basename(rawName, ext);
        let targetName = rawName;
        let counter = 1;
        while (existsSync(join(inboxDir, targetName))) {
          targetName = `${base}-${counter}${ext}`;
          counter++;
        }
        writeFileSync(join(inboxDir, targetName), att.buffer);
        const workspaceRelpath = `inbox/${targetName}`;
        const attId = ulid();
        const attNow = isoNow();
        this.db.run(
          `INSERT INTO attachments (id, message_id, workspace_relpath, original_filename, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [attId, id, workspaceRelpath, att.originalFilename || targetName, attNow],
        );
      }
    }

    this.touchSession(sessionId, now);
    return this.hydrateMessage(
      this.db.query<MessageRow, [string]>(`SELECT * FROM messages WHERE id = ?`).get(id)!,
    );
  }

  insertMessage(input: {
    sessionId: string;
    turnId?: string | null;
    parentId?: string | null;
    kind: Message["kind"];
    author: string;
    body: string;
    sourceTurnId?: string | null;
    paths?: string[];
  }): Message {
    this.sessionRow(input.sessionId);
    const parentId = input.parentId ?? null;
    const parent = parentId ? this.requireMainParent(input.sessionId, parentId) : null;
    const body =
      input.kind === "bot" || input.kind === "user"
        ? this.withReplyMention(input.body, parent, input.author)
        : input.body;
    const now = isoNow();
    const id = ulid();
    this.db.run(
      `INSERT INTO messages (id, session_id, turn_id, parent_id, kind, author, body, source_turn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.sessionId,
        input.turnId ?? null,
        parentId,
        input.kind,
        input.author,
        body,
        input.sourceTurnId ?? null,
        now,
      ],
    );
    if (input.paths && input.paths.length > 0) {
      this.insertPathAttachments(id, input.paths, now);
    }
    this.touchSession(input.sessionId, now);
    return this.getMessage(id);
  }

  getMessage(id: string): Message {
    return this.hydrateMessage(this.messageRow(id));
  }

  listMainMessages(sessionId: string, limit: number): Message[] {
    this.sessionRow(sessionId);
    const rows = this.db
      .query<MessageRow, [string, number]>(
        `SELECT * FROM messages
         WHERE session_id = ? AND kind != 'profile_change'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(sessionId, limit);
    return rows.map((row) => this.hydrateMessage(row));
  }

  private requireMainParent(sessionId: string, parentId: string): MessageRow {
    const parent = this.db
      .query<MessageRow, [string]>(`SELECT * FROM messages WHERE id = ?`)
      .get(parentId);
    if (!parent || parent.session_id !== sessionId) {
      throw new HttpError(422, "invalid_args", "parent_id must be a message in this session");
    }
    if (parent.parent_id) {
      throw new HttpError(422, "invalid_args", "threads are one level deep");
    }
    return parent;
  }

  private withReplyMention(body: string, parent: MessageRow | null, selfAuthor: string): string {
    if (!parent || parent.author === USER_MEMBER) return body;
    let parentName: string | null = null;
    try {
      parentName = this.getBot(parent.author).name;
    } catch {
      parentName = null;
    }
    return ensureReplyMention(body, {
      parentAuthor: parent.author,
      parentName,
      selfAuthor,
      rosterNames: this.listBots().map((b) => b.name),
    });
  }

  listThreadMessages(parentId: string): Message[] {
    const parent = this.getMessage(parentId);
    const replies = this.db
      .query<MessageRow, [string]>(
        `SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(parentId)
      .map((row) => this.hydrateMessage(row))
      .filter((m) => !isHiddenTranscriptKind(m.kind));
    return isHiddenTranscriptKind(parent.kind) ? replies : [parent, ...replies];
  }

  findBotByName(name: string): Bot | null {
    const row = this.db
      .query<BotRow, [string]>(`SELECT * FROM bots WHERE name = ? AND deleted_at IS NULL`)
      .get(name);
    return row ? toBot(row) : null;
  }

  requireBotByName(name: string): Bot {
    const bot = this.findBotByName(name);
    if (!bot) throw new HttpError(404, "not_found", "bot not found");
    return bot;
  }

  listParticipants(sessionId: string): SessionParticipant[] {
    return this.db
      .query<ParticipantRow, [string]>(
        `SELECT * FROM session_participants WHERE session_id = ? ORDER BY joined_at ASC`,
      )
      .all(sessionId)
      .map((p) => ({ member: p.member, joined_at: p.joined_at, left_at: p.left_at }));
  }

  presentParticipants(sessionId: string): SessionParticipant[] {
    return this.listParticipants(sessionId).filter((p) => p.left_at === null);
  }

  isPresent(sessionId: string, member: string): boolean {
    const row = this.db
      .query<ParticipantRow, [string, string]>(
        `SELECT * FROM session_participants WHERE session_id = ? AND member = ?`,
      )
      .get(sessionId, member);
    return Boolean(row && row.left_at === null);
  }

  presentBotIds(sessionId: string): string[] {
    return this.presentParticipants(sessionId)
      .map((p) => p.member)
      .filter((m) => m !== USER_MEMBER);
  }

  findDirectSession(memberA: string, memberB: string): SessionDetail | null {
    const row = this.db
      .query<SessionRow, [string, string]>(
        `SELECT s.* FROM sessions s
         JOIN session_participants p1
           ON p1.session_id = s.id AND p1.member = ? AND p1.left_at IS NULL
         JOIN session_participants p2
           ON p2.session_id = s.id AND p2.member = ? AND p2.left_at IS NULL
         WHERE s.kind = 'direct'
           AND (
             SELECT COUNT(*) FROM session_participants p
             WHERE p.session_id = s.id AND p.left_at IS NULL
           ) = 2
         ORDER BY s.created_at ASC, s.id ASC
         LIMIT 1`,
      )
      .get(memberA, memberB);
    return row ? this.getSession(row.id) : null;
  }

  createDirect(memberA: string, memberB: string): SessionDetail {
    if (memberA === memberB) {
      throw new HttpError(422, "invalid_args", "a direct session needs two different members");
    }
    const existing = this.findDirectSession(memberA, memberB);
    if (existing) return existing;
    if (memberA !== USER_MEMBER) this.aliveBot(memberA);
    if (memberB !== USER_MEMBER) this.aliveBot(memberB);
    const now = isoNow();
    const sessionId = ulid();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO sessions (id, kind, name, last_read_at, created_at, updated_at) VALUES (?, 'direct', NULL, ?, ?, ?)`,
        [sessionId, now, now, now],
      );
      this.db.run(
        `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
        [sessionId, memberA, now],
      );
      this.db.run(
        `INSERT INTO session_participants (session_id, member, joined_at, left_at) VALUES (?, ?, ?, NULL)`,
        [sessionId, memberB, now],
      );
    })();
    return this.getSession(sessionId);
  }

  createTurn(input: { sessionId: string; botId: string; triggerMessageId: string }): Turn {
    this.sessionRow(input.sessionId);
    this.aliveBot(input.botId);
    this.messageRow(input.triggerMessageId);
    const now = isoNow();
    const id = ulid();
    this.db.run(
      `INSERT INTO turns
        (id, session_id, bot_id, status, trigger_message_id, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
      [id, input.sessionId, input.botId, input.triggerMessageId, now, now, now],
    );
    return this.getTurn(id);
  }

  getTurn(id: string): Turn {
    const row = this.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "turn not found");
    return toTurn(row);
  }

  listLiveTurns(filter: { sessionId?: string; botId?: string } = {}): Turn[] {
    let sql = `SELECT * FROM turns WHERE status IN ('running', 'waiting_approval', 'waiting_ask')`;
    const args: string[] = [];
    if (filter.sessionId) {
      sql += ` AND session_id = ?`;
      args.push(filter.sessionId);
    }
    if (filter.botId) {
      sql += ` AND bot_id = ?`;
      args.push(filter.botId);
    }
    sql += ` ORDER BY last_activity_at DESC, id DESC`;
    return this.db.query<TurnRow, string[]>(sql).all(...args).map((row) => toTurn(row));
  }

  setTurnStatus(id: string, status: Turn["status"]): Turn {
    const row = this.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "turn not found");
    const now = isoNow();
    this.db.run(
      `UPDATE turns SET status = ?, last_activity_at = ?, updated_at = ? WHERE id = ?`,
      [status, now, now, id],
    );
    return this.getTurn(id);
  }

  touchTurn(id: string): Turn {
    const now = isoNow();
    this.db.run(`UPDATE turns SET last_activity_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
    return this.getTurn(id);
  }

  redirectTurn(id: string): Turn {
    const row = this.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "turn not found");
    if (!isLive(row.status)) return toTurn(row);
    const now = isoNow();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE turns SET status = 'redirected', last_activity_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, id],
      );
      this.db.run(
        `UPDATE approvals SET status = 'voided', resolved_at = ? WHERE turn_id = ? AND status = 'pending'`,
        [now, id],
      );
    })();
    return this.getTurn(id);
  }

  insertSpend(input: {
    sessionId: string;
    botId: string;
    turnId?: string | null;
    judgementId?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    cachedTokens?: number | null;
    reasoningTokens?: number | null;
    costUsdTicks?: number | null;
    missingReason?: Spend["missing_reason"];
  }): Spend {
    const now = isoNow();
    const row: Spend = {
      id: ulid(),
      session_id: input.sessionId,
      bot_id: input.botId,
      turn_id: input.turnId ?? null,
      judgement_id: input.judgementId ?? null,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      total_tokens: input.totalTokens ?? null,
      cached_tokens: input.cachedTokens ?? null,
      reasoning_tokens: input.reasoningTokens ?? null,
      cost_usd_ticks: input.costUsdTicks ?? null,
      missing_reason: input.missingReason ?? null,
      created_at: now,
    };
    this.db.run(
      `INSERT INTO spend (
         id, session_id, bot_id, turn_id, judgement_id,
         input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens,
         cost_usd_ticks, missing_reason, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.session_id,
        row.bot_id,
        row.turn_id,
        row.judgement_id,
        row.input_tokens,
        row.output_tokens,
        row.total_tokens,
        row.cached_tokens,
        row.reasoning_tokens,
        row.cost_usd_ticks,
        row.missing_reason,
        row.created_at,
      ],
    );
    return row;
  }

  insertJudgement(input: {
    sessionId: string;
    messageId: string;
    botId: string;
    decision: Judgement["decision"];
    reason?: string | null;
    error?: Judgement["error"];
  }): Judgement {
    const row: Judgement = {
      id: ulid(),
      session_id: input.sessionId,
      message_id: input.messageId,
      bot_id: input.botId,
      decision: input.decision,
      reason: input.reason ?? null,
      error: input.error ?? null,
      created_at: isoNow(),
    };
    this.db.run(
      `INSERT INTO judgements (id, session_id, message_id, bot_id, decision, reason, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.session_id,
        row.message_id,
        row.bot_id,
        row.decision,
        row.reason,
        row.error,
        row.created_at,
      ],
    );
    return row;
  }

  pendingInterrupt(botId: string): boolean {
    return this.pendingInterruptSet().has(botId);
  }

  markInterruptPending(botId: string): void {
    const set = this.pendingInterruptSet();
    set.add(botId);
    this.writePendingInterrupts(set);
  }

  clearInterruptPending(botId: string): void {
    const set = this.pendingInterruptSet();
    if (!set.delete(botId)) return;
    this.writePendingInterrupts(set);
  }

  recoverInterruptedTurns(): void {
    this.interruptRunningTurns();
  }

  putReaction(messageId: string, emoji: string): void {
    this.messageRow(messageId);
    const now = isoNow();
    this.db.run(
      `INSERT OR IGNORE INTO reactions (message_id, actor, emoji, created_at) VALUES (?, ?, ?, ?)`,
      [messageId, USER_MEMBER, emoji, now],
    );
  }

  deleteReaction(messageId: string, emoji: string): void {
    this.messageRow(messageId);
    this.db.run(`DELETE FROM reactions WHERE message_id = ? AND actor = ? AND emoji = ?`, [
      messageId,
      USER_MEMBER,
      emoji,
    ]);
  }

  listAllowRules() {
    return this.db
      .query<{ id: string; kind_key: string; scope: string; created_at: string }, []>(
        `SELECT * FROM allow_rules ORDER BY created_at ASC`,
      )
      .all();
  }

  createAllowRule(kind_key: string, scope: string) {
    if (!ALLOWED_KIND_KEYS.has(kind_key)) {
      throw new HttpError(422, "invalid_args", "this kind cannot be Always allow");
    }
    const nextScope = requireNonEmpty("scope", scope);
    if (kind_key === "unconstrained-shell" && nextScope !== "*") {
      throw new HttpError(422, "invalid_args", "unconstrained-shell scope must be *");
    }
    const existing = this.db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM allow_rules WHERE kind_key = ? AND scope = ?`,
      )
      .get(kind_key, nextScope);
    if (existing) {
      return this.db
        .query<{ id: string; kind_key: string; scope: string; created_at: string }, [string]>(
          `SELECT * FROM allow_rules WHERE id = ?`,
        )
        .get(existing.id)!;
    }
    const row = {
      id: ulid(),
      kind_key,
      scope: nextScope,
      created_at: isoNow(),
    };
    this.db.run(`INSERT INTO allow_rules (id, kind_key, scope, created_at) VALUES (?, ?, ?, ?)`, [
      row.id,
      row.kind_key,
      row.scope,
      row.created_at,
    ]);
    return row;
  }

  deleteAllowRule(id: string): void {
    const changes = this.db.run(`DELETE FROM allow_rules WHERE id = ?`, [id]).changes;
    if (changes === 0) throw new HttpError(404, "not_found", "allow rule not found");
  }

  async listProviders(): Promise<Provider[]> {
    await this.ensureLegacyProvider();
    const rows = this.db
      .query<ProviderRow, []>(`SELECT * FROM providers ORDER BY created_at ASC, id`)
      .all();
    const out: Provider[] = [];
    for (const row of rows) out.push(await this.toProvider(row));
    return out;
  }

  async getProvider(id: string): Promise<Provider> {
    await this.ensureLegacyProvider();
    return this.toProvider(this.requireProvider(id));
  }

  async createProvider(input: CreateProviderRequest): Promise<Provider> {
    await this.ensureLegacyProvider();
    const name = requireNonEmpty("name", input.name);
    const baseUrl =
      typeof input.base_url === "string" && input.base_url.trim().length === 0
        ? ""
        : resolveEndpointUrl(input.base_url);
    const catalog = input.models !== undefined ? normalizeModelCatalog(input.models) : [];
    const models = catalogNames(catalog);
    const availableModels =
      input.available_models !== undefined ? normalizeAvailableModels(input.available_models) : [];
    const defaultModel =
      input.default_model !== undefined
        ? normalizeDefaultModel(input.default_model, models)
        : (models[0] ?? null);
    const now = isoNow();
    const id = ulid();
    this.db.run(
      `INSERT INTO providers (id, name, base_url, models, available_models, default_model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, baseUrl, serializeCatalog(catalog), JSON.stringify(availableModels), defaultModel, now, now],
    );
    if (typeof input.api_key === "string" && input.api_key.length > 0) {
      await this.writeProviderKey(id, input.api_key);
    }
    if (!this.defaultProviderId()) this.setSetting("default_provider_id", id);
    this.mirrorDefaultProvider();
    return this.getProvider(id);
  }

  async patchProvider(id: string, patch: PatchProviderRequest): Promise<Provider> {
    await this.ensureLegacyProvider();
    const current = this.requireProvider(id);
    const name = patch.name !== undefined ? requireNonEmpty("name", patch.name) : current.name;
    const baseUrl =
      patch.base_url !== undefined ? resolveEndpointUrl(patch.base_url) : current.base_url;
    let catalog = parseStoredCatalog(current.models);
    if (patch.models !== undefined) {
      catalog = normalizeModelCatalog(patch.models);
      this.dropUnknownBotModelsForProvider(id, catalogNames(catalog));
    }
    const models = catalogNames(catalog);
    const availableModels =
      patch.available_models !== undefined
        ? normalizeAvailableModels(patch.available_models)
        : parseStoredAvailableModels(current.available_models);
    let defaultModel = emptyToNull(current.default_model);
    if (patch.default_model !== undefined) {
      defaultModel = normalizeDefaultModel(patch.default_model, models);
    } else if (defaultModel && !models.includes(defaultModel)) {
      defaultModel = models[0] ?? null;
    } else if (!defaultModel && models.length > 0) {
      defaultModel = models[0]!;
    }
    const now = isoNow();
    this.db.run(
      `UPDATE providers SET name = ?, base_url = ?, models = ?, available_models = ?, default_model = ?, updated_at = ? WHERE id = ?`,
      [name, baseUrl, serializeCatalog(catalog), JSON.stringify(availableModels), defaultModel, now, id],
    );
    if (patch.api_key !== undefined) {
      if (typeof patch.api_key !== "string") {
        throw new HttpError(422, "invalid_args", "api_key must be a string");
      }
      await this.writeProviderKey(id, patch.api_key);
    }
    this.mirrorDefaultProvider();
    return this.getProvider(id);
  }

  async deleteProvider(id: string): Promise<void> {
    await this.ensureLegacyProvider();
    this.requireProvider(id);
    const remaining = this.db
      .query<ProviderRow, [string]>(`SELECT * FROM providers WHERE id != ? ORDER BY created_at ASC, id`)
      .all(id);
    const now = isoNow();
    this.db.transaction(() => {
      this.db.run(`UPDATE bots SET provider_id = NULL, updated_at = ? WHERE provider_id = ?`, [now, id]);
      const changes = this.db.run(`DELETE FROM providers WHERE id = ?`, [id]).changes;
      if (changes === 0) throw new HttpError(404, "not_found", "provider not found");
    })();
    await this.keys.delete(providerKeychainName(id));
    this.cachedKeys.delete(providerKeychainName(id));
    const defaultId = this.defaultProviderId();
    if (defaultId === id) {
      this.setSetting("default_provider_id", remaining[0]?.id ?? "");
    }
    this.dropUnknownBotModels(this.allConfiguredModels());
    this.mirrorDefaultProvider();
  }

  listMcpServers() {
    return this.db
      .query<McpRow, []>(`SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE`)
      .all()
      .map((row) => this.toMcp(row, this.cachedKeys.has(mcpAuthKeychainName(row.id))));
  }

  async listMcpServersHydrated() {
    const rows = this.db
      .query<McpRow, []>(`SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE`)
      .all();
    const out = [];
    for (const row of rows) {
      await this.readKey(mcpAuthKeychainName(row.id));
      out.push(this.toMcp(row, true));
    }
    return out;
  }

  async mcpAuth(id: string): Promise<string | null> {
    return this.readKey(mcpAuthKeychainName(id));
  }

  async createMcpServer(input: {
    name: string;
    transport?: McpTransport;
    command?: string;
    args?: string[];
    url?: string | null;
    headers?: McpHeader[];
    auth?: string;
    enabled?: boolean;
    instructions?: string | null;
    usage_note?: string | null;
    tool_catalog?: Array<{ name: string; description: string }>;
  }) {
    const name = requireNonEmpty("name", input.name);
    const spec = normalizeMcpSpec({
      transport: input.transport,
      command: input.command,
      args: input.args,
      url: input.url,
      headers: input.headers,
    });
    const now = isoNow();
    const catalog = JSON.stringify(input.tool_catalog ?? []);
    const instructions = input.instructions?.trim() ? input.instructions : null;
    const usageNote = parseMcpUsageNote(input.usage_note);
    const id = ulid();
    const row: McpRow = {
      id,
      name,
      transport: spec.transport,
      command: spec.command,
      args: JSON.stringify(spec.args),
      url: spec.url,
      headers: JSON.stringify(spec.headers),
      enabled: input.enabled === false ? 0 : 1,
      instructions,
      usage_note: usageNote,
      tool_catalog: catalog,
      created_at: now,
      updated_at: now,
    };
    this.db.run(
      `INSERT INTO mcp_servers (id, name, transport, command, args, url, headers, enabled, instructions, usage_note, tool_catalog, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.name,
        row.transport ?? "stdio",
        row.command,
        row.args,
        row.url ?? null,
        row.headers ?? "[]",
        row.enabled,
        row.instructions ?? null,
        row.usage_note ?? null,
        row.tool_catalog ?? "[]",
        row.created_at,
        row.updated_at,
      ],
    );
    if (typeof input.auth === "string" && input.auth.length > 0) {
      await this.writeMcpAuth(id, input.auth);
    }
    await this.readKey(mcpAuthKeychainName(id));
    return this.toMcp(row, true);
  }

  async patchMcpServer(
    id: string,
    patch: {
      name?: string;
      transport?: McpTransport;
      command?: string;
      args?: string[];
      url?: string | null;
      headers?: McpHeader[];
      auth?: string;
      enabled?: boolean;
      instructions?: string | null;
      usage_note?: string | null;
      tool_catalog?: Array<{ name: string; description: string }>;
    },
  ) {
    const current = this.db.query<McpRow, [string]>(`SELECT * FROM mcp_servers WHERE id = ?`).get(id);
    if (!current) throw new HttpError(404, "not_found", "mcp server not found");
    // The note is written by you or a Bot, so it survives connection changes; only an explicit
    // patch replaces or clears it.
    const usageNote =
      patch.usage_note !== undefined ? parseMcpUsageNote(patch.usage_note) : (current.usage_note ?? null);
    const name = patch.name !== undefined ? requireNonEmpty("name", patch.name) : current.name;
    const spec = normalizeMcpSpec({
      transport: patch.transport ?? parseTransport(current.transport),
      command: patch.command !== undefined ? patch.command : current.command,
      args: patch.args !== undefined ? patch.args : parseMcpArgs(current.args),
      url: patch.url !== undefined ? patch.url : current.url,
      headers: patch.headers !== undefined ? patch.headers : parseMcpHeaders(current.headers),
    });
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
    const connectionChanged =
      spec.transport !== parseTransport(current.transport) ||
      spec.command !== current.command ||
      JSON.stringify(spec.args) !== current.args ||
      (spec.url ?? null) !== (current.url ?? null) ||
      JSON.stringify(spec.headers) !== (current.headers ?? "[]");
    const instructions =
      patch.instructions !== undefined
        ? patch.instructions?.trim()
          ? patch.instructions
          : null
        : connectionChanged
          ? null
          : current.instructions;
    const toolCatalog =
      patch.tool_catalog !== undefined
        ? JSON.stringify(patch.tool_catalog)
        : connectionChanged
          ? "[]"
          : (current.tool_catalog ?? "[]");
    const now = isoNow();
    this.db.run(
      `UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args = ?, url = ?, headers = ?, enabled = ?, instructions = ?, usage_note = ?, tool_catalog = ?, updated_at = ? WHERE id = ?`,
      [
        name,
        spec.transport,
        spec.command,
        JSON.stringify(spec.args),
        spec.url ?? null,
        JSON.stringify(spec.headers),
        enabled,
        instructions ?? null,
        usageNote,
        toolCatalog ?? "[]",
        now,
        id,
      ],
    );
    if (patch.auth !== undefined) {
      await this.writeMcpAuth(id, patch.auth);
    }
    await this.readKey(mcpAuthKeychainName(id));
    const next = this.db.query<McpRow, [string]>(`SELECT * FROM mcp_servers WHERE id = ?`).get(id)!;
    return this.toMcp(next, true);
  }

  async deleteMcpServer(id: string): Promise<void> {
    const changes = this.db.run(`DELETE FROM mcp_servers WHERE id = ?`, [id]).changes;
    if (changes === 0) throw new HttpError(404, "not_found", "mcp server not found");
    await this.keys.delete(mcpAuthKeychainName(id));
    this.cachedKeys.delete(mcpAuthKeychainName(id));
  }

  listRoutines(): Routine[] {
    return this.db
      .query<RoutineRow, []>(`SELECT * FROM routines ORDER BY created_at ASC`)
      .all()
      .map(toRoutine);
  }

  createRoutine(input: {
    bot_id: string;
    title: string;
    instruction: string;
    schedule: Routine["schedule"];
    enabled?: boolean;
  }): Routine {
    this.aliveBot(input.bot_id);
    const title = requireNonEmpty("title", input.title);
    const instruction = requireString("instruction", input.instruction);
    const schedule = parseSchedule(input.schedule);
    const now = isoNow();
    const id = ulid();
    this.db.run(
      `INSERT INTO routines
        (id, bot_id, title, instruction, schedule_kind, schedule_time, weekdays, enabled, last_fired_for_due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.bot_id,
        title,
        instruction,
        schedule.kind,
        schedule.time,
        schedule.kind === "weekly" ? JSON.stringify(schedule.weekdays) : null,
        input.enabled === false ? 0 : 1,
        now,
        now,
      ],
    );
    return this.listRoutines().find((r) => r.id === id)!;
  }

  patchRoutine(
    id: string,
    patch: Partial<{ title: string; instruction: string; schedule: Routine["schedule"]; enabled: boolean }>,
  ): Routine {
    const current = this.db.query<RoutineRow, [string]>(`SELECT * FROM routines WHERE id = ?`).get(id);
    if (!current) throw new HttpError(404, "not_found", "routine not found");
    const title = patch.title !== undefined ? requireNonEmpty("title", patch.title) : current.title;
    const instruction =
      patch.instruction !== undefined ? requireString("instruction", patch.instruction) : current.instruction;
    const schedule = patch.schedule ? parseSchedule(patch.schedule) : toRoutine(current).schedule;
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
    const now = isoNow();
    this.db.run(
      `UPDATE routines SET title = ?, instruction = ?, schedule_kind = ?, schedule_time = ?, weekdays = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
      [
        title,
        instruction,
        schedule.kind,
        schedule.time,
        schedule.kind === "weekly" ? JSON.stringify(schedule.weekdays) : null,
        enabled,
        now,
        id,
      ],
    );
    return this.listRoutines().find((r) => r.id === id)!;
  }

  deleteRoutine(id: string): void {
    const changes = this.db.run(`DELETE FROM routines WHERE id = ?`, [id]).changes;
    if (changes === 0) throw new HttpError(404, "not_found", "routine not found");
  }

  getRoutine(id: string): Routine {
    const row = this.db.query<RoutineRow, [string]>(`SELECT * FROM routines WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "routine not found");
    return toRoutine(row);
  }

  listSkills(botId?: string): Skill[] {
    if (botId) {
      this.aliveBot(botId);
      return this.db
        .query<SkillRow, [string]>(`SELECT * FROM skills WHERE bot_id = ? ORDER BY name COLLATE NOCASE ASC, id ASC`)
        .all(botId)
        .map(toSkill);
    }
    return this.db
      .query<SkillRow, []>(`SELECT * FROM skills ORDER BY bot_id ASC, name COLLATE NOCASE ASC, id ASC`)
      .all()
      .map(toSkill);
  }

  listEnabledSkills(botId: string): Skill[] {
    return this.listSkills(botId).filter((skill) => skill.enabled);
  }

  getSkill(id: string): Skill {
    const row = this.db.query<SkillRow, [string]>(`SELECT * FROM skills WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "skill not found");
    return toSkill(row);
  }

  findSkillByName(botId: string, name: string): Skill | null {
    const normalized = requireNonEmpty("name", name);
    const row = this.db
      .query<SkillRow, [string, string]>(
        `SELECT * FROM skills WHERE bot_id = ? AND lower(name) = lower(?) LIMIT 1`,
      )
      .get(botId, normalized);
    return row ? toSkill(row) : null;
  }

  createSkill(input: {
    bot_id: string;
    name: string;
    description: string;
    body: string;
    uses?: string[];
    enabled?: boolean;
  }): Skill {
    this.aliveBot(input.bot_id);
    const name = parseSkillName(input.name);
    const description = parseSkillDescription(input.description);
    const body = parseSkillBody(input.body);
    const uses = JSON.stringify(parseSkillUses(input.uses));
    this.assertSkillNameFree(input.bot_id, name);
    this.assertSkillCapacity(input.bot_id);
    const now = isoNow();
    const id = ulid();
    this.db.run(
      `INSERT INTO skills (id, bot_id, name, description, body, uses, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.bot_id, name, description, body, uses, input.enabled === false ? 0 : 1, now, now],
    );
    return this.getSkill(id);
  }

  patchSkill(
    id: string,
    patch: Partial<{ name: string; description: string; body: string; uses: string[]; enabled: boolean }>,
  ): Skill {
    const current = this.db.query<SkillRow, [string]>(`SELECT * FROM skills WHERE id = ?`).get(id);
    if (!current) throw new HttpError(404, "not_found", "skill not found");
    const name = patch.name !== undefined ? parseSkillName(patch.name) : current.name;
    const description =
      patch.description !== undefined ? parseSkillDescription(patch.description) : current.description;
    const body = patch.body !== undefined ? parseSkillBody(patch.body) : current.body;
    const uses = patch.uses !== undefined ? JSON.stringify(parseSkillUses(patch.uses)) : (current.uses ?? "[]");
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
    if (name.toLowerCase() !== current.name.toLowerCase()) {
      this.assertSkillNameFree(current.bot_id, name, id);
    }
    const now = isoNow();
    this.db.run(
      `UPDATE skills SET name = ?, description = ?, body = ?, uses = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      [name, description, body, uses, enabled, now, id],
    );
    return this.getSkill(id);
  }

  deleteSkill(id: string): void {
    const changes = this.db.run(`DELETE FROM skills WHERE id = ?`, [id]).changes;
    if (changes === 0) throw new HttpError(404, "not_found", "skill not found");
  }

  private assertSkillNameFree(botId: string, name: string, exceptId?: string): void {
    const row = this.db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM skills WHERE bot_id = ? AND lower(name) = lower(?) LIMIT 1`,
      )
      .get(botId, name);
    if (row && row.id !== exceptId) throw new HttpError(409, "conflict", "that skill name is already used");
  }

  private assertSkillCapacity(botId: string): void {
    const row = this.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM skills WHERE bot_id = ?`)
      .get(botId);
    if ((row?.n ?? 0) >= SKILL_MAX_PER_BOT) {
      throw new HttpError(422, "failed", `a bot can have at most ${SKILL_MAX_PER_BOT} skills`);
    }
  }

  /**
   * If this routine is due and the cursor is behind that due, stamp
   * `last_fired_for_due_at` and return the claimed row. Concurrent ticks
   * lose the compare-and-set and skip.
   */
  claimRoutineDue(id: string, now: Date = new Date()): Routine | null {
    const row = this.db.query<RoutineRow, [string]>(`SELECT * FROM routines WHERE id = ?`).get(id);
    if (!row || row.enabled !== 1) return null;
    const bot = this.db.query<BotRow, [string]>(`SELECT * FROM bots WHERE id = ?`).get(row.bot_id);
    if (!bot || bot.deleted_at || bot.archived_at) return null;
    const routine = toRoutine(row);
    const createdAt = new Date(row.created_at);
    if (Number.isNaN(createdAt.getTime())) return null;
    const due = latestDueAt(routine.schedule, now, createdAt);
    if (!due) return null;
    const dueAt = dueIso(due);
    if (row.last_fired_for_due_at && row.last_fired_for_due_at >= dueAt) return null;
    const stamped = isoNow();
    const changes = this.db.run(
      `UPDATE routines SET last_fired_for_due_at = ?, updated_at = ?
       WHERE id = ? AND enabled = 1
         AND (last_fired_for_due_at IS NULL OR last_fired_for_due_at < ?)`,
      [dueAt, stamped, id, dueAt],
    ).changes;
    if (changes === 0) return null;
    return this.getRoutine(id);
  }

  listSpend(filter: { session_id?: string; bot_id?: string; turn_id?: string }): Spend[] {
    let sql = `SELECT * FROM spend`;
    const where: string[] = [];
    const args: string[] = [];
    if (filter.session_id) {
      where.push("session_id = ?");
      args.push(filter.session_id);
    }
    if (filter.bot_id) {
      where.push("bot_id = ?");
      args.push(filter.bot_id);
    }
    if (filter.turn_id) {
      where.push("turn_id = ?");
      args.push(filter.turn_id);
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY created_at ASC`;
    return this.db.query<Spend, string[]>(sql).all(...args);
  }

  listJudgements(sessionId: string): Judgement[] {
    this.sessionRow(sessionId);
    return this.db
      .query<Judgement, [string]>(
        `SELECT * FROM judgements WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId);
  }

  matchesAllowRule(kind_key: string, target: string): boolean {
    const rules = this.listAllowRules();
    for (const rule of rules) {
      if (rule.kind_key !== kind_key) continue;
      if (rule.scope === "*") return true;
      if (kind_key === "unconstrained-shell") continue;
      if (target === rule.scope || target.startsWith(rule.scope.endsWith("/") ? rule.scope : `${rule.scope}/`)) {
        return true;
      }
    }
    return false;
  }

  insertApproval(input: {
    turnId: string;
    messageId: string | null;
    kind_key: string;
    summary: string;
    target: string;
    requires_api_key?: boolean;
  }): Approval {
    const now = isoNow();
    const row: Approval = {
      id: ulid(),
      turn_id: input.turnId,
      message_id: input.messageId,
      status: "pending",
      kind_key: input.kind_key,
      summary: input.summary,
      target: input.target,
      created_at: now,
      resolved_at: null,
      requires_api_key: Boolean(input.requires_api_key),
    };
    this.db.run(
      `INSERT INTO approvals (id, turn_id, message_id, status, kind_key, summary, target, created_at, resolved_at, requires_api_key)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, ?)`,
      [
        row.id,
        row.turn_id,
        row.message_id,
        row.kind_key,
        row.summary,
        row.target,
        row.created_at,
        row.requires_api_key ? 1 : 0,
      ],
    );
    return row;
  }

  getApproval(id: string): Approval {
    const row = this.db.query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "approval not found");
    return toApproval(row);
  }

  listApprovals(status?: string) {
    if (status && status !== "pending") {
      throw new HttpError(422, "invalid_args", "status must be pending when set");
    }
    const sql = status
      ? `SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`
      : `SELECT * FROM approvals ORDER BY created_at ASC`;
    return this.db.query<ApprovalRow, []>(sql).all().map(toApproval);
  }

  resolveApproval(
    id: string,
    action: "allow_once" | "deny" | "always_allow",
    scope?: string,
  ) {
    const row = this.db.query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "approval not found");
    if (row.status !== "pending") {
      throw new HttpError(409, "conflict", "approval is no longer pending");
    }
    if (action === "always_allow") {
      if (!row.kind_key || !ALLOWED_KIND_KEYS.has(row.kind_key)) {
        throw new HttpError(422, "invalid_args", "this kind cannot be Always allow");
      }
      const nextScope =
        row.kind_key === "unconstrained-shell" ? "*" : (scope ?? row.target ?? "*");
      if (row.kind_key === "unconstrained-shell" && scope && scope !== "*") {
        throw new HttpError(422, "invalid_args", "unconstrained-shell scope must be *");
      }
      this.createAllowRule(row.kind_key, nextScope);
    }
    const now = isoNow();
    const status = action === "deny" ? "denied" : "allowed_once";
    this.db.run(`UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?`, [status, now, id]);
    const next = this.db.query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE id = ?`).get(id)!;
    return toApproval(next);
  }

  stopTurn(turnId?: string, opts: { allowGroup?: boolean } = {}): Turn | null {
    const row = turnId
      ? this.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(turnId)
      : this.db
          .query<TurnRow, []>(
            opts.allowGroup
              ? `SELECT * FROM turns
                 WHERE status IN ('running', 'waiting_approval', 'waiting_ask')
                 ORDER BY last_activity_at DESC LIMIT 1`
              : `SELECT t.* FROM turns t
                 JOIN sessions s ON s.id = t.session_id
                 WHERE t.status IN ('running', 'waiting_approval', 'waiting_ask')
                   AND s.kind = 'direct'
                 ORDER BY t.last_activity_at DESC LIMIT 1`,
          )
          .get();
    if (!row) {
      if (turnId) throw new HttpError(404, "not_found", "turn not found");
      return null;
    }
    if (!isLive(row.status)) {
      throw new HttpError(422, "invalid_args", "turn is not in progress");
    }
    if (!opts.allowGroup) {
      const session = this.db
        .query<{ kind: string }, [string]>(`SELECT kind FROM sessions WHERE id = ?`)
        .get(row.session_id);
      if (session?.kind === "group") {
        throw new HttpError(422, "invalid_args", "group turns cannot be stopped");
      }
    }
    const now = isoNow();
    this.db.transaction(() => {
      this.db.run(`UPDATE turns SET status = 'stopped', updated_at = ? WHERE id = ?`, [now, row.id]);
      this.db.run(
        `UPDATE approvals SET status = 'voided', resolved_at = ? WHERE turn_id = ? AND status = 'pending'`,
        [now, row.id],
      );
    })();
    return { ...row, status: "stopped", updated_at: now, partial_text: null };
  }

  interruptRunningTurns(): void {
    const now = isoNow();
    const live = this.db
      .query<TurnRow, []>(
        `SELECT * FROM turns WHERE status IN ('running', 'waiting_approval', 'waiting_ask')`,
      )
      .all();
    this.db.transaction(() => {
      for (const turn of live) {
        this.db.run(`UPDATE turns SET status = 'interrupted', updated_at = ? WHERE id = ?`, [
          now,
          turn.id,
        ]);
        this.db.run(
          `UPDATE approvals SET status = 'voided', resolved_at = ? WHERE turn_id = ? AND status = 'pending'`,
          [now, turn.id],
        );
        this.db.run(
          `INSERT INTO messages (id, session_id, turn_id, parent_id, kind, author, body, source_turn_id, created_at)
           VALUES (?, ?, ?, NULL, 'system', ?, ?, NULL, ?)`,
          [ulid(), turn.session_id, turn.id, turn.bot_id, INTERRUPT_NOTE_BODY, now],
        );
        this.markInterruptPending(turn.bot_id);
      }
    })();
  }

  claimInterruptContinue(messageId: string): Turn {
    const note = this.getMessage(messageId);
    if (note.kind !== "system" || note.body !== INTERRUPT_NOTE_BODY || !note.turn_id) {
      throw new HttpError(422, "invalid_args", "message is not an interrupted turn");
    }
    if (note.source_turn_id) {
      throw new HttpError(422, "invalid_args", "interrupted turn already continued");
    }
    const cut = this.getTurn(note.turn_id);
    if (cut.status !== "interrupted" || cut.bot_id !== note.author) {
      throw new HttpError(422, "invalid_args", "turn is not interrupted");
    }
    const session = this.sessionRow(note.session_id);
    if (session.archived_at) {
      throw new HttpError(422, "invalid_args", "session is archived");
    }
    const bot = this.aliveBot(cut.bot_id);
    if (bot.archived_at) {
      throw new HttpError(422, "invalid_args", "bot is archived");
    }
    if (!this.isPresent(note.session_id, cut.bot_id)) {
      throw new HttpError(422, "invalid_args", "bot is not in this session");
    }
    if (this.listLiveTurns({ sessionId: note.session_id, botId: cut.bot_id }).length > 0) {
      throw new HttpError(422, "invalid_args", "bot already has a live turn");
    }
    const now = isoNow();
    const id = ulid();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO turns
          (id, session_id, bot_id, status, trigger_message_id, last_activity_at, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
        [id, note.session_id, cut.bot_id, note.id, now, now, now],
      );
      const updated = this.db.run(
        `UPDATE messages SET source_turn_id = ? WHERE id = ? AND source_turn_id IS NULL`,
        [id, note.id],
      ).changes;
      if (updated !== 1) {
        throw new HttpError(422, "invalid_args", "interrupted turn already continued");
      }
    })();
    this.touchSession(note.session_id, now);
    return this.getTurn(id);
  }

  search(q: string): SearchHit[] {
    const needle = requireNonEmpty("q", q).toLowerCase();
    const botNames = new Map(
      this.db
        .query<{ id: string; name: string }, []>(`SELECT id, name FROM bots`)
        .all()
        .map((row) => [row.id, row.name] as const),
    );
    const sessions = this.listSessions();
    const titles = new Map<string, string>();
    const youBotByPeer = new Map<string, string>();
    for (const session of sessions) {
      titles.set(session.id, sessionSearchTitle(session, session.participants, botNames));
      if (session.kind !== "direct") continue;
      const active = session.participants.filter((p) => p.left_at === null).map((p) => p.member);
      if (!active.includes(USER_MEMBER)) continue;
      const peer = active.find((member) => member !== USER_MEMBER);
      if (peer) youBotByPeer.set(peer, session.id);
    }
    const titleFor = (sessionId: string): string => {
      const cached = titles.get(sessionId);
      if (cached !== undefined) return cached;
      try {
        const session = this.sessionRow(sessionId);
        const title = sessionSearchTitle(session, this.listParticipants(sessionId), botNames);
        titles.set(sessionId, title);
        return title;
      } catch {
        return "";
      }
    };
    const bots = this.listBots()
      .filter((b) => `${b.name} ${b.duties} ${b.boundaries}`.toLowerCase().includes(needle))
      .map((b) => {
        const sessionId = youBotByPeer.get(b.id);
        return {
          kind: "bot" as const,
          id: b.id,
          snippet: b.name,
          session_id: sessionId,
          session_title: b.name,
        };
      });
    const sessionHits = sessions
      .filter((s) => (s.name ?? "").toLowerCase().includes(needle))
      .map((s) => ({
        kind: "session" as const,
        id: s.id,
        snippet: s.name ?? (titleFor(s.id) || s.kind),
        session_id: s.id,
        session_title: titleFor(s.id) || s.name || s.kind,
      }));
    const messages = this.db
      .query<{ id: string; session_id: string; parent_id: string | null; body: string }, []>(
        `SELECT id, session_id, parent_id, body FROM messages WHERE kind != 'profile_change'`,
      )
      .all()
      .filter((m) => m.body.toLowerCase().includes(needle))
      .map((m) => ({
        kind: "message" as const,
        id: m.id,
        snippet: m.body.slice(0, 160),
        session_id: m.session_id,
        session_title: titleFor(m.session_id),
        parent_id: m.parent_id,
      }));
    const routines = this.listRoutines()
      .filter((r) => `${r.title} ${r.instruction}`.toLowerCase().includes(needle))
      .map((r) => ({ kind: "routine" as const, id: r.id, snippet: r.title }));
    const files = this.searchWorkspaceFiles(needle);
    return [...bots, ...sessionHits, ...messages, ...routines, ...files];
  }

  private pendingInterruptSet(): Set<string> {
    const raw = this.db
      .query<SettingRow, [string]>(`SELECT key, value FROM settings WHERE key = ?`)
      .get("_pending_interrupt_bots");
    if (!raw?.value) return new Set();
    try {
      const parsed = JSON.parse(raw.value) as unknown;
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((id): id is string => typeof id === "string"));
    } catch {
      return new Set();
    }
  }

  private writePendingInterrupts(set: Set<string>): void {
    this.setSetting("_pending_interrupt_bots", JSON.stringify([...set]));
  }

  private settingsMap(): Map<string, string> {
    const rows = this.db.query<SettingRow, []>(`SELECT key, value FROM settings`).all();
    const map = new Map<string, string>();
    for (const key of KNOWN_SETTING_KEYS) map.set(key, "");
    for (const row of rows) map.set(row.key, row.value);
    if (!map.get("locale")) map.set("locale", "zh");
    if (!map.get("theme")) map.set("theme", "system");
    if (!map.has("launch_at_login") || map.get("launch_at_login") === "") {
      map.set("launch_at_login", "1");
    }
    return map;
  }

  private setSetting(key: string, value: string): void {
    this.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
      key,
      value,
    ]);
  }

  private providerRows(): ProviderRow[] {
    return this.db
      .query<ProviderRow, []>(`SELECT * FROM providers ORDER BY created_at ASC, id`)
      .all();
  }

  private requireProvider(id: string): ProviderRow {
    const row = this.db.query<ProviderRow, [string]>(`SELECT * FROM providers WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "provider not found");
    return row;
  }

  defaultProviderId(): string | null {
    return emptyToNull(this.settingsMap().get("default_provider_id"));
  }

  private defaultProviderRow(providers: Provider[], preferredId: string | null): Provider | null {
    if (preferredId) {
      const named = providers.find((provider) => provider.id === preferredId);
      if (named) return named;
    }
    return providers[0] ?? null;
  }

  private allConfiguredModels(): string[] {
    return unionProviderModels(
      this.providerRows().map((row) => ({
        id: row.id,
        models: parseStoredModels(row.models),
        defaultModel: emptyToNull(row.default_model),
      })),
    );
  }

  private resolveIncomingBotTarget(
    modelValue: unknown,
    providerValue: unknown,
  ): { model: string | null; providerId: string | null } {
    const model = modelValue === undefined ? null : normalizeBotModel(modelValue, this.allConfiguredModels());
    const providerId = normalizeOptionalId(providerValue, "provider_id");
    if (providerId) {
      const row = this.requireProvider(providerId);
      const models = parseStoredModels(row.models);
      if (model && !models.includes(model)) {
        throw new HttpError(422, "invalid_args", "model must be one of the provider models");
      }
      return { model, providerId };
    }
    if (!model) return { model: null, providerId: null };
    const match = resolveProviderForModel(
      this.providerRows().map((row) => ({
        id: row.id,
        models: parseStoredModels(row.models),
        defaultModel: emptyToNull(row.default_model),
      })),
      { model, providerId: null, defaultProviderId: this.defaultProviderId() },
    );
    return { model, providerId: match?.id ?? null };
  }

  /**
   * An explicit pin must be a level the pinned model supports. With no pinned model any level is
   * accepted; the turn applies it whenever the chosen model supports it.
   */
  private resolveIncomingThinkingLevel(
    value: unknown,
    model: string | null,
    providerId: string | null,
  ): ThinkingLevel | null {
    const level = normalizeBotThinkingLevel(value);
    if (!level) return null;
    if (!this.modelSupportsThinking(model, providerId, level)) {
      throw new HttpError(422, "invalid_args", "thinking_level must be one the pinned model supports");
    }
    return level;
  }

  /** A pin carried across a model change is dropped when the new model cannot honour it. */
  private carriedThinkingLevel(
    raw: string | null,
    model: string | null,
    providerId: string | null,
  ): ThinkingLevel | null {
    const level = parseStoredThinkingLevel(raw);
    if (!level) return null;
    return this.modelSupportsThinking(model, providerId, level) ? level : null;
  }

  private modelSupportsThinking(
    model: string | null,
    providerId: string | null,
    level: ThinkingLevel,
  ): boolean {
    if (!model) return true;
    const rows = providerId
      ? this.providerRows().filter((row) => row.id === providerId)
      : this.providerRows();
    const entries = rows.flatMap((row) => parseStoredCatalog(row.models)).filter((row) => row.name === model);
    if (entries.length === 0) return true;
    return entries.some((entry) => entry.thinking_levels.length === 0 || entry.thinking_levels.includes(level));
  }

  private dropUnknownBotModels(models: string[]): void {
    const rows = this.db
      .query<{ id: string; model: string }, []>(
        `SELECT id, model FROM bots WHERE deleted_at IS NULL AND model IS NOT NULL`,
      )
      .all();
    const now = isoNow();
    for (const row of rows) {
      if (models.includes(row.model)) continue;
      this.db.run(`UPDATE bots SET model = NULL, provider_id = NULL, updated_at = ? WHERE id = ?`, [
        now,
        row.id,
      ]);
    }
  }

  private dropUnknownBotModelsForProvider(providerId: string, models: string[]): void {
    const rows = this.db
      .query<{ id: string; model: string }, [string]>(
        `SELECT id, model FROM bots WHERE deleted_at IS NULL AND provider_id = ? AND model IS NOT NULL`,
      )
      .all(providerId);
    const now = isoNow();
    for (const row of rows) {
      if (models.includes(row.model)) continue;
      this.db.run(`UPDATE bots SET model = NULL, updated_at = ? WHERE id = ?`, [now, row.id]);
    }
  }

  private async toProvider(row: ProviderRow): Promise<Provider> {
    const catalog = parseStoredCatalog(row.models);
    const models = catalogNames(catalog);
    const storedDefault = emptyToNull(row.default_model);
    return {
      id: row.id,
      name: row.name,
      base_url: emptyToNull(row.base_url),
      key_set: (await this.readKey(providerKeychainName(row.id))) !== null,
      models,
      model_catalog: catalog,
      available_models: parseStoredAvailableModels(row.available_models),
      default_model: storedDefault && models.includes(storedDefault) ? storedDefault : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  catalogEntries(): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    for (const row of this.providerRows()) {
      for (const item of parseStoredCatalog(row.models)) {
        out.push({ ...item, providerId: row.id });
      }
    }
    return out;
  }

  decideTurnRoute(input: {
    text: string;
    botModel: string | null;
    botProviderId: string | null;
    botThinkingLevel?: ThinkingLevel | null;
    providerIds?: readonly string[];
  }): RouteDecision | null {
    const catalog = this.catalogEntries().filter((row) =>
      input.providerIds ? input.providerIds.includes(row.providerId) : true,
    );
    const defaultProviderId =
      this.defaultProviderId() ?? this.providerRows()[0]?.id ?? null;
    return decideCompletion({
      text: input.text,
      catalog,
      botModel: input.botModel,
      botProviderId: input.botProviderId,
      defaultProviderId,
      botThinkingLevel: input.botThinkingLevel ?? null,
      learned: this.routeLearnedState(),
    });
  }

  recordTurnRoute(input: {
    turnId: string;
    sessionId: string;
    triggerMessageId: string;
    decision: RouteDecision;
  }): void {
    const now = isoNow();
    this.db.run(
      `INSERT INTO turn_route_decisions (
         turn_id, session_id, trigger_message_id, model, thinking_level, signature, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(turn_id) DO NOTHING`,
      [
        input.turnId,
        input.sessionId,
        input.triggerMessageId,
        input.decision.model,
        input.decision.thinkingLevel,
        input.decision.signature,
        now,
      ],
    );
  }

  getTurnRoute(turnId: string): {
    turn_id: string;
    session_id: string;
    trigger_message_id: string;
    model: string;
    thinking_level: string;
    signature: string;
    created_at: string;
  } | null {
    return (
      this.db
        .query<
          {
            turn_id: string;
            session_id: string;
            trigger_message_id: string;
            model: string;
            thinking_level: string;
            signature: string;
            created_at: string;
          },
          [string]
        >(`SELECT * FROM turn_route_decisions WHERE turn_id = ?`)
        .get(turnId) ?? null
    );
  }

  listRouteFeedback(): Array<{
    id: string;
    turn_id: string;
    message_id: string;
    model: string;
    thinking_level: string;
    signature: string;
    body: string;
    created_at: string;
  }> {
    return this.db
      .query<
        {
          id: string;
          turn_id: string;
          message_id: string;
          model: string;
          thinking_level: string;
          signature: string;
          body: string;
          created_at: string;
        },
        []
      >(`SELECT * FROM route_feedback ORDER BY created_at ASC, id ASC`)
      .all();
  }

  routeLearnedState(): RouteLearnedState {
    const raw = this.settingsMap().get("route_learned");
    if (!raw) return emptyLearnedState();
    try {
      const parsed = JSON.parse(raw) as RouteLearnedState;
      if (!parsed || !Array.isArray(parsed.penalties)) return emptyLearnedState();
      return {
        penalties: parsed.penalties
          .filter(
            (row) =>
              row &&
              typeof row.signature === "string" &&
              typeof row.model === "string" &&
              typeof row.thinkingLevel === "string" &&
              typeof row.penalty === "number",
          )
          .map((row) => ({
            signature: row.signature,
            model: row.model,
            thinkingLevel: row.thinkingLevel,
            penalty: row.penalty,
          })),
      };
    } catch {
      return emptyLearnedState();
    }
  }

  collectRouteFeedback(message: { id: string; session_id: string; author: string; body: string }): boolean {
    if (message.author !== USER_MEMBER) return false;
    if (!isCritiqueMessage(message.body)) return false;
    const prior = this.latestCompletedRoute(message.session_id, message.id);
    if (!prior) return false;
    const already = this.db
      .query<{ id: string }, [string]>(`SELECT id FROM route_feedback WHERE message_id = ?`)
      .get(message.id);
    if (already) return false;
    const now = isoNow();
    this.db.run(
      `INSERT INTO route_feedback (
         id, turn_id, message_id, model, thinking_level, signature, body, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ulid(), prior.turn_id, message.id, prior.model, prior.thinking_level, prior.signature, message.body, now],
    );
    const next = applyFeedbackToLearned(this.routeLearnedState(), {
      signature: prior.signature,
      model: prior.model,
      thinkingLevel: prior.thinking_level,
    });
    this.setSetting("route_learned", JSON.stringify(next));
    return true;
  }

  private latestCompletedRoute(
    sessionId: string,
    beforeMessageId: string,
  ): {
    turn_id: string;
    model: string;
    thinking_level: string;
    signature: string;
  } | null {
    return (
      this.db
        .query<
          {
            turn_id: string;
            model: string;
            thinking_level: string;
            signature: string;
          },
          [string, string]
        >(
          `SELECT d.turn_id, d.model, d.thinking_level, d.signature
           FROM turn_route_decisions d
           JOIN turns t ON t.id = d.turn_id
           JOIN messages m ON m.id = d.trigger_message_id
           JOIN messages cur ON cur.id = ?
           WHERE d.session_id = ?
             AND m.rowid < cur.rowid
           ORDER BY m.rowid DESC
           LIMIT 1`,
        )
        .get(beforeMessageId, sessionId) ?? null
    );
  }

  private async readKey(name: string): Promise<string | null> {
    if (this.cachedKeys.has(name)) return this.cachedKeys.get(name) ?? null;
    const value = await this.keys.get(name);
    this.cachedKeys.set(name, value);
    return value;
  }

  private async writeProviderKey(id: string, value: string): Promise<void> {
    const name = providerKeychainName(id);
    if (value.length === 0) {
      await this.keys.delete(name);
      this.cachedKeys.set(name, null);
      return;
    }
    await this.keys.set(value, name);
    this.cachedKeys.set(name, value);
  }

  private async writeMcpAuth(id: string, value: string): Promise<void> {
    const name = mcpAuthKeychainName(id);
    if (value.length === 0) {
      await this.keys.delete(name);
      this.cachedKeys.set(name, null);
      return;
    }
    await this.keys.set(value, name);
    this.cachedKeys.set(name, value);
  }

  private toMcp(row: McpRow, authKnown = false) {
    const transport = parseTransport(row.transport);
    return {
      id: row.id,
      name: row.name,
      transport,
      command: row.command,
      args: parseMcpArgs(row.args),
      url: emptyToNull(row.url),
      headers: parseMcpHeaders(row.headers),
      auth_set: authKnown ? this.cachedKeys.get(mcpAuthKeychainName(row.id)) != null : false,
      enabled: row.enabled === 1,
      instructions: row.instructions?.trim() ? row.instructions : null,
      usage_note: row.usage_note?.trim() ? row.usage_note : null,
      tool_catalog: parseToolCatalog(row.tool_catalog),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mirrorDefaultProvider(): void {
    const id = this.defaultProviderId();
    const row = id
      ? this.db.query<ProviderRow, [string]>(`SELECT * FROM providers WHERE id = ?`).get(id)
      : this.providerRows()[0];
    if (!row) {
      this.setSetting("endpoint_base_url", "");
      this.setSetting("endpoint_models", "[]");
      this.setSetting("endpoint_default_model", "");
      this.setSetting("endpoint_key_ref", "");
      return;
    }
    if (!this.defaultProviderId()) this.setSetting("default_provider_id", row.id);
    this.setSetting("endpoint_base_url", row.base_url);
    this.setSetting("endpoint_models", row.models);
    this.setSetting("endpoint_default_model", row.default_model ?? "");
    this.setSetting("endpoint_key_ref", KEYCHAIN_REF);
  }

  private async ensureLegacyProvider(): Promise<void> {
    this.ensureLegacyProviderRow();
    const id = this.defaultProviderId() ?? this.providerRows()[0]?.id;
    if (!id || this.copiedLegacyKey) return;
    this.copiedLegacyKey = true;
    const existing = await this.readKey(providerKeychainName(id));
    if (existing) return;
    const legacy = await this.readKey(KEYCHAIN_NAME);
    if (legacy) await this.writeProviderKey(id, legacy);
  }

  private ensureLegacyProviderRow(): void {
    if (this.providerRows().length > 0) {
      if (!this.defaultProviderId()) this.setSetting("default_provider_id", this.providerRows()[0]!.id);
      this.mirrorDefaultProvider();
      return;
    }
    const map = this.settingsMap();
    const baseUrl = emptyToNull(map.get("endpoint_base_url"));
    const catalog = parseStoredCatalog(map.get("endpoint_models"));
    const models = catalogNames(catalog);
    const storedDefault = emptyToNull(map.get("endpoint_default_model"));
    const defaultModel = storedDefault && models.includes(storedDefault) ? storedDefault : (models[0] ?? null);
    const hadKeyRef = Boolean(emptyToNull(map.get("endpoint_key_ref")));
    if (!baseUrl && models.length === 0 && !hadKeyRef) return;
    const now = isoNow();
    const id = ulid();
    this.db.run(
      `INSERT INTO providers (id, name, base_url, models, available_models, default_model, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`,
      [id, "Default", baseUrl ?? "", serializeCatalog(catalog), defaultModel, now, now],
    );
    this.setSetting("default_provider_id", id);
    this.mirrorDefaultProvider();
  }

  private aliveBot(id: string): BotRow {
    const row = this.db.query<BotRow, [string]>(`SELECT * FROM bots WHERE id = ?`).get(id);
    if (!row || row.deleted_at) throw new HttpError(404, "not_found", "bot not found");
    return row;
  }

  private assertNameFree(name: string): void {
    const taken = this.db
      .query<{ id: string }, [string]>(`SELECT id FROM bots WHERE name = ? LIMIT 1`)
      .get(name);
    if (taken) throw new HttpError(409, "conflict", "that name is already used");
  }

  unreadCount(sessionId: string): number {
    this.sessionRow(sessionId);
    const row = this.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.session_id = ?
           AND m.kind != 'profile_change'
           AND m.author != ?
           AND (s.last_read_at IS NULL OR m.created_at > s.last_read_at)`,
      )
      .get(sessionId, USER_MEMBER);
    return row?.n ?? 0;
  }

  private unreadCountsBySession(): Map<string, number> {
    const rows = this.db
      .query<{ session_id: string; n: number }, [string]>(
        `SELECT m.session_id AS session_id, COUNT(*) AS n
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.kind != 'profile_change'
           AND m.author != ?
           AND (s.last_read_at IS NULL OR m.created_at > s.last_read_at)
         GROUP BY m.session_id`,
      )
      .all(USER_MEMBER);
    return new Map(rows.map((row) => [row.session_id, row.n]));
  }

  private sessionRow(id: string): SessionRow {
    const row = this.db.query<SessionRow, [string]>(`SELECT * FROM sessions WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "session not found");
    return row;
  }

  private messageRow(id: string): MessageRow {
    const row = this.db.query<MessageRow, [string]>(`SELECT * FROM messages WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "message not found");
    return row;
  }

  getAttachment(id: string): Attachment {
    const row = this.db.query<AttachmentRow, [string]>(`SELECT * FROM attachments WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, "not_found", "attachment not found");
    return this.hydrateAttachment(row);
  }

  /**
   * On-disk location for an attachment that is still allowed to be read.
   * Workspace-relative paths must stay inside the workspace. Inbox copies
   * without a workspace still live under Application Support.
   */
  resolveAttachmentLocation(relpath: string): { abs: string; isDir: boolean } | null {
    const root = this.workspacePath();
    if (root) {
      const classified = classifyPath(root, relpath);
      if (classified.zone !== "inside") return null;
      return statOrMissing(classified.abs);
    }
    if (!relpath.startsWith("inbox/") && relpath !== "inbox") return null;
    const fallback = join(homedir(), "Library", "Application Support", APP_SUPPORT_DIRNAME, relpath);
    return statOrMissing(fallback);
  }

  getAttachmentFilePath(attachment: Attachment): string {
    const located = this.resolveAttachmentLocation(attachment.workspace_relpath);
    if (located) return located.abs;
    const ws = this.workspacePath();
    const root = ws || join(homedir(), "Library", "Application Support", APP_SUPPORT_DIRNAME);
    return join(root, attachment.workspace_relpath);
  }

  private insertPathAttachments(messageId: string, paths: string[], now: string): void {
    for (const rel of paths) {
      const filename = rel === "." ? "." : basename(rel) || rel;
      this.db.run(
        `INSERT INTO attachments (id, message_id, workspace_relpath, original_filename, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [ulid(), messageId, rel, filename, now],
      );
    }
  }

  private searchWorkspaceFiles(needle: string): Array<{ kind: "file"; path: string; snippet: string }> {
    const root = this.workspacePath();
    if (!root) return [];
    const hits: Array<{ kind: "file"; path: string; snippet: string }> = [];
    const walk = (abs: string, rel: string, depth: number) => {
      if (hits.length >= 40 || depth > 8) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(abs);
      } catch {
        return;
      }
      for (const name of entries) {
        if (hits.length >= 40) return;
        if (name === ".git" || name === "node_modules" || name === ".DS_Store") continue;
        if (name.startsWith(".") && name !== ".env") continue;
        const childAbs = join(abs, name);
        const childRel = rel === "." ? name : `${rel}/${name}`;
        let st;
        try {
          st = statSync(childAbs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(childAbs, childRel, depth + 1);
          continue;
        }
        if (!st.isFile()) continue;
        if (childRel.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)) {
          hits.push({ kind: "file", path: childRel, snippet: childRel });
        }
      }
    };
    walk(root, ".", 0);
    return hits;
  }

  private hydrateAttachment(row: AttachmentRow): Attachment {
    const located = this.resolveAttachmentLocation(row.workspace_relpath);
    let exists = false;
    let is_dir = false;
    let size: number | null = null;
    if (located) {
      try {
        const st = statSync(located.abs);
        exists = true;
        is_dir = st.isDirectory();
        size = st.size;
      } catch {
        exists = false;
      }
    }
    return {
      ...row,
      exists,
      is_dir,
      size,
      mime: attachmentMime(row.original_filename, row.workspace_relpath),
    };
  }

  private hydrateMessage(row: MessageRow): Message {
    const attachments = this.db
      .query<AttachmentRow, [string]>(`SELECT * FROM attachments WHERE message_id = ?`)
      .all(row.id)
      .map((att) => this.hydrateAttachment(att));
    const reactions = this.db
      .query<Reaction, [string]>(`SELECT * FROM reactions WHERE message_id = ?`)
      .all(row.id);
    return { ...row, attachments, reactions };
  }

  private touchSession(id: string, now: string): void {
    this.db.run(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [now, id]);
  }
}

type RoutineRow = {
  id: string;
  bot_id: string;
  title: string;
  instruction: string;
  schedule_kind: "daily" | "weekly";
  schedule_time: string;
  weekdays: string | null;
  enabled: number;
  last_fired_for_due_at: string | null;
  created_at: string;
  updated_at: string;
};

type SkillRow = {
  id: string;
  bot_id: string;
  name: string;
  description: string;
  body: string;
  uses?: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type ApprovalRow = {
  id: string;
  turn_id: string;
  message_id: string | null;
  status: string;
  kind_key: string | null;
  summary: string | null;
  target: string | null;
  created_at: string;
  resolved_at: string | null;
  requires_api_key?: number | boolean | null;
};

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    turn_id: row.turn_id,
    message_id: row.message_id,
    status: row.status as Approval["status"],
    kind_key: row.kind_key,
    summary: row.summary,
    target: row.target,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    requires_api_key: Boolean(row.requires_api_key),
  };
}

function toTurn(row: TurnRow): Turn {
  return { ...row, partial_text: null };
}

function toBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    duties: row.duties,
    boundaries: row.boundaries,
    avatar: row.avatar ?? generateBoringAvatar({ name: row.name }),
    model: row.model,
    provider_id: row.provider_id,
    thinking_level: parseStoredThinkingLevel(row.thinking_level),
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function statOrMissing(abs: string): { abs: string; isDir: boolean } | null {
  try {
    const st = statSync(abs);
    return { abs, isDir: st.isDirectory() };
  } catch {
    return { abs, isDir: false };
  }
}

function migrateSchema(db: Database): void {
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
}

type McpRow = {
  id: string;
  name: string;
  transport?: string | null;
  command: string;
  args: string;
  url?: string | null;
  headers?: string | null;
  enabled: number;
  instructions?: string | null;
  usage_note?: string | null;
  tool_catalog?: string | null;
  created_at: string;
  updated_at: string;
};

const MCP_USAGE_NOTE_MAX = 2000;

/** Trims the roster-level MCP usage note; empty means "no note". */
function parseMcpUsageNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "usage_note must be a string");
  }
  const note = value.trim();
  if (note.length === 0) return null;
  if (codePointCount(note) > MCP_USAGE_NOTE_MAX) {
    throw new HttpError(422, "invalid_args", `usage_note must be at most ${MCP_USAGE_NOTE_MAX} characters`);
  }
  return note;
}

function parseTransport(value: string | null | undefined): McpTransport {
  return value === "http" ? "http" : "stdio";
}

function parseMcpArgs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through
  }
  return [];
}

function parseMcpHeaders(raw: string | null | undefined): McpHeader[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: McpHeader[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const name = (item as { name?: unknown }).name;
      const value = (item as { value?: unknown }).value;
      if (typeof name !== "string" || name.trim().length === 0) continue;
      if (typeof value !== "string") continue;
      out.push({ name: name.trim(), value });
    }
    return out;
  } catch {
    return [];
  }
}

function parseToolCatalog(raw: string | null | undefined): Array<{ name: string; description: string }> {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is { name: unknown; description?: unknown } =>
          Boolean(item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"),
        )
        .map((item) => ({
          name: String(item.name),
          description: typeof item.description === "string" ? item.description : "",
        }));
    }
  } catch {
    // fall through
  }
  return [];
}

function normalizeMcpSpec(input: {
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string | null;
  headers?: McpHeader[];
}): {
  transport: McpTransport;
  command: string;
  args: string[];
  url: string | null;
  headers: McpHeader[];
} {
  const urlGiven = typeof input.url === "string" && input.url.trim().length > 0;
  const commandGiven = typeof input.command === "string" && input.command.trim().length > 0;
  const transport: McpTransport =
    input.transport ?? (urlGiven && !commandGiven ? "http" : "stdio");
  if (transport === "http") {
    if (!urlGiven) throw new HttpError(422, "invalid_args", "url is required");
    return {
      transport,
      command: "",
      args: [],
      url: resolveMcpUrl(input.url),
      headers: normalizeMcpHeaders(input.headers ?? []),
    };
  }
  if (!commandGiven) throw new HttpError(422, "invalid_args", "command is required");
  return {
    transport,
    command: requireNonEmpty("command", input.command),
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    url: null,
    headers: [],
  };
}

function normalizeMcpHeaders(value: unknown): McpHeader[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(422, "invalid_args", "headers must be an array of { name, value }");
  }
  const out: McpHeader[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new HttpError(422, "invalid_args", "headers must be an array of { name, value }");
    }
    const name = (item as { name?: unknown }).name;
    const headerValue = (item as { value?: unknown }).value;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new HttpError(422, "invalid_args", "header name is required");
    }
    if (typeof headerValue !== "string") {
      throw new HttpError(422, "invalid_args", "header value must be a string");
    }
    const trimmed = name.trim();
    if (trimmed.toLowerCase() === "authorization") continue;
    out.push({ name: trimmed, value: headerValue });
  }
  return out;
}

function resolveMcpUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "url must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new HttpError(422, "invalid_args", "url is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(422, "invalid_args", "url must be an http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(422, "invalid_args", "url must be an http or https URL");
  }
  return parsed.href;
}

const SKILL_NAME_MAX = 64;
const SKILL_DESCRIPTION_MAX = 500;
const SKILL_BODY_MAX = 32_000;
const SKILL_MAX_PER_BOT = 32;

function parseSkillName(value: unknown): string {
  const name = requireNonEmpty("name", value);
  if (codePointCount(name) > SKILL_NAME_MAX) {
    throw new HttpError(422, "invalid_args", `name must be at most ${SKILL_NAME_MAX} characters`);
  }
  return name;
}

function parseSkillDescription(value: unknown): string {
  const description = requireNonEmpty("description", value);
  if (codePointCount(description) > SKILL_DESCRIPTION_MAX) {
    throw new HttpError(422, "invalid_args", `description must be at most ${SKILL_DESCRIPTION_MAX} characters`);
  }
  return description;
}

function parseSkillBody(value: unknown): string {
  const body = requireNonEmpty("body", value);
  if (codePointCount(body) > SKILL_BODY_MAX) {
    throw new HttpError(422, "invalid_args", `body must be at most ${SKILL_BODY_MAX} characters`);
  }
  return body;
}

const SKILL_USES_MAX = 16;
const SKILL_USE_NAME_MAX = 64;

/** MCP server names a skill relies on: trimmed, deduped case-insensitively, empty entries dropped. */
function parseSkillUses(value: unknown): string[] {
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

function parseSkillUsesJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    bot_id: row.bot_id,
    name: row.name,
    description: row.description,
    body: row.body,
    uses: parseSkillUsesJson(row.uses),
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRoutine(row: RoutineRow): Routine {
  const schedule: Routine["schedule"] =
    row.schedule_kind === "weekly"
      ? { kind: "weekly", time: row.schedule_time, weekdays: JSON.parse(row.weekdays ?? "[]") }
      : { kind: "daily", time: row.schedule_time };
  return {
    id: row.id,
    bot_id: row.bot_id,
    title: row.title,
    instruction: row.instruction,
    schedule,
    enabled: row.enabled === 1,
    last_fired_for_due_at: row.last_fired_for_due_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseSchedule(schedule: Routine["schedule"] | undefined): Routine["schedule"] {
  if (!schedule || (schedule.kind !== "daily" && schedule.kind !== "weekly")) {
    throw new HttpError(422, "invalid_args", "schedule.kind must be daily or weekly");
  }
  if (!parseClockTime(schedule.time)) {
    throw new HttpError(422, "invalid_args", "schedule.time must be HH:MM");
  }
  if (schedule.kind === "weekly") {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) {
      throw new HttpError(422, "invalid_args", "weekly schedule needs weekdays");
    }
    const weekdays = [...new Set(schedule.weekdays)];
    if (!weekdays.every(isWeekday)) {
      throw new HttpError(422, "invalid_args", "weekdays must be mon..sun");
    }
    return { kind: "weekly", time: schedule.time, weekdays };
  }
  return { kind: "daily", time: schedule.time };
}

function memoryKeyStore(): EndpointKeyStore {
  let value: string | null = null;
  return {
    async get() {
      return value;
    },
    async set(next) {
      value = next;
    },
    async delete() {
      value = null;
    },
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function requireNonEmpty(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(422, "invalid_args", `${field} is required`);
  }
  return value.trim();
}

function requireString(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", `${field} must be a string`);
  }
  return value;
}

function normalizeOptionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function resolveWorkspacePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "workspace_path must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new HttpError(422, "invalid_args", "workspace_path cannot be empty");
  }
  const expanded = expandHome(trimmed);
  if (!isAbsolute(expanded)) {
    throw new HttpError(422, "invalid_args", "workspace_path must be an absolute directory");
  }
  try {
    if (!existsSync(expanded)) {
      mkdirSync(expanded, { recursive: true });
    }
    const resolved = realpathSync(expanded);
    if (!statSync(resolved).isDirectory()) {
      throw new HttpError(422, "invalid_args", "workspace_path must be a directory");
    }
    return resolved;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "invalid_args", "workspace_path could not be created");
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function resolveEndpointUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "endpoint_base_url must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new HttpError(422, "invalid_args", "endpoint_base_url cannot be empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(422, "invalid_args", "endpoint_base_url must be an http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(422, "invalid_args", "endpoint_base_url must be an http or https URL");
  }
  return parsed.href;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new HttpError(422, "invalid_args", "limit must be 1..200");
  }
  return limit;
}

function cursorTime(cursor: string): string {
  const i = cursor.indexOf("|");
  if (i < 0) throw new HttpError(422, "invalid_args", "bad cursor");
  return cursor.slice(0, i);
}

function cursorId(cursor: string): string {
  const i = cursor.indexOf("|");
  if (i < 0) throw new HttpError(422, "invalid_args", "bad cursor");
  return cursor.slice(i + 1);
}

function isLive(status: Turn["status"]): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_ask";
}

function sessionSearchTitle(
  session: { kind: SessionKind; name: string | null },
  participants: readonly SessionParticipant[],
  botNames: ReadonlyMap<string, string>,
): string {
  if (session.kind === "group") return session.name ?? "";
  const names = participants
    .filter((p) => p.left_at === null && p.member !== USER_MEMBER)
    .map((p) => botNames.get(p.member) ?? p.member);
  const hasYou = participants.some((p) => p.left_at === null && p.member === USER_MEMBER);
  if (hasYou) return names[0] ?? "";
  return names.join(" ↔ ");
}
