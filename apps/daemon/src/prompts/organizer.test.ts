import { describe, expect, test } from "bun:test";
import { Store, type PlanSpec } from "../store";
import {
  ORGANIZER_BODY_LIMIT,
  ORGANIZER_TICKETS_LIMIT,
  ORGANIZER_TRACE_LIMIT,
  organizerPayload,
  parseOrganizerResult,
} from "./organizer";

function spec(over: Partial<PlanSpec> = {}): PlanSpec {
  return {
    kind: "周报",
    goal: "写一份周报",
    acceptance: ["交到 report.md"],
    rules: ["不要口语"],
    process: ["Writer 写，Reviewer 审"],
    progress: { done: [], open: ["初稿"], blocked: [] },
    status: "active",
    ...over,
  };
}

function fixture() {
  const store = new Store();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
  const group = store.createGroup({ name: "周报组", members: [writer.bot.id, reviewer.bot.id] });
  return { store, writer: writer.bot, reviewer: reviewer.bot, group };
}

describe("what the organizer reads", () => {
  test("a message run: the line, the current plan with its tickets, what happened since the last version, the session's earlier plans, kinds, and precedents", async () => {
    const { store, writer, reviewer, group } = fixture();
    // An earlier plan of this session that saw a turn, and a finished one of the same kind elsewhere.
    const earlier = store.openTask({ sessionId: group.id, title: "订会议室", spec: spec({ kind: "会议室", goal: "订会议室" }) });
    const booking = store.postMessage(group.id, { body: "订会议室" });
    store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: booking.id });
    const done = store.openTask({
      sessionId: store.createBot({ name: "Other", duties: "x", boundaries: "y" }).direct_session.id,
      title: "上周的周报",
      spec: spec({ goal: "写上周的周报", status: "done", progress: { done: ["交了 report.md"], open: [], blocked: [] } }),
    });
    expect(done.status).toBe("done");
    const routine = store.createRoutine({ bot_id: writer.id, title: "日报", instruction: "每天汇总", schedule: { kind: "daily", time: "09:00" } });
    store.openTask({ sessionId: group.id, title: "日报", kind: "日报", routineId: routine.id });
    await Bun.sleep(15);

    const plan = store.openTask({ sessionId: group.id, title: "写周报", brief: "写一份周报，交到 report.md", spec: spec() });
    expect(store.getTask(earlier.id).status).toBe("parked");
    const ticket = store.createTicket({ taskId: plan.id, title: "初稿", spec: "第".repeat(400), status: "doing", worker: writer.id });
    store.recordSpecRevision({ taskId: plan.id, spec: spec(), actor: "app" });
    await Bun.sleep(20);
    // Since then: a Bot delivered a file under the ticket, and the user spoke again.
    const opener = store.postMessage(group.id, { body: "写一份周报，交到 report.md" });
    const turn = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: opener.id, taskId: plan.id, ticketId: ticket.id });
    store.insertMessage({ sessionId: group.id, turnId: turn.id, kind: "bot", author: writer.id, body: "初稿在 draft.md", paths: [`${ticket.dir}/draft.md`, `${ticket.dir}/tool-results/x.json`] });
    const message = store.postMessage(group.id, { body: `${"改".repeat(ORGANIZER_BODY_LIMIT * 2)}再改一版` });

    const payload = organizerPayload(store, { mode: "message", sessionId: group.id, message, current: store.getTask(plan.id), trace: Array.from({ length: ORGANIZER_TRACE_LIMIT + 3 }, (_, i) => `step ${i}`) });
    expect(payload.mode).toBe("message");
    // Members who joined in the same millisecond come back in no fixed order.
    expect({ ...payload.session, members: [...payload.session.members].sort() }).toEqual({ id: group.id, kind: "group", name: "周报组", members: ["Reviewer", "Writer"] });
    expect(payload.message).toMatchObject({ id: message.id, author: "user", attachments: [], truncated: true });
    expect([...payload.message!.body]).toHaveLength(ORGANIZER_BODY_LIMIT * 2);
    expect(payload.current_plan).toMatchObject({ id: plan.id, kind: "周报", status: "active", brief: "写一份周报，交到 report.md", revision: 1, spec: spec() });
    expect(payload.current_plan!.tickets).toMatchObject([{ id: ticket.id, seq: 1, title: "初稿", status: "doing", worker: "Writer", artifacts: 1 }]);
    expect([...payload.current_plan!.tickets[0]!.spec].length).toBeLessThan(400);
    expect(payload.since_last_revision.messages.map((row) => [row.author, row.kind])).toEqual([
      ["user", "user"],
      ["Writer", "bot"],
      ["user", "user"],
    ]);
    expect(payload.since_last_revision.messages[1]).toMatchObject({ ticket_id: ticket.id, body: "初稿在 draft.md" });
    expect(payload.since_last_revision.artifacts).toMatchObject([{ path: `${ticket.dir}/draft.md`, by: "Writer", ticket_id: ticket.id }]);
    expect(payload.since_last_revision.trace).toHaveLength(ORGANIZER_TRACE_LIMIT);
    expect(payload.since_last_revision.trace[0]).toBe("step 3");
    // The session's earlier plans, without the current one and without the routine's standing plan.
    expect(payload.recent_plans.map((row) => [row.id, row.goal, row.status])).toEqual([[earlier.id, "订会议室", "parked"]]);
    expect(payload.kinds.sort()).toEqual(["会议室", "周报", "日报"]);
    expect(payload.precedents).toEqual([{ goal: "写上周的周报", process: ["Writer 写，Reviewer 审"], rules: ["不要口语"], outcome: ["交了 report.md"] }]);
    void reviewer;
    store.close();
  });

  test("a settle run has no line; a session without a plan has nothing to continue", () => {
    const { store, group } = fixture();
    const empty = organizerPayload(store, { mode: "message", sessionId: group.id, message: store.postMessage(group.id, { body: "你好" }), current: null });
    expect(empty.current_plan).toBeNull();
    expect(empty.since_last_revision).toEqual({ messages: [], artifacts: [], trace: [] });
    expect(empty.recent_plans).toEqual([]);
    const plan = store.openTask({ sessionId: group.id, title: "写周报", spec: spec() });
    const settle = organizerPayload(store, { mode: "settle", sessionId: group.id, message: null, current: plan });
    expect(settle.mode).toBe("settle");
    expect(settle.message).toBeNull();
    expect(settle.current_plan?.id).toBe(plan.id);
    store.close();
  });
});

describe("what the organizer answered", () => {
  const roster = [
    { id: "01ARZ3NDEKTSV4RRFFQ69G5FA1", name: "Writer" },
    { id: "01ARZ3NDEKTSV4RRFFQ69G5FA2", name: "Reviewer" },
  ];
  const recent = new Set(["01ARZ3NDEKTSV4RRFFQ69G5FB1"]);
  const ctx = { mode: "message" as const, recentPlanIds: recent, roster };

  test("is read out of a fence, needs a plan with a goal, and never throws", () => {
    expect(parseOrganizerResult("nope", ctx)).toBeNull();
    expect(parseOrganizerResult('{"decision":"new"}', ctx)).toBeNull();
    expect(parseOrganizerResult('{"decision":"new","plan":{"kind":"x"}}', ctx)).toBeNull();
    const parsed = parseOrganizerResult('好的：\n```json\n{"decision":"new","plan":{"goal":"写一份周报","status":"active"},"tickets":[],"message_ticket":null}\n```', ctx);
    expect(parsed).toMatchObject({ decision: "new", resumePlanId: null, tickets: [], messageTicket: null });
    expect(parsed!.spec.goal).toBe("写一份周报");
  });

  test("resume needs a plan this session had; settle is always continue and names no ticket", () => {
    const plan = { goal: "写一份周报" };
    expect(parseOrganizerResult(JSON.stringify({ decision: "resume", resume_plan_id: "01ARZ3NDEKTSV4RRFFQ69G5FB1", plan }), ctx)).toMatchObject({ decision: "resume", resumePlanId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" });
    expect(parseOrganizerResult(JSON.stringify({ decision: "resume", resume_plan_id: "01ARZ3NDEKTSV4RRFFQ69G5FB9", plan }), ctx)).toMatchObject({ decision: "continue", resumePlanId: null });
    expect(parseOrganizerResult(JSON.stringify({ decision: "Later", plan }), ctx)).toMatchObject({ decision: "continue" });
    const settled = parseOrganizerResult(JSON.stringify({ decision: "new", plan, message_ticket: "new-1" }), { ...ctx, mode: "settle" });
    expect(settled).toMatchObject({ decision: "continue", messageTicket: null });
  });

  test("tickets keep only a real id or a new-N, a title, a known status, and a worker from the roster", () => {
    const parsed = parseOrganizerResult(
      JSON.stringify({
        decision: "continue",
        plan: { goal: "写一份周报" },
        tickets: [
          { id: "01ARZ3NDEKTSV4RRFFQ69G5FC1", title: "初稿", spec: " 第一版 ", status: "review", worker: "writer" },
          { id: "new-1", title: "  配图  ", status: "later", worker: "Nobody" },
          { id: "ticket-3", title: "无效 id" },
          { id: "new-2", title: "" },
          "not an object",
          { id: "new-3", title: "没有状态" },
        ],
        message_ticket: "new-1",
      }),
      ctx,
    );
    expect(parsed!.tickets).toEqual([
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FC1", title: "初稿", spec: "第一版", status: "review", worker: "01ARZ3NDEKTSV4RRFFQ69G5FA1" },
      { id: "new-1", title: "配图", spec: "", status: "todo", worker: null },
      { id: "new-3", title: "没有状态", spec: "", status: "todo", worker: null },
    ]);
    expect(parsed!.messageTicket).toBe("new-1");
    expect(parseOrganizerResult(JSON.stringify({ plan: { goal: "x" }, message_ticket: "ticket-3" }), ctx)!.messageTicket).toBeNull();
    const many = Array.from({ length: ORGANIZER_TICKETS_LIMIT + 5 }, (_, i) => ({ id: `new-${i + 1}`, title: `任务 ${i + 1}` }));
    expect(parseOrganizerResult(JSON.stringify({ plan: { goal: "x" }, tickets: many }), ctx)!.tickets).toHaveLength(ORGANIZER_TICKETS_LIMIT);
  });
});
