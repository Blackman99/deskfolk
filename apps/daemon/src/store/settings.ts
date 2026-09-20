/**
 * Settings and default-provider primitives: the `/settings` read/patch surface, endpoint key
 * lookup, and the legacy single-provider migration that seeds a `providers` row from old flat
 * settings columns and keeps the flat settings mirror in sync with the current default provider.
 */
import {
  KEYCHAIN_NAME,
  KEYCHAIN_REF,
  providerKeychainName,
  type PatchProviderRequest,
  type Provider,
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
import { createProviderSync, listProviders, patchProviderSync, toProviderCached } from "./providers";
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
  return settingsCached(ctx);
}

export function settingsCached(ctx: StoreContext): Settings {
  const map = settingsMap(ctx);
  const workspace_path = emptyToNull(map.get("workspace_path"));
  const providers = providerRows(ctx).map((row) => toProviderCached(ctx, row));
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
  return {
    settings_rev: ctx.db.query<{ settings_rev: number }, []>("SELECT settings_rev FROM request_meta WHERE singleton = 1").get()!.settings_rev,
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
      key !== "launch_at_login" &&
      key !== "locale" &&
      key !== "theme"
    ) {
      throw new HttpError(422, "invalid_args", `unknown settings field: ${key}`);
    }
  }
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
  const touchesEndpoint =
    "endpoint_base_url" in patch ||
    "endpoint_api_key" in patch ||
    "endpoint_models" in patch ||
    "endpoint_default_model" in patch;
  if (touchesEndpoint) {
    const current = settingsMap(ctx);
    const providers = providerRows(ctx).map((row) => toProviderCached(ctx, row));
    const target =
      defaultProviderRow(ctx, providers, emptyToNull(current.get("default_provider_id"))) ??
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
      patchProviderSync(ctx, target.id, providerPatch);
    } else {
      const created = createProviderSync(ctx, {
        name: "Default",
        base_url: providerPatch.base_url ?? "",
        api_key: providerPatch.api_key,
        models: providerPatch.models,
        default_model: providerPatch.default_model,
      });
      setSetting(ctx, "default_provider_id", created.id);
      mirrorDefaultProvider(ctx);
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
  ensureLegacyProviderRow(ctx);
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
