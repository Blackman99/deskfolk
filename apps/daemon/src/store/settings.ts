/**
 * Settings and default-provider primitives: the `/settings` read/patch surface, endpoint key
 * lookup, and the legacy single-provider migration that seeds a `providers` row from old flat
 * settings columns and keeps the flat settings mirror in sync with the current default provider.
 */
import {
  BUILTIN_MODEL_ROLES,
  KEYCHAIN_NAME,
  KEYCHAIN_REF,
  isBuiltinModelRole,
  isAgentModelName,
  isBotRunner,
  type BotRunner,
  isClaudeModelName,
  isLocalEndpoint,
  isReaderAgentModel,
  providerKeychainName,
  type BuiltinModelRole,
  type BuiltinModels,
  type PatchProviderRequest,
  type Provider,
  type ReaderAgentModel,
  type ReaderEndpointModel,
  type ReaderModel,
  type Settings,
  type SettingsPatch,
  type Theme,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import {
  catalogNames,
  normalizeModelCatalog,
  parseStoredCatalog,
  serializeCatalog,
  unionProviderModels,
} from "../models";
import { listedConfigDir } from "./claude-code";
import { listedAgentConfigDir, listedCustomAgent } from "./agents";
import { hydrateSpeechKey, speechSettings } from "./speech";
import { createProviderSync, listProviders, patchProviderSync, providersCached } from "./providers";
import {
  type ProviderRow,
  type StoreContext,
  defaultProviderId,
  emptyToNull,
  normalizeOptionalId,
  providerRows,
  requireProvider,
  resolveEndpointUrl,
  resolveWorkspacePath,
  setSetting,
  settingsMap,
  keyMutation,
} from "./shared";

export async function settings(ctx: StoreContext): Promise<Settings> {
  await ensureLegacyProvider(ctx);
  await listProviders(ctx);
  await hydrateSpeechKey(ctx);
  return settingsCached(ctx);
}

export function settingsCached(ctx: StoreContext): Settings {
  const map = settingsMap(ctx);
  const workspace_path = emptyToNull(map.get("workspace_path"));
  const providers = providersCached(ctx);
  const defaultProvider = defaultProviderRow(ctx, providers, emptyToNull(map.get("default_provider_id")));
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
  const builtin_models = Object.fromEntries(
    BUILTIN_MODEL_ROLES.map((role) => [role, builtinModelRead(map, providers, role)]),
  ) as BuiltinModels;
  const reader_model = builtin_models.reader;
  // Older windows know the organizing model as an endpoint's only (ADR 0075).
  const organizer_model: ReaderEndpointModel | null = builtin_models.organizer && !isReaderAgentModel(builtin_models.organizer)
    ? builtin_models.organizer : null;
  return {
    settings_rev: ctx.db.query<{ settings_rev: number }, []>("SELECT settings_rev FROM request_meta WHERE singleton = 1").get()!.settings_rev,
    workspace_path,
    endpoint_base_url,
    endpoint_key_set: keySet,
    endpoint_models,
    endpoint_model_catalog,
    endpoint_default_model,
    default_provider_id: defaultProvider?.id ?? null,
    reader_model,
    organizer_model,
    builtin_models,
    speech: speechSettings(ctx),
    launch_at_login,
    locale,
    theme,
    wizard_complete: Boolean(
      workspace_path &&
        (hasUsableEndpoint(providers) || setUpOnClaudeCode(builtin_models)),
    ),
  };
}

/**
 * Set up on Claude Code alone (ADR 0078): every built-in call that can run on a Claude model is on
 * one, so the app has a model for each call it makes without an endpoint. Compaction is left out:
 * it only runs in an endpoint Bot's turn, and Claude Code compacts its own.
 */
export function setUpOnClaudeCode(models: BuiltinModels): boolean {
  return BUILTIN_MODEL_ROLES.every((role) => role === "compaction" || isReaderAgentModel(models[role]));
}

/** An endpoint a turn can be sent to: an address, and a key unless it is on this computer or network. */
function hasUsableEndpoint(providers: ReturnType<typeof providersCached>): boolean {
  return providers.some((provider) => provider.base_url && (provider.key_set || isLocalEndpoint(provider.base_url)));
}

/**
 * Set up on Claude Code alone, with no endpoint to run a Bot on (ADR 0078): the Claude account the
 * app's own calls use, which a new Bot made without saying what runs it is put on. Null while there
 * is an endpoint, or the app is not set up on Claude Code.
 */
export function claudeOnlyAccount(ctx: StoreContext): { runner: BotRunner; configDir: string | null; customId: string | null } | null {
  const settings = settingsCached(ctx);
  if (hasUsableEndpoint(providersCached(ctx)) || !settings.builtin_models || !setUpOnClaudeCode(settings.builtin_models)) return null;
  // Set up on another local agent alone (ADR 0079), the same way: the one lines are read on.
  const reader = settings.builtin_models.reader;
  return isReaderAgentModel(reader)
    ? { runner: reader.runner, configDir: reader.config_dir, customId: reader.custom_id ?? null }
    : { runner: "claude_code", configDir: null, customId: null };
}

/**
 * Where each built-in call's choice is kept (ADR 0077): `<role>_provider_id`, `_model`, `_runner`
 * and `_config_dir`. The reader's and the organizer's are the keys they always had.
 */
export function builtinModelKeys(role: BuiltinModelRole): { provider: string; model: string; runner: string; configDir: string; customId: string } {
  return { provider: `${role}_provider_id`, model: `${role}_model`, runner: `${role}_runner`, configDir: `${role}_config_dir`, customId: `${role}_custom_id` };
}

/**
 * A built-in call's model as you chose it: a Claude model of yours (ADR 0061) as kept, since it names
 * no endpoint to look up; an endpoint's read as null while that endpoint is gone or no longer lists it.
 */
function builtinModelRead(map: Map<string, string>, providers: readonly Provider[], role: BuiltinModelRole): ReaderModel | null {
  const keys = builtinModelKeys(role);
  const model = emptyToNull(map.get(keys.model));
  if (!model) return null;
  const runner = map.get(keys.runner);
  if (runner === "claude_code") return { runner: "claude_code", model, config_dir: emptyToNull(map.get(keys.configDir)) };
  // Another local agent of yours (ADR 0079), kept as chosen: like Claude's, it names no endpoint.
  if (isBotRunner(runner)) return { runner, model, config_dir: emptyToNull(map.get(keys.configDir)), custom_id: emptyToNull(map.get(keys.customId)) };
  const provider = providers.find((row) => row.id === emptyToNull(map.get(keys.provider)));
  return provider && provider.models.includes(model) ? { provider_id: provider.id, model } : null;
}

/** The language the app speaks to the user in. */
export function localeOf(ctx: StoreContext): "zh" | "en" {
  return settingsCached(ctx).locale === "en" ? "en" : "zh";
}

/**
 * The model a patch names for a built-in call (ADR 0055, 0077): one an endpoint lists, a Claude
 * model of yours on one of the accounts listed in Settings (ADR 0061), or null to run it as before.
 */
function builtinModelOf(ctx: StoreContext, value: unknown, field: string): ReaderModel | null {
  if (value === null) return null;
  if (value && typeof value === "object" && "runner" in value) {
    const agent = value as Partial<ReaderAgentModel>;
    if (agent.runner === "claude_code") {
      if (typeof agent.model !== "string" || !isClaudeModelName(agent.model)) {
        throw new HttpError(422, "invalid_args", `${field} must be { runner: "claude_code", model, config_dir } with a Claude model name`);
      }
      return { runner: "claude_code", model: agent.model, config_dir: listedConfigDir(ctx, agent.config_dir, `${field}.config_dir`) };
    }
    // Another local agent of yours (ADR 0079): its model as it names them, one of its accounts, and
    // for your own ACP agent, which one.
    if (!isBotRunner(agent.runner) || typeof agent.model !== "string" || !isAgentModelName(agent.model.trim())) {
      throw new HttpError(422, "invalid_args", `${field} must be { runner, model, config_dir } with a runner the app knows and a model name`);
    }
    const customId = agent.runner === "custom" ? listedCustomAgent(ctx, agent.custom_id, `${field}.custom_id`) : null;
    return { runner: agent.runner, model: agent.model.trim(), config_dir: listedAgentConfigDir(ctx, agent.runner, agent.config_dir, `${field}.config_dir`),
      ...(customId ? { custom_id: customId } : {}) };
  }
  const row = value as Partial<ReaderEndpointModel> | undefined;
  if (!row || typeof row !== "object" || typeof row.provider_id !== "string" || typeof row.model !== "string") {
    throw new HttpError(422, "invalid_args", `${field} must be null, { provider_id, model } or { runner, model, config_dir }`);
  }
  const provider = providersCached(ctx).find((candidate) => candidate.id === row.provider_id);
  if (!provider) throw new HttpError(404, "not_found", "provider not found");
  if (!provider.models.includes(row.model)) throw new HttpError(422, "invalid_args", `${field} must be a model that endpoint lists`);
  return { provider_id: provider.id, model: row.model };
}

function setBuiltinModel(ctx: StoreContext, role: BuiltinModelRole, chosen: ReaderModel | null): void {
  const keys = builtinModelKeys(role);
  const agent = isReaderAgentModel(chosen) ? chosen : null;
  setSetting(ctx, keys.provider, chosen && !agent ? (chosen as ReaderEndpointModel).provider_id : "");
  setSetting(ctx, keys.model, chosen?.model ?? "");
  setSetting(ctx, keys.runner, agent ? agent.runner : "");
  setSetting(ctx, keys.configDir, agent?.config_dir ?? "");
  setSetting(ctx, keys.customId, agent?.custom_id ?? "");
}

/**
 * The model an older window's patch names to organize with (ADR 0075): one an endpoint lists, or
 * null to follow the default. `builtin_models.organizer` takes a Claude model of yours as well (ADR 0077).
 */
function organizerModelOf(ctx: StoreContext, value: unknown): ReaderEndpointModel | null {
  if (value === null) return null;
  const row = value as Partial<ReaderEndpointModel> | undefined;
  if (!row || typeof row !== "object" || "runner" in row || typeof row.provider_id !== "string" || typeof row.model !== "string") {
    throw new HttpError(422, "invalid_args", "organizer_model must be null or { provider_id, model }");
  }
  const provider = providersCached(ctx).find((candidate) => candidate.id === row.provider_id);
  if (!provider) throw new HttpError(404, "not_found", "provider not found");
  if (!provider.models.includes(row.model)) throw new HttpError(422, "invalid_args", "organizer_model must be a model that endpoint lists");
  return { provider_id: provider.id, model: row.model };
}

export async function patchSettings(
  ctx: StoreContext,
  patch: SettingsPatch | Record<string, unknown>,
): Promise<Settings> {
  await settings(ctx);
  await keyMutation(ctx, () => patchSettingsSync(ctx, patch));
  return settings(ctx);
}

export function patchSettingsSync(ctx: StoreContext, patch: SettingsPatch | Record<string, unknown>): Settings {
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
      key !== "reader_model" &&
      key !== "organizer_model" &&
      key !== "builtin_models" &&
      key !== "launch_at_login" &&
      key !== "locale" &&
      key !== "theme"
    ) {
      throw new HttpError(422, "invalid_args", `unknown settings field: ${key}`);
    }
  }
  ctx.commit(() => {
    if ("workspace_path" in patch) {
      setSetting(ctx, "workspace_path", resolveWorkspacePath(patch.workspace_path));
    }
    if ("launch_at_login" in patch) {
      if (typeof patch.launch_at_login !== "boolean") {
        throw new HttpError(422, "invalid_args", "launch_at_login must be a boolean");
      }
      setSetting(ctx, "launch_at_login", patch.launch_at_login ? "1" : "0");
    }
    if ("locale" in patch) {
      if (patch.locale !== "zh" && patch.locale !== "en") {
        throw new HttpError(422, "invalid_args", "locale must be zh or en");
      }
      setSetting(ctx, "locale", patch.locale);
    }
    if ("theme" in patch) {
      if (patch.theme !== "system" && patch.theme !== "light" && patch.theme !== "dark") {
        throw new HttpError(422, "invalid_args", "theme must be system, light, or dark");
      }
      setSetting(ctx, "theme", patch.theme);
    }
    if ("default_provider_id" in patch) {
      const nextId = normalizeOptionalId(patch.default_provider_id, "default_provider_id");
      if (nextId) requireProvider(ctx, nextId);
      setSetting(ctx, "default_provider_id", nextId ?? "");
    }
    // One choice at a time: an endpoint's model clears the Claude keys, a Claude model the endpoint's.
    if ("reader_model" in patch) setBuiltinModel(ctx, "reader", builtinModelOf(ctx, patch.reader_model, "reader_model"));
    if ("organizer_model" in patch) setBuiltinModel(ctx, "organizer", organizerModelOf(ctx, patch.organizer_model));
    if ("builtin_models" in patch) {
      const given = patch.builtin_models;
      if (!given || typeof given !== "object" || Array.isArray(given)) {
        throw new HttpError(422, "invalid_args", "builtin_models must be an object of call → model or null");
      }
      // Validated whole before any is written: the transaction rolls back on a throw either way.
      const chosen = Object.entries(given as Record<string, unknown>).map(([role, value]) => {
        if (!isBuiltinModelRole(role)) throw new HttpError(422, "invalid_args", `unknown built-in call: ${role}`);
        return [role, builtinModelOf(ctx, value, `builtin_models.${role}`)] as const;
      });
      for (const [role, model] of chosen) setBuiltinModel(ctx, role, model);
    }
  });
  const touchesEndpoint =
    "endpoint_base_url" in patch ||
    "endpoint_api_key" in patch ||
    "endpoint_models" in patch ||
    "endpoint_default_model" in patch;
  if (touchesEndpoint) {
    const current = settingsMap(ctx);
    const providers = providersCached(ctx);
    const target =
      defaultProviderRow(ctx, providers, emptyToNull(current.get("default_provider_id"))) ??
      providers[0] ??
      null;
    const providerPatch: PatchProviderRequest = {};
    if ("endpoint_base_url" in patch) {
      providerPatch.base_url = resolveEndpointUrl(patch.endpoint_base_url);
    }
    if ("endpoint_models" in patch) {
      // Checked here and passed on as sent, so that a null on a model's measured field still
      // clears it (models.ts).
      normalizeModelCatalog(patch.endpoint_models);
      providerPatch.models = patch.endpoint_models as PatchProviderRequest["models"];
    }
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
      patchProviderSync(ctx, target.id, providerPatch);
    } else {
      const created = createProviderSync(ctx, {
        name: "Default",
        base_url: providerPatch.base_url ?? "",
        api_key: providerPatch.api_key,
        models: providerPatch.models,
        default_model: providerPatch.default_model,
      });
      ctx.commit(() => {
        setSetting(ctx, "default_provider_id", created.id);
        mirrorDefaultProvider(ctx);
      });
    }
  }
  ctx.db.run("UPDATE request_meta SET settings_rev = settings_rev + 1 WHERE singleton = 1");
  return settingsCached(ctx);
}

export async function endpointKey(ctx: StoreContext, providerId?: string | null): Promise<string | null> {
  await ensureLegacyProvider(ctx);
  const id = providerId ?? defaultProviderId(ctx);
  if (!id) return ctx.keys.read(KEYCHAIN_NAME);
  return ctx.keys.read(providerKeychainName(id));
}

export function defaultProviderRow(
  ctx: StoreContext,
  providers: Provider[],
  preferredId: string | null,
): Provider | null {
  if (preferredId) {
    const named = providers.find((provider) => provider.id === preferredId);
    if (named) return named;
  }
  return providers[0] ?? null;
}

export function mirrorDefaultProvider(ctx: StoreContext): void {
  const id = defaultProviderId(ctx);
  const row = id
    ? ctx.db.query<ProviderRow, [string]>(`SELECT * FROM providers WHERE id = ?`).get(id)
    : providerRows(ctx)[0];
  if (!row) {
    setSetting(ctx, "endpoint_base_url", "");
    setSetting(ctx, "endpoint_models", "[]");
    setSetting(ctx, "endpoint_default_model", "");
    setSetting(ctx, "endpoint_key_ref", "");
    return;
  }
  if (!defaultProviderId(ctx)) setSetting(ctx, "default_provider_id", row.id);
  setSetting(ctx, "endpoint_base_url", row.base_url);
  setSetting(ctx, "endpoint_models", row.models);
  setSetting(ctx, "endpoint_default_model", row.default_model ?? "");
  setSetting(ctx, "endpoint_key_ref", KEYCHAIN_REF);
}

export async function ensureLegacyProvider(ctx: StoreContext): Promise<void> {
  ctx.commit(() => ensureLegacyProviderRow(ctx));
  const id = defaultProviderId(ctx) ?? providerRows(ctx)[0]?.id;
  if (!id || ctx.legacy.copiedKey) return;
  const existing = await ctx.keys.read(providerKeychainName(id));
  if (existing || ctx.keys.pending(providerKeychainName(id))) { ctx.legacy.copiedKey = true; return; }
  const legacy = await ctx.keys.read(KEYCHAIN_NAME);
  if (legacy) await ctx.keys.write(providerKeychainName(id), legacy);
  ctx.legacy.copiedKey = true;
}

export function ensureLegacyProviderRow(ctx: StoreContext): void {
  if (providerRows(ctx).length > 0) {
    if (!defaultProviderId(ctx)) setSetting(ctx, "default_provider_id", providerRows(ctx)[0]!.id);
    mirrorDefaultProvider(ctx);
    return;
  }
  const map = settingsMap(ctx);
  const baseUrl = emptyToNull(map.get("endpoint_base_url"));
  const catalog = parseStoredCatalog(map.get("endpoint_models"));
  const models = catalogNames(catalog);
  const storedDefault = emptyToNull(map.get("endpoint_default_model"));
  const defaultModel = storedDefault && models.includes(storedDefault) ? storedDefault : (models[0] ?? null);
  const hadKeyRef = Boolean(emptyToNull(map.get("endpoint_key_ref")));
  if (!baseUrl && models.length === 0 && !hadKeyRef) return;
  const now = isoNow();
  const id = ulid();
  ctx.db.run(
    `INSERT INTO providers (id, name, base_url, models, available_models, default_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`,
    [id, "Default", baseUrl ?? "", serializeCatalog(catalog), defaultModel, now, now],
  );
  setSetting(ctx, "default_provider_id", id);
  mirrorDefaultProvider(ctx);
}
