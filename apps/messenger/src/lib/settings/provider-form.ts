import {
  THINKING_LEVELS,
  isLocalEndpoint,
  isThinkingLevel,
  sortThinkingLevels,
  type ApiFormat,
  type CreateProviderRequest,
  type EndpointModel,
  type EndpointModelInput,
  type ModelPricing,
  type PatchProviderRequest,
  type ProbedModel,
  type ThinkingLevel,
} from "@real-bot/protocol";

export type ModelAttrDraft = {
  /** Raw text of the price field; empty means unset. */
  price: string;
  billingInput?: string;
  billingOutput?: string;
  billingCachedInput?: string;
  /** Levels this name supports; never empty in a draft the form produced. */
  thinkingLevels: ThinkingLevel[];
  strengths: string[];
  /** Whether it takes pictures (ADR 0049): true, false, or null for "not known" (clears a saved value); absent keeps what was saved. */
  inputImage?: boolean | null;
  /**
   * Raw text of the context window field, in tokens (ADR 0067): empty clears a saved one, absent
   * keeps what was saved. Filled from what a local model server said when the list was fetched.
   */
  contextWindow?: string;
  /** The speed on record (`stream_tps_p10`), shown beside the speed test; never sent back. */
  recordedTps?: number;
};

/** What a model server on this computer or network said about a model when the list was fetched (ADR 0067). */
export type ProbedFacts = Pick<ProbedModel, "context_window" | "input_image" | "tools">;

export type ProviderDraft = {
  name: string;
  baseUrl: string;
  /** Chat Completions or Anthropic Messages; decides the path, the key header and the request shape. */
  apiFormat: ApiFormat;
  apiKey: string;
  /** Enabled names, in the order they were picked. */
  models: string[];
  /** What the endpoint's `/models` last returned; saved with the provider so the picker survives reopening. */
  availableModels: string[];
  /** Thinking levels `/models` advertised per name; empty when that object did not say. */
  advertisedThinking: Record<string, ThinkingLevel[]>;
  /** What a local server said per name (window, pictures, tools); absent for a cloud endpoint. */
  probedFacts?: Record<string, ProbedFacts>;
  defaultModel: string;
  modelAttrs: Record<string, ModelAttrDraft>;
};

export type ProviderFieldErrors = {
  name?: "empty";
  endpoint?: "empty" | "invalid";
  endpointKey?: "empty";
  models?: "empty";
  pricing?: "invalid";
  contextWindow?: "invalid";
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
    apiFormat: "openai",
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
  const modelAttrs = pruneAttrs(draft.modelAttrs, models, draft.advertisedThinking, draft.probedFacts);
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
  const probedFacts = { ...draft.probedFacts };
  for (const row of catalog) {
    const facts = factsOf(row);
    if (facts) {
      const before = draft.probedFacts?.[row.name];
      probedFacts[row.name] = facts;
      const current = modelAttrs[row.name];
      if (current) modelAttrs[row.name] = withProbedFacts(current, facts, before);
    }
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
  return withSyncedDefaultModel({
    ...draft,
    availableModels,
    advertisedThinking,
    ...(Object.keys(probedFacts).length > 0 ? { probedFacts } : {}),
    models,
    modelAttrs,
  });
}

function factsOf(row: ProbedModel): ProbedFacts | null {
  const facts: ProbedFacts = {
    ...(row.context_window !== undefined ? { context_window: row.context_window } : {}),
    ...(row.input_image !== undefined ? { input_image: row.input_image } : {}),
    ...(row.tools !== undefined ? { tools: row.tools } : {}),
  };
  return Object.keys(facts).length > 0 ? facts : null;
}

/**
 * A model's attributes with what its server said filled in: the window where the field is empty or
 * still shows what the server said before, pictures where nothing was set. What you typed stays.
 */
function withProbedFacts(attr: ModelAttrDraft, facts: ProbedFacts, before?: ProbedFacts): ModelAttrDraft {
  let next = attr;
  const window = facts.context_window;
  const followsServer = attr.contextWindow === undefined || attr.contextWindow === "" ||
    (before?.context_window !== undefined && attr.contextWindow === String(before.context_window));
  if (window !== undefined && followsServer && attr.contextWindow !== String(window)) next = { ...next, contextWindow: String(window) };
  if (facts.input_image !== undefined && (attr.inputImage === undefined || attr.inputImage === null)) next = { ...next, inputImage: facts.input_image };
  return next;
}

/** Whether a context window field holds something other than nothing or a whole number of tokens. */
export function invalidContextWindow(attr: ModelAttrDraft | undefined): boolean {
  const raw = attr?.contextWindow?.trim() ?? "";
  if (raw.length === 0) return false;
  return !/^\d+$/.test(raw) || Number(raw) <= 0;
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
  // A model server on this computer or network answers without a key (ADR 0067).
  if (apiKey.length === 0 && !keySet && !isLocalEndpoint(baseUrl)) return null;
  return `${draft.apiFormat}\n${baseUrl}\n${apiKey}`;
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
    billingValues(attr).some((value) => value.length > 0) ||
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
  api_format?: ApiFormat;
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
      ...billingDraft(row.pricing),
      thinkingLevels: [...row.thinking_levels],
      strengths: [...row.strengths],
      ...(row.input_image !== undefined ? { inputImage: row.input_image } : {}),
      ...(row.context_window !== undefined ? { contextWindow: String(row.context_window) } : {}),
      ...(row.stream_tps_p10 !== undefined ? { recordedTps: row.stream_tps_p10 } : {}),
    };
  }
  return {
    name: input.name,
    baseUrl: input.base_url ?? "",
    apiFormat: input.api_format ?? "openai",
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
  // Left out for Chat Completions, which is what a daemon reads when none is given.
  if (draft.apiFormat !== "openai") body.api_format = draft.apiFormat;
  if (parsed.defaultModel) body.default_model = parsed.defaultModel;
  if (parsed.availableModels.length > 0) body.available_models = parsed.availableModels;
  return { ok: true, body };
}

export function planPatchProvider(
  current: {
    name: string;
    base_url: string | null;
    api_format?: ApiFormat;
    models: readonly string[];
    model_catalog?: readonly EndpointModel[];
    available_models?: readonly string[];
    default_model: string | null;
  },
  draft: ProviderDraft,
): ProviderPatchPlan {
  // An existing endpoint may keep an empty enabled list and no default. A new one already could.
  const parsed = parseProviderDraft(draft, false, { allowEmptyModels: true });
  if (!parsed.ok) return parsed;
  const patch: PatchProviderRequest = {};
  if (parsed.name !== current.name) patch.name = parsed.name;
  if (parsed.baseUrl !== (current.base_url ?? "")) patch.base_url = parsed.baseUrl;
  if (draft.apiFormat !== (current.api_format ?? "openai")) patch.api_format = draft.apiFormat;
  const currentCatalog = current.model_catalog ?? current.models.map(defaultCatalogItem);
  if (!sameCatalog(parsed.models, currentCatalog)) patch.models = parsed.models;
  if (!sameList(parsed.availableModels, current.available_models ?? [])) {
    patch.available_models = parsed.availableModels;
  }
  if (draft.apiKey.length > 0) patch.api_key = draft.apiKey;
  // Omitting default_model makes the daemon pick the first enabled name. Send "" whenever this
  // patch changes anything and the draft default is empty, including when the saved default is already empty.
  if (parsed.defaultModel !== (current.default_model ?? "")) {
    patch.default_model = parsed.defaultModel;
  } else if (parsed.defaultModel.length === 0 && Object.keys(patch).length > 0) {
    patch.default_model = "";
  }
  return { ok: true, patch };
}

/**
 * The format a probe names: the draft's when it is not what the daemon would read by itself (the
 * saved endpoint's, or Chat Completions for a new one), so a daemon from before formats still takes
 * every probe a Chat Completions endpoint makes.
 */
export function probeFormat(draft: ProviderDraft, saved: ApiFormat | undefined): ApiFormat | undefined {
  return draft.apiFormat !== (saved ?? "openai") || draft.apiFormat !== "openai" ? draft.apiFormat : undefined;
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
      models: EndpointModelInput[];
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
  if (requireKey && draft.apiKey.length === 0 && !isLocalEndpoint(baseUrl)) errors.endpointKey = "empty";
  if (names.length === 0 && !options.allowEmptyModels) errors.models = "empty";
  if (defaultModel.length === 0) {
    if (!options.allowEmptyModels) errors.defaultModel = "empty";
  } else if (!names.includes(defaultModel)) errors.defaultModel = "invalid";
  if (names.some((name) => invalidBilling(draft.modelAttrs[name]))) errors.pricing = "invalid";
  if (names.some((name) => invalidContextWindow(draft.modelAttrs[name]))) errors.contextWindow = "invalid";
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const models = names.map((modelName) => requestItemFromAttr(modelName, draft.modelAttrs[modelName]));
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

/** The entry as saved: as `catalogFromAttr` reads it, plus a null that clears "takes pictures" when set back to not known. */
function requestItemFromAttr(name: string, attr: ModelAttrDraft | undefined): EndpointModelInput {
  const row: EndpointModelInput = catalogFromAttr(name, attr);
  return {
    ...row,
    ...(attr?.inputImage === null ? { input_image: null } : {}),
    // An emptied window field clears the saved one; a field never shown leaves it as it was.
    ...(attr?.contextWindow !== undefined && attr.contextWindow.trim() === "" ? { context_window: null } : {}),
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
    ...billingCatalog(source),
    thinking_levels: levels.length > 0 ? levels : [...THINKING_LEVELS],
    strengths: uniqueTags(source.strengths),
    ...(typeof source.inputImage === "boolean" ? { input_image: source.inputImage } : {}),
    ...(windowOf(source) !== undefined ? { context_window: windowOf(source) } : {}),
  };
}

function windowOf(attr: ModelAttrDraft): number | undefined {
  const raw = attr.contextWindow?.trim() ?? "";
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : undefined;
}

function billingValues(attr: ModelAttrDraft | undefined): string[] {
  return [attr?.billingInput ?? "", attr?.billingOutput ?? "", attr?.billingCachedInput ?? ""].map((value) => value.trim());
}

export function invalidBilling(attr: ModelAttrDraft | undefined): boolean {
  const values = billingValues(attr);
  if (values.every((value) => !value)) return false;
  if (!values[0] || !values[1]) return true;
  return values.some((value) => value.length > 0 && (!Number.isFinite(Number(value)) || Number(value) < 0));
}

function billingCatalog(attr: ModelAttrDraft): { pricing?: ModelPricing } {
  const [input, output, cached] = billingValues(attr);
  if (!input || !output || invalidBilling(attr)) return {};
  return { pricing: { input: Number(input), output: Number(output), ...(cached ? { cached_input: Number(cached) } : {}) } };
}

function billingDraft(pricing: ModelPricing | undefined): Partial<ModelAttrDraft> {
  if (!pricing) return {};
  return { billingInput: String(pricing.input), billingOutput: String(pricing.output),
    billingCachedInput: pricing.cached_input == null ? "" : String(pricing.cached_input) };
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
  facts?: Record<string, ProbedFacts>,
): Record<string, ModelAttrDraft> {
  const next: Record<string, ModelAttrDraft> = {};
  for (const name of names) {
    const said = facts?.[name];
    next[name] = attrs[name] ?? (said ? withProbedFacts(attrFromAdvertised(advertised?.[name]), said) : attrFromAdvertised(advertised?.[name]));
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
        ...(row.context_window !== undefined ? { context_window: row.context_window } : {}),
        ...(row.input_image !== undefined ? { input_image: row.input_image } : {}),
        ...(row.tools !== undefined ? { tools: row.tools } : {}),
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
    ...billingDraft(item.pricing),
    thinkingLevels: [...(item.thinking_levels ?? THINKING_LEVELS)],
    strengths: [...(item.strengths ?? [])],
    ...(typeof item.input_image === "boolean" ? { inputImage: item.input_image } : {}),
    ...(typeof item.context_window === "number" ? { contextWindow: String(item.context_window) } : {}),
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
      left.pricing?.input === right.pricing?.input &&
      left.pricing?.output === right.pricing?.output &&
      left.pricing?.cached_input === right.pricing?.cached_input &&
      sameList(left.thinking_levels, right.thinking_levels) &&
      sameList(left.strengths, right.strengths) &&
      left.input_image === (right.input_image ?? undefined) &&
      left.context_window === (right.context_window ?? undefined)
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
