import { describe, expect, it } from "bun:test";
import { Store } from "./index";
import { USER_MEMBER } from "@real-bot/protocol";
import { committedEvents } from "./events";

describe("PR1 notifications domain integration", () => {
  it("creates approval notification and resolves it on approval", () => {
    const store = new Store();
    try {
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const trigger = store.postMessage(writer.direct_session.id, { body: "write file" });
      const turn = store.createTurn({
        sessionId: writer.direct_session.id,
        botId: writer.bot.id,
        triggerMessageId: trigger.id,
      });

      const approval = store.insertApproval({
        turnId: turn.id,
        messageId: null,
        kind_key: "outside-workspace",
        summary: "Write /tmp/a.txt",
        target: "/tmp/a.txt",
      });

      const notif = store.getNotificationBySemanticKey(`approval:${approval.id}`);
      expect(notif).toBeTruthy();
      expect(notif!.action_state).toBe("open");
      expect(notif!.kind).toBe("approval");
      expect(notif!.read_at).toBeNull();

      store.resolveApproval(approval.id, "allow_once");
      const resolvedNotif = store.getNotificationBySemanticKey(`approval:${approval.id}`);
      expect(resolvedNotif!.action_state).toBe("resolved");
      expect(resolvedNotif!.resolution_reason).toBe("resolved");
      expect(resolvedNotif!.read_at).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it("handles bot reply notifications in direct sessions", () => {
    const store = new Store();
    try {
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const trigger = store.postMessage(writer.direct_session.id, { body: "hello" });
      const turn = store.createTurn({
        sessionId: writer.direct_session.id,
        botId: writer.bot.id,
        triggerMessageId: trigger.id,
      });

      const botMsg = store.insertMessage({
        sessionId: writer.direct_session.id,
        turnId: turn.id,
        kind: "bot",
        author: writer.bot.id,
        body: "Hello there!",
      });

      const notif = store.getNotificationBySemanticKey(`reply:${botMsg.id}`);
      expect(notif).toBeTruthy();
      expect(notif!.kind).toBe("reply");
      expect(notif!.action_state).toBe("none");
      expect(notif!.read_at).toBeNull();
    } finally {
      store.close();
    }
  });

  it("handles routine_result notification for routine root turn", () => {
    const store = new Store();
    try {
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const routine = store.createRoutine({
        bot_id: writer.bot.id,
        title: "Daily Brief",
        instruction: "Do daily brief",
        schedule: { kind: "daily", time: "09:00" },
        enabled: true,
      });

      const trigger = store.insertMessage({
        sessionId: writer.direct_session.id,
        kind: "user",
        author: USER_MEMBER,
        body: routine.instruction,
      });

      const turn = store.createTurn({
        sessionId: writer.direct_session.id,
        botId: writer.bot.id,
        triggerMessageId: trigger.id,
        routineId: routine.id,
        routineDueAt: "2026-09-22T09:00:00.000Z",
      });

      const botMsg = store.insertMessage({
        sessionId: writer.direct_session.id,
        turnId: turn.id,
        kind: "bot",
        author: writer.bot.id,
        body: "Here is your daily brief.",
      });

      const notif = store.getNotificationBySemanticKey(`reply:${botMsg.id}`);
      expect(notif).toBeTruthy();
      expect(notif!.kind).toBe("routine_result");
      expect(notif!.action_state).toBe("none");
    } finally {
      store.close();
    }
  });

  it("handles synchronous turn interruption and continue", () => {
    const store = new Store();
    try {
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const trigger = store.postMessage(writer.direct_session.id, { body: "do long work" });
      const turn = store.createTurn({
        sessionId: writer.direct_session.id,
        botId: writer.bot.id,
        triggerMessageId: trigger.id,
      });

      const app = store.insertApproval({
        turnId: turn.id,
        messageId: null,
        kind_key: "unconstrained-shell",
        summary: "run shell",
        target: "*",
      });

      const interrupted = store.interruptTurnRecord(turn.id);
      expect(interrupted).toBeTruthy();

      const notif = store.getNotificationBySemanticKey(`interrupted:${turn.id}`);
      expect(notif).toBeTruthy();
      expect(notif!.kind).toBe("interrupted");
      expect(notif!.action_state).toBe("open");

      // Approval was voided
      const appNotif = store.getNotificationBySemanticKey(`approval:${app.id}`);
      expect(appNotif!.action_state).toBe("voided");

      // Claim continue
      const nextTurn = store.claimInterruptContinue(interrupted!.note.id);
      expect(nextTurn).toBeTruthy();

      const continuedNotif = store.getNotificationBySemanticKey(`interrupted:${turn.id}`);
      expect(continuedNotif!.action_state).toBe("resolved");
      expect(continuedNotif!.resolution_reason).toBe("continued");
      expect(continuedNotif!.read_at).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it("excludes failure and interrupted notifications in Bot↔Bot sessions where user is not present", () => {
    const store = new Store();
    try {
      const b1 = store.createBot({ name: "Bot1", duties: "d1", boundaries: "none" });
      const b2 = store.createBot({ name: "Bot2", duties: "d2", boundaries: "none" });
      const botDirect = store.createBotDirect(b1.bot.id, b2.bot.id, null);

      const trigger = store.insertMessage({
        sessionId: botDirect.id,
        kind: "bot",
        author: b1.bot.id,
        body: "handoff to bot 2",
      });

      const turn = store.createTurn({
        sessionId: botDirect.id,
        botId: b2.bot.id,
        triggerMessageId: trigger.id,
      });

      // Interrupt turn in Bot↔Bot session
      store.interruptTurnRecord(turn.id);
      // Verify no interrupted notification was created for this turn
      expect(store.getNotificationBySemanticKey(`interrupted:${turn.id}`)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("cascades notification cleanup on bot deletion and advances cleanup_revision", () => {
    const store = new Store();
    try {
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const trigger = store.postMessage(writer.direct_session.id, { body: "hi" });
      const turn = store.createTurn({
        sessionId: writer.direct_session.id,
        botId: writer.bot.id,
        triggerMessageId: trigger.id,
      });
      const msg = store.insertMessage({
        sessionId: writer.direct_session.id,
        turnId: turn.id,
        kind: "bot",
        author: writer.bot.id,
        body: "reply",
      });
      expect(store.getNotificationBySemanticKey(`reply:${msg.id}`)).toBeTruthy();

      const revBefore = store.getCleanupRevision();
      store.deleteBot(writer.bot.id);
      expect(store.getNotificationBySemanticKey(`reply:${msg.id}`)).toBeNull();
      expect(store.getCleanupRevision()).toBeGreaterThan(revBefore);
    } finally {
      store.close();
    }
  });

  it("voids pending actions and clears pending_ask_id on turn void actions", () => {
    const store = new Store();
    try {
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const trigger = store.postMessage(writer.direct_session.id, { body: "hi" });
      const turn = store.createTurn({
        sessionId: writer.direct_session.id,
        botId: writer.bot.id,
        triggerMessageId: trigger.id,
      });

      const askMsg = store.insertMessage({
        sessionId: writer.direct_session.id,
        turnId: turn.id,
        kind: "ask",
        author: writer.bot.id,
        body: "question?",
      });

      store.db.run("UPDATE turns SET pending_ask_id = ? WHERE id = ?", [askMsg.id, turn.id]);
      store.createNotification({
        semantic_key: `ask:${askMsg.id}`,
        kind: "ask",
        session_id: writer.direct_session.id,
        message_id: askMsg.id,
        turn_id: turn.id,
        action_state: "open",
      });

      store.voidPendingTurnActions(turn.id, "turn_failed");
      const turnAfter = store.getTurn(turn.id);
      expect(turnAfter.pending_ask_id).toBeNull();

      const askNotif = store.getNotificationBySemanticKey(`ask:${askMsg.id}`);
      expect(askNotif?.action_state).toBe("voided");
    } finally {
      store.close();
    }
  });

  it("cleans up notifications when session history is cleared", () => {
    const store = new Store();
    try {
      const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const trigger = store.postMessage(writer.direct_session.id, { body: "hi" });
      const turn = store.createTurn({
        sessionId: writer.direct_session.id,
        botId: writer.bot.id,
        triggerMessageId: trigger.id,
      });
      const msg = store.insertMessage({
        sessionId: writer.direct_session.id,
        turnId: turn.id,
        kind: "bot",
        author: writer.bot.id,
        body: "reply",
      });

      expect(store.getNotificationBySemanticKey(`reply:${msg.id}`)).toBeTruthy();
      store.clearSessionMessages(writer.direct_session.id);
      expect(store.getNotificationBySemanticKey(`reply:${msg.id}`)).toBeNull();
    } finally {
      store.close();
    }
  });
});
