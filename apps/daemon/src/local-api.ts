import { isNonReceiptPath, LOCAL_API_NAME, type CapabilitiesResponse, type ClientEvent, type HealthResponse, type NotificationFilter, type RuntimeSnapshot, type SessionSnapshot, type StreamFrame, type ToolFrame, type WsAuthMessage } from "@real-bot/protocol";
import { warmDisplayAvatar } from "./avatar-display";
import { createClaudeCodeProbe } from "./claude-code/probe";
import { createClaudeUsageProbe } from "./claude-code/usage";
import { HttpError } from "./errors";
import { emptyResponse, fromError, jsonResponse, matchPath, readBearer, readJson, responseRecord } from "./http";
import { ulid } from "./ids";
import { displayBot, numberOr, shellCommandOf, terminalColors } from "./local-api/helpers";
import { checkRevision, parseMutation, type ParsedMutation } from "./local-api/parse";
import type { RouteCtx } from "./local-api/route-ctx";
import { botAndSessionRoutes } from "./local-api/routes/bots-and-sessions";
import { configRoutes } from "./local-api/routes/config";
import { messageRoutes } from "./local-api/routes/messages";
import { notificationRoutes } from "./local-api/routes/notifications";
import { planRoutes } from "./local-api/routes/plans";
import { qualityAndPromptRoutes } from "./local-api/routes/quality-and-prompts";
import { systemRoutes } from "./local-api/routes/system";
import type { LocalApi, LocalApiOptions, SocketData } from "./local-api/types";
import { createMcpHost, persistMcpInspect, type McpHost } from "./mcp-host";
import { NotificationDeliveryScheduler, PresenceManager } from "./notifications";
import { corsHeaders, originDecision } from "./origin";
import { COLLAB_TOOL_NAMES } from "./prompts";
import { reconcilePrompts } from "./prompts/book";
import type { PtySignal } from "./pty";
import { Quiesce, TurnAdmission } from "./quiesce";
import { requestDigest, validateRequestPath } from "./request-digest";
import { startScheduler } from "./scheduler";
import { EventStream } from "./session-events";
import type { AttachmentInput } from "./store";
import type { FileCommit } from "./store/files";
import type { KeyOperation, RequestScope } from "./store/receipts";
import { ENGINE_LEVEL } from "./store/schema-gate";
import { StreamHub, type StreamRead } from "./streams";
import { ensureZshIntegration } from "./terminal-env";
import { Terminals } from "./terminals";
import { createTurnEngine, type TurnEngine } from "./turn-engine";
import { locateWorkspaceFile } from "./workspace-browse";
export type { LocalApi, LocalApiOptions } from "./local-api/types";

const AUTH_TIMEOUT_MS = 5_000;

/** Stands for every window socket at once: there is one window, and it either watches or does not. */
export const LOCAL_WATCHER = "local" as const;

export function createLocalApi(options: LocalApiOptions): LocalApi {
  options = {
    ...options,
    admission: options.admission ?? new TurnAdmission(),
    claudeCode: options.claudeCode ?? createClaudeCodeProbe({ setting: () => options.store.claudeCodePath() }),
  };
  const claudeCode = options.claudeCode!;
  options.claudeUsage ??= createClaudeUsageProbe({
    claudeCode,
    inUse: () => options.store.listBots().some((bot) => bot.runner === "claude_code"),
  });
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  const timers = new Map<Bun.ServerWebSocket<SocketData>, ReturnType<typeof setTimeout>>();

  function send(ws: Bun.ServerWebSocket<SocketData>, payload: string): void {
    try {
      if (ws.send(payload) === 0) ws.close(1013, "event delivery failed");
    } catch {
      ws.close(1013, "event delivery failed");
    }
  }

  const events = new EventStream();
  // Portraits are sent as small copies; making them before the first snapshot asks is cheaper
  // than sending the originals once.
  for (const bot of options.store.listBots()) void warmDisplayAvatar(bot.avatar);
  const presence = new PresenceManager();
  const notificationScheduler = new NotificationDeliveryScheduler(options.store, presence);
  events.subscribe((frame) => {
    const payload = JSON.stringify(frame);
    for (const ws of sockets) if (ws.data.authed && ws.data.sync) send(ws, payload);
  });
  const credentialEvents = new Set(["settings.changed", "provider.upsert", "provider.removed", "mcp.upsert", "mcp.removed"]);
  function publishLegacy(event: ClientEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of sockets) if (ws.data.authed && !ws.data.sync) send(ws, payload);
  }
  options.store.onCommit((event) => {
    events.publish(event);
    if (credentialEvents.has(event.event)) publishLegacy(event);
  });

  /**
   * Terminal and command output. Watched-only: nothing is sent while nobody is looking, which is
   * what keeps a build running under a closed panel off the phone's radio. A watcher is either
   * every window socket ({@link LOCAL_WATCHER}) or one paired device, by id.
   */
  const streams = new StreamHub();
  const streamWatchers = new Map<string, Set<string>>();
  const streamSubscriptions = new Map<string, () => void>();
  const streamListeners = new Set<(id: string, read: StreamRead, watchers: readonly string[]) => void>();
  const toolListeners = new Set<(frame: ToolFrame) => void>();

  /** To everyone watching `id`, or only to `to`: a backlog is for the watcher who asked for it. */
  function emitStream(id: string, read: StreamRead, to?: string): void {
    const watching = streamWatchers.get(id);
    if (!watching?.size) return;
    const targets = to === undefined ? watching : new Set([to]);
    const frame: StreamFrame = {
      type: "stream",
      id,
      offset: read.offset,
      data: Buffer.from(read.bytes).toString("base64"),
      ...(read.skipped ? { skipped: read.skipped } : {}),
      ...(read.closed ? { closed: true } : {}),
    };
    if (targets.has(LOCAL_WATCHER)) {
      const payload = JSON.stringify(frame);
      for (const ws of sockets) if (ws.data.authed && ws.data.sync) send(ws, payload);
    }
    if (!streamListeners.size) return;
    const list = [...targets];
    // Raw bytes for anyone else: the remote link coalesces before it encodes, and re-decoding
    // base64 per chunk just to batch it would be silly.
    for (const listener of streamListeners) listener(id, read, list);
  }

  function watchStream(id: string, watcher: string, from: number): void {
    const watching = streamWatchers.get(id) ?? new Set<string>();
    streamWatchers.set(id, watching);
    const first = watching.size === 0;
    watching.add(watcher);
    if (first) {
      streamSubscriptions.set(id, streams.subscribe(id, from, (read) => emitStream(id, read)));
      return;
    }
    // Already live for someone else: this watcher still needs its own backlog, and only this one.
    // Handed to everyone, it reached a phone already past those bytes as if they were new.
    const backlog = streams.read(id, from);
    if (backlog.bytes.length || backlog.skipped) emitStream(id, backlog, watcher);
  }

  const terminals = new Terminals({
    streams,
    now: options.now,
    store: options.store,
    shellIntegrationDir: options.dataDir ? ensureZshIntegration(options.dataDir) : null,
    // Straight onto the sequenced ring: open / resize / exit / gone is a handful of frames, not
    // a firehose, and clients get ordering and catch-up for free. The bytes go elsewhere.
    publish: (event) => {
      events.publish(event);
      publishLegacy(event);
    },
  });

  function unwatchStream(id: string, watcher: string): void {
    const watching = streamWatchers.get(id);
    if (!watching) return;
    watching.delete(watcher);
    if (watching.size) return;
    streamWatchers.delete(id);
    streamSubscriptions.get(id)?.();
    streamSubscriptions.delete(id);
  }


  /**
   * Tool phases go out beside the stream bytes, not through the event ring. A few frames a turn
   * is nothing, but they are as ephemeral as the bytes they describe: miss them and you have
   * missed nothing that a reload would not rebuild from the turn itself.
   */
  function publishTool(frame: ToolFrame): void {
    const payload = JSON.stringify(frame);
    for (const ws of sockets) if (ws.data.authed && ws.data.sync) send(ws, payload);
    for (const listener of toolListeners) listener(frame);
  }

  function publish(event: ClientEvent): void {
    if (event.event === "turn.tool" && (event.phase === "started" || event.phase === "exited")) {
      publishTool({
        type: "tool",
        turn_id: event.turn_id,
        id: event.id,
        name: event.name ?? "",
        phase: event.phase,
        ...(shellCommandOf(event.name, event.arguments) ? { command: shellCommandOf(event.name, event.arguments) } : {}),
        ...(event.target ? { target: event.target } : {}),
        ...(event.mcp_server ? { mcp_server: event.mcp_server } : {}),
        ...(event.mcp_tool ? { mcp_tool: event.mcp_tool } : {}),
        ...(event.exit_code === undefined ? {} : { exit_code: event.exit_code }),
        ...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms }),
      });
    }
    options.store.afterCommit(() => {
      if (!credentialEvents.has(event.event)) publishLegacy(event);
      // Persisted rows come from Store commits, never a delayed tool/API result.
      if (event.event === "judgement.started" || event.event === "judgement.ended") events.publish(event);
      if (event.event === "turn.token") {
        const turn = options.store.getTurn(event.turn_id);
        options.store.setTurnPartial(turn.id, `${turn.partial_text ?? ""}${event.text}`);
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
      localEndpoint: options.localEndpoint,
      sleep: options.sleep,
      mcp,
      admission: options.admission,
      streams,
      ablation: options.ablation,
      claudeCode,
      agentQuery: options.agentQuery,
    });

  options.beforeScheduler?.(engine);
  const scheduler =
    options.schedule === false
      ? null
      : startScheduler({
          store: options.store,
          engine,
          now: options.now,
        });
  const quiesce = new Quiesce(options.store, engine, options.admission!, scheduler);

  function withPartial(turn: import("@real-bot/protocol").Turn) {
    const tool = engine.runningTool(turn.id);
    return { ...turn, partial_text: turn.partial_text ?? engine.partialText(turn.id), ...(tool ? { running_tool: tool } : {}) };
  }

  function snapshotSessions(sessions: RuntimeSnapshot["sessions"]) {
    const pending = engine.pendingJudgements();
    return sessions.map((session) => ({
      ...session,
      live_turns: session.live_turns?.map(withPartial),
      pending_judgements: pending.filter((row) => row.session_id === session.id),
    }));
  }

  async function dispatchBusiness(request: Request, scope: RequestScope): Promise<Response> {
    scope.guard?.();
    const url = new URL(request.url);
    validateRequestPath(url.pathname + url.search);
    // /v1/debug is never on the remote whitelist either (remote/routes.ts); excluded here too, the
    // same way /v1/runtime is, so a call that somehow reached dispatchBusiness still 404s instead
    // of reading it. So is a developer's raise of the engine level past an older installed app
    // (ADR 0041): that is for whoever sits at this Mac, never for a phone.
    if (
      !url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/v1/runtime") ||
      url.pathname.startsWith("/v1/debug") ||
      url.pathname.startsWith("/v1/capabilities/")
    ) {
      throw new HttpError(404, "not_found", "not a business endpoint");
    }
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
      const receipt = matchPath(url.pathname, "/v1/requests/:id");
      const response = receipt && request.method === "GET"
        ? (() => { const r = options.store.receipts.read({ ...scope, requestId: receipt.id! }); return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json", ...r.headers } }); })()
        : await readBusiness(request, url, scope);
      scope.guard?.();
      return response;
    }
    if (isNonReceiptPath(url.pathname)) {
      const response = await readBusiness(request, url, scope);
      scope.guard?.();
      return response;
    }
    return mutate(request, url, scope);
  }

  async function mutate(request: Request, url: URL, scope: RequestScope): Promise<Response> {
    validateRequestPath(url.pathname + url.search);
    const parsed = await parseMutation(request, (request as Request & { stagedFiles?: AttachmentInput[] }).stagedFiles);
    const digest = requestDigest({ method: request.method, path: url.pathname + url.search, body: parsed.digestBody ?? parsed.body,
      multipart: parsed.multipart, normalizedFiles: parsed.normalizedFiles,
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
        scope.guard?.();
        options.store.recoverFiles();
        // Only a post carries files. One that will be refused must not stage them anywhere first.
        const posting = request.method === "POST" && parsed.files.length ? matchPath(url.pathname, "/v1/sessions/:id/messages") : null;
        if (posting) options.store.assertUserMayPost(posting.id!);
        if (parsed.files.some((file) => !file.staged)) options.store.prepareAttachments(parsed.files);
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
          const result = options.store.planKeys(plan, () => dispatch(request, url, options, (event) => events.push(event), engine, mcp, parsed, scope, notificationScheduler, presence));
          if (result instanceof Promise) throw new HttpError(422, "not_retryable", "this endpoint cannot use request receipts");
          for (const op of plan) keyOps.push({ ...op, field: op.value === "" ? "" : url.pathname.startsWith("/v1/credential-operations/") ? "value" : url.pathname === "/v1/settings" ? "endpoint_api_key" : url.pathname.startsWith("/v1/mcp-servers") ? "auth" : "api_key" });
          options.store.afterCommit(() => {
            committed = true;
            for (const event of events) publish(event);
            events.length = 0;
          });
          return responseRecord(scope.requireRevision && url.pathname === "/v1/turns/stop" && result.status < 300
            ? emptyResponse(204, null) : result);
        };
      }, keyOps);
      if ((committed || keyOps.length) && response.status < 400 && url.pathname.startsWith("/v1/mcp-servers") && request.method !== "DELETE" && response.body) {
        const id = (JSON.parse(response.body) as { id: string }).id;
        const server = options.store.listMcpServers().find((row) => row.id === id);
        if (server) void persistMcpInspect(options.store, mcp, server).catch(() => undefined);
      }
      return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", ...response.headers, "X-Request-Id": scope.requestId } });
    } finally {
      if (stagedWrite) options.store.discardFile(stagedWrite);
      for (const file of parsed.files) if (file.staged) options.store.discardFile(file.staged);
    }
  }

  /**
   * Terminals never write a request receipt. Receipts are keyed by `(device_id, request_id)` and
   * stored, which is right for a message and absurd for a keystroke; `/v1/models/probe` already
   * set the precedent for a POST that is not replayable. The cost is stated rather than hidden:
   * a keystroke lost to a dropped connection is lost, and retrying one is not idempotent.
   */
  async function terminalRoute(request: Request, url: URL, scope?: RequestScope): Promise<Response> {
    const path = url.pathname;
    const method = request.method;
    const watcher = scope?.deviceId && scope.deviceId !== "local" ? scope.deviceId : LOCAL_WATCHER;
    const body = method === "POST" ? (await readJson(request)) as Record<string, unknown> : {};

    if (method === "GET" && path === "/v1/terminals") return jsonResponse({ items: terminals.list() }, 200, null);
    if (method === "POST" && path === "/v1/terminals") {
      const cwd = typeof body.cwd === "string" ? body.cwd : "";
      return jsonResponse(terminals.open({ cwd, rows: numberOr(body.rows), cols: numberOr(body.cols) }), 200, null);
    }

    // A command's stream is watched the same way a terminal's is, but its id is
    // `<turn_id>:<tool_call_id>` — not a ULID, and not something to put in a path segment.
    if (method === "POST" && (path === "/v1/streams/watch" || path === "/v1/streams/unwatch")) {
      const id = typeof body.id === "string" ? body.id : "";
      if (!/^[0-9A-HJKMNP-TV-Z]{26}:[A-Za-z0-9_-]{1,128}$/.test(id)) {
        throw new HttpError(422, "invalid_args", "id must be <turn>:<tool call>");
      }
      if (path.endsWith("/unwatch")) {
        unwatchStream(id, watcher);
        return emptyResponse(204, null);
      }
      if (!streams.has(id)) throw new HttpError(404, "not_found", "no such stream");
      watchStream(id, watcher, Math.max(0, numberOr(body.from) ?? 0));
      return emptyResponse(204, null);
    }

    const one = matchPath(path, "/v1/terminals/:id");
    if (one && method === "GET") return jsonResponse(terminals.get(one.id!), 200, null);
    if (one && method === "DELETE") {
      terminals.remove(one.id!);
      unwatchStream(one.id!, watcher);
      return emptyResponse(204, null);
    }

    const scrollback = matchPath(path, "/v1/terminals/:id/scrollback");
    if (scrollback && method === "GET") {
      const id = terminals.get(scrollback.id!).id;
      const raw = url.searchParams.get("from") ?? "0";
      if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new HttpError(422, "invalid_args", "from must be a byte offset");
      }
      const read = streams.read(id, Number(raw));
      return jsonResponse({
        offset: read.offset,
        data: Buffer.from(read.bytes).toString("base64"),
        skipped: read.skipped,
        end: read.end,
        closed: read.closed,
      }, 200, null);
    }

    // What a pane attaches to. The scrollback above stays for readers that predate it.
    const screen = matchPath(path, "/v1/terminals/:id/screen");
    if (screen && method === "GET") {
      const snapshot = await terminals.screen(screen.id!);
      return jsonResponse({
        offset: snapshot.offset,
        data: Buffer.from(snapshot.data, "utf8").toString("base64"),
        rows: snapshot.rows,
        cols: snapshot.cols,
      }, 200, null);
    }

    const clear = matchPath(path, "/v1/terminals/:id/clear");
    if (clear && method === "POST") {
      terminals.clear(clear.id!);
      return emptyResponse(204, null);
    }

    const colors = matchPath(path, "/v1/terminals/:id/colors");
    if (colors && method === "POST") {
      terminals.colors(colors.id!, terminalColors(body));
      return emptyResponse(204, null);
    }

    const input = matchPath(path, "/v1/terminals/:id/input");
    if (input && method === "POST") {
      const data = typeof body.data === "string" ? body.data : "";
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new HttpError(422, "invalid_args", "data must be base64");
      terminals.write(input.id!, new Uint8Array(Buffer.from(data, "base64")));
      return emptyResponse(204, null);
    }

    const resize = matchPath(path, "/v1/terminals/:id/resize");
    if (resize && method === "POST") {
      return jsonResponse(terminals.resize(resize.id!, numberOr(body.rows) ?? 24, numberOr(body.cols) ?? 80), 200, null);
    }

    const signal = matchPath(path, "/v1/terminals/:id/signal");
    if (signal && method === "POST") {
      const name = typeof body.signal === "string" ? body.signal : "";
      if (!["SIGINT", "SIGQUIT", "SIGTSTP", "SIGTERM", "SIGKILL"].includes(name)) {
        throw new HttpError(422, "invalid_args", "unknown signal");
      }
      terminals.signal(signal.id!, name as PtySignal);
      return emptyResponse(204, null);
    }

    const watch = matchPath(path, "/v1/terminals/:id/watch");
    if (watch && method === "POST") {
      const id = terminals.get(watch.id!).id;
      const from = numberOr(body.from) ?? 0;
      watchStream(id, watcher, Math.max(0, from));
      return jsonResponse(terminals.get(id), 200, null);
    }

    const unwatch = matchPath(path, "/v1/terminals/:id/unwatch");
    if (unwatch && method === "POST") {
      unwatchStream(unwatch.id!, watcher);
      return emptyResponse(204, null);
    }

    throw new HttpError(404, "not_found", "unknown route");
  }

  async function readBusiness(request: Request, url: URL, scope?: RequestScope): Promise<Response> {
    const path = url.pathname;
    if (request.method === "GET" && path === "/v1/snapshot") {
      await options.store.hydrateSnapshot();
      const snapshot = options.store.db.transaction((): RuntimeSnapshot => {
        const state = options.store.readSnapshot();
        return {
          ...state,
          bots: state.bots.map(displayBot),
          sessions: snapshotSessions(state.sessions),
          notificationCapabilities: {
            inbox_v1: true,
            bounded_read_v1: true,
            pending_ask_v1: true,
            policy_v1: Boolean(options.policyV1),
            push_settings_v2: Boolean(options.pushSettingsV2),
          },
          ...events.cursor(),
          ...(options.remoteStatus ? { remoteStatus: options.remoteStatus() } : {}),
        };
      })();
      return jsonResponse(snapshot, 200, null);
    }
    const clickMatch = matchPath(path, "/v1/notifications/desktop/click/:ref");
    if (request.method === "GET" && clickMatch) {
      if (scope?.deviceId && scope.deviceId !== "local") {
        throw new HttpError(404, "not_found", "unknown route");
      }
      const res = notificationScheduler.resolveClick(clickMatch.ref!);
      return jsonResponse(res ?? { open_inbox: false }, 200, null);
    }
    if (request.method === "GET" && path === "/v1/notifications/desktop/state") {
      if (scope?.deviceId && scope.deviceId !== "local") {
        throw new HttpError(404, "not_found", "unknown route");
      }
      return jsonResponse(notificationScheduler.getState(), 200, null);
    }
    if (request.method === "GET" && path === "/v1/notifications") {
      const filterParam = url.searchParams.get("filter") ?? "actionable";
      if (filterParam !== "actionable" && filterParam !== "unread" && filterParam !== "all") {
        throw new HttpError(422, "invalid_args", "filter must be actionable, unread, or all");
      }
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new HttpError(422, "invalid_args", "limit must be an integer between 1 and 100");
      }
      const cursor = url.searchParams.get("cursor");
      const result = options.store.db.transaction(() => {
        const res = options.store.listNotifications({
          filter: filterParam as NotificationFilter,
          limit,
          cursor: cursor || null,
        });
        return { ...res, ...events.cursor() };
      })();
      return jsonResponse(result, 200, null);
    }
    if (request.method === "GET" && path === "/v1/notifications/push-config") {
      if (scope?.deviceId && scope.deviceId !== "local") {
        throw new HttpError(404, "not_found", "unknown route");
      }
      return jsonResponse(options.store.getNotificationPushConfig(), 200, null);
    }
    const notifDetail = matchPath(path, "/v1/notifications/:id");
    if (request.method === "GET" && notifDetail && notifDetail.id !== "read" && notifDetail.id !== "desktop" && notifDetail.id !== "push-config") {
      const notif = options.store.getNotification(notifDetail.id!);
      if (!notif) {
        throw new HttpError(404, "not_found", "notification not found");
      }
      return jsonResponse(notif, 200, null);
    }
    if (request.method === "GET" && path === "/v1/notification-policy") {
      if (!options.policyV1) {
        throw new HttpError(409, "capability_unavailable", "notification policy is unavailable in this version");
      }
      return jsonResponse(options.store.getNotificationPolicy(), 200, null);
    }
    if (request.method === "GET" && path === "/v1/notification-device") {
      if (!options.policyV1) {
        throw new HttpError(409, "capability_unavailable", "notification policy is unavailable in this version");
      }
      const receiverId = scope?.deviceId && scope.deviceId !== "local" ? scope.deviceId : "desktop";
      return jsonResponse(options.store.getNotificationDevice(receiverId), 200, null);
    }
    const session = matchPath(path, "/v1/sessions/:id/snapshot");
    if (request.method === "GET" && session) {
      const id = session.id!;
      const limitText = url.searchParams.get("limit");
      const messageLimit = limitText ? Number(limitText) : undefined;
      const snapshot = options.store.db.transaction((): SessionSnapshot => {
        const session = options.store.getSession(id, { messageLimit });
        return {
          session: { ...session, turns: session.turns.map(withPartial), pending_judgements: engine.pendingJudgements(id) },
          judgements: options.store.listJudgements(id), ...events.cursor(),
        };
      })();
      return jsonResponse(snapshot, 200, null);
    }
    if (request.method === "GET" && path === "/v1/events/catchup") {
      const instance = url.searchParams.get("event_instance_id") ?? "";
      const rawSeq = url.searchParams.get("after_seq") ?? "";
      if (!/^[0-9a-f]{32}$/.test(instance) || !/^(0|[1-9][0-9]*)$/.test(rawSeq) || !Number.isSafeInteger(Number(rawSeq))) {
        throw new HttpError(422, "invalid_args", "invalid event cursor");
      }
      return jsonResponse(events.catchup({ event_instance_id: instance, watermark_seq: Number(rawSeq) }), 200, null);
    }
    if (path === "/v1/terminals" || path.startsWith("/v1/terminals/") || path.startsWith("/v1/streams/")) {
      return terminalRoute(request, url, scope);
    }
    return dispatch(request, url, options, publish, engine, mcp, { body: request.method === "POST" ? await readJson(request) as Record<string, unknown> : {}, files: [], multipart: false }, scope, notificationScheduler, presence);
  }

  /**
   * `POST /v1/capabilities/raise { accept_older_app: true }` records the opt-in (`by` says whether
   * `scripts/engine-level.ts` sent it) and takes the level up now; `DELETE` takes the opt-in back,
   * which never lowers the level. Either answers with the capabilities as they now stand.
   */
  async function engineLevelRoute(request: Request): Promise<CapabilitiesResponse> {
    const { store } = options;
    if (request.method === "DELETE") {
      store.withdrawOlderAppOptIn();
      options.log?.(`took back the developer's opt-in past an older installed app; engine level stays at ${store.capabilities().engine_level}`);
      return store.capabilities();
    }
    const body = (await readJson(request)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || body.accept_older_app !== true) {
      throw new HttpError(400, "invalid_args", "accept_older_app: true is required: the installed app, opened without this daemon running, would not honor holds");
    }
    if (body.by !== undefined && body.by !== "api" && body.by !== "script") throw new HttpError(400, "invalid_args", "by must be api or script");
    if (body.level !== undefined && (typeof body.level !== "number" || !Number.isInteger(body.level) || body.level < 1 || body.level > ENGINE_LEVEL)) {
      throw new HttpError(400, "invalid_args", `level must be an integer from 1 to ${ENGINE_LEVEL}`);
    }
    store.acceptOlderApp(body.by === "script" ? "script" : "api", body.level as number | undefined);
    const before = store.capabilities().engine_level;
    // Already at the top: only the opt-in is recorded. Catching up again would take over plans the
    // organizer parked since boot as holds mid-run, which is the next boot's job.
    if (before >= ENGINE_LEVEL) return store.capabilities();
    for (const line of store.catchUpEngineLevel(options.installedApp?.() ?? null)) options.log?.(line);
    // A higher level renders some defaults differently: merge them into the prompts you edited (ADR 0064).
    for (const line of reconcilePrompts(store)) options.log?.(`prompts: ${line}`);
    if (store.capabilities().engine_level > before) {
      // Plans taken over as holds end whatever still runs in them, as any new hold does.
      engine.enforceHolds();
      // The snapshot now carries `holds`, which is what shows the stop menus; no event says so.
      events.resnapshot();
    }
    return store.capabilities();
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
      validateRequestPath(path + url.search);
      if (request.method === "POST" && path === "/v1/runtime/quit") {
        scheduler?.stop();
      }
      if (request.method === "GET" && path === "/v1/runtime/drain") {
        return jsonResponse(quiesce.state(), 200, origin);
      }
      if (request.method === "POST" && path === "/v1/runtime/quiesce") {
        const body = (await readJson(request)) as Record<string, unknown>;
        const action = typeof body.action === "string" ? body.action : "";
        if (action === "begin") return jsonResponse(quiesce.begin(), 200, origin);
        if (action === "wait") return jsonResponse(await quiesce.wait(), 200, origin);
        if (action === "cancel") return jsonResponse(quiesce.cancel(), 200, origin);
        if (action === "force") return jsonResponse(quiesce.force(), 200, origin);
        throw new HttpError(422, "invalid_args", "action must be begin, wait, cancel, or force");
      }
      // The remote screen is the Mac's to allow: these never pass the business dispatch a phone
      // reaches, so no paired device can turn it on, widen its ICE servers, or see who else is in.
      if (path === "/v1/remote/screen" && options.screen && (request.method === "GET" || request.method === "PUT")) {
        if (request.method === "PUT") return jsonResponse(await options.screen.configure(await readJson(request)), 200, origin);
        await options.screen.probe();
        return jsonResponse(options.screen.status(), 200, origin);
      }
      // Your own Claude Code as the daemon finds it (ADR 0061). Local only, like the routes around
      // it: reading it may run `claude --version` and `claude auth status`, never anything that
      // touches its credentials, and a phone has no business pointing the daemon at a program.
      if (path === "/v1/runtime/claude-code" && request.method === "GET") {
        return jsonResponse(await claudeCode.current(), 200, origin);
      }
      if (path === "/v1/runtime/claude-code/detect" && request.method === "POST") {
        return jsonResponse(await claudeCode.detect(), 200, origin);
      }
      if (path === "/v1/runtime/claude-code/path" && request.method === "PUT") {
        const body = (await readJson(request)) as Record<string, unknown>;
        options.store.setClaudeCodePath(body.path ?? null);
        return jsonResponse(await claudeCode.detect(), 200, origin);
      }
      if (request.method === "POST" && path === "/v1/remote/screen/disconnect" && options.screen) {
        options.screen.endAll();
        return jsonResponse(options.screen.status(), 200, origin);
      }
      if (request.method === "POST" && path === "/v1/remote/setup") {
        if (!options.devSetup) throw new HttpError(404, "not_found", "unknown route");
        const body = (await readJson(request)) as Record<string, unknown>;
        return jsonResponse(await options.devSetup(body) as Record<string, unknown>, 200, origin);
      }
      if (request.method === "POST" && path === "/v1/runtime/handoff") {
        options.onHandoff?.();
        return emptyResponse(204, origin);
      }
      if (request.method === "POST" && path === "/v1/runtime/stop") {
        terminals.shutdown();
        await options.lifecycle?.writeStopLatch();
        options.onRuntimeStop?.();
        return emptyResponse(204, origin);
      }
      // Local only, like the routes above, and never through the business dispatch a phone reaches
      // (ADR 0041): a developer's word that this data folder may go up past an older installed app,
      // carried out now, the way boot would carry it out, instead of at the next start.
      if (path === "/v1/capabilities/raise" && (request.method === "POST" || request.method === "DELETE")) {
        return jsonResponse(await engineLevelRoute(request), 200, origin);
      }
      // Quit stops the processes. The rows stay, so the next start puts each shell back where it was.
      if (request.method === "POST" && path === "/v1/runtime/quit") terminals.shutdown();
      const isMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(request.method) && !isNonReceiptPath(path);
      const response = isMutation
        ? await mutate(request, url, { deviceId: "local", requestId: request.headers.get("X-Request-Id") ?? ulid() })
        : await readBusiness(request, url);
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
    subscribeSync: (listener) => events.subscribe(listener),
    syncCursor: () => events.cursor(),
    terminals,
    streams,
    watchStream,
    unwatchStream,
    subscribeStreams: (listener) => {
      streamListeners.add(listener);
      return () => streamListeners.delete(listener);
    },
    subscribeTools: (listener) => {
      toolListeners.add(listener);
      return () => toolListeners.delete(listener);
    },
    quiesce,
    publish,
    engine,
    presence,
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
        if (!parsed || typeof parsed !== "object" || parsed.type !== "auth" || parsed.token !== options.token ||
          (parsed.protocol !== undefined && parsed.protocol !== "sync-v1")) {
          ws.close(4001, "unauthorized");
          return;
        }
        ws.data.authed = true;
        ws.data.sync = parsed.protocol === "sync-v1";
        if (ws.data.sync) send(ws, JSON.stringify({ type: "ready", ...events.cursor() }));
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

function dispatch(
  request: Request,
  url: URL,
  options: LocalApiOptions,
  publish: (event: ClientEvent) => void,
  engine: TurnEngine,
  mcp: McpHost,
  input: ParsedMutation,
  scope?: RequestScope,
  notificationScheduler?: NotificationDeliveryScheduler,
  presence?: PresenceManager,
): Response | Promise<Response> {
  const { store, onQuit } = options;
  const method = request.method;
  const path = url.pathname;
  const ctx: RouteCtx = { request, url, options, publish, engine, mcp, input, scope, notificationScheduler, presence, store, onQuit, method, path };
  // Each group answers only the paths it owns and returns null for the rest; the groups keep the
  // order their checks had when this was one function, so the first match still wins.
  const routed = systemRoutes(ctx)
    ?? botAndSessionRoutes(ctx)
    ?? planRoutes(ctx)
    ?? qualityAndPromptRoutes(ctx)
    ?? notificationRoutes(ctx)
    ?? messageRoutes(ctx)
    ?? configRoutes(ctx);
  if (routed !== null) return routed;

  return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404, null);
}
