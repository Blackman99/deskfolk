import { describe, expect, it } from "bun:test";
import { Store } from "./index";

describe("store notifications", () => {
  it("creates notifications with monotonic ordinals and respects semantic key deduplication", () => {
    const store = new Store();
    try {
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const n1 = store.createNotification({
        semantic_key: "test:1",
        kind: "reply",
        session_id: writer.direct_session.id,
      });
      expect(n1.ordinal).toBe(1);
      expect(n1.action_state).toBe("none");

      // Duplicate semantic_key returns existing without allocating new ordinal
      const n1Dup = store.createNotification({
        semantic_key: "test:1",
        kind: "reply",
      });
      expect(n1Dup.id).toBe(n1.id);
      expect(n1Dup.ordinal).toBe(1);

      const n2 = store.createNotification({
        semantic_key: "test:2",
        kind: "approval",
        session_id: writer.direct_session.id,
      });
      expect(n2.ordinal).toBe(2);
      expect(n2.action_state).toBe("open");
    } finally {
      store.close();
    }
  });

  it("handles markRead and markNotificationsReadBatch", () => {
    const store = new Store();
    try {
      const n1 = store.createNotification({ semantic_key: "test:1", kind: "reply" });
      const n2 = store.createNotification({ semantic_key: "test:2", kind: "reply" });

      expect(store.getNotification(n1.id)?.read_at).toBeNull();

      store.markNotificationRead(n1.id);
      expect(store.getNotification(n1.id)?.read_at).toBeTruthy();
      expect(store.getNotification(n2.id)?.read_at).toBeNull();

      store.markNotificationsReadBatch({ ids: [n2.id] });
      expect(store.getNotification(n2.id)?.read_at).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it("acknowledges failure/interrupted and refuses approval/ask", () => {
    const store = new Store();
    try {
      const failNotif = store.createNotification({
        semantic_key: "failure:turn_1",
        kind: "failure",
        fail_kind: "stuck",
      });
      expect(failNotif.action_state).toBe("open");

      // Wrong revision
      expect(() => store.acknowledgeNotification(failNotif.id, 99)).toThrow();

      // Successful ack
      const acked = store.acknowledgeNotification(failNotif.id, failNotif.revision);
      expect(acked.action_state).toBe("resolved");
      expect(acked.resolution_reason).toBe("acknowledged");
      expect(acked.read_at).toBeTruthy();

      // Approval cannot be acknowledged via acknowledgeNotification
      const appNotif = store.createNotification({
        semantic_key: "approval:app_1",
        kind: "approval",
      });
      expect(() => store.acknowledgeNotification(appNotif.id, appNotif.revision)).toThrow();
    } finally {
      store.close();
    }
  });

  it("paginates notifications with cursor", () => {
    const store = new Store();
    try {
      for (let i = 1; i <= 15; i++) {
        store.createNotification({ semantic_key: `test:${i}`, kind: "reply" });
      }

      const page1 = store.listNotifications({ filter: "all", limit: 10 });
      expect(page1.items.length).toBe(10);
      expect(page1.next).toBeTruthy();
      expect(page1.summary.unread_count).toBe(15);

      const page2 = store.listNotifications({ filter: "all", limit: 10, cursor: page1.next });
      expect(page2.items.length).toBe(5);
      expect(page2.next).toBeNull();
    } finally {
      store.close();
    }
  });

  it("manages policy and device settings with CAS", () => {
    const store = new Store();
    try {
      const policy = store.getNotificationPolicy();
      expect(policy.categories.approval).toBe(true);

      expect(() =>
        store.updateNotificationPolicy({
          if_revision: 99,
          categories: { approval: false },
        }),
      ).toThrow();

      const updated = store.updateNotificationPolicy({
        if_revision: policy.revision,
        categories: { approval: false },
      });
      expect(updated.revision).toBe(policy.revision + 1);
      expect(updated.categories.approval).toBe(false);

      const device = store.getNotificationDevice("desktop");
      expect(device.enabled).toBe(false);

      const updatedDev = store.updateNotificationDevice("desktop", {
        if_revision: device.revision,
        enabled: true,
      });
      expect(updatedDev.enabled).toBe(true);
      expect(updatedDev.revision).toBe(1);
    } finally {
      store.close();
    }
  });

  it("prunes notification delivery history without dropping live batches", () => {
    const store = new Store();
    try {
      const now = Date.now();
      store.db.run(
        `INSERT INTO notification_deliveries (
          delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
          state, attempt, next_attempt_at, absolute_expires_at, created_at, push_generation, trust_generation
        ) VALUES ('live-claimed', 'desktop', 'desktop', 'test:live', 0, 'click-live', 'claimed', 0, ?, ?, ?, 1, 1)`,
        [now, now + 120_000, now - 8 * 86_400_000],
      );
      store.db.run(
        `INSERT INTO notification_deliveries (
          delivery_id, receiver_id, channel, batch_key, upper_ordinal, click_ref,
          state, attempt, next_attempt_at, absolute_expires_at, created_at, push_generation, trust_generation
        ) VALUES ('old-accepted', 'desktop', 'desktop', 'session:old', 0, 'click-old', 'accepted', 1, NULL, ?, ?, 1, 1)`,
        [now, now - 8 * 86_400_000],
      );
      store.pruneNotificationDeliveriesRetention(now);
      expect(
        store.db.query<{ state: string }, []>(
          "SELECT state FROM notification_deliveries WHERE delivery_id = 'live-claimed'",
        ).get()?.state,
      ).toBe("claimed");
      expect(
        store.db.query<{ count: number }, []>(
          "SELECT COUNT(*) as count FROM notification_deliveries WHERE delivery_id = 'old-accepted'",
        ).get()?.count,
      ).toBe(0);
    } finally {
      store.close();
    }
  });
});
