import type { RuntimeSnapshot } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import type { EventSync } from "../event-sync.ts";
import type { MessengerApi } from "../messenger-api.ts";
import { RemoteApi } from "../remote/api.ts";
import { disablePush, enablePush, pushPermission, refreshPush, type DisablePushResult, type PushPermission } from "../remote/push.ts";
import type { Snapshot } from "../snapshot.ts";
import type { Connection } from "../runtime.svelte.ts";
import { readTauriInternals } from "../tauri.ts";
import {
  acceptFirstPage,
  acceptMore,
  applySummary,
  beginInboxLoad,
  beginMore,
  emptyInbox,
  markLocalRead,
  rejectInboxLoad,
  removeInboxItem,
  upsertInboxItem,
  type InboxReplayEvent,
  type InboxState,
} from "./inbox-state.ts";
import {
  EMPTY_NATIVE_CAPABILITIES,
  EMPTY_NOTIFICATION_CAPABILITIES,
  EMPTY_NOTIFICATION_SUMMARY,
  type NativeFocusFacts,
  type NativeNotificationCapabilities,
  type NotificationCapabilities,
  type NotificationDevice,
  type NotificationDevicePatch,
  type NotificationFilter,
  type NotificationIntent,
  type NotificationItem,
  type NotificationPermissionStateDto,
  type NotificationPolicy,
  type NotificationPolicyPatch,
  type NotificationSummary,
  type NotificationViewReport,
  type PushRecovery,
  type PushStateV2,
  type PushTransport,
} from "./types.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time rather than cached: the
 * live connection and its client, the snapshot a mute or a bounded read edits, the session the
 * chrome is pointed at, and the two moves an intent's landing conversation still needs (closing
 * whatever overlay is open, and the session-load machinery itself).
 */
export interface NotificationCenterHost {
  readonly api: MessengerApi | null;
  readonly sync: EventSync | null;
  snapshot: Snapshot;
  selectedId: string | null;
  readonly connection: Connection;
  readonly isDesktopShell: boolean;
  readonly stopped: boolean;
  /** The remote link's own health, as {@link applyPushState} reads it to gate push delivery. */
  readonly remoteStatus: RuntimeSnapshot["remoteStatus"] | null;
  selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void>;
  closeSheets(): void;
}

/**
 * The notifications, push and desktop-native cluster: the inbox, its policy and per-device
 * settings, the badge, presence and bounded reads, and the PWA/desktop push machinery underneath
 * "enable notifications". `MessengerRuntime` forwards every field and method here under the same
 * public names components and tests call, and reaches back in through {@link NotificationCenterHost}.
 */
export class NotificationCenter {
  pushEnabled = $state(false);
  pushBusy = $state(false);
  pushError = $state<string | null>(null);
  pushErrorCode = $state<string | null>(null);
  pushPermission = $state<PushPermission>("unsupported");

  notificationSummary = $state<NotificationSummary>(EMPTY_NOTIFICATION_SUMMARY);
  notificationPolicy = $state<NotificationPolicy | null>(null);
  notificationDevice = $state<NotificationDevice | null>(null);
  notificationCapabilities = $state<NotificationCapabilities>(EMPTY_NOTIFICATION_CAPABILITIES);
  nativeCapabilities = $state<NativeNotificationCapabilities>(EMPTY_NATIVE_CAPABILITIES);
  notificationInboxState = $state<InboxState>(emptyInbox());
  pushTransport = $state<PushTransport>("legacy");
  pushSubscribed = $state(false);
  pushRecovery = $state<PushRecovery>("none");
  remoteGated = $state(false);
  nativeFocusFacts = $state<NativeFocusFacts>({
    visible: false,
    focused: false,
    minimized: false,
    effectiveFocused: false,
  });

  /** Sent on presence heartbeats, so the Mac can tell two tabs of the same page apart. */
  readonly instanceId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

  /** Cleared and rebuilt by the runtime's `start`/`destroy`; owned here since it drives this cluster. */
  presenceTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The read each conversation has already put on record, session id to message id. One slot for
   * the whole app was enough while only one conversation could be on screen; with several, the
   * second one's read landed on the first one's slot and was swallowed.
   */
  private readonly boundedReadSent = new Map<string, string>();
  /**
   * The newest unread notification each conversation has been told about, by ordinal. A note the
   * conversation does not list (a stalled plan's review) has a notification and no line, so the
   * page's read of the last line is all there is to read it by; this is what lets that read be
   * sent again once, after the notification lands.
   */
  private noticeMarks = $state<Record<string, number>>({});
  private notificationIntentHandler: ((intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }) => void) | null = null;

  constructor(private readonly host: NotificationCenterHost) {}

  setNotificationIntentHandler(handler: ((intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }) => void) | null): void {
    this.notificationIntentHandler = handler;
  }

  dispatchNotificationIntent(intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }): void {
    if (this.notificationIntentHandler) {
      this.notificationIntentHandler(intent);
      return;
    }
    this.applyNotificationIntent(intent);
  }

  /**
   * A system banner or a PWA push click lands on the conversation it belongs to. A generic
   * pending push has no session in it, so it returns to the chat list, where that state shows.
   */
  applyNotificationIntent(intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }): void {
    this.host.closeSheets();
    if (!intent.sessionId) {
      this.host.selectedId = null;
      return;
    }
    void this.host.selectSession(intent.sessionId, { messageId: intent.messageId ?? undefined });
  }

  async loadNotificationPolicy(): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    try {
      this.notificationPolicy = await api.getNotificationPolicy();
    } catch {
      // Graceful
    }
  }

  async patchNotificationPolicy(patch: Omit<NotificationPolicyPatch, "if_revision">): Promise<void> {
    const api = this.host.api;
    if (!api || !this.notificationPolicy) return;
    try {
      const res = await api.patchNotificationPolicy({
        ...patch,
        if_revision: this.notificationPolicy.revision,
      });
      this.notificationPolicy = res;
    } catch {
      // Graceful
    }
  }

  async loadNotificationDevice(): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    try {
      this.notificationDevice = await api.getNotificationDevice();
    } catch {
      // Graceful
    }
  }

  async patchNotificationDevice(patch: Omit<NotificationDevicePatch, "if_revision">): Promise<void> {
    const api = this.host.api;
    if (!api || !this.notificationDevice) return;
    try {
      const res = await api.patchNotificationDevice({
        ...patch,
        if_revision: this.notificationDevice.revision,
      });
      this.notificationDevice = res;
    } catch {
      // Graceful
    }
  }

  private liveInboxWatermark(): { event_instance_id: string; watermark_seq: number } | null {
    return this.host.sync?.snapshotCursor() ?? null;
  }

  private inboxReplayAfter(page: { event_instance_id: string; watermark_seq: number }): {
    complete: boolean;
    replay: InboxReplayEvent[];
    reason?: "invalid" | "instance" | "truncated";
  } {
    const result = this.host.sync?.notificationEventsAfter({
      event_instance_id: page.event_instance_id,
      watermark_seq: page.watermark_seq,
    });
    if (!result) return { complete: true, replay: [] };
    if (!result.complete) return { complete: false, replay: [], reason: result.reason };
    const replay: InboxReplayEvent[] = [];
    for (const frame of result.frames) {
      const payload = frame.payload;
      if (payload.event === "notification.upsert") {
        const { event: _e, occurred_at: _at, ...item } = payload;
        replay.push({ seq: frame.seq, event: "notification.upsert", item: item as NotificationItem });
      } else if (payload.event === "notification.removed") {
        replay.push({ seq: frame.seq, event: "notification.removed", id: payload.id });
      } else if (payload.event === "notification.summary") {
        replay.push({ seq: frame.seq, event: "notification.summary", summary: payload.summary });
      }
    }
    return { complete: true, replay };
  }

  private deferInboxReload(filter: NotificationFilter, generation: number, overflow: boolean): void {
    if (overflow) {
      this.notificationInboxState = {
        ...this.notificationInboxState,
        loading: false,
        loadingMore: false,
        error: "stale",
      };
      return;
    }
    queueMicrotask(() => {
      if (this.host.stopped || this.notificationInboxState.generation !== generation) return;
      void this.loadNotificationInbox(filter);
    });
  }

  async loadNotificationInbox(filter: NotificationFilter): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    this.notificationInboxState = beginInboxLoad(this.notificationInboxState, filter);
    const gen = this.notificationInboxState.generation;
    const priorSummary = this.notificationInboxState.summary;
    try {
      const page = await api.listNotifications({ filter, limit: 50 });
      if (this.notificationInboxState.generation !== gen) return;
      const live = this.liveInboxWatermark();
      const liveAhead = Boolean(live && live.event_instance_id === page.event_instance_id && live.watermark_seq > page.watermark_seq);
      const replayed = this.inboxReplayAfter(page);
      const instanceMismatch = replayed.reason === "invalid" || replayed.reason === "instance";
      if (instanceMismatch || (liveAhead && !replayed.complete)) {
        this.deferInboxReload(filter, gen, replayed.reason === "truncated");
        return;
      }
      this.notificationInboxState = acceptFirstPage(this.notificationInboxState, {
        filter,
        generation: gen,
        instanceId: page.event_instance_id,
        watermark: page.watermark_seq,
        upperOrdinal: page.upper_ordinal,
        page,
        live,
        replay: replayed.replay,
        replayComplete: replayed.complete,
      });
      if (!liveAhead) {
        this.notificationSummary = this.notificationInboxState.summary;
        this.syncAppBadge();
      } else if (this.notificationInboxState.summary !== priorSummary) {
        this.notificationSummary = this.notificationInboxState.summary;
        this.syncAppBadge();
      }
    } catch {
      this.notificationInboxState = rejectInboxLoad(this.notificationInboxState, gen, "offline");
    }
  }

  async loadMoreNotifications(): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    const state = this.notificationInboxState;
    if (!state.next || state.loadingMore || state.loading) return;
    this.notificationInboxState = beginMore(state);
    const gen = this.notificationInboxState.generation;
    const priorSummary = state.summary;
    try {
      const page = await api.listNotifications({
        filter: state.filter,
        limit: 50,
        cursor: state.next,
      });
      if (this.notificationInboxState.generation !== gen) return;
      const live = this.liveInboxWatermark();
      const liveAhead = Boolean(live && live.event_instance_id === page.event_instance_id && live.watermark_seq > page.watermark_seq);
      const replayed = this.inboxReplayAfter(page);
      const instanceMismatch = replayed.reason === "invalid" || replayed.reason === "instance";
      if (instanceMismatch || (liveAhead && !replayed.complete)) {
        this.notificationInboxState = { ...state, loadingMore: false, error: replayed.reason === "truncated" ? "stale" : state.error };
        if (replayed.reason !== "truncated") this.deferInboxReload(state.filter, gen, false);
        return;
      }
      this.notificationInboxState = acceptMore(this.notificationInboxState, {
        filter: state.filter,
        generation: gen,
        instanceId: page.event_instance_id,
        watermark: page.watermark_seq,
        upperOrdinal: state.upperOrdinal,
        page,
        live,
        replay: replayed.replay,
        replayComplete: replayed.complete,
      });
      if (!liveAhead) {
        this.notificationSummary = this.notificationInboxState.summary;
        this.syncAppBadge();
      } else if (this.notificationInboxState.summary !== priorSummary) {
        this.notificationSummary = this.notificationInboxState.summary;
        this.syncAppBadge();
      }
    } catch {
      this.notificationInboxState = {
        ...this.notificationInboxState,
        loadingMore: false,
        error: "offline",
      };
    }
  }

  async markNotificationRead(id: string): Promise<void> {
    await this.markNotificationsRead([id]);
  }

  async markNotificationsRead(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const api = this.host.api;
    if (!api) return;
    try {
      await api.markNotificationsRead({ ids });
      const now = new Date().toISOString();
      let openDecrements = 0;
      for (const id of ids) {
        const item = this.notificationInboxState.items.find((i) => i.id === id);
        if (item && !item.read_at && item.action_state !== "open") {
          openDecrements++;
        }
      }
      this.notificationInboxState = markLocalRead(this.notificationInboxState, ids, now);
      this.notificationSummary = {
        ...this.notificationSummary,
        unread_count: Math.max(0, this.notificationSummary.unread_count - ids.length),
        attention_count: Math.max(0, this.notificationSummary.attention_count - openDecrements),
      };
      this.syncAppBadge();
    } catch {
      // Non-fatal
    }
  }

  async markAllNotificationsRead(): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    const upper = this.notificationInboxState.upperOrdinal;
    try {
      await api.markNotificationsRead({ through_ordinal: upper, filter: "all" });
      const now = new Date().toISOString();
      const allIds = this.notificationInboxState.items.map((i: NotificationItem) => i.id);
      this.notificationInboxState = markLocalRead(this.notificationInboxState, allIds, now);
      this.notificationSummary = {
        ...this.notificationSummary,
        unread_count: 0,
        attention_count: this.notificationSummary.open_count,
      };
      this.syncAppBadge();
    } catch {
      // Non-fatal
    }
  }

  async acknowledgeNotification(id: string, ifRevision: number): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    try {
      await api.acknowledgeNotification(id, ifRevision);
      const item = this.notificationInboxState.items.find((i: NotificationItem) => i.id === id);
      if (item) {
        const updated: NotificationItem = {
          ...item,
          action_state: "resolved",
          resolution_reason: "acknowledged",
          revision: item.revision + 1,
          read_at: item.read_at ?? new Date().toISOString(),
        };
        this.notificationInboxState = upsertInboxItem(this.notificationInboxState, updated);
      }
    } catch {
      // Non-fatal
    }
  }

  syncAppBadge(): void {
    if (typeof navigator === "undefined" || !("setAppBadge" in navigator)) return;
    const attention = this.notificationSummary.attention_count;
    if (attention <= 0) {
      if ("clearAppBadge" in navigator) {
        navigator.clearAppBadge().catch(() => {});
      }
    } else {
      if (this.notificationDevice?.badge !== false) {
        navigator.setAppBadge(attention).catch(() => {});
      }
    }
  }

  isSessionMuted(sessionId: string): boolean {
    const session = this.host.snapshot.sessions.find((s) => s.id === sessionId);
    return session?.notification_preference?.muted === true;
  }

  async setSessionMuted(sessionId: string, muted: boolean): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    const session = this.host.snapshot.sessions.find((s) => s.id === sessionId);
    const revision = session?.notification_preference?.revision ?? 0;
    try {
      const pref = await api.putSessionNotificationPreference(sessionId, { muted, if_revision: revision });
      this.host.snapshot = {
        ...this.host.snapshot,
        sessions: this.host.snapshot.sessions.map((s) =>
          s.id === sessionId ? { ...s, notification_preference: pref } : s
        ),
      };
    } catch {
      // Non-fatal
    }
  }

  async sendTestNotification(): Promise<{ ok: boolean; status: string; error_code?: string | null }> {
    const api = this.host.api;
    const copy = copyFor(this.host.snapshot.settings.locale).notifications;
    if (!api) {
      throw new ApiError(0, "disconnected", copyFor(this.host.snapshot.settings.locale).disconnected.host);
    }
    const localNativePath = this.host.isDesktopShell || api.kind === "local";
    if (localNativePath) {
      if (!this.nativeCapabilities.native_delivery_v1 || this.pushPermission !== "granted" || !this.notificationDevice?.enabled) {
        throw new ApiError(409, "delivery_gated", copy.testDeliveryGated);
      }
      if ("testDesktopNotification" in api) {
        return api.testDesktopNotification();
      }
      throw new ApiError(409, "delivery_gated", copy.testDeliveryGated);
    }
    if (this.remoteGated) {
      throw new ApiError(503, "gateway_unavailable", copyFor(this.host.snapshot.settings.locale).notifications.remoteGated);
    }
    if ("testRemotePush" in api) {
      return api.testRemotePush();
    }
    throw new ApiError(409, "capability_unavailable", copy.upgradeRequired);
  }

  async enableDeviceNotifications(): Promise<boolean> {
    const res = await this.setPushEnabled(true);
    return Boolean(res);
  }

  async disableDeviceNotifications(): Promise<DisablePushResult | boolean> {
    return this.setPushEnabled(false);
  }

  async pollDesktopNativeState(): Promise<void> {
    const internals = readTauriInternals();
    if (!internals?.invoke) return;
    try {
      const stateDto = (await internals.invoke("notification_permission_state")) as NotificationPermissionStateDto;
      if (stateDto) {
        this.nativeCapabilities = {
          native_reading_v1: stateDto.nativeReadingV1,
          native_delivery_v1: stateDto.nativeDeliveryV1,
        };
        this.pushPermission = (stateDto.permission === "granted" || stateDto.permission === "denied")
          ? stateDto.permission
          : "default";
      }
    } catch {
      // Native call failure
    }
    try {
      const intent = (await internals.invoke("take_notification_intent")) as NotificationIntent | null;
      if (intent?.clickRef) {
        await this.handleDesktopNotificationIntent(intent.clickRef);
      }
    } catch {
      // Intent error
    }
  }

  async handleDesktopNotificationIntent(clickRef: string): Promise<void> {
    const api = this.host.api;
    if (!api || !("getDesktopClickTarget" in api)) {
      this.dispatchNotificationIntent({ openInbox: true });
      return;
    }
    try {
      const res = await api.getDesktopClickTarget(clickRef);
      if (res.target?.session_id) {
        this.dispatchNotificationIntent({
          sessionId: res.target.session_id,
          messageId: res.target.message_id ?? null,
          openInbox: false,
        });
        return;
      }
      this.dispatchNotificationIntent({ openInbox: true });
    } catch {
      this.dispatchNotificationIntent({ openInbox: true });
    }
  }

  async reportDesktopNotificationView(atLatest: boolean): Promise<NativeFocusFacts | null> {
    const internals = readTauriInternals();
    if (!internals?.invoke) return null;
    try {
      const report: NotificationViewReport = {
        sessionId: this.host.selectedId,
        atLatest,
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
      };
      const facts = (await internals.invoke("report_notification_view", { report })) as NativeFocusFacts;
      if (facts) {
        this.nativeFocusFacts = facts;
        return facts;
      }
    } catch {
      // ignore
    }
    return null;
  }

  async requestDesktopNotificationPermission(): Promise<void> {
    const internals = readTauriInternals();
    if (!internals?.invoke) return;
    try {
      const stateDto = (await internals.invoke("request_notification_permission")) as NotificationPermissionStateDto;
      if (stateDto) {
        this.nativeCapabilities = {
          native_reading_v1: stateDto.nativeReadingV1,
          native_delivery_v1: stateDto.nativeDeliveryV1,
        };
        this.pushPermission = (stateDto.permission === "granted" || stateDto.permission === "denied")
          ? stateDto.permission
          : "default";
        if (stateDto.permission === "granted") {
          await this.patchNotificationDevice({ enabled: true });
        }
      }
    } catch {
      // ignore
    }
  }

  async sendPresenceHeartbeat(atLatest: boolean = false): Promise<void> {
    const api = this.host.api;
    if (!api || this.host.connection !== "connected" || typeof document === "undefined" || document.visibilityState !== "visible") return;
    if (this.host.isDesktopShell) {
      await this.reportDesktopNotificationView(atLatest);
      return;
    }
    try {
      await api.postNotificationPresence({
        instance_id: this.instanceId,
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        session_id: this.host.selectedId,
        at_latest: atLatest,
      });
    } catch {
      // Non-fatal
    }
  }

  private applyPushState(v2: PushStateV2): void {
    this.pushSubscribed = v2.subscribed;
    this.pushEnabled = v2.enabled;
    this.pushRecovery = v2.recovery;
    this.pushTransport = v2.push_transport;
    const state = this.host.remoteStatus?.state;
    this.remoteGated =
      state === "activation_gated" ||
      state === "native_unavailable" ||
      state === "off" ||
      state === "trust_mismatch";
  }

  async loadPushState(): Promise<void> {
    const api = this.host.api;
    if (!(api instanceof RemoteApi)) return;
    let v2: PushStateV2 | null = null;
    try {
      v2 = await api.getPushStateV2();
      this.applyPushState(v2);
    } catch {
      try {
        const legacy = await api.pushState();
        this.pushSubscribed = legacy.subscribed;
        this.pushEnabled = legacy.subscribed;
        this.pushTransport = "legacy";
      } catch {
        // ignore
      }
      return;
    }
    if (!v2.enabled || v2.push_transport !== "policy_v2") return;
    try {
      const result = await refreshPush(api, v2);
      if (result === "needs_repair") {
        if (this.pushRecovery === "none") this.pushRecovery = "registration_missing";
        return;
      }
      this.applyPushState(await api.getPushStateV2());
    } catch {
      if (this.pushRecovery === "none") this.pushRecovery = "registration_missing";
    }
  }

  async prefetchPushState(): Promise<PushStateV2 | null> {
    const api = this.host.api;
    if (!(api instanceof RemoteApi)) return null;
    try {
      const v2 = await api.getPushStateV2();
      this.applyPushState(v2);
      return v2;
    } catch {
      return null;
    }
  }

  /**
   * The Mac answers a read with `session.upsert`, so a read that is already on record still comes
   * back as a new snapshot. Sending it again on the strength of that snapshot is a loop: the same
   * message was read once a second for as long as the conversation stayed on screen, and every
   * pane that reads the snapshot — the file tree beside the chat, the workspace — was rebuilt each
   * time. A read is sent once per message, and again only if it failed.
   */
  async submitBoundedRead(sessionId: string, messageId: string, noticeMark: number = 0): Promise<void> {
    const api = this.host.api;
    if (!api || this.host.connection !== "connected" || this.host.selectedId !== sessionId) return;
    const sent = `${messageId}#${noticeMark}`;
    if (this.boundedReadSent.get(sessionId) === sent) return;
    this.boundedReadSent.set(sessionId, sent);
    try {
      const detail = await api.markSessionReadThrough(sessionId, messageId);
      if (this.host.api !== api) return;
      const current = this.host.snapshot.sessions.find((s) => s.id === sessionId);
      // Writing the row back unchanged is a new snapshot object for nothing.
      if (
        current &&
        current.unread_count === detail.unread_count &&
        current.last_read_at === detail.last_read_at
      ) {
        return;
      }
      this.host.snapshot = {
        ...this.host.snapshot,
        sessions: this.host.snapshot.sessions.map((s) =>
          s.id === sessionId ? { ...s, unread_count: detail.unread_count, last_read_at: detail.last_read_at } : s
        ),
      };
    } catch {
      // Bounded read failure is non-fatal, but the next attempt must be allowed through.
      if (this.boundedReadSent.get(sessionId) === sent) this.boundedReadSent.delete(sessionId);
    }
  }

  async setPushEnabled(enabled: boolean): Promise<DisablePushResult | boolean> {
    const api = this.host.api;
    if (this.host.isDesktopShell) {
      if (enabled) {
        await this.requestDesktopNotificationPermission();
      } else {
        await this.patchNotificationDevice({ enabled: false });
      }
      return true;
    }
    if (!(api instanceof RemoteApi) || this.pushBusy) return false;
    this.pushBusy = true;
    this.pushError = null;
    this.pushErrorCode = null;
    this.pushPermission = pushPermission();
    try {
      if (enabled) {
        await enablePush(api, "enable");
        this.pushEnabled = true;
        this.pushSubscribed = true;
        this.pushRecovery = "none";
        this.pushPermission = pushPermission();
        await this.loadNotificationDevice();
        return true;
      } else {
        const outcome = await disablePush(api);
        this.pushEnabled = !outcome.hostDisabled;
        this.pushSubscribed = !outcome.localRemoved;
        this.pushPermission = pushPermission();
        await this.loadNotificationDevice();
        return outcome;
      }
    } catch (error) {
      this.pushPermission = pushPermission();
      this.pushErrorCode = error instanceof ApiError ? error.code
        : error instanceof Error && error.name !== "Error" ? error.name : null;
      this.pushError = error instanceof Error && error.message === "denied" ? "denied"
        : error instanceof Error && error.message === "unsupported" ? "unsupported"
        : "failed";
      return false;
    } finally {
      this.pushBusy = false;
    }
  }

  /** See `noticeMarks`. Read inside an effect, it re-runs it when a new notification lands. */
  noticeMark(sessionId: string): number {
    return this.noticeMarks[sessionId] ?? 0;
  }

  /** `resetConnection` clears reads sent on the connection it is replacing; this is that clear. */
  clearBoundedReads(): void {
    this.boundedReadSent.clear();
  }

  /** `ingest`'s `notification.upsert` branch, kept here so the badge sync goes with the write. */
  applyNotificationUpsert(item: NotificationItem): void {
    const sessionId = item.session_id;
    if (sessionId && !item.read_at && item.ordinal > (this.noticeMarks[sessionId] ?? 0)) {
      this.noticeMarks = { ...this.noticeMarks, [sessionId]: item.ordinal };
    }
    this.notificationInboxState = upsertInboxItem(this.notificationInboxState, item);
    this.syncAppBadge();
  }

  /** `ingest`'s `notification.removed` branch. */
  applyNotificationRemoved(id: string): void {
    this.notificationInboxState = removeInboxItem(this.notificationInboxState, id);
    this.syncAppBadge();
  }

  /** `ingest`'s `notification.summary` branch. */
  applyLiveNotificationSummary(summary: NotificationSummary): void {
    this.notificationSummary = summary;
    this.notificationInboxState = applySummary(this.notificationInboxState, summary);
    this.syncAppBadge();
  }

  /** `ingest`'s `notification_policy.changed` branch. */
  applyNotificationPolicyChanged(policy: NotificationPolicy): void {
    this.notificationPolicy = policy;
  }
}
