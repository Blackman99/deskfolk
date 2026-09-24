import {
  FILE_DROP_SESSION_ID,
  LOCAL_API_BIND,
  LOCAL_API_NAME,
  REACTION_EMOJI,
  USER_MEMBER,
  type ClientEvent,
  type CreateProviderRequest,
  type HealthResponse,
  type PatchProviderRequest,
  type CreateRoutineRequest,
  type PatchRoutineRequest,
  type CreateBotRequest,
  type PatchBotRequest,
  type RuntimeResponse,
  type WsAuthMessage,
  type RuntimeSnapshot,
  type SessionSnapshot,
  type SessionSummary,
  type NotificationFilter,
  type SpendFilter,
  type SpendKind,
  type StreamFrame,
  type ToolFrame,
  type AnnotationFilter,
  type CreateAnnotationRequest,
  type PatchAnnotationRequest,
  type SendAnnotationsRequest,
  isNonReceiptPath,
} from "@real-bot/protocol";
import { existsSync, readFileSync, statSync } from "node:fs";
import { attachmentMime } from "./artifact-mime";
import { emptyResponse, fromError, jsonResponse, matchPath, readBearer, readJson, responseRecord } from "./http";
import { corsHeaders, originDecision } from "./origin";
import { EventStream, sessionUpsertFields } from "./session-events";
import { StreamHub, type StreamRead } from "./streams";
import { Terminals } from "./terminals";
import { ensureZshIntegration } from "./terminal-env";
import type { PtySignal } from "./pty";
import { HttpError } from "./errors";
import { type AttachmentInput, type Store } from "./store";
import type { CompletionsClient } from "./completions";
import { createMcpHost, persistMcpInspect, type McpHost } from "./mcp-host";
import { COLLAB_TOOL_NAMES } from "./prompts";
import { startScheduler, type Scheduler } from "./scheduler";
import { createTurnEngine, type TurnEngine } from "./turn-engine";
import { probeEndpointModels } from "./probe-models";
import type { FileCommit } from "./store/files";
import type { RouteLearningRow, RouteReviewRow } from "./store/routing";
import { ulid } from "./ids";
import { requestDigest, normalizeFiles, validateRequestPath, type NormalizedFile, type CanonicalEncoder } from "./request-digest";
import { type RequestScope, type KeyOperation } from "./store/receipts";
import { fileEtag } from "./file-integrity";
import { fileRangeResponse } from "./file-range";
import { parseImageVariant, reduceImage, type ImageVariant } from "./image-variant";
import { displayAvatar, isDisplayAvatar, warmDisplayAvatar, withoutDisplayMark } from "./avatar-display";
import { REMOTE_FILE_LIMIT } from "@real-bot/remote";
import { Quiesce, TurnAdmission } from "./quiesce";
import type { RuntimeLifecycle } from "./lifecycle";
import { listWorkspaceDir, locateWorkspaceFile, writeWorkspaceFile } from "./workspace-browse";
import { listHostDir } from "./host-paths";
import { PresenceManager, NotificationDeliveryScheduler } from "./notifications";

const AUTH_TIMEOUT_MS = 5_000;
const REACTIONS = new Set<string>(REACTION_EMOJI);

type SocketData = {
  authed: boolean;
  sync?: boolean;
};

/** Stands for every window socket at once: there is one window, and it either watches or does not. */
export const LOCAL_WATCHER = "local" as const;

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
  admission?: TurnAdmission;
  remoteStatus?: () => NonNullable<RuntimeSnapshot["remoteStatus"]>;
  /**
   * Dev-only bridge to the pairing side of the setup channel. The packaged window reaches it over
   * its inherited socketpair, which a source build has no way to obtain; absent in production, and
   * the route 404s without it.
   */
  devSetup?: (request: unknown) => Promise<unknown>;
  runtimeInfo?: () => RuntimeResponse;
  lifecycle?: RuntimeLifecycle;
  onHandoff?: () => void;
  onRuntimeStop?: () => void;
  policyV1?: boolean;
  pushSettingsV2?: boolean;
  /** Where Deskfolk's own zsh shell integration is written, for terminals the person opens. */
  dataDir?: string;
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
  quiesce: Quiesce;
  subscribeSync: EventStream["subscribe"];
  syncCursor: EventStream["cursor"];
  terminals: Terminals;
  streams: StreamHub;
  /** Start sending a stream to one watcher, from a byte offset, with its backlog first. */
  watchStream: (id: string, watcher: string, from: number) => void;
  unwatchStream: (id: string, watcher: string) => void;
  /** Stream frames, with the watchers they are meant for; the remote link routes by device id. */
  subscribeStreams: (listener: (id: string, read: StreamRead, watchers: readonly string[]) => void) => () => void;
  subscribeTools: (listener: (frame: ToolFrame) => void) => () => void;
  presence: PresenceManager;
};

export function createLocalApi(options: LocalApiOptions): LocalApi {
  options = { ...options, admission: options.admission ?? new TurnAdmission() };
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
      sleep: options.sleep,
      mcp,
      admission: options.admission,
      streams,
    });

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
    return { ...turn, partial_text: turn.partial_text ?? engine.partialText(turn.id) };
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
    if (!url.pathname.startsWith("/v1/") || url.pathname.startsWith("/v1/runtime")) {
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

function occurred(): string {
  return new Date().toISOString();
}

/** A verdict as clients read it: the row, and what the next same-kind choice made of it. */
function reviewOut(store: Store, row: RouteReviewRow) {
  return {
    chain_id: row.chain_id,
    turn_id: row.turn_id,
    session_id: row.session_id,
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
    retired_at: row.retired_at,
    effect: store.reviewEffect(row),
  };
}

/** A learning note as clients read it: the row, and whether later same-kind chains got shorter. */
function learningOut(store: Store, row: RouteLearningRow) {
  return { ...row, outcome: store.learningOutcome({ botId: row.bot_id, chainId: row.chain_id }) };
}

/** The command line out of a `shell` call's arguments, so a finished row can name itself. */
function shellCommandOf(name: string | undefined, args: string | undefined): string | undefined {
  if (name !== "shell" || !args) return undefined;
  try {
    const parsed = JSON.parse(args) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

/** A pane's colours: `#rrggbb` text and background, optionally a cursor and the sixteen ANSI colours. */
function terminalColors(body: Record<string, unknown>): { foreground: string; background: string; cursor?: string; palette?: string[] } {
  const hex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
  const { foreground, background, cursor, palette } = body;
  if (!hex(foreground) || !hex(background) || (cursor !== undefined && !hex(cursor))
    || (palette !== undefined && !(Array.isArray(palette) && palette.length <= 16 && palette.every(hex)))) {
    throw new HttpError(422, "invalid_args", "colours are #rrggbb");
  }
  return { foreground, background, ...(cursor ? { cursor } : {}), ...(palette ? { palette: palette as string[] } : {}) };
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A file's bytes, or with `size` a smaller copy of the picture. The copy is announced by
 * `X-Original-Size`, the original's length, so a client can offer the original and say what it
 * costs; without the header the bytes are the original. The remote cap applies to what is sent,
 * so a picture too large to send whole can still be shown scaled.
 */
/** A Bot as clients are sent it: its portrait as the small marked copy (see avatar-display). */
function displayBot<T extends { avatar: string | null }>(bot: T): T {
  return { ...bot, avatar: displayAvatar(bot.avatar) };
}

async function fileResponse(abs: string, mime: string, filename: string, variant: ImageVariant | null, remote: boolean, range: string | null): Promise<Response> {
  if (range !== null) {
    if (variant) throw new HttpError(422, "invalid_args", "range cannot be combined with image size");
    return fileRangeResponse(abs, mime, filename, range, remote);
  }
  const reduced = variant ? await reduceImage(abs, mime, variant) : null;
  if (!reduced && remote && statSync(abs).size > REMOTE_FILE_LIMIT) throw new HttpError(413, "file_limit", "remote file limit exceeded");
  const file = reduced?.bytes ?? readFileSync(abs);
  return new Response(file, {
    status: 200,
    headers: {
      "ETag": fileEtag(file),
      "Content-Type": reduced?.mime ?? mime,
      "Content-Length": String(file.byteLength),
      "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
      ...(reduced ? { "X-Original-Size": String(statSync(abs).size) } : {}),
    },
  });
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
      if (!current || (current.kind === "direct" && !["running", "waiting_approval", "waiting_ask"].includes(current.status))) return emptyResponse(204, null);
    }
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
    return fileResponse(located.abs, located.mime, located.rel.split("/").pop() ?? located.rel, variant, url.hostname === "remote.invalid", url.searchParams.get("range") ?? request.headers.get("Range"));
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
      request.signal.throwIfAborted();
      const probed = await probeEndpointModels(baseUrl, apiKey, fetch, request.signal, { guard: scope?.guard });
      scope?.guard?.();
      return jsonResponse({ models: probed.models, catalog: probed.catalog }, 200, null);
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
  if (params && method === "DELETE") {
    const previousBots = store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
    store.deleteProviderSync(params.id!);
    const at = occurred();
    publishBotModelChanges(store, previousBots, at, publish);
    return emptyResponse(204, null);
  }

  if (method === "GET" && path === "/v1/bots") {
    return jsonResponse({ items: store.listBots().map(displayBot) }, 200, null);
  }

  if (method === "POST" && path === "/v1/bots") {
    let body = (input.body) as CreateBotRequest;
    // A portrait copied from another Bot's card is that picture: keep it, without the mark.
    if (typeof body.avatar === "string" && isDisplayAvatar(body.avatar)) body = { ...body, avatar: withoutDisplayMark(body.avatar) };
    const created = store.createBot(body);
    const at = occurred();
    publish({ event: "bot.upsert", occurred_at: at, ...created.bot, deleted_at: null });
    publish({
      event: "session.upsert",
      occurred_at: at,
      ...sessionUpsertFields(created.direct_session),
    });
    return jsonResponse({ ...created, bot: displayBot(created.bot) }, 201, null);
  }

  params = matchPath(path, "/v1/bots/:id/archive");
  if (params && method === "POST") {
    const bot = store.archiveBot(params.id!);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: null });
    return jsonResponse(displayBot(bot), 200, null);
  }
  params = matchPath(path, "/v1/bots/:id/restore");
  if (params && method === "POST") {
    const bot = store.restoreBot(params.id!);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: null });
    return jsonResponse(displayBot(bot), 200, null);
  }
  params = matchPath(path, "/v1/bots/:id/profile-revisions");
  if (params && method === "GET") {
    return jsonResponse({ items: store.listProfileRevisions(params.id!) }, 200, null);
  }
  params = matchPath(path, "/v1/bots/:id");
  if (params && method === "GET") {
    return jsonResponse(displayBot(store.getBot(params.id!)), 200, null);
  }
  if (params && method === "PATCH") {
    let body = (input.body) as PatchBotRequest;
    // A profile save sends back the portrait it was shown with every other edit. That is the
    // small copy, never a new picture: the stored original stays.
    if (typeof body.avatar === "string" && isDisplayAvatar(body.avatar)) {
      const { avatar: _shown, ...rest } = body;
      body = rest;
    }
    const bot = store.patchBot(params.id!, body);
    publish({ event: "bot.upsert", occurred_at: occurred(), ...bot, deleted_at: null });
    return jsonResponse(displayBot(bot), 200, null);
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
    options.admission?.assertNew();
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
    if (Array.isArray(body.files) && body.files.length && !fileInputs.length) {
      throw new HttpError(422, "invalid_args", "remote file bytes must arrive on type 0x05");
    }

    const sessionId = params.id!;
    if (askId) {
      engine.assertAskPending(askId, sessionId);
    } else {
      options.admission?.assertNew();
    }
    const fileDrop = sessionId === FILE_DROP_SESSION_ID;
    if (fileDrop && askId) {
      throw new HttpError(422, "invalid_args", "the file drop does not answer asks");
    }
    const message = store.transaction(() => {
      const msg = store.postMessage(sessionId, {
        body: bodyText,
        parent_id: parentId,
        attachments: fileInputs.length > 0 ? fileInputs : undefined,
      });
      if (askId) {
        engine.replyAsk(askId, msg);
      }
      return msg;
    });
    publish({ event: "message.created", occurred_at: occurred(), ...message });
    // A file dropped here is already in inbox/. Nothing is woken.
    if (!askId && !fileDrop) {
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
    options.admission?.assertNew();
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

  params = matchPath(path, "/v1/tasks/:id/artifacts");
  if (params && method === "GET") {
    const task = store.getTask(params.id!);
    return jsonResponse(
      {
        id: task.id,
        dir: task.dir,
        title: task.title,
        closed_at: task.closed_at,
        items: store.taskArtifacts(task.id, store.citedPathExists),
      },
      200,
      null,
    );
  }

  params = matchPath(path, "/v1/tasks/:id/trace");
  if (params && method === "GET") {
    const trace = store.taskTrace(params.id!);
    // Each card carries the model choice its turn ran on, so the board is where it is read.
    const records = new Map(store.listTaskRoutes(params.id!).map((record) => [record.turn_id, record]));
    const reviews = new Map(store.listTaskReviews(params.id!).map((row) => [row.turn_id, reviewOut(store, row)]));
    const learnings = new Map(store.listTaskLearnings(params.id!).map((row) => [row.chain_id, learningOut(store, row)]));
    // A card's files open the preview as its tree; one deleted since must not come back there.
    const cited = new Set(trace.nodes.flatMap((node) => node.artifacts.map((file) => file.path)));
    const gone = store.transaction(() => new Set([...cited].filter((file) => !store.citedPathExists(file))));
    return jsonResponse(
      {
        ...trace,
        nodes: trace.nodes.map((node) => {
          const record = records.get(node.turn_id);
          const routed = {
            ...node,
            artifacts: node.artifacts.map((file) => ({ ...file, exists: !gone.has(file.path) })),
            route: record
              ? {
                  record,
                  review: reviews.get(node.turn_id) ?? null,
                  // A chain is named after the turn that started it; its note belongs there.
                  learning: record.chain_id === record.turn_id ? (learnings.get(record.chain_id) ?? null) : null,
                }
              : null,
          };
          // A live turn's sentence lives in the engine, not the row, the same way a session's turns do.
          if (node.status !== "running") return routed;
          const live = engine.partialText(node.turn_id)?.replace(/\s+/g, " ").trim();
          return live ? { ...routed, summary: [...live].slice(0, 80).join("") } : routed;
        }),
      },
      200,
      null,
    );
  }

  params = matchPath(path, "/v1/sessions/:id/tasks");
  if (params && method === "GET") {
    store.getSession(params.id!);
    return jsonResponse({ items: store.sessionTasks(params.id!) }, 200, null);
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
        reviews: store.listSessionReviews(params.id!).map((row) => reviewOut(store, row)),
        learnings: store.listSessionLearnings(params.id!).map((row) => learningOut(store, row)),
      },
      200,
      null,
    );
  }

  params = matchPath(path, "/v1/sessions/:id/composer-suggestions");
  if (params && method === "GET") {
    store.getSession(params.id!);
    return engine.suggestComposer(params.id!, request.signal, scope?.guard).then((items) => jsonResponse({ items }, 200, null), () => jsonResponse({ items: [] }, 200, null));
  }

  params = matchPath(path, "/v1/sessions/:id/read");
  if (params && method === "POST") {
    const body = input.body as { through_message_id?: string };
    if (
      body &&
      body.through_message_id !== undefined &&
      (typeof body.through_message_id !== "string" ||
        !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(body.through_message_id))
    ) {
      throw new HttpError(422, "invalid_args", "through_message_id must be a valid ULID");
    }
    const session = store.markSessionRead(
      params.id!,
      body?.through_message_id ? { through_message_id: body.through_message_id } : undefined,
    );
    publish({
      event: "session.upsert",
      occurred_at: occurred(),
      ...sessionUpsertFields(session),
    });
    // The read state, not the transcript: a client already has the messages it just read, and
    // on a phone the whole detail was 150 KB every time a conversation was opened.
    const { messages: _messages, turns: _turns, pending_judgements: _pending, ...summary } = session;
    return jsonResponse(summary satisfies SessionSummary, 200, null);
  }

  if (method === "POST" && path === "/v1/notifications/read") {
    const body = input.body as Record<string, unknown>;
    if (Array.isArray(body.ids)) {
      if (
        body.ids.length === 0 ||
        body.ids.length > 100 ||
        !body.ids.every((id) => typeof id === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))
      ) {
        throw new HttpError(422, "invalid_args", "ids must be 1-100 valid ULIDs");
      }
      store.markNotificationsReadBatch({ ids: body.ids as string[] });
      return emptyResponse(204, null);
    } else if (body.through_ordinal !== undefined) {
      if (
        body.filter !== "all" ||
        typeof body.through_ordinal !== "number" ||
        !Number.isInteger(body.through_ordinal) ||
        body.through_ordinal < 0
      ) {
        throw new HttpError(
          422,
          "invalid_args",
          "through_ordinal must be a non-negative integer and filter must be 'all'",
        );
      }
      store.markNotificationsReadBatch({ through_ordinal: body.through_ordinal, filter: "all" });
      return emptyResponse(204, null);
    }
    throw new HttpError(422, "invalid_args", "must provide either ids or through_ordinal with filter 'all'");
  }

  if (method === "POST" && path === "/v1/notifications/retention-notice/read") {
    store.markRetentionNoticeRead();
    return emptyResponse(204, null);
  }

  const ackMatch = matchPath(path, "/v1/notifications/:id/acknowledge");
  if (method === "POST" && ackMatch) {
    const body = input.body as Record<string, unknown>;
    if (
      typeof body.if_revision !== "number" ||
      !Number.isInteger(body.if_revision) ||
      body.if_revision < 0
    ) {
      throw new HttpError(422, "invalid_args", "if_revision must be a non-negative integer");
    }
    const item = store.acknowledgeNotification(ackMatch.id!, body.if_revision);
    return jsonResponse(item, 200, null);
  }

  if (method === "PATCH" && path === "/v1/notification-policy") {
    if (!options.policyV1) {
      throw new HttpError(409, "capability_unavailable", "notification policy is unavailable in this version");
    }
    const body = input.body as Record<string, unknown>;
    if (typeof body.if_revision !== "number" || !Number.isInteger(body.if_revision)) {
      throw new HttpError(422, "invalid_args", "if_revision is required");
    }
    const updated = store.updateNotificationPolicy(body as any);
    return jsonResponse(updated, 200, null);
  }

  if (method === "PATCH" && path === "/v1/notification-device") {
    if (!options.policyV1) {
      throw new HttpError(409, "capability_unavailable", "notification policy is unavailable in this version");
    }
    const receiverId = scope?.deviceId && scope.deviceId !== "local" ? scope.deviceId : "desktop";
    const body = input.body as Record<string, unknown>;
    if (typeof body.if_revision !== "number" || !Number.isInteger(body.if_revision)) {
      throw new HttpError(422, "invalid_args", "if_revision is required");
    }
    if (receiverId !== "desktop") {
      if (body.enabled !== undefined) {
        throw new HttpError(422, "invalid_args", "remote device enabled must be changed via push subscribe/unsubscribe");
      }
      if ((body.preview !== undefined && body.preview !== "generic") || (body.sound !== undefined && body.sound !== "system")) {
        throw new HttpError(422, "invalid_args", "remote devices must use generic preview and system sound");
      }
    }
    const updated = store.updateNotificationDevice(receiverId, body as any);
    return jsonResponse(updated, 200, null);
  }

  if (method === "PATCH" && path === "/v1/notifications/push-config") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const body = input.body as Record<string, unknown>;
    if (typeof body.if_revision !== "number" || !Number.isInteger(body.if_revision) || body.if_revision < 0) {
      throw new HttpError(422, "invalid_args", "if_revision is required");
    }
    if (!Object.hasOwn(body, "contact_uri")) {
      throw new HttpError(422, "invalid_args", "contact_uri is required");
    }
    const contactUri = body.contact_uri === null ? null : (typeof body.contact_uri === "string" ? body.contact_uri : undefined);
    if (contactUri === undefined) {
      throw new HttpError(422, "invalid_args", "contact_uri must be string or null");
    }
    const updated = store.updateNotificationPushConfig(contactUri, body.if_revision);
    return jsonResponse(updated, 200, null);
  }

  const prefMatch = matchPath(path, "/v1/sessions/:id/notification-preference");
  if (method === "PUT" && prefMatch) {
    if (!options.policyV1) {
      throw new HttpError(409, "capability_unavailable", "notification policy is unavailable in this version");
    }
    const body = input.body as Record<string, unknown>;
    if (typeof body.muted !== "boolean" || typeof body.if_revision !== "number" || !Number.isInteger(body.if_revision)) {
      throw new HttpError(422, "invalid_args", "muted (boolean) and if_revision (integer) are required");
    }
    const updated = store.setSessionNotificationPreference(prefMatch.id!, body.muted, body.if_revision);
    return jsonResponse(updated, 200, null);
  }

  if (method === "POST" && path === "/v1/notification-presence") {
    const body = input.body as Record<string, unknown>;
    if (
      typeof body.instance_id !== "string" ||
      typeof body.visible !== "boolean" ||
      typeof body.focused !== "boolean" ||
      (body.session_id !== null && body.session_id !== undefined && typeof body.session_id !== "string") ||
      typeof body.at_latest !== "boolean"
    ) {
      throw new HttpError(422, "invalid_args", "invalid presence fields");
    }
    const receiverId = scope?.deviceId && scope.deviceId !== "local" ? scope.deviceId : "desktop";
    presence?.update(receiverId, body as any);
    return emptyResponse(204, null);
  }

  if (method === "POST" && path === "/v1/notifications/desktop/claim") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const body = input.body as Record<string, unknown>;
    if (
      typeof body.owner_id !== "string" ||
      !body.owner_id ||
      (body.permission !== "granted" && body.permission !== "denied" && body.permission !== "default")
    ) {
      throw new HttpError(422, "invalid_args", "invalid claim request fields");
    }
    const claimed = notificationScheduler?.claimDesktop(body as any);
    if (!claimed) return emptyResponse(204, null);
    return jsonResponse(claimed, 200, null);
  }

  if (method === "POST" && path === "/v1/notifications/desktop/revalidate") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const body = input.body as Record<string, unknown>;
    if (typeof body.delivery_id !== "string" || typeof body.claim_token !== "string") {
      throw new HttpError(422, "invalid_args", "delivery_id and claim_token are required");
    }
    const result = notificationScheduler?.revalidateDesktop(body as any);
    return jsonResponse(result ?? { action: "cancel" }, 200, null);
  }

  if (method === "POST" && path === "/v1/notifications/desktop/report") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const body = input.body as Record<string, unknown>;
    if (
      typeof body.delivery_id !== "string" ||
      typeof body.claim_token !== "string" ||
      (body.result !== "accepted" && body.result !== "failed" && body.result !== "unknown")
    ) {
      throw new HttpError(422, "invalid_args", "delivery_id, claim_token, and valid result are required");
    }
    notificationScheduler?.reportDesktop(body as any);
    return emptyResponse(204, null);
  }

  if (method === "POST" && path === "/v1/notifications/desktop/reconcile") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const body = input.body as Record<string, unknown>;
    if (!Array.isArray(body.identifiers)) {
      throw new HttpError(422, "invalid_args", "identifiers array required");
    }
    const result = notificationScheduler?.reconcile(body as any);
    return jsonResponse(result ?? { remove_identifiers: [] }, 200, null);
  }

  if (method === "POST" && path === "/v1/notifications/desktop/test") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const result = notificationScheduler?.testDesktop();
    return jsonResponse(result ?? { ok: true, status: "queued" }, 200, null);
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
    const variant = parseImageVariant(url.searchParams.get("size"));
    const mime = attachmentMime(att.original_filename, att.workspace_relpath);
    return fileResponse(located.abs, mime, att.original_filename, variant, url.hostname === "remote.invalid", url.searchParams.get("range") ?? request.headers.get("Range"));
  }

  params = matchPath(path, "/v1/attachments/:id");
  if (params && method === "GET") {
    const att = store.getAttachment(params.id!);
    return jsonResponse(att, 200, null);
  }

  // Annotations: drafts you keep on an artifact, sent as one quoted reply that wakes the Bot.
  if (method === "GET" && path === "/v1/annotations") {
    const q = url.searchParams;
    const filter: AnnotationFilter = {};
    for (const key of ["relpath", "session_id", "target_session_id", "message_id", "target_message_id", "status"] as const) {
      const value = q.get(key);
      if (value !== null) (filter as Record<string, string>)[key] = value;
    }
    return jsonResponse({ items: store.listAnnotations(filter) }, 200, null);
  }
  if (method === "POST" && path === "/v1/annotations") {
    return jsonResponse(store.createAnnotation(input.body as CreateAnnotationRequest), 201, null);
  }
  if (method === "POST" && path === "/v1/annotations/send") {
    // The batch wakes the Bot the way your own message would: same admission, same door.
    options.admission?.assertNew();
    const sent = store.sendAnnotations(input.body as SendAnnotationsRequest);
    publish({ event: "message.created", occurred_at: occurred(), ...sent.message });
    store.afterCommit(() => { void engine.handleInboundMessage(sent.message, { fromUser: true }); });
    return jsonResponse(sent, 201, null);
  }
  params = matchPath(path, "/v1/annotations/:id/crop");
  if (params && method === "GET") {
    const crop = store.annotationCrop(params.id!);
    if (!crop) throw new HttpError(404, "not_found", "this annotation has no crop");
    const bytes = Buffer.from(crop.bytes);
    return new Response(bytes, {
      status: 200,
      headers: {
        "ETag": fileEtag(bytes),
        "Content-Type": crop.mime,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `inline; filename="annotation-${params.id!}.${crop.mime === "image/png" ? "png" : "jpg"}"`,
      },
    });
  }
  params = matchPath(path, "/v1/annotations/:id");
  if (params && method === "GET") {
    return jsonResponse(store.getAnnotation(params.id!), 200, null);
  }
  if (params && method === "PATCH") {
    return jsonResponse(store.patchAnnotation(params.id!, input.body as PatchAnnotationRequest), 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteAnnotation(params.id!);
    return emptyResponse(204, null);
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
    const server = store.createMcpServerSync(body);
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
    const server = store.patchMcpServerSync(params.id!, body);
    return jsonResponse(server, 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteMcpServerSync(params.id!);
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
    const body = input.body as CreateRoutineRequest;
    const routine = store.createRoutine(body);
    publish({ event: "routine.upsert", occurred_at: occurred(), ...routine });
    engine.fireRoutine(routine.id);
    return jsonResponse(store.getRoutine(routine.id), 201, null);
  }
  params = matchPath(path, "/v1/routines/:id");
  if (params && method === "PATCH") {
    const body = input.body as PatchRoutineRequest;
    const routine = store.patchRoutine(params.id!, body);
    publish({ event: "routine.upsert", occurred_at: occurred(), ...routine });
    engine.fireRoutine(routine.id);
    return jsonResponse(store.getRoutine(routine.id), 200, null);
  }
  if (params && method === "DELETE") {
    store.deleteRoutine(params.id!, input.body.if_revision as string | undefined);
    publish({ event: "routine.removed", occurred_at: occurred(), id: params.id! });
    return emptyResponse(204, null);
  }

  if (method === "GET" && (path === "/v1/spend" || path === "/v1/spend/summary")) {
    const filter = spendFilterFrom(url);
    if (path === "/v1/spend/summary") {
      const groupBy = url.searchParams.get("group_by");
      const tz = url.searchParams.get("tz");
      return jsonResponse(
        store.spendSummary({
          ...filter,
          ...(groupBy ? { group_by: groupBy as "model" | "session" | "bot" | "kind" | "day" } : {}),
          ...(tz ? { tz } : {}),
        }),
        200,
        null,
      );
    }
    const limitText = url.searchParams.get("limit");
    const limit = limitText ? Number(limitText) : undefined;
    if (limitText && (!Number.isInteger(limit) || limit! < 1 || limit! > 200)) {
      throw new HttpError(422, "invalid_args", "limit must be an integer between 1 and 200");
    }
    return jsonResponse(
      store.spendPage({ ...filter, ...(limit ? { limit } : {}), cursor: url.searchParams.get("cursor") }),
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

const SPEND_KINDS = new Set<SpendKind>(["turn", "judgement", "route_pick", "route_review", "route_learn", "composer_suggest"]);
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Shared by the summary and the detail page. An empty `bot_id` or `model` means the null group. */
function spendFilterFrom(url: URL): SpendFilter {
  const filter: SpendFilter = {};
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from) filter.from = canonicalIso(from, "from");
  if (to) filter.to = canonicalIso(to, "to");
  const unique = [...new Set(
    url.searchParams.getAll("kind").flatMap((kind) => kind.split(",")).map((kind) => kind.trim()).filter((kind) => kind.length > 0),
  )];
  if (unique.length > 0) {
    if (unique.some((kind) => !SPEND_KINDS.has(kind as SpendKind))) {
      throw new HttpError(422, "invalid_args", "kind is not a spend kind");
    }
    filter.kind = unique as SpendKind[];
  }
  if (url.searchParams.has("bot_id")) {
    const botId = url.searchParams.get("bot_id") ?? "";
    if (botId === "") filter.bot_id = null;
    else if (!ULID.test(botId)) throw new HttpError(422, "invalid_args", "bot_id must be empty or an id");
    else filter.bot_id = botId;
  }
  const sessionId = url.searchParams.get("session_id");
  if (sessionId) {
    if (!ULID.test(sessionId)) throw new HttpError(422, "invalid_args", "session_id must be an id");
    filter.session_id = sessionId;
  }
  if (url.searchParams.has("model")) {
    const model = url.searchParams.get("model") ?? "";
    filter.model = model === "" ? null : model;
  }
  const providerId = url.searchParams.get("provider_id");
  if (providerId) {
    if (!ULID.test(providerId)) throw new HttpError(422, "invalid_args", "provider_id must be an id");
    filter.provider_id = providerId;
  }
  const turnId = url.searchParams.get("turn_id");
  if (turnId) {
    if (!ULID.test(turnId)) throw new HttpError(422, "invalid_args", "turn_id must be an id");
    filter.turn_id = turnId;
  }
  const tz = url.searchParams.get("tz");
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    } catch {
      throw new HttpError(422, "invalid_args", "tz must be an IANA time zone");
    }
  }
  return filter;
}

/**
 * Ledger rows are `YYYY-MM-DDTHH:mm:ss.sssZ`. A shorter instant would sort ahead of the same
 * millisecond, so the bound is stored in that form. A month or day that does not exist is rejected
 * rather than rolled into the next month.
 */
function canonicalIso(value: string, name: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) throw new HttpError(422, "invalid_args", `${name} must be an ISO timestamp`);
  const [, year, month, day, hour, minute, second, fraction] = match;
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) throw new HttpError(422, "invalid_args", `${name} must be an ISO timestamp`);
  const canonical = new Date(instant).toISOString();
  const millis = (fraction ?? "").padEnd(3, "0");
  if (canonical !== `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`) {
    throw new HttpError(422, "invalid_args", `${name} must be an ISO timestamp`);
  }
  return canonical;
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

type ParsedMutation = {
  body: Record<string, unknown>; files: AttachmentInput[]; multipart: boolean; stagedWrite?: FileCommit;
  normalizedFiles?: NormalizedFile<AttachmentInput>[]; digestBody?: Record<string, unknown>;
};

async function parseMutation(request: Request, staged?: AttachmentInput[]): Promise<ParsedMutation> {
  const media = (request.headers.get("content-type") ?? "application/json").split(";")[0]!.trim().toLowerCase();
  if (media !== "application/json" && media !== "multipart/form-data") throw new HttpError(422, "invalid_args", "unsupported mutation media type");
  if (media === "application/json") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(422, "invalid_args", "body must be an object");
    const record = body as Record<string, unknown>;
    if (staged?.length) {
      const digestBody = { ...record };
      delete digestBody.files;
      return {
        body: digestBody, files: staged, multipart: true, digestBody,
        normalizedFiles: staged.map((file) => {
          if (!file.staged?.sha256) throw new HttpError(422, "invalid_args", "file hash mismatch");
          return { file, filename: file.originalFilename, hash: file.staged.sha256 };
        }),
      };
    }
    if (Array.isArray(record.files) && record.files.length) {
      throw new HttpError(422, "invalid_args", "remote file bytes must arrive on type 0x05");
    }
    return { body: record, files: [], multipart: false };
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
  const normalizedFiles = normalizeFiles(files, (file) => ({ filename: file.originalFilename, bytes: file.buffer }));
  return { body, files: normalizedFiles.map((item) => item.file), normalizedFiles, multipart: true };
}

function checkRevision(store: Store, request: Request, url: URL, body: Record<string, unknown>, scope: RequestScope): void {
  if (request.method === "PUT" && url.pathname === "/v1/workspace/file" && scope.requireRevision && !request.headers.has("If-Match")) {
    throw new HttpError(422, "invalid_args", "If-Match is required");
  }
  if ((request.method === "PATCH" || request.method === "DELETE") && matchPath(url.pathname, "/v1/routines/:id")) {
    if (scope.requireRevision && body.if_revision === undefined) throw new HttpError(422, "invalid_args", "if_revision is required");
    // The routine Store method compares once inside this receipt transaction.
    return;
  }
  const destructive = scope.requireRevision && (request.method === "DELETE" || /\/(archive|restore|clear)$/.test(url.pathname));
  if (request.method !== "PATCH" && !destructive) return;
  const revision = body.if_revision;
  if (revision === undefined && !scope.requireRevision) return;
  if (url.pathname === "/v1/settings") {
    if (!Number.isInteger(revision) || revision !== store.settingsCached().settings_rev) throw new HttpError(409, "conflict", "settings revision changed");
  } else {
    const parts = url.pathname.split("/");
    const tables: Record<string, string> = { bots: "bots", skills: "skills", memories: "memories", routines: "routines", providers: "providers", "mcp-servers": "mcp_servers", sessions: "sessions", annotations: "annotations" };
    const table = parts[2] === "allow-rules" && destructive ? "allow_rules" : tables[parts[2] ?? ""];
    if (!table || !parts[3]) return;
    const revisionColumn = table === "allow_rules" ? "created_at" : "updated_at";
    const row = store.db.query<{ updated_at: string }, [string]>(`SELECT ${revisionColumn} AS updated_at FROM ${table} WHERE id = ?`).get(decodeURIComponent(parts[3]));
    if (!row) throw new HttpError(404, "not_found", "entity not found");
    if (typeof revision !== "string" || revision !== row.updated_at) throw new HttpError(409, "conflict", "entity revision changed");
  }
  delete body.if_revision;
}
