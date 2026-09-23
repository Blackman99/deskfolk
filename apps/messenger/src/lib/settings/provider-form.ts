import {
  THINKING_LEVELS,
  isThinkingLevel,
  sortThinkingLevels,
  type CreateProviderRequest,
  type EndpointModel,
  type EndpointModelInput,
  type PatchProviderRequest,
  type ProbedModel,
  type ThinkingLevel,
} from "@real-bot/protocol";

export type ModelAttrDraft = {
  /** Raw text of the price field; empty means unset. */
  price: string;
  /** Levels this name supports; never empty in a draft the form produced. */
  thinkingLevels: ThinkingLevel[];
  strengths: string[];
};

export type ProviderDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Enabled names, in the order they were picked. */
  models: string[];
  /** What the endpoint's `/models` last returned; saved with the provider so the picker survives reopening. */
  availableModels: string[];
  /** Thinking levels `/models` advertised per name; empty when that object did not say. */
  advertisedThinking: Record<string, ThinkingLevel[]>;
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

export const PRESET_STRENGTHS = ["code", "writing", "reasoning", "chat"] as const;

/** A probed list this short is enabled wholesale when nothing was picked yet. */
export const AUTO_ENABLE_MAX = 3;

export function emptyModelAttr(): ModelAttrDraft {
  return { price: "", thinkingLevels: [...THINKING_LEVELS], strengths: [] };
}

/**
 * The one endpoint editor that can be open. Adding and editing are the same form, so they share a
 * shape; `target` says which, and the shell keeps it so its Escape cascade can see the flyout.
 */
export type ProviderEditorState = {
  /** `"add"`, or the id of the endpoint being edited. */
  target: "add" | string;
  /**
   * Which layer of the editor is showing. `connection` is the name, URL and key; `models` is the
   * enable list and per-model attributes. The default model is picked on the list, not here.
   */
  view: "connection" | "models";
  draft: ProviderDraft;
  errors: ProviderFieldErrors;
  failed: boolean;
  fetching: boolean;
  fetchError: string | null;
};

export function emptyProviderDraft(): ProviderDraft {
  return {
    name: "",
    baseUrl: "",
    apiKey: "",
    models: [],
    availableModels: [],
    defaultModel: "",
    advertisedThinking: {},
    modelAttrs: {},
  };
}

export function withSyncedDefaultModel(draft: ProviderDraft): ProviderDraft {
  const models = uniqueNames(draft.models);
  const modelAttrs = pruneAttrs(draft.modelAttrs, models, draft.advertisedThinking);
  const next = { ...draft, models, modelAttrs };
  if (next.defaultModel && models.includes(next.defaultModel)) return next;
  if (!next.defaultModel) return next;
  return { ...next, defaultModel: "" };
}

/**
 * Records what the endpoint returned. Enabled names are kept as they are; only when nothing is
 * enabled yet and the list is short does the whole list get enabled. Advertised thinking levels
 * fill in a name that still has the fallback four (or last followed the previous advertisement);
 * a hand-edited list is left alone.
 */
export function applyProbedModels(
  draft: ProviderDraft,
  probed: readonly string[] | { models?: readonly string[]; catalog?: readonly ProbedModel[] },
): ProviderDraft {
  const catalog = probedCatalog(probed);
  const availableModels = uniqueNames(catalog.map((row) => row.name));
  const advertisedThinking = { ...draft.advertisedThinking };
  const modelAttrs = { ...draft.modelAttrs };
  for (const row of catalog) {
    if (row.thinking_levels.length === 0) continue;
    advertisedThinking[row.name] = [...row.thinking_levels];
    const current = modelAttrs[row.name];
    if (!current) continue;
    if (!followsAdvertisedThinking(current, draft.advertisedThinking[row.name])) continue;
    modelAttrs[row.name] = { ...current, thinkingLevels: [...row.thinking_levels] };
  }
  const models =
    draft.models.length === 0 && availableModels.length > 0 && availableModels.length <= AUTO_ENABLE_MAX
      ? [...availableModels]
      : draft.models;
  return withSyncedDefaultModel({ ...draft, availableModels, advertisedThinking, models, modelAttrs });
}

/** Rows the picker shows: the probed list in endpoint order, then enabled names the endpoint did not list. */
export function pickerModels(draft: ProviderDraft): string[] {
  return uniqueNames([...draft.availableModels, ...draft.models]);
}

export function toggleDraftModel(draft: ProviderDraft, name: string): ProviderDraft {
  const models = draft.models.includes(name)
    ? draft.models.filter((item) => item !== name)
    : [...draft.models, name];
  return withSyncedDefaultModel({ ...draft, models });
}

export function setDraftModels(draft: ProviderDraft, names: readonly string[]): ProviderDraft {
  return withSyncedDefaultModel({ ...draft, models: [...names] });
}

/** Adds a name typed by hand; returns the same draft when the input is blank or already enabled. */
export function addDraftModel(draft: ProviderDraft, raw: string): ProviderDraft {
  const name = raw.trim();
  if (name.length === 0 || draft.models.includes(name)) return draft;
  return withSyncedDefaultModel({ ...draft, models: [...draft.models, name] });
}

/**
 * Whether the draft has enough to ask the endpoint for its models. The value doubles as a
 * signature: a probe is repeated only when it changes.
 */
export function probeSignature(draft: ProviderDraft, keySet: boolean): string | null {
  const baseUrl = draft.baseUrl.trim();
  if (!isHttpOrHttpsUrl(baseUrl)) return null;
  const apiKey = draft.apiKey.trim();
  if (apiKey.length === 0 && !keySet) return null;
  return `${baseUrl}\n${apiKey}`;
}

/** Toggles a level, keeping at least one so a name never claims to support nothing. */
export function toggleAttrThinkingLevel(attr: ModelAttrDraft, level: ThinkingLevel): ModelAttrDraft {
  const wanted = level.trim();
  if (!isThinkingLevel(wanted)) return attr;
  if (attr.thinkingLevels.some((item) => item.toLowerCase() === wanted.toLowerCase())) {
    if (attr.thinkingLevels.length === 1) return attr;
    return {
      ...attr,
      thinkingLevels: attr.thinkingLevels.filter((item) => item.toLowerCase() !== wanted.toLowerCase()),
    };
  }
  return { ...attr, thinkingLevels: sortThinkingLevels([...attr.thinkingLevels, wanted]) };
}

/** Adds a level typed by hand; already-present names (any case) are left alone. */
export function addAttrThinkingLevel(attr: ModelAttrDraft, raw: string): ModelAttrDraft {
  const level = raw.trim();
  if (!isThinkingLevel(level)) return attr;
  if (attr.thinkingLevels.some((item) => item.toLowerCase() === level.toLowerCase())) return attr;
  return { ...attr, thinkingLevels: sortThinkingLevels([...attr.thinkingLevels, level]) };
}

/** Chips for a name: the fallback four, what the endpoint advertised, and anything already ticked. */
export function thinkingChipOptions(
  attr: ModelAttrDraft,
  advertised: readonly string[] | undefined,
): ThinkingLevel[] {
  return sortThinkingLevels([...THINKING_LEVELS, ...(advertised ?? []), ...attr.thinkingLevels]);
}

export function toggleAttrStrength(attr: ModelAttrDraft, tag: string): ModelAttrDraft {
  const wanted = tag.trim();
  if (wanted.length === 0) return attr;
  const key = wanted.toLowerCase();
  if (attr.strengths.some((item) => item.toLowerCase() === key)) {
    return { ...attr, strengths: attr.strengths.filter((item) => item.toLowerCase() !== key) };
  }
  return { ...attr, strengths: [...attr.strengths, wanted] };
}

/** Adds a tag typed by hand; already-present tags (any case) are left alone. */
export function addAttrStrength(attr: ModelAttrDraft, raw: string): ModelAttrDraft {
  const tag = raw.trim();
  if (tag.length === 0) return attr;
  const key = tag.toLowerCase();
  if (attr.strengths.some((item) => item.toLowerCase() === key)) return attr;
  return { ...attr, strengths: [...attr.strengths, tag] };
}

export function hasCustomAttrs(attr: ModelAttrDraft, advertised?: readonly string[]): boolean {
  const baseline = advertised && advertised.length > 0 ? advertised : THINKING_LEVELS;
  return (
    attr.price.trim().length > 0 ||
    !sameList(attr.thinkingLevels, baseline) ||
    attr.strengths.length > 0
  );
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
  available_models?: readonly string[];
  default_model: string | null;
}): ProviderDraft {
  const catalog = input.model_catalog ?? input.models.map(defaultCatalogItem);
  const modelAttrs: Record<string, ModelAttrDraft> = {};
  for (const row of catalog) {
    modelAttrs[row.name] = {
      price: row.price == null ? "" : String(row.price),
      thinkingLevels: [...row.thinking_levels],
      strengths: [...row.strengths],
    };
  }
  return {
    name: input.name,
    baseUrl: input.base_url ?? "",
    apiKey: "",
    models: [...input.models],
    availableModels: [...(input.available_models ?? [])],
    advertisedThinking: {},
    defaultModel: input.default_model ?? "",
    modelAttrs,
  };
}

export function planCreateProvider(draft: ProviderDraft, requireKey: boolean): ProviderSavePlan {
  // A new endpoint starts as a connection. The model list and its default are chosen afterwards.
  const parsed = parseProviderDraft(draft, requireKey, { allowEmptyModels: true });
  if (!parsed.ok) return parsed;
  const body: CreateProviderRequest = {
    name: parsed.name,
    base_url: parsed.baseUrl,
    api_key: parsed.apiKey || undefined,
    models: parsed.models,
  };
  if (parsed.defaultModel) body.default_model = parsed.defaultModel;
  if (parsed.availableModels.length > 0) body.available_models = parsed.availableModels;
  return { ok: true, body };
}

export function planPatchProvider(
  current: {
    name: string;
    base_url: string | null;
    models: readonly string[];
    model_catalog?: readonly EndpointModel[];
    available_models?: readonly string[];
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
  if (!sameList(parsed.availableModels, current.available_models ?? [])) {
    patch.available_models = parsed.availableModels;
  }
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
  options: { allowEmptyModels?: boolean } = {},
):
  | {
      ok: true;
      name: string;
      baseUrl: string;
      apiKey: string;
      models: EndpointModel[];
      availableModels: string[];
      defaultModel: string;
    }
  | { ok: false; errors: ProviderFieldErrors } {
  const name = draft.name.trim();
  const baseUrl = draft.baseUrl.trim();
  const names = uniqueNames(draft.models);
  const defaultModel = draft.defaultModel.trim();
  const errors: ProviderFieldErrors = {};
  if (name.length === 0) errors.name = "empty";
  if (baseUrl.length === 0) errors.endpoint = "empty";
  else if (!isHttpOrHttpsUrl(baseUrl)) errors.endpoint = "invalid";
  if (requireKey && draft.apiKey.length === 0) errors.endpointKey = "empty";
  if (names.length === 0 && !options.allowEmptyModels) errors.models = "empty";
  if (defaultModel.length === 0) {
    if (!options.allowEmptyModels) errors.defaultModel = "empty";
  } else if (!names.includes(defaultModel)) errors.defaultModel = "invalid";
  if (errors.name || errors.endpoint || errors.endpointKey || errors.models || errors.defaultModel) {
    return { ok: false, errors };
  }
  const models = names.map((modelName) => catalogFromAttr(modelName, draft.modelAttrs[modelName]));
  return {
    ok: true,
    name,
    baseUrl,
    apiKey: draft.apiKey,
    models,
    availableModels: uniqueNames(draft.availableModels),
    defaultModel,
  };
}

function catalogFromAttr(name: string, attr: ModelAttrDraft | undefined): EndpointModel {
  const source = attr ?? emptyModelAttr();
  const priceRaw = source.price.trim();
  const price = priceRaw.length === 0 ? null : Number(priceRaw);
  const levels = sortThinkingLevels(source.thinkingLevels.filter((level) => isThinkingLevel(level)));
  return {
    name,
    price: price != null && Number.isFinite(price) && price >= 0 ? price : null,
    thinking_levels: levels.length > 0 ? levels : [...THINKING_LEVELS],
    strengths: uniqueTags(source.strengths),
  };
}

function uniqueNames(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function uniqueTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length === 0 || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

function pruneAttrs(
  attrs: Record<string, ModelAttrDraft>,
  names: readonly string[],
  advertised: Record<string, ThinkingLevel[]> | undefined,
): Record<string, ModelAttrDraft> {
  const next: Record<string, ModelAttrDraft> = {};
  for (const name of names) {
    next[name] = attrs[name] ?? attrFromAdvertised(advertised?.[name]);
  }
  return next;
}

function attrFromAdvertised(advertised: readonly string[] | undefined): ModelAttrDraft {
  if (advertised && advertised.length > 0) {
    return { price: "", thinkingLevels: [...advertised], strengths: [] };
  }
  return emptyModelAttr();
}

function followsAdvertisedThinking(
  attr: ModelAttrDraft,
  previousAdvertised: readonly string[] | undefined,
): boolean {
  if (attr.thinkingLevels.length === 0 || sameList(attr.thinkingLevels, THINKING_LEVELS)) return true;
  return Boolean(
    previousAdvertised && previousAdvertised.length > 0 && sameList(attr.thinkingLevels, previousAdvertised),
  );
}

function probedCatalog(
  probed: readonly string[] | { models?: readonly string[]; catalog?: readonly ProbedModel[] },
): ProbedModel[] {
  if (Array.isArray(probed)) {
    return uniqueNames(probed).map((name) => ({ name, thinking_levels: [] }));
  }
  const obj = probed as { models?: readonly string[]; catalog?: readonly ProbedModel[] };
  const catalog = obj.catalog ?? [];
  if (catalog.length > 0) {
    const out: ProbedModel[] = [];
    const seen = new Set<string>();
    for (const row of catalog) {
      const name = row.name.trim();
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        thinking_levels: sortThinkingLevels(row.thinking_levels.filter((level: string) => isThinkingLevel(level))),
      });
    }
    return out;
  }
  return uniqueNames(obj.models ?? []).map((name) => ({ name, thinking_levels: [] }));
}

function defaultCatalogItem(name: string): EndpointModel {
  return {
    name,
    price: null,
    thinking_levels: [...THINKING_LEVELS],
    strengths: [],
  };
}

function catalogItemFromInput(item: EndpointModelInput): EndpointModel {
  if (typeof item === "string") return defaultCatalogItem(item);
  return catalogFromAttr(item.name, {
    price: item.price == null ? "" : String(item.price),
    thinkingLevels: [...(item.thinking_levels ?? THINKING_LEVELS)],
    strengths: [...(item.strengths ?? [])],
  });
}

function sameCatalog(a: readonly EndpointModelInput[], b: readonly EndpointModel[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const left = catalogItemFromInput(item);
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
