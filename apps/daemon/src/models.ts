import {
  THINKING_LEVELS,
  isThinkingLevel,
  sortThinkingLevels,
  type EndpointModel,
  type ModelPricing,
  type ThinkingLevel,
} from "@real-bot/protocol";
import { HttpError } from "./errors";

export function parseStoredModels(raw: string | undefined): string[] {
  return parseStoredCatalog(raw).map((row) => row.name);
}

export function parseStoredCatalog(raw: string | undefined): EndpointModel[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => parseCatalogItemLoose(item))
      .filter((item): item is EndpointModel => item !== null);
  } catch {
    return [];
  }
}

export function catalogNames(catalog: readonly EndpointModel[]): string[] {
  return catalog.map((row) => row.name);
}

export function serializeCatalog(catalog: readonly EndpointModel[]): string {
  return JSON.stringify(catalog.map(serializeItem));
}

export function normalizeModelList(value: unknown): string[] {
  return catalogNames(normalizeModelCatalog(value));
}

/** Plain name list as the endpoint's `/models` returned it: trimmed, deduped, no attributes. */
export function normalizeAvailableModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(422, "invalid_args", "available_models must be an array of strings");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new HttpError(422, "invalid_args", "available_models must be an array of strings");
    }
    const name = item.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Loose read of the stored `/models` list; anything malformed reads as empty. */
export function parseStoredAvailableModels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const name = item.trim();
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

export function normalizeModelCatalog(value: unknown): EndpointModel[] {
  if (!Array.isArray(value)) {
    throw new HttpError(422, "invalid_args", "endpoint_models must be an array of strings");
  }
  const out: EndpointModel[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const row = parseCatalogItemStrict(item);
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    out.push(row);
  }
  return out;
}

export function normalizeDefaultModel(value: unknown, models: string[]): string | null {
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "endpoint_default_model must be a string");
  }
  const name = value.trim();
  if (name.length === 0) return null;
  if (!models.includes(name)) {
    throw new HttpError(422, "invalid_args", "endpoint_default_model must be one of endpoint_models");
  }
  return name;
}

export function normalizeBotModel(value: unknown, models: string[]): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "model must be a string");
  }
  const name = value.trim();
  if (name.length === 0) return null;
  if (!models.includes(name)) {
    throw new HttpError(422, "invalid_args", "model must be one of endpoint_models");
  }
  return name;
}

export function normalizeBotThinkingLevel(value: unknown): ThinkingLevel | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "thinking_level must be a reasoning_effort name");
  }
  const level = value.trim();
  if (level.length === 0) return null;
  if (!isThinkingLevel(level)) {
    throw new HttpError(422, "invalid_args", "thinking_level must be a reasoning_effort name");
  }
  return level;
}

/** Loose read of a stored pin: anything that is not a reasoning_effort token is treated as unpinned. */
export function parseStoredThinkingLevel(raw: string | null | undefined): ThinkingLevel | null {
  if (!raw || !isThinkingLevel(raw)) return null;
  return raw;
}

export function resolveCompletionModel(input: {
  botModel: string | null;
  defaultModel: string | null;
  models: string[];
}): string | null {
  if (input.botModel && input.models.includes(input.botModel)) return input.botModel;
  if (input.defaultModel && input.models.includes(input.defaultModel)) return input.defaultModel;
  return null;
}

export type ProviderModels = {
  id: string;
  models: string[];
  defaultModel: string | null;
};

export function unionProviderModels(providers: readonly ProviderModels[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    for (const name of provider.models) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export function resolveProviderForModel(
  providers: readonly ProviderModels[],
  input: { model: string | null; providerId: string | null; defaultProviderId: string | null },
): ProviderModels | null {
  if (input.providerId) {
    const named = providers.find((provider) => provider.id === input.providerId) ?? null;
    if (!named) return null;
    if (input.model && !named.models.includes(input.model)) return null;
    return named;
  }
  if (input.model) {
    const matches = providers.filter((provider) => provider.models.includes(input.model!));
    if (matches.length === 1) return matches[0]!;
    if (input.defaultProviderId) {
      const preferred = matches.find((provider) => provider.id === input.defaultProviderId);
      if (preferred) return preferred;
    }
    return matches[0] ?? null;
  }
  if (input.defaultProviderId) {
    return providers.find((provider) => provider.id === input.defaultProviderId) ?? providers[0] ?? null;
  }
  return providers[0] ?? null;
}

export function resolveCompletionTarget(
  providers: readonly ProviderModels[],
  input: { botModel: string | null; botProviderId: string | null; defaultProviderId: string | null },
): { providerId: string; model: string } | null {
  const provider = resolveProviderForModel(providers, {
    model: input.botModel,
    providerId: input.botProviderId,
    defaultProviderId: input.defaultProviderId,
  });
  if (!provider) return null;
  const model = resolveCompletionModel({
    botModel: input.botModel,
    defaultModel: provider.defaultModel,
    models: provider.models,
  });
  if (!model) return null;
  return { providerId: provider.id, model };
}

function parseCatalogItemLoose(item: unknown): EndpointModel | null {
  try {
    return parseCatalogItemStrict(item);
  } catch {
    return null;
  }
}

function parseCatalogItemStrict(item: unknown): EndpointModel {
  if (typeof item === "string") {
    const name = item.trim();
    if (name.length === 0) {
      throw new HttpError(422, "invalid_args", "endpoint_models cannot include empty names");
    }
    return defaultCatalogItem(name);
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new HttpError(422, "invalid_args", "endpoint_models must be an array of strings");
  }
  const rec = item as Record<string, unknown>;
  if (typeof rec.name !== "string") {
    throw new HttpError(422, "invalid_args", "endpoint_models must be an array of strings");
  }
  const name = rec.name.trim();
  if (name.length === 0) {
    throw new HttpError(422, "invalid_args", "endpoint_models cannot include empty names");
  }
  const pricing = normalizePricing(rec.pricing);
  return {
    name,
    ...(pricing ? { pricing } : {}),
    price: normalizePrice(rec.price),
    thinking_levels: normalizeThinkingLevels(rec.thinking_levels),
    strengths: normalizeStrengths(rec.strengths),
  };
}

function defaultCatalogItem(name: string): EndpointModel {
  return {
    name,
    price: null,
    thinking_levels: [...THINKING_LEVELS],
    strengths: [],
  };
}

function serializeItem(row: EndpointModel): Record<string, unknown> {
  return {
    name: row.name,
    price: row.price,
    ...(row.pricing ? { pricing: row.pricing } : {}),
    thinking_levels: row.thinking_levels,
    strengths: row.strengths,
  };
}

function normalizePricing(value: unknown): ModelPricing | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "invalid_args", "model pricing must contain input and output rates in USD per million tokens");
  }
  const rates = value as Record<string, unknown>;
  for (const key of ["input", "output", ...(rates.cached_input !== undefined ? ["cached_input"] : [])]) {
    const rate = rates[key];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
      throw new HttpError(422, "invalid_args", `model pricing.${key} must be a finite non-negative number`);
    }
  }
  return {
    input: rates.input as number,
    output: rates.output as number,
    ...(rates.cached_input !== undefined ? { cached_input: rates.cached_input as number } : {}),
  };
}

function normalizePrice(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HttpError(422, "invalid_args", "model price must be a non-negative number");
  }
  return value;
}

function normalizeThinkingLevels(value: unknown): ThinkingLevel[] {
  if (value === undefined || value === null) return [...THINKING_LEVELS];
  if (!Array.isArray(value)) {
    throw new HttpError(422, "invalid_args", "thinking_levels must be an array");
  }
  const collected: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isThinkingLevel(item.trim())) {
      throw new HttpError(422, "invalid_args", "thinking_levels must be reasoning_effort names");
    }
    collected.push(item.trim());
  }
  const out = sortThinkingLevels(collected);
  return out.length > 0 ? out : [...THINKING_LEVELS];
}

function normalizeStrengths(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(422, "invalid_args", "strengths must be an array of strings");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new HttpError(422, "invalid_args", "strengths must be an array of strings");
    }
    const tag = item.trim();
    if (tag.length === 0 || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}
