import { describe, expect, test } from "bun:test";
import { USER_MEMBER } from "@real-bot/protocol";
import { Store } from ".";
import { CHECK_BACK_MAX_MINUTES, CHECK_BACK_NOTE_MAX } from "./check-backs";

function fixture() {
  const store = new Store();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
  const group = store.createGroup({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] });
  const trigger = store.postMessage(group.id, { body: "写一份周报，交到 report.md" });
  const turn = store.createTurn({ sessionId: group.id, botId: writer.bot.id, triggerMessageId: trigger.id });
  return { store, writer: writer.bot, reviewer: reviewer.bot, group, trigger, turn };
}

describe("booking a check-back", () => {
  test("lands on the turn's job, due after the minutes asked for, and is the Bot's one pending appointment", () => {
    const { store, writer, group, turn } = fixture();
    const at = new Date("2026-09-25T10:00:00.000Z");
    const { row, replaced } = store.scheduleCheckBack({
      botId: writer.id,
      sessionId: group.id,
      turnId: turn.id,
      note: "  看 Reviewer 回了没有 \n 没回就催一次 ",
      afterMinutes: 15,
      now: at,
    });
    expect(replaced).toBe(false);
    expect(row.task_id).toBe(turn.task_id!);
    expect(row.turn_id).toBe(turn.id);
    expect(row.due_at).toBe("2026-09-25T10:15:00.000Z");
    expect(row.note).toBe("看 Reviewer 回了没有 没回就催一次");
    expect(row.fired_at).toBeNull();
    expect(store.pendingCheckBack(writer.id, group.id)?.id).toBe(row.id);
    // Not due yet, then due: the scheduler reads it exactly once its time has come.
    expect(store.dueCheckBacks(new Date("2026-09-25T10:14:59.000Z"))).toEqual([]);
    expect(store.dueCheckBacks(new Date("2026-09-25T10:15:00.000Z")).map((r) => r.id)).toEqual([row.id]);
    store.close();
  });

  test("booking again replaces the earlier appointment instead of stacking a second one", () => {
    const { store, writer, group, turn } = fixture();
    const first = store.scheduleCheckBack({ botId: writer.id, sessionId: group.id, turnId: turn.id, note: "first", afterMinutes: 5 });
    const second = store.scheduleCheckBack({ botId: writer.id, sessionId: group.id, turnId: turn.id, note: "second", afterMinutes: 30 });
    expect(second.replaced).toBe(true);
    expect(store.getCheckBack(first.row.id).voided_at).not.toBeNull();
    expect(store.pendingCheckBack(writer.id, group.id)?.note).toBe("second");
    expect(store.listPendingCheckBacks(group.id)).toHaveLength(1);
    store.close();
  });

  test("another Bot's appointment in the same session is its own", () => {
    const { store, writer, reviewer, group, turn } = fixture();
    store.scheduleCheckBack({ botId: writer.id, sessionId: group.id, turnId: turn.id, note: "w", afterMinutes: 5 });
    const theirs = store.scheduleCheckBack({ botId: reviewer.id, sessionId: group.id, turnId: null, note: "r", afterMinutes: 5 });
    expect(theirs.replaced).toBe(false);
    expect(store.listPendingCheckBacks(group.id)).toHaveLength(2);
    store.close();
  });

  test("rejects a blank note, a non-integer, and minutes outside a week", () => {
    const { store, writer, group, turn } = fixture();
    const book = (note: unknown, afterMinutes: unknown) =>
      store.scheduleCheckBack({ botId: writer.id, sessionId: group.id, turnId: turn.id, note, afterMinutes });
    expect(() => book("   ", 5)).toThrow("note is required");
    expect(() => book(42, 5)).toThrow("note is required");
    expect(() => book("ok", 0)).toThrow("after_minutes");
    expect(() => book("ok", 2.5)).toThrow("after_minutes");
    expect(() => book("ok", "5")).toThrow("after_minutes");
    expect(() => book("ok", CHECK_BACK_MAX_MINUTES + 1)).toThrow("after_minutes");
    expect(store.pendingCheckBack(writer.id, group.id)).toBeNull();
    const long = book("x".repeat(CHECK_BACK_NOTE_MAX + 50), CHECK_BACK_MAX_MINUTES);
    expect([...long.row.note].length).toBe(CHECK_BACK_NOTE_MAX);
    store.close();
  });

  test("a Bot cannot book in a session it is not in", () => {
    const { store, writer, reviewer } = fixture();
    const theirDirect = store.createBot({ name: "Other", duties: "", boundaries: "" }).direct_session;
    expect(() =>
      store.scheduleCheckBack({ botId: writer.id, sessionId: theirDirect.id, turnId: null, note: "n", afterMinutes: 5 }),
    ).toThrow("not in that session");
    expect(store.listPendingCheckBacks()).toHaveLength(0);
    void reviewer;
    store.close();
  });
});

describe("firing and voiding", () => {
  test("a claim is compare-and-set: the second tick gets nothing", () => {
    const { store, writer, group, turn } = fixture();
    const { row } = store.scheduleCheckBack({ botId: writer.id, sessionId: group.id, turnId: turn.id, note: "n", afterMinutes: 1 });
    const at = new Date(Date.parse(row.due_at) + 1000);
    expect(store.claimCheckBack(row.id, at)?.id).toBe(row.id);
    expect(store.claimCheckBack(row.id, at)).toBeNull();
    expect(store.dueCheckBacks(at)).toEqual([]);
    store.markCheckBackFired(row.id, "turn_2");
    expect(store.getCheckBack(row.id)).toMatchObject({ fired_at: at.toISOString(), fired_turn_id: "turn_2" });
    expect(store.pendingCheckBack(writer.id, group.id)).toBeNull();
    store.close();
  });

  test("Stop on the turn that booked it voids it; a later turn's Stop does not", () => {
    const { store, writer, group, trigger, turn } = fixture();
    // Stop only reaches direct turns, so the appointment is booked from the Writer's direct.
    const direct = store.findDirectSession(USER_MEMBER, writer.id)!;
    const ask = store.postMessage(direct.id, { body: "先看看" });
    const own = store.createTurn({ sessionId: direct.id, botId: writer.id, triggerMessageId: ask.id });
    const { row } = store.scheduleCheckBack({ botId: writer.id, sessionId: direct.id, turnId: own.id, note: "n", afterMinutes: 5 });
    const later = store.createTurn({ sessionId: direct.id, botId: writer.id, triggerMessageId: ask.id });
    store.stopTurn(later.id);
    expect(store.getCheckBack(row.id).voided_at).toBeNull();
    store.stopTurn(own.id);
    expect(store.getCheckBack(row.id).voided_at).not.toBeNull();
    expect(store.pendingCheckBack(writer.id, direct.id)).toBeNull();
    void group;
    void trigger;
    void turn;
    store.close();
  });

  test("clearing the session's history voids its appointments; deleting the group drops them", () => {
    const { store, writer, group, turn } = fixture();
    const { row } = store.scheduleCheckBack({ botId: writer.id, sessionId: group.id, turnId: turn.id, note: "n", afterMinutes: 5 });
    store.clearSessionMessages(group.id);
    expect(store.getCheckBack(row.id).voided_at).not.toBeNull();
    const again = store.scheduleCheckBack({ botId: writer.id, sessionId: group.id, turnId: null, note: "n2", afterMinutes: 5 });
    store.deleteSession(group.id);
    expect(() => store.getCheckBack(again.row.id)).toThrow("check-back not found");
    store.close();
  });

  test("deleting the Bot voids what it booked and leaves the others", () => {
    const { store, writer, reviewer, group, turn } = fixture();
    const mine = store.scheduleCheckBack({ botId: writer.id, sessionId: group.id, turnId: turn.id, note: "w", afterMinutes: 5 });
    const theirs = store.scheduleCheckBack({ botId: reviewer.id, sessionId: group.id, turnId: null, note: "r", afterMinutes: 5 });
    store.deleteBot(writer.id);
    expect(store.getCheckBack(mine.row.id).voided_at).not.toBeNull();
    expect(store.getCheckBack(theirs.row.id).voided_at).toBeNull();
    store.close();
  });
});
