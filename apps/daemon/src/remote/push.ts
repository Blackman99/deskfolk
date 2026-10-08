import type { ClientEvent, NotificationItem, PushPublicState, PushRecoveryReason } from "@real-bot/protocol";
import { base64url } from "@real-bot/remote";
import { HttpError } from "../errors";
import { ulid } from "../ids";
import { BATCHING_WINDOW_MS, DELIVERY_ABSOLUTE_DEADLINE_MS, isQuietHoursActive, MAX_DELIVERY_ATTEMPTS, nextQuietHoursEndMs, PresenceManager, SEND_SLOT_INTERVAL_MS, TEST_RATE_LIMIT_MS } from "../notifications";
import type { RemoteNativeClient } from "../remote-native";
import type { Store } from "../store";
import { encryptPush, pushHeaders, vapidFingerprint, vapidPrivate32, vapidPublic } from "./push-crypto";
import { endpointHash, keyBytes, parsePushEndpoint, parseSubscribeV2, PUSH_PLAINTEXT } from "./push-endpoint";
import { createSafePushFetch, type PushFetch } from "./push-net";
import { deletePushSubs, livePushSubs, pushSub, upsertPushSub } from "./push-subs";
import type { RemoteTrust } from "./trust";

export {
  BATCHING_WINDOW_MS,
  DELIVERY_ABSOLUTE_DEADLINE_MS,
  MAX_DELIVERY_ATTEMPTS,
  SEND_SLOT_INTERVAL_MS,
  TEST_RATE_LIMIT_MS,
};
export const REQUEST_TIMEOUT_MS = 10_000;
export const GLOBAL_CONCURRENCY_LIMIT = 4;

export type PushServiceOptions = {
  store: Store;
  native: Pick<RemoteNativeClient, "read">;
  fetch?: PushFetch;
  now?: () => number;
  trust?: RemoteTrust;
  remoteStatus?: () => { state: string; diagnostic: string | null; devices: number };
  pausedUpgrade?: boolean;
  presence?: PresenceManager;
};

type PushDeliveryRow = {
  delivery_id: string;
  batch_key: string;
  state: string;
  attempt: number;
  absolute_expires_at: number;
  next_attempt_at: number | null;
  push_generation: number;
  trust_generation: number;
};

export class PushService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryDueAt = new Map<string, number>();
  private readonly inFlightByDevice = new Map<string, AbortController>();
  private readonly lastTestAtByReceiver = new Map<string, number>();
  private activeGlobalRequests = 0;
  private closed = false;
  private cachedVapidFp: string | null = null;
  readonly pausedUpgrade: boolean;
  private readonly GATE_RETRY_MS = 5_000;
  private readonly CONCURRENCY_RETRY_MS = 250;

  constructor(private readonly options: PushServiceOptions) {
    this.pausedUpgrade = options.pausedUpgrade ?? false;
    // A warm-up only (subscribing reads it again). Before any relay there is nothing to push to,
    // and on the file credential store the read would write this Mac's keys for nothing.
    if (!options.trust || options.trust.host()) void this.vapidFingerprint().catch(() => undefined);
    if (options.trust) {
      options.trust.onInvalidate(() => {
        for (const ctrl of this.inFlightByDevice.values()) {
          ctrl.abort("trust_invalidated");
        }
        this.inFlightByDevice.clear();
      });
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryDueAt.clear();
    for (const ctrl of this.inFlightByDevice.values()) {
      ctrl.abort("closed");
    }
    this.inFlightByDevice.clear();
  }

  abortDevice(deviceId: string): void {
    const ctrl = this.inFlightByDevice.get(deviceId);
    if (ctrl) {
      ctrl.abort("device_aborted");
      this.inFlightByDevice.delete(deviceId);
    }
    const timer = this.retryTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(deviceId);
    }
    this.retryDueAt.delete(deviceId);
  }

  now(): number {
    return this.options.now?.() ?? Date.now();
  }

  recoverScheduled(): void {
    if (this.pausedUpgrade || this.closed) return;
    const now = this.now();
    this.reconcileDeliveries(now);
    const rows = this.options.store.db
      .query<{ receiver_id: string; next_attempt_at: number | null; next_send_at: number | null }, [number]>(`
        SELECT d.receiver_id, d.next_attempt_at, nd.next_send_at
        FROM notification_deliveries d
        JOIN notification_devices nd ON nd.receiver_id = d.receiver_id
        WHERE d.channel = 'remote_push' AND d.state IN ('pending', 'retry_wait', 'unknown')
          AND d.absolute_expires_at > ?
      `)
      .all(now);
    const devices = new Set(rows.map((row) => row.receiver_id));
    for (const row of rows) {
      const due = Math.max(row.next_attempt_at ?? now, row.next_send_at ?? now);
      this.scheduleDevice(row.receiver_id, due);
    }
    for (const sub of livePushSubs(this.options.store, now)) {
      if (devices.has(sub.device_id)) continue;
      const policy = this.options.store.getNotificationPolicy();
      if (isQuietHoursActive(policy, new Date(now))) {
        const quietEnd = nextQuietHoursEndMs(policy, new Date(now));
        if (quietEnd) this.scheduleDevice(sub.device_id, quietEnd);
      }
    }
    for (const [deviceId, at] of this.retryDueAt) {
      if (at <= now) this.scheduleDevice(deviceId, now);
    }
  }

  async applicationServerKey(): Promise<string> {
    const vapid = await this.options.native.read("vapid");
    try {
      vapidPrivate32(vapid);
      this.cachedVapidFp = vapidFingerprint(vapid);
      return base64url(vapidPublic(vapid));
    } finally {
      vapid.fill(0);
    }
  }

  async vapidFingerprint(): Promise<string> {
    const vapid = await this.options.native.read("vapid");
    try {
      vapidPrivate32(vapid);
      const fp = vapidFingerprint(vapid);
      this.cachedVapidFp = fp;
      return fp;
    } finally {
      vapid.fill(0);
    }
  }

  async publicState(deviceId: string): Promise<PushPublicState> {
    const appServerKey = await this.applicationServerKey();
    const currentFingerprint = await this.vapidFingerprint();
    const sub = pushSub(this.options.store, deviceId);
    const devRow = this.options.store.getNotificationDeviceRow(deviceId);
    const contactConfig = this.options.store.getNotificationPushConfig();
    const now = this.now();

    let recovery: PushRecoveryReason = "none";
    if (sub) {
      if (sub.expires_at !== null && sub.expires_at <= now) {
        recovery = "expired";
      } else if (sub.vapid_fingerprint && sub.vapid_fingerprint !== currentFingerprint) {
        recovery = "key_mismatch";
      } else {
        recovery = "none";
      }
    } else {
      if (devRow?.enabled) {
        if (devRow.last_invalid_reason === "gone") recovery = "gone";
        else if (devRow.last_invalid_reason === "expired") recovery = "expired";
        else if (devRow.last_invalid_reason === "key_mismatch") recovery = "key_mismatch";
        else recovery = "registration_missing";
      } else {
        recovery = "none";
      }
    }

    return {
      applicationServerKey: appServerKey,
      subscribed: Boolean(sub),
      enabled: Boolean(devRow?.enabled),
      device_revision: devRow?.revision ?? 0,
      push_generation: devRow?.push_generation ?? 1,
      vapid_key_fingerprint: currentFingerprint,
      recovery,
      current_endpoint_hash: sub ? sub.endpoint_hash : null,
      last_gone_endpoint_hash: devRow?.last_invalid_endpoint_hash ?? null,
      last_error_code: devRow?.last_invalid_reason ?? (sub?.last_diagnostics ?? null),
      contact_configured: contactConfig.contact_configured,
      push_transport: this.pausedUpgrade ? "paused_upgrade" : "policy_v2",
    };
  }

  subscribe(deviceId: string, body: Record<string, unknown>): void {
    if (this.pausedUpgrade) {
      throw new HttpError(409, "capability_unavailable", "push subscription is paused during upgrade");
    }
    if (!this.isRemoteGateOpen()) {
      throw new HttpError(503, "gateway_unavailable", "remote push is not currently available");
    }
    if (!body || typeof body !== "object" || !Object.hasOwn(body, "mode") || !Object.hasOwn(body, "if_device_revision")) {
      throw new HttpError(409, "client_upgrade_required", "push subscription requires push_settings_v2 format");
    }

    const input = parseSubscribeV2(body);
    const now = this.now();
    if (this.cachedVapidFp && input.application_server_key_fingerprint !== this.cachedVapidFp) {
      throw new HttpError(409, "key_mismatch", "application server key fingerprint mismatch");
    }

    this.abortDevice(deviceId);
    this.options.store.transaction(() => {
      const devRow = this.options.store.getNotificationDeviceRow(deviceId);
      const currentRevision = devRow ? devRow.revision : 0;
      const currentGeneration = devRow ? devRow.push_generation : 0;
      const currentEnabled = Boolean(devRow?.enabled);
      const lastGoneHash = devRow?.last_invalid_endpoint_hash ?? null;
      const lastGoneReason = devRow?.last_invalid_reason ?? null;

      if (currentRevision !== input.if_device_revision) {
        throw new HttpError(
          409,
          "revision_conflict",
          `device revision conflict: expected ${input.if_device_revision}, actual ${currentRevision}`,
        );
      }

      const newEndpointHash = endpointHash(input.endpoint);
      const existingConflict = this.options.store.db
        .query<{ device_id: string }, [string, string]>(
          "SELECT device_id FROM remote_push_subs WHERE endpoint_hash = ? AND device_id != ?",
        )
        .get(newEndpointHash, deviceId);
      if (existingConflict) {
        throw new HttpError(409, "endpoint_conflict", "endpoint already registered by another device");
      }
      if (lastGoneHash === newEndpointHash && lastGoneReason === "gone") {
        throw new HttpError(409, "endpoint_gone", "endpoint was previously reported gone");
      }

      const existingSub = pushSub(this.options.store, deviceId);
      if (input.mode === "refresh") {
        if (!currentEnabled) throw new HttpError(409, "not_enabled", "refresh requires device to be enabled");
        if (!existingSub) throw new HttpError(409, "no_subscription", "refresh requires an existing subscription");
        if (lastGoneReason === "gone" || lastGoneReason === "expired" || lastGoneReason === "key_mismatch") {
          throw new HttpError(409, "recovery_required", "device requires explicit enable recovery");
        }
      }

      if (
        currentEnabled &&
        existingSub &&
        existingSub.endpoint === input.endpoint &&
        existingSub.p256dh === input.p256dh &&
        existingSub.auth === input.auth &&
        existingSub.expires_at === (input.expires_at ?? null) &&
        existingSub.vapid_fingerprint === input.application_server_key_fingerprint
      ) {
        return;
      }

      const nextRevision = currentRevision + 1;
      const nextGeneration = currentGeneration + 1;
      this.options.store.db.run(
        `INSERT INTO notification_devices (
          receiver_id, revision, enabled, sound, preview, badge, push_generation,
          last_invalid_endpoint_hash, last_invalid_reason
        ) VALUES (?, ?, 1, 'system', 'generic', 1, ?, NULL, NULL)
        ON CONFLICT(receiver_id) DO UPDATE SET
          revision = excluded.revision,
          enabled = 1,
          push_generation = excluded.push_generation,
          last_invalid_endpoint_hash = NULL,
          last_invalid_reason = NULL`,
        [deviceId, nextRevision, nextGeneration],
      );
      upsertPushSub(this.options.store, deviceId, input, now, nextGeneration, input.application_server_key_fingerprint);
      this.options.store.db.run(
        `UPDATE notification_deliveries
         SET state = 'suppressed'
         WHERE receiver_id = ? AND channel = 'remote_push' AND push_generation < ? AND state IN ('pending', 'claimed', 'retry_wait')`,
        [deviceId, nextGeneration],
      );
    });
  }

  unsubscribe(deviceId: string, body?: Record<string, unknown>): void {
    this.options.store.transaction(() => {
      const devRow = this.options.store.getNotificationDeviceRow(deviceId);
      const currentRevision = devRow ? devRow.revision : 0;
      const currentGeneration = devRow ? devRow.push_generation : 0;
      if (body && typeof body.if_device_revision === "number") {
        if (currentRevision !== body.if_device_revision) {
          throw new HttpError(
            409,
            "revision_conflict",
            `device revision conflict: expected ${body.if_device_revision}, actual ${currentRevision}`,
          );
        }
      }

      const nextRevision = currentRevision + 1;
      const nextGeneration = currentGeneration + 1;
      this.options.store.db.run(
        `INSERT INTO notification_devices (
          receiver_id, revision, enabled, sound, preview, badge, push_generation
        ) VALUES (?, ?, 0, 'system', 'generic', 1, ?)
        ON CONFLICT(receiver_id) DO UPDATE SET
          revision = excluded.revision,
          enabled = 0,
          push_generation = excluded.push_generation`,
        [deviceId, nextRevision, nextGeneration],
      );
      this.options.store.db.run("DELETE FROM remote_push_subs WHERE device_id = ?", [deviceId]);
      this.options.store.db.run(
        `UPDATE notification_deliveries
         SET state = 'suppressed'
         WHERE receiver_id = ? AND channel = 'remote_push' AND state IN ('pending', 'claimed', 'retry_wait')`,
        [deviceId],
      );
    });
    this.abortDevice(deviceId);
  }

  async test(deviceId: string): Promise<{ ok: boolean; status: string; error_code?: string | null }> {
    const now = this.now();
    const devRow = this.options.store.getNotificationDeviceRow(deviceId);
    if (!devRow || !devRow.enabled) {
      throw new HttpError(409, "push_disabled", "push notifications must be enabled to send a test");
    }
    const sub = pushSub(this.options.store, deviceId);
    if (!sub) throw new HttpError(409, "no_subscription", "no active push subscription for device");
    if (!this.isRemoteGateOpen()) {
      throw new HttpError(503, "gateway_unavailable", "remote push is not currently available");
    }
    if (!this.options.store.getNotificationPushConfig().contact_uri && !this.options.fetch) {
      throw new HttpError(409, "push_contact_required", "operator contact URI is required before sending push");
    }

    const lastTest = this.lastTestAtByReceiver.get(deviceId) ?? 0;
    if (now - lastTest < TEST_RATE_LIMIT_MS) {
      throw new HttpError(429, "rate_limited", "test push rate limited to once per 60 seconds");
    }
    this.reconcileDeliveries(now);
    if (this.activeBatch(deviceId)) {
      throw new HttpError(409, "push_pending", "a push delivery is still pending for this device");
    }

    const deliveryId = ulid();
    this.options.store.db.run(
      `INSERT INTO notification_deliveries (
        delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
        state, attempt, next_attempt_at, absolute_expires_at, claim_token,
        claim_expires_at, push_generation, trust_generation, created_at
      ) VALUES (?, ?, 'remote_push', ?, 0, ?, 'pending', 0, ?, ?, NULL, NULL, ?, ?, ?)`,
      [
        deliveryId,
        deviceId,
        `test:${deliveryId}`,
        ulid(),
        now,
        now + DELIVERY_ABSOLUTE_DEADLINE_MS,
        devRow.push_generation,
        this.currentTrustGeneration(),
        now,
      ],
    );

    this.lastTestAtByReceiver.set(deviceId, now);
    if (devRow.last_attempt_at && now < (devRow.next_send_at ?? 0)) {
      this.scheduleDevice(deviceId, devRow.next_send_at ?? now);
      return { ok: true, status: "waiting_send_slot" };
    }

    await this.deliverPending(deviceId);
    const row = this.options.store.db
      .query<{ state: string; error_code: string | null }, [string]>("SELECT state, error_code FROM notification_deliveries WHERE delivery_id = ?")
      .get(deliveryId);
    if (row?.state === "accepted") return { ok: true, status: "accepted" };
    if (row?.state === "retry_wait" || row?.state === "claimed" || row?.state === "pending") {
      return { ok: true, status: "queued", error_code: row.error_code };
    }
    throw new HttpError(503, "failed", row?.state ?? "push test was not accepted");
  }

  notify(event: ClientEvent): void {
    if (this.pausedUpgrade || this.closed) return;
    if (event.event !== "notification.upsert") return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, BATCHING_WINDOW_MS);
  }

  async flush(): Promise<void> {
    if (this.pausedUpgrade || this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const now = this.now();
    const dueFromTimers = [...this.retryDueAt.entries()].filter(([, at]) => at <= now).map(([id]) => id);
    const deviceIds = [
      ...new Set([
        ...livePushSubs(this.options.store, now).map((sub) => sub.device_id),
        ...this.options.store.db
          .query<{ receiver_id: string }, []>(
            "SELECT DISTINCT receiver_id FROM notification_deliveries WHERE channel = 'remote_push' AND state IN ('pending', 'retry_wait', 'unknown')",
          )
          .all()
          .map((row) => row.receiver_id),
        ...dueFromTimers,
      ]),
    ];
    if (!deviceIds.length) return;
    const queue = [...deviceIds];
    const workers = Array.from({ length: Math.min(GLOBAL_CONCURRENCY_LIMIT, queue.length) }, async () => {
      while (queue.length) {
        const deviceId = queue.shift();
        if (!deviceId) return;
        await this.deliverPending(deviceId, true);
      }
    });
    await Promise.all(workers);
  }

  private isRemoteGateOpen(): boolean {
    if (!this.options.remoteStatus) return true;
    const status = this.options.remoteStatus().state;
    return !["off", "activation_gated", "native_unavailable", "trust_mismatch"].includes(status);
  }

  private isDeviceTrusted(deviceId: string): boolean {
    if (!this.options.trust) return true;
    try {
      const dev = this.options.trust.device(deviceId);
      const host = this.options.trust.host();
      if (!dev || dev.revoked) return false;
      return dev.generation === host?.generation;
    } catch {
      return false;
    }
  }

  private currentTrustGeneration(): number {
    return this.options.trust?.host()?.generation ?? 1;
  }

  private scheduleDevice(deviceId: string, at: number): void {
    if (this.closed || this.pausedUpgrade) return;
    const now = this.now();
    const due = Math.max(at, now);
    const existingDue = this.retryDueAt.get(deviceId);
    if (existingDue !== undefined && existingDue <= due && existingDue > now && this.retryTimers.has(deviceId)) return;
    this.retryDueAt.set(deviceId, due);
    const existing = this.retryTimers.get(deviceId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(1, due - now);
    this.retryTimers.set(
      deviceId,
      setTimeout(() => {
        this.retryTimers.delete(deviceId);
        this.retryDueAt.delete(deviceId);
        void this.deliverPending(deviceId).catch(() => undefined);
      }, delay),
    );
  }

  private reconcileDeliveries(now: number): void {
    this.options.store.db.run(
      `UPDATE notification_deliveries SET state = 'expired', error_code = 'expired', next_attempt_at = NULL
       WHERE channel = 'remote_push' AND state IN ('pending', 'retry_wait', 'unknown')
         AND absolute_expires_at <= ?`,
      [now],
    );
    const stranded = this.options.store.db
      .query<PushDeliveryRow & { receiver_id: string }, []>(`
        SELECT delivery_id, receiver_id, batch_key, state, attempt, absolute_expires_at, next_attempt_at, push_generation, trust_generation
        FROM notification_deliveries
        WHERE channel = 'remote_push' AND state = 'claimed'
      `)
      .all();
    for (const row of stranded) {
      if (this.inFlightByDevice.has(row.receiver_id)) continue;
      if (now >= row.absolute_expires_at || row.attempt + 1 >= MAX_DELIVERY_ATTEMPTS) {
        this.options.store.db.run(
          "UPDATE notification_deliveries SET state = ?, error_code = 'unknown' WHERE delivery_id = ? AND state = 'claimed'",
          [now >= row.absolute_expires_at ? "expired" : "unknown", row.delivery_id],
        );
        continue;
      }
      const nextSend = this.options.store.getNotificationDeviceRow(row.receiver_id)?.next_send_at ?? now;
      const nextAttemptAt = Math.max(now, nextSend);
      this.options.store.db.run(
        `UPDATE notification_deliveries
         SET state = 'unknown', error_code = 'unknown', next_attempt_at = ?
         WHERE delivery_id = ? AND state = 'claimed'`,
        [nextAttemptAt, row.delivery_id],
      );
    }
  }

  private activeBatch(deviceId: string): { delivery_id: string; state: string } | null {
    return (
      this.options.store.db
        .query<{ delivery_id: string; state: string }, [string]>(`
          SELECT delivery_id, state FROM notification_deliveries
          WHERE receiver_id = ? AND channel = 'remote_push' AND state IN ('pending', 'retry_wait', 'claimed', 'unknown')
          ORDER BY created_at ASC LIMIT 1
        `)
        .get(deviceId) ?? null
    );
  }

  private deferUntilSendable(deviceId: string, extraAt?: number | null): void {
    const now = this.now();
    const policy = this.options.store.getNotificationPolicy();
    const quietEnd = isQuietHoursActive(policy, new Date(now)) ? nextQuietHoursEndMs(policy, new Date(now)) : null;
    const nextSend = this.options.store.getNotificationDeviceRow(deviceId)?.next_send_at ?? now;
    const due = Math.max(extraAt ?? now, quietEnd ?? now, nextSend, now);
    this.options.store.db.run(
      `UPDATE notification_deliveries SET next_attempt_at = ?
       WHERE receiver_id = ? AND channel = 'remote_push' AND state IN ('pending', 'retry_wait', 'unknown')
         AND (next_attempt_at IS NULL OR next_attempt_at < ?)`,
      [due, deviceId, due],
    );
    this.scheduleDevice(deviceId, due);
  }

  private batchStillEligible(delivery: PushDeliveryRow, deviceId: string, now: number): boolean {
    if (delivery.batch_key.startsWith("test:")) return true;
    const policy = this.options.store.getNotificationPolicy();
    const items = this.options.store.db
      .query<{ id: string; kind: string; session_id: string | null; read_at: string | null; action_state: string }, [string]>(`
        SELECT n.id, n.kind, n.session_id, n.read_at, n.action_state
        FROM notification_delivery_items di
        JOIN notifications n ON n.id = di.notification_id
        WHERE di.delivery_id = ?
      `)
      .all(delivery.delivery_id);
    for (const item of items) {
      if (!policy.categories[item.kind as keyof typeof policy.categories]) continue;
      if ((item.kind === "reply" || item.kind === "routine_result") && item.session_id) {
        if (this.options.store.getSessionNotificationPreference(item.session_id).muted) continue;
      }
      const unreadOrOpen = item.read_at === null || item.action_state === "open";
      if (!unreadOrOpen) continue;
      if (this.options.presence?.isReceiverActiveForeground(deviceId, item.session_id, now)) continue;
      return true;
    }
    return false;
  }

  private requireContactUri(): string | null {
    const configured = this.options.store.getNotificationPushConfig().contact_uri;
    if (configured) return configured;
    if (this.options.fetch) return "mailto:real-bot@localhost";
    return null;
  }

  private selectCandidates(now: number, skipBatchWindow: boolean, deviceId: string): NotificationItem[] {
    const policy = this.options.store.getNotificationPolicy();
    const unread = this.options.store.listNotifications({ filter: "unread", limit: 100 });
    const candidates: NotificationItem[] = [];
    for (const item of unread.items) {
      if (!policy.categories[item.kind]) continue;
      if ((item.kind === "reply" || item.kind === "routine_result") && item.session_id) {
        const pref = this.options.store.getSessionNotificationPreference(item.session_id);
        if (pref.muted) continue;
      }
      if (this.options.presence?.isReceiverActiveForeground(deviceId, item.session_id, now)) continue;
      if (!skipBatchWindow) {
        const createdMs = new Date(item.created_at).getTime();
        if (now - createdMs < BATCHING_WINDOW_MS) continue;
      }
      candidates.push(item);
    }
    return candidates;
  }

  private loadDueDelivery(deviceId: string, now: number): PushDeliveryRow | null {
    return (
      this.options.store.db
        .query<PushDeliveryRow, [string, number, number]>(`
          SELECT delivery_id, batch_key, state, attempt, absolute_expires_at, next_attempt_at, push_generation, trust_generation
          FROM notification_deliveries
          WHERE receiver_id = ? AND channel = 'remote_push' AND state IN ('pending', 'retry_wait', 'unknown')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND absolute_expires_at > ?
          ORDER BY CASE WHEN batch_key LIKE 'test:%' THEN 1 ELSE 0 END ASC, created_at ASC
          LIMIT 1
        `)
        .get(deviceId, now, now) ?? null
    );
  }

  private markFailed(deliveryId: string, errorCode: string): void {
    this.options.store.db.run(
      "UPDATE notification_deliveries SET state = 'failed', error_code = ? WHERE delivery_id = ? AND state = 'claimed'",
      [errorCode, deliveryId],
    );
  }

  private scheduleRetry(
    delivery: PushDeliveryRow,
    nextAttemptCount: number,
    nextAttemptAt: number,
    errorCode: string,
  ): void {
    if (nextAttemptAt > delivery.absolute_expires_at || nextAttemptCount >= MAX_DELIVERY_ATTEMPTS) {
      this.options.store.db.run(
        `UPDATE notification_deliveries SET state = ?, attempt = ?, error_code = ?
         WHERE delivery_id = ? AND state = 'claimed'`,
        [
          nextAttemptAt > delivery.absolute_expires_at ? "expired" : "failed",
          nextAttemptCount,
          nextAttemptAt > delivery.absolute_expires_at ? "expired" : errorCode,
          delivery.delivery_id,
        ],
      );
      return;
    }
    this.options.store.db.run(
      `UPDATE notification_deliveries
       SET state = 'retry_wait', attempt = ?, next_attempt_at = ?, error_code = ?
       WHERE delivery_id = ? AND state = 'claimed'`,
      [nextAttemptCount, nextAttemptAt, errorCode, delivery.delivery_id],
    );
  }

  private writeDiagnostics(deviceId: string, generation: number, code: string): void {
    this.options.store.db.run(
      "UPDATE notification_devices SET last_diagnostics = ? WHERE receiver_id = ? AND push_generation = ?",
      [code, deviceId, generation],
    );
    this.options.store.db.run(
      "UPDATE remote_push_subs SET last_diagnostics = ? WHERE device_id = ? AND generation = ?",
      [code, deviceId, generation],
    );
  }

  private async deliverPending(deviceId: string, skipBatchWindow = false): Promise<void> {
    if (this.closed || this.pausedUpgrade) return;
    this.reconcileDeliveries(this.now());
    if (!this.isRemoteGateOpen() || !this.isDeviceTrusted(deviceId)) {
      this.scheduleDevice(deviceId, this.now() + this.GATE_RETRY_MS);
      return;
    }

    const contactUri = this.requireContactUri();
    if (!contactUri) {
      this.options.store.db.run(
        "UPDATE notification_devices SET last_diagnostics = 'push_contact_required' WHERE receiver_id = ?",
        [deviceId],
      );
      this.deferUntilSendable(deviceId, this.now() + this.GATE_RETRY_MS);
      return;
    }

    const devRow = this.options.store.getNotificationDeviceRow(deviceId);
    if (!devRow || !devRow.enabled) return;
    const sub = pushSub(this.options.store, deviceId);
    if (!sub || sub.generation !== devRow.push_generation) return;
    if (this.inFlightByDevice.has(deviceId)) return;
    if (this.activeGlobalRequests >= GLOBAL_CONCURRENCY_LIMIT) {
      this.deferUntilSendable(deviceId, this.now() + this.CONCURRENCY_RETRY_MS);
      return;
    }

    const now = this.now();
    if (devRow.last_attempt_at && now < (devRow.next_send_at ?? 0)) {
      this.scheduleDevice(deviceId, devRow.next_send_at ?? now);
      return;
    }

    const policy = this.options.store.getNotificationPolicy();
    const isQuiet = isQuietHoursActive(policy, new Date(now));
    let delivery = this.loadDueDelivery(deviceId, now);
    const isTest = Boolean(delivery?.batch_key.startsWith("test:"));
    if (!isTest && isQuiet) {
      this.deferUntilSendable(deviceId, nextQuietHoursEndMs(policy, new Date(now)));
      return;
    }

    if (!delivery) {
      if (this.activeBatch(deviceId)) {
        this.deferUntilSendable(deviceId);
        return;
      }
      const candidates = this.selectCandidates(now, skipBatchWindow, deviceId);
      if (candidates.length === 0) {
        if (this.options.presence?.isReceiverActiveForeground(deviceId, null, now)) {
          this.deferUntilSendable(deviceId, now + 1_000);
        }
        return;
      }
      const deliveryId = ulid();
      const absExpiresAt = now + DELIVERY_ABSOLUTE_DEADLINE_MS;
      const highest = candidates[0]!;
      const batchKey = `batch:${deliveryId}`;
      const trustGeneration = this.currentTrustGeneration();
      this.options.store.transaction(() => {
        this.options.store.db.run(
          `INSERT INTO notification_deliveries (
            delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
            state, attempt, next_attempt_at, absolute_expires_at, claim_token,
            claim_expires_at, push_generation, trust_generation, created_at
          ) VALUES (?, ?, 'remote_push', ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, ?, ?, ?)`,
          [deliveryId, deviceId, batchKey, highest.ordinal, ulid(), now, absExpiresAt, devRow.push_generation, trustGeneration, now],
        );
        for (const item of candidates) {
          this.options.store.db.run(
            "INSERT OR IGNORE INTO notification_delivery_items (delivery_id, notification_id) VALUES (?, ?)",
            [deliveryId, item.id],
          );
        }
      });
      delivery = {
        delivery_id: deliveryId,
        batch_key: batchKey,
        state: "pending",
        attempt: 0,
        absolute_expires_at: absExpiresAt,
        next_attempt_at: now,
        push_generation: devRow.push_generation,
        trust_generation: trustGeneration,
      };
    }

    if (now > delivery.absolute_expires_at) {
      this.options.store.db.run(
        "UPDATE notification_deliveries SET state = 'expired' WHERE delivery_id = ? AND state IN ('pending', 'retry_wait', 'unknown')",
        [delivery.delivery_id],
      );
      return;
    }

    if (!this.batchStillEligible(delivery, deviceId, now)) {
      this.options.store.db.run(
        "UPDATE notification_deliveries SET state = 'suppressed' WHERE delivery_id = ? AND state IN ('pending', 'retry_wait', 'unknown')",
        [delivery.delivery_id],
      );
      return;
    }

    const slot = this.options.store.db.run(
      `UPDATE notification_devices SET last_attempt_at = ?, next_send_at = ?
       WHERE receiver_id = ? AND (last_attempt_at IS NULL OR ? >= next_send_at)`,
      [now, now + SEND_SLOT_INTERVAL_MS, deviceId, now],
    );
    if (slot.changes === 0) {
      this.scheduleDevice(deviceId, this.options.store.getNotificationDeviceRow(deviceId)?.next_send_at ?? now);
      return;
    }
    const claimed = this.options.store.db.run(
      "UPDATE notification_deliveries SET state = 'claimed' WHERE delivery_id = ? AND state IN ('pending', 'retry_wait', 'unknown')",
      [delivery.delivery_id],
    );
    if (claimed.changes === 0) return;

    let vapid: Uint8Array | undefined;
    try {
      vapid = await this.options.native.read("vapid");
      vapidPrivate32(vapid);
    } catch {
      this.markFailed(delivery.delivery_id, "vapid_unavailable");
      return;
    }

    const abortCtrl = new AbortController();
    this.inFlightByDevice.set(deviceId, abortCtrl);
    this.activeGlobalRequests++;
    const timeoutId = setTimeout(() => abortCtrl.abort("timeout"), REQUEST_TIMEOUT_MS);
    let response: Response | undefined;
    let fetchError: Error | undefined;
    try {
      let url: URL;
      try {
        url = parsePushEndpoint(sub.endpoint);
      } catch {
        deletePushSubs(this.options.store, deviceId);
        return;
      }
      const p256dh = keyBytes(sub.p256dh, 65);
      const auth = keyBytes(sub.auth, 16);
      const body = encryptPush(Buffer.from(PUSH_PLAINTEXT), p256dh, auth);
      const headers = pushHeaders(url, vapid, contactUri, now);
      const fetchFn = this.options.fetch ?? createSafePushFetch();
      response = await fetchFn(url, {
        method: "POST",
        redirect: "error",
        headers,
        body: Buffer.from(body),
        signal: abortCtrl.signal,
      });
    } catch (err) {
      fetchError = err as Error;
    } finally {
      clearTimeout(timeoutId);
      vapid.fill(0);
      this.activeGlobalRequests--;
      this.inFlightByDevice.delete(deviceId);
      if (this.activeGlobalRequests < GLOBAL_CONCURRENCY_LIMIT) {
        const waiting = [...this.retryDueAt.entries()].sort((a, b) => a[1] - b[1])[0];
        if (waiting) this.scheduleDevice(waiting[0], this.now() + 1);
      }
    }

    const postNow = this.now();
    const postDev = this.options.store.getNotificationDeviceRow(deviceId);
    const postSub = pushSub(this.options.store, deviceId);
    const stillTrusted = this.isDeviceTrusted(deviceId);
    const genMatches =
      postDev?.push_generation === delivery.push_generation &&
      postSub?.generation === delivery.push_generation;
    const trustMatches = delivery.trust_generation === this.currentTrustGeneration();
    const abortReason = abortCtrl.signal.reason;
    const revokeAbort =
      abortReason === "device_aborted" || abortReason === "trust_invalidated" || abortReason === "closed";
    const timedOut =
      abortReason === "timeout" ||
      (fetchError?.name === "AbortError" && !revokeAbort);
    const aborted = revokeAbort || (abortCtrl.signal.aborted && !timedOut);

    if (!stillTrusted || aborted || !trustMatches) {
      this.markFailed(delivery.delivery_id, aborted || !stillTrusted ? "aborted" : "stale_trust");
      this.writeDiagnostics(deviceId, delivery.push_generation, aborted || !stillTrusted ? "aborted" : "stale_trust");
      return;
    }
    if (!genMatches) {
      this.markFailed(delivery.delivery_id, "replaced");
      return;
    }

    if (response && response.status >= 200 && response.status < 300) {
      this.options.store.transaction(() => {
        this.options.store.db.run(
          "UPDATE notification_deliveries SET state = 'accepted', attempt = attempt + 1 WHERE delivery_id = ? AND state = 'claimed'",
          [delivery.delivery_id],
        );
        this.writeDiagnostics(deviceId, delivery.push_generation, "accepted");
     });
      return;
    }

    if (response && (response.status === 404 || response.status === 410)) {
      this.options.store.transaction(() => {
        this.options.store.db.run(
          "DELETE FROM remote_push_subs WHERE device_id = ? AND generation = ?",
          [deviceId, delivery.push_generation],
        );
        this.options.store.db.run(
          `UPDATE notification_devices
           SET push_generation = push_generation + 1, revision = revision + 1,
               last_invalid_endpoint_hash = ?, last_invalid_reason = 'gone', last_diagnostics = 'gone'
           WHERE receiver_id = ? AND push_generation = ?`,
          [endpointHash(sub.endpoint), deviceId, delivery.push_generation],
        );
        this.options.store.db.run(
          "UPDATE notification_deliveries SET state = 'failed', error_code = 'gone' WHERE delivery_id = ? AND state = 'claimed'",
          [delivery.delivery_id],
        );
      });
      return;
    }

    if (fetchError instanceof HttpError && fetchError.code === "redirect_forbidden") {
      this.markFailed(delivery.delivery_id, "redirect_forbidden");
      this.writeDiagnostics(deviceId, delivery.push_generation, "redirect_forbidden");
      return;
    }

    if (response && response.status === 429) {
      const retryHeader = response.headers.get("Retry-After");
      let retryAfterMs = 5_000;
      if (retryHeader) {
        const seconds = Number(retryHeader);
        if (!Number.isNaN(seconds) && seconds > 0) retryAfterMs = seconds * 1000;
        else {
          const parsedDate = Date.parse(retryHeader);
          if (!Number.isNaN(parsedDate) && parsedDate > postNow) retryAfterMs = parsedDate - postNow;
        }
      }
      const nextAttemptAt = Math.max(postNow + retryAfterMs, postDev?.next_send_at ?? 0);
      this.scheduleRetry(delivery, delivery.attempt + 1, nextAttemptAt, "http_429");
      this.scheduleDevice(deviceId, nextAttemptAt);
      return;
    }

    if (timedOut || fetchError || (response && response.status >= 500)) {
      const nextAttemptCount = delivery.attempt + 1;
      const backoff = nextAttemptCount === 1 ? 5_000 : 20_000;
      const jitter = Math.floor(Math.random() * 1_000);
      const nextAttemptAt = Math.max(postNow + backoff + jitter, postDev?.next_send_at ?? 0);
      const errorCode = timedOut ? "timeout" : response ? `http_${response.status}` : "network_error";
      this.scheduleRetry(delivery, nextAttemptCount, nextAttemptAt, errorCode);
      if (nextAttemptCount < MAX_DELIVERY_ATTEMPTS && nextAttemptAt <= delivery.absolute_expires_at) {
        this.scheduleDevice(deviceId, nextAttemptAt);
      }
      return;
    }

    const errCode = response ? `http_${response.status}` : "error";
    this.markFailed(delivery.delivery_id, errCode);
    this.writeDiagnostics(deviceId, delivery.push_generation, errCode);
  }
}
