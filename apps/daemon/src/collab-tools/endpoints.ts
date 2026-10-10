/** Endpoint and model tools. */
import { BUILTIN_MODEL_ROLES, isBuiltinModelRole, isLadderAgentRung, isLocalEndpoint, isReaderAgentModel, type ApiFormat, type BuiltinModelRole, type BuiltinModels, type ModelLadderAgentRung, type ModelLadderRung, type Provider, type ReaderEndpointModel, type ReaderModel } from "@real-bot/protocol";
import { runCollabTool, type ToolCtx, type ToolResult } from "../collab-tools";
import { HttpError } from "../errors";
import { normalizeModelCatalog } from "../models";
import type { Store } from "../store";
import { resolveApiFormat, resolveWorkspaceId } from "../store/shared";
import { toolFail as fail } from "../tool-result";
import { optionalString, requireString } from "./args";
import { assertActive, mutateConfiguration } from "./guards";
import { botPinEmits, snapshotBotPins } from "./roster";

const DEFAULT_ENDPOINT_GUARD =
  "cannot modify the default endpoint's URL, API format, workspace or key, or delete it";

export async function listEndpoints(ctx: ToolCtx): Promise<ToolResult> {
  const providers = await ctx.store.listProviders();
  const defaultId = ctx.store.defaultProviderId();
  return {
    ok: true,
    data: {
      endpoints: providers.map((provider) => serializeEndpoint(provider, defaultId)),
      ...modelSettingsView(ctx.store, await ctx.store.settings()),
    },
    emitted: [],
  };
}

/** The app-wide model settings as the Bot's tools name them: endpoint ids, not provider ids. */
function modelSettingsView(store: Store, settings: { reader_model?: ReaderModel | null; organizer_model?: ReaderEndpointModel | null; builtin_models?: BuiltinModels }) {
  const organizer = settings.organizer_model ?? null;
  // A Claude model of the user's (ADR 0061) names no endpoint; it is the user's to set, so it is only shown.
  const view = (chosen: ReaderModel | null) => !chosen ? null
    : isReaderAgentModel(chosen) ? { runner: chosen.runner, model: chosen.model, config_dir: chosen.config_dir }
      : { endpoint_id: chosen.provider_id, model: chosen.model };
  return {
    reader_model: view(settings.reader_model ?? null),
    organizer_model: organizer ? { endpoint_id: organizer.provider_id, model: organizer.model } : null,
    builtin_models: Object.fromEntries(BUILTIN_MODEL_ROLES.map((role) => [role, view(settings.builtin_models?.[role] ?? null)])),
    // A Claude rung (ADR 0076) is shown as the user set it: the Bot may keep, move or drop it, never add one.
    model_ladder: store.modelLadder().map((rung) => (isLadderAgentRung(rung) ? { runner: rung.runner, model: rung.model, effort: rung.effort, config_dir: rung.config_dir }
      : { endpoint_id: rung.provider_id, model: rung.model })),
  };
}

/** A `{ endpoint_id, model }` from a tool argument, as the store takes it. */
function endpointModelOf(value: unknown, field: string): { provider_id: string; model: string } {
  const row = value as { endpoint_id?: unknown; model?: unknown } | null;
  if (!row || typeof row !== "object" || typeof row.endpoint_id !== "string" || typeof row.model !== "string") {
    throw new HttpError(422, "invalid_args", `${field} must be { endpoint_id, model }`);
  }
  return { provider_id: row.endpoint_id, model: row.model };
}

/** The speed test of the model's settings (ADR 0067), run by a Bot. */
export async function measureModelTool(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const endpointId = requireString(args.endpoint_id, "endpoint_id");
  const model = requireString(args.model, "model");
  if (!ctx.measure) return fail("failed", "measuring a model needs the app's engine; it is not available here");
  const speed = await ctx.measure(endpointId, model, ctx.signal ?? new AbortController().signal);
  assertActive(ctx);
  const provider = await ctx.store.getProvider(endpointId);
  return { ok: true, data: { ...speed }, emitted: speed.recorded_tps ? [{ kind: "provider", provider }] : [] };
}

/**
 * The default endpoint, the reading model, the organizing model (ADR 0075) and the model ladder (ADR 0014, 2026-10-08). They choose
 * among endpoints and models you already configured, so they run at once, as changing one
 * endpoint's default model does: no key or URL goes anywhere new. Validated as one change — the
 * ladder and the settings are written in one transaction, or neither.
 */
export async function updateModelSettings(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const given = (key: string) => args[key] !== undefined;
  if (!given("default_endpoint_id") && !given("reader_model") && !given("organizer_model") && !given("builtin_models") && !given("model_ladder")) {
    throw new HttpError(422, "invalid_args", "give default_endpoint_id, reader_model, organizer_model, builtin_models or model_ladder");
  }
  const patch: {
    default_provider_id?: string;
    reader_model?: { provider_id: string; model: string } | null;
    organizer_model?: { provider_id: string; model: string } | null;
    builtin_models?: Partial<Record<BuiltinModelRole, { provider_id: string; model: string } | null>>;
  } = {};
  if (given("default_endpoint_id")) {
    const id = requireString(args.default_endpoint_id, "default_endpoint_id");
    const provider = await ctx.store.getProvider(id);
    // An endpoint the app cannot call would leave every unpinned Bot with nothing to run on.
    if (!provider.key_set && !isLocalEndpoint(provider.base_url)) {
      throw new HttpError(409, "conflict", "that endpoint has no key yet; the user adds it in Settings");
    }
    if (provider.models.length === 0) throw new HttpError(409, "conflict", "that endpoint lists no models yet");
    patch.default_provider_id = id;
  }
  // Only the user spends their Claude plan on a reading, as only the user moves a Bot onto it.
  const readerArg = args.reader_model as { runner?: unknown } | null | undefined;
  if (readerArg && typeof readerArg === "object" && "runner" in readerArg) {
    throw new HttpError(403, "forbidden", "only the user can choose a Claude model to read lines; it spends their Claude plan");
  }
  if (given("reader_model")) patch.reader_model = args.reader_model === null ? null : endpointModelOf(args.reader_model, "reader_model");
  // The organizing model is an endpoint's only, so a Claude shape falls through to the same refusal as any wrong one.
  if (given("organizer_model")) patch.organizer_model = args.organizer_model === null ? null : endpointModelOf(args.organizer_model, "organizer_model");
  if (given("builtin_models")) {
    const named = args.builtin_models;
    if (!named || typeof named !== "object" || Array.isArray(named)) throw new HttpError(422, "invalid_args", "builtin_models must be an object of call → { endpoint_id, model } or null");
    patch.builtin_models = {};
    for (const [role, value] of Object.entries(named as Record<string, unknown>)) {
      if (!isBuiltinModelRole(role)) throw new HttpError(422, "invalid_args", `unknown built-in call: ${role}`);
      // Only the user spends their Claude plan on a built-in call (ADR 0077), as on a reading.
      if (value && typeof value === "object" && "runner" in value) {
        throw new HttpError(403, "forbidden", "only the user can choose a Claude model for a built-in call; it spends their Claude plan");
      }
      patch.builtin_models[role] = value === null ? null : endpointModelOf(value, `builtin_models.${role}`);
    }
  }
  let ladder: ModelLadderRung[] | undefined;
  if (given("model_ladder")) {
    if (!Array.isArray(args.model_ladder)) throw new HttpError(422, "invalid_args", "model_ladder must be a list of { endpoint_id, model }");
    const current = ctx.store.modelLadder();
    ladder = args.model_ladder.map((rung) => {
      if (!rung || typeof rung !== "object" || !("runner" in rung)) return endpointModelOf(rung, "model_ladder");
      // Only the user puts their Claude plan on the ladder, as only the user moves a Bot onto it: one already there may stay.
      const named = rung as ModelLadderAgentRung;
      const kept = current.find((existing) => isLadderAgentRung(existing) && existing.model === named.model
        && existing.effort === (named.effort ?? null) && existing.config_dir === (named.config_dir ?? null));
      if (!kept) throw new HttpError(403, "forbidden", "only the user can put a Claude model on the ladder; it spends their Claude plan");
      return kept;
    });
  }
  const previousBots = snapshotBotPins(ctx.store);
  const settings = await mutateConfiguration(ctx, () => {
    if (ladder) ctx.store.setModelLadder(ladder);
    // The ladder alone changes no setting.
    return Object.keys(patch).length > 0 ? ctx.store.patchSettingsSync(patch) : ctx.store.settingsCached();
  });
  return {
    ok: true,
    data: { default_endpoint_id: settings.default_provider_id, ...modelSettingsView(ctx.store, settings) },
    emitted: [{ kind: "settings" }, ...botPinEmits(ctx.store, previousBots)],
  };
}

export async function addEndpoint(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const name = requireString(args.name, "name");
  const baseUrl = requireString(args.base_url, "base_url");
  const apiFormat = args.api_format === undefined ? "openai" : resolveApiFormat(args.api_format);
  const workspaceId = args.workspace_id === undefined ? null : resolveWorkspaceId(args.workspace_id);
  const models = args.models === undefined ? undefined : args.models;
  const defaultModel = optionalString(args.default_model);
  if (!ctx.approved) {
    const catalog = models === undefined ? [] : normalizeModelCatalog(models);
    return {
      ok: false,
      waitApproval: {
        kind_key: "endpoint-add",
        target: baseUrl,
        summary: endpointAddSummary(name, baseUrl, apiFormat, workspaceId, catalog.map((row) => row.name)),
        // A model server on this computer or network may take none (ADR 0067); the card still offers the field.
        requiresApiKey: !isLocalEndpoint(baseUrl),
        run: (opts) =>
          runCollabTool({ ...ctx, approved: true, approvalApiKey: opts?.api_key }, "add_endpoint", args),
      },
      emitted: [],
    };
  }
  const apiKey = ctx.approvalApiKey?.trim() ?? "";
  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    throw new HttpError(422, "invalid_args", "api_key is required");
  }
  const previousBots = snapshotBotPins(ctx.store);
  const provider = await mutateConfiguration(ctx, () => ctx.store.createProviderSync({
    name,
    base_url: baseUrl,
    api_format: apiFormat,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(apiKey ? { api_key: apiKey } : {}),
    models: models === undefined ? undefined : (models as Provider["model_catalog"]),
    default_model: defaultModel,
  }));
  return {
    ok: true,
    data: serializeEndpoint(provider, ctx.store.defaultProviderId()),
    emitted: [{ kind: "provider", provider }, { kind: "settings" }, ...botPinEmits(ctx.store, previousBots)],
  };
}

export async function updateEndpoint(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const id = requireString(args.id, "id");
  const current = await ctx.store.getProvider(id);
  assertActive(ctx);
  const defaultId = ctx.store.defaultProviderId();
  const isDefault = defaultId === id;
  const nextName = args.name !== undefined ? requireString(args.name, "name") : undefined;
  const nextUrl = args.base_url !== undefined ? requireString(args.base_url, "base_url") : undefined;
  const urlChanging = nextUrl !== undefined && nextUrl !== (current.base_url ?? "");
  const nextFormat = args.api_format !== undefined ? resolveApiFormat(args.api_format) : undefined;
  // Another format sends the key to another path in another shape: as weighty as another URL.
  const formatChanging = nextFormat !== undefined && nextFormat !== (current.api_format ?? "openai");
  const nextWorkspace = args.workspace_id !== undefined ? resolveWorkspaceId(args.workspace_id) : undefined;
  // The workspace id picks whose workspace the key bills: as weighty as the URL the key goes to.
  const workspaceChanging = nextWorkspace !== undefined && nextWorkspace !== (current.workspace_id ?? null);
  const connectionChanging = urlChanging || formatChanging || workspaceChanging;
  if (connectionChanging && isDefault) {
    return fail("failed", DEFAULT_ENDPOINT_GUARD);
  }
  if (connectionChanging && !ctx.approved) {
    const catalog =
      args.models !== undefined ? normalizeModelCatalog(args.models) : current.model_catalog;
    const target = nextUrl ?? current.base_url ?? "";
    return {
      ok: false,
      waitApproval: {
        kind_key: "endpoint-edit",
        target,
        summary: endpointEditSummary(nextName ?? current.name, target, nextFormat ?? current.api_format ?? "openai", nextWorkspace !== undefined ? nextWorkspace : current.workspace_id ?? null, catalog.map((row) => row.name)),
        requiresApiKey: !current.key_set && !isLocalEndpoint(target),
        run: (opts) =>
          runCollabTool({ ...ctx, approved: true, approvalApiKey: opts?.api_key }, "update_endpoint", args),
      },
      emitted: [],
    };
  }
  if (connectionChanging) {
    const apiKey = ctx.approvalApiKey?.trim() ?? "";
    if (!current.key_set && !apiKey && !isLocalEndpoint(nextUrl ?? current.base_url)) {
      throw new HttpError(422, "invalid_args", "api_key is required");
    }
  }
  const patch: {
    name?: string;
    base_url?: string;
    api_format?: ApiFormat;
    workspace_id?: string | null;
    api_key?: string;
    models?: Provider["model_catalog"];
    default_model?: string | null;
  } = {};
  if (nextName !== undefined) patch.name = nextName;
  if (urlChanging) patch.base_url = nextUrl;
  if (formatChanging) patch.api_format = nextFormat;
  if (workspaceChanging) patch.workspace_id = nextWorkspace;
  if (args.models !== undefined) patch.models = args.models as Provider["model_catalog"];
  if (args.default_model !== undefined) {
    patch.default_model = optionalString(args.default_model) ?? null;
  }
  if (connectionChanging && ctx.approvalApiKey && ctx.approvalApiKey.trim().length > 0) {
    patch.api_key = ctx.approvalApiKey.trim();
  }
  const previousBots = snapshotBotPins(ctx.store);
  const provider = await mutateConfiguration(ctx, () => ctx.store.patchProviderSync(id, patch));
  return {
    ok: true,
    data: serializeEndpoint(provider, ctx.store.defaultProviderId()),
    emitted: [{ kind: "provider", provider }, { kind: "settings" }, ...botPinEmits(ctx.store, previousBots)],
  };
}

export async function deleteEndpoint(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const id = requireString(args.id, "id");
  await ctx.store.getProvider(id);
  assertActive(ctx);
  if (ctx.store.defaultProviderId() === id) {
    return fail("failed", DEFAULT_ENDPOINT_GUARD);
  }
  const previousBots = snapshotBotPins(ctx.store);
  await mutateConfiguration(ctx, () => ctx.store.deleteProviderSync(id));
  return {
    ok: true,
    data: { id },
    emitted: [{ kind: "provider_removed", id }, { kind: "settings" }, ...botPinEmits(ctx.store, previousBots)],
  };
}

function serializeEndpoint(provider: Provider, defaultId: string | null): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    api_format: provider.api_format ?? "openai",
    workspace_id: provider.workspace_id ?? null,
    key_set: provider.key_set,
    models: provider.models,
    model_catalog: provider.model_catalog,
    available_models: provider.available_models,
    default_model: provider.default_model,
    is_default: provider.id === defaultId,
  };
}

function endpointAddSummary(name: string, url: string, format: ApiFormat, workspaceId: string | null, models: string[]): string {
  const list = models.length > 0 ? models.join(", ") : "(none)";
  return `endpoint-add ${name}\n${url}${formatNote(format)}${workspaceNote(workspaceId)}\nmodels: ${list}`;
}

function endpointEditSummary(name: string, url: string, format: ApiFormat, workspaceId: string | null, models: string[]): string {
  const list = models.length > 0 ? models.join(", ") : "(none)";
  return `endpoint-edit ${name}\n${url}${formatNote(format)}${workspaceNote(workspaceId)}\nmodels: ${list}`;
}

/** The format beside the URL on an approval card; Chat Completions, as every endpoint was before, goes unsaid. */
function formatNote(format: ApiFormat): string {
  return format === "anthropic" ? " (Anthropic Messages)" : "";
}

/** The Anthropic workspace beside the URL on an approval card; none goes unsaid. */
function workspaceNote(workspaceId: string | null): string {
  return workspaceId ? ` [workspace ${workspaceId}]` : "";
}
