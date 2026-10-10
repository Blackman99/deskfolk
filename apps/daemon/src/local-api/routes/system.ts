import { isBotRunner, isLocalEndpoint, LOCAL_API_BIND, type ApiFormat, type CreateProviderRequest, type PatchProviderRequest, type RuntimeResponse } from "@real-bot/protocol";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_USAGE_REFRESH_MIN_MS } from "../../claude-code/usage";
import type { OtherRunner } from "../../agents/status";
import { AGENT_USAGE_REFRESH_MIN_MS } from "../../agents/usage";
import { HttpError } from "../../errors";
import { listHostDir } from "../../host-paths";
import { emptyResponse, jsonResponse, matchPath } from "../../http";
import { parseImageVariant } from "../../image-variant";
import { readLocalModels } from "../../local-model";
import { probeEndpointModels, withLocalFacts } from "../../probe-models";
import { resolveApiFormat, resolveWorkspaceId } from "../../store/shared";
import { listWorkspaceDir, locateWorkspaceFile, writeWorkspaceFile } from "../../workspace-browse";
import { trashWorkspacePaths } from "../../workspace-trash";
import { fileResponse, occurred, publishBotModelChanges } from "../helpers";
import type { RouteCtx } from "../route-ctx";

/** Local API routes: credential operations, runtime, capabilities, quit, Stop, settings, workspace and host browsing, model probing, providers. */
export function systemRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { request, url, options, publish, engine, input, scope, store, onQuit, method, path } = ctx;

  if (method === "GET" && path === "/v1/credential-operations") {
    return jsonResponse({ items: store.listCredentialOperations() }, 200, null);
  }
  const credential = matchPath(path, "/v1/credential-operations/:id/resolve");
  if (method === "POST" && credential) {
    store.resolveCredentialOperation(credential.id!, input.body);
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/runtime") {
    const body: RuntimeResponse = options.runtimeInfo?.() ?? { pid: process.pid, bind: LOCAL_API_BIND };
    return jsonResponse(body, 200, null);
  }

  // Unlike /v1/runtime, this is on the remote whitelist (remote/routes.ts): a phone reads it too.
  if (method === "GET" && path === "/v1/capabilities") {
    return jsonResponse(store.capabilities(), 200, null);
  }

  // Your Claude plan's usage (ADR 0061), on this Mac and a paired phone alike.
  if (method === "GET" && path === "/v1/claude-usage" && options.claudeUsage) {
    const refresh = url.searchParams.get("refresh") === "1";
    return options.claudeUsage.current(refresh ? CLAUDE_USAGE_REFRESH_MIN_MS : undefined).then((usage) => jsonResponse(usage, 200, null));
  }

  // Your own Claude Code as the daemon finds it (ADR 0061), from this Mac or a paired phone.
  // Reading it may run `claude --version` and `claude auth status`, never anything that touches
  // its credentials. No receipt (isNonReceiptPath): each answer is a fresh look, and the path and
  // the account list are set whole, so a repeat sets the same thing.
  if (path === "/v1/runtime/claude-code" && method === "GET") {
    return options.claudeCode!.current().then((status) => jsonResponse(status, 200, null));
  }
  if (path === "/v1/runtime/claude-code/detect" && method === "POST") {
    return options.claudeCode!.detect().then((status) => jsonResponse(status, 200, null));
  }
  if (path === "/v1/runtime/claude-code/path" && method === "PUT") {
    store.setClaudeCodePath((input.body as Record<string, unknown>).path ?? null);
    return options.claudeCode!.detect().then((status) => jsonResponse(status, 200, null));
  }
  // The Claude accounts besides the daemon's own environment: the config directories a Bot may
  // run on. The whole list each time; one a Bot or a ladder rung runs on cannot be taken away (409).
  if (path === "/v1/runtime/claude-code/accounts" && method === "PUT") {
    store.setClaudeCodeConfigDirs((input.body as Record<string, unknown>).config_dirs);
    return options.claudeCode!.detect().then((status) => jsonResponse(status, 200, null));
  }

  // Your other local agents (ADR 0079), from this Mac or a paired phone, as for Claude Code: each
  // answer a fresh look (the agent run and asked about itself), the path, account list and custom
  // agents set whole. No receipt (isNonReceiptPath).
  if (options.agents && (path === "/v1/runtime/agents" || path.startsWith("/v1/runtime/agents/") || path === "/v1/runtime/custom-agents")) {
    const agents = options.agents;
    const body = (input.body ?? {}) as Record<string, unknown>;
    const runnerOf = (value: unknown): OtherRunner => {
      if (typeof value !== "string" || value === "claude_code" || !isBotRunner(value)) throw new HttpError(422, "invalid_args", "runner must name a local agent other than claude_code");
      return value as OtherRunner;
    };
    const customOf = (runner: OtherRunner) => (runner === "custom" ? (typeof body.custom_id === "string" ? body.custom_id : null) : null);
    if (method === "GET" && path === "/v1/runtime/agents") {
      return agents.list(url.searchParams.get("refresh") === "1" ? 0 : undefined, url.searchParams.get("wait") === "1").then((list) => jsonResponse(list, 200, null));
    }
    if (method === "POST" && path === "/v1/runtime/agents/detect") {
      const runner = runnerOf(body.runner);
      return agents.detect(runner, customOf(runner)).then((status) => jsonResponse(status, 200, null));
    }
    if (method === "PUT" && path === "/v1/runtime/agents/path") {
      const runner = runnerOf(body.runner);
      store.setAgentPath(runner, body.path ?? null);
      return agents.detect(runner, null).then((status) => jsonResponse(status, 200, null));
    }
    if (method === "PUT" && path === "/v1/runtime/agents/accounts") {
      const runner = runnerOf(body.runner);
      store.setAgentConfigDirs(runner, body.config_dirs);
      return agents.detect(runner, null).then((status) => jsonResponse(status, 200, null));
    }
    if (method === "PUT" && path === "/v1/runtime/custom-agents") {
      const saved = store.setCustomAgents(body.agents);
      return agents.list(0).then((list) => jsonResponse({ ...list, custom_agents: saved }, 200, null));
    }
  }
  if (method === "GET" && path === "/v1/agent-usage" && options.agentUsage) {
    const refresh = url.searchParams.get("refresh") === "1";
    return options.agentUsage.current(refresh ? AGENT_USAGE_REFRESH_MIN_MS : undefined).then((usage) => jsonResponse(usage, 200, null));
  }

  if (method === "POST" && path === "/v1/runtime/quit") {
    engine.abortAll();
    store.interruptRunningTurns((turnId) => engine.executionOf(turnId));
    store.afterCommit(() => onQuit?.());
    return emptyResponse(204, null);
  }

  if (method === "POST" && path === "/v1/turns/stop") {
    const body = (input.body) as { turn_id?: string };
    if (scope?.requireRevision && body.turn_id) {
      const current = store.db.query<{ status: string; kind: string }, [string]>(
        "SELECT t.status, s.kind FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.id = ?").get(body.turn_id);
      // A retried Stop finds its turn over: done, whichever kind of conversation it was in, now
      // that a group's turn can be stopped too.
      if (!current || !["running", "waiting_approval", "waiting_ask"].includes(current.status)) return emptyResponse(204, null);
    }
    const turn = engine.stop(body.turn_id, { button: true });
    if (!turn) return emptyResponse(204, null);
    return jsonResponse(turn, 200, null);
  }

  if (method === "POST" && path === "/v1/turns/continue") {
    const body = (input.body) as { message_id?: string };
    if (typeof body.message_id !== "string" || body.message_id.trim().length === 0) {
      throw new HttpError(422, "invalid_args", "message_id is required");
    }
    // Your press: a stop of yours over that work goes on past it (ADR 0071).
    const turn = engine.continueFromInterrupt(body.message_id.trim(), { byYou: true });
    return jsonResponse(turn, 200, null);
  }

  if (method === "GET" && path === "/v1/settings") {
    return store.settings().then((value) => jsonResponse(value, 200, null));
  }

  if (method === "GET" && path === "/v1/workspace/tree") {
    const root = store.workspacePath();
    if (!root) throw new HttpError(422, "invalid_args", "workspace is not set");
    const rel = url.searchParams.get("path") ?? "";
    return jsonResponse(listWorkspaceDir(root, rel), 200, null);
  }

  if (method === "GET" && path === "/v1/host/tree") {
    if (url.hostname !== "remote.invalid") throw new HttpError(404, "not_found", "host browse is remote-only");
    return jsonResponse(listHostDir(url.searchParams.get("path") ?? ""), 200, null);
  }

  if (method === "GET" && path === "/v1/workspace/file") {
    const root = store.workspacePath();
    if (!root) throw new HttpError(422, "invalid_args", "workspace is not set");
    const rel = url.searchParams.get("path") ?? "";
    const variant = parseImageVariant(url.searchParams.get("size"));
    const located = locateWorkspaceFile(root, rel);
    if (!existsSync(located.abs)) {
      throw new HttpError(404, "not_found", "path not found");
    }
    return fileResponse(located.abs, located.mime, located.rel.split("/").pop() ?? located.rel, variant, url.searchParams.get("range") ?? request.headers.get("Range"));
  }

  if (method === "PUT" && path === "/v1/workspace/file") {
    const root = store.workspacePath();
    if (!root) throw new HttpError(422, "invalid_args", "workspace is not set");
    const body = (input.body) as { path?: unknown; content?: unknown };
    if (typeof body.path !== "string" || body.path.trim().length === 0) {
      throw new HttpError(422, "invalid_args", "path is required");
    }
    if (typeof body.content !== "string") {
      throw new HttpError(422, "invalid_args", "content must be a string");
    }
    const result = writeWorkspaceFile(root, body.path, body.content, request.headers.get("If-Match"), (abs) => {
      if (!input.stagedWrite) throw new Error("file must be staged");
      // Joined natively: `abs` is `C:\ws\a.md` on Windows, and `final_rel` is always `/`-separated.
      if (abs !== join(input.stagedWrite.root, ...input.stagedWrite.final_rel.split("/"))) throw new HttpError(409, "conflict", "workspace target changed");
      store.commitPreparedFile(input.stagedWrite);
    });
    const response = emptyResponse(204, null);
    response.headers.set("ETag", result.etag);
    return response;
  }

  // No receipt (see isNonReceiptPath): what moves is files, and a repeat finds them gone.
  if (method === "POST" && path === "/v1/workspace/trash") {
    const root = store.workspacePath();
    if (!root) throw new HttpError(422, "invalid_args", "workspace is not set");
    const body = (input.body) as { paths?: unknown };
    return trashWorkspacePaths(root, body.paths, options.trash).then((result) => jsonResponse(result, 200, null));
  }

  if (method === "POST" && path === "/v1/models/probe") {
    return (async () => {
      const body = (input.body) as {
        endpoint_base_url?: string;
        endpoint_api_key?: string;
        /** The format the form shows; absent, the saved endpoint's (or `openai`). */
        api_format?: string;
        /** The Anthropic workspace the form shows, "" or null for none; absent, the named endpoint's (ADR 0072). */
        workspace_id?: string | null;
        provider_id?: string;
      };
      const settings = await store.settings();
      let baseUrl = body.endpoint_base_url?.trim() ?? "";
      let apiKey = body.endpoint_api_key?.trim() ?? "";
      let apiFormat: ApiFormat | undefined = body.api_format === undefined ? undefined : resolveApiFormat(body.api_format);
      if (!baseUrl || !apiKey || !apiFormat) {
        const providerId = body.provider_id?.trim() || settings.default_provider_id;
        if (providerId) {
          const provider = await store.getProvider(providerId);
          if (!baseUrl) baseUrl = provider.base_url?.trim() ?? "";
          if (!apiKey) apiKey = (await store.endpointKey(providerId))?.trim() ?? "";
          apiFormat ??= provider.api_format;
        } else if (!baseUrl) {
          baseUrl = settings.endpoint_base_url?.trim() ?? "";
          if (!apiKey) apiKey = (await store.endpointKey())?.trim() ?? "";
        }
      }
      if (!baseUrl) {
        throw new HttpError(422, "invalid_args", "endpoint_base_url is required");
      }
      // Only the endpoint the form names lends its workspace: the default one's has nothing to do
      // with an address being added.
      let workspaceId = body.workspace_id === undefined ? undefined : resolveWorkspaceId(body.workspace_id);
      const namedProvider = body.provider_id?.trim();
      if (workspaceId === undefined && namedProvider) workspaceId = (await store.getProvider(namedProvider)).workspace_id ?? null;
      request.signal.throwIfAborted();
      const probed = await probeEndpointModels(baseUrl, apiKey, fetch, request.signal, { guard: scope?.guard, apiFormat, workspaceId });
      scope?.guard?.();
      // A model server on this computer or network also says each model's window and what it can
      // do (ADR 0067); a cloud endpoint's `/models` is all there is.
      const catalog = (options.localEndpoint ?? isLocalEndpoint)(baseUrl) && apiFormat !== "anthropic"
        ? withLocalFacts(probed.catalog, await readLocalModels(fetch, baseUrl, probed.models, { signal: request.signal }))
        : probed.catalog;
      return jsonResponse({ models: probed.models, catalog }, 200, null);
    })();
  }

  if (method === "PATCH" && path === "/v1/settings") {
    const patch = (input.body) as Record<string, unknown>;
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    const next = store.patchSettingsSync(patch);
    const at = occurred();
    publishBotModelChanges(store, previousBots, at, publish);
    return jsonResponse(next, 200, null);
  }

  let params = matchPath(path, "/v1/providers/:id");
  if (method === "GET" && path === "/v1/providers") {
    return store.listProviders().then((items) => jsonResponse({ items }, 200, null));
  }
  if (method === "POST" && path === "/v1/providers") {
    const body = (input.body) as CreateProviderRequest;
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    const provider = store.createProviderSync(body);
    const at = occurred();
    publishBotModelChanges(store, previousBots, at, publish);
    return jsonResponse(provider, 201, null);
  }
  if (params && method === "GET") {
    return store.getProvider(params.id!).then((value) => jsonResponse(value, 200, null));
  }
  if (params && method === "PATCH") {
    const body = (input.body) as PatchProviderRequest;
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    const provider = store.patchProviderSync(params.id!, body);
    const at = occurred();
    publishBotModelChanges(store, previousBots, at, publish);
    return jsonResponse(provider, 200, null);
  }
  const speedTest = matchPath(path, "/v1/providers/:id/speed-test");
  if (speedTest && method === "POST") {
    const body = (input.body ?? {}) as { model?: unknown };
    if (typeof body.model !== "string" || !body.model.trim()) throw new HttpError(422, "invalid_args", "model is required");
    return engine.measureModel(speedTest.id!, body.model.trim(), request.signal).then((value) => jsonResponse(value, 200, null));
  }
  if (params && method === "DELETE") {
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    store.deleteProviderSync(params.id!);
    const at = occurred();
    publishBotModelChanges(store, previousBots, at, publish);
    return emptyResponse(204, null);
  }

  return null;
}
