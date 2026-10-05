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

  it("stops counting a seen interruption or failure towards the badge, but not a pending approval or ask", () => {
    const store = new Store();
    try {
      const ids = (["interrupted", "failure", "approval", "ask"] as const).map((kind) =>
        store.createNotification({ semantic_key: `${kind}:turn_1`, kind }).id,
      );
      expect(store.getNotificationSummary().attention_count).toBe(4);

      store.markNotificationsReadBatch({ ids });
      const summary = store.getNotificationSummary();
      expect(summary.unread_count).toBe(0);
      expect(summary.open_count).toBe(4);
      expect(summary.attention_count).toBe(2);
    } finally {
      store.close();
    }
  });

  it("does not count a notification in a conversation that is left out of the session list", () => {
    const store = new Store();
    try {
      const gone = store.createBot({ name: "Gone", duties: "write", boundaries: "none" });
      const kept = store.createBot({ name: "Kept", duties: "write", boundaries: "none" });
      store.deleteBot(gone.bot.id);
      // Written after the delete, as a call-back already in flight would: deleting the Bot only
      // clears what was there, and nothing can open this conversation to read it.
      store.createNotification({
        semantic_key: "stalled:late",
        kind: "failure",
        session_id: gone.direct_session.id,
        action_state: "open",
      });
      store.createNotification({
        semantic_key: "stalled:kept",
        kind: "failure",
        session_id: kept.direct_session.id,
        action_state: "open",
      });
      store.createNotification({ semantic_key: "reply:none", kind: "reply" });

      const summary = store.getNotificationSummary();
      expect(summary.attention_count).toBe(2);
      expect(summary.unread_count).toBe(2);
      expect(summary.open_count).toBe(1);
    } finally {
      store.close();
    }
  });

  it("does not count what waits in an archived Bot's direct until the Bot is restored", () => {
    const store = new Store();
    try {
      const shelved = store.createBot({ name: "Shelved", duties: "write", boundaries: "none" });
      const kept = store.createBot({ name: "Kept", duties: "write", boundaries: "none" });
      // Its default-model card, seen but not answered, and a reply you never read.
      const card = store.createNotification({
        semantic_key: "model_default:card",
        kind: "ask",
        session_id: shelved.direct_session.id,
        action_state: "open",
      });
      store.markNotificationRead(card.id);
      store.createNotification({ semantic_key: "reply:shelved", kind: "reply", session_id: shelved.direct_session.id });
      store.createNotification({ semantic_key: "reply:kept", kind: "reply", session_id: kept.direct_session.id });
      expect(store.getNotificationSummary().attention_count).toBe(3);

      // Archived, its direct leaves the main list for the archived one: nothing there holds the badge.
      store.archiveBot(shelved.bot.id);
      expect(store.getNotificationSummary()).toMatchObject({ attention_count: 1, unread_count: 1, open_count: 0 });
      // Still there to open and answer in the archived list.
      expect(store.listSessions().map((session) => session.id)).toContain(shelved.direct_session.id);

      store.restoreBot(shelved.bot.id);
      expect(store.getNotificationSummary()).toMatchObject({ attention_count: 3, unread_count: 2, open_count: 1 });
    } finally {
      store.close();
    }
  });

  it("marks the conversation a card waits on you in, and lifts the mark once it no longer waits", () => {
    const store = new Store();
    try {
      const director = store.createBot({ name: "Director", duties: "film", boundaries: "none" });
      const other = store.createBot({ name: "Other", duties: "write", boundaries: "none" });
      const session = director.direct_session.id;
      const waiting = () => store.listSessions().find((row) => row.id === session)?.waiting_on_you;
      const upserts: (string | null | undefined)[] = [];
      store.onCommit((event) => {
        if (event.event === "session.upsert" && event.id === session) upserts.push(event.waiting_on_you);
      });
      expect(waiting()).toBeNull();

      // A sample's approve/reject card, read the moment it landed because the conversation was open:
      // the Dock badge counts it, and with no turn live nothing on the row said where it was
      // (2026-10-05).
      const card = store.createNotification({ semantic_key: "review_item:card", kind: "ask", session_id: session, action_state: "open" });
      store.markNotificationRead(card.id);
      expect(waiting()).toBe("approval");
      expect(upserts.at(-1)).toBe("approval");
      expect(store.listSessions().find((row) => row.id === other.direct_session.id)?.waiting_on_you).toBeNull();

      // A question card besides it: the hand-over still reads as the one to approve.
      store.createNotification({ semantic_key: "work_question:q", kind: "ask", session_id: session, action_state: "open" });
      expect(waiting()).toBe("approval");

      store.updateNotificationActionState("review_item:card", "resolved", "approve", true);
      expect(waiting()).toBe("ask");
      expect(upserts.at(-1)).toBe("ask");

      store.updateNotificationActionState("work_question:q", "voided", "superseded", true);
      expect(waiting()).toBeNull();
      expect(upserts.at(-1)).toBeNull();

      // A reply waits on nothing: unread is the row's dot, not this mark.
      store.createNotification({ semantic_key: "reply:r", kind: "reply", session_id: session });
      expect(waiting()).toBeNull();
    } finally {
      store.close();
    }
  });

  it("reading through a line also reads a notification whose note the conversation does not list, up to the next line it does", () => {
    const store = new Store();
    try {
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const session = writer.direct_session.id;
      const say = (body: string) =>
        store.insertMessage({ sessionId: session, kind: "bot", author: writer.bot.id, body });
      // What a stalled plan keeps for its notification: the app's own note, not listed.
      const note = (body: string) =>
        store.insertMessage({ sessionId: session, kind: "system", author: writer.bot.id, body, botOnly: true });
      const noticeOn = (key: string, messageId: string) =>
        store.createNotification({
          semantic_key: key,
          kind: "failure",
          session_id: session,
          message_id: messageId,
          action_state: "open",
          fail_kind: "stalled_plan",
        });

      const first = say("初稿在 draft.md");
      const sameGap = noticeOn("stalled:a", note("这件事停下了").id);
      const second = say("还差最后一节");
      const laterGap = noticeOn("stalled:b", note("这件事又停下了").id);

      // The note after the line you read, with nothing listed in between, is read with it.
      store.markSessionRead(session, { through_message_id: first.id });
      expect(store.getNotification(sameGap.id)?.read_at).toBeTruthy();
      // The one after a later line you have not read is not.
      expect(store.getNotification(laterGap.id)?.read_at).toBeNull();

      store.markSessionRead(session, { through_message_id: second.id });
      expect(store.getNotification(laterGap.id)?.read_at).toBeTruthy();
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
