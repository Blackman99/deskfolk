import { describe, expect, it } from "bun:test";
import { Store } from "./store";
import { memoryKeyStore } from "./store/shared";
import { createLocalApi } from "./local-api";
import { HttpError } from "./errors";
import {
  isQuietHoursActive,
  PresenceManager,
  NotificationDeliveryScheduler,
  CLAIM_LEASE_MS,
} from "./notifications";
import { DELIVERY_RETENTION_MS, MAX_DELIVERY_RECORDS } from "./store/notifications";
import type {
  DesktopClaimResponse,
  DesktopRevalidateResponse,
  DesktopStateResponse,
  NotificationDevice,
  NotificationItem,
  NotificationPolicy,
  RuntimeSnapshot,
  SessionNotificationPreference,
} from "@real-bot/protocol";

describe("notifications scheduler and presence (PR4)", () => {
  it("manages presence leases, rates, and foreground detection", () => {
    const presence = new PresenceManager();
    const t0 = 100_000;

    presence.update(
      "desktop",
      {
        instance_id: "inst_1",
        visible: true,
        focused: true,
        session_id: "sess_1",
        at_latest: true,
      },
      t0,
    );

    expect(presence.isReceiverActiveForeground("desktop", "sess_1", t0 + 1_000)).toBe(true);
    // Different session is not active foreground for sess_2
    expect(presence.isReceiverActiveForeground("desktop", "sess_2", t0 + 1_000)).toBe(false);

    // Lease expires after 10s
    expect(presence.isReceiverActiveForeground("desktop", "sess_1", t0 + 11_000)).toBe(false);
  });

  it("evaluates quiet hours across overnight and timezones", () => {
    const overnightPolicy: NotificationPolicy = {
      revision: 1,
      categories: {
        approval: true,
        ask: true,
        failure: true,
        interrupted: true,
        reply: true,
        routine_result: true,
      },
      quiet_hours: {
        enabled: true,
        start: "22:00",
        end: "08:00",
        time_zone: "UTC",
      },
    };

    // 23:30 UTC is quiet
    expect(isQuietHoursActive(overnightPolicy, new Date("2026-09-22T23:30:00Z"))).toBe(true);
    // 03:30 UTC is quiet
    expect(isQuietHoursActive(overnightPolicy, new Date("2026-09-22T03:30:00Z"))).toBe(true);
    // 12:00 UTC is active
    expect(isQuietHoursActive(overnightPolicy, new Date("2026-09-22T12:00:00Z"))).toBe(false);
  });

  it("handles desktop claim, revalidate, and report cycle with 30s send slot", async () => {
    const token = "test-token";
    const store = new Store({ endpointKey: memoryKeyStore() });
    const api = createLocalApi({ store, token, schedule: false, policyV1: true });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: api.fetch,
      websocket: api.websocket,
    });
    const origin = `http://${server.hostname}:${server.port}`;
    const auth = (extra?: Record<string, string>) => ({
      Authorization: `Bearer ${token}`,
      ...extra,
    });

    try {
      const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });

      // Enable desktop device
      store.updateNotificationDevice("desktop", { if_revision: 0, enabled: true });

      // Create notification older than 2s batch window
      const notif = store.createNotification({
        semantic_key: "msg:1",
        kind: "reply",
        session_id: bot.direct_session.id,
        created_at: new Date(Date.now() - 3_000).toISOString(),
      });

      // Claim delivery
      const claimRes = await fetch(`${origin}/v1/notifications/desktop/claim`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ owner_id: "owner-123456789012", permission: "granted" }),
      });
      expect(claimRes.status).toBe(200);
      const claim = (await claimRes.json()) as DesktopClaimResponse;
      expect(claim.delivery_id).toBeTruthy();
      expect(claim.claim_token).toBeTruthy();

      // Click resolution
      const clickRes = await fetch(`${origin}/v1/notifications/desktop/click/${claim.click_ref}`, {
        headers: auth(),
      });
      expect(clickRes.status).toBe(200);
      const target = (await clickRes.json()) as { target?: { session_id: string } };
      expect(target.target?.session_id).toBe(bot.direct_session.id);

      // Revalidate delivery
      const revalRes = await fetch(`${origin}/v1/notifications/desktop/revalidate`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ delivery_id: claim.delivery_id, claim_token: claim.claim_token }),
      });
      expect(revalRes.status).toBe(200);
      const reval = (await revalRes.json()) as DesktopRevalidateResponse;
      expect(reval.action).toBe("deliver");
      expect(reval.permit).toBeTruthy();

      // Report delivery
      const reportRes = await fetch(`${origin}/v1/notifications/desktop/report`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          delivery_id: claim.delivery_id,
          claim_token: claim.claim_token,
          result: "accepted",
        }),
      });
      expect(reportRes.status).toBe(204);

      // Stale claim token report is ignored and does not corrupt accepted state
      await fetch(`${origin}/v1/notifications/desktop/report`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          delivery_id: claim.delivery_id,
          claim_token: "stale-claim-token",
          result: "failed",
        }),
      });
      const checkState = store.db.query<{ state: string }, [string]>("SELECT state FROM notification_deliveries WHERE delivery_id = ?").get(claim.delivery_id);
      expect(checkState?.state).toBe("accepted");

      // State check
      const stateRes = await fetch(`${origin}/v1/notifications/desktop/state`, { headers: auth() });
      expect(stateRes.status).toBe(200);

      // Reconcile check
      const recRes = await fetch(`${origin}/v1/notifications/desktop/reconcile`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ identifiers: [claim.identifier] }),
      });
      expect(recRes.status).toBe(200);

      // Reset 30s send slot to simulate 30s elapsed time
      store.db.run("UPDATE notification_devices SET last_attempt_at = 0, next_send_at = 0 WHERE receiver_id = 'desktop'");

      // Infinite replay check: unread msg:1 was ALREADY accepted, so next claim returns 204 (no candidate!)
      const noReplayClaim = await fetch(`${origin}/v1/notifications/desktop/claim`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ owner_id: "owner-123456789012", permission: "granted" }),
      });
      expect(noReplayClaim.status).toBe(204);

      // Subsequent new notification for the same session can be claimed without unique constraint violation
      const notif2 = store.createNotification({
        semantic_key: "msg:2",
        kind: "reply",
        session_id: bot.direct_session.id,
        created_at: new Date(Date.now() - 3_000).toISOString(),
      });

      const secondClaim = await fetch(`${origin}/v1/notifications/desktop/claim`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ owner_id: "owner-123456789012", permission: "granted" }),
      });
      expect(secondClaim.status).toBe(200);
      const claim2 = (await secondClaim.json()) as DesktopClaimResponse;
      expect(claim2.delivery_id).not.toBe(claim.delivery_id);
    } finally {
      api.scheduler?.stop();
      await api.engine.close();
      store.close();
      await server.stop(true);
    }
  });

  it("handles test notifications end-to-end", async () => {
    const token = "test-token";
    const store = new Store({ endpointKey: memoryKeyStore() });
    const api = createLocalApi({ store, token, schedule: false, policyV1: true });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: api.fetch,
      websocket: api.websocket,
    });
    const origin = `http://${server.hostname}:${server.port}`;
    const auth = (extra?: Record<string, string>) => ({
      Authorization: `Bearer ${token}`,
      ...extra,
    });

    try {
      store.updateNotificationDevice("desktop", { if_revision: 0, enabled: true });

      // Trigger test notification
      const testRes = await fetch(`${origin}/v1/notifications/desktop/test`, {
        method: "POST",
        headers: auth(),
      });
      expect(testRes.status).toBe(200);

      // Claim claims the pending test delivery
      const claimRes = await fetch(`${origin}/v1/notifications/desktop/claim`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ owner_id: "owner-test", permission: "granted" }),
      });
      expect(claimRes.status).toBe(200);
      const claim = (await claimRes.json()) as DesktopClaimResponse;
      expect(claim.title).toBe("Deskfolk");
      expect(claim.body).toBe("这是一条测试通知");
      expect(claim.identifier).toBe("test");

      // In-memory 60s gate still holds, so HTTP without a clock override is 429.
      // 409 delivery_busy after 61s is asserted against testDesktop(now) below.
      const busyRes = await fetch(`${origin}/v1/notifications/desktop/test`, {
        method: "POST",
        headers: auth(),
      });
      expect(busyRes.status).toBe(429);

      // Revalidate test delivery
      const revalRes = await fetch(`${origin}/v1/notifications/desktop/revalidate`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ delivery_id: claim.delivery_id, claim_token: claim.claim_token }),
      });
      expect(revalRes.status).toBe(200);
      const reval = (await revalRes.json()) as DesktopRevalidateResponse;
      expect(reval.action).toBe("deliver");
      expect(reval.permit).toBeTruthy();

      // Repeated revalidate under same claim returns deliver with permit
      const revalRes2 = await fetch(`${origin}/v1/notifications/desktop/revalidate`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ delivery_id: claim.delivery_id, claim_token: claim.claim_token }),
      });
      expect(revalRes2.status).toBe(200);
      const reval2 = (await revalRes2.json()) as DesktopRevalidateResponse;
      expect(reval2.action).toBe("deliver");
      expect(reval2.permit).toBe(reval.permit);

      // Click test notification
      const clickRes = await fetch(`${origin}/v1/notifications/desktop/click/${claim.click_ref}`, {
        headers: auth(),
      });
      expect(clickRes.status).toBe(200);
      const click = (await clickRes.json()) as { open_inbox: boolean; target?: { session_id?: string } };
      expect(click.open_inbox).toBe(false);
      expect(click.target).toBeUndefined();
    } finally {
      api.scheduler?.stop();
      await api.engine.close();
      store.close();
      await server.stop(true);
    }
  });

  it("preserves privacy by enforcing generic summaries for approvals and questions", async () => {
    const token = "test-token";
    const store = new Store({ endpointKey: memoryKeyStore() });
    const api = createLocalApi({ store, token, schedule: false, policyV1: true });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: api.fetch,
      websocket: api.websocket,
    });
    const origin = `http://${server.hostname}:${server.port}`;
    const auth = (extra?: Record<string, string>) => ({
      Authorization: `Bearer ${token}`,
      ...extra,
    });

    try {
      const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });

      // Enable desktop device with reply_excerpt preview
      store.updateNotificationDevice("desktop", {
        if_revision: 0,
        enabled: true,
        preview: "reply_excerpt",
      });

      // Create an approval with sensitive summary
      const appNotif = store.createNotification({
        semantic_key: "app:sensitive",
        kind: "approval",
        session_id: bot.direct_session.id,
        created_at: new Date(Date.now() - 3_000).toISOString(),
      });

      // Claim should use generic text even though preview is reply_excerpt
      const claimRes = await fetch(`${origin}/v1/notifications/desktop/claim`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ owner_id: "owner-priv", permission: "granted" }),
      });
      expect(claimRes.status).toBe(200);
      const claim = (await claimRes.json()) as DesktopClaimResponse;
      expect(claim.title).toBe("Deskfolk");
      expect(claim.body).toBe("有待批准事项，打开查看");
    } finally {
      api.scheduler?.stop();
      await api.engine.close();
      store.close();
      await server.stop(true);
    }
  });

  it("handles delivery failure retry backoff and monotonic cleanup_revision", async () => {
    const token = "test-token";
    const store = new Store({ endpointKey: memoryKeyStore() });
    const api = createLocalApi({ store, token, schedule: false, policyV1: true });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: api.fetch,
      websocket: api.websocket,
    });
    const origin = `http://${server.hostname}:${server.port}`;
    const auth = (extra?: Record<string, string>) => ({
      Authorization: `Bearer ${token}`,
      ...extra,
    });

    try {
      const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      store.updateNotificationDevice("desktop", { if_revision: 0, enabled: true });

      const notif = store.createNotification({
        semantic_key: "fail:test",
        kind: "failure",
        session_id: bot.direct_session.id,
        created_at: new Date(Date.now() - 3_000).toISOString(),
      });

      // Claim delivery
      const claimRes = await fetch(`${origin}/v1/notifications/desktop/claim`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ owner_id: "owner-retry", permission: "granted" }),
      });
      const claim = (await claimRes.json()) as DesktopClaimResponse;

      // Report failed
      const reportRes = await fetch(`${origin}/v1/notifications/desktop/report`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          delivery_id: claim.delivery_id,
          claim_token: claim.claim_token,
          result: "failed",
          code: "system_error",
        }),
      });
      expect(reportRes.status).toBe(204);

      // Verify delivery is in retry_wait
      const deliveryRow = store.db
        .query<{ state: string; next_attempt_at: number }, [string]>(
          "SELECT state, next_attempt_at FROM notification_deliveries WHERE delivery_id = ?",
        )
        .get(claim.delivery_id);
      expect(deliveryRow?.state).toBe("retry_wait");
      expect(deliveryRow?.next_attempt_at).toBeGreaterThan(Date.now());

      // Test terminal unknown records state = 'unknown' after max attempts
      store.db.run("UPDATE notification_deliveries SET state = 'claimed', attempt = 2 WHERE delivery_id = ?", [claim.delivery_id]);
      await fetch(`${origin}/v1/notifications/desktop/report`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          delivery_id: claim.delivery_id,
          claim_token: claim.claim_token,
          result: "unknown",
        }),
      });
      const terminalRow = store.db.query<{ state: string }, [string]>("SELECT state FROM notification_deliveries WHERE delivery_id = ?").get(claim.delivery_id);
      expect(terminalRow?.state).toBe("unknown");

      // Monotonic cleanup_revision increments on mark read
      const initialRev = store.getCleanupRevision();
      store.markNotificationRead(notif.id);
      expect(store.getCleanupRevision()).toBeGreaterThan(initialRev);
    } finally {
      api.scheduler?.stop();
      await api.engine.close();
      store.close();
      await server.stop(true);
    }
  });

  it("allows policy and device settings mutations when policy_v1 is true", async () => {
    const token = "test-token";
    const store = new Store({ endpointKey: memoryKeyStore() });
    const api = createLocalApi({ store, token, schedule: false, policyV1: true });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: api.fetch,
      websocket: api.websocket,
    });
    const origin = `http://${server.hostname}:${server.port}`;
    const auth = (extra?: Record<string, string>) => ({
      Authorization: `Bearer ${token}`,
      ...extra,
    });

    try {
      // Snapshot now shows policy_v1: true
      const snapRes = await fetch(`${origin}/v1/snapshot`, { headers: auth() });
      const snap = (await snapRes.json()) as RuntimeSnapshot;
      expect(snap.notificationCapabilities?.policy_v1).toBe(true);

      // GET policy
      const polRes = await fetch(`${origin}/v1/notification-policy`, { headers: auth() });
      expect(polRes.status).toBe(200);
      const policy = (await polRes.json()) as NotificationPolicy;
      expect(policy.categories.approval).toBe(true);

      // PATCH policy
      const patchPolRes = await fetch(`${origin}/v1/notification-policy`, {
        method: "PATCH",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ if_revision: policy.revision, categories: { approval: false } }),
      });
      expect(patchPolRes.status).toBe(200);
      const updatedPol = (await patchPolRes.json()) as NotificationPolicy;
      expect(updatedPol.categories.approval).toBe(false);

      // GET and PATCH device
      const devRes = await fetch(`${origin}/v1/notification-device`, { headers: auth() });
      expect(devRes.status).toBe(200);
      const dev = (await devRes.json()) as NotificationDevice;

      const patchDevRes = await fetch(`${origin}/v1/notification-device`, {
        method: "PATCH",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ if_revision: dev.revision, enabled: true }),
      });
      expect(patchDevRes.status).toBe(200);
      const updatedDev = (await patchDevRes.json()) as NotificationDevice;
      expect(updatedDev.enabled).toBe(true);

      // Session mute preference
      const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const muteRes = await fetch(`${origin}/v1/sessions/${bot.direct_session.id}/notification-preference`, {
        method: "PUT",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ muted: true, if_revision: 0 }),
      });
      expect(muteRes.status).toBe(200);
      const pref = (await muteRes.json()) as SessionNotificationPreference;
      expect(pref.muted).toBe(true);
    } finally {
      api.scheduler?.stop();
      await api.engine.close();
      store.close();
      await server.stop(true);
    }
  });
});

const GRANT = { owner_id: "owner-scheduler", permission: "granted" as const };

function enableDesktop(store: Store): void {
  store.updateNotificationDevice("desktop", { if_revision: 0, enabled: true });
}

function clearSendSlot(store: Store): void {
  store.db.run(
    "UPDATE notification_devices SET last_attempt_at = 0, next_send_at = 0 WHERE receiver_id = 'desktop'",
  );
}

function plannedOrdinal(store: Store): number {
  return store.getNotificationDeviceRow("desktop")?.planned_ordinal ?? 0;
}

function deliveryRow(store: Store, deliveryId: string) {
  return store.db
    .query<{ state: string; attempt: number; permit: string | null; next_attempt_at: number | null }, [string]>(
      "SELECT state, attempt, permit, next_attempt_at FROM notification_deliveries WHERE delivery_id = ?",
    )
    .get(deliveryId);
}

function attachedOrdinals(store: Store, deliveryId: string): number[] {
  return store.db
    .query<{ ordinal: number }, [string]>(
      `SELECT n.ordinal as ordinal
       FROM notification_delivery_items di
       JOIN notifications n ON n.id = di.notification_id
       WHERE di.delivery_id = ?
       ORDER BY n.ordinal ASC`,
    )
    .all(deliveryId)
    .map((row) => row.ordinal);
}

function failUntilTerminal(
  scheduler: NotificationDeliveryScheduler,
  store: Store,
  claim: { delivery_id: string; claim_token: string },
  now: number,
): { state: string; attempt: number } {
  let current = claim;
  let clock = now;
  for (let i = 0; i < 6; i++) {
    scheduler.reportDesktop(
      { delivery_id: current.delivery_id, claim_token: current.claim_token, result: "failed" },
      clock,
    );
    const row = deliveryRow(store, current.delivery_id);
    if (!row) throw new Error("delivery disappeared");
    if (row.state === "failed" || row.state === "unknown" || row.state === "expired") {
      return { state: row.state, attempt: row.attempt };
    }
    clearSendSlot(store);
    clock += 25_000;
    const next = scheduler.claimDesktop(GRANT, clock);
    if (!next) throw new Error(`expected retry claim, state=${row.state}`);
    current = next;
  }
  throw new Error("delivery did not reach a terminal state");
}

describe("desktop delivery watermark, recovery, and slot release", () => {
  it("does not rebatch the same still-open item after failed/expired/unknown", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      enableDesktop(store);
      store.createNotification({
        semantic_key: "approval:open-once",
        kind: "approval",
        session_id: bot.direct_session.id,
        created_at: new Date(Date.now() - 5_000).toISOString(),
      });
      const presence = new PresenceManager();
      const scheduler = new NotificationDeliveryScheduler(store, presence);
      const t0 = Date.now();
      const first = scheduler.claimDesktop(GRANT, t0);
      expect(first).toBeTruthy();
      const terminal = failUntilTerminal(scheduler, store, first!, t0);
      expect(terminal.state).toBe("failed");
      expect(store.getNotificationBySemanticKey("approval:open-once")?.action_state).toBe("open");

      clearSendSlot(store);
      expect(scheduler.claimDesktop(GRANT, t0 + 90_000)).toBeNull();

      const restarted = new NotificationDeliveryScheduler(store, presence);
      clearSendSlot(store);
      const recovered = restarted.claimDesktop(GRANT, t0 + 120_000);
      expect(recovered).toBeTruthy();
      expect(recovered!.delivery_id).not.toBe(first!.delivery_id);
      expect(attachedOrdinals(store, recovered!.delivery_id)).toEqual([1]);

      store.db.run(
        "UPDATE notification_deliveries SET state = 'failed', attempt = 3 WHERE delivery_id = ?",
        [recovered!.delivery_id],
      );
      clearSendSlot(store);
      expect(restarted.claimDesktop(GRANT, t0 + 150_000)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("does not form a second batch for an unread reply after the first delivery fails", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      enableDesktop(store);
      store.createNotification({
        semantic_key: "reply:still-unread",
        kind: "reply",
        session_id: bot.direct_session.id,
        created_at: new Date(Date.now() - 5_000).toISOString(),
      });
      const scheduler = new NotificationDeliveryScheduler(store, new PresenceManager());
      const t0 = Date.now();
      const first = scheduler.claimDesktop(GRANT, t0);
      expect(first).toBeTruthy();
      failUntilTerminal(scheduler, store, first!, t0);
      clearSendSlot(store);
      const second = scheduler.claimDesktop(GRANT, t0 + 30_000);
      expect(second).toBeNull();
      expect(store.getNotificationBySemanticKey("reply:still-unread")?.read_at).toBeNull();
    } finally {
      store.close();
    }
  });

  it("claims unread replies oldest-first and does not starve ordinal 1 behind a newest-100 page", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      enableDesktop(store);
      const createdAt = new Date(Date.now() - 10_000).toISOString();
      for (let i = 1; i <= 101; i++) {
        store.createNotification({
          semantic_key: `reply:${i}`,
          kind: "reply",
          session_id: bot.direct_session.id,
          created_at: createdAt,
        });
      }
      const scheduler = new NotificationDeliveryScheduler(store, new PresenceManager());
      const t0 = Date.now();
      const first = scheduler.claimDesktop(GRANT, t0);
      expect(first).toBeTruthy();
      const firstOrdinals = attachedOrdinals(store, first!.delivery_id);
      expect(firstOrdinals).toHaveLength(100);
      expect(firstOrdinals[0]).toBe(1);
      expect(firstOrdinals[99]).toBe(100);
      expect(plannedOrdinal(store)).toBe(100);
      const newestUnreadPage = store
        .listNotifications({ filter: "unread", limit: 100 })
        .items.map((item) => item.ordinal);
      expect(newestUnreadPage).not.toContain(1);
      expect(store.getNotificationBySemanticKey("reply:1")?.read_at).toBeNull();

      scheduler.reportDesktop(
        { delivery_id: first!.delivery_id, claim_token: first!.claim_token, result: "accepted" },
        t0,
      );
      clearSendSlot(store);
      const second = scheduler.claimDesktop(GRANT, t0 + 31_000);
      expect(second).toBeTruthy();
      expect(attachedOrdinals(store, second!.delivery_id)).toEqual([101]);
      expect(store.getNotificationBySemanticKey("reply:1")?.read_at).toBeNull();
    } finally {
      store.close();
    }
  });

  it("keeps a deferred 2s hole and still recovers an 8-day-old still-open approval", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      enableDesktop(store);
      const t0 = Date.now();
      store.createNotification({
        semantic_key: "reply:old-enough",
        kind: "reply",
        session_id: bot.direct_session.id,
        created_at: new Date(t0 - 5_000).toISOString(),
      });
      store.createNotification({
        semantic_key: "reply:too-fresh",
        kind: "reply",
        session_id: bot.direct_session.id,
        created_at: new Date(t0 - 500).toISOString(),
      });
      const scheduler = new NotificationDeliveryScheduler(store, new PresenceManager());
      const first = scheduler.claimDesktop(GRANT, t0);
      expect(first).toBeTruthy();
      expect(attachedOrdinals(store, first!.delivery_id)).toEqual([1]);
      expect(plannedOrdinal(store)).toBe(1);

      const aged = store.createNotification({
        semantic_key: "approval:eight-days",
        kind: "approval",
        session_id: bot.direct_session.id,
        created_at: new Date(t0 - 8 * 86_400_000).toISOString(),
      });
      store.db.run("UPDATE notification_devices SET planned_ordinal = ? WHERE receiver_id = 'desktop'", [
        aged.ordinal,
      ]);
      store.db.run(
        "UPDATE notification_deliveries SET state = 'accepted' WHERE delivery_id = ?",
        [first!.delivery_id],
      );
      clearSendSlot(store);

      const recovered = new NotificationDeliveryScheduler(store, new PresenceManager()).claimDesktop(
        GRANT,
        t0 + 31_000,
      );
      expect(recovered).toBeTruthy();
      expect(attachedOrdinals(store, recovered!.delivery_id)).toContain(aged.ordinal);
    } finally {
      store.close();
    }
  });

  it("releases send-slot retry_later to retry_wait without an attempt penalty", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      enableDesktop(store);
      store.createNotification({
        semantic_key: "reply:slot",
        kind: "reply",
        session_id: bot.direct_session.id,
        created_at: new Date(Date.now() - 5_000).toISOString(),
      });
      const scheduler = new NotificationDeliveryScheduler(store, new PresenceManager());
      const t0 = Date.now();
      const claim = scheduler.claimDesktop(GRANT, t0);
      expect(claim).toBeTruthy();
      store.db.run(
        "UPDATE notification_devices SET last_attempt_at = ?, next_send_at = ? WHERE receiver_id = 'desktop'",
        [t0, t0 + 25_000],
      );
      const reval = scheduler.revalidateDesktop(
        { delivery_id: claim!.delivery_id, claim_token: claim!.claim_token },
        t0 + 1_000,
      );
      expect(reval.action).toBe("retry_later");
      expect(reval.retry_after_ms).toBe(24_000);
      const waiting = deliveryRow(store, claim!.delivery_id);
      expect(waiting?.state).toBe("retry_wait");
      expect(waiting?.attempt).toBe(0);
      expect(waiting?.permit).toBeNull();

      const afterLease = scheduler.claimDesktop(GRANT, t0 + CLAIM_LEASE_MS + 2_000);
      expect(afterLease).toBeNull();
      expect(deliveryRow(store, claim!.delivery_id)?.attempt).toBe(0);
      expect(deliveryRow(store, claim!.delivery_id)?.state).toBe("retry_wait");

      const reclaimed = scheduler.claimDesktop(GRANT, t0 + 25_000);
      expect(reclaimed?.delivery_id).toBe(claim!.delivery_id);
      expect(deliveryRow(store, claim!.delivery_id)?.attempt).toBe(0);
    } finally {
      store.close();
    }
  });

  it("reclaims a test retry_wait with the same copy, same delivery_id, attempt 0, and no business items", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      enableDesktop(store);
      const scheduler = new NotificationDeliveryScheduler(store, new PresenceManager());
      const t0 = Date.now();
      expect(scheduler.testDesktop(t0)).toEqual({ ok: true, status: "queued" });
      const first = scheduler.claimDesktop(GRANT, t0);
      expect(first).toBeTruthy();
      expect(first!.identifier).toBe("test");
      expect(first!.title).toBe("Deskfolk");
      expect(first!.body).toBe("这是一条测试通知");
      expect(attachedOrdinals(store, first!.delivery_id)).toEqual([]);
      expect(
        store.db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) as count FROM notification_delivery_items WHERE delivery_id = ?",
          )
          .get(first!.delivery_id)?.count,
      ).toBe(0);

      store.db.run(
        "UPDATE notification_devices SET last_attempt_at = ?, next_send_at = ? WHERE receiver_id = 'desktop'",
        [t0, t0 + 25_000],
      );
      const reval = scheduler.revalidateDesktop(
        { delivery_id: first!.delivery_id, claim_token: first!.claim_token },
        t0 + 1_000,
      );
      expect(reval.action).toBe("retry_later");
      expect(reval.retry_after_ms).toBe(24_000);
      const waiting = deliveryRow(store, first!.delivery_id);
      expect(waiting?.state).toBe("retry_wait");
      expect(waiting?.attempt).toBe(0);
      expect(waiting?.permit).toBeNull();

      const afterLease = scheduler.claimDesktop(GRANT, t0 + CLAIM_LEASE_MS + 2_000);
      expect(afterLease).toBeNull();
      expect(deliveryRow(store, first!.delivery_id)?.attempt).toBe(0);
      expect(deliveryRow(store, first!.delivery_id)?.state).toBe("retry_wait");

      const reclaimed = scheduler.claimDesktop(GRANT, t0 + 25_000);
      expect(reclaimed).toBeTruthy();
      expect(reclaimed!.delivery_id).toBe(first!.delivery_id);
      expect(reclaimed!.identifier).toBe("test");
      expect(reclaimed!.title).toBe("Deskfolk");
      expect(reclaimed!.body).toBe("这是一条测试通知");
      expect(reclaimed!.identifier).not.toBe("host:all");
      expect(reclaimed!.body).not.toBe("有待处理事项，打开查看");
      expect(deliveryRow(store, first!.delivery_id)?.attempt).toBe(0);
      expect(attachedOrdinals(store, first!.delivery_id)).toEqual([]);
      expect(
        store.db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) as count FROM notification_delivery_items WHERE delivery_id = ?",
          )
          .get(first!.delivery_id)?.count,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  it("returns 409 delivery_busy for a second test 61s later while the first claim is in-flight", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      enableDesktop(store);
      const scheduler = new NotificationDeliveryScheduler(store, new PresenceManager());
      const t0 = 1_700_000_000_000;
      expect(scheduler.testDesktop(t0)).toEqual({ ok: true, status: "queued" });
      const claimed = scheduler.claimDesktop(GRANT, t0);
      expect(claimed?.identifier).toBe("test");
      expect(deliveryRow(store, claimed!.delivery_id)?.state).toBe("claimed");

      let thrown: unknown;
      try {
        scheduler.testDesktop(t0 + 61_000);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(409);
      expect((thrown as HttpError).code).toBe("delivery_busy");
    } finally {
      store.close();
    }
  });

  it("queues a desktop test without claiming native presentation", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      enableDesktop(store);
      const scheduler = new NotificationDeliveryScheduler(store, new PresenceManager());
      const t0 = 1_800_000_000_000;
      expect(scheduler.testDesktop(t0)).toEqual({ ok: true, status: "queued" });
      const pending = store.db
        .query<{ state: string; permit: string | null }, []>(
          "SELECT state, permit FROM notification_deliveries WHERE receiver_id = 'desktop' AND channel = 'desktop'",
        )
        .get();
      expect(pending?.state).toBe("pending");
      expect(pending?.permit).toBeNull();
    } finally {
      store.close();
    }
  });

  it("clears a session's banner and the badge once its only open item is a seen interruption", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
      const cut = store.createNotification({
        semantic_key: "interrupted:turn_1",
        kind: "interrupted",
        session_id: writer.direct_session.id,
      });
      const waiting = store.createNotification({
        semantic_key: "approval:app_1",
        kind: "approval",
        session_id: reviewer.direct_session.id,
      });
      store.markNotificationsReadBatch({ ids: [cut.id, waiting.id] });

      const scheduler = new NotificationDeliveryScheduler(store, new PresenceManager());
      expect(scheduler.getState().attention_count).toBe(1);
      expect(
        scheduler.reconcile({
          identifiers: [`session:${writer.direct_session.id}`, `session:${reviewer.direct_session.id}`],
        }).remove_identifiers,
      ).toEqual([`session:${writer.direct_session.id}`]);
    } finally {
      store.close();
    }
  });

  it("prunes delivery history to 7 days / 2000 rows and keeps live batches", () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    try {
      const now = Date.now();
      store.db.run(
        `INSERT INTO notification_deliveries (
          delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
          state, attempt, next_attempt_at, absolute_expires_at, created_at, push_generation, trust_generation
        ) VALUES ('live-pending', 'desktop', 'desktop', 'test:live', 0, 'click-live', 'pending', 0, ?, ?, ?, 1, 1)`,
        [now, now + 120_000, now - DELIVERY_RETENTION_MS - 1],
      );
      for (let i = 0; i < MAX_DELIVERY_RECORDS + 12; i++) {
        const aged = i < 8;
        store.db.run(
          `INSERT INTO notification_deliveries (
            delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
            state, attempt, next_attempt_at, absolute_expires_at, created_at, push_generation, trust_generation
          ) VALUES (?, 'desktop', 'desktop', ?, 0, ?, 'accepted', 1, NULL, ?, ?, 1, 1)`,
          [
            `hist-${i}`,
            `session:hist:${i}`,
            `click-${i}`,
            now,
            aged ? now - DELIVERY_RETENTION_MS - i - 2 : now - i,
          ],
        );
      }
      store.pruneNotificationDeliveriesRetention(now);
      const live = store.db
        .query<{ state: string }, []>(
          "SELECT state FROM notification_deliveries WHERE delivery_id = 'live-pending'",
        )
        .get();
      expect(live?.state).toBe("pending");
      const agedGone = store.db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) as count FROM notification_deliveries WHERE created_at < ? AND delivery_id != 'live-pending'",
        )
        .get(now - DELIVERY_RETENTION_MS)?.count;
      expect(agedGone).toBe(0);
      const total =
        store.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM notification_deliveries").get()
          ?.count ?? 0;
      expect(total).toBe(MAX_DELIVERY_RECORDS);
    } finally {
      store.close();
    }
  });
});
