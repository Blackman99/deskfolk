/**
 * Holds (叫停, ADR 0040): what one covers, what it changes in the store when it is made — the plans
 * it parks, the check-backs it sets aside — and how lifting it, which only you do, puts those back.
 */
import { describe, expect, test } from "bun:test";
import type { ClientEvent } from "@real-bot/protocol";
import { Store } from ".";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { parsePlanSpec, type PlanSpec } from "./plan-shape";
import type { OrganizerResult } from "./plan-spec";

function spec(over: Partial<PlanSpec> = {}): PlanSpec {
  return {
    kind: "视频",
    goal: "EP01 动画成片",
    acceptance: [],
    rules: [],
    process: [],
    progress: { done: [], open: [], blocked: [] },
    status: "active",
    ...over,
  };
}

function result(over: Partial<OrganizerResult> = {}): OrganizerResult {
  return { decision: "continue", resumePlanId: null, spec: spec(), tickets: [], messageTicket: null, ...over };
}

/** 视频导演 and 审片员 in a group with a plan and a ticket, and a direct of their own on it. Holds are on. */
function fixture(opts: { holdsOn?: boolean; legacySlot?: boolean } = {}) {
  const store = new Store();
  if (opts.holdsOn !== false) store.raiseEngineLevel(null);
  // P2 compatibility cases deliberately exercise the old one-current-plan slot; P4b permits
  // multiple non-dormant plans and therefore no longer moves one aside merely by opening another.
  if (opts.legacySlot) store.db.run("UPDATE settings SET value = '1' WHERE key = 'engine_level'");
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "none" });
  const room = store.createGroup({ name: "片场", members: [director.bot.id, reviewer.bot.id] });
  const plan = store.openTask({ sessionId: room.id, title: "EP01", spec: spec() });
  const shot = store.createTicket({ taskId: plan.id, title: "Shot 11", spec: "", status: "doing", worker: director.bot.id });
  const kickoff = store.postMessage(room.id, { body: "EP01 开工" });
  store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [plan.id, kickoff.id]);
  const thread = store.createBotDirect(director.bot.id, reviewer.bot.id, { sessionId: room.id, messageId: kickoff.id });
  const opener = store.insertMessage({ sessionId: thread.id, kind: "bot", author: reviewer.bot.id, body: "Shot 11 分镜过了" });
  const turn = store.createTurn({ sessionId: thread.id, botId: director.bot.id, triggerMessageId: opener.id, taskId: plan.id, ticketId: shot.id });
  return { store, director: director.bot, reviewer: reviewer.bot, direct: director.direct_session, room, plan, shot, thread, turn };
}

function refusal(work: () => unknown): { status: number; code: string } | null {
  try {
    work();
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, code: error.code };
    throw error;
  }
  return null;
}

describe("making a hold", () => {
  test("is refused until the engine level brings holds, which also raises the database's floor", () => {
    const { store, director } = fixture({ holdsOn: false });
    expect(refusal(() => store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" }))).toEqual({
      status: 409,
      code: "holds_unavailable",
    });
    expect(store.capabilities()).toMatchObject({ engine_level: 0, features: [] });
    expect(store.raiseEngineLevel(null)).toEqual({ level: 2, raised: true, refused: null, accepted: null });
    expect(store.capabilities()).toMatchObject({ engine_level: 2, features: ["holds", "work_items"] });
    expect(store.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'schema_min_compatible'").get()?.value).toBe("2");
    const hold = store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    expect(hold).toMatchObject({ scope: "bot", scope_id: director.id, action: "pause", cascade: true, source: "user_button", lifted_at: null, targets: [] });
    store.close();
  });

  test("checks its scope, its targets and the line it came from", () => {
    const { store, director, plan, room, turn } = fixture();
    const make = (input: Partial<Parameters<Store["createHold"]>[0]>) =>
      refusal(() => store.createHold({ source: "user_button", scope: "bot", scopeId: director.id, ...input }));
    expect(make({ scope: "everyone" })?.status).toBe(422);
    expect(make({ scope: "global", scopeId: room.id })?.status).toBe(422);
    expect(make({ scope: "plan", scopeId: undefined })?.status).toBe(422);
    expect(make({ scope: "plan", scopeId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" })?.status).toBe(404);
    expect(make({ scope: "bot_plan", scopeId: director.id })?.status).toBe(404);
    expect(make({ scope: "bot_plan", scopeId: `${director.id}:${plan.id}` })).toBeNull();
    expect(make({ action: "stop" })?.status).toBe(422);
    expect(make({ targets: [{ scope: "global", id: "x" }] })?.status).toBe(422);
    expect(make({ targets: "session" })?.status).toBe(422);
    // Only a Stop's own hold, on one Bot in one plan or on one turn, goes when you next speak.
    expect(make({ liftOnNextUserMessage: true })?.status).toBe(422);
    expect(make({ scope: "turn", scopeId: turn.id, liftOnNextUserMessage: true })).toBeNull();
    // A stop you said names your line, and a line a Bot wrote is not yours.
    expect(make({ source: "user_text" })?.status).toBe(422);
    const botLine = store.insertMessage({ sessionId: room.id, kind: "bot", author: director.id, body: "停了" });
    expect(make({ source: "user_text", sourceMessageId: botLine.id })?.status).toBe(422);
    const yours = store.postMessage(room.id, { body: "你手头的生成停一下" });
    expect(make({ source: "user_text", sourceMessageId: yours.id })).toBeNull();
    store.close();
  });
});

describe("what a hold covers", () => {
  test("each scope covers its own and nothing past it", () => {
    const { store, director, reviewer, room, direct, plan, shot, thread, turn } = fixture();
    const elsewhere = store.openTask({ sessionId: direct.id, title: "回响纪元" });
    const inThread = { botId: director.id, sessionId: thread.id, taskId: plan.id, ticketId: shot.id, turnId: turn.id };
    const reviewerInRoom = { botId: reviewer.id, sessionId: room.id, taskId: plan.id, ticketId: null, turnId: null };
    const directorElsewhere = { botId: director.id, sessionId: direct.id, taskId: elsewhere.id, ticketId: null, turnId: null };
    const covers = (scope: string, scopeId: string | null) => {
      const hold = store.createHold({ scope, scopeId, source: "user_button" });
      const seen = [inThread, reviewerInRoom, directorElsewhere].map((subject) => store.holdsCovering(subject).some((row) => row.id === hold.id));
      store.liftHold(hold.id, { by: "user_button" });
      return seen;
    };
    expect(covers("global", null)).toEqual([true, true, true]);
    // A Bot's hold follows it into every conversation; the other Bot goes on.
    expect(covers("bot", director.id)).toEqual([true, false, true]);
    // A hold on the group reaches its plan in the Bot↔Bot direct too, and not a plan homed elsewhere.
    expect(covers("session", room.id)).toEqual([true, true, false]);
    expect(covers("plan", plan.id)).toEqual([true, true, false]);
    expect(covers("ticket", shot.id)).toEqual([true, false, false]);
    expect(covers("bot_plan", `${director.id}:${plan.id}`)).toEqual([true, false, false]);
    expect(covers("turn", turn.id)).toEqual([true, false, false]);
    store.close();
  });

  test("its targets reach past its scope, fixed when it was made", () => {
    const { store, director, reviewer, thread, room } = fixture();
    const hold = store.createHold({ scope: "bot", scopeId: director.id, targets: [{ scope: "session", id: thread.id }], source: "user_button" });
    // The reviewer's work in the direct the director opened is held with it; its own in the group is not.
    expect(store.holdsCovering({ botId: reviewer.id, sessionId: thread.id }).map((row) => row.id)).toEqual([hold.id]);
    expect(store.holdsCovering({ botId: reviewer.id, sessionId: room.id })).toEqual([]);
    store.close();
  });

  test("a lifted hold covers nothing, and lifting takes you: a line of yours, or a button", () => {
    const { store, director, room } = fixture();
    const hold = store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    expect(refusal(() => store.liftHold(hold.id, { by: "organizer" }))?.status).toBe(422);
    expect(refusal(() => store.liftHold(hold.id, { by: "user_text" }))?.status).toBe(422);
    const botLine = store.insertMessage({ sessionId: room.id, kind: "bot", author: director.id, body: "继续" });
    expect(refusal(() => store.liftHold(hold.id, { by: "user_text", messageId: botLine.id }))?.status).toBe(422);
    const yours = store.postMessage(room.id, { body: "继续" });
    const lifted = store.liftHold(hold.id, { by: "user_text", messageId: yours.id });
    expect(lifted).toMatchObject({ lifted_by: "user_text", lifted_message_id: yours.id });
    expect(lifted.lifted_at).not.toBeNull();
    expect(store.holdsCovering({ botId: director.id })).toEqual([]);
    // Lifting it again changes nothing, including who lifted it.
    expect(store.liftHold(hold.id, { by: "user_button" })).toEqual(lifted);
    expect(store.listHolds({ inForce: true })).toEqual([]);
    expect(store.listHolds().map((row) => row.id)).toEqual([hold.id]);
    store.close();
  });
});

describe("a hold over a plan reads as the plan parked", () => {
  test("in its status and its spec, still the conversation's current plan, and lifting puts it back", () => {
    const { store, plan, room } = fixture();
    const hold = store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
    const held = store.getTask(plan.id);
    expect(held).toMatchObject({ status: "parked", closed_at: null });
    expect(parsePlanSpec(held.spec)?.status).toBe("parked");
    expect(store.sessionCurrentTask(room.id)?.id).toBe(plan.id);
    expect(store.getHold(hold.id).effect.parked_plans).toEqual([{ task_id: plan.id, prior: "active" }]);
    expect(store.taskDetail(plan.id, () => true).held_by?.map((row) => row.id)).toEqual([hold.id]);

    const lifted = store.liftHold(hold.id, { by: "user_button" });
    expect(lifted.effect.restored_plans).toEqual([plan.id]);
    expect(store.getTask(plan.id)).toMatchObject({ status: "active", closed_at: null });
    expect(parsePlanSpec(store.getTask(plan.id).spec)?.status).toBe("active");
    expect(store.taskDetail(plan.id, () => true).held_by).toEqual([]);
    store.close();
  });

  test("the organizer cannot put it back in progress, and echoing parked does not move it out of the slot", () => {
    const { store, plan, room } = fixture();
    const hold = store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
    // 10:53 「你私聊里的没停」: the filing wrote the plan back to in progress.
    store.setTaskSpec(plan.id, spec({ status: "active", rules: ["接着做完"] }));
    expect(store.getTask(plan.id).status).toBe("parked");
    expect(parsePlanSpec(store.getTask(plan.id).spec)).toMatchObject({ status: "parked", rules: ["接着做完"] });
    store.setTaskSpec(plan.id, spec({ status: "parked" }));
    expect(store.getTask(plan.id)).toMatchObject({ status: "parked", closed_at: null });
    expect(store.sessionCurrentTask(room.id)?.id).toBe(plan.id);
    // What it asked for is what lifting the hold gets to.
    store.liftHold(hold.id, { by: "user_button" });
    expect(store.getTask(plan.id).status).toBe("active");
    store.close();
  });

  test("a resume files into it without putting it back in progress", () => {
    const { store, plan, room } = fixture();
    const other = store.postMessage(room.id, { body: "先做预告片" });
    store.applyOrganizerResult({
      sessionId: room.id,
      current: store.sessionCurrentTask(room.id),
      result: result({ decision: "new", spec: spec({ goal: "预告片" }) }),
      source: { messageId: other.id, turnId: null, messageBody: other.body },
    });
    const hold = store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
    const back = store.postMessage(room.id, { body: "回到 EP01" });
    const resumed = store.applyOrganizerResult({
      sessionId: room.id,
      current: store.sessionCurrentTask(room.id),
      result: result({ decision: "resume", resumePlanId: plan.id }),
      source: { messageId: back.id, turnId: null, messageBody: back.body },
    });
    expect(resumed.task).toMatchObject({ id: plan.id, status: "parked", closed_at: null });
    expect(store.sessionCurrentTask(room.id)?.id).toBe(plan.id);
    store.liftHold(hold.id, { by: "user_button" });
    expect(store.getTask(plan.id)).toMatchObject({ status: "active", closed_at: null });
    store.close();
  });

  test("a plan opened in a conversation you stopped is born parked; one finished stays finished", () => {
    const { store, room, plan } = fixture();
    const hold = store.createHold({ scope: "session", scopeId: room.id, source: "user_button" });
    expect(store.getTask(plan.id).status).toBe("parked");
    const later = store.openTask({ sessionId: room.id, title: "预告片" });
    expect(store.getTask(later.id).status).toBe("parked");
    store.setTaskSpec(later.id, spec({ goal: "预告片", status: "done" }));
    expect(store.getTask(later.id).status).toBe("done");
    store.liftHold(hold.id, { by: "user_button" });
    expect(store.getTask(later.id).status).toBe("done");
    store.close();
  });

  test("a hold on a conversation parks its own plans and no one else's, whichever plan came first", () => {
    // The group's plan is the first row in tasks; the director's direct opens one after it.
    const { store, room, direct, plan } = fixture();
    const elsewhere = store.openTask({ sessionId: direct.id, title: "回响纪元", spec: spec({ goal: "回响纪元" }) });
    const onRoom = store.createHold({ scope: "session", scopeId: room.id, source: "user_button" });
    expect(store.getTask(plan.id).status).toBe("parked");
    expect(store.getTask(elsewhere.id).status).toBe("active");
    expect(store.getHold(onRoom.id).effect.parked_plans).toEqual([{ task_id: plan.id, prior: "active" }]);
    store.liftHold(onRoom.id, { by: "user_button" });

    const onDirect = store.createHold({ scope: "session", scopeId: direct.id, source: "user_button" });
    expect(store.getTask(elsewhere.id).status).toBe("parked");
    expect(store.getTask(plan.id).status).toBe("active");
    expect(store.getHold(onDirect.id).effect.parked_plans).toEqual([{ task_id: elsewhere.id, prior: "active" }]);
    // A plan opened there is born parked; the group opening one is not held by it.
    const later = store.openTask({ sessionId: direct.id, title: "预告片" });
    expect(store.getTask(later.id).status).toBe("parked");
    const inRoom = store.openTask({ sessionId: room.id, title: "花絮" });
    expect(store.getTask(inRoom.id).status).toBe("active");
    store.close();
  });

  test("a legacy plan a newer one moved aside reads parked in its spec too, and lifting moves it aside again", () => {
    const { store, room, plan } = fixture({ legacySlot: true });
    const newer = store.openTask({ sessionId: room.id, title: "预告片", spec: spec({ goal: "预告片" }) });
    // Moved aside: parked in the column, still in progress in its spec.
    expect(store.getTask(plan.id).status).toBe("parked");
    expect(parsePlanSpec(store.getTask(plan.id).spec)?.status).toBe("active");
    const hold = store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
    expect(parsePlanSpec(store.getTask(plan.id).spec)?.status).toBe("parked");
    expect(store.getHold(hold.id).effect.parked_plans).toEqual([{ task_id: plan.id, prior: "aside" }]);

    // The board sends the spec back with an edit of the goal: no resume, the hold stands.
    const detail = store.taskDetail(plan.id, () => true);
    store.setPlanSpecByUser(plan.id, { ...detail.spec, goal: "EP01 动画成片，2 分钟" }, detail.revision);
    expect(store.getHold(hold.id).lifted_at).toBeNull();
    expect(store.getTask(plan.id).status).toBe("parked");

    store.liftHold(hold.id, { by: "user_button" });
    const back = store.getTask(plan.id);
    expect(back.status).toBe("parked");
    expect(back.closed_at).not.toBeNull();
    expect(parsePlanSpec(back.spec)).toMatchObject({ status: "active", goal: "EP01 动画成片，2 分钟" });
    expect(store.sessionCurrentTask(room.id)?.id).toBe(newer.id);
    // Moved aside, not stopped: the boot import leaves it alone.
    expect(store.reconcileHolds().imported).toEqual([]);
    store.close();
  });

  test("making and lifting it are each a version of the plan, so a board showing the one before cannot undo either", () => {
    const { store, plan } = fixture();
    store.setPlanSpecByUser(plan.id, spec({ goal: "EP01 动画成片，约 2 分钟" }));
    const filed = store.lastSpecRevisionAt(plan.id);
    // The board's copy from before the stop: in progress.
    const before = store.taskDetail(plan.id, () => true);
    const hold = store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
    expect(store.taskDetail(plan.id, () => true).revision).toBe(before.revision + 1);
    // An edit made on it sends back in progress, which would lift the hold: refused.
    expect(refusal(() => store.setPlanSpecByUser(plan.id, { ...before.spec, goal: "EP01 动画成片，2 分钟" }, before.revision))).toEqual({
      status: 409,
      code: "revision_conflict",
    });
    expect(store.getHold(hold.id).lifted_at).toBeNull();
    expect(store.getTask(plan.id).status).toBe("parked");

    // The other way round: a copy from under the hold sends back parked, which would make a new one.
    const during = store.taskDetail(plan.id, () => true);
    store.liftHold(hold.id, { by: "user_button" });
    expect(store.taskDetail(plan.id, () => true).revision).toBe(during.revision + 1);
    expect(refusal(() => store.setPlanSpecByUser(plan.id, during.spec, during.revision))).toEqual({ status: 409, code: "revision_conflict" });
    expect(store.listHolds({ inForce: true })).toEqual([]);
    expect(store.getTask(plan.id).status).toBe("active");

    // Neither version is yours, and neither files anything: the goal you typed is still yours, and
    // the organizer still reads everything since your edit.
    expect(store.listSpecRevisions(plan.id).map((row) => [row.actor, row.cause, row.spec.status])).toEqual([
      ["app", "hold", "active"],
      ["app", "hold", "parked"],
      ["user", null, "active"],
    ]);
    expect(store.userWrittenSpec(plan.id).goal).toBe(true);
    expect(store.lastSpecRevisionAt(plan.id)).toBe(filed);
    store.close();
  });

  test("a legacy plan a newer one moves aside while a hold parks it goes back moved aside, under a plan hold or a conversation's", () => {
    for (const scope of ["plan", "session"] as const) {
      const { store, plan, room } = fixture({ legacySlot: true });
      const hold = store.createHold({ scope, scopeId: scope === "plan" ? plan.id : room.id, source: "user_button" });
      const newer = store.openTask({ sessionId: room.id, title: "预告片", spec: spec({ goal: "预告片" }) });
      expect(store.getHold(hold.id).effect.parked_plans).toContainEqual({ task_id: plan.id, prior: "aside" });
      store.liftHold(hold.id, { by: "user_button" });
      // Out of the slot and in progress in its spec only, as the newer plan left it: nothing calls its Bots back.
      const back = store.getTask(plan.id);
      expect(back).toMatchObject({ status: "parked", closed_at: expect.any(String) });
      expect(parsePlanSpec(back.spec)?.status).toBe("active");
      expect(store.getTask(newer.id)).toMatchObject({ status: "active", closed_at: null });
      expect(store.sessionCurrentTask(room.id)?.id).toBe(newer.id);
      store.close();
    }
  });

  test("one a resumed plan moves aside while a hold parks it goes back moved aside too", () => {
    const { store, plan, room } = fixture();
    const other = store.postMessage(room.id, { body: "先做预告片" });
    const trailer = store.applyOrganizerResult({
      sessionId: room.id,
      current: store.sessionCurrentTask(room.id),
      result: result({ decision: "new", spec: spec({ goal: "预告片" }) }),
      source: { messageId: other.id, turnId: null, messageBody: other.body },
    }).task;
    const hold = store.createHold({ scope: "plan", scopeId: trailer.id, source: "user_button" });
    const back = store.postMessage(room.id, { body: "回到 EP01" });
    store.applyOrganizerResult({
      sessionId: room.id,
      current: store.sessionCurrentTask(room.id),
      result: result({ decision: "resume", resumePlanId: plan.id }),
      source: { messageId: back.id, turnId: null, messageBody: back.body },
    });
    expect(store.getHold(hold.id).effect.parked_plans).toEqual([{ task_id: trailer.id, prior: "aside" }]);
    store.liftHold(hold.id, { by: "user_button" });
    expect(store.getTask(trailer.id)).toMatchObject({ status: "parked", closed_at: expect.any(String) });
    expect(parsePlanSpec(store.getTask(trailer.id).spec)?.status).toBe("active");
    expect(store.sessionCurrentTask(room.id)?.id).toBe(plan.id);
    store.close();
  });

  test("a hold on a Bot, a ticket, a turn or on everything leaves plan status alone", () => {
    const { store, director, plan, shot, turn } = fixture();
    store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    store.createHold({ scope: "ticket", scopeId: shot.id, source: "user_button" });
    store.createHold({ scope: "turn", scopeId: turn.id, source: "user_button" });
    const everything = store.createHold({ scope: "global", source: "user_button" });
    expect(store.getTask(plan.id).status).toBe("active");
    // Only the one over the plan as a whole says why nothing runs in it.
    expect(store.taskDetail(plan.id, () => true).held_by?.map((row) => row.id)).toEqual([everything.id]);
    store.close();
  });

  test("with two holds over it, lifting one leaves it parked and the other carries its way back", () => {
    const { store, plan, room } = fixture();
    const onPlan = store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
    const onRoom = store.createHold({ scope: "session", scopeId: room.id, source: "user_button" });
    store.liftHold(onPlan.id, { by: "user_button" });
    expect(store.getTask(plan.id).status).toBe("parked");
    expect(store.getHold(onRoom.id).effect.parked_plans).toEqual([{ task_id: plan.id, prior: "active" }]);
    store.liftHold(onRoom.id, { by: "user_button" });
    expect(store.getTask(plan.id).status).toBe("active");
    store.close();
  });
});

describe("a hold over a check-back sets it aside", () => {
  test("cancelled as far as an older build can tell, and pending again once lifted", () => {
    const { store, director, thread, turn } = fixture();
    const booked = store.scheduleCheckBack({ botId: director.id, sessionId: thread.id, turnId: turn.id, note: "看母带导出", afterMinutes: 5 });
    expect(booked.row).toMatchObject({ cause: "self", dedupe_key: `${director.id}:${thread.id}`, attempts: 0, suspended_at: null });
    const hold = store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    const aside = store.getCheckBack(booked.row.id);
    expect(aside.suspended_at).not.toBeNull();
    expect(aside.voided_at).toBe(aside.suspended_at);
    expect(store.getHold(hold.id).effect.suspended_check_backs).toEqual([booked.row.id]);
    expect(store.dueCheckBacks(new Date(Date.now() + 3_600_000))).toEqual([]);

    const lifted = store.liftHold(hold.id, { by: "user_button" });
    expect(lifted.effect.resumed_check_backs).toEqual([booked.row.id]);
    expect(store.getCheckBack(booked.row.id)).toMatchObject({ suspended_at: null, voided_at: null });
    expect(store.pendingCheckBack(director.id, thread.id)?.id).toBe(booked.row.id);
    store.close();
  });

  test("one booked while the hold is in force waits for the lift too; booking again replaces it", () => {
    const { store, director, thread, turn } = fixture();
    const hold = store.createHold({ scope: "turn", scopeId: turn.id, source: "user_button" });
    const first = store.scheduleCheckBack({ botId: director.id, sessionId: thread.id, turnId: turn.id, note: "first", afterMinutes: 5 });
    expect(store.getCheckBack(first.row.id).suspended_at).not.toBeNull();
    const second = store.scheduleCheckBack({ botId: director.id, sessionId: thread.id, turnId: null, note: "second", afterMinutes: 5 });
    expect(second.replaced).toBe(true);
    expect(store.getCheckBack(first.row.id)).toMatchObject({ suspended_at: null });
    expect(store.getCheckBack(first.row.id).voided_at).not.toBeNull();
    // Not the turn's own booking, so the turn hold does not cover it.
    expect(store.pendingCheckBack(director.id, thread.id)?.id).toBe(second.row.id);
    store.liftHold(hold.id, { by: "user_button" });
    expect(store.getCheckBack(first.row.id).voided_at).not.toBeNull();
    expect(store.listPendingCheckBacks(thread.id).map((row) => row.id)).toEqual([second.row.id]);
    store.close();
  });

  test("one cancelled for good meanwhile, or taken over by a newer booking, stays cancelled", () => {
    const { store, director, reviewer, room, thread, turn } = fixture();
    const inThread = store.scheduleCheckBack({ botId: director.id, sessionId: thread.id, turnId: turn.id, note: "a", afterMinutes: 5 });
    const inRoom = store.scheduleCheckBack({ botId: reviewer.id, sessionId: room.id, turnId: null, note: "b", afterMinutes: 5 });
    const hold = store.createHold({ scope: "global", source: "user_button" });
    // You clear the direct's history while the Bots are stopped: its check-back is cancelled for good.
    store.clearSessionMessages(thread.id);
    // And a booking for the reviewer in the group lands pending without passing through the store (an
    // older build's write): it is the one the reviewer has there now.
    const newer = ulid();
    store.db.run(
      `INSERT INTO check_backs (id, bot_id, session_id, note, due_at, created_at) VALUES (?, ?, ?, 'newer', ?, ?)`,
      [newer, reviewer.id, room.id, inRoom.row.due_at, isoNow()],
    );
    store.liftHold(hold.id, { by: "user_button" });
    for (const id of [inThread.row.id, inRoom.row.id]) {
      expect(store.getCheckBack(id).suspended_at).toBeNull();
      expect(store.getCheckBack(id).voided_at).not.toBeNull();
    }
    expect(store.listPendingCheckBacks(room.id).map((row) => row.id)).toEqual([newer]);
    store.close();
  });

  test("the app's own call-backs name why they wake someone", () => {
    const { store, director, room, plan } = fixture();
    const nudge = store.bookPlanNudge({ botId: director.id, sessionId: room.id, taskId: plan.id, ticketId: null, note: "还有没收口的任务" });
    expect(nudge.cause).toBe("supervisor");
    store.close();
  });
});

describe("a hold outlives the history it was said in", () => {
  test("clearing the conversation keeps the hold and forgets only the line", () => {
    const { store, director, room } = fixture();
    const said = store.postMessage(room.id, { body: "停下你所有的工作" });
    const hold = store.createHold({ scope: "bot", scopeId: director.id, source: "user_text", sourceMessageId: said.id });
    store.clearSessionMessages(room.id);
    expect(store.getHold(hold.id)).toMatchObject({ source_message_id: null, lifted_at: null });
    expect(store.holdsCovering({ botId: director.id }).map((row) => row.id)).toEqual([hold.id]);
    store.close();
  });

  test("clearing the conversation keeps the plans a hold names, lifted or not", () => {
    const { store, director, direct } = fixture();
    const held = store.openTask({ sessionId: direct.id, title: "回响纪元" });
    const onPlan = store.createHold({ scope: "plan", scopeId: held.id, source: "user_button" });
    const once = store.openTask({ sessionId: direct.id, title: "预告片" });
    store.liftHold(store.createHold({ scope: "bot_plan", scopeId: `${director.id}:${once.id}`, source: "user_button" }).id, { by: "user_button" });
    const handedOn = store.openTask({ sessionId: direct.id, title: "花絮" });
    const cut = store.createTicket({ taskId: handedOn.id, title: "剪辑", spec: "", status: "doing", worker: director.id });
    store.createHold({ scope: "bot", scopeId: director.id, targets: [{ scope: "ticket", id: cut.id }], source: "user_button" });
    const unnamed = store.openTask({ sessionId: direct.id, title: "草稿" });

    store.clearSessionMessages(direct.id);
    for (const task of [held, once, handedOn]) expect(store.getTask(task.id).id).toBe(task.id);
    expect(refusal(() => store.getTask(unnamed.id))?.status).toBe(404);
    expect(store.getHold(onPlan.id).lifted_at).toBeNull();
    store.close();
  });

  test("deleting a legacy conversation gives each plan its hold parks a hold of its own", () => {
    // The group's plans outlive the group: the Bot↔Bot direct worked on the one, talked about the other.
    const { store, room, plan, thread } = fixture({ legacySlot: true });
    const onRoom = store.createHold({ scope: "session", scopeId: room.id, source: "user_button" });
    const aside = store.openTask({ sessionId: room.id, title: "预告片", spec: spec({ goal: "预告片" }) });
    store.db.run(`UPDATE messages SET task_id = ? WHERE session_id = ?`, [aside.id, thread.id]);
    store.deleteSession(room.id);

    for (const [task, prior] of [
      [plan.id, "aside"],
      [aside.id, "active"],
    ] as const) {
      expect(store.getTask(task)).toMatchObject({ session_id: null, status: "parked" });
      const [own] = store.holdsCovering({ taskId: task });
      expect(own).toMatchObject({ scope: "plan", scope_id: task, source: "migration", lifted_at: null, effect: { parked_plans: [{ task_id: task, prior }] } });
      store.liftHold(own!.id, { by: "user_button" });
    }
    expect(store.getTask(aside.id).status).toBe("active");
    expect(parsePlanSpec(store.getTask(plan.id).spec)?.status).toBe("active");
    // The conversation's own hold stays, as every hold does until you lift it.
    expect(store.getHold(onRoom.id).lifted_at).toBeNull();
    store.close();
  });

  test("deleting the conversation gives a plan stopped the old way before its hold a hold of its own too", () => {
    const { store, room, plan } = fixture();
    // The organizer parked it before any hold: parked in its status and its spec, nothing to put back.
    store.setTaskSpec(plan.id, spec({ status: "parked" }));
    const onRoom = store.createHold({ scope: "session", scopeId: room.id, source: "user_button" });
    expect(store.getHold(onRoom.id).effect.parked_plans ?? []).toEqual([]);
    store.deleteSession(room.id);

    const [own] = store.holdsCovering({ taskId: plan.id });
    expect(own).toMatchObject({ scope: "plan", scope_id: plan.id, source: "migration", effect: { parked_plans: [{ task_id: plan.id, prior: "active" }] } });
    // Not taken over again at boot, and lifting it puts it back in progress, as the boot import would have.
    expect(store.reconcileHolds().imported).toEqual([]);
    store.liftHold(own!.id, { by: "user_button" });
    expect(store.getTask(plan.id).status).toBe("active");
    store.close();
  });

  test("clients hear of it as it is made and lifted", () => {
    const { store, plan } = fixture();
    const events: ClientEvent[] = [];
    store.onCommit((event) => events.push(event));
    const hold = store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
    const made = events.filter((event) => event.event === "hold.upsert");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ id: hold.id, effect: { parked_plans: [{ task_id: plan.id, prior: "active" }] } });
    // The plan it parked goes out too, parked and saying what holds it.
    const board = events.find((event) => event.event === "task.upsert");
    expect(board).toMatchObject({ id: plan.id, status: "parked" });
    events.length = 0;
    store.liftHold(hold.id, { by: "user_button" });
    expect(events.find((event) => event.event === "hold.upsert")).toMatchObject({ id: hold.id, lifted_by: "user_button" });
    store.close();
  });
});

describe("setting a plan's status by hand, the way it was done before holds", () => {
  test("parking it is a hold on it, and setting it back in progress lifts that", () => {
    const { store, plan } = fixture();
    store.setPlanSpecByUser(plan.id, spec({ status: "parked" }));
    const [hold] = store.listHolds({ inForce: true });
    expect(hold).toMatchObject({ scope: "plan", scope_id: plan.id, source: "user_button" });
    expect(store.getTask(plan.id).status).toBe("parked");
    // An edit that sends back the status it was shown is only an edit.
    store.setPlanSpecByUser(plan.id, spec({ status: "parked", goal: "EP01 动画成片，2 分钟" }));
    expect(store.listHolds({ inForce: true })).toHaveLength(1);
    store.setPlanSpecByUser(plan.id, spec({ status: "active" }));
    expect(store.listHolds({ inForce: true })).toEqual([]);
    expect(store.getHold(hold!.id).lifted_by).toBe("user_button");
    expect(store.getTask(plan.id)).toMatchObject({ status: "active", closed_at: null });
    store.close();
  });

  test("parking a legacy plan a newer one moved aside is a hold on it too", () => {
    const { store, room, plan } = fixture({ legacySlot: true });
    store.openTask({ sessionId: room.id, title: "预告片" });
    // What the board shows and sends back is the spec's status, in progress here.
    store.setPlanSpecByUser(plan.id, spec({ status: "parked" }));
    const [hold] = store.listHolds({ inForce: true });
    expect(hold).toMatchObject({ scope: "plan", scope_id: plan.id, effect: { parked_plans: [{ task_id: plan.id, prior: "aside" }] } });
    expect(parsePlanSpec(store.getTask(plan.id).spec)?.status).toBe("parked");
    // Setting it back in progress lifts it, and is then what it always was on a plan out of the slot.
    store.setPlanSpecByUser(plan.id, spec({ status: "active" }));
    expect(store.listHolds({ inForce: true })).toEqual([]);
    expect(store.getTask(plan.id).status).toBe("active");
    expect(store.sessionCurrentTask(room.id)?.id).not.toBe(plan.id);
    store.close();
  });

  test("a hold on its conversation still stands, and the plan says so", () => {
    const { store, plan, room } = fixture();
    store.setPlanSpecByUser(plan.id, spec({ status: "parked" }));
    const onRoom = store.createHold({ scope: "session", scopeId: room.id, source: "user_button" });
    const { task } = store.setPlanSpecByUser(plan.id, spec({ status: "active" }));
    expect(task.status).toBe("parked");
    expect(store.taskDetail(plan.id, () => true).held_by?.map((row) => row.id)).toEqual([onRoom.id]);
    store.close();
  });

  test("accepting it as done lifts the hold on it, and so does reopening a plan you had accepted", () => {
    const { store, plan } = fixture();
    store.setPlanSpecByUser(plan.id, spec({ status: "parked" }));
    store.setPlanSpecByUser(plan.id, spec({ status: "done" }));
    expect(store.listHolds({ inForce: true })).toEqual([]);
    expect(store.getTask(plan.id).status).toBe("done");
    // Parking a finished plan and lifting that puts back done, not in progress.
    store.setPlanSpecByUser(plan.id, spec({ status: "parked" }));
    const [hold] = store.listHolds({ inForce: true });
    store.liftHold(hold!.id, { by: "user_button" });
    expect(store.getTask(plan.id).status).toBe("done");
    store.close();
  });

  test("before holds are on, parking is only the status", () => {
    const { store, plan } = fixture({ holdsOn: false });
    store.setPlanSpecByUser(plan.id, spec({ status: "parked" }));
    expect(store.getTask(plan.id).status).toBe("parked");
    expect(store.getTask(plan.id).closed_at).not.toBeNull();
    expect(store.listHolds()).toEqual([]);
    store.setPlanSpecByUser(plan.id, spec({ status: "active" }));
    expect(store.getTask(plan.id)).toMatchObject({ status: "active", closed_at: null });
    store.close();
  });
});

describe("at boot", () => {
  test("a plan stopped before holds existed becomes a hold; one only moved aside for another does not", () => {
    const { store, room, plan } = fixture({ holdsOn: false });
    // Stopped the old way: the organizer (or you) wrote parked into the plan.
    store.setTaskSpec(plan.id, spec({ status: "parked" }));
    // Moved aside: a newer plan took the slot, and its spec still says in progress.
    const aside = store.openTask({ sessionId: room.id, title: "预告片", spec: spec({ goal: "预告片" }) });
    store.openTask({ sessionId: room.id, title: "花絮" });
    expect(store.getTask(aside.id).status).toBe("parked");
    expect(store.reconcileHolds()).toEqual({ imported: [], reparked: [] });

    store.raiseEngineLevel(null);
    const first = store.reconcileHolds();
    expect(first.imported).toEqual([plan.id]);
    const [hold] = store.listHolds({ inForce: true });
    expect(hold).toMatchObject({ scope: "plan", scope_id: plan.id, source: "legacy", effect: { parked_plans: [{ task_id: plan.id, prior: "active" }] } });
    // Only you put it back from here: a resume leaves it parked, lifting it does not.
    store.setTaskSpec(plan.id, spec({ status: "active" }));
    expect(store.getTask(plan.id).status).toBe("parked");
    expect(store.reconcileHolds()).toEqual({ imported: [], reparked: [] });
    store.liftHold(hold!.id, { by: "user_button" });
    expect(store.getTask(plan.id).status).toBe("active");
    expect(store.getTask(aside.id).status).toBe("parked");
    store.close();
  });

  test("a plan stopped the old way is taken over while another conversation is held", () => {
    const { store, room, direct } = fixture({ holdsOn: false });
    const stopped = store.openTask({ sessionId: direct.id, title: "回响纪元", spec: spec({ goal: "回响纪元", status: "parked" }) });
    store.raiseEngineLevel(null);
    store.createHold({ scope: "session", scopeId: room.id, source: "user_button" });
    expect(store.reconcileHolds().imported).toEqual([stopped.id]);
    store.close();
  });

  test("whatever a hold covers is held again, in case a write got past it", () => {
    const { store, plan, director, thread, turn } = fixture();
    const hold = store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
    const booked = store.scheduleCheckBack({ botId: director.id, sessionId: thread.id, turnId: turn.id, note: "看母带", afterMinutes: 5 });
    store.db.run(`UPDATE tasks SET status = 'active' WHERE id = ?`, [plan.id]);
    store.db.run(`UPDATE check_backs SET suspended_at = NULL, voided_at = NULL WHERE id = ?`, [booked.row.id]);
    expect(store.reconcileHolds()).toEqual({ imported: [], reparked: [plan.id] });
    expect(store.getTask(plan.id).status).toBe("parked");
    expect(store.getCheckBack(booked.row.id).suspended_at).not.toBeNull();
    store.liftHold(hold.id, { by: "user_button" });
    expect(store.getTask(plan.id).status).toBe("active");
    expect(store.getCheckBack(booked.row.id).voided_at).toBeNull();
    store.close();
  });
});
