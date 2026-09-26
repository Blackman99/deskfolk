import { describe, expect, test } from "bun:test";
import type { ClientEvent } from "@real-bot/protocol";
import { Store } from ".";
import { HttpError } from "../errors";
import { normalizePlanSpec, parsePlanSpec, SPEC_GOAL_MAX, SPEC_ITEM_MAX, SPEC_LIST_MAX, type PlanSpec } from "./plan-shape";
import { ORGANIZER_NEW_TICKETS_MAX, type OrganizerResult } from "./plan-spec";

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
    expect(parsePlanSpec(applied.task.spec)).toEqual(spec());
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
    expect(parsePlanSpec(second.task.spec)?.rules).toEqual(["先给 Reviewer 过一遍"]);
    expect(second.revision.revision).toBe(2);
    store.close();
  });

  test("resumes only a plan this session had before, else continues; new parks the current one", () => {
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

    // A resume of a plan that is not this session's recent history is a continue.
    const other = store.createBot({ name: "Other", duties: "x", boundaries: "y" });
    const elsewhere = store.openTask({ sessionId: other.direct_session.id, title: "别处的事" });
    const c = store.postMessage(session.id, { body: "回到那件事" });
    const stayed = store.applyOrganizerResult({
      sessionId: session.id,
      current: store.sessionCurrentTask(session.id),
      result: result({ decision: "resume", resumePlanId: elsewhere.id, spec: spec({ kind: "会议室", goal: "订会议室" }) }),
      source: { messageId: c.id, turnId: null, messageBody: c.body },
    });
    expect(stayed.task.id).toBe(planB.id);

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

  test("raises plan and ticket events as it goes, and a cleared session takes them away", () => {
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

    store.clearSessionMessages(session.id);
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
    expect(detail.spec).toEqual(spec());
    expect(detail.tickets).toHaveLength(1);
    expect(detail.tickets[0]!.artifacts).toMatchObject([{ path: `${ticket.dir}/draft.md`, exists: true }]);
    store.close();
  });
});
