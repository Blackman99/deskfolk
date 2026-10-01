import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER } from "@real-bot/protocol";
import { isoNow } from "../ids";
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

describe("plan call-back reply deduplication", () => {
  const translation = `Make a sci-fi short-film video, longer than 5 minutes.

备选：
- Produce a science-fiction short video with a runtime of more than 5 minutes.
- Create a sci-fi short drama video that must run longer than five minutes.`;
  const reworded = translation.replace("video, longer", "video that runs longer").replace("must run longer", "must be longer");

  function repeats(previous: string, body: string, planNudge = true, outside?: "plan" | "session" | "author") {
    const { store, writer, reviewer, group, trigger, turn } = fixture();
    try {
      const message = store.insertMessage({ sessionId: group.id, turnId: turn.id, kind: "bot", author: writer.id, body: previous });
      store.setTurnStatus(turn.id, "completed");
      const recalled = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: trigger.id });
      if (outside === "plan") store.db.run("UPDATE messages SET task_id = NULL WHERE id = ?", [message.id]);
      return store.repeatsPlanAnswer({ turnId: recalled.id, sessionId: outside === "session" ? "elsewhere" : group.id, author: outside === "author" ? reviewer.id : writer.id, body, planNudge });
    } finally {
      store.close();
    }
  }

  test("recognizes the screenshot's light prose changes and Markdown-only changes", () => {
    expect(repeats(translation, reworded)).toBe(true);
    expect(repeats(translation, translation.replace("Make a", "**Make** a").replace(/^- /gm, "* "))).toBe(true);
  });

  test("leaves new content, changed numbers, negation, questions and short answers intact", () => {
    for (const body of [
      reworded + "\nUse a cinematic tone.",
      reworded.replace("5 minutes", "6 minutes"),
      reworded.replace("more than", "less than"),
      reworded.replace("must be", "must not be"),
      reworded.replace("longer than 5 minutes.", "longer than 5 minutes?"),
    ]) expect(repeats(translation, body)).toBe(false);
    expect(repeats("The answer is ready.", "The answer was ready.")).toBe(false);
    expect(repeats(translation + "\nSend the video that failed review back to the editor.", reworded + "\nSend the video failed review back to the editor.")).toBe(false);
    expect(repeats(translation + "\nThis should be ready for the next review.", reworded + "\nThis should ready for the next review.")).toBe(false);
  });

  test("preserves new link destinations, file paths, code and mentions", () => {
    for (const [before, after] of [
      ["\n[成片](deliverables/first.mp4)", "\n[成片](deliverables/second.mp4)"],
      ["\n[参考](https://example.com/first)", "\n[参考](https://example.com/second)"],
      ["\n附件：deliverables/first.mp4", "\n附件：deliverables/second.mp4"],
      ["\n`const value = 1`", "\n`const value = 2`"],
      ["\n@Writer", "\n@Reviewer"],
    ]) expect(repeats(translation + before, reworded + after)).toBe(false);
  });

  test("only compares this Bot's answers in this session and plan on an app call-back", () => {
    expect(repeats(translation, reworded, false)).toBe(false);
    for (const outside of ["plan", "session", "author"] as const) expect(repeats(translation, reworded, true, outside)).toBe(false);
  });
});

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

describe("the line a check-back wakes its Bot with", () => {
  test("a database from before the column finds the lines already fired and hides them", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-check-back-line-"));
    const file = join(dir, "state.sqlite");
    try {
      const store = new Store({ filename: file });
      const created = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
      const writer = created.bot;
      const session = created.direct_session.id;
      store.postMessage(session, { body: "写一份周报，交到 report.md" });
      const { row } = store.scheduleCheckBack({ botId: writer.id, sessionId: session, turnId: null, note: "看 report.md 写好没", afterMinutes: 1 });
      store.claimCheckBack(row.id, new Date(Date.parse(row.due_at) + 1000));
      const line = store.insertMessage({ sessionId: session, kind: "system", author: writer.id, body: "回看：看 report.md 写好没" });
      const echo = store.insertMessage({ sessionId: session, kind: "bot", author: writer.id, body: "回看：看 report.md 写好没" });
      store.db.run(`ALTER TABLE check_backs DROP COLUMN message_id`);
      store.close();

      const reopened = new Store({ filename: file });
      expect(reopened.getCheckBack(row.id).message_id).toBe(line.id);
      const shown = reopened.listMessages(session).items.map((m) => m.id);
      expect(shown).not.toContain(line.id);
      expect(shown).toContain(echo.id);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the app's call-backs to a plan", () => {
  test("are counted since you last said something in the plan, a line filed under it or an answer to its question; a line of yours elsewhere, or a Bot's own appointment, changes nothing", () => {
    const { store, writer, reviewer, group, trigger, turn } = fixture();
    const planId = turn.task_id!;
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 25, 10, minute));
    const said = (minute: number, taskId: string | null) => {
      const line = minute === 0 ? trigger : store.insertMessage({ sessionId: group.id, kind: "user", author: USER_MEMBER, body: "看看进度" });
      store.db.run("UPDATE messages SET created_at = ?, task_id = ? WHERE id = ?", [at(minute).toISOString(), taskId, line.id]);
    };
    // The plan watch's budget: call-backs since you last said something in the plan, a line or an answer.
    const spent = () => store.planNudgesSince(planId, store.lastUserLineAt(planId) ?? "");
    const callBack = (botId: string, minute: number) =>
      store.bookPlanNudge({ botId, sessionId: group.id, taskId: planId, ticketId: null, note: "规划静下来一阵了", now: at(minute) });

    said(0, planId);
    expect(spent()).toBe(0);
    callBack(writer.id, 1);
    callBack(reviewer.id, 2);
    expect(spent()).toBe(2);
    said(3, null);
    callBack(writer.id, 4);
    store.scheduleCheckBack({ botId: reviewer.id, sessionId: group.id, turnId: turn.id, note: "看 Writer 交了没", afterMinutes: 5, now: at(4) });
    expect(spent()).toBe(3);
    // Your line filed under the plan starts the count over.
    said(5, planId);
    expect(spent()).toBe(0);
    callBack(writer.id, 6);
    expect(spent()).toBe(1);
    // So does your answer to one of its Bots' questions, dated when you answered it.
    const ask = store.insertMessage({
      sessionId: group.id,
      kind: "ask",
      author: writer.id,
      body: "先做哪个？",
      ask: { options: [{ label: "初稿" }, { label: "配图" }], multi_select: false },
    });
    store.db.run("UPDATE messages SET created_at = ?, task_id = ? WHERE id = ?", [at(6).toISOString(), planId, ask.id]);
    callBack(writer.id, 7);
    expect(spent()).toBe(2);
    store.recordAskAnswer(ask.id, { selected: ["初稿"], custom: null, answered_at: at(8).toISOString() });
    expect(spent()).toBe(0);
    store.close();
  });

  test("are stamped on the store's clock, so a settle filed just before one is no hand-over after it", () => {
    const { store, writer, group, turn } = fixture();
    const planId = turn.task_id!;
    const draft = store.createTicket({ taskId: planId, title: "初稿", status: "doing", worker: writer.id });
    store.createTicket({ taskId: planId, title: "配图", status: "todo" });
    const spec = { kind: "周报", goal: "写周报", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active" as const };
    // A busy store's clock runs ahead of the wall clock.
    for (let i = 0; i < 50; i += 1) isoNow();
    store.applyOrganizerResult({
      sessionId: group.id,
      current: store.getTask(planId),
      result: { decision: "continue", resumePlanId: null, spec, tickets: [{ id: draft.id, spec: "", status: "review" }], messageTicket: null },
      source: { messageId: null, turnId: turn.id, messageBody: "" },
    });
    const nudge = store.bookPlanNudge({ botId: writer.id, sessionId: group.id, taskId: planId, ticketId: null, note: "规划静下来了" });
    expect(nudge.created_at > store.lastSpecRevisionAt(planId)).toBe(true);
    expect(store.ticketHandedOverSince(planId, nudge.created_at)).toBe(false);
    store.close();
  });
});
