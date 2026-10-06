import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import * as domain from "./work-on";
import { KeyCache, type StoreContext } from "./shared";
import { Transactions } from "./transactions";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store();
  stores.push(store);
  store.raiseEngineLevel(null);
  const { bot, direct_session } = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const ctx: StoreContext = {
    db: store.db, keys: new KeyCache({ get: async () => null, set: async () => {}, delete: async () => {} }, store.db),
    commit: (work) => store.transaction(work), tx: new Transactions(store.db), inboxRoot: "", activeStages: new Set(),
    keyPlan: null, legacy: { copiedKey: false },
  };
  const line = store.postMessage(direct_session.id, { body: "Write an original report" });
  const turn = store.createTurn({ sessionId: direct_session.id, botId: bot.id, triggerMessageId: line.id });
  return { store, ctx, bot, sessionId: direct_session.id, line, turn };
}

function counts(store: Store) {
  return ["tasks", "tickets", "work_items", "inbox_items", "messages", "work_events"].map((table) =>
    store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
}

test("a captured plan that becomes accepted or abandoned cannot be bound or reopen its job", () => {
  for (const stage of ['accepted', 'abandoned'] as const) {
    const { store, ctx, bot, sessionId, turn: initial } = fixture();
    store.setTurnStatus(initial.id, 'completed');
    const plan = store.openTask({ sessionId, title: 'Captured' });
    const line = store.postMessage(sessionId, { body: 'Follow up' });
    const turn = store.createTurn({ sessionId, botId: bot.id, triggerMessageId: line.id });
    store.db.run('UPDATE tasks SET stage = ? WHERE id = ?', [stage, plan.id]);
    const before = counts(store);
    expect(() => domain.workOn(ctx, { turnId: turn.id, plan: plan.id })).toThrow('no longer runnable');
    expect(counts(store)).toEqual(before);
    expect(store.getTurn(turn.id)).toMatchObject({ task_id: null, mode: 'desk' });
  }
});

test("a default may split before acting, but durable directory use or in-flight writes reject new work without orphans", () => {
  for (const evidence of ['none', 'persisted', 'written'] as const) {
    const { store, ctx, bot, sessionId, turn: initial } = fixture();
    store.setTurnStatus(initial.id, 'completed');
    const existing = store.openTask({ sessionId, title: 'Default candidate' });
    const line = store.postMessage(sessionId, { body: 'Another deliverable the reading took for the old job' });
    store.fileMessage(line.id, { botId: bot.id, read: { source: 'model', about: 'jobs', targets: [{ taskId: existing.id, ticketId: null, partKey: null }] } });
    const turn = store.createTurn({ sessionId, botId: bot.id, triggerMessageId: line.id });
    expect(turn.task_id).toBe(existing.id);
    if (evidence === 'persisted') store.markWorkDirectoryUsed(turn.id);
    const before = counts(store);
    const input = { turnId: turn.id, plan: { new: { quote_message_id: line.id, title: 'Split' } },
      ...(evidence === 'written' ? { writtenPaths: ['work/already-written.txt'] } : {}) };
    if (evidence === 'none') {
      const result = domain.workOn(ctx, input);
      expect(result.taskId).not.toBe(existing.id);
      expect(store.getMessage(line.id).task_id).toBe(result.taskId);
    } else {
      expect(() => domain.workOn(ctx, input)).toThrow('already acted');
      expect(counts(store)).toEqual(before);
      expect(store.getTurn(turn.id).task_id).toBe(existing.id);
    }
  }
});

test("an ended segment cannot mutate a new job, and a read-only answer cannot bind even a captured candidate", () => {
  const { store, ctx, bot, sessionId, line, turn } = fixture();
  store.setTurnStatus(turn.id, 'completed');
  const before = counts(store);
  expect(() => domain.workOn(ctx, { turnId: turn.id, plan: { new: { quote_message_id: line.id } } })).toThrow('no longer running');
  expect(counts(store)).toEqual(before);
  const plan = store.openTask({ sessionId, title: 'Candidate' });
  const question = store.postMessage(sessionId, { body: 'What is happening?' });
  const readonly = store.createTurn({ sessionId, botId: bot.id, triggerMessageId: question.id, mode: 'readonly' });
  expect(() => domain.workOn(ctx, { turnId: readonly.id, plan: plan.id })).toThrow('read-only');
});

test("merging keeps the busy segment's exact binding and delivers the original trigger once", () => {
  const { store, ctx, bot, sessionId, turn: initial } = fixture();
  store.setTurnStatus(initial.id, 'completed');
  const plan = store.openTask({ sessionId, title: 'Busy' });
  const firstTicket = store.createTicket({ taskId: plan.id, title: 'Already running' });
  const requestedTicket = store.createTicket({ taskId: plan.id, title: 'New request' });
  const opening = store.postMessage(sessionId, { body: 'First request' });
  store.fileMessage(opening.id, { explicit: [{ taskId: plan.id, ticketId: firstTicket.id }] });
  const busy = store.createTurn({ sessionId, botId: bot.id, triggerMessageId: opening.id, taskId: plan.id, ticketId: firstTicket.id });
  const line = store.postMessage(sessionId, { body: 'Additional request' });
  const desk = store.createTurn({ sessionId, botId: bot.id, triggerMessageId: line.id });
  const result = domain.workOn(ctx, { turnId: desk.id, plan: plan.id, ticket: requestedTicket.id });
  expect(result).toEqual({ mergedInto: busy.id, ended: true, messages: [], filed: [line.id] });
  expect(store.getTurn(busy.id)).toMatchObject({ task_id: plan.id, ticket_id: firstTicket.id });
  expect(store.getTurn(desk.id).end_reason).toBe('merged');
  const first = store.db.query('SELECT message_id, body_snapshot FROM inbox_items WHERE turn_id = ?').all(busy.id);
  expect(first).toEqual([{ message_id: line.id, body_snapshot: line.body }]);
  domain.workOn(ctx, { turnId: desk.id, plan: plan.id, ticket: requestedTicket.id });
  expect(store.db.query('SELECT seq FROM inbox_items WHERE turn_id = ? AND message_id = ?').all(busy.id, line.id)).toHaveLength(1);
});

test("a fresh job at parallel capacity queues durably, with no new-plan card, but never becomes a third working segment", () => {
  const { store, ctx, bot, sessionId, turn: initial } = fixture();
  store.setTurnStatus(initial.id, 'completed');
  for (const title of ['First job', 'Second job']) {
    const plan = store.openTask({ sessionId, title });
    const line = store.postMessage(sessionId, { body: title });
    store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
    store.createTurn({ sessionId, botId: bot.id, triggerMessageId: line.id, taskId: plan.id });
  }
  const line = store.postMessage(sessionId, { body: '另外写份新报告' });
  const desk = store.createTurn({ sessionId, botId: bot.id, triggerMessageId: line.id });
  const result = domain.workOn(ctx, { turnId: desk.id, plan: { new: { title: 'Third job', quote_message_id: line.id } } });
  expect(result.queued).toBe(true);
  expect(result.ended).toBe(true);
  expect(typeof result.taskId).toBe('string');
  expect(typeof result.workItemId).toBe('string');
  expect(store.getTurn(desk.id)).toMatchObject({ mode: 'desk', task_id: null, end_reason: 'queued' });
  expect(store.db.query("SELECT COUNT(*) AS n FROM turns WHERE mode = 'work' AND status = 'running'").get()).toEqual({ n: 2 });
  expect(store.db.query('SELECT state FROM work_items WHERE id = ?').get(result.workItemId!)).toEqual({ state: 'queued' });
  expect(store.db.query('SELECT task_id, message_id, state FROM inbox_items WHERE work_item_id = ?').all(result.workItemId!)).toEqual([{ task_id: result.taskId, message_id: line.id, state: 'queued' }]);
  expect(result.messages.map((message) => message.control?.kind ?? null)).toEqual([null]);
});

test("contract selections validate the frozen candidate, exact ticket, same-bot also, and quote conversation without partial writes", () => {
  const { store, ctx, bot, sessionId, turn: initial } = fixture();
  store.setTurnStatus(initial.id, 'completed');
  const a = store.openTask({ sessionId, title: 'A' });
  const b = store.openTask({ sessionId, title: 'B' });
  const ticket = store.createTicket({ taskId: b.id, title: 'Draft' });
  const line = store.postMessage(sessionId, { body: 'Pick one' });
  const turn = store.createTurn({ sessionId, botId: bot.id, triggerMessageId: line.id });
  const foreign = store.createBot({ name: 'Foreign', duties: 'none', boundaries: 'none' });
  const foreignPlan = store.openTask({ sessionId: foreign.direct_session.id, title: 'Foreign plan' });
  const foreignLine = store.postMessage(foreign.direct_session.id, { body: 'Wrong conversation' });
  const otherItem = store.findOrCreateWorkItem({ botId: foreign.bot.id, sessionId, taskId: a.id, ticketId: null });
  const before = counts(store);
  for (const selection of [
    { plan: foreignPlan.id }, { plan: a.id, ticket: ticket.id }, { plan: a.id, also: [otherItem.id] },
    { plan: { new: { quote_message_id: foreignLine.id } } },
  ]) {
    expect(() => domain.workOn(ctx, { turnId: turn.id, ...selection })).toThrow();
    expect(counts(store)).toEqual(before);
  }
  const sameBot = store.findOrCreateWorkItem({ botId: bot.id, sessionId, taskId: b.id, ticketId: ticket.id });
  const result = domain.workOn(ctx, { turnId: turn.id, plan: a.id, also: [sameBot.id] });
  expect(result.taskId).toBe(a.id);
  expect(store.getMessage(line.id).filings).toMatchObject([{ task_id: a.id }, { task_id: b.id, ticket_id: ticket.id }]);
});

test("a continued desk uses the original user's quote rather than its app note", () => {
  const { store, ctx, line, turn } = fixture();
  const interrupted = store.interruptTurnRecord(turn.id)!;
  const continued = store.claimInterruptContinue(interrupted.note.id);
  const result = domain.workOn(ctx, { turnId: continued.id, plan: { new: { quote_message_id: line.id, title: 'Continued request' } } });
  expect(store.getTask(result.taskId!).brief).toBe(line.body);
  expect(store.getMessage(line.id).task_id).toBe(result.taskId);
  expect(store.listWorkEvents({ kind: "plan.opened" }).at(-1)?.payload).toMatchObject({ quote_message_id: line.id });
});

test("a held desk or a malformed ticket cannot leave a created plan, ticket, filing, work event or visible card", () => {
  const { store, ctx, bot, sessionId, turn, line } = fixture();
  const before = counts(store);
  const fresh = { new: { title: 'No orphan', quote_message_id: line.id } };
  expect(() => domain.workOn(ctx, { turnId: turn.id, plan: fresh, ticket: { invalid: true } })).toThrow();
  expect(counts(store)).toEqual(before);
  const hold = store.createHold({ scope: 'bot', scopeId: bot.id, source: 'user_button' });
  const heldCounts = counts(store);
  expect(() => domain.workOn(ctx, { turnId: turn.id, plan: fresh })).toThrow('a stop');
  expect(counts(store)).toEqual(heldCounts);
  expect(store.getMessage(line.id).task_id).toBeNull();
  expect(store.getHold(hold.id).lifted_at).toBeNull();
  expect(store.getTurn(turn.id)).toMatchObject({ task_id: null, mode: 'desk', session_id: sessionId });
});

test("work_on atomically opens a quoted job, owns its exact ticket and files the words, with no new-job card", () => {
  const { store, ctx, bot, turn, line } = fixture();
  const result = domain.workOn(ctx, { turnId: turn.id,
    plan: { new: { title: "Report", quote_message_id: line.id } },
    ticket: { new: { title: "Draft", deliverable: "report.md" } },
  });
  expect(result.ended).toBeUndefined();
  expect(typeof result.taskId).toBe('string');
  expect(typeof result.ticketId).toBe('string');
  expect(typeof result.workItemId).toBe('string');
  expect(store.getTurn(turn.id)).toMatchObject({ task_id: result.taskId, ticket_id: result.ticketId, work_item_id: result.workItemId, mode: "work" });
  expect(store.getTicket(result.ticketId!)).toMatchObject({ title: "Draft", spec: "report.md", worker: bot.id });
  expect(store.getTask(result.taskId!)).toMatchObject({ title: "Report", brief: "Write an original report" });
  expect(store.getMessage(line.id).filings).toMatchObject([{ task_id: result.taskId, ticket_id: result.ticketId, strength: "bot" }]);
  expect(result.messages).toEqual([]);
  expect(store.db.query("SELECT state FROM work_items WHERE id = ?").get(turn.work_item_id!)).toEqual({ state: "closed" });
});

test("a segment on a job may name one of its tickets where the job goes; naming something else says which job it is on", () => {
  const { store, ctx, bot, sessionId, line, turn } = fixture();
  const opened = domain.workOn(ctx, { turnId: turn.id, plan: { new: { quote_message_id: line.id, title: "Report" } } });
  const outline = store.createTicket({ taskId: opened.taskId!, title: "Outline", worker: bot.id });
  // As after plan_items folded the opening ticket: the segment is on the whole job.
  store.db.run("UPDATE turns SET ticket_id = NULL WHERE id = ?", [turn.id]);
  // The ticket's id given as the job: that job, and that ticket (2026-10-04, large-job run).
  const bound = domain.workOn(ctx, { turnId: turn.id, plan: outline.id });
  expect(bound).toMatchObject({ taskId: opened.taskId, ticketId: outline.id });
  expect(store.getTurn(turn.id)).toMatchObject({ task_id: opened.taskId, ticket_id: outline.id });
  // Anything else that is no candidate: the refusal names the job the segment is on.
  expect(() => domain.workOn(ctx, { turnId: turn.id, plan: "01M00000000000000000000000" }))
    .toThrow(`This segment is already on job ${opened.taskId}`);
  void sessionId;
});
