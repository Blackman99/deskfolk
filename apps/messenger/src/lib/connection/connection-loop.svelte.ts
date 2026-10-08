import type {
  CatchupResponse,
  ClientEvent,
  EventCursor,
  RuntimeSnapshot,
  SearchHit,
  SequencedEvent,
  StreamFrame,
  SyncFrame,
  ToolFrame,
} from "@real-bot/protocol";
import { probeHealth } from "../api.ts";
import type { TurnActivity } from "../chat/turn-activity.ts";
import type { LocalEndpoint } from "../discovery.ts";
import { EventSync } from "../event-sync.ts";
import { classifyHealth } from "../health.ts";
import type { LocalApi } from "../local-api.ts";
import type { MessengerApi } from "../messenger-api.ts";
import { parseNotificationCapabilities, parseNotificationPolicy, parseNotificationSummary } from "../notifications/parse.ts";
import { supportsWebLocks, type TabRole } from "../notifications/tab-owner.ts";
import type {
  NativeFocusFacts,
  NotificationCapabilities,
  NotificationPolicy,
  NotificationSummary,
} from "../notifications/types.ts";
import { RemoteApi, type DurablePendingRequest } from "../remote/api.ts";
import { loadEnrollment, type StoredEnrollment } from "../remote/idb.ts";
import { HOSTED_MESSENGER } from "../remote/mode.ts";
import type { Connection, DraftReconnect, HostUnreachable } from "../runtime.svelte.ts";
import type { SessionView } from "../session-view.svelte.ts";
import { fromRuntimeSnapshot, type Snapshot } from "../snapshot.ts";

const RETRY_MS = 1000;
/**
 * A remote retry is a WebSocket handshake at the relay, and the relay allows ten per minute from
 * one address. Retrying every second during a host outage spends that budget in ten seconds and
 * then gets refused for the rest of the minute — the harder the device tries, the longer it takes
 * to come back once the Mac is up. So remote attempts back off, with jitter so several devices on
 * one address do not line up, and reset the moment a connection succeeds.
 */
const REMOTE_RETRY_MIN_MS = 1000;
const REMOTE_RETRY_MAX_MS = 20_000;

export function nextRemoteRetry(previous: number, random = Math.random): number {
  const grown = Math.min(previous * 2, REMOTE_RETRY_MAX_MS);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(grown * jitter, REMOTE_RETRY_MAX_MS));
}
/** Attempts that still read as "connecting" before the page says the host cannot be reached. */
const CONNECTING_ATTEMPTS = 3;
/**
 * Past this many missed events a phone takes the snapshot instead: replaying hundreds of frames
 * costs about what the snapshot does, and the snapshot also re-reads the open conversation.
 */
const RESUME_MAX_EVENTS = 300;

/**
 * What the connection loop reaches back into the runtime for, read at call time and never cached
 * (a test replaces `api`, `sync` and `tick` on the runtime itself). It is most of the runtime: a
 * connection that comes up installs a snapshot into every domain, and one that goes resets them.
 * The client and the event reader, the page's own state and the conversations' views, the
 * notification and remote fields a snapshot fills, the per-domain counters a new snapshot or a
 * dropped link resets, and the loop's own entry points as the runtime answers to them.
 */
export interface ConnectionLoopHost {
  readonly stopped: boolean;
  connection: Connection;
  api: MessengerApi | null;
  sync: EventSync | null;
  connectionSeq: number;
  snapshot: Snapshot;
  selectedId: string | null;
  readonly draft: string;
  readonly views: Map<string, SessionView>;
  endpointKey: string;
  pendingMutation: { id: string; code: string } | null;
  durablePending: DurablePendingRequest[];
  hostUnreachable: HostUnreachable;
  enrolled: boolean;
  draftReconnect: DraftReconnect;
  uvReady: boolean;
  remoteStatus: RuntimeSnapshot["remoteStatus"] | null;
  readonly tabRole: TabRole;
  readonly isDesktopShell: boolean;
  notificationCapabilities: NotificationCapabilities;
  notificationSummary: NotificationSummary;
  notificationPolicy: NotificationPolicy | null;
  delegationSnapshotEpoch: number;
  readonly delegationEventRevisions: Map<string, number>;
  readonly delegationReadSeq: Map<string, number>;
  delegationLoading: Record<string, boolean>;
  delegationLoadError: Record<string, boolean>;
  delegationUnsupported: Record<string, boolean>;
  messageSnapshotRevision: number;
  readonly turnActivity: TurnActivity;
  toolRevision: number;
  sessionLoad: Promise<void>;
  searchSeq: number;
  searchHits: SearchHit[];
  searchLoading: boolean;
  searchError: boolean;
  tick(): Promise<void>;
  tickRemote(): Promise<void>;
  pump(): void;
  reconnectNow(): void;
  resetConnection(): void;
  installSnapshot(api: MessengerApi, sync: EventSync, snapshot: RuntimeSnapshot): Promise<void>;
  markDisconnected(): void;
  acquireTabLock(): Promise<boolean>;
  syncAppBadge(): void;
  pollDesktopNativeState(): Promise<void>;
  reportDesktopNotificationView(atLatest: boolean): Promise<NativeFocusFacts | null>;
  refreshMaintenance(): Promise<void>;
  loadPushState(): Promise<void>;
  reconcilePendingMutation(api: MessengerApi): void;
  syncSettingsDraft(settings: {
    workspace_path: string | null;
    endpoint_base_url: string | null;
    endpoint_models: string[];
    endpoint_default_model: string | null;
  }): void;
  ingest(event: ClientEvent, frame?: SequencedEvent): void;
  sessionView(id: string): SessionView;
  selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void>;
  acceptEphemeral(value: unknown): value is StreamFrame | ToolFrame;
  clearBoundedReads(): void;
}

/**
 * The loop that finds the Mac and keeps a link to it: discovery and the health probe on a desktop,
 * the relay and its enrollment on a phone, the event socket, the snapshot a new link installs and
 * the catch-up a phone back on the same Mac replays instead, the retry timer and its backoff, and
 * what a dropped link resets. `MessengerRuntime` forwards `retryConnection` and the loop's private
 * entry points here, and reaches back in through {@link ConnectionLoopHost}.
 */
export class ConnectionLoop {
  constructor(private readonly host: ConnectionLoopHost) {}

  /** Consecutive failed attempts since the last connection; the first few are still "connecting". */
  connectFailures = 0;
  /** How long to wait before the next relay handshake; grows while the Mac is unreachable. */
  remoteRetryMs = REMOTE_RETRY_MIN_MS;
  private ws: WebSocket | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  /** When the loop owes its next attempt. A wake-up may bring the timer here, never past it. */
  nextAttemptAt = 0;
  private ticking = false;
  /**
   * Where the page was when its last remote link went: the event cursor it had applied and each
   * open conversation's history state. Coming back to the same Mac, it replays only what it
   * missed from here — a few KB — instead of the whole snapshot and every open transcript.
   */
  private resumePoint: {
    cursor: EventCursor;
    views: Map<SessionView, { detailLoaded: boolean; messageNext: string | null }>;
  } | null = null;

  /** The button on the unreachable screen: try now, and look like it. */
  retryConnection(): void {
    if (this.host.stopped || this.host.connection === "connected") return;
    this.connectFailures = 0;
    this.remoteRetryMs = REMOTE_RETRY_MIN_MS;
    this.host.connection = "connecting";
    if (this.timer) clearTimeout(this.timer);
    this.host.pump();
  }

  async tick(): Promise<void> {
    if (this.host.stopped) return;
    if (this.host.connection !== "connected") {
      this.host.connection = this.connectFailures >= CONNECTING_ATTEMPTS ? "disconnected" : "connecting";
    }
    if (HOSTED_MESSENGER) {
      await this.host.tickRemote();
      return;
    }
    const { discoverEndpoint } = await import("../local-discovery.ts");
    const endpoint = await discoverEndpoint();
    if (!endpoint) {
      this.host.hostUnreachable = "runtime";
      this.host.markDisconnected();
      this.schedule();
      return;
    }
    if (this.host.stopped) return;
    const health = await probeHealth(endpoint.origin);
    if (this.host.stopped) return;
    if (classifyHealth(health.status, health.body) !== "ours") {
      this.host.hostUnreachable = "runtime";
      this.host.markDisconnected();
      this.schedule();
      return;
    }
    if (this.host.connection === "connected" && this.host.api && this.host.api.kind === "local" && sameEndpoint(this.host.api.endpoint, endpoint)) {
      this.schedule();
      return;
    }
    try {
      await this.connectLocal(endpoint);
    } catch {
      this.host.hostUnreachable = "runtime";
      this.host.markDisconnected();
    }
    this.schedule();
  }

  async tickRemote(): Promise<void> {
    // Clearing site data under a live page force-closes the IndexedDB connection, so the next
    // read throws. That is the state right after someone wipes a dead enrollment by hand: treat
    // it as not enrolled and let the pairing screen come back.
    let enrollment: StoredEnrollment | null = null;
    try {
      enrollment = await loadEnrollment();
    } catch {
      enrollment = null;
    }
    this.host.enrolled = Boolean(enrollment);
    if (!enrollment) {
      this.host.hostUnreachable = "host";
      this.host.markDisconnected();
      // Nothing to reconnect to, so this is a cheap local poll, not a relay handshake.
      this.remoteRetryMs = REMOTE_RETRY_MIN_MS;
      this.schedule();
      return;
    }
    if (this.host.connection === "connected" && this.host.api instanceof RemoteApi && this.host.api.enrollment.deviceId === enrollment.deviceId) {
      this.remoteRetryMs = REMOTE_RETRY_MIN_MS;
      this.schedule();
      return;
    }
    if (this.host.tabRole === "standby") {
      this.schedule(this.remoteRetryMs);
      return;
    }
    if (this.host.tabRole !== "owner" && typeof navigator !== "undefined" && supportsWebLocks(navigator.locks)) {
      const acquired = await this.host.acquireTabLock();
      if (!acquired) {
        this.schedule(this.remoteRetryMs);
        return;
      }
    }
    try {
      await this.connectRemote(enrollment);
      // The Mac is back: the next drop starts from the short delay again.
      this.remoteRetryMs = REMOTE_RETRY_MIN_MS;
      this.schedule();
      return;
    } catch {
      this.host.hostUnreachable = "host";
      this.host.markDisconnected();
    }
    this.schedule(this.remoteRetryMs);
    this.remoteRetryMs = nextRemoteRetry(this.remoteRetryMs);
  }

  private rememberDraftOnDisconnect(): void {
    const id = this.host.selectedId;
    const draft = this.host.draft.trim();
    if (id && draft && !this.host.draftReconnect) this.host.draftReconnect = { sessionId: id, draft, confirm: false };
  }

  async installSnapshot(api: MessengerApi, sync: EventSync, snapshot: RuntimeSnapshot): Promise<void> {
    if (this.host.stopped || this.host.api !== api || this.host.sync !== sync) return;
    if (api instanceof RemoteApi) api.observeSnapshot(snapshot);
    const frames = sync.install(snapshot);
    if (!frames) throw new Error("event gap during snapshot");
    this.host.delegationSnapshotEpoch++;
    this.host.delegationEventRevisions.clear();
    this.host.delegationReadSeq.clear();
    this.host.delegationLoading = {};
    this.host.delegationLoadError = {};
    this.host.delegationUnsupported = {};
    this.host.messageSnapshotRevision++;
    this.host.snapshot = fromRuntimeSnapshot(snapshot);
    this.host.remoteStatus = snapshot.remoteStatus ?? null;
    if (snapshot.notificationCapabilities) {
      this.host.notificationCapabilities = parseNotificationCapabilities(snapshot.notificationCapabilities);
    }
    if (snapshot.notificationSummary) {
      this.host.notificationSummary = parseNotificationSummary(snapshot.notificationSummary);
      this.host.syncAppBadge();
    }
    if (snapshot.notificationPolicy) {
      const parsed = parseNotificationPolicy(snapshot.notificationPolicy);
      if (parsed) this.host.notificationPolicy = parsed;
    }
    if (this.host.isDesktopShell) {
      void this.host.pollDesktopNativeState();
      void this.host.reportDesktopNotificationView(false);
    }
    if (api instanceof RemoteApi) {
      void this.host.refreshMaintenance();
      void this.host.loadPushState();
    }
    this.host.reconcilePendingMutation(api);
    this.host.syncSettingsDraft(snapshot.settings);
    for (const frame of frames) this.host.ingest(frame.payload, frame);
    this.host.endpointKey = "";
    this.host.connection = "connected";
    this.connectFailures = 0;
    for (const view of this.host.views.values()) {
      view.focusedTurnId = null;
      view.pendingFocusTrigger = null;
    }
    // Back into the conversation it was written in, whichever pane has the keyboard now.
    const kept = this.host.draftReconnect;
    if (kept && !kept.confirm) this.host.sessionView(kept.sessionId).draft = kept.draft;
    const selected = this.host.selectedId;
    if (selected && this.host.snapshot.sessions.some((s) => s.id === selected)) {
      void this.host.selectSession(selected, { preservePage: true });
    } else if (selected) {
      this.host.selectedId = null;
    }
  }

  private async connectLocal(endpoint: LocalEndpoint): Promise<void> {
    const { LocalApi } = await import("../local-api.ts");
    this.host.resetConnection();
    const api = new LocalApi(endpoint);
    const sync = new EventSync();
    this.host.api = api;
    this.host.sync = sync;
    this.host.hostUnreachable = "runtime";
    await this.openSocket(api, sync);
    const snapshot = await api.snapshot();
    await this.host.installSnapshot(api, sync, snapshot);
  }

  private async connectRemote(enrollment: StoredEnrollment): Promise<void> {
    this.host.resetConnection();
    const api = new RemoteApi(enrollment, {}, this.host.durablePending);
    const sync = new EventSync();
    this.host.api = api;
    this.host.sync = sync;
    this.host.hostUnreachable = "host";
    const ready = await api.connect((frame) => {
      if (this.host.api !== api || this.host.sync !== sync) return;
      // The relay carries stream and tool frames on the same channel as events. Letting one
      // reach `EventSync` reads as a cursor mismatch and drops the link, which is what "the
      // host is unreachable" looked like the moment a terminal was opened on a phone.
      if (this.host.acceptEphemeral(frame)) return;
      const frames = sync.receive(frame);
      if (!frames) {
        this.host.markDisconnected();
        return;
      }
      for (const event of frames) this.host.ingest(event.payload, event);
    }, () => {
      // The link went without being asked to: the relay closed it, the Mac went away, the phone
      // changed network. Nobody is going to type to find out, so the page notices by itself and
      // the loop tries again on its own delay.
      if (this.host.api !== api) return;
      this.host.markDisconnected();
      this.host.reconnectNow();
    });
    const frames = sync.receive(ready);
    if (!frames) throw new Error("invalid remote ready");
    if (await this.resumeRemote(api, sync, ready)) {
      this.host.uvReady = api.uvReady;
      return;
    }
    this.resumePoint = null;
    const snapshot = await api.snapshot();
    await this.host.installSnapshot(api, sync, snapshot);
    this.host.uvReady = api.uvReady;
  }

  /**
   * Back on the Mac this page left — the same event instance — it asks for the events it missed
   * and keeps everything on screen. A restarted Mac, a ring that rolled over, too many missed
   * events or any gap: false, and the caller takes the snapshot.
   */
  private async resumeRemote(api: RemoteApi, sync: EventSync, ready: SyncFrame): Promise<boolean> {
    const point = this.resumePoint;
    if (!point || ready.type !== "ready" || ready.event_instance_id !== point.cursor.event_instance_id) return false;
    const missed = ready.watermark_seq - point.cursor.watermark_seq;
    if (missed < 0 || missed > RESUME_MAX_EVENTS) return false;
    let caught: CatchupResponse;
    try {
      caught = await api.catchup(point.cursor);
    } catch {
      return false;
    }
    if (this.host.stopped || this.host.api !== api || this.host.sync !== sync) return true;
    if (caught.resnapshot || caught.event_instance_id !== point.cursor.event_instance_id) return false;
    const frames = sync.resume(point.cursor, caught.events);
    if (!frames) return false;
    this.resumePoint = null;
    for (const [view, kept] of point.views) {
      if (this.host.views.get(view.sessionId) !== view) continue;
      view.detailLoaded = kept.detailLoaded;
      view.messageNext = kept.messageNext;
    }
    // A new link is a new client: it learns the revisions edits carry from what is on screen.
    api.observeSnapshot(this.host.snapshot);
    this.host.reconcilePendingMutation(api);
    for (const frame of frames) this.host.ingest(frame.payload, frame);
    void this.host.refreshMaintenance();
    void this.host.loadPushState();
    this.host.endpointKey = "";
    this.host.connection = "connected";
    this.connectFailures = 0;
    for (const view of this.host.views.values()) {
      view.focusedTurnId = null;
      view.pendingFocusTrigger = null;
      // Streamed text is not an event, so a reply that ran while the link was down is missing
      // what arrived meanwhile: its conversation reads its history again.
      if (this.host.snapshot.turns.some((turn) => turn.session_id === view.sessionId && turn.status === "running")) {
        view.detailLoaded = false;
      }
    }
    const kept = this.host.draftReconnect;
    if (kept && !kept.confirm) this.host.sessionView(kept.sessionId).draft = kept.draft;
    const selected = this.host.selectedId;
    if (selected && this.host.snapshot.sessions.some((s) => s.id === selected)) {
      if (!this.host.views.get(selected)?.detailLoaded) void this.host.selectSession(selected, { preservePage: true });
    } else if (selected) {
      this.host.selectedId = null;
    }
    return true;
  }

  private openSocket(api: LocalApi, sync: EventSync): Promise<void> {
    const ws = new WebSocket(api.eventsUrl());
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        reject(new Error("event subscription timeout"));
        ws.close();
      }, 5000);
      ws.addEventListener("open", () => ws.send(api.authFrame()));
      ws.addEventListener("message", (ev) => {
        if (this.ws !== ws) return;
        const raw = String(ev.data);
        // Ephemeral frames ride the same socket but not the event cursor, so they have to leave
        // before the sequenced path, which reads anything without an instance id as a gap.
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        if (this.host.acceptEphemeral(parsed)) return;
        const frame = api.parseSyncFrame(raw);
        if (!frame || (!ready && frame.type !== "ready")) {
          reject(new Error("invalid event stream"));
          this.host.markDisconnected();
          return;
        }
        if (frame.type === "ready") {
          ready = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        const frames = sync.receive(frame);
        if (!frames) {
          reject(new Error("event gap"));
          this.host.markDisconnected();
          return;
        }
        for (const event of frames) this.host.ingest(event.payload, event);
      });
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        reject(new Error("event socket closed"));
        if (this.ws === ws) this.host.markDisconnected();
      });
      ws.addEventListener("error", () => ws.close());
    });
  }

  resetConnection(): void {
    // Only a remote link that had applied events leaves a point to resume from; an attempt that
    // never got that far keeps the previous one.
    const cursor = this.host.api instanceof RemoteApi ? (this.host.sync?.snapshotCursor() ?? null) : null;
    if (cursor) {
      this.resumePoint = {
        cursor,
        views: new Map([...this.host.views.values()].map((view) => [view, { detailLoaded: view.detailLoaded, messageNext: view.messageNext }])),
      };
    }
    this.rememberDraftOnDisconnect();
    this.host.clearBoundedReads();
    // A step that ended while the link was down would read as running forever.
    this.host.turnActivity.clear();
    this.host.toolRevision += 1;
    this.connectFailures += 1;
    this.host.connection = this.connectFailures >= CONNECTING_ATTEMPTS ? "disconnected" : "connecting";
    this.teardownSocket();
    if (this.host.api instanceof RemoteApi) {
      this.host.durablePending = this.host.api.durablePending();
      this.host.api.close();
    } else if (this.host.api) {
      this.host.pendingMutation = null;
      this.host.durablePending = [];
    }
    this.host.api = null;
    this.host.sync?.close();
    this.host.sync = null;
    this.host.sessionLoad = Promise.resolve();
    this.host.delegationReadSeq.clear();
    this.host.delegationLoading = {};
    this.host.searchSeq++;
    this.host.searchHits = [];
    this.host.searchLoading = false;
    this.host.searchError = false;
    // Every open conversation reads its history again from the next connection, not only the selected one.
    for (const view of this.host.views.values()) {
      view.detailLoaded = false;
      view.messageNext = null;
    }
    this.host.connectionSeq++;
    for (const view of this.host.views.values()) {
      view.sending = false;
      view.upload = null;
    }
  }

  private teardownSocket(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  private schedule(delay = RETRY_MS): void {
    if (this.host.stopped) return;
    // One timer, always the newest: a drop landing while a tick is in flight must not leave two
    // loops running, which on a relay that allows ten handshakes a minute is a way to be refused.
    if (this.timer) clearTimeout(this.timer);
    this.nextAttemptAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.host.pump();
    }, delay);
  }

  /**
   * Try now — as soon as the delay the loop already owes allows it. A phone comes back from a
   * dropped link, a locked screen or a changed network with its timers frozen and no interaction
   * to ride on, and asking again is worth nothing if the relay refuses it: the handshake budget
   * is spent per minute, so a page that just tried still waits, and one frozen for an hour does
   * not.
   */
  reconnectNow(): void {
    if (this.host.stopped || this.host.connection === "connected") return;
    this.schedule(Math.max(0, this.nextAttemptAt - Date.now()));
  }

  /** A tick that throws must still leave a timer behind, or the page never reconnects. */
  pump(): void {
    // An attempt already running owns the next one; a second pass would open a second socket for
    // the same device, which the relay refuses while the first route is still there.
    if (this.ticking) return;
    this.ticking = true;
    void this.host.tick()
      .catch(() => {
        this.host.markDisconnected();
        this.schedule();
      })
      .finally(() => {
        this.ticking = false;
      });
  }
}

function sameEndpoint(a: LocalEndpoint, b: LocalEndpoint): boolean {
  return a.origin === b.origin && a.token === b.token;
}
