import {
  type DesktopClaimRequest,
  type DesktopClaimResponse,
  type DesktopReconcileRequest,
  type DesktopReconcileResponse,
  type DesktopReportRequest,
  type DesktopRevalidateRequest,
  type DesktopRevalidateResponse,
  type DesktopStateResponse,
  type NotificationDevice,
  type NotificationItem,
  type NotificationPolicy,
  type NotificationPresence,
  type NotificationTarget,
} from "@real-bot/protocol";
import { HttpError } from "./errors";
import { ulid } from "./ids";
import { truncateCodePoints } from "./notification-policy";
import type { Store } from "./store";
import { NEEDS_ATTENTION_SQL } from "./store/notifications";

export const BATCHING_WINDOW_MS = 2_000;
export const SEND_SLOT_INTERVAL_MS = 30_000;
export const CLAIM_LEASE_MS = 10_000;
export const DELIVERY_ABSOLUTE_DEADLINE_MS = 120_000;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const PRESENCE_LEASE_MS = 10_000;
export const TEST_RATE_LIMIT_MS = 60_000;
export const BATCH_ITEM_LIMIT = 100;
const CANDIDATE_SCAN_LIMIT = 200;

export type PresenceRecord = NotificationPresence & {
  receiver_id: string;
  last_seen_at: number;
};

export class PresenceManager {
  private records = new Map<string, PresenceRecord>();
  private lastUpdateByInstance = new Map<string, number>();

  update(receiverId: string, presence: NotificationPresence, now: number = Date.now()): void {
    const last = this.lastUpdateByInstance.get(presence.instance_id) ?? 0;
    if (now - last < 1_000) {
      // 1 update per second rate limit per instance
      return;
    }
    this.lastUpdateByInstance.set(presence.instance_id, now);

    this.sweep(now);

    const existingForReceiver = Array.from(this.records.values()).filter(
      (r) => r.receiver_id === receiverId,
    );
    if (existingForReceiver.length >= 4 && !this.records.has(presence.instance_id)) {
      const oldest = existingForReceiver.sort((a, b) => a.last_seen_at - b.last_seen_at)[0];
      if (oldest) {
        this.records.delete(oldest.instance_id);
      }
    }

    if (!presence.visible) {
      this.records.delete(presence.instance_id);
      return;
    }

    this.records.set(presence.instance_id, {
      ...presence,
      receiver_id: receiverId,
      last_seen_at: now,
    });
  }

  isReceiverActiveForeground(
    receiverId: string,
    sessionId?: string | null,
    now: number = Date.now(),
  ): boolean {
    this.sweep(now);
    for (const record of this.records.values()) {
      if (record.receiver_id !== receiverId) continue;
      if (record.visible && record.focused) {
        if (!sessionId) return true;
        if (record.session_id === sessionId && record.at_latest) return true;
      }
    }
    return false;
  }

  sweep(now: number = Date.now()): void {
    for (const [id, record] of this.records.entries()) {
      if (now - record.last_seen_at > PRESENCE_LEASE_MS) {
        this.records.delete(id);
      }
    }
    for (const [inst, time] of this.lastUpdateByInstance.entries()) {
      if (now - time > PRESENCE_LEASE_MS * 2) {
        this.lastUpdateByInstance.delete(inst);
      }
    }
  }

  clear(): void {
    this.records.clear();
    this.lastUpdateByInstance.clear();
  }
}

export function isQuietHoursActive(policy: NotificationPolicy, at: Date = new Date()): boolean {
  if (!policy.quiet_hours.enabled) return false;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: policy.quiet_hours.time_zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const currentMin = hour * 60 + minute;

    const [startH, startM] = policy.quiet_hours.start.split(":").map(Number);
    const [endH, endM] = policy.quiet_hours.end.split(":").map(Number);
    if (startH === undefined || startM === undefined || endH === undefined || endM === undefined) {
      return false;
    }
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;

    if (startMin < endMin) {
      return currentMin >= startMin && currentMin < endMin;
    } else {
      return currentMin >= startMin || currentMin < endMin;
    }
  } catch {
    return false;
  }
}

/** Next quiet-end instant in epoch ms. Null when quiet hours are off or already inactive. */
export function nextQuietHoursEndMs(policy: NotificationPolicy, at: Date = new Date()): number | null {
  if (!isQuietHoursActive(policy, at)) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: policy.quiet_hours.time_zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const currentMin = hour * 60 + minute;
    const [endH, endM] = policy.quiet_hours.end.split(":").map(Number);
    if (endH === undefined || endM === undefined) return null;
    const endMin = endH * 60 + endM;
    const minutesUntilEnd = currentMin < endMin ? endMin - currentMin : 24 * 60 - currentMin + endMin;
    const second = at.getUTCSeconds();
    const ms = at.getUTCMilliseconds();
    return at.getTime() + minutesUntilEnd * 60_000 - second * 1_000 - ms;
  } catch {
    return null;
  }
}

function renderDesktopDeliveryContent(
  dev: NotificationDevice,
  highest: NotificationItem,
  candidateCount: number,
): { title: string; body: string } {
  const isExcerptAllowed =
    dev.preview === "reply_excerpt" &&
    (highest.kind === "reply" || highest.kind === "routine_result");

  let title: string;
  let body: string;

  if (isExcerptAllowed) {
    title = truncateCodePoints(highest.display.title, 80);
    const summary = truncateCodePoints(highest.display.summary, 80);
    body = candidateCount > 1 ? `${summary} (等 ${candidateCount} 项)` : summary;
  } else {
    title = "Real Bot";
    if (highest.kind === "approval") {
      body = candidateCount > 1 ? `有 ${candidateCount} 项待处理事项，打开查看` : "有待批准事项，打开查看";
    } else if (highest.kind === "ask") {
      body = candidateCount > 1 ? `有 ${candidateCount} 项待处理事项，打开查看` : "有等待回答的问题，打开查看";
    } else if (highest.kind === "failure") {
      body = candidateCount > 1 ? `有 ${candidateCount} 项待处理事项，打开查看` : "有任务执行失败，打开查看";
    } else if (highest.kind === "interrupted") {
      body = candidateCount > 1 ? `有 ${candidateCount} 项待处理事项，打开查看` : "有任务已中断，打开查看";
    } else {
      body = candidateCount > 1 ? `有 ${candidateCount} 条新通知` : "有新回复，打开查看";
    }
  }

  return { title, body };
}

const TEST_DESKTOP_COPY = {
  title: "Real Bot",
  body: "这是一条测试通知",
  sound: "default" as const,
  identifier: "test",
};

type AttentionScanRow = {
  id: string;
  ordinal: number;
  kind: NotificationItem["kind"];
  session_id: string | null;
  created_at: string;
  read_at: string | null;
  action_state: string;
};

type ItemDeliveryDisposition = {
  live: boolean;
  accepted: boolean;
  terminalAlert: boolean;
};

export class NotificationDeliveryScheduler {
  private lastTestAtByReceiver = new Map<string, number>();
  /** Armed on process start and again when quiet hours end; consumed by one summary batch. */
  private recoveryArmed = true;
  private recoveryFloor: number | null = null;
  private recoveryCeiling: number | null = null;
  private lastQuiet: boolean | null = null;

  constructor(
    private readonly store: Store,
    private readonly presence: PresenceManager,
  ) {}

  private noteQuietTransition(isQuiet: boolean): void {
    if (this.lastQuiet === true && !isQuiet) {
      this.recoveryArmed = true;
      this.recoveryFloor = null;
      this.recoveryCeiling = null;
    }
    this.lastQuiet = isQuiet;
  }

  private consumeRecovery(): void {
    this.recoveryArmed = false;
    this.recoveryFloor = null;
    this.recoveryCeiling = null;
  }

  private itemDisposition(notificationId: string): ItemDeliveryDisposition {
    const states = this.store.db
      .query<{ state: string }, [string]>(
        `SELECT d.state as state
         FROM notification_delivery_items di
         JOIN notification_deliveries d ON d.delivery_id = di.delivery_id
         WHERE di.notification_id = ? AND d.receiver_id = 'desktop'`,
      )
      .all(notificationId);
    let live = false;
    let accepted = false;
    let terminalAlert = false;
    for (const row of states) {
      if (row.state === "pending" || row.state === "claimed" || row.state === "retry_wait") {
        live = true;
      } else if (row.state === "accepted") {
        accepted = true;
      } else if (row.state === "failed" || row.state === "expired" || row.state === "unknown") {
        terminalAlert = true;
      }
    }
    return { live, accepted, terminalAlert };
  }

  private releaseClaimToRetryWait(
    deliveryId: string,
    claimToken: string,
    nextAttemptAt: number,
  ): void {
    this.store.db.run(
      `UPDATE notification_deliveries
       SET state = 'retry_wait', next_attempt_at = ?
       WHERE delivery_id = ? AND claim_token = ? AND state = 'claimed'`,
      [nextAttemptAt, deliveryId, claimToken],
    );
  }

  private loadAttentionWindow(startOrdinal: number): AttentionScanRow[] {
    return this.store.db
      .query<AttentionScanRow, [number, number]>(
        `SELECT id, ordinal, kind, session_id, created_at, read_at, action_state
         FROM notifications
         WHERE ordinal >= ?
           AND (read_at IS NULL OR action_state = 'open')
         ORDER BY ordinal ASC
         LIMIT ?`,
      )
      .all(startOrdinal, CANDIDATE_SCAN_LIMIT);
  }

  private classifyDesktopCandidate(
    row: AttentionScanRow,
    now: number,
    policy: NotificationPolicy,
    allowRecovery: boolean,
  ): "skip" | "defer" | "ready" {
    if (!policy.categories[row.kind]) return "skip";

    if ((row.kind === "reply" || row.kind === "routine_result") && row.session_id) {
      const pref = this.store.getSessionNotificationPreference(row.session_id);
      if (pref.muted) return "skip";
    }

    const isForeground =
      Boolean(row.session_id) &&
      this.presence.isReceiverActiveForeground("desktop", row.session_id, now);
    const createdMs = new Date(row.created_at).getTime();
    if (isForeground || now - createdMs < BATCHING_WINDOW_MS) {
      return "defer";
    }

    if (row.action_state === "none" && now - createdMs > DELIVERY_ABSOLUTE_DEADLINE_MS) {
      return "skip";
    }

    const disposition = this.itemDisposition(row.id);
    if (disposition.live || disposition.accepted) return "skip";
    if (disposition.terminalAlert) {
      if (!allowRecovery || row.action_state !== "open" || row.read_at !== null) return "skip";
    }
    return "ready";
  }

  claimDesktop(
    req: DesktopClaimRequest,
    now: number = Date.now(),
  ): DesktopClaimResponse | null {
    const dev = this.store.getNotificationDevice("desktop");
    if (!dev.enabled || req.permission !== "granted") {
      return null;
    }

    const policy = this.store.getNotificationPolicy();
    const isQuiet = isQuietHoursActive(policy, new Date(now));

    // Check active delivery for this receiver/channel (max 1 active per receiver/channel)
    const activeDelivery = this.store.db
      .query<{
        delivery_id: string;
        claim_token: string;
        claim_expires_at: number;
        absolute_expires_at: number;
        click_ref: string;
        state: string;
        batch_key: string;
        attempt: number;
        next_attempt_at: number | null;
        permit: string | null;
      }, []>(`
        SELECT delivery_id, claim_token, claim_expires_at, absolute_expires_at, click_ref, state, batch_key, attempt, next_attempt_at, permit
        FROM notification_deliveries
        WHERE receiver_id = 'desktop' AND channel = 'desktop' AND state IN ('claimed', 'pending', 'retry_wait')
        LIMIT 1
      `)
      .get();

    if (activeDelivery) {
      if (activeDelivery.state === "claimed") {
        if (now < activeDelivery.claim_expires_at) {
          // Still in-flight
          return null;
        }
        // Claim lease expired. Only a permit (actual send) counts as an attempt.
        if (now >= activeDelivery.absolute_expires_at) {
          this.store.db.run(
            "UPDATE notification_deliveries SET state = 'expired' WHERE delivery_id = ?",
            [activeDelivery.delivery_id],
          );
        } else if (!activeDelivery.permit) {
          this.store.db.run(
            `UPDATE notification_deliveries
             SET state = 'retry_wait', next_attempt_at = ?
             WHERE delivery_id = ? AND state = 'claimed'`,
            [now, activeDelivery.delivery_id],
          );
        } else {
          const nextAttempt = activeDelivery.attempt + 1;
          const nextState = nextAttempt >= MAX_DELIVERY_ATTEMPTS ? "failed" : "retry_wait";
          const nextAttemptAt = now + (nextAttempt === 1 ? 5_000 : 20_000);
          this.store.db.run(
            "UPDATE notification_deliveries SET state = ?, attempt = ?, next_attempt_at = ? WHERE delivery_id = ?",
            [nextState, nextAttempt, nextAttemptAt, activeDelivery.delivery_id],
          );
        }
        return null;
      }

      if (activeDelivery.state === "retry_wait") {
        if (now >= activeDelivery.absolute_expires_at) {
          this.store.db.run(
            "UPDATE notification_deliveries SET state = 'expired' WHERE delivery_id = ?",
            [activeDelivery.delivery_id],
          );
          return null;
        }
        if (isQuiet) return null;
        if (now >= (activeDelivery.next_attempt_at ?? 0)) {
          const devRow = this.store.getNotificationDeviceRow("desktop");
          if (devRow?.last_attempt_at && now < (devRow.next_send_at ?? 0)) {
            return null;
          }
          // Re-claim this delivery
          const newClaimToken = ulid();
          const newLeaseExpiresAt = now + CLAIM_LEASE_MS;
          this.store.db.run(
            "UPDATE notification_deliveries SET state = 'claimed', claim_token = ?, claim_expires_at = ? WHERE delivery_id = ?",
            [newClaimToken, newLeaseExpiresAt, activeDelivery.delivery_id],
          );

          if (activeDelivery.batch_key.startsWith("test:")) {
            return {
              delivery_id: activeDelivery.delivery_id,
              claim_token: newClaimToken,
              lease_expires_at: newLeaseExpiresAt,
              click_ref: activeDelivery.click_ref,
              ...TEST_DESKTOP_COPY,
            };
          }

          const items = this.store.db
            .query<{ id: string }, [string]>(
              "SELECT notification_id as id FROM notification_delivery_items WHERE delivery_id = ?",
            )
            .all(activeDelivery.delivery_id);

          const firstItem = items[0] ? this.store.getNotification(items[0].id) : null;
          const content = firstItem
            ? renderDesktopDeliveryContent(dev, firstItem, items.length)
            : { title: "Real Bot", body: "有待处理事项，打开查看" };

          const sound = dev.sound === "off" ? "off" : "default";
          const singleSession = activeDelivery.batch_key.startsWith("session:");
          const identifier = singleSession ? activeDelivery.batch_key.split(":")[0] + ":" + activeDelivery.batch_key.split(":")[1] : "host:all";

          return {
            delivery_id: activeDelivery.delivery_id,
            claim_token: newClaimToken,
            lease_expires_at: newLeaseExpiresAt,
            click_ref: activeDelivery.click_ref,
            title: content.title,
            body: content.body,
            sound,
            identifier,
          };
        }
        // Still waiting for retry backoff
        return null;
      }

      if (activeDelivery.state === "pending" && activeDelivery.batch_key.startsWith("test:")) {
        // Pending test delivery
        const devRow = this.store.getNotificationDeviceRow("desktop");
        if (devRow?.last_attempt_at && now < (devRow.next_send_at ?? 0)) {
          return null;
        }
        const claimToken = ulid();
        const leaseExpiresAt = now + CLAIM_LEASE_MS;
        this.store.db.run(
          "UPDATE notification_deliveries SET state = 'claimed', claim_token = ?, claim_expires_at = ? WHERE delivery_id = ?",
          [claimToken, leaseExpiresAt, activeDelivery.delivery_id],
        );
        return {
          delivery_id: activeDelivery.delivery_id,
          claim_token: claimToken,
          lease_expires_at: leaseExpiresAt,
          click_ref: activeDelivery.click_ref,
          ...TEST_DESKTOP_COPY,
        };
      }
    }

    this.noteQuietTransition(isQuiet);

    // Quiet hours suppresses new business claims
    if (isQuiet) {
      return null;
    }

    // Check shared 30s send slot
    const devRow = this.store.getNotificationDeviceRow("desktop");
    if (devRow?.last_attempt_at && now < (devRow.next_send_at ?? 0)) {
      return null;
    }

    this.store.pruneNotificationDeliveriesRetention(now);

    const plannedOrdinal = devRow?.planned_ordinal ?? 0;
    if (this.recoveryArmed && this.recoveryCeiling === null) {
      const oldestOpen = this.store.db
        .query<{ ordinal: number }, []>(
          `SELECT MIN(ordinal) as ordinal FROM notifications
           WHERE action_state = 'open' AND read_at IS NULL`,
        )
        .get()?.ordinal;
      this.recoveryFloor = oldestOpen ?? Number.POSITIVE_INFINITY;
      this.recoveryCeiling = plannedOrdinal;
    }
    const scanStart =
      this.recoveryArmed && this.recoveryFloor !== null && Number.isFinite(this.recoveryFloor)
        ? Math.min(this.recoveryFloor, plannedOrdinal + 1)
        : plannedOrdinal + 1;
    const rows = this.loadAttentionWindow(Math.max(1, scanStart));

    const candidates: NotificationItem[] = [];
    let minDeferredOrdinal = Infinity;
    let watermark = plannedOrdinal;
    let recoveryDeferred = false;
    let includedRecovery = false;
    let batchCount = 0;

    for (const row of rows) {
      const allowRecovery =
        this.recoveryArmed &&
        this.recoveryCeiling !== null &&
        this.recoveryFloor !== null &&
        row.ordinal >= this.recoveryFloor &&
        row.ordinal <= this.recoveryCeiling;
      const verdict = this.classifyDesktopCandidate(row, now, policy, allowRecovery);
      if (verdict === "defer") {
        if (allowRecovery) recoveryDeferred = true;
        minDeferredOrdinal = Math.min(minDeferredOrdinal, row.ordinal);
        break;
      }
      if (verdict === "skip") {
        if (minDeferredOrdinal === Infinity) watermark = row.ordinal;
        continue;
      }
      batchCount += 1;
      if (allowRecovery) includedRecovery = true;
      if (candidates.length < BATCH_ITEM_LIMIT) {
        const item = this.store.getNotification(row.id);
        if (item) candidates.push(item);
      } else if (!allowRecovery) {
        break;
      }
    }

    if (candidates.length === 0) {
      let targetOrdinal = watermark;
      if (minDeferredOrdinal < Infinity) {
        targetOrdinal = Math.min(targetOrdinal, minDeferredOrdinal - 1);
      }
      if (targetOrdinal > plannedOrdinal) {
        this.store.db.run(
          "UPDATE notification_devices SET planned_ordinal = ? WHERE receiver_id = 'desktop' AND planned_ordinal < ?",
          [targetOrdinal, targetOrdinal],
        );
      }
      if (!recoveryDeferred) this.consumeRecovery();
      return null;
    }

    // Form batch
    const deliveryId = ulid();
    const claimToken = ulid();
    const clickRef = ulid();
    const leaseExpiresAt = now + CLAIM_LEASE_MS;
    const absExpiresAt = now + DELIVERY_ABSOLUTE_DEADLINE_MS;

    const highest = candidates.reduce((a, b) => (a.ordinal >= b.ordinal ? a : b));
    const singleSession = candidates.every((c) => c.session_id === highest.session_id);
    const identifier = singleSession && highest.session_id ? `session:${highest.session_id}` : "host:all";
    const batchKey = `${identifier}:${deliveryId}`;

    const content = renderDesktopDeliveryContent(dev, highest, batchCount);
    const sound = dev.sound === "off" ? "off" : "default";

    this.store.transaction(() => {
      this.store.db.run(
        `INSERT INTO notification_deliveries (
          delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
          state, attempt, next_attempt_at, absolute_expires_at, claim_token,
          claim_expires_at, push_generation, trust_generation, created_at
        ) VALUES (?, 'desktop', 'desktop', ?, ?, ?, 'claimed', 0, ?, ?, ?, ?, 1, 1, ?)`,
        [
          deliveryId,
          batchKey,
          highest.ordinal,
          clickRef,
          now,
          absExpiresAt,
          claimToken,
          leaseExpiresAt,
          now,
        ],
      );

      for (const item of candidates) {
        this.store.db.run(
          "INSERT OR IGNORE INTO notification_delivery_items (delivery_id, notification_id) VALUES (?, ?)",
          [deliveryId, item.id],
        );
      }

      // Never advance planned_ordinal past a deferred hole or an unseen ordinal.
      const maxAttached = Math.max(...candidates.map((c) => c.ordinal));
      let targetOrdinal = Math.max(watermark, maxAttached);
      if (minDeferredOrdinal < Infinity) {
        targetOrdinal = Math.min(targetOrdinal, minDeferredOrdinal - 1);
      }
      if (targetOrdinal > plannedOrdinal) {
        this.store.db.run(
          "UPDATE notification_devices SET planned_ordinal = ? WHERE receiver_id = 'desktop' AND planned_ordinal < ?",
          [targetOrdinal, targetOrdinal],
        );
      }
    });

    if (includedRecovery || !recoveryDeferred) {
      this.consumeRecovery();
    }

    return {
      delivery_id: deliveryId,
      claim_token: claimToken,
      lease_expires_at: leaseExpiresAt,
      click_ref: clickRef,
      title: content.title,
      body: content.body,
      sound,
      identifier,
    };
  }

  revalidateDesktop(
    req: DesktopRevalidateRequest,
    now: number = Date.now(),
  ): DesktopRevalidateResponse {
    const delivery = this.store.db
      .query<{
        delivery_id: string;
        claim_token: string;
        claim_expires_at: number;
        absolute_expires_at: number;
        state: string;
        batch_key: string;
        permit: string | null;
      }, [string]>(`
        SELECT delivery_id, claim_token, claim_expires_at, absolute_expires_at, state, batch_key, permit
        FROM notification_deliveries
        WHERE delivery_id = ?
      `)
      .get(req.delivery_id);

    if (!delivery || delivery.claim_token !== req.claim_token) {
      return { action: "cancel" };
    }
    if (delivery.state !== "claimed") {
      return { action: "cancel" };
    }
    if (now > delivery.absolute_expires_at) {
      this.store.db.run(
        "UPDATE notification_deliveries SET state = 'expired' WHERE delivery_id = ?",
        [req.delivery_id],
      );
      return { action: "cancel" };
    }

    const dev = this.store.getNotificationDevice("desktop");
    if (!dev.enabled) {
      return { action: "cancel" };
    }

    // Handle test delivery
    if (delivery.batch_key.startsWith("test:")) {
      if (delivery.permit) {
        return {
          action: "deliver",
          permit: delivery.permit,
          title: TEST_DESKTOP_COPY.title,
          body: TEST_DESKTOP_COPY.body,
          sound: dev.sound === "off" ? "off" : "default",
        };
      }
      const devRow = this.store.getNotificationDeviceRow("desktop");
      if (devRow?.last_attempt_at && now < (devRow.next_send_at ?? 0)) {
        const retryAfterMs = Math.max(1_000, (devRow.next_send_at ?? 0) - now);
        this.releaseClaimToRetryWait(req.delivery_id, req.claim_token, now + retryAfterMs);
        return {
          action: "retry_later",
          retry_after_ms: retryAfterMs,
        };
      }
      const permit = ulid();
      this.store.db.run(
        "UPDATE notification_devices SET last_attempt_at = ?, next_send_at = ? WHERE receiver_id = 'desktop'",
        [now, now + SEND_SLOT_INTERVAL_MS],
      );
      this.store.db.run(
        "UPDATE notification_deliveries SET permit = ? WHERE delivery_id = ? AND claim_token = ?",
        [permit, req.delivery_id, req.claim_token],
      );
      return {
        action: "deliver",
        permit,
        title: TEST_DESKTOP_COPY.title,
        body: TEST_DESKTOP_COPY.body,
        sound: dev.sound === "off" ? "off" : "default",
      };
    }

    const policy = this.store.getNotificationPolicy();
    if (isQuietHoursActive(policy, new Date(now))) {
      this.releaseClaimToRetryWait(req.delivery_id, req.claim_token, now + 60_000);
      return { action: "retry_later", retry_after_ms: 60_000 };
    }

    // Check shared 30s send slot
    const devRow = this.store.getNotificationDeviceRow("desktop");
    if (devRow?.last_attempt_at && now < (devRow.next_send_at ?? 0)) {
      const retryAfterMs = Math.max(1_000, (devRow.next_send_at ?? 0) - now);
      this.releaseClaimToRetryWait(req.delivery_id, req.claim_token, now + retryAfterMs);
      return {
        action: "retry_later",
        retry_after_ms: retryAfterMs,
      };
    }

    // Check if items in delivery are still unread/open
    const items = this.store.db
      .query<{ id: string; read_at: string | null; action_state: string }, [string]>(`
        SELECT n.id, n.read_at, n.action_state
        FROM notification_delivery_items di
        JOIN notifications n ON n.id = di.notification_id
        WHERE di.delivery_id = ?
      `)
      .all(req.delivery_id);

    const activeItems = items.filter(
      (i) => i.read_at === null || i.action_state === "open",
    );
    if (activeItems.length === 0) {
      this.store.db.run(
        "UPDATE notification_deliveries SET state = 'suppressed' WHERE delivery_id = ?",
        [req.delivery_id],
      );
      return { action: "cancel" };
    }

    if (delivery.permit) {
      const highestItem = this.store.getNotification(activeItems[0]!.id);
      const content = highestItem
        ? renderDesktopDeliveryContent(dev, highestItem, activeItems.length)
        : { title: "Real Bot", body: "有待处理事项，打开查看" };

      const sound = dev.sound === "off" ? "off" : "default";

      return {
        action: "deliver",
        permit: delivery.permit,
        title: content.title,
        body: content.body,
        sound,
      };
    }

    // Atomically reserve 30s send slot via CAS
    const updated = this.store.db.run(
      `UPDATE notification_devices
       SET last_attempt_at = ?, next_send_at = ?
       WHERE receiver_id = 'desktop' AND (last_attempt_at IS NULL OR ? >= next_send_at)`,
      [now, now + SEND_SLOT_INTERVAL_MS, now],
    );

    if (updated.changes === 0) {
      const retryAfterMs = Math.max(1_000, (devRow?.next_send_at ?? now) - now);
      this.releaseClaimToRetryWait(req.delivery_id, req.claim_token, now + retryAfterMs);
      return {
        action: "retry_later",
        retry_after_ms: retryAfterMs,
      };
    }

    const permit = ulid();
    this.store.db.run(
      "UPDATE notification_deliveries SET permit = ? WHERE delivery_id = ? AND claim_token = ?",
      [permit, req.delivery_id, req.claim_token],
    );

    const highestItem = this.store.getNotification(activeItems[0]!.id);
    const content = highestItem
      ? renderDesktopDeliveryContent(dev, highestItem, activeItems.length)
      : { title: "Real Bot", body: "有待处理事项，打开查看" };

    const sound = dev.sound === "off" ? "off" : "default";

    return {
      action: "deliver",
      permit,
      title: content.title,
      body: content.body,
      sound,
    };
  }

  reportDesktop(
    req: DesktopReportRequest,
    now: number = Date.now(),
  ): void {
    const delivery = this.store.db
      .query<{ delivery_id: string; claim_token: string; state: string; attempt: number; absolute_expires_at: number }, [string]>(`
        SELECT delivery_id, claim_token, state, attempt, absolute_expires_at
        FROM notification_deliveries
        WHERE delivery_id = ?
      `)
      .get(req.delivery_id);

    if (!delivery || delivery.claim_token !== req.claim_token) {
      return;
    }
    if (delivery.state !== "claimed") {
      return;
    }

    if (req.result === "accepted") {
      this.store.db.run(
        "UPDATE notification_deliveries SET state = 'accepted', attempt = attempt + 1 WHERE delivery_id = ? AND claim_token = ? AND state = 'claimed'",
        [req.delivery_id, req.claim_token],
      );
    } else {
      const nextAttempt = delivery.attempt + 1;
      const isCancelled = req.code === "cancelled" || req.code === "suppressed";
      const isFailed = nextAttempt >= MAX_DELIVERY_ATTEMPTS || now >= delivery.absolute_expires_at;
      const nextState = isCancelled
        ? "suppressed"
        : isFailed
          ? req.result === "unknown"
            ? "unknown"
            : "failed"
          : "retry_wait";
      const nextAttemptAt = isCancelled || isFailed ? null : now + (nextAttempt === 1 ? 5_000 : 20_000);
      this.store.db.run(
        "UPDATE notification_deliveries SET state = ?, attempt = ?, next_attempt_at = ?, error_code = ? WHERE delivery_id = ? AND claim_token = ? AND state = 'claimed'",
        [nextState, nextAttempt, nextAttemptAt, req.code ?? req.result, req.delivery_id, req.claim_token],
      );
    }
  }

  resolveClick(
    clickRef: string,
  ): { target?: NotificationTarget; open_inbox: boolean } | null {
    const delivery = this.store.db
      .query<{ delivery_id: string; batch_key: string }, [string]>(`
        SELECT delivery_id, batch_key FROM notification_deliveries WHERE click_ref = ?
      `)
      .get(clickRef);

    if (!delivery) {
      return null;
    }

    if (delivery.batch_key.startsWith("test:")) {
      return { open_inbox: false };
    }

    const items = this.store.db
      .query<{
        id: string;
        session_id: string | null;
        message_id: string | null;
        approval_id: string | null;
        turn_id: string | null;
        kind: string;
        action_state: string;
      }, [string]>(`
        SELECT n.id, n.session_id, n.message_id, n.approval_id, n.turn_id, n.kind, n.action_state
        FROM notification_delivery_items di
        JOIN notifications n ON n.id = di.notification_id
        WHERE di.delivery_id = ?
        ORDER BY CASE
          WHEN n.kind = 'approval' AND n.action_state = 'open' THEN 1
          WHEN n.kind = 'ask' AND n.action_state = 'open' THEN 2
          WHEN n.kind IN ('failure', 'interrupted') AND n.action_state = 'open' THEN 3
          ELSE 4
        END ASC
      `)
      .all(delivery.delivery_id);

    const first = items[0];
    if (first && first.session_id) {
      return {
        open_inbox: false,
        target: {
          session_id: first.session_id,
          message_id: first.message_id,
          approval_id: first.approval_id,
          turn_id: first.turn_id,
        },
      };
    }

    return { open_inbox: false };
  }

  getState(): DesktopStateResponse {
    const summary = this.store.getNotificationSummary();
    const cleanupRevision = this.store.getCleanupRevision();
    return {
      attention_count: summary.attention_count,
      cleanup_revision: cleanupRevision,
    };
  }

  reconcile(req: DesktopReconcileRequest): DesktopReconcileResponse {
    const remove: string[] = [];
    for (const identifier of req.identifiers.slice(0, 100)) {
      if (identifier === "test") {
        remove.push(identifier);
      } else if (identifier.startsWith("session:")) {
        const sessionId = identifier.slice("session:".length);
        const activeCount = this.store.db
          .query<{ count: number }, [string]>(`
            SELECT COUNT(*) as count FROM notifications
            WHERE session_id = ? AND ${NEEDS_ATTENTION_SQL}
          `)
          .get(sessionId)?.count ?? 0;
        if (activeCount === 0) {
          remove.push(identifier);
        }
      } else if (identifier === "host:all") {
        const summary = this.store.getNotificationSummary();
        if (summary.attention_count === 0) {
          remove.push(identifier);
        }
      } else {
        remove.push(identifier);
      }
    }
    return { remove_identifiers: remove };
  }

  testDesktop(now: number = Date.now()): { ok: boolean; status: string } {
    const last = this.lastTestAtByReceiver.get("desktop") ?? 0;
    if (now - last < TEST_RATE_LIMIT_MS) {
      throw new HttpError(429, "rate_limited", "test notification rate limited to once per 60 seconds");
    }
    this.lastTestAtByReceiver.set("desktop", now);

    const dev = this.store.getNotificationDevice("desktop");
    if (!dev.enabled) {
      throw new HttpError(409, "device_disabled", "desktop notifications must be enabled to send a test");
    }

    const active = this.store.db
      .query<{ state: string }, []>(
        "SELECT state FROM notification_deliveries WHERE receiver_id = 'desktop' AND channel = 'desktop' AND state IN ('pending', 'claimed', 'retry_wait')",
      )
      .get();
    if (active) {
      throw new HttpError(409, "delivery_busy", "a delivery is currently in progress or waiting for retry");
    }

    const deliveryId = ulid();
    const clickRef = ulid();
    const absExpiresAt = now + DELIVERY_ABSOLUTE_DEADLINE_MS;

    this.store.db.run(
      `INSERT INTO notification_deliveries (
        delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
        state, attempt, next_attempt_at, absolute_expires_at, push_generation, trust_generation, created_at
      ) VALUES (?, 'desktop', 'desktop', ?, 0, ?, 'pending', 0, ?, ?, 1, 1, ?)`,
      [deliveryId, `test:${deliveryId}`, clickRef, now, absExpiresAt, now],
    );

    return { ok: true, status: "queued" };
  }
}
