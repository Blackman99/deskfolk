import {
  LOCAL_API_BIND,
  LOCAL_API_NAME,
  REACTION_EMOJI,
  USER_MEMBER,
  type ClientEvent,
  type CreateProviderRequest,
  type HealthResponse,
  type PatchProviderRequest,
  type Routine,
  type CreateBotRequest,
  type PatchBotRequest,
  type RuntimeResponse,
  type WsAuthMessage,
} from "@real-bot/protocol";
import { existsSync, readFileSync } from "node:fs";
import { attachmentMime } from "./artifact-mime";
import { emptyResponse, fromError, jsonResponse, matchPath, readBearer, readJson, responseRecord } from "./http";
import { corsHeaders, originDecision } from "./origin";
import { sessionUpsertFields } from "./session-events";
import { HttpError } from "./errors";
import { type AttachmentInput, type Store } from "./store";
import type { CompletionsClient } from "./completions";
import { createMcpHost, persistMcpInspect, type McpHost } from "./mcp-host";
import { COLLAB_TOOL_NAMES } from "./prompts";
import { startScheduler, type Scheduler } from "./scheduler";
import { createTurnEngine, type TurnEngine } from "./turn-engine";
import { probeEndpointModels } from "./probe-models";
import type { FileCommit } from "./store/files";
import { ulid } from "./ids";
import { requestDigest, sha256, type CanonicalEncoder } from "./request-digest";
import { type RequestScope, type KeyOperation } from "./store/receipts";
import { fileEtag } from "./file-integrity";
import { listWorkspaceDir, locateWorkspaceFile, writeWorkspaceFile } from "./workspace-browse";

const AUTH_TIMEOUT_MS = 5_000;
const REACTIONS = new Set<string>(REACTION_EMOJI);

type SocketData = {
  authed: boolean;
};

export type LocalApiOptions = {
  store: Store;
  token: string;
  onQuit?: () => void;
  engine?: TurnEngine;
  completions?: CompletionsClient;
  sleep?: (ms: number) => Promise<void>;
  mcp?: McpHost;
  /** Skip the calendar ticker (tests that drive `engine.fireRoutine` themselves). */
  schedule?: boolean;
  now?: () => Date;
  canonicalEncoder?: CanonicalEncoder;
};

export type LocalApi = {
  dispatchBusiness: (request: Request, scope: RequestScope) => Promise<Response>;
  fetch: (request: Request, server: Bun.Server<SocketData>) => Promise<Response | undefined>;
  websocket: {
    data: SocketData;
    open: (ws: Bun.ServerWebSocket<SocketData>) => void;
    message: (ws: Bun.ServerWebSocket<SocketData>, message: string | Buffer) => void;
    close: (ws: Bun.ServerWebSocket<SocketData>) => void;
  };
  publish: (event: ClientEvent) => void;
  engine: TurnEngine;
  scheduler: Scheduler | null;
};

export function createLocalApi(options: LocalApiOptions): LocalApi {
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  const timers = new Map<Bun.ServerWebSocket<SocketData>, ReturnType<typeof setTimeout>>();

  function publish(event: ClientEvent): void {
    options.store.afterCommit(() => {
    const payload = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.data.authed) ws.send(payload);
    }
    });
  }

  const mcp =
    options.mcp ??
    createMcpHost({
      listServers: () => options.store.listMcpServers(),
      authFor: (id) => options.store.mcpAuth(id),
      builtinNames: COLLAB_TOOL_NAMES,
    });
  const engine =
    options.engine ??
    createTurnEngine({
      store: options.store,
      publish,
      completions: options.completions,
      sleep: options.sleep,
      mcp,
    });

  const scheduler =
    options.schedule === false
      ? null
      : startScheduler({
          store: options.store,
          engine,
          now: options.now,
        });

  async function dispatchBusiness(request: Request, scope: RequestScope): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/") || url.pathname.startsWith("/v1/runtime")) {
      throw new HttpError(404, "not_found", "not a business endpoint");
    }
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
      return dispatch(request, url, options, publish, engine, mcp, { body: {}, files: [], multipart: false });
    }
    if (url.pathname === "/v1/models/probe") throw new HttpError(422, "not_retryable", "model probes are not retryable mutations");
    return mutate(request, url, scope);
  }

  async function mutate(request: Request, url: URL, scope: RequestScope): Promise<Response> {
    const parsed = await parseMutation(request);
    const digest = requestDigest({ method: request.method, path: url.pathname + url.search, body: parsed.body,
      multipart: parsed.multipart, files: parsed.files.map((file) => ({ filename: file.originalFilename, bytes: file.buffer })),
      ifMatch: request.headers.get("If-Match"),
    }, options.canonicalEncoder);
    const keyOps: KeyOperation[] = [];
    const events: ClientEvent[] = [];
    let committed = false;
    options.store.recoverFiles();
    let stagedWrite: FileCommit | undefined;
    try {
      const response = await options.store.receipts.execute(scope, digest, request.method, url.pathname, parsed.body, async () => {
        await options.store.settings();
        await options.store.listMcpServersHydrated();
        options.store.recoverFiles();
        options.store.prepareAttachments(parsed.files);
        if (request.method === "PUT" && url.pathname === "/v1/workspace/file" && typeof parsed.body.path === "string" && typeof parsed.body.content === "string" && Buffer.byteLength(parsed.body.content) <= 1_000_000) {
          const root = options.store.workspacePath();
          if (root) {
            const located = locateWorkspaceFile(root, parsed.body.path);
            stagedWrite = options.store.prepareFile(root, located.abs, parsed.body.content);
            parsed.stagedWrite = stagedWrite;
          }
        }
        return () => {
          checkRevision(options.store, request, url, parsed.body, scope);
          const plan: Array<{ name: string; value: string }> = [];
          const result = options.store.planKeys(plan, () => dispatch(request, url, options, (event) => events.push(event), engine, mcp, parsed));
          if (result instanceof Promise) throw new HttpError(422, "not_retryable", "this endpoint cannot use request receipts");
          for (const op of plan) keyOps.push({ ...op, field: op.value === "" ? "" : url.pathname === "/v1/settings" ? "endpoint_api_key" : url.pathname.startsWith("/v1/mcp-servers") ? "auth" : "api_key" });
          options.store.afterCommit(() => {
            committed = true;
            if (keyOps.length === 0) {
              for (const event of events) publish(event);
              events.length = 0;
            }
          });
          return responseRecord(result);
        };
      }, keyOps);
      if (committed || keyOps.length) {
        if (response.status === 503) {
          for (const provider of options.store.providersCached()) publish({ event: "provider.upsert", occurred_at: occurred(), ...provider });
          for (const server of options.store.listMcpServers()) publish({ event: "mcp.upsert", occurred_at: occurred(), ...server });
          publish({ event: "settings.changed", occurred_at: occurred(), ...options.store.settingsCached() });
        } else if (response.status < 400) {
          for (const event of events) publish(event);
          if (!committed && keyOps.length) {
            for (const provider of options.store.providersCached()) publish({ event: "provider.upsert", occurred_at: occurred(), ...provider });
            for (const server of options.store.listMcpServers()) publish({ event: "mcp.upsert", occurred_at: occurred(), ...server });
            publish({ event: "settings.changed", occurred_at: occurred(), ...options.store.settingsCached() });
          }
          if (url.pathname.startsWith("/v1/mcp-servers") && request.method !== "DELETE" && response.body) {
            const id = (JSON.parse(response.body) as { id: string }).id;
            const server = options.store.listMcpServers().find((row) => row.id === id);
            if (server) void persistMcpInspect(options.store, mcp, server).then((next) => publish({ event: "mcp.upsert", occurred_at: occurred(), ...next })).catch(() => undefined);
          }
        }
      }
      return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", ...response.headers, "X-Request-Id": scope.requestId } });
    } finally {
      if (stagedWrite) options.store.discardFile(stagedWrite);
      for (const file of parsed.files) if (file.staged) options.store.discardFile(file.staged);
    }
  }

  async function handle(request: Request, server: Bun.Server<SocketData>): Promise<Response | undefined> {
    const origin = request.headers.get("Origin");
    const originState = originDecision(origin);

    if (request.method === "OPTIONS") {
      if (originState === "forbidden") {
        return jsonResponse(
          { error: { code: "forbidden_origin", message: "origin is not allowed" } },
          403,
          null,
        );
      }
      if (originState === "allowed" && origin) {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      return new Response(null, { status: 204 });
    }

    if (originState === "forbidden") {
      return jsonResponse(
        { error: { code: "forbidden_origin", message: "origin is not allowed" } },
        403,
        null,
      );
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/v1/health") {
      const body: HealthResponse = { ok: true, name: LOCAL_API_NAME };
      return jsonResponse(body, 200, origin);
    }

    if (request.method === "GET" && path === "/v1/events") {
      const upgraded = server.upgrade(request, { data: { authed: false } });
      if (!upgraded) {
        return jsonResponse(
          { error: { code: "failed", message: "websocket upgrade failed" } },
          400,
          origin,
        );
      }
      return undefined;
    }

    const token = readBearer(request.headers.get("Authorization"));
    if (!token || token !== options.token) {
      return jsonResponse(
        { error: { code: "unauthorized", message: "missing or invalid token" } },
        401,
        origin,
      );
    }

    try {
      if (request.method === "POST" && path === "/v1/runtime/quit") {
        scheduler?.stop();
      }
      const isMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(request.method) && path !== "/v1/models/probe";
      const response = isMutation
        ? await mutate(request, url, { deviceId: "local", requestId: request.headers.get("X-Request-Id") ?? ulid() })
        : await dispatch(request, url, options, publish, engine, mcp, { body: request.method === "POST" ? await readJson(request) as Record<string, unknown> : {}, files: [], multipart: false });
      if (origin && originState === "allowed") {
        const headers = new Headers(response.headers);
        for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
        return new Response(response.body, { status: response.status, headers });
      }
      return response;
    } catch (error) {
      return fromError(error, origin);
    }
  }

  return {
    fetch: handle,
    dispatchBusiness,
    publish,
    engine,
    websocket: {
      data: { authed: false },
      open(ws) {
        sockets.add(ws);
        timers.set(
          ws,
          setTimeout(() => {
            if (!ws.data.authed) ws.close(4001, "auth timeout");
          }, AUTH_TIMEOUT_MS),
        );
      },
      message(ws, message) {
        if (ws.data.authed) return;
        const text = typeof message === "string" ? message : message.toString();
        let parsed: WsAuthMessage | null = null;
        try {
          parsed = JSON.parse(text) as WsAuthMessage;
        } catch {
          ws.close(4001, "unauthorized");
          return;
        }
        if (parsed.type !== "auth" || parsed.token !== options.token) {
          ws.close(4001, "unauthorized");
          return;
        }
        ws.data.authed = true;
        const timer = timers.get(ws);
        if (timer) clearTimeout(timer);
        timers.delete(ws);
      },
      close(ws) {
        sockets.delete(ws);
        const timer = timers.get(ws);
        if (timer) clearTimeout(timer);
        timers.delete(ws);
      },
    },
    scheduler,
  };
}

function occurred(): string {
  return new Date().toISOString();
}

function dispatch(
  request: Request,
  url: URL,
  options: LocalApiOptions,
  publish: (event: ClientEvent) => void,
  engine: TurnEngine,
  mcp: McpHost,
  input: ParsedMutation,
): Response | Promise<Response> {
  const { store, onQuit } = options;
  const method = request.method;
  const path = url.pathname;

  if (method === "GET" && path === "/v1/runtime") {
    const body: RuntimeResponse = { pid: process.pid, bind: LOCAL_API_BIND };
    return jsonResponse(body, 200, null);
  }

  if (method === "POST" && path === "/v1/runtime/quit") {
    engine.abortAll();
    store.interruptRunningTurns();
    store.afterCommit(() => onQuit?.());
    return emptyResponse(204, null);
  }

  if (method === "POST" && path === "/v1/turns/stop") {
    const body = (input.body) as { turn_id?: string };
    const turn = engine.stop(body.turn_id);
    if (!turn) return emptyResponse(204, null);
    return jsonResponse(turn, 200, null);
  }

  if (method === "POST" && path === "/v1/turns/continue") {
    const body = (input.body) as { message_id?: string };
    if (typeof body.message_id !== "string" || body.message_id.trim().length === 0) {
      throw new HttpError(422, "invalid_args", "message_id is required");
    }
    const turn = engine.continueFromInterrupt(body.message_id.trim());
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

  if (method === "GET" && path === "/v1/workspace/file") {
    const root = store.workspacePath();
    if (!root) throw new HttpError(422, "invalid_args", "workspace is not set");
    const rel = url.searchParams.get("path") ?? "";
    const located = locateWorkspaceFile(root, rel);
    if (!existsSync(located.abs)) {
      throw new HttpError(404, "not_found", "path not found");
    }
    const file = readFileSync(located.abs);
    return new Response(file, {
      status: 200,
      headers: {
        "ETag": fileEtag(file),
        "Content-Type": located.mime,
        "Content-Disposition": `inline; filename="${encodeURIComponent(located.rel.split("/").pop() ?? located.rel)}"`,
      },
    });
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
      if (abs !== `${input.stagedWrite.root}/${input.stagedWrite.final_rel}`) throw new HttpError(409, "conflict", "workspace target changed");
      store.commitPreparedFile(input.stagedWrite);
    });
    const response = emptyResponse(204, null);
    response.headers.set("ETag", result.etag);
    return response;
  }

  if (method === "POST" && path === "/v1/models/probe") {
    return (async () => {
      const body = (input.body) as {
        endpoint_base_url?: string;
        endpoint_api_key?: string;
        provider_id?: string;
      };
      const settings = await store.settings();
      let baseUrl = body.endpoint_base_url?.trim() ?? "";
      let apiKey = body.endpoint_api_key?.trim() ?? "";
      if (!baseUrl || !apiKey) {
        const providerId = body.provider_id?.trim() || settings.default_provider_id;
        if (providerId) {
          const provider = await store.getProvider(providerId);
          if (!baseUrl) baseUrl = provider.base_url?.trim() ?? "";
          if (!apiKey) apiKey = (await store.endpointKey(providerId))?.trim() ?? "";
        } else if (!baseUrl) {
          baseUrl = settings.endpoint_base_url?.trim() ?? "";
          if (!apiKey) apiKey = (await store.endpointKey())?.trim() ?? "";
        }
      }
      if (!baseUrl) {
        throw new HttpError(422, "invalid_args", "endpoint_base_url is required");
      }
      const probed = await probeEndpointModels(baseUrl, apiKey);
      return jsonResponse({ models: probed.models, catalog: probed.catalog }, 200, null);
    })();
  }

  if (method === "PATCH" && path === "/v1/settings") {
    const patch = (input.body) as Record<string, unknown>;
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    const previousProviderIds = new Set((store.providersCached()).map((provider) => provider.id));
    const next = store.patchSettingsSync(patch);
    const at = occurred();
    publish({ event: "settings.changed", occurred_at: at, ...next });
    for (const provider of store.providersCached()) {
      previousProviderIds.delete(provider.id);
      publish({ event: "provider.upsert", occurred_at: at, ...provider });
    }
    for (const id of previousProviderIds) {
      publish({ event: "provider.removed", occurred_at: at, id });
    }
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
    publish({ event: "provider.upsert", occurred_at: at, ...provider });
    publish({ event: "settings.changed", occurred_at: at, ...store.settingsCached() });
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
    publish({ event: "provider.upsert", occurred_at: at, ...provider });
    publish({ event: "settings.changed", occurred_at: at, ...store.settingsCached() });
    publishBotModelChanges(store, previousBots, at, publish);
    return jsonResponse(provider, 200, null);
  }
  if (params && method === "DELETE") {
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    store.deleteProviderSync(params.id!);
    const at = occurred();
    publish({ event: "provider.removed", occurred_at: at, id: params.id! });
    publish({ event: "settings.changed", occurred_at: at, ...store.settingsCached() });
    publishBotModelChanges(store, previousBots, at, publish);
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/bots") {
    return jsonResponse({ items: store.listBots() }, 200, null);
  }

  if (method === "POST" && path === "/v1/bots") {
    const body = (input.body) as CreateBotRequest;
    const created = store.createBot(body);
    const at = occurred();
    publish({ event: "bot.upsert", occurred_at: at, ...created.bot, deleted_at: null });
    publish({
      event: "session.upsert",
      occurred_at: at,
      ...sessionUpsertFields(created.direct_session),
    });
    return jsonResponse(created, 201, null);
  }

  params = matchPath(path, "/v1/bots/:id/archive");
  if (params && method === "POST") {
    const bot = store.archiveBot(params.id!);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: null });
    return jsonResponse(bot, 200, null);
  }
  params = matchPath(path, "/v1/bots/:id/restore");
  if (params && method === "POST") {
    const bot = store.restoreBot(params.id!);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: null });
    return jsonResponse(bot, 200, null);
  }
  params = matchPath(path, "/v1/bots/:id/profile-revisions");
  if (params && method === "GET") {
    return jsonResponse({ items: store.listProfileRevisions(params.id!) }, 200, null);
  }
  params = matchPath(path, "/v1/bots/:id");
  if (params && method === "GET") {
    return jsonResponse(store.getBot(params.id!), 200, null);
  }
  if (params && method === "PATCH") {
    const body = (input.body) as PatchBotRequest;
    const bot = store.patchBot(params.id!, body);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: null });
    return jsonResponse(bot, 200, null);
  }
  if (params && method === "DELETE") {
    const bot = store.getBot(params.id!);
    store.deleteBot(params.id!);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: occurred() });
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/sessions") {
    const pending = engine.pendingJudgements();
    const pendingBySession = new Map<string, typeof pending>();
    for (const row of pending) {
      const list = pendingBySession.get(row.session_id) ?? [];
      list.push(row);
      pendingBySession.set(row.session_id, list);
    }
    const items = store.listSessions().map((s) => ({
      ...s,
      live_turns: s.live_turns?.map((turn) => ({
        ...turn,
        partial_text: engine.partialText(turn.id) ?? turn.partial_text,
      })),
      pending_judgements: pendingBySession.get(s.id) ?? [],
    }));
    return jsonResponse({ items }, 200, null);
  }
  if (method === "POST" && path === "/v1/sessions") {
    const body = (input.body) as { name: string; members: string[] };
    const session = store.createGroup(body);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 201, null);
  }

  params = matchPath(path, "/v1/sessions/:id/messages");
  if (params && method === "GET") {
    const cursor = url.searchParams.get("cursor");
    const limitText = url.searchParams.get("limit");
    const limit = limitText ? Number(limitText) : undefined;
    return jsonResponse(store.listMessages(params.id!, { cursor, limit }), 200, null);
  }
  if (params && method === "POST") {
    const body = input.body;
    const bodyText = typeof body.body === "string" ? body.body : "";
    const parentId = typeof body.parent_id === "string" ? body.parent_id || null : null;
    const askId = typeof body.ask_id === "string" ? body.ask_id || null : null;
    const fork = body.fork === undefined ? undefined : body.fork === true || body.fork === "true";
    const fileInputs = input.files;

    const message = store.postMessage(params.id!, {
      body: bodyText,
      parent_id: parentId,
      attachments: fileInputs.length > 0 ? fileInputs : undefined,
    });
    publish({ event: "message.created", occurred_at: occurred(), ...message });
    if (askId) {
      engine.replyAsk(askId, message);
    } else {
      store.afterCommit(() => { void engine.handleInboundMessage(message, { fork, fromUser: true }); });
    }
    return jsonResponse(message, 201, null);
  }
  if (params && method === "DELETE") {
    store.getSession(params.id!);
    const liveTurns = store.listLiveTurns({ sessionId: params.id! });
    for (const t of liveTurns) {
      engine.stop(t.id, { allowGroup: true });
    }
    store.clearSessionMessages(params.id!);
    publish({ event: "session.cleared", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  params = matchPath(path, "/v1/sessions/:id/clear");
  if (params && method === "POST") {
    store.getSession(params.id!);
    const liveTurns = store.listLiveTurns({ sessionId: params.id! });
    for (const t of liveTurns) {
      engine.stop(t.id, { allowGroup: true });
    }
    store.clearSessionMessages(params.id!);
    publish({ event: "session.cleared", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  params = matchPath(path, "/v1/sessions/:id/members");
  if (params && method === "POST") {
    const body = (input.body) as { bot_id: string };
    const session = store.addMember(params.id!, body.bot_id);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }
  if (params && method === "DELETE") {
    const body = (input.body) as { bot_id: string };
    const session = store.removeMember(params.id!, body.bot_id);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }

  params = matchPath(path, "/v1/sessions/:id/judgements");
  if (params && method === "GET") {
    return jsonResponse({ items: store.listJudgements(params.id!) }, 200, null);
  }

  params = matchPath(path, "/v1/sessions/:id/routes");
  if (params && method === "GET") {
    store.getSession(params.id!);
    return jsonResponse(
      {
        items: store.listSessionRoutes(params.id!),
        reviews: store.listSessionReviews(params.id!).map((row) => ({
          chain_id: row.chain_id,
          turn_id: row.turn_id,
          bot_id: row.bot_id,
          signature: row.signature,
          model: row.model,
          thinking_level: row.thinking_level,
          fault: row.fault,
          direction: row.direction,
          rounds: row.rounds,
          confidence: row.confidence,
          reason: row.reason,
          created_at: row.created_at,
        })),
      },
      200,
      null,
    );
  }

  params = matchPath(path, "/v1/sessions/:id/composer-suggestions");
  if (params && method === "GET") {
    store.getSession(params.id!);
    return engine.suggestComposer(params.id!, request.signal).then((items) => jsonResponse({ items }, 200, null), () => jsonResponse({ items: [] }, 200, null));
  }

  params = matchPath(path, "/v1/sessions/:id/read");
  if (params && method === "POST") {
    const session = store.markSessionRead(params.id!);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }

  params = matchPath(path, "/v1/sessions/:id/archive");
  if (params && method === "POST") {
    const liveTurns = store.listLiveTurns({ sessionId: params.id! });
    for (const t of liveTurns) {
      engine.stop(t.id, { allowGroup: true });
    }
    const session = store.archiveSession(params.id!);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }

  params = matchPath(path, "/v1/sessions/:id/restore");
  if (params && method === "POST") {
    const session = store.restoreSession(params.id!);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }

  params = matchPath(path, "/v1/sessions/:id");
  if (params && method === "GET") {
    const session = store.getSession(params.id!);
    session.turns = session.turns.map((turn) => ({
      ...turn,
      partial_text: engine.partialText(turn.id) ?? turn.partial_text,
    }));
    session.pending_judgements = engine.pendingJudgements(params.id!);
    return jsonResponse(session, 200, null);
  }
  if (params && method === "PATCH") {
    const body = (input.body) as { name?: string };
    if (typeof body.name !== "string") {
      throw new HttpError(422, "invalid_args", "name is required");
    }
    const session = store.renameSession(params.id!, body.name);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }
  if (params && method === "DELETE") {
    const session = store.getSession(params.id!);
    if (session.kind !== "group") {
      throw new HttpError(422, "invalid_args", "only groups can be deleted");
    }
    const liveTurns = store.listLiveTurns({ sessionId: params.id! });
    for (const t of liveTurns) {
      engine.stop(t.id, { allowGroup: true });
    }
    store.deleteSession(params.id!);
    publish({
      event: "session.removed",
      occurred_at: occurred(),
      id: params.id!,
    });
    return emptyResponse(204, null);
  }

  params = matchPath(path, "/v1/messages/:id/reactions");
  if (params && (method === "PUT" || method === "DELETE")) {
    const body = (input.body) as { emoji?: string };
    if (!body.emoji || !REACTIONS.has(body.emoji)) {
      throw new HttpError(422, "invalid_args", "emoji is not in the allowed set");
    }
    if (method === "PUT") store.putReaction(params.id!, body.emoji);
    else store.deleteReaction(params.id!, body.emoji);
    publish({
      event: "reaction.changed",
      occurred_at: occurred(),
      message_id: params.id!,
      actor: USER_MEMBER,
      emoji: body.emoji,
      op: method === "PUT" ? "add" : "remove",
    });
    return emptyResponse(204, null);
  }

  params = matchPath(path, "/v1/attachments/:id/content");
  if (params && method === "GET") {
    const att = store.getAttachment(params.id!);
    const located = store.resolveAttachmentLocation(att.workspace_relpath);
    if (!located || !existsSync(located.abs)) {
      throw new HttpError(404, "not_found", "attachment file not found on disk");
    }
    if (located.isDir) {
      throw new HttpError(422, "invalid_args", "attachment is a directory");
    }
    const file = readFileSync(located.abs);
    const mime = attachmentMime(att.original_filename, att.workspace_relpath);
    return new Response(file, {
      status: 200,
      headers: {
        "ETag": fileEtag(file),
        "Content-Type": mime,
        "Content-Disposition": `inline; filename="${encodeURIComponent(att.original_filename)}"`,
      },
    });
  }

  params = matchPath(path, "/v1/attachments/:id");
  if (params && method === "GET") {
    const att = store.getAttachment(params.id!);
    return jsonResponse(att, 200, null);
  }

  if (method === "GET" && path === "/v1/approvals") {
    return jsonResponse({ items: store.listApprovals(url.searchParams.get("status") ?? undefined) }, 200, null);
  }
  params = matchPath(path, "/v1/approvals/:id/resolve");
  if (params && method === "POST") {
    const body = (input.body) as { action?: string; scope?: string; api_key?: string };
    if (
      body.action !== "allow_once" &&
      body.action !== "deny" &&
      body.action !== "always_allow"
    ) {
      throw new HttpError(422, "invalid_args", "action must be allow_once, deny, or always_allow");
    }
    if (body.api_key !== undefined && typeof body.api_key !== "string") {
      throw new HttpError(422, "invalid_args", "api_key must be a string");
    }
    return jsonResponse(
      engine.resolveApproval(params.id!, body.action, body.scope, body.api_key),
      200,
      null,
    );
  }

  if (method === "GET" && path === "/v1/allow-rules") {
    return jsonResponse({ items: store.listAllowRules() }, 200, null);
  }
  if (method === "POST" && path === "/v1/allow-rules") {
    const body = (input.body) as { kind_key?: string; scope?: string };
    if (!body.kind_key || !body.scope) {
      throw new HttpError(422, "invalid_args", "kind_key and scope are required");
    }
    const rule = store.createAllowRule(body.kind_key, body.scope);
    publish({ event: "allow_rule.upsert", occurred_at: occurred(), ...rule });
    return jsonResponse(rule, 201, null);
  }
  params = matchPath(path, "/v1/allow-rules/:id");
  if (params && method === "DELETE") {
    store.deleteAllowRule(params.id!);
    publish({ event: "allow_rule.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/mcp-servers") {
    return store.listMcpServersHydrated().then((items) => jsonResponse({ items }, 200, null));
  }
  if (method === "POST" && path === "/v1/mcp-servers") {
    const body = (input.body) as {
      name: string;
      transport?: "stdio" | "http";
      command?: string;
      args?: string[];
      url?: string;
      headers?: Array<{ name: string; value: string }>;
      auth?: string;
      enabled?: boolean;
      usage_note?: string | null;
    };
    let server = store.createMcpServerSync(body);
    publish({ event: "mcp.upsert", occurred_at: occurred(), ...server });
    return jsonResponse(server, 201, null);
  }
  params = matchPath(path, "/v1/mcp-servers/:id");
  if (params && method === "PATCH") {
    const body = (input.body) as {
      name?: string;
      transport?: "stdio" | "http";
      command?: string;
      args?: string[];
      url?: string;
      headers?: Array<{ name: string; value: string }>;
      auth?: string;
      enabled?: boolean;
      usage_note?: string | null;
    };
    let server = store.patchMcpServerSync(params.id!, body);
    publish({ event: "mcp.upsert", occurred_at: occurred(), ...server });
    return jsonResponse(server, 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteMcpServerSync(params.id!);
    publish({ event: "mcp.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/skills") {
    return jsonResponse({ items: store.listSkills() }, 200, null);
  }
  if (method === "POST" && path === "/v1/skills") {
    const body = (input.body) as {
      bot_id: string;
      name: string;
      description: string;
      body: string;
      uses?: string[];
      enabled?: boolean;
    };
    const skill = store.createSkill(body);
    publish({ event: "skill.upsert", occurred_at: occurred(), ...skill });
    return jsonResponse(skill, 201, null);
  }
  params = matchPath(path, "/v1/skills/:id");
  if (params && method === "PATCH") {
    const body = (input.body) as {
      name?: string;
      description?: string;
      body?: string;
      uses?: string[];
      enabled?: boolean;
    };
    const skill = store.patchSkill(params.id!, body);
    publish({ event: "skill.upsert", occurred_at: occurred(), ...skill });
    return jsonResponse(skill, 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteSkill(params.id!);
    publish({ event: "skill.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  // Memories have no POST: the Bot writes them, you correct them.
  if (method === "GET" && path === "/v1/memories") {
    return jsonResponse({ items: store.listMemories() }, 200, null);
  }
  params = matchPath(path, "/v1/memories/:id");
  if (params && method === "PATCH") {
    const body = (input.body) as { subject?: string; body?: string; enabled?: boolean };
    const memory = store.patchMemory(params.id!, body);
    publish({ event: "memory.upsert", occurred_at: occurred(), ...memory });
    return jsonResponse(memory, 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteMemory(params.id!);
    publish({ event: "memory.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/routines") {
    return jsonResponse({ items: store.listRoutines() }, 200, null);
  }
  if (method === "POST" && path === "/v1/routines") {
    const body = (input.body) as {
      bot_id: string;
      title: string;
      instruction: string;
      schedule: Routine["schedule"];
      enabled?: boolean;
    };
    const routine = store.createRoutine(body);
    publish({ event: "routine.upsert", occurred_at: occurred(), ...routine });
    engine.fireRoutine(routine.id);
    return jsonResponse(store.getRoutine(routine.id), 201, null);
  }
  params = matchPath(path, "/v1/routines/:id");
  if (params && method === "PATCH") {
    const body = (input.body) as {
      title?: string;
      instruction?: string;
      schedule?: Routine["schedule"];
      enabled?: boolean;
    };
    const routine = store.patchRoutine(params.id!, body);
    publish({ event: "routine.upsert", occurred_at: occurred(), ...routine });
    engine.fireRoutine(routine.id);
    return jsonResponse(store.getRoutine(routine.id), 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteRoutine(params.id!);
    publish({ event: "routine.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/spend") {
    return jsonResponse(
      {
        items: store.listSpend({
          session_id: url.searchParams.get("session_id") ?? undefined,
          bot_id: url.searchParams.get("bot_id") ?? undefined,
          turn_id: url.searchParams.get("turn_id") ?? undefined,
        }),
      },
      200,
      null,
    );
  }

  if (method === "GET" && path === "/v1/search") {
    const q = url.searchParams.get("q") ?? "";
    return jsonResponse({ items: store.search(q) }, 200, null);
  }

  return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404, null);
}

function publishBotModelChanges(
  store: Store,
  previousBots: Array<{ id: string; model: string | null; provider_id: string | null }>,
  at: string,
  publish: (event: ClientEvent) => void,
): void {
  for (const bot of store.listBots()) {
    const previous = previousBots.find((row) => row.id === bot.id);
    if (previous?.model === bot.model && previous.provider_id === bot.provider_id) continue;
    publish({ event: "bot.upsert", occurred_at: at, ...bot, deleted_at: null });
  }
}

type ParsedMutation = { body: Record<string, unknown>; files: AttachmentInput[]; multipart: boolean; stagedWrite?: FileCommit };

async function parseMutation(request: Request): Promise<ParsedMutation> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("multipart/form-data")) {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(422, "invalid_args", "body must be an object");
    return { body: body as Record<string, unknown>, files: [], multipart: false };
  }
  const form = await request.formData();
  const body: Record<string, unknown> = {};
  const files: AttachmentInput[] = [];
  for (const [key, value] of form) {
    if (value instanceof File) files.push({ originalFilename: value.name, buffer: new Uint8Array(await value.arrayBuffer()) });
    else {
      if (Object.hasOwn(body, key)) throw new HttpError(422, "invalid_args", "duplicate multipart field");
      Object.defineProperty(body, key, { value, enumerable: true });
    }
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.originalFilename), Buffer.from(b.originalFilename)) || sha256(a.buffer).localeCompare(sha256(b.buffer)));
  return { body, files, multipart: true };
}

function checkRevision(store: Store, request: Request, url: URL, body: Record<string, unknown>, scope: RequestScope): void {
  if (request.method === "PUT" && url.pathname === "/v1/workspace/file" && scope.requireRevision && !request.headers.has("If-Match")) {
    throw new HttpError(422, "invalid_args", "If-Match is required");
  }
  if (request.method !== "PATCH") return;
  const revision = body.if_revision;
  if (revision === undefined && !scope.requireRevision) return;
  if (url.pathname === "/v1/settings") {
    if (!Number.isInteger(revision) || revision !== store.settingsCached().settings_rev) throw new HttpError(409, "conflict", "settings revision changed");
  } else {
    const parts = url.pathname.split("/");
    const tables: Record<string, string> = { bots: "bots", skills: "skills", memories: "memories", routines: "routines", providers: "providers", "mcp-servers": "mcp_servers", sessions: "sessions" };
    const table = tables[parts[2] ?? ""];
    if (!table || !parts[3]) return;
    const row = store.db.query<{ updated_at: string }, [string]>(`SELECT updated_at FROM ${table} WHERE id = ?`).get(decodeURIComponent(parts[3]));
    if (!row) throw new HttpError(404, "not_found", "entity not found");
    if (typeof revision !== "string" || revision !== row.updated_at) throw new HttpError(409, "conflict", "entity revision changed");
  }
  delete body.if_revision;
}
