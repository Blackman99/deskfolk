import { describe, expect, it } from "bun:test";
import { Store } from "./store";
import { memoryKeyStore } from "./store/shared";
import { createLocalApi } from "./local-api";
import type {
  ListNotificationsResponse,
  NotificationItem,
  RuntimeSnapshot,
  SessionDetail,
} from "@real-bot/protocol";

type Harness = {
  origin: string;
  token: string;
  store: Store;
  auth: (extra?: Record<string, string>) => Record<string, string>;
  get: <T>(path: string) => Promise<T>;
  createBot: (input: { name: string }) => Promise<{ bot: { id: string; name: string }; direct_session: { id: string } }>;
  close: () => Promise<void>;
};

async function startApi(opts: { policyV1?: boolean; pushSettingsV2?: boolean } = {}): Promise<Harness> {
  const token = "test-token";
  const store = new Store({ endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token, schedule: false, policyV1: opts.policyV1, pushSettingsV2: opts.pushSettingsV2 });
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
  return {
    origin,
    token,
    store,
    auth,
    get: async <T>(path: string): Promise<T> => {
      const res = await fetch(`${origin}${path}`, { headers: auth() });
      if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
      return (await res.json()) as T;
    },
    createBot: async (input: { name: string }) => {
      return store.createBot({ name: input.name, duties: "test", boundaries: "none" });
    },
    close: async () => {
      api.scheduler?.stop();
      await api.engine.close();
      store.close();
      await server.stop(true);
    },
  };
}

describe("notifications API (PR2)", () => {
  it("exposes notification capabilities on snapshot", async () => {
    const h = await startApi();
    try {
      const res = await h.get<RuntimeSnapshot>("/v1/snapshot");
      expect(res.notificationCapabilities).toEqual({
        inbox_v1: true,
        bounded_read_v1: true,
        pending_ask_v1: true,
        policy_v1: false,
        push_settings_v2: false,
      });
      expect(res.notificationSummary).toBeTruthy();
      expect(res.notificationSummary?.unread_count).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("lists, filters, and paginates notifications with cursor", async () => {
    const h = await startApi();
    try {
      const bot = await h.createBot({ name: "Writer" });
      // Post 5 messages to generate notifications
      for (let i = 1; i <= 5; i++) {
        h.store.createNotification({
          semantic_key: `test:msg:${i}`,
          kind: "reply",
          session_id: bot.direct_session.id,
        });
      }
      // Add one approval notification
      const app = h.store.createNotification({
        semantic_key: "test:app:1",
        kind: "approval",
        session_id: bot.direct_session.id,
      });

      // GET /v1/notifications default (actionable)
      const actionable = await h.get<ListNotificationsResponse>("/v1/notifications");
      expect(actionable.items.length).toBe(1);
      expect(actionable.items[0]!.id).toBe(app.id);
      expect(actionable.summary.open_count).toBe(1);
      expect(actionable.summary.unread_count).toBe(6);
      expect(actionable.event_instance_id).toBeTruthy();

      // GET /v1/notifications?filter=all&limit=3
      const page1 = await h.get<ListNotificationsResponse>("/v1/notifications?filter=all&limit=3");
      expect(page1.items.length).toBe(3);
      expect(page1.next).toBeTruthy();

      // Next page
      const page2 = await h.get<ListNotificationsResponse>(
        `/v1/notifications?filter=all&limit=3&cursor=${encodeURIComponent(page1.next!)}`,
      );
      expect(page2.items.length).toBe(3);

      // GET single notification
      const single = await h.get<NotificationItem>(`/v1/notifications/${app.id}`);
      expect(single.id).toBe(app.id);
      expect(single.kind).toBe("approval");

      // 404 for non-existent
      const notFound = await fetch(`${h.origin}/v1/notifications/01M33000000000000000000000`, {
        headers: h.auth(),
      });
      expect(notFound.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("marks notifications as read via batch and through_ordinal", async () => {
    const h = await startApi();
    try {
      const bot = await h.createBot({ name: "Writer" });
      const n1 = h.store.createNotification({
        semantic_key: "read:1",
        kind: "reply",
        session_id: bot.direct_session.id,
      });
      const n2 = h.store.createNotification({
        semantic_key: "read:2",
        kind: "reply",
        session_id: bot.direct_session.id,
      });

      // Mark n1 read by ID
      const res1 = await fetch(`${h.origin}/v1/notifications/read`, {
        method: "POST",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ids: [n1.id] }),
      });
      expect(res1.status).toBe(204);

      const check1 = await h.get<NotificationItem>(`/v1/notifications/${n1.id}`);
      expect(check1.read_at).toBeTruthy();
      const check2 = await h.get<NotificationItem>(`/v1/notifications/${n2.id}`);
      expect(check2.read_at).toBeNull();

      // Mark n2 read through ordinal
      const res2 = await fetch(`${h.origin}/v1/notifications/read`, {
        method: "POST",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ through_ordinal: n2.ordinal, filter: "all" }),
      });
      expect(res2.status).toBe(204);

      const check2After = await h.get<NotificationItem>(`/v1/notifications/${n2.id}`);
      expect(check2After.read_at).toBeTruthy();
    } finally {
      await h.close();
    }
  });

  it("acknowledges failure and interrupted notifications and refuses reply", async () => {
    const h = await startApi();
    try {
      const failNotif = h.store.createNotification({
        semantic_key: "fail:1",
        kind: "failure",
        fail_kind: "endpoint_error",
      });

      // Acknowledge with correct revision
      const res = await fetch(`${h.origin}/v1/notifications/${failNotif.id}/acknowledge`, {
        method: "POST",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ if_revision: failNotif.revision }),
      });
      expect(res.status).toBe(200);
      const acked = (await res.json()) as NotificationItem;
      expect(acked.action_state).toBe("resolved");
      expect(acked.resolution_reason).toBe("acknowledged");

      // Revision conflict on second call
      const resConflict = await fetch(`${h.origin}/v1/notifications/${failNotif.id}/acknowledge`, {
        method: "POST",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ if_revision: failNotif.revision }),
      });
      expect(resConflict.status).toBe(409);

      // Reply notification cannot be acknowledged
      const replyNotif = h.store.createNotification({
        semantic_key: "reply:ack_refuse",
        kind: "reply",
      });
      const resReply = await fetch(`${h.origin}/v1/notifications/${replyNotif.id}/acknowledge`, {
        method: "POST",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ if_revision: replyNotif.revision }),
      });
      expect(resReply.status).toBe(422);
    } finally {
      await h.close();
    }
  });

  it("marks session read through message and updates read_through_seq", async () => {
    const h = await startApi();
    try {
      const bot = await h.createBot({ name: "Writer" });
      const m1 = h.store.postMessage(bot.direct_session.id, { body: "msg 1" });
      const m2 = h.store.postMessage(bot.direct_session.id, { body: "msg 2" });

      const res = await fetch(`${h.origin}/v1/sessions/${bot.direct_session.id}/read`, {
        method: "POST",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ through_message_id: m1.id }),
      });
      expect(res.status).toBe(200);
      const detail = (await res.json()) as SessionDetail;
      expect(detail.read_through_seq).toBe(m1.message_seq ?? 1);

      // Verify unread count reflects reading through m1
      const sessionAfter = h.store.getSession(bot.direct_session.id);
      expect(sessionAfter.read_through_seq).toBe(m1.message_seq ?? 1);
    } finally {
      await h.close();
    }
  });

  it("bypasses receipts for notification presence without writing durable rows", async () => {
    const h = await startApi();
    try {
      const res = await fetch(`${h.origin}/v1/notification-presence`, {
        method: "POST",
        headers: h.auth({
          "Content-Type": "application/json",
          "X-Request-Id": "01M33PRESENCE0000000000000",
        }),
        body: JSON.stringify({
          instance_id: "inst_presence_test",
          visible: true,
          focused: true,
          session_id: null,
          at_latest: true,
        }),
      });
      expect(res.status).toBe(204);

      // Zero rows in request_receipts
      const receiptsCount = h.store.db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM request_receipts")
        .get()?.count ?? 0;
      expect(receiptsCount).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("prevents committing user answer message if ask_id is invalid or dead", async () => {
    const h = await startApi();
    try {
      const bot = await h.createBot({ name: "Writer" });
      const res = await fetch(`${h.origin}/v1/sessions/${bot.direct_session.id}/messages`, {
        method: "POST",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          body: "my answer",
          ask_id: "01M33DEADASK00000000000000",
        }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);

      // Verify no orphan message was committed
      const messages = h.store.listMessages(bot.direct_session.id);
      expect(messages.items.length).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("reads and marks retention notice read", async () => {
    const h = await startApi();
    try {
      // Record a retention notice
      h.store.db.run(
        "INSERT INTO notification_retention_notice (singleton, pruned_at, read_at) VALUES (1, '2026-09-22T00:00:00.000Z', NULL) ON CONFLICT(singleton) DO UPDATE SET pruned_at = excluded.pruned_at, read_at = NULL",
      );

      const summary = await h.get<{ summary: { retention_notice: { pruned_at: string; read_at: string | null } } }>("/v1/notifications");
      expect(summary.summary.retention_notice).toBeTruthy();
      expect(summary.summary.retention_notice.read_at).toBeNull();

      const markReadRes = await fetch(`${h.origin}/v1/notifications/retention-notice/read`, {
        method: "POST",
        headers: h.auth(),
      });
      expect(markReadRes.status).toBe(204);

      const summaryAfter = await h.get<{ summary: { retention_notice: { pruned_at: string; read_at: string | null } } }>("/v1/notifications");
      expect(summaryAfter.summary.retention_notice.read_at).toBeTruthy();
    } finally {
      await h.close();
    }
  });

  it("returns 409 capability_unavailable for policy and device routes when policy_v1 is false", async () => {
    const h = await startApi(); // policyV1 is false by default
    try {
      const getPolicy = await fetch(`${h.origin}/v1/notification-policy`, { headers: h.auth() });
      expect(getPolicy.status).toBe(409);
      const err1 = (await getPolicy.json()) as { error: { code: string } };
      expect(err1.error.code).toBe("capability_unavailable");

      const patchPolicy = await fetch(`${h.origin}/v1/notification-policy`, {
        method: "PATCH",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ if_revision: 1 }),
      });
      expect(patchPolicy.status).toBe(409);

      const getDevice = await fetch(`${h.origin}/v1/notification-device`, { headers: h.auth() });
      expect(getDevice.status).toBe(409);

      const patchDevice = await fetch(`${h.origin}/v1/notification-device`, {
        method: "PATCH",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ if_revision: 0 }),
      });
      expect(patchDevice.status).toBe(409);
    } finally {
      await h.close();
    }
  });

  it("exposes push_settings_v2 capability and manages local push-config", async () => {
    const h = await startApi({ pushSettingsV2: true, policyV1: true });
    try {
      const snap = await h.get<RuntimeSnapshot>("/v1/snapshot");
      expect(snap.notificationCapabilities?.push_settings_v2).toBe(true);

      // GET default push config
      const getRes = await fetch(`${h.origin}/v1/notifications/push-config`, { headers: h.auth() });
      expect(getRes.status).toBe(200);
      const conf = (await getRes.json()) as { contact_uri: string | null; revision: number; contact_configured: boolean };
      expect(conf).toEqual({ contact_uri: null, revision: 1, contact_configured: false });

      // PATCH with mailto
      const patchMailto = await fetch(`${h.origin}/v1/notifications/push-config`, {
        method: "PATCH",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ contact_uri: "mailto:admin@example.com", if_revision: 1 }),
      });
      expect(patchMailto.status).toBe(200);
      const conf2 = (await patchMailto.json()) as { contact_uri: string | null; revision: number; contact_configured: boolean };
      expect(conf2).toEqual({ contact_uri: "mailto:admin@example.com", revision: 2, contact_configured: true });

      // PATCH with https
      const patchHttps = await fetch(`${h.origin}/v1/notifications/push-config`, {
        method: "PATCH",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ contact_uri: "https://example.com/notifications/contact", if_revision: 2 }),
      });
      expect(patchHttps.status).toBe(200);
      const conf3 = (await patchHttps.json()) as { contact_uri: string | null; revision: number; contact_configured: boolean };
      expect(conf3.contact_configured).toBe(true);

      // Revision conflict
      const conflictRes = await fetch(`${h.origin}/v1/notifications/push-config`, {
        method: "PATCH",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ contact_uri: null, if_revision: 1 }),
      });
      expect(conflictRes.status).toBe(409);

      // Invalid URIs rejected
      const badUris = [
        "http://insecure.example.com",
        "ftp://example.com",
        "https://user:pass@example.com",
        "https://example.com/#frag",
        "mailto:invalid email",
        "mailto:admin@example.com\n",
        "a".repeat(600),
      ];
      for (const bad of badUris) {
        const res = await fetch(`${h.origin}/v1/notifications/push-config`, {
          method: "PATCH",
          headers: h.auth({ "Content-Type": "application/json" }),
          body: JSON.stringify({ contact_uri: bad, if_revision: 3 }),
        });
        expect(res.status).toBe(422);
      }
    } finally {
      await h.close();
    }
  });

  it("desktop test from a snapshot with native_delivery false and device enabled returns queued, not accepted", async () => {
    const h = await startApi({ policyV1: true, pushSettingsV2: true });
    try {
      h.store.updateNotificationDevice("desktop", { if_revision: 0, enabled: true });
      const res = await fetch(`${h.origin}/v1/notifications/desktop/test`, {
        method: "POST",
        headers: h.auth({ "Content-Type": "application/json" }),
        body: "{}",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; status: string };
      expect(body).toEqual({ ok: true, status: "queued" });
      expect(body.status).not.toBe("accepted");
      expect(body.status).not.toBe("submitted");
    } finally {
      await h.close();
    }
  });
});
