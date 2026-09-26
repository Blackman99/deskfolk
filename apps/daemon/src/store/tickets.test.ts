import { describe, expect, test } from "bun:test";
import { Store } from ".";
import { HttpError } from "../errors";
import { PLAN_MAP_FILE, TICKET_FILE } from "./tasks";
import { TICKET_SPEC_MAX, TICKET_TITLE_MAX, TICKETS_MAX, ticketDirName } from "./tickets";

function fixture() {
  const store = new Store();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const plan = store.openTask({ sessionId: writer.direct_session.id, title: "写周报" });
  return { store, bot: writer.bot, session: writer.direct_session, plan };
}

function status(error: unknown): number {
  return error instanceof HttpError ? error.status : -1;
}

describe("ticket dir naming", () => {
  const plan = "work/写周报-7f3k";

  test("numbers the folder, keeps CJK, and clips the slug", () => {
    expect(ticketDirName(plan, 1, "初稿")).toBe(`${plan}/01-初稿`);
    expect(ticketDirName(plan, 12, "fix  the a/b?c test")).toBe(`${plan}/12-fix-the-a-b-c-test`);
  });

  test("a title that leaves no slug still yields a numbered folder", () => {
    expect(ticketDirName(plan, 3, "???")).toBe(`${plan}/03`);
  });
});

describe("tickets of a plan", () => {
  test("are numbered in order, live under the plan dir, and start open", () => {
    const { store, plan } = fixture();
    const first = store.createTicket({ taskId: plan.id, title: "初稿", spec: "写出第一版", worker: null });
    const second = store.createTicket({ taskId: plan.id, title: "配图", status: "doing", worker: null });
    expect(first).toMatchObject({ task_id: plan.id, seq: 1, title: "初稿", spec: "写出第一版", status: "todo", worker: null, closed_at: null });
    expect(first.dir).toBe(`${plan.dir}/01-初稿`);
    expect(second).toMatchObject({ seq: 2, status: "doing", closed_at: null });
    expect(second.dir).toBe(`${plan.dir}/02-配图`);
    expect(store.listTickets(plan.id).map((row) => row.id)).toEqual([first.id, second.id]);
    expect(store.listTicketDirs(plan.id)).toEqual([first.dir, second.dir]);
    store.close();
  });

  test("one opened as done is closed on the spot; a blank title or a made-up status is refused", () => {
    const { store, plan } = fixture();
    const done = store.createTicket({ taskId: plan.id, title: "已经交了", status: "done", worker: null });
    expect(done.closed_at).toBeString();
    let refused: unknown;
    try {
      store.createTicket({ taskId: plan.id, title: "   ", worker: null });
    } catch (error) {
      refused = error;
    }
    expect(status(refused)).toBe(422);
    try {
      store.createTicket({ taskId: plan.id, title: "x", status: "later", worker: null });
    } catch (error) {
      refused = error;
    }
    expect(status(refused)).toBe(422);
    expect(store.listTickets(plan.id)).toHaveLength(1);
    store.close();
  });

  test("a plan holds at most the cap; the one past it is refused", () => {
    const { store, plan } = fixture();
    for (let i = 0; i < TICKETS_MAX; i += 1) store.createTicket({ taskId: plan.id, title: `任务 ${i + 1}`, worker: null });
    let refused: unknown;
    try {
      store.createTicket({ taskId: plan.id, title: "多出来的", worker: null });
    } catch (error) {
      refused = error;
    }
    expect(status(refused)).toBe(422);
    expect(store.listTickets(plan.id)).toHaveLength(TICKETS_MAX);
    store.close();
  });

  test("a patch changes only what it names, closes on done, reopens on doing, and is a no-op when nothing moved", () => {
    const { store, plan, bot } = fixture();
    const ticket = store.createTicket({ taskId: plan.id, title: "初稿", spec: "第一版", worker: null });
    const same = store.patchTicket(ticket.id, { title: "初稿" });
    expect(same.updated_at).toBe(ticket.updated_at);

    const closed = store.patchTicket(ticket.id, { status: "done", worker: bot.id }, { now: new Date(Date.now() + 1000) });
    expect(closed).toMatchObject({ title: "初稿", spec: "第一版", status: "done", worker: bot.id });
    expect(closed.closed_at).toBeString();
    expect(closed.updated_at).not.toBe(ticket.updated_at);

    const reopened = store.patchTicket(ticket.id, { status: "doing", spec: "  第二版  " });
    expect(reopened).toMatchObject({ status: "doing", spec: "第二版", worker: bot.id, closed_at: null });

    const clipped = store.patchTicket(ticket.id, { title: "长".repeat(TICKET_TITLE_MAX + 5), spec: "多".repeat(TICKET_SPEC_MAX + 5) });
    expect([...clipped.title]).toHaveLength(TICKET_TITLE_MAX);
    expect([...clipped.spec]).toHaveLength(TICKET_SPEC_MAX);
    store.close();
  });

  test("a ticket's artifacts are what its own messages cited, minus the app's files and what is gone", () => {
    const { store, plan, bot, session } = fixture();
    const mine = store.createTicket({ taskId: plan.id, title: "初稿", worker: null });
    const theirs = store.createTicket({ taskId: plan.id, title: "配图", worker: null });
    const trigger = store.postMessage(session.id, { body: "开始吧" });
    const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: trigger.id, taskId: plan.id, ticketId: mine.id });
    expect(turn.ticket_id).toBe(mine.id);
    expect(store.turnWorkDir(turn.id)).toBe(mine.dir);
    expect(store.turnPlanDir(turn.id)).toBe(plan.dir);
    store.insertMessage({
      sessionId: session.id,
      turnId: turn.id,
      kind: "bot",
      author: bot.id,
      body: "初稿在 draft.md",
      paths: [`${mine.dir}/draft.md`, `${mine.dir}/tool-results/01J.json`, `${mine.dir}/scratch/probe.py`, `${plan.dir}/${PLAN_MAP_FILE}`, `${mine.dir}/${TICKET_FILE}`, "gone.md"],
    });
    const other = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: trigger.id, taskId: plan.id, ticketId: theirs.id });
    store.insertMessage({ sessionId: session.id, turnId: other.id, kind: "bot", author: bot.id, body: "图", paths: [`${theirs.dir}/chart.png`] });

    const listed = store.ticketArtifacts(mine.id, (path) => path !== "gone.md");
    expect(listed.map((row) => row.path)).toEqual([`${mine.dir}/draft.md`]);
    expect(listed[0]).toMatchObject({ message_id: expect.any(String), attachment_id: expect.any(String) });
    expect(store.ticketArtifacts(theirs.id, () => true).map((row) => row.path)).toEqual([`${theirs.dir}/chart.png`]);
    // The plan's own list carries the ticket each file was filed under.
    const plans = store.taskArtifacts(plan.id, () => true);
    expect(plans.map((row) => [row.path, row.ticket_id]).sort()).toEqual([
      ["gone.md", mine.id],
      [`${mine.dir}/draft.md`, mine.id],
      [`${theirs.dir}/chart.png`, theirs.id],
    ]);
    store.close();
  });
});
