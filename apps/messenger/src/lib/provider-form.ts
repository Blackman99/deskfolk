import {
  THINKING_LEVELS,
  type CreateProviderRequest,
  type EndpointModel,
  type EndpointModelInput,
  type PatchProviderRequest,
  type ThinkingLevel,
} from "@real-bot/protocol";
import { parseModelLines } from "./wizard-save.ts";

export type ModelAttrDraft = {
  price: string;
  thinkingLevels: string;
  strengths: string;
};

export type ProviderDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelsText: string;
  defaultModel: string;
  modelAttrs: Record<string, ModelAttrDraft>;
};

export type ProviderFieldErrors = {
  name?: "empty";
  endpoint?: "empty" | "invalid";
  endpointKey?: "empty";
  models?: "empty";
  defaultModel?: "empty" | "invalid";
};

export type ProviderSavePlan =
  | { ok: true; body: CreateProviderRequest }
  | { ok: false; errors: ProviderFieldErrors };

export type ProviderPatchPlan =
  | { ok: true; patch: PatchProviderRequest }
  | { ok: false; errors: ProviderFieldErrors };

export function emptyModelAttr(): ModelAttrDraft {
  return { price: "", thinkingLevels: THINKING_LEVELS.join(", "), strengths: "" };
}

export function emptyProviderDraft(): ProviderDraft {
  return { name: "", baseUrl: "", apiKey: "", modelsText: "", defaultModel: "", modelAttrs: {} };
}

export function withSyncedDefaultModel(draft: ProviderDraft): ProviderDraft {
  const models = parseModelLines(draft.modelsText);
  const modelAttrs = pruneAttrs(draft.modelAttrs, models);
  const next = { ...draft, modelAttrs };
  if (next.defaultModel && models.includes(next.defaultModel)) return next;
  if (models[0]) return { ...next, defaultModel: models[0] };
  if (!next.defaultModel) return next;
  return { ...next, defaultModel: "" };
}

export function applyProbedModels(draft: ProviderDraft, models: string[]): ProviderDraft {
  const current = parseModelLines(draft.modelsText);
  const matching = current.filter((m) => models.includes(m));
  const nextSelected = matching.length > 0 ? matching : models.slice(0, 3);
  return withSyncedDefaultModel({
    ...draft,
    modelsText: nextSelected.join("\n"),
    defaultModel: nextSelected.includes(draft.defaultModel)
      ? draft.defaultModel
      : (nextSelected[0] ?? ""),
  });
}

export function providerHost(baseUrl: string | null | undefined): string {
  const raw = (baseUrl ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

export function draftFromProvider(input: {
  name: string;
  base_url: string | null;
  models: readonly string[];
  model_catalog?: readonly EndpointModel[];
  default_model: string | null;
}): ProviderDraft {
  const catalog = input.model_catalog ?? input.models.map(defaultCatalogItem);
  const modelAttrs: Record<string, ModelAttrDraft> = {};
  for (const row of catalog) {
    modelAttrs[row.name] = {
      price: row.price == null ? "" : String(row.price),
      thinkingLevels: row.thinking_levels.join(", "),
      strengths: row.strengths.join(", "),
    };
  }
  return {
    name: input.name,
    baseUrl: input.base_url ?? "",
    apiKey: "",
    modelsText: input.models.join("\n"),
    defaultModel: input.default_model ?? "",
    modelAttrs,
  };
}

export function planCreateProvider(draft: ProviderDraft, requireKey: boolean): ProviderSavePlan {
  const parsed = parseProviderDraft(draft, requireKey);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    body: {
      name: parsed.name,
      base_url: parsed.baseUrl,
      api_key: parsed.apiKey || undefined,
      models: parsed.models,
      default_model: parsed.defaultModel,
    },
  };
}

export function planPatchProvider(
  current: {
    name: string;
    base_url: string | null;
    models: readonly string[];
    model_catalog?: readonly EndpointModel[];
    default_model: string | null;
  },
  draft: ProviderDraft,
): ProviderPatchPlan {
  const parsed = parseProviderDraft(draft, false);
  if (!parsed.ok) return parsed;
  const patch: PatchProviderRequest = {};
  if (parsed.name !== current.name) patch.name = parsed.name;
  if (parsed.baseUrl !== (current.base_url ?? "")) patch.base_url = parsed.baseUrl;
  const currentCatalog = current.model_catalog ?? current.models.map(defaultCatalogItem);
  if (!sameCatalog(parsed.models, currentCatalog)) patch.models = parsed.models;
  if (parsed.defaultModel !== (current.default_model ?? "")) patch.default_model = parsed.defaultModel;
  if (draft.apiKey.length > 0) patch.api_key = draft.apiKey;
  return { ok: true, patch };
}

export function mapProviderError(message: string): ProviderFieldErrors | { top: true } {
  if (message === "name is required") return { name: "empty" };
  if (message === "endpoint_base_url cannot be empty") return { endpoint: "empty" };
  if (message.startsWith("endpoint_base_url")) return { endpoint: "invalid" };
  if (message.startsWith("endpoint_models")) return { models: "empty" };
  if (message.startsWith("endpoint_default_model")) return { defaultModel: "invalid" };
  if (message.startsWith("api_key")) return { endpointKey: "empty" };
  return { top: true };
}

export function modelSelectValue(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

export function parseModelSelectValue(raw: string): { provider_id: string | null; model: string } {
  const trimmed = raw.trim();
  const i = trimmed.indexOf("::");
  if (i <= 0) return { provider_id: null, model: trimmed };
  return { provider_id: trimmed.slice(0, i), model: trimmed.slice(i + 2).trim() };
}

function parseProviderDraft(
  draft: ProviderDraft,
  requireKey: boolean,
):
  | { ok: true; name: string; baseUrl: string; apiKey: string; models: EndpointModelInput[]; defaultModel: string }
  | { ok: false; errors: ProviderFieldErrors } {
  const name = draft.name.trim();
  const baseUrl = draft.baseUrl.trim();
  const names = parseModelLines(draft.modelsText);
  const defaultModel = draft.defaultModel.trim();
  const errors: ProviderFieldErrors = {};
  if (name.length === 0) errors.name = "empty";
  if (baseUrl.length === 0) errors.endpoint = "empty";
  else if (!isHttpOrHttpsUrl(baseUrl)) errors.endpoint = "invalid";
  if (requireKey && draft.apiKey.length === 0) errors.endpointKey = "empty";
  if (names.length === 0) errors.models = "empty";
  if (defaultModel.length === 0) errors.defaultModel = "empty";
  else if (names.length > 0 && !names.includes(defaultModel)) errors.defaultModel = "invalid";
  if (errors.name || errors.endpoint || errors.endpointKey || errors.models || errors.defaultModel) {
    return { ok: false, errors };
  }
  const models = names.map((modelName) => catalogFromAttr(modelName, draft.modelAttrs[modelName]));
  return { ok: true, name, baseUrl, apiKey: draft.apiKey, models, defaultModel };
}

function catalogFromAttr(name: string, attr: ModelAttrDraft | undefined): EndpointModel {
  const source = attr ?? emptyModelAttr();
  const priceRaw = source.price.trim();
  const price = priceRaw.length === 0 ? null : Number(priceRaw);
  return {
    name,
    price: price != null && Number.isFinite(price) && price >= 0 ? price : null,
    thinking_levels: parseThinkingLevels(source.thinkingLevels),
    strengths: parseTags(source.strengths),
  };
}

function parseThinkingLevels(raw: string): ThinkingLevel[] {
  const out: ThinkingLevel[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,/\s]+/)) {
    const item = part.trim();
    if (!isThinkingLevel(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length > 0 ? out : [...THINKING_LEVELS];
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

function parseTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,/\n]+/)) {
    const tag = part.trim();
    if (tag.length === 0 || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

function pruneAttrs(
  attrs: Record<string, ModelAttrDraft>,
  names: readonly string[],
): Record<string, ModelAttrDraft> {
  const keep = new Set(names);
  const next: Record<string, ModelAttrDraft> = {};
  for (const name of names) {
    next[name] = attrs[name] ?? emptyModelAttr();
  }
  for (const [name, value] of Object.entries(attrs)) {
    if (keep.has(name)) next[name] = value;
  }
  return next;
}

function defaultCatalogItem(name: string): EndpointModel {
  return {
    name,
    price: null,
    thinking_levels: [...THINKING_LEVELS],
    strengths: [],
  };
}

function sameCatalog(a: readonly EndpointModelInput[], b: readonly EndpointModel[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const left = typeof item === "string" ? defaultCatalogItem(item) : catalogFromAttr(item.name, {
      price: item.price == null ? "" : String(item.price),
      thinkingLevels: (item.thinking_levels ?? THINKING_LEVELS).join(", "),
      strengths: (item.strengths ?? []).join(", "),
    });
    const right = b[i]!;
    return (
      left.name === right.name &&
      left.price === right.price &&
      sameList(left.thinking_levels, right.thinking_levels) &&
      sameList(left.strengths, right.strengths)
    );
  });
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function isHttpOrHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
