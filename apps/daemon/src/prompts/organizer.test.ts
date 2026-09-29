import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKS_MAX, Store, type PlanSpec } from "../store";
import {
  ORGANIZER_BODY_LIMIT,
  ORGANIZER_TICKETS_LIMIT,
  ORGANIZER_TRACE_LIMIT,
  organizerPayload,
  parseOrganizerChecks,
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
    const root = mkdtempSync(join(tmpdir(), "organizer-payload-"));
    store.patchSettingsSync({ workspace_path: root });
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
    store.recordTurnRun({ turnId: turn.id, tool: "shell", command: "bun   test\n", exitCode: 1, ok: true, cwd: ticket.dir });
    store.recordTurnRun({ turnId: turn.id, tool: "shell", command: "sleep 999", exitCode: null, ok: false, error: "command timed out after 600s and was killed" });
    // A check the app ran itself, ahead of what a Bot says: the payload carries its result too.
    const check = store.createCheckByUser(plan.id, { item: "交到 report.md", ticket_id: ticket.id, kind: "command", command: "true" });
    const run = store.beginCheckRun(check.id, "user");
    store.finishCheckRun(run.id, { outcome: "fail", exitCode: 1, detail: "退出码 1，应为 0", output: "boom" });
    const message = store.postMessage(group.id, { body: `${"改".repeat(ORGANIZER_BODY_LIMIT * 2)}再改一版` });

    const payload = organizerPayload(store, { mode: "message", sessionId: group.id, message, current: store.getTask(plan.id), trace: Array.from({ length: ORGANIZER_TRACE_LIMIT + 3 }, (_, i) => `step ${i}`) });
    expect(payload.mode).toBe("message");
    // Members who joined in the same millisecond come back in no fixed order.
    expect({ ...payload.session, members: [...payload.session.members].sort() }).toEqual({ id: group.id, kind: "group", name: "周报组", members: ["Reviewer", "Writer"] });
    expect(payload.message).toMatchObject({ id: message.id, author: "user", attachments: [], truncated: true });
    expect([...payload.message!.body]).toHaveLength(ORGANIZER_BODY_LIMIT * 2);
    expect(payload.current_plan).toMatchObject({ id: plan.id, kind: "周报", status: "active", brief: "写一份周报，交到 report.md", revision: 1, spec: spec() });
    expect(payload.current_plan!.tickets).toMatchObject([{ id: ticket.id, seq: 1, title: "初稿", status: "doing", worker: "Writer", artifacts: 1, files: [`${ticket.dir}/draft.md`] }]);
    // What was run, not what was said: the organizer can hold "tests pass" against an exit code —
    // and where it actually ran, so a proposed command check can copy the same cwd.
    expect(payload.since_last_revision.commands).toEqual([
      { by: "Writer", ticket: 1, command: "bun test", cwd: ticket.dir, exit_code: 1, ok: true },
      { by: "Writer", ticket: 1, command: "sleep 999", cwd: null, exit_code: null, ok: false, error: "command timed out after 600s and was killed" },
    ]);
    // The plan's own checks — the app's evidence, ahead of a Bot's own say-so.
    expect(payload.current_plan!.checks).toEqual([
      {
        id: check.id,
        item: "交到 report.md",
        kind: "command",
        what: "命令：true",
        source: "user",
        ticket: 1,
        last: { outcome: "fail", detail: "退出码 1，应为 0", at: expect.any(String), output: "boom" },
      },
    ]);
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
    rmSync(root, { recursive: true, force: true });
  });

  test("a settle run has no line; a session without a plan has nothing to continue", () => {
    const { store, group } = fixture();
    const empty = organizerPayload(store, { mode: "message", sessionId: group.id, message: store.postMessage(group.id, { body: "你好" }), current: null });
    expect(empty.current_plan).toBeNull();
    expect(empty.since_last_revision).toEqual({ messages: [], artifacts: [], trace: [], commands: [] });
    expect(empty.recent_plans).toEqual([]);
    expect(empty.elsewhere_plans).toEqual([]);
    const plan = store.openTask({ sessionId: group.id, title: "写周报", spec: spec() });
    const settle = organizerPayload(store, { mode: "settle", sessionId: group.id, message: null, current: plan });
    expect(settle.mode).toBe("settle");
    expect(settle.message).toBeNull();
    expect(settle.current_plan?.id).toBe(plan.id);
    expect(settle.elsewhere_plans).toEqual([]);
    store.close();
  });

  test("a line in your direct with a Bot sees the job that Bot is on in a group, whole, and only there", () => {
    const { store, writer, reviewer, group } = fixture();
    const plan = store.openTask({ sessionId: group.id, title: "写周报", brief: "写一份周报，交到 report.md", spec: spec() });
    const draft = store.createTicket({ taskId: plan.id, title: "初稿", status: "doing", worker: writer.id });
    store.createTicket({ taskId: plan.id, title: "审稿", status: "todo", worker: reviewer.id });
    const go = store.postMessage(group.id, { body: "写周报" });
    store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: go.id, taskId: plan.id, ticketId: draft.id });
    const direct = store.findDirectSession("user", writer.id)!;
    // Something already said here about that job: it is what a follow-up continues.
    const earlier = store.postMessage(direct.id, { body: "周报标题别太长" });
    store.db.run(`UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?`, [plan.id, draft.id, earlier.id]);
    const line = store.postMessage(direct.id, { body: "还有，别用表格" });

    const payload = organizerPayload(store, { mode: "message", sessionId: direct.id, message: line, current: store.sessionCurrentTask(direct.id) });
    expect(payload.current_plan).toBeNull();
    expect(payload.elsewhere_plans).toEqual([
      {
        id: plan.id,
        title: "写周报",
        home: "群「周报组」",
        working: ["Writer（群「周报组」）"],
        status: "active",
        brief: "写一份周报，交到 report.md",
        spec: spec(),
        tickets: [
          { id: draft.id, seq: 1, title: "初稿", status: "doing", worker: "Writer" },
          { id: expect.any(String), seq: 2, title: "审稿", status: "todo", worker: "Reviewer" },
        ],
        said_here: [{ author: "user", body: "周报标题别太长" }],
      },
    ]);
    // The stamped line made it one of this session's plans too; it is shown once, where join can take it.
    expect(payload.recent_plans.map((row) => row.id)).not.toContain(plan.id);
    store.close();
  });
});

describe("what the organizer answered", () => {
  const roster = [
    { id: "01ARZ3NDEKTSV4RRFFQ69G5FA1", name: "Writer" },
    { id: "01ARZ3NDEKTSV4RRFFQ69G5FA2", name: "Reviewer" },
  ];
  const recent = new Set(["01ARZ3NDEKTSV4RRFFQ69G5FB1"]);
  const elsewhere = new Set(["01ARZ3NDEKTSV4RRFFQ69G5FE1"]);
  const ctx = { mode: "message" as const, recentPlanIds: recent, elsewherePlanIds: elsewhere, roster };

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

  test("join needs a plan the Bots here are on elsewhere, and only a message run joins", () => {
    const plan = { goal: "写一份周报" };
    expect(parseOrganizerResult(JSON.stringify({ decision: "join", join_plan_id: "01ARZ3NDEKTSV4RRFFQ69G5FE1", plan, message_ticket: "01ARZ3NDEKTSV4RRFFQ69G5FC1" }), ctx)).toMatchObject({
      decision: "join",
      joinPlanId: "01ARZ3NDEKTSV4RRFFQ69G5FE1",
      resumePlanId: null,
      messageTicket: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
    });
    // A plan of this session's past is not a job elsewhere, and an unknown id is no plan at all.
    expect(parseOrganizerResult(JSON.stringify({ decision: "join", join_plan_id: "01ARZ3NDEKTSV4RRFFQ69G5FB1", plan }), ctx)).toMatchObject({ decision: "continue", joinPlanId: null });
    expect(parseOrganizerResult(JSON.stringify({ decision: "join", plan }), ctx)).toMatchObject({ decision: "continue", joinPlanId: null });
    expect(parseOrganizerResult(JSON.stringify({ decision: "join", join_plan_id: "01ARZ3NDEKTSV4RRFFQ69G5FE1", plan }), { ...ctx, mode: "settle" })).toMatchObject({ decision: "continue", joinPlanId: null });
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

  test("an existing ticket named by id with only what changed keeps the rest: no title, status or worker means as it was", () => {
    const parsed = parseOrganizerResult(
      JSON.stringify({
        plan: { goal: "写一份周报", status: "done" },
        tickets: [
          { id: "01ARZ3NDEKTSV4RRFFQ69G5FC1", status: "done" },
          { id: "01ARZ3NDEKTSV4RRFFQ69G5FC2", worker: "Reviewer" },
          { id: "01ARZ3NDEKTSV4RRFFQ69G5FC3", title: "终稿", status: "someday", worker: null },
          { id: "new-1", status: "doing" },
        ],
      }),
      { ...ctx, mode: "settle" },
    );
    expect(parsed!.tickets).toEqual([
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FC1", spec: "", status: "done" },
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FC2", spec: "", worker: "01ARZ3NDEKTSV4RRFFQ69G5FA2" },
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FC3", spec: "", title: "终稿" },
    ]);
    for (const ticket of parsed!.tickets) {
      expect("status" in ticket && ticket.status === undefined).toBe(false);
      expect("worker" in ticket && ticket.worker === undefined).toBe(false);
    }
  });
});

describe("parseOrganizerChecks", () => {
  const existing = new Set(["01ARZ3NDEKTSV4RRFFQ69G5FD1"]);

  test("drops anything that is not an object, and an id that is neither a known check nor new-N", () => {
    expect(parseOrganizerChecks(null, existing)).toEqual([]);
    expect(parseOrganizerChecks("nope", existing)).toEqual([]);
    expect(parseOrganizerChecks([42, "x", null, ["nested"]], existing)).toEqual([]);
    expect(parseOrganizerChecks([{ id: "01ARZ3NDEKTSV4RRFFQ69G5FD9", item: "别的" }], existing)).toEqual([]);
    expect(parseOrganizerChecks([{ id: "not-an-id", item: "别的" }], existing)).toEqual([]);
    expect(parseOrganizerChecks([{ item: "没写 id" }], existing)).toEqual([]);
  });

  test("a new-N proposal keeps only well-typed fields; a bad kind or a wrong-typed field is left out, not the whole entry", () => {
    const parsed = parseOrganizerChecks(
      [
        {
          id: "new-1",
          item: "  交到 report.md  ",
          kind: "command",
          command: "bun test",
          cwd: "work/写周报-ab12",
          ticket: "01ARZ3NDEKTSV4RRFFQ69G5FT1",
          expect_exit: 0,
          timeout_sec: 30,
        },
        { id: "new-2", item: "坏 kind", kind: "verify", path: 42, negate: "yes", expect_exit: "0" },
      ],
      existing,
    );
    expect(parsed).toEqual([
      {
        id: "new-1",
        item: "交到 report.md",
        kind: "command",
        command: "bun test",
        cwd: "work/写周报-ab12",
        ticket: "01ARZ3NDEKTSV4RRFFQ69G5FT1",
        expect_exit: 0,
        timeout_sec: 30,
      },
      { id: "new-2", item: "坏 kind" },
    ]);
  });

  test("kind continuity parses through like any other kind", () => {
    expect(
      parseOrganizerChecks(
        [{ id: "new-1", item: "镜头连贯", kind: "continuity", path: "renders/ep01_MASTER.mp4", command: "grep -o 'shots/.*.mp4' stitch.py" }],
        existing,
      ),
    ).toEqual([{ id: "new-1", item: "镜头连贯", kind: "continuity", path: "renders/ep01_MASTER.mp4", command: "grep -o 'shots/.*.mp4' stitch.py" }]);
  });

  test("remove only on an existing check the payload showed; a new-N cannot be removed, and other fields on a remove are ignored", () => {
    expect(parseOrganizerChecks([{ id: "01ARZ3NDEKTSV4RRFFQ69G5FD1", remove: true, item: "ignored" }], existing)).toEqual([
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FD1", remove: true },
    ]);
    expect(parseOrganizerChecks([{ id: "new-1", remove: true }], existing)).toEqual([]);
    // remove must be exactly true
    expect(parseOrganizerChecks([{ id: "01ARZ3NDEKTSV4RRFFQ69G5FD1", remove: "yes", item: "改一下" }], existing)).toEqual([
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FD1", item: "改一下" },
    ]);
  });

  test("ticket is null, a string, or left out — each means something different and is kept apart", () => {
    expect(parseOrganizerChecks([{ id: "01ARZ3NDEKTSV4RRFFQ69G5FD1", ticket: null }], existing)).toEqual([{ id: "01ARZ3NDEKTSV4RRFFQ69G5FD1", ticket: null }]);
    expect(parseOrganizerChecks([{ id: "01ARZ3NDEKTSV4RRFFQ69G5FD1", ticket: "new-2" }], existing)).toEqual([
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FD1", ticket: "new-2" },
    ]);
    expect(parseOrganizerChecks([{ id: "01ARZ3NDEKTSV4RRFFQ69G5FD1" }], existing)).toEqual([{ id: "01ARZ3NDEKTSV4RRFFQ69G5FD1" }]);
  });

  test("caps the list at CHECKS_MAX entries", () => {
    const many = Array.from({ length: CHECKS_MAX + 5 }, (_, i) => ({ id: `new-${i + 1}`, item: `检查 ${i + 1}` }));
    expect(parseOrganizerChecks(many, existing)).toHaveLength(CHECKS_MAX);
  });
});
