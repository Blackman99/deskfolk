import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoNow } from "../ids";
import { CHECKS_MAX, Store, type OrganizerResult, type PlanSpec } from "../store";
import {
  holdSettle,
  ORGANIZER_BODY_LIMIT,
  ORGANIZER_MESSAGES_LIMIT,
  ORGANIZER_TICKETS_LIMIT,
  ORGANIZER_TRACE_LIMIT,
  ORGANIZER_USER_LINE_MAX,
  ORGANIZER_USER_LINES,
  ORGANIZER_USER_LINES_BUDGET,
  ORGANIZER_USER_LINES_EARLIEST,
  ORGANIZER_USER_LINES_SCAN,
  organizerPayload,
  parseOrganizerChecks,
  parseOrganizerResult,
  ticketSpecPreview,
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
    expect(empty.since_last_revision).toEqual({ messages: [], user_spoke: true, artifacts: [], trace: [], commands: [] });
    expect(empty.recent_plans).toEqual([]);
    expect(empty.elsewhere_plans).toEqual([]);
    const plan = store.openTask({ sessionId: group.id, title: "写周报", spec: spec() });
    const settle = organizerPayload(store, { mode: "settle", sessionId: group.id, message: null, current: plan });
    expect(settle.mode).toBe("settle");
    expect(settle.message).toBeNull();
    expect(settle.current_plan?.id).toBe(plan.id);
    expect(settle.elsewhere_plans).toEqual([]);
    // A settle is told what the app read before the call: whether you said anything since.
    expect(settle.since_last_revision.user_spoke).toBe(false);
    expect(organizerPayload(store, { mode: "settle", sessionId: group.id, message: null, current: plan, userSpoke: true }).since_last_revision.user_spoke).toBe(true);
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

  test("every line since the last version says whether you, a Bot or the app said it, and a question's answer comes apart from it, as yours", () => {
    const { store, writer, group } = fixture();
    const plan = store.openTask({ sessionId: group.id, title: "写周报", spec: spec() });
    const opener = store.postMessage(group.id, { body: "写一份周报" });
    const turn = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: opener.id, taskId: plan.id });
    store.recordSpecRevision({ taskId: plan.id, spec: spec(), actor: "app" });
    store.postMessage(group.id, { body: "标题别太长" });
    store.insertMessage({ sessionId: group.id, turnId: turn.id, kind: "bot", author: writer.id, body: "配图先冻结，不再重试" });
    store.insertMessage({ sessionId: group.id, turnId: turn.id, kind: "system", author: writer.id, body: "这一轮被中断了" });
    const ask = store.insertMessage({
      sessionId: group.id,
      turnId: turn.id,
      kind: "ask",
      author: writer.id,
      body: "发给谁？",
      ask: { options: [{ label: "团队" }, { label: "老板" }], multi_select: false },
    });
    store.recordAskAnswer(ask.id, { selected: ["老板"], custom: "抄送财务", answered_at: isoNow() });

    const payload = organizerPayload(store, { mode: "message", sessionId: group.id, message: null, current: store.getTask(plan.id) });
    const messages = payload.since_last_revision.messages;
    expect(messages.map((row) => [row.author, row.kind, row.from])).toEqual([
      ["user", "user", "user"],
      ["Writer", "bot", "bot"],
      ["Writer", "system", "app"],
      ["Writer", "ask", "bot"],
    ]);
    // The question is the Bot's, with its choices; what you picked and wrote is yours.
    expect(messages[3]).toMatchObject({ id: ask.id, body: "发给谁？ 选项（单选）：团队 / 老板", answer: "用户选了：老板 用户补充：抄送财务" });
    expect(messages.slice(0, 3).some((row) => "answer" in row)).toBe(false);
    expect(payload.since_last_revision.user_spoke).toBe(true);
    store.close();
  });

  test("the organizer reads every line of yours about the plan, not only those since the last version: filed under it, said in its session while it was open, and your answers, dated when you answered", () => {
    const { store, writer, group } = fixture();
    const direct = store.findDirectSession("user", writer.id)!;
    const other = store.openTask({ sessionId: direct.id, title: "订会议室" });
    const plan = store.openTask({ sessionId: group.id, title: "写周报", spec: spec() });
    const opener = store.postMessage(group.id, { body: "写一份周报" });
    const turn = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: opener.id, taskId: plan.id });
    const ask = store.insertMessage({
      sessionId: group.id,
      turnId: turn.id,
      kind: "ask",
      author: writer.id,
      body: "发给谁？",
      ask: { options: [{ label: "团队" }, { label: "老板" }], multi_select: false },
    });
    const cost = store.postMessage(group.id, { body: "不用考虑金额问题，尽可能做好就行" });
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [plan.id, cost.id]);
    // A filing that failed leaves the line unstamped; a line filed under another plan is that plan's.
    store.postMessage(group.id, { body: "标题别太长" });
    const elsewhere = store.postMessage(group.id, { body: "会议室订三楼" });
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [other.id, elsewhere.id]);
    const answeredAt = isoNow();
    store.recordAskAnswer(ask.id, { selected: ["老板"], custom: null, answered_at: answeredAt });
    store.recordSpecRevision({ taskId: plan.id, spec: spec(), actor: "app" });
    // Since that version: more Bot lines than the window holds, a line of yours, and one filed elsewhere.
    for (let i = 0; i < ORGANIZER_MESSAGES_LIMIT + 5; i += 1) {
      store.insertMessage({ sessionId: group.id, turnId: turn.id, kind: "bot", author: writer.id, body: `初稿进展 ${i}` });
    }
    const aside = store.postMessage(group.id, { body: "会议室改到周五" });
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [other.id, aside.id]);
    const latest = store.postMessage(group.id, { body: "继续推进" });

    const payload = organizerPayload(store, { mode: "message", sessionId: group.id, message: latest, current: store.getTask(plan.id) });
    expect(payload.current_plan!.user_lines).toEqual([
      { via: "message", at: expect.any(String), text: "写一份周报" },
      { via: "message", at: expect.any(String), text: "不用考虑金额问题，尽可能做好就行" },
      { via: "message", at: expect.any(String), text: "标题别太长" },
      { via: "answer", at: answeredAt, text: "用户选了：老板", asked: "发给谁？" },
    ]);
    expect(payload.current_plan!.user_lines_omitted).toBe(0);
    // Each line is shown once: the one since the last version is among the messages, not repeated.
    const since = payload.since_last_revision.messages;
    expect(since.at(-1)).toMatchObject({ id: latest.id, from: "user" });
    expect(since.map((row) => row.id)).not.toContain(aside.id);
    expect(store.taskMessagesSince(plan.id, "", 100).map((row) => row.id)).not.toContain(elsewhere.id);
    store.close();
  });

  test("your lines stay bounded: a line said again counts once, where it was said last; a long one is clipped; past the caps the first few and the newest are kept and the rest counted", () => {
    const { store, reviewer, group } = fixture();
    let clock = Date.parse("2020-01-01T00:00:00.000Z");
    const say = (sessionId: string, planId: string, body: string) => {
      const row = store.postMessage(sessionId, { body });
      clock += 1000;
      store.db.run(`UPDATE messages SET task_id = ?, created_at = ? WHERE id = ?`, [planId, new Date(clock).toISOString(), row.id]);
    };
    const plan = store.openTask({ sessionId: group.id, title: "写周报", spec: spec() });
    const line = (i: number) => `${i} `.padEnd(250, "句");
    for (let i = 0; i < 100; i += 1) {
      say(group.id, plan.id, i === 99 ? "长".repeat(400) : line(i));
      if (i % 20 === 19) say(group.id, plan.id, "继续");
    }
    store.recordSpecRevision({ taskId: plan.id, spec: spec(), actor: "app" });

    const { user_lines: lines, user_lines_omitted: omitted } = organizerPayload(store, {
      mode: "settle",
      sessionId: group.id,
      message: null,
      current: store.getTask(plan.id),
    }).current_plan!;
    expect(lines.length).toBeLessThanOrEqual(ORGANIZER_USER_LINES);
    const cost = lines.reduce((sum, row) => sum + [...row.text].length + [...(row.asked ?? "")].length, 0);
    expect(cost).toBeLessThanOrEqual(ORGANIZER_USER_LINES_BUDGET);
    for (const row of lines) expect([...row.text].length).toBeLessThanOrEqual(ORGANIZER_USER_LINE_MAX);
    // The job's opening terms, then the newest; 继续 once, where it was said last.
    expect(lines.slice(0, ORGANIZER_USER_LINES_EARLIEST).map((row) => row.text)).toEqual([0, 1, 2, 3].map(line));
    expect(lines.filter((row) => row.text === "继续")).toHaveLength(1);
    expect(lines.at(-1)).toEqual({ via: "message", at: expect.any(String), text: "继续" });
    expect(lines.at(-2)).toEqual({ via: "message", at: expect.any(String), text: "长".repeat(ORGANIZER_USER_LINE_MAX), truncated: true });
    expect(lines.filter((row) => row.truncated)).toHaveLength(1);
    // Every distinct line is either shown or counted.
    expect(lines.length + omitted).toBe(101);

    // Many short lines hit the line cap, and lines past the scan are counted without being read.
    const direct = store.findDirectSession("user", reviewer.id)!;
    const naming = store.openTask({ sessionId: direct.id, title: "起名" });
    const count = ORGANIZER_USER_LINES_EARLIEST + ORGANIZER_USER_LINES_SCAN + 26;
    for (let i = 0; i < count; i += 1) say(direct.id, naming.id, `名字 ${i}`);
    const counted = organizerPayload(store, { mode: "settle", sessionId: direct.id, message: null, current: store.getTask(naming.id) }).current_plan!;
    expect(counted.user_lines).toHaveLength(ORGANIZER_USER_LINES);
    expect(counted.user_lines.slice(0, ORGANIZER_USER_LINES_EARLIEST).map((row) => row.text)).toEqual(["名字 0", "名字 1", "名字 2", "名字 3"]);
    expect(counted.user_lines.at(-1)!.text).toBe(`名字 ${count - 1}`);
    expect(counted.user_lines_omitted).toBe(count - ORGANIZER_USER_LINES);
    store.close();
  });

  test("the rules and ticket descriptions you typed on the board are marked as yours, however many tickets you moved since", () => {
    const { store, writer, group } = fixture();
    const plan = store.openTask({ sessionId: group.id, title: "写周报", spec: spec() });
    const draft = store.createTicket({ taskId: plan.id, title: "初稿", spec: "写出第一版", status: "todo" });
    const file = (rules: string[], tickets: OrganizerResult["tickets"] = []) =>
      store.applyOrganizerResult({
        sessionId: group.id,
        current: store.getTask(plan.id),
        result: { decision: "continue", resumePlanId: null, spec: spec({ rules }), tickets, messageTicket: null },
        source: { messageId: null, turnId: null, messageBody: "" },
      });
    const typed = () => organizerPayload(store, { mode: "settle", sessionId: group.id, message: null, current: store.getTask(plan.id) }).current_plan!;
    file(["不要口语"]);
    store.setPlanSpecByUser(plan.id, spec({ rules: ["不要口语", "标题别太长"] }));
    // Every drag on the board is a revision of yours too; none of them pushes your rule out.
    for (let i = 0; i < 12; i += 1) store.patchTicketByUser(draft.id, { status: i % 2 === 0 ? "doing" : "todo", worker: writer.id });
    file(["不要口语", "标题别太长", "配图冻结"]);
    expect(typed().rules_user_typed).toEqual(["标题别太长"]);
    expect(typed().tickets[0]).not.toHaveProperty("spec_user_typed");

    store.patchTicketByUser(draft.id, { spec: "写出第一版，附上数据来源" });
    expect(typed().tickets[0]).toMatchObject({ spec: "写出第一版，附上数据来源", spec_user_typed: true });
    // Once the organizer rewrites it, it is no longer the description you wrote.
    file(["不要口语", "标题别太长"], [{ id: draft.id, spec: "写出第一版和第二版" }]);
    expect(typed().tickets[0]).not.toHaveProperty("spec_user_typed");
    expect(typed().rules_user_typed).toEqual(["标题别太长"]);
    store.close();
  });

  test("the goal and the Done when lines you typed on the board are marked as yours until the organizer changes them", () => {
    const { store, group } = fixture();
    const plan = store.openTask({ sessionId: group.id, title: "写周报", spec: spec() });
    const file = (over: Partial<PlanSpec>) =>
      store.applyOrganizerResult({
        sessionId: group.id,
        current: store.getTask(plan.id),
        result: { decision: "continue", resumePlanId: null, spec: spec(over), tickets: [], messageTicket: null },
        source: { messageId: null, turnId: null, messageBody: "" },
      });
    const typed = () => organizerPayload(store, { mode: "message", sessionId: group.id, message: null, current: store.getTask(plan.id) }).current_plan!;
    file({});
    expect(typed()).toMatchObject({ goal_user_typed: false, acceptance_user_typed: [] });

    store.setPlanSpecByUser(plan.id, spec({ goal: "只写第一周的周报", acceptance: ["交到 report.md", "不超过一页"] }));
    // The organizer files something else and keeps what you typed: still yours.
    file({ goal: "只写第一周的周报", acceptance: ["交到 report.md", "不超过一页"], rules: ["不要口语"] });
    expect(typed()).toMatchObject({ goal_user_typed: true, acceptance_user_typed: ["不超过一页"] });

    file({ goal: "写一份周报", acceptance: ["交到 report.md", "不超过一页"] });
    expect(typed()).toMatchObject({ goal_user_typed: false, acceptance_user_typed: ["不超过一页"] });
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

describe("what a settle may change when you have said nothing since the last version", () => {
  function answer(over: Partial<OrganizerResult> = {}): OrganizerResult {
    return { decision: "continue", resumePlanId: null, spec: spec(), tickets: [], messageTicket: null, ...over };
  }

  function board() {
    const { store, writer, group } = fixture();
    const plan = store.openTask({ sessionId: group.id, title: "写周报", spec: spec() });
    const draft = store.createTicket({ taskId: plan.id, title: "初稿", spec: "写出第一版，交到 draft.md", status: "doing", worker: writer.id });
    const art = store.createTicket({ taskId: plan.id, title: "配图", status: "todo" });
    return { store, writer, plan, draft, art, tickets: () => store.listTickets(plan.id) };
  }

  test("the goal, Done when and rules stay exactly as they were, and the plan is not parked; process and progress land", () => {
    const { store, tickets } = board();
    const before = spec({ rules: ["不要口语", "标题别太长"] });
    const changed = spec({
      goal: "只写周报的第一段",
      acceptance: ["交到 report.md", "审稿解冻前不能当作终稿"],
      rules: ["不要口语，只推进初稿，审稿冻结"],
      process: ["Writer 决定先冻结审稿"],
      progress: { done: ["初稿"], open: [], blocked: ["审稿：等 Writer 解冻"] },
      status: "parked",
    });
    const quiet = { before, tickets: tickets(), userSpoke: false };
    const { result, held } = holdSettle(answer({ spec: changed }), quiet);
    expect(result.spec).toEqual({ ...changed, goal: before.goal, acceptance: before.acceptance, rules: before.rules, status: "active" });
    expect(held).toEqual(["kept the goal as it was", "kept Done when as it was", "kept the rules as they were", "did not park the plan"]);
    // A rule added on its own, or one dropped on its own, is held all the same: neither rests on a word of yours.
    expect(holdSettle(answer({ spec: { ...before, rules: [...before.rules, "审稿冻结"] } }), quiet).result.spec.rules).toEqual(before.rules);
    expect(holdSettle(answer({ spec: { ...before, rules: ["不要口语"] } }), quiet).result.spec.rules).toEqual(before.rules);
    // A plan you parked stays parked, a plan called done is done, and an unchanged answer holds nothing.
    const parked = { ...before, status: "parked" as const };
    expect(holdSettle(answer({ spec: parked }), { ...quiet, before: parked }).result.spec.status).toBe("parked");
    expect(holdSettle(answer({ spec: { ...before, status: "done" } }), quiet).result.spec.status).toBe("done");
    expect(holdSettle(answer({ spec: before }), quiet).held).toEqual([]);
    store.close();
  });

  test("an existing ticket keeps the description it has; an empty one may be filled, a new ticket opens with its own, and status and worker still move", () => {
    const { store, writer, plan, draft, art, tickets } = board();
    const quiet = { before: spec(), tickets: tickets(), userSpoke: false };
    const { result, held } = holdSettle(
      answer({
        tickets: [
          { id: draft.id, spec: "已交初稿，不再重试", status: "review", worker: writer.id },
          { id: art.id, spec: "每段配一张图" },
          { id: "new-1", title: "排版", spec: "排成 A4", status: "todo" },
        ],
      }),
      quiet,
    );
    expect(result.tickets).toEqual([
      { id: draft.id, spec: "", status: "review", worker: writer.id },
      { id: art.id, spec: "每段配一张图" },
      { id: "new-1", title: "排版", spec: "排成 A4", status: "todo" },
    ]);
    expect(held).toEqual(["kept ticket 01's spec"]);
    // A new-N named like an existing ticket is that ticket, the way the store will read it.
    const renamed = holdSettle(answer({ tickets: [{ id: "new-1", title: "初稿", spec: "只改标题" }] }), quiet);
    expect(renamed.result.tickets).toEqual([{ id: "new-1", title: "初稿", spec: "" }]);
    expect(renamed.held).toEqual(["kept ticket 01's spec"]);
    // So is one named like a ticket the same answer renamed first.
    const retitled = holdSettle(
      answer({ tickets: [{ id: draft.id, title: "终稿", spec: "" }, { id: "new-1", title: "终稿", spec: "不再重试，只等解冻" }] }),
      quiet,
    );
    expect(retitled.result.tickets).toEqual([{ id: draft.id, title: "终稿", spec: "" }, { id: "new-1", title: "终稿", spec: "" }]);
    expect(retitled.held).toEqual(["kept ticket 01's spec"]);
    // Echoing the one-line preview it was shown is no rewrite: blanked so the description is not cut short, and not logged.
    const long = store.createTicket({ taskId: plan.id, title: "长说明", spec: `第一段\n\n${"细".repeat(400)}` });
    const echoed = holdSettle(answer({ tickets: [{ id: long.id, spec: ticketSpecPreview(long.spec) }] }), { ...quiet, tickets: tickets() });
    expect(echoed.result.tickets).toEqual([{ id: long.id, spec: "" }]);
    expect(echoed.held).toEqual([]);
    store.close();
  });

  test("after a line of yours a settle changes what it likes; a plan with no version yet gets no rules", () => {
    const { store, draft, tickets } = board();
    const changed = answer({ spec: spec({ goal: "写两份周报", rules: ["不要口语", "标题别太长"] }), tickets: [{ id: draft.id, spec: "写两版" }] });
    const spoke = holdSettle(changed, { before: spec(), tickets: tickets(), userSpoke: true });
    expect(spoke.result).toBe(changed);
    expect(spoke.held).toEqual([]);
    const first = holdSettle(answer({ spec: spec({ goal: "写周报初稿", rules: ["审稿冻结"] }) }), { before: null, tickets: [], userSpoke: false });
    expect(first.result.spec).toMatchObject({ goal: "写周报初稿", rules: [] });
    expect(first.held).toEqual(["kept the rules as they were"]);
    store.close();
  });
});
