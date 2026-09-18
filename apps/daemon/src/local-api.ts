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
import { existsSync } from "node:fs";
import { attachmentMime } from "./artifact-mime";
import { emptyResponse, fromError, jsonResponse, matchPath, readBearer, readJson } from "./http";
import { corsHeaders, originDecision } from "./origin";
import { HttpError } from "./errors";
import { type AttachmentInput, type Store } from "./store";
import type { CompletionsClient } from "./completions";
import { createMcpHost, persistMcpInspect, type McpHost } from "./mcp-host";
import { COLLAB_TOOL_NAMES } from "./prompts";
import { startScheduler, type Scheduler } from "./scheduler";
import { createTurnEngine, type TurnEngine } from "./turn-engine";
import { probeEndpointModels } from "./probe-models";
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
};

export type LocalApi = {
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
    const payload = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.data.authed) ws.send(payload);
    }
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
      const response = await dispatch(request, url, options, publish, engine, mcp);
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

async function dispatch(
  request: Request,
  url: URL,
  options: LocalApiOptions,
  publish: (event: ClientEvent) => void,
  engine: TurnEngine,
  mcp: McpHost,
): Promise<Response> {
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
    onQuit?.();
    return emptyResponse(204, null);
  }

  if (method === "POST" && path === "/v1/turns/stop") {
    const body = (await readJson(request)) as { turn_id?: string };
    const turn = engine.stop(body.turn_id);
    if (!turn) return emptyResponse(204, null);
    return jsonResponse(turn, 200, null);
  }

  if (method === "POST" && path === "/v1/turns/continue") {
    const body = (await readJson(request)) as { message_id?: string };
    if (typeof body.message_id !== "string" || body.message_id.trim().length === 0) {
      throw new HttpError(422, "invalid_args", "message_id is required");
    }
    const turn = engine.continueFromInterrupt(body.message_id.trim());
    return jsonResponse(turn, 200, null);
  }

  if (method === "GET" && path === "/v1/settings") {
    return jsonResponse(await store.settings(), 200, null);
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
    const file = Bun.file(located.abs);
    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": located.mime,
        "Content-Disposition": `inline; filename="${encodeURIComponent(located.rel.split("/").pop() ?? located.rel)}"`,
      },
    });
  }

  if (method === "PUT" && path === "/v1/workspace/file") {
    const root = store.workspacePath();
    if (!root) throw new HttpError(422, "invalid_args", "workspace is not set");
    const body = (await readJson(request)) as { path?: unknown; content?: unknown };
    if (typeof body.path !== "string" || body.path.trim().length === 0) {
      throw new HttpError(422, "invalid_args", "path is required");
    }
    if (typeof body.content !== "string") {
      throw new HttpError(422, "invalid_args", "content must be a string");
    }
    writeWorkspaceFile(root, body.path, body.content);
    return emptyResponse(204, null);
  }

  if (method === "POST" && path === "/v1/models/probe") {
    const body = (await readJson(request)) as {
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
    const models = await probeEndpointModels(baseUrl, apiKey);
    return jsonResponse({ models }, 200, null);
  }

  if (method === "PATCH" && path === "/v1/settings") {
    const patch = (await readJson(request)) as Record<string, unknown>;
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    const previousProviderIds = new Set((await store.listProviders()).map((provider) => provider.id));
    const next = await store.patchSettings(patch);
    const at = occurred();
    publish({ event: "settings.changed", occurred_at: at, ...next });
    for (const provider of await store.listProviders()) {
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
    return jsonResponse({ items: await store.listProviders() }, 200, null);
  }
  if (method === "POST" && path === "/v1/providers") {
    const body = (await readJson(request)) as CreateProviderRequest;
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    const provider = await store.createProvider(body);
    const at = occurred();
    publish({ event: "provider.upsert", occurred_at: at, ...provider });
    publish({ event: "settings.changed", occurred_at: at, ...(await store.settings()) });
    publishBotModelChanges(store, previousBots, at, publish);
    return jsonResponse(provider, 201, null);
  }
  if (params && method === "GET") {
    return jsonResponse(await store.getProvider(params.id!), 200, null);
  }
  if (params && method === "PATCH") {
    const body = (await readJson(request)) as PatchProviderRequest;
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    const provider = await store.patchProvider(params.id!, body);
    const at = occurred();
    publish({ event: "provider.upsert", occurred_at: at, ...provider });
    publish({ event: "settings.changed", occurred_at: at, ...(await store.settings()) });
    publishBotModelChanges(store, previousBots, at, publish);
    return jsonResponse(provider, 200, null);
  }
  if (params && method === "DELETE") {
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    await store.deleteProvider(params.id!);
    const at = occurred();
    publish({ event: "provider.removed", occurred_at: at, id: params.id! });
    publish({ event: "settings.changed", occurred_at: at, ...(await store.settings()) });
    publishBotModelChanges(store, previousBots, at, publish);
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/bots") {
    return jsonResponse({ items: store.listBots() }, 200, null);
  }

  if (method === "POST" && path === "/v1/bots") {
    const body = (await readJson(request)) as CreateBotRequest;
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
    const body = (await readJson(request)) as PatchBotRequest;
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
    const body = (await readJson(request)) as { name: string; members: string[] };
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
    const contentType = request.headers.get("content-type") ?? "";
    let bodyText = "";
    let parentId: string | null = null;
    let fork: boolean | undefined = undefined;
    let askId: string | null = null;
    const fileInputs: AttachmentInput[] = [];

    if (contentType.toLowerCase().includes("multipart/form-data")) {
      const formData = await request.formData();
      bodyText = formData.get("body")?.toString() ?? "";
      parentId = formData.get("parent_id")?.toString() || null;
      const rawFork = formData.get("fork");
      if (rawFork !== null) fork = rawFork === "true";
      askId = formData.get("ask_id")?.toString() || null;
      for (const [_, val] of formData.entries()) {
        if (val instanceof File && val.size > 0) {
          fileInputs.push({
            originalFilename: val.name || "attachment",
            buffer: new Uint8Array(await val.arrayBuffer()),
          });
        }
      }
    } else {
      const body = (await readJson(request)) as {
        body: string;
        parent_id?: string | null;
        fork?: boolean;
        ask_id?: string | null;
      };
      bodyText = body.body ?? "";
      parentId = body.parent_id ?? null;
      if (body.fork !== undefined) fork = Boolean(body.fork);
      askId = body.ask_id ?? null;
    }

    const message = store.postMessage(params.id!, {
      body: bodyText,
      parent_id: parentId,
      attachments: fileInputs.length > 0 ? fileInputs : undefined,
    });
    publish({ event: "message.created", occurred_at: occurred(), ...message });
    if (askId) {
      await engine.replyAsk(askId, message);
    } else {
      void engine.handleInboundMessage(message, { fork, fromUser: true });
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
    const body = (await readJson(request)) as { bot_id: string };
    const session = store.addMember(params.id!, body.bot_id);
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    return jsonResponse(session, 200, null);
  }
  if (params && method === "DELETE") {
    const body = (await readJson(request)) as { bot_id: string };
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
    const body = (await readJson(request)) as { name?: string };
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
    const body = (await readJson(request)) as { emoji?: string };
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
    const file = Bun.file(located.abs);
    const mime = attachmentMime(att.original_filename, att.workspace_relpath);
    return new Response(file, {
      status: 200,
      headers: {
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
    const body = (await readJson(request)) as { action?: string; scope?: string; api_key?: string };
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
      await engine.resolveApproval(params.id!, body.action, body.scope, body.api_key),
      200,
      null,
    );
  }

  if (method === "GET" && path === "/v1/allow-rules") {
    return jsonResponse({ items: store.listAllowRules() }, 200, null);
  }
  if (method === "POST" && path === "/v1/allow-rules") {
    const body = (await readJson(request)) as { kind_key?: string; scope?: string };
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
    return jsonResponse({ items: await store.listMcpServersHydrated() }, 200, null);
  }
  if (method === "POST" && path === "/v1/mcp-servers") {
    const body = (await readJson(request)) as {
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
    let server = await store.createMcpServer(body);
    server = await persistMcpInspect(store, mcp, server);
    publish({ event: "mcp.upsert", occurred_at: occurred(), ...server });
    return jsonResponse(server, 201, null);
  }
  params = matchPath(path, "/v1/mcp-servers/:id");
  if (params && method === "PATCH") {
    const body = (await readJson(request)) as {
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
    let server = await store.patchMcpServer(params.id!, body);
    server = await persistMcpInspect(store, mcp, server);
    publish({ event: "mcp.upsert", occurred_at: occurred(), ...server });
    return jsonResponse(server, 200, null);
  }
  if (params && method === "DELETE") {
    await store.deleteMcpServer(params.id!);
    publish({ event: "mcp.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/skills") {
    return jsonResponse({ items: store.listSkills() }, 200, null);
  }
  if (method === "POST" && path === "/v1/skills") {
    const body = (await readJson(request)) as {
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
    const body = (await readJson(request)) as {
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

  if (method === "GET" && path === "/v1/routines") {
    return jsonResponse({ items: store.listRoutines() }, 200, null);
  }
  if (method === "POST" && path === "/v1/routines") {
    const body = (await readJson(request)) as {
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
    const body = (await readJson(request)) as {
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

function sessionUpsertFields(session: {
  id: string;
  kind: "direct" | "group";
  name: string | null;
  last_read_at?: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
  participants: { member: string; joined_at: string; left_at: string | null }[];
  unread_count?: number;
}) {
  return {
    id: session.id,
    kind: session.kind,
    name: session.name,
    last_read_at: session.last_read_at ?? null,
    archived_at: session.archived_at ?? null,
    created_at: session.created_at,
    updated_at: session.updated_at,
    participants: session.participants,
    unread_count: session.unread_count ?? 0,
  };
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
