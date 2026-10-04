import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent } from "@real-bot/protocol";
import { Store } from ".";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { normalizePlanSpec, parsePlanSpec, SPEC_GOAL_MAX, SPEC_ITEM_MAX, SPEC_LIST_MAX, type PlanSpec } from "./plan-shape";
import { ORGANIZER_NEW_TICKETS_MAX, type OrganizerResult } from "./plan-spec";

/** Like `fixture`, but with a real workspace directory so checks can be created. */
function checksFixture() {
  const root = mkdtempSync(join(tmpdir(), "plan-spec-checks-"));
  const store = new Store();
  store.patchSettingsSync({ workspace_path: root });
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  return {
    store,
    bot: writer.bot,
    session: writer.direct_session,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function fixture() {
  const store = new Store();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
  return { store, bot: writer.bot, reviewer: reviewer.bot, session: writer.direct_session };
}

function spec(over: Partial<PlanSpec> = {}): PlanSpec {
  return {
    kind: "周报",
    goal: "写一份周报",
    acceptance: ["交到 report.md"],
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

function status(error: unknown): number {
  return error instanceof HttpError ? error.status : -1;
}

function refused(work: () => unknown): number {
  try {
    work();
  } catch (error) {
    return status(error);
  }
  return 0;
}

describe("the shape of a spec", () => {
  test("needs a goal, clips every line, drops blanks and repeats, and reads an unknown status as active", () => {
    expect(normalizePlanSpec(null)).toBeNull();
    expect(normalizePlanSpec([])).toBeNull();
    expect(normalizePlanSpec({ kind: "周报" })).toBeNull();
    expect(normalizePlanSpec({ goal: "   " })).toBeNull();
    const many = Array.from({ length: SPEC_LIST_MAX + 5 }, (_, i) => `第 ${i} 条`);
    const normalized = normalizePlanSpec({
      kind: "  周报  ",
      goal: `写一份${"很".repeat(SPEC_GOAL_MAX)}长的周报`,
      acceptance: ["  交到 report.md ", "", "交到 report.md", 42, "图".repeat(SPEC_ITEM_MAX + 10)],
      rules: "not a list",
      process: many,
      progress: { done: ["初稿"], open: null },
      status: "Later",
    })!;
    expect(normalized.kind).toBe("周报");
    expect([...normalized.goal]).toHaveLength(SPEC_GOAL_MAX);
    expect(normalized.acceptance).toEqual(["交到 report.md", "图".repeat(SPEC_ITEM_MAX)]);
    expect(normalized.rules).toEqual([]);
    expect(normalized.process).toHaveLength(SPEC_LIST_MAX);
    expect(normalized.progress).toEqual({ done: ["初稿"], open: [], blocked: [] });
    expect(normalized.status).toBe("active");
  });

  test("a stored row that is not a spec reads as none", () => {
    expect(parsePlanSpec(null)).toBeNull();
    expect(parsePlanSpec("{not json")).toBeNull();
    expect(parsePlanSpec(JSON.stringify({ kind: "x" }))).toBeNull();
    expect(parsePlanSpec(JSON.stringify(spec()))).toEqual(spec());
  });
});

describe("your edit of a plan", () => {
  test("is a revision of yours, and a stale revision or a goalless spec is refused", () => {
    const { store, session } = fixture();
    const plan = store.openTask({ sessionId: session.id, title: "写周报" });
    expect(store.currentRevision(plan.id)).toBe(0);
    const saved = store.setPlanSpecByUser(plan.id, spec({ rules: ["不要口语"] }), 0);
    expect(saved.revision).toMatchObject({ task_id: plan.id, revision: 1, actor: "user", source_message_id: null });
    expect(parsePlanSpec(saved.task.spec)).toEqual(spec({ rules: ["不要口语"] }));
    expect(saved.task.kind).toBe("周报");
    expect(saved.task.spec_updated_at).toBeString();

    expect(refused(() => store.setPlanSpecByUser(plan.id, spec(), 0))).toBe(409);
    expect(refused(() => store.setPlanSpecByUser(plan.id, spec(), "1"))).toBe(422);
    expect(refused(() => store.setPlanSpecByUser(plan.id, { kind: "周报" }, 1))).toBe(422);
    expect(refused(() => store.setPlanSpecByUser("01ARZ3NDEKTSV4RRFFQ69G5FAV", spec()))).toBe(404);
    expect(store.currentRevision(plan.id)).toBe(1);
    expect(store.listSpecRevisions(plan.id).map((row) => [row.revision, row.actor])).toEqual([[1, "user"]]);
    store.close();
  });

  test("done takes the plan out of the current slot; active puts it back while nothing else took it", () => {
    const { store, session } = fixture();
    const plan = store.openTask({ sessionId: session.id, title: "写周报" });
    store.setPlanSpecByUser(plan.id, spec({ status: "done" }));
    expect(store.getTask(plan.id)).toMatchObject({ status: "done" });
    expect(store.getTask(plan.id).closed_at).toBeString();
    expect(store.sessionCurrentTask(session.id)).toBeNull();

    store.setPlanSpecByUser(plan.id, spec({ status: "active" }));
    expect(store.getTask(plan.id)).toMatchObject({ status: "active", closed_at: null });
    expect(store.sessionCurrentTask(session.id)?.id).toBe(plan.id);

    // Another plan holding the slot keeps it: the revived one is active but not current.
    const next = store.openTask({ sessionId: session.id, title: "订会议室" });
    expect(store.getTask(plan.id)).toMatchObject({ status: "parked" });
    store.setPlanSpecByUser(plan.id, spec({ status: "active" }));
    expect(store.getTask(plan.id).status).toBe("active");
    expect(store.getTask(plan.id).closed_at).toBeString();
    expect(store.sessionCurrentTask(session.id)?.id).toBe(next.id);
    store.close();
  });

  test("of one ticket is a revision too, unless nothing changed or the plan has no spec yet", () => {
    const { store, session, bot } = fixture();
    const plan = store.openTask({ sessionId: session.id, title: "写周报" });
    const ticket = store.createTicket({ taskId: plan.id, title: "初稿", worker: null });
    // No spec: the ticket moves, the history stays empty.
    expect(store.patchTicketByUser(ticket.id, { status: "doing" }).revision).toBeNull();
    expect(store.getTicket(ticket.id).status).toBe("doing");

    store.setPlanSpecByUser(plan.id, spec());
    const moved = store.patchTicketByUser(ticket.id, { status: "review", worker: bot.id }, 1);
    expect(moved.ticket).toMatchObject({ status: "review", worker: bot.id });
    expect(moved.revision).toMatchObject({ revision: 2, actor: "user" });
    expect(store.patchTicketByUser(ticket.id, { status: "review" }).revision).toBeNull();
    expect(store.currentRevision(plan.id)).toBe(2);
    expect(refused(() => store.patchTicketByUser(ticket.id, { status: "done" }, 1))).toBe(409);
    expect(refused(() => store.patchTicketByUser("01ARZ3NDEKTSV4RRFFQ69G5FAV", { status: "done" }))).toBe(404);
    expect(refused(() => store.patchTicketByUser(ticket.id, { status: "later" }))).toBe(422);
    store.close();
  });
});

describe("what one organizer run changes", () => {
  test("never the rules or Done when: a plan keeps the ones it has, one it opens starts with none, and the rest is filed", () => {
    const { store, session } = fixture();
    const opener = store.postMessage(session.id, { body: "写周报，交到 report.md，不要口语" });
    const opened = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({ decision: "new", spec: spec({ rules: ["不要口语"], process: ["Writer 写"] }) }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
    });
    expect(parsePlanSpec(opened.task.spec)).toMatchObject({ goal: "写一份周报", acceptance: [], rules: [], process: ["Writer 写"] });
    // What you write on the board stays, whatever a later filing answers.
    store.setPlanSpecByUser(opened.task.id, spec({ acceptance: ["交到 report.md"], rules: ["不要口语", "标题别太长"], process: ["Writer 写"] }));
    const follow = store.postMessage(session.id, { body: "加一节下周计划" });
    const filed = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.sessionCurrentTask(session.id),
      result: result({ spec: spec({ goal: "写一份带下周计划的周报", acceptance: [], rules: ["用户要求接着做完"], progress: { done: [], open: ["下周计划"], blocked: [] } }) }),
      source: { messageId: follow.id, turnId: null, messageBody: follow.body },
    });
    expect(parsePlanSpec(filed.task.spec)).toMatchObject({
      goal: "写一份带下周计划的周报",
      acceptance: ["交到 report.md"],
      rules: ["不要口语", "标题别太长"],
      progress: { open: ["下周计划"] },
    });
    store.close();
  });

  test("keeps a rule you typed on the board while the call was out, though the run was built on the plan as it stood before", () => {
    const { store, session } = fixture();
    const opener = store.postMessage(session.id, { body: "写周报" });
    const opened = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({ decision: "new", spec: spec() }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
    });
    // The organizer takes its copy of the plan, and the call goes out.
    const before = store.sessionCurrentTask(session.id)!;
    const line = store.postMessage(session.id, { body: "加一节下周计划" });
    store.setPlanSpecByUser(opened.task.id, spec({ acceptance: ["交到 report.md"], rules: ["标题别太长"] }));
    // The answer lands on that copy; a line's filing carries no revision to refuse it by.
    const filed = store.applyOrganizerResult({
      sessionId: session.id,
      current: before,
      result: result({ spec: spec({ acceptance: [], progress: { done: [], open: ["下周计划"], blocked: [] } }) }),
      source: { messageId: line.id, turnId: null, messageBody: line.body },
    });
    expect(parsePlanSpec(filed.task.spec)).toMatchObject({
      acceptance: ["交到 report.md"],
      rules: ["标题别太长"],
      progress: { open: ["下周计划"] },
    });
    store.close();
  });

  test("with no current plan, opens one from the message, files the tickets, and stamps the message", () => {
    const { store, session, bot } = fixture();
    const message = store.postMessage(session.id, { body: "帮我写一份周报，交到 report.md" });
    const applied = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({
        decision: "new",
        tickets: [
          { id: "new-1", title: "初稿", spec: "写出第一版", status: "doing", worker: bot.id },
          { id: "new-2", title: "配图", spec: "", status: "todo", worker: null },
        ],
        messageTicket: "new-2",
      }),
      source: { messageId: message.id, turnId: null, messageBody: message.body },
    });
    expect(applied.created).toBe(2);
    expect(applied.task).toMatchObject({ session_id: session.id, title: "写一份周报", brief: message.body, kind: "周报", status: "active" });
    expect(applied.task.dir).toMatch(/^work\/写一份周报-[0-9a-z]{4}$/);
    // Everything but its Done when: that is no longer the organizer's to write (ADR 0040 P3).
    expect(parsePlanSpec(applied.task.spec)).toEqual(spec({ acceptance: [] }));
    expect(applied.tickets.map((row) => [row.seq, row.title, row.status, row.worker])).toEqual([
      [1, "初稿", "doing", bot.id],
      [2, "配图", "todo", null],
    ]);
    expect(applied.messageTicketId).toBe(applied.tickets[1]!.id);
    expect(store.getMessage(message.id)).toMatchObject({ task_id: applied.task.id, ticket_id: applied.tickets[1]!.id });
    expect(applied.revision).toMatchObject({ revision: 1, actor: "app", source_message_id: message.id, source_turn_id: null });
    expect(JSON.parse(applied.revision.tickets_snapshot)).toHaveLength(2);
    expect(store.sessionCurrentTask(session.id)?.id).toBe(applied.task.id);
    // The turn this message opens lands in the plan and the ticket the stamp names.
    const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: message.id });
    expect(turn).toMatchObject({ task_id: applied.task.id, ticket_id: applied.tickets[1]!.id });
    expect(store.turnWorkDir(turn.id)).toBe(applied.tickets[1]!.dir);
    store.close();
  });

  test("its version is stamped on the store's clock, so it never reads as older than the line it filed", () => {
    const { store, session } = fixture();
    // A busy store's clock runs ahead of the wall clock: every stamp within one millisecond moves it on.
    for (let i = 0; i < 50; i++) isoNow();
    const message = store.postMessage(session.id, { body: "帮我写一份周报" });
    const applied = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({ decision: "new" }),
      source: { messageId: message.id, turnId: null, messageBody: message.body },
    });
    const since = store.lastSpecRevisionAt(applied.task.id);
    expect(since > store.getMessage(message.id).created_at).toBe(true);
    // So the settle after it does not take that line for something that happened since.
    expect(store.taskMessagesSince(applied.task.id, since, 1)).toEqual([]);
    store.close();
  });

  test("continuing, it patches tickets by id, dedupes a new one by title, drops what it cannot place, and caps what it opens", () => {
    const { store, session, bot, reviewer } = fixture();
    const opener = store.postMessage(session.id, { body: "写周报" });
    const first = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({ decision: "new", tickets: [{ id: "new-1", title: "初稿", spec: "", status: "todo", worker: null }] }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
    });
    const existing = first.tickets[0]!;
    const follow = store.postMessage(session.id, { body: "初稿让 Reviewer 看一下" });
    const extra = Array.from({ length: ORGANIZER_NEW_TICKETS_MAX + 2 }, (_, i) => ({
      id: `new-${i + 3}`,
      title: `额外 ${i + 1}`,
      spec: "",
      status: "todo" as const,
      worker: null,
    }));
    const second = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.sessionCurrentTask(session.id),
      result: result({
        spec: spec({ rules: ["先给 Reviewer 过一遍"] }),
        tickets: [
          { id: existing.id, title: "初稿", spec: "第一版", status: "review", worker: reviewer.id },
          // Same title as the existing one: a repeat, not a second ticket.
          { id: "new-1", title: " 初稿 ", spec: "", status: "doing", worker: bot.id },
          { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", title: "谁的", spec: "", status: "todo", worker: null },
          { id: "new-2", title: "   ", spec: "", status: "todo", worker: null },
          ...extra,
        ],
        messageTicket: "new-1",
      }),
      source: { messageId: follow.id, turnId: null, messageBody: follow.body },
    });
    expect(second.task.id).toBe(first.task.id);
    expect(second.created).toBe(ORGANIZER_NEW_TICKETS_MAX);
    expect(second.tickets).toHaveLength(1 + ORGANIZER_NEW_TICKETS_MAX);
    // The last entry for the existing ticket wins: the repeat moved it to doing under the Writer.
    expect(second.tickets[0]).toMatchObject({ id: existing.id, title: "初稿", spec: "第一版", status: "doing", worker: bot.id });
    expect(second.tickets.some((row) => row.title === "谁的")).toBe(false);
    expect(second.messageTicketId).toBe(existing.id);
    expect(store.getMessage(follow.id)).toMatchObject({ task_id: first.task.id, ticket_id: existing.id });
    expect(parsePlanSpec(second.task.spec)?.rules).toEqual([]);
    expect(second.revision.revision).toBe(2);
    store.close();
  });

  test("resumes only a plan this session had before, else files nothing; new parks the current one", () => {
    const { store, session } = fixture();
    const a = store.postMessage(session.id, { body: "写周报" });
    const planA = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({ decision: "new" }),
      source: { messageId: a.id, turnId: null, messageBody: a.body },
    }).task;
    const b = store.postMessage(session.id, { body: "先订个会议室" });
    const planB = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.sessionCurrentTask(session.id),
      result: result({ decision: "new", spec: spec({ kind: "会议室", goal: "订会议室" }) }),
      source: { messageId: b.id, turnId: null, messageBody: b.body },
    }).task;
    expect(planB.id).not.toBe(planA.id);
    expect(store.getTask(planA.id)).toMatchObject({ status: "parked" });
    expect(store.sessionCurrentTask(session.id)?.id).toBe(planB.id);

    // A resume of a plan that is not this session's recent history files nothing: the answer was
    // written for that plan, and continuing with it would write its goal over this one.
    const other = store.createBot({ name: "Other", duties: "x", boundaries: "y" });
    const elsewhere = store.openTask({ sessionId: other.direct_session.id, title: "别处的事" });
    const c = store.postMessage(session.id, { body: "回到那件事" });
    const revisions = store.listSpecRevisions(planB.id).length;
    expect(
      refused(() =>
        store.applyOrganizerResult({
          sessionId: session.id,
          current: store.sessionCurrentTask(session.id),
          result: result({ decision: "resume", resumePlanId: elsewhere.id, spec: spec({ goal: "别处的事" }) }),
          source: { messageId: c.id, turnId: null, messageBody: c.body },
        }),
      ),
    ).toBe(409);
    expect(store.sessionCurrentTask(session.id)?.id).toBe(planB.id);
    expect(parsePlanSpec(store.getTask(planB.id).spec)?.goal).toBe("订会议室");
    expect(store.listSpecRevisions(planB.id)).toHaveLength(revisions);
    expect(store.getMessage(c.id).task_id).toBeNull();

    const d = store.postMessage(session.id, { body: "周报接着写" });
    const resumed = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.sessionCurrentTask(session.id),
      result: result({ decision: "resume", resumePlanId: planA.id }),
      source: { messageId: d.id, turnId: null, messageBody: d.body },
    });
    expect(resumed.task.id).toBe(planA.id);
    expect(store.sessionCurrentTask(session.id)?.id).toBe(planA.id);
    expect(store.getTask(planA.id)).toMatchObject({ status: "active", closed_at: null });
    expect(store.getTask(planB.id)).toMatchObject({ status: "parked" });
    expect(store.getMessage(d.id).task_id).toBe(planA.id);
    store.close();
  });

  test("a line about a job the Bots here are doing elsewhere joins that plan; this session's plan stays current", () => {
    const { store, session, bot, reviewer } = fixture();
    const group = store.createGroup({ name: "周报组", members: [bot.id, reviewer.id] });
    const report = store.openTask({ sessionId: group.id, title: "写周报", spec: spec({ rules: ["不要口语"] }) });
    const draft = store.createTicket({ taskId: report.id, title: "初稿", status: "doing", worker: bot.id });
    store.createTicket({ taskId: report.id, title: "审稿", status: "todo", worker: reviewer.id });
    const go = store.postMessage(group.id, { body: "写周报" });
    store.createTurn({ sessionId: group.id, botId: bot.id, triggerMessageId: go.id, taskId: report.id, ticketId: draft.id });
    const mine = store.openTask({ sessionId: session.id, title: "订会议室", spec: spec({ kind: "会议室", goal: "订会议室" }) });
    expect(store.elsewherePlans(session.id).map((task) => task.id)).toEqual([report.id]);

    const aside = store.postMessage(session.id, { body: "周报标题别太长" });
    const joined = store.applyOrganizerResult({
      sessionId: session.id,
      current: mine,
      result: result({
        decision: "join",
        joinPlanId: report.id,
        spec: spec({ rules: ["不要口语", "标题别太长"] }),
        tickets: [{ id: draft.id, spec: "" }],
        messageTicket: draft.id,
      }),
      source: { messageId: aside.id, turnId: null, messageBody: aside.body },
    });
    expect(joined.task.id).toBe(report.id);
    expect(parsePlanSpec(store.getTask(report.id).spec)?.rules).toEqual(["不要口语"]);
    expect(store.getMessage(aside.id)).toMatchObject({ task_id: report.id, ticket_id: draft.id });
    // The group keeps its job and this direct keeps its own.
    expect(store.getTask(report.id)).toMatchObject({ session_id: group.id, status: "active", closed_at: null });
    expect(store.sessionCurrentTask(session.id)?.id).toBe(mine.id);
    expect(store.sessionCurrentTask(group.id)?.id).toBe(report.id);
    store.close();
  });

  test("join only takes a plan the Bots here are on elsewhere; anything else files nothing and opens no plan", () => {
    const { store, session, bot, reviewer } = fixture();
    const other = store.createBot({ name: "Other", duties: "x", boundaries: "y" });
    const theirs = store.openTask({ sessionId: other.direct_session.id, title: "别人的事" });
    store.createTicket({ taskId: theirs.id, title: "别人的任务", status: "doing", worker: other.bot.id });
    const mine = store.openTask({ sessionId: session.id, title: "订会议室" });
    const line = store.postMessage(session.id, { body: "那件事怎么样了" });
    const join = (current: typeof mine | null) =>
      refused(() =>
        store.applyOrganizerResult({
          sessionId: session.id,
          current,
          result: result({ decision: "join", joinPlanId: theirs.id }),
          source: { messageId: line.id, turnId: null, messageBody: line.body },
        }),
      );
    const plans = () => store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`).get()!.n;
    const before = plans();
    expect(join(mine)).toBe(409);
    // With no current plan either: the copy of the job a continue on nothing once opened.
    expect(join(null)).toBe(409);
    expect(plans()).toBe(before);
    expect(store.getMessage(line.id).task_id).toBeNull();

    // What counts: an open ticket of a Bot here in an active plan, or its live turn in another session.
    const group = store.createGroup({ name: "周报组", members: [bot.id, reviewer.id] });
    const report = store.openTask({ sessionId: group.id, title: "写周报" });
    const review = store.createTicket({ taskId: report.id, title: "审稿", status: "todo", worker: reviewer.id });
    expect(store.elsewherePlans(session.id)).toEqual([]);
    store.createTicket({ taskId: report.id, title: "初稿", status: "review", worker: bot.id });
    expect(store.elsewherePlans(session.id).map((task) => task.id)).toEqual([report.id]);
    store.patchTicket(review.id, { status: "done" });
    const done = store.openTask({ sessionId: group.id, title: "上周的周报", spec: spec({ status: "done" }) });
    store.createTicket({ taskId: done.id, title: "初稿", status: "doing", worker: bot.id });
    expect(store.elsewherePlans(session.id).map((task) => task.id)).not.toContain(done.id);
    store.close();
  });

  test("settling names the turn it came from and stamps no message", () => {
    const { store, session, bot } = fixture();
    const opener = store.postMessage(session.id, { body: "写周报" });
    const plan = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({ decision: "new", tickets: [{ id: "new-1", title: "初稿", spec: "", status: "doing", worker: bot.id }] }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
    });
    const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: opener.id });
    const settled = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.getTask(plan.task.id),
      result: result({
        spec: spec({ progress: { done: ["初稿"], open: [], blocked: [] } }),
        tickets: [{ id: plan.tickets[0]!.id, title: "初稿", spec: "", status: "done", worker: bot.id }],
      }),
      source: { messageId: null, turnId: turn.id, messageBody: "" },
    });
    expect(settled.revision).toMatchObject({ revision: 2, actor: "app", source_message_id: null, source_turn_id: turn.id });
    expect(settled.tickets[0]).toMatchObject({ status: "done" });
    expect(settled.tickets[0]!.closed_at).toBeString();
    expect(store.getMessage(opener.id).ticket_id).toBeNull();
    store.close();
  });

  test("a settle naming tickets by id with only what changed moves them and keeps the rest", () => {
    const { store, session, bot, reviewer } = fixture();
    const opener = store.postMessage(session.id, { body: "写周报" });
    const plan = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({
        decision: "new",
        tickets: [
          { id: "new-1", title: "初稿", spec: "写第一版", status: "doing", worker: bot.id },
          { id: "new-2", title: "审稿", spec: "Reviewer 过一遍", status: "todo", worker: reviewer.id },
        ],
      }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
    });
    const [draft, review] = plan.tickets;
    const settled = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.getTask(plan.task.id),
      // What a settle writes when it only moves things: no title, no worker, no status on the second.
      result: result({ tickets: [{ id: draft!.id, spec: "", status: "review" }, { id: review!.id, spec: "" }] }),
      source: { messageId: null, turnId: null, messageBody: "" },
    });
    expect(settled.tickets[0]).toMatchObject({ title: "初稿", spec: "写第一版", status: "review", worker: bot.id });
    expect(settled.tickets[1]).toMatchObject({ title: "审稿", spec: "Reviewer 过一遍", status: "todo", worker: reviewer.id });
    store.close();
  });

  test("a settle files the handover only: the goal and kind stay, it parks nothing, and an existing ticket keeps its title and the description it has", () => {
    const { store, session, bot } = fixture();
    const opener = store.postMessage(session.id, { body: "写周报" });
    const plan = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({
        decision: "new",
        tickets: [
          { id: "new-1", title: "初稿", spec: "写出第一版，交到 draft.md", status: "doing", worker: bot.id },
          { id: "new-2", title: "配图", spec: "", status: "todo" },
          { id: "new-3", title: "长说明", spec: `第一段\n\n${"细".repeat(400)}`, status: "todo" },
        ],
      }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
    });
    const [draft, art, long] = plan.tickets;
    // A coordinator's caution written up as the job's goal and its tickets' descriptions, and the
    // plan set aside: none of it was said by you, and a settle has no line of yours to go on.
    const settled = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.getTask(plan.task.id),
      result: result({
        spec: spec({
          kind: "周报初稿",
          goal: "只写周报的第一段",
          acceptance: ["审稿解冻前不能当作终稿"],
          rules: ["只推进初稿，审稿冻结"],
          process: ["Writer 决定先冻结审稿"],
          progress: { done: ["初稿"], open: [], blocked: ["审稿：等 Writer 解冻"] },
          status: "parked",
        }),
        tickets: [
          { id: draft!.id, title: "初稿（冻结）", spec: "已交初稿，不再重试", status: "review", worker: bot.id },
          { id: art!.id, spec: "每段配一张图" },
          // The one-line preview it was shown, echoed back: no rewrite, so nothing to say.
          { id: long!.id, spec: `第一段 ${"细".repeat(200)}` },
          // A new-N named like an existing ticket is that ticket: it moves, and keeps its description.
          { id: "new-1", title: "初稿", spec: "只改说明", status: "review" },
          { id: "new-2", title: "排版", spec: "排成 A4", status: "todo" },
        ],
      }),
      source: { messageId: null, turnId: null, messageBody: "" },
      settle: true,
    });
    expect(parsePlanSpec(settled.task.spec)).toEqual({
      ...spec(),
      process: ["Writer 决定先冻结审稿"],
      progress: { done: ["初稿"], open: [], blocked: ["审稿：等 Writer 解冻"] },
      // Not the board's to lose either: a settle never writes Done when.
      acceptance: [],
    });
    expect(settled.task.status).toBe("active");
    expect(settled.tickets.map((ticket) => [ticket.title, ticket.spec, ticket.status])).toEqual([
      ["初稿", "写出第一版，交到 draft.md", "review"],
      ["配图", "每段配一张图", "todo"],
      ["长说明", long!.spec, "todo"],
      ["排版", "排成 A4", "todo"],
    ]);
    expect(settled.kept).toEqual([
      "kept the goal as it was",
      "did not park the plan",
      "kept ticket 01's title",
      "kept ticket 01's spec",
      "kept ticket 01's spec",
    ]);
    store.close();
  });

  test("a settle may still give a plan with no spec yet its goal and call it done, but parks it no more than any other", () => {
    const { store, session, bot } = fixture();
    // A plan a turn opened while the line's filing failed: no spec at all.
    const plan = store.openTask({ sessionId: session.id, title: "写周报" });
    const ticket = store.createTicket({ taskId: plan.id, title: "初稿", spec: "写出第一版", status: "doing", worker: bot.id });
    const first = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.getTask(plan.id),
      result: result({ spec: spec({ goal: "写一份周报", rules: ["审稿冻结"], status: "parked" }) }),
      source: { messageId: null, turnId: null, messageBody: "" },
      settle: true,
    });
    expect(parsePlanSpec(first.task.spec)).toMatchObject({ goal: "写一份周报", acceptance: [], rules: [], status: "active" });
    expect(first.task.status).toBe("active");
    expect(first.kept).toEqual(["did not park the plan"]);
    const done = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.getTask(plan.id),
      result: result({ spec: spec({ goal: "写一份周报", status: "done" }), tickets: [{ id: ticket.id, spec: "", status: "done" }] }),
      source: { messageId: null, turnId: null, messageBody: "" },
      settle: true,
    });
    expect(done.task.status).toBe("done");
    expect(done.kept).toEqual([]);
    store.close();
  });

  test("from level 5 a settle does not reopen a job hand-overs and approvals delivered", () => {
    // 2026-10-04, real-model run: 19 s after your 放行 delivered the poster job again, a settle that had
    // just seen your change called it in progress, and the board said 进行中 over a delivered job.
    const { store, session, bot } = fixture();
    store.db.run("INSERT INTO settings (key, value) VALUES ('engine_level', '8') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const plan = store.openTask({ sessionId: session.id, title: "开业海报" });
    store.createTicket({ taskId: plan.id, title: "海报", spec: "竖版", status: "done", worker: bot.id });
    store.applyOrganizerResult({ sessionId: session.id, current: store.getTask(plan.id),
      result: result({ spec: spec({ goal: "一张开业海报" }) }), source: { messageId: null, turnId: null, messageBody: "" }, settle: true });
    const spec0 = parsePlanSpec(store.getTask(plan.id).spec)!;
    store.setTaskSpec(plan.id, { ...spec0, status: "done" });
    expect(store.getTask(plan.id).status).toBe("done");
    const settled = store.applyOrganizerResult({ sessionId: session.id, current: store.getTask(plan.id),
      result: result({ spec: spec({ goal: "一张开业海报", status: "active" }) }), source: { messageId: null, turnId: null, messageBody: "" }, settle: true });
    expect(settled.task.status).toBe("done");
    expect(settled.kept).toContain("kept the job done: hand-overs and approvals decide it");
    store.close();
  });

  test("a settle leaves a plan a newer one displaced parked, though its spec still reads active", () => {
    const { store, session } = fixture();
    const older = store.openTask({ sessionId: session.id, title: "写周报", spec: spec() });
    store.openTask({ sessionId: session.id, title: "做海报", spec: spec({ goal: "做一张海报" }) });
    expect(store.getTask(older.id).status).toBe("parked");
    const settled = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.getTask(older.id),
      result: result({ spec: spec({ status: "parked" }) }),
      source: { messageId: null, turnId: null, messageBody: "" },
      settle: true,
    });
    expect(settled.task.status).toBe("parked");
    expect(settled.kept).toEqual([]);
    store.close();
  });

  test("a settle that renames a ticket and then names it by the new title files one ticket, not two", () => {
    const { store, session, bot } = fixture();
    const opener = store.postMessage(session.id, { body: "写周报" });
    const plan = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({ decision: "new", tickets: [{ id: "new-1", title: "初稿", spec: "写出第一版", status: "doing", worker: bot.id }] }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
    });
    const settled = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.getTask(plan.task.id),
      result: result({
        tickets: [
          { id: plan.tickets[0]!.id, title: "终稿", spec: "", status: "doing" },
          { id: "new-1", title: "终稿", spec: "", status: "review", worker: bot.id },
        ],
      }),
      source: { messageId: null, turnId: null, messageBody: "" },
      settle: true,
    });
    expect(settled.created).toBe(0);
    expect(settled.tickets.map((ticket) => [ticket.title, ticket.status])).toEqual([["初稿", "review"]]);
    store.close();
  });

  test("a plan called done while tickets are still to do or in progress stays active; review counts as handed over", () => {
    const { store, session, bot } = fixture();
    const opener = store.postMessage(session.id, { body: "做个网页" });
    const plan = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({
        decision: "new",
        tickets: [
          { id: "new-1", title: "设计", spec: "", status: "todo", worker: bot.id },
          { id: "new-2", title: "实现", spec: "", status: "todo", worker: bot.id },
        ],
      }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
    });
    const [design, build] = plan.tickets;
    const done = spec({ status: "done", progress: { done: ["设计", "实现"], open: [], blocked: [] } });
    const early = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.getTask(plan.task.id),
      result: result({ spec: done, tickets: [{ id: design!.id, spec: "", status: "done" }] }),
      source: { messageId: null, turnId: null, messageBody: "" },
    });
    expect(early.heldOpenBy.map((ticket) => ticket.id)).toEqual([build!.id]);
    expect(early.task).toMatchObject({ status: "active", closed_at: null });
    expect(parsePlanSpec(early.task.spec)).toMatchObject({ status: "active", progress: { done: ["设计", "实现"] } });
    expect(early.revision.spec).toContain('"status":"active"');
    expect(store.sessionCurrentTask(session.id)?.id).toBe(plan.task.id);

    const closed = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.getTask(plan.task.id),
      result: result({ spec: done, tickets: [{ id: build!.id, spec: "", status: "review" }] }),
      source: { messageId: null, turnId: null, messageBody: "" },
    });
    expect(closed.heldOpenBy).toEqual([]);
    expect(closed.task.status).toBe("done");
    store.close();
  });

  test("a plan called done stays active while an active check has failed, or has never run since its definition; it goes through once the check passes", () => {
    const f = checksFixture();
    const plan = f.store.applyOrganizerResult({
      sessionId: f.session.id,
      current: null,
      result: result({ decision: "new" }),
      source: { messageId: null, turnId: null, messageBody: "写一份周报" },
    }).task;
    const failing = f.store.createCheckByUser(plan.id, { item: "交到 report.md", kind: "exists", path: "report.md" });
    const run = f.store.beginCheckRun(failing.id, "user");
    f.store.finishCheckRun(run.id, { outcome: "fail", exitCode: null, detail: "文件不在", output: null });

    // Failed: held open, and it is not "awaiting evidence" — there is already a verdict, just not
    // a passing one.
    const heldByFailure = f.store.applyOrganizerResult({
      sessionId: f.session.id,
      current: f.store.getTask(plan.id),
      result: result({ spec: spec({ status: "done" }) }),
      source: { messageId: null, turnId: null, messageBody: "" },
    });
    expect(heldByFailure.heldByChecks.map((c) => c.id)).toEqual([failing.id]);
    expect(heldByFailure.awaitingEvidence).toBe(false);
    expect(heldByFailure.task.status).toBe("active");

    // The same check now passes: `done` goes through, held by nothing.
    const passed = f.store.beginCheckRun(failing.id, "user");
    f.store.finishCheckRun(passed.id, { outcome: "pass", exitCode: null, detail: "ok", output: null });
    const closed = f.store.applyOrganizerResult({
      sessionId: f.session.id,
      current: f.store.getTask(plan.id),
      result: result({ spec: spec({ status: "done" }) }),
      source: { messageId: null, turnId: null, messageBody: "" },
    });
    expect(closed.heldByChecks).toEqual([]);
    expect(closed.task.status).toBe("done");
    f.close();
  });

  test("a plan called done stays active for a check that never ran; `awaitingEvidence` is true only when every holding check is like that", () => {
    const f = checksFixture();
    const plan = f.store.applyOrganizerResult({
      sessionId: f.session.id,
      current: null,
      result: result({ decision: "new" }),
      source: { messageId: null, turnId: null, messageBody: "写一份周报" },
    }).task;
    const neverRun = f.store.createCheckByUser(plan.id, { item: "交到 report.md", kind: "exists", path: "report.md" });

    const held = f.store.applyOrganizerResult({
      sessionId: f.session.id,
      current: f.store.getTask(plan.id),
      result: result({ spec: spec({ status: "done" }) }),
      source: { messageId: null, turnId: null, messageBody: "" },
    });
    expect(held.heldByChecks.map((c) => c.id)).toEqual([neverRun.id]);
    expect(held.awaitingEvidence).toBe(true);
    expect(held.task.status).toBe("active");

    // A second, failing check alongside it: still held, but no longer purely "awaiting evidence" —
    // one of the two has an actual verdict against it.
    const failing = f.store.createCheckByUser(plan.id, { item: "第二条", kind: "exists", path: "b.md" });
    const run = f.store.beginCheckRun(failing.id, "user");
    f.store.finishCheckRun(run.id, { outcome: "fail", exitCode: null, detail: "文件不在", output: null });
    const mixedHeld = f.store.applyOrganizerResult({
      sessionId: f.session.id,
      current: f.store.getTask(plan.id),
      result: result({ spec: spec({ status: "done" }) }),
      source: { messageId: null, turnId: null, messageBody: "" },
    });
    expect(mixedHeld.heldByChecks.map((c) => c.id).sort()).toEqual([failing.id, neverRun.id].sort());
    expect(mixedHeld.awaitingEvidence).toBe(false);
    f.close();
  });

  test("raises plan and ticket events as it goes; a cleared session sets the plan aside, and takes it away with your words", () => {
    const { store, session, bot } = fixture();
    const seen: ClientEvent[] = [];
    store.onCommit((event) => seen.push(event));
    const opener = store.postMessage(session.id, { body: "写周报" });
    const applied = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({ decision: "new", tickets: [{ id: "new-1", title: "初稿", spec: "", status: "doing", worker: bot.id }] }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
    });
    const upserts = seen.filter((event) => event.event === "task.upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ id: applied.task.id, goal: "写一份周报", revision: 1, revision_actor: "app", ticket_counts: { doing: 1 } });
    expect(seen.filter((event) => event.event === "ticket.upsert")).toMatchObject([{ id: applied.tickets[0]!.id, task_id: applied.task.id, status: "doing" }]);

    // Repeating what is already there moves nothing and says nothing about the ticket.
    seen.length = 0;
    store.patchTicket(applied.tickets[0]!.id, { status: "doing" });
    expect(seen).toEqual([]);

    // What you said about it is kept (ADR 0040), so the plan stays, set aside and closed for the board.
    store.clearSessionMessages(session.id);
    expect(seen.filter((event) => event.event === "task.removed" || event.event === "ticket.removed")).toEqual([]);
    expect(seen.filter((event) => event.event === "task.upsert")).toMatchObject([{ id: applied.task.id, closed_at: expect.any(String) }]);
    expect(store.getTask(applied.task.id).dormant_since).toBeString();

    // Erased with it, nothing keeps the plan any more.
    seen.length = 0;
    store.clearSessionMessages(session.id, { eraseQuotes: true });
    expect(seen.filter((event) => event.event === "ticket.removed")).toMatchObject([{ id: applied.tickets[0]!.id, task_id: applied.task.id }]);
    expect(seen.filter((event) => event.event === "task.removed")).toMatchObject([{ id: applied.task.id }]);
    expect(store.listTickets(applied.task.id)).toEqual([]);
    store.close();
  });

  test("the detail a board reads carries the spec, the revision, and each ticket's surviving artifacts", () => {
    const { store, session, bot } = fixture();
    const opener = store.postMessage(session.id, { body: "写周报" });
    const applied = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({ decision: "new", tickets: [{ id: "new-1", title: "初稿", spec: "", status: "doing", worker: bot.id }], messageTicket: "new-1" }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
    });
    const ticket = applied.tickets[0]!;
    const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: opener.id });
    store.insertMessage({ sessionId: session.id, turnId: turn.id, kind: "bot", author: bot.id, body: "初稿", paths: [`${ticket.dir}/draft.md`, "gone.md"] });
    const detail = store.taskDetail(applied.task.id, (path) => path !== "gone.md");
    expect(detail).toMatchObject({
      id: applied.task.id,
      goal: "写一份周报",
      kind: "周报",
      status: "active",
      brief: "写周报",
      revision: 1,
      revision_actor: "app",
      routine_id: null,
      ticket_counts: { todo: 0, doing: 1, review: 0, done: 0, parked: 0 },
    });
    expect(detail.spec).toEqual(spec({ acceptance: [] }));
    expect(detail.tickets).toHaveLength(1);
    expect(detail.tickets[0]!.artifacts).toMatchObject([{ path: `${ticket.dir}/draft.md`, exists: true }]);
    store.close();
  });
});

describe("whether a plan handed a ticket over since a moment", () => {
  test("a later version, or the board now, must show a ticket newly in review or done; rewording one that sits there is no move", () => {
    const { store, session, bot, reviewer } = fixture();
    const opener = store.postMessage(session.id, { body: "写周报" });
    const at = (second: number) => new Date(Date.UTC(2026, 8, 28, 1, 0, second));
    const plan = store.applyOrganizerResult({
      sessionId: session.id,
      current: null,
      result: result({
        decision: "new",
        tickets: [
          { id: "new-1", title: "初稿", spec: "写第一版", status: "review", worker: bot.id },
          { id: "new-2", title: "审稿", spec: "过一遍", status: "doing", worker: reviewer.id },
        ],
      }),
      source: { messageId: opener.id, turnId: null, messageBody: opener.body },
      now: at(0),
    });
    const [draft, review] = plan.tickets;
    const settle = (second: number, tickets: OrganizerResult["tickets"]) =>
      store.applyOrganizerResult({
        sessionId: session.id,
        current: store.getTask(plan.task.id),
        result: result({ tickets }),
        source: { messageId: null, turnId: null, messageBody: "" },
        now: at(second),
      });
    const movedSince = (second: number) => store.ticketHandedOverSince(plan.task.id, at(second).toISOString());

    expect(movedSince(1)).toBe(false);
    // Rewording the ticket already awaiting review is a new version, not a move.
    settle(2, [{ id: draft!.id, spec: "写第一版，加上图表" }]);
    expect(movedSince(1)).toBe(false);
    // The other ticket handed over in a later version is.
    settle(3, [{ id: review!.id, spec: "", status: "review" }]);
    expect(movedSince(1)).toBe(true);
    // A version that repeats the board as it stood is not.
    settle(5, []);
    expect(movedSince(4)).toBe(false);
    // Sent back, then handed over again: a move, although it ends where it began.
    settle(6, [{ id: draft!.id, spec: "", status: "doing" }]);
    settle(7, [{ id: draft!.id, spec: "", status: "review" }]);
    expect(movedSince(5)).toBe(true);
    // A ticket opened already awaiting review is one.
    expect(movedSince(8)).toBe(false);
    settle(9, [{ id: "new-1", title: "排版", spec: "排好版", status: "review", worker: bot.id }]);
    expect(movedSince(8)).toBe(true);

    // The app's own move to review leaves no version: the board now shows it.
    settle(11, [{ id: draft!.id, spec: "", status: "doing" }]);
    expect(movedSince(12)).toBe(false);
    expect(store.observeTicketWork({ ticketId: draft!.id, botId: bot.id, seen: "delivered", now: at(13) })).toMatchObject({ status: "review" });
    expect(movedSince(12)).toBe(true);
    // A ticket untouched since the moment did not move after it, whatever the last version said.
    expect(movedSince(14)).toBe(false);

    // Your edit marking one done is a version of the plan too.
    store.patchTicketByUser(review!.id, { status: "done" });
    expect(movedSince(15)).toBe(true);
    store.close();
  });
});
