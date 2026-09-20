/**
 * Provider CRUD and the model/thinking-level resolution that keeps bots pointed at models their
 * provider actually offers: incoming bot model/provider/thinking-level normalization, the model
 * catalog exposed to routing, and the cleanup that unpins bots when a provider's models change.
 */
import {
  providerKeychainName,
  type CreateProviderRequest,
  type PatchProviderRequest,
  sortThinkingLevels,
  THINKING_LEVELS,
  type Provider,
  type ThinkingLevel,
} from "@real-bot/protocol";
import { pickThinkingLevel } from "../route-decision";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
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
} from "../models";
import { type CatalogEntry } from "../route-decision";
import { ensureLegacyProvider, mirrorDefaultProvider } from "./settings";
import {
  type ProviderRow,
  type StoreContext,
  defaultProviderId,
  emptyToNull,
  normalizeOptionalId,
  providerRows,
  requireNonEmpty,
  requireProvider,
  resolveEndpointUrl,
  setSetting,
} from "./shared";

export async function listProviders(ctx: StoreContext): Promise<Provider[]> {
  await ensureLegacyProvider(ctx);
  const rows = ctx.db
    .query<ProviderRow, []>(`SELECT * FROM providers ORDER BY created_at ASC, id`)
    .all();
  const out: Provider[] = [];
  for (const row of rows) out.push(await toProvider(ctx, row));
  return out;
}

export async function getProvider(ctx: StoreContext, id: string): Promise<Provider> {
  await ensureLegacyProvider(ctx);
  return toProvider(ctx, requireProvider(ctx, id));
}

export async function createProvider(ctx: StoreContext, input: CreateProviderRequest): Promise<Provider> {
  await ensureLegacyProvider(ctx);
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
  ctx.commit(() => ctx.db.run(
    `INSERT INTO providers (id, name, base_url, models, available_models, default_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, baseUrl, serializeCatalog(catalog), JSON.stringify(availableModels), defaultModel, now, now],
  ));
  if (typeof input.api_key === "string" && input.api_key.length > 0) {
    await ctx.keys.write(providerKeychainName(id), input.api_key);
  }
  ctx.commit(() => {
    if (!defaultProviderId(ctx)) setSetting(ctx, "default_provider_id", id);
    mirrorDefaultProvider(ctx);
  });
  return getProvider(ctx, id);
}

export async function patchProvider(
  ctx: StoreContext,
  id: string,
  patch: PatchProviderRequest,
): Promise<Provider> {
  await ensureLegacyProvider(ctx);
  const current = requireProvider(ctx, id);
  if (patch.api_key !== undefined && typeof patch.api_key !== "string") {
    throw new HttpError(422, "invalid_args", "api_key must be a string");
  }
  const name = patch.name !== undefined ? requireNonEmpty("name", patch.name) : current.name;
  const baseUrl =
    patch.base_url !== undefined ? resolveEndpointUrl(patch.base_url) : current.base_url;
  let catalog = parseStoredCatalog(current.models);
  if (patch.models !== undefined) {
    catalog = normalizeModelCatalog(patch.models);
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
  ctx.commit(() => {
    if (patch.models !== undefined) dropUnknownBotModelsForProvider(ctx, id, models);
    ctx.db.run(
      `UPDATE providers SET name = ?, base_url = ?, models = ?, available_models = ?, default_model = ?, updated_at = ? WHERE id = ?`,
      [name, baseUrl, serializeCatalog(catalog), JSON.stringify(availableModels), defaultModel, now, id],
    );
    mirrorDefaultProvider(ctx);
  });
  if (patch.api_key !== undefined) {
    await ctx.keys.write(providerKeychainName(id), patch.api_key);
  }
  return getProvider(ctx, id);
}

export async function deleteProvider(ctx: StoreContext, id: string): Promise<void> {
  await ensureLegacyProvider(ctx);
  requireProvider(ctx, id);
  const remaining = ctx.db
    .query<ProviderRow, [string]>(`SELECT * FROM providers WHERE id != ? ORDER BY created_at ASC, id`)
    .all(id);
  const now = isoNow();
  ctx.commit(() => {
    ctx.db.run(`UPDATE bots SET provider_id = NULL, updated_at = ? WHERE provider_id = ?`, [now, id]);
    const changes = ctx.db.run(`DELETE FROM providers WHERE id = ?`, [id]).changes;
    if (changes === 0) throw new HttpError(404, "not_found", "provider not found");
  });
  await ctx.keys.write(providerKeychainName(id), "");
  ctx.commit(() => {
    const defaultId = defaultProviderId(ctx);
    if (defaultId === id) setSetting(ctx, "default_provider_id", remaining[0]?.id ?? "");
    dropUnknownBotModels(ctx, allConfiguredModels(ctx));
    mirrorDefaultProvider(ctx);
  });
}

export async function toProvider(ctx: StoreContext, row: ProviderRow): Promise<Provider> {
  await ctx.keys.read(providerKeychainName(row.id));
  return toProviderCached(ctx, row);
}

export function listProvidersCached(ctx: StoreContext): Provider[] {
  return providerRows(ctx).map((row) => toProviderCached(ctx, row));
}

function toProviderCached(ctx: StoreContext, row: ProviderRow): Provider {
  const catalog = parseStoredCatalog(row.models);
  const models = catalogNames(catalog);
  const storedDefault = emptyToNull(row.default_model);
  return {
    id: row.id,
    name: row.name,
    base_url: emptyToNull(row.base_url),
    key_set: ctx.keys.peek(providerKeychainName(row.id)) != null,
    models,
    model_catalog: catalog,
    available_models: parseStoredAvailableModels(row.available_models),
    default_model: storedDefault && models.includes(storedDefault) ? storedDefault : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function catalogEntries(ctx: StoreContext): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const row of providerRows(ctx)) {
    for (const item of parseStoredCatalog(row.models)) {
      out.push({ ...item, providerId: row.id });
    }
  }
  return out;
}

export function allConfiguredModels(ctx: StoreContext): string[] {
  return unionProviderModels(
    providerRows(ctx).map((row) => ({
      id: row.id,
      models: parseStoredModels(row.models),
      defaultModel: emptyToNull(row.default_model),
    })),
  );
}

export function resolveIncomingBotTarget(
  ctx: StoreContext,
  modelValue: unknown,
  providerValue: unknown,
): { model: string | null; providerId: string | null } {
  const model = modelValue === undefined ? null : normalizeBotModel(modelValue, allConfiguredModels(ctx));
  const providerId = normalizeOptionalId(providerValue, "provider_id");
  if (providerId) {
    const row = requireProvider(ctx, providerId);
    const models = parseStoredModels(row.models);
    if (model && !models.includes(model)) {
      throw new HttpError(422, "invalid_args", "model must be one of the provider models");
    }
    return { model, providerId };
  }
  if (!model) return { model: null, providerId: null };
  const match = resolveProviderForModel(
    providerRows(ctx).map((row) => ({
      id: row.id,
      models: parseStoredModels(row.models),
      defaultModel: emptyToNull(row.default_model),
    })),
    { model, providerId: null, defaultProviderId: defaultProviderId(ctx) },
  );
  return { model, providerId: match?.id ?? null };
}

/**
 * A thinking level belongs to a model: either the app picks both, or a Bot pins both. An explicit
 * pin therefore needs a pinned model, and must be a level that model supports.
 */
export function resolveIncomingThinkingLevel(
  ctx: StoreContext,
  value: unknown,
  model: string | null,
  providerId: string | null,
): ThinkingLevel | null {
  const level = normalizeBotThinkingLevel(value);
  if (!level) return null;
  if (!model) {
    throw new HttpError(422, "invalid_args", "thinking_level needs a pinned model");
  }
  if (!modelSupportsThinking(ctx, model, providerId, level)) {
    throw new HttpError(422, "invalid_args", "thinking_level must be one the pinned model supports");
  }
  return level;
}

/**
 * The level a pinned model lands on when none was given or the old pin does not survive the swap.
 * Same preference the router applies to an ordinary message, so pinning a model does not quietly
 * change how hard it thinks.
 */
export function defaultThinkingLevelFor(
  ctx: StoreContext,
  model: string | null,
  providerId: string | null,
): ThinkingLevel | null {
  if (!model) return null;
  const rows = providerId
    ? providerRows(ctx).filter((row) => row.id === providerId)
    : providerRows(ctx);
  const levels: string[] = [];
  for (const row of rows) {
    for (const entry of parseStoredCatalog(row.models)) {
      if (entry.name !== model) continue;
      levels.push(...(entry.thinking_levels.length > 0 ? entry.thinking_levels : THINKING_LEVELS));
    }
  }
  const supported = levels.length > 0 ? sortThinkingLevels(levels) : [...THINKING_LEVELS];
  return pickThinkingLevel("general", supported);
}

/**
 * A pin carried across a model change follows the new model: dropped entirely when the model went
 * away, and moved to that model's default when the new one cannot honour the old level.
 */
export function carriedThinkingLevel(
  ctx: StoreContext,
  raw: string | null,
  model: string | null,
  providerId: string | null,
): ThinkingLevel | null {
  if (!model) return null;
  const level = parseStoredThinkingLevel(raw);
  if (!level) return null;
  return modelSupportsThinking(ctx, model, providerId, level)
    ? level
    : defaultThinkingLevelFor(ctx, model, providerId);
}

export function modelSupportsThinking(
  ctx: StoreContext,
  model: string | null,
  providerId: string | null,
  level: ThinkingLevel,
): boolean {
  if (!model) return true;
  const rows = providerId
    ? providerRows(ctx).filter((row) => row.id === providerId)
    : providerRows(ctx);
  const entries = rows.flatMap((row) => parseStoredCatalog(row.models)).filter((row) => row.name === model);
  if (entries.length === 0) return true;
  const wanted = level.toLowerCase();
  return entries.some(
    (entry) =>
      entry.thinking_levels.length === 0 ||
      entry.thinking_levels.some((item) => item.toLowerCase() === wanted),
  );
}

export function dropUnknownBotModels(ctx: StoreContext, models: string[]): void {
  const rows = ctx.db
    .query<{ id: string; model: string }, []>(
      `SELECT id, model FROM bots WHERE deleted_at IS NULL AND model IS NOT NULL`,
    )
    .all();
  const now = isoNow();
  for (const row of rows) {
    if (models.includes(row.model)) continue;
    ctx.db.run(`UPDATE bots SET model = NULL, provider_id = NULL, updated_at = ? WHERE id = ?`, [
      now,
      row.id,
    ]);
  }
}

export function dropUnknownBotModelsForProvider(ctx: StoreContext, providerId: string, models: string[]): void {
  const rows = ctx.db
    .query<{ id: string; model: string }, [string]>(
      `SELECT id, model FROM bots WHERE deleted_at IS NULL AND provider_id = ? AND model IS NOT NULL`,
    )
    .all(providerId);
  const now = isoNow();
  for (const row of rows) {
    if (models.includes(row.model)) continue;
    ctx.db.run(`UPDATE bots SET model = NULL, updated_at = ? WHERE id = ?`, [now, row.id]);
  }
}
