import { afterEach, expect, test } from "bun:test";
import { Store } from "./index";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store();
  stores.push(store);
  store.raiseEngineLevel(null);
  const { bot, direct_session: session } = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const plans = ["Report", "Website", "Book", "Notes"].map((title) => store.openTask({ sessionId: session.id, title }));
  return { store, bot, session, plans };
}

test("the Bot's positive parallel limit controls admission while a desk and the same job stay exempt", () => {
  const { store, bot, session, plans } = fixture();
  store.db.run("UPDATE bots SET parallel_limit = 1 WHERE id = ?", [bot.id]);
  const line = store.postMessage(session.id, { body: "Write the report" });
  store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: line.id, taskId: plans[0]!.id });
  expect(store.workItemQueuePlace({ botId: bot.id, taskId: plans[1]!.id })).toBe(1);
  expect(store.workItemQueuePlace({ botId: bot.id, taskId: plans[0]!.id })).toBeNull();
  expect(store.workItemQueuePlace({ botId: bot.id, taskId: null })).toBeNull();
});

test("queue admission keeps one wake and one visible notice per request, with distinct-job positions", () => {
  const { store, bot, session, plans } = fixture();
  for (const plan of plans.slice(0, 2)) {
    const line = store.postMessage(session.id, { body: `Work on ${plan.title}` });
    store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: line.id, taskId: plan.id });
  }
  const third = store.postMessage(session.id, { body: "Write the book" });
  const input = { botId: bot.id, sessionId: session.id, taskId: plans[2]!.id, ticketId: null,
    messageId: third.id, author: "user", body: third.body };
  const queued = store.queueWork(input);
  expect(queued.position).toBe(1);
  expect(queued.workItem.state).toBe("queued");
  expect(queued.inbox.body_snapshot).toBe("Write the book");
  expect(queued.message?.body).toContain("排在第 1 位");
  const replayed = store.queueWork(input);
  expect(replayed.workItem.id).toBe(queued.workItem.id);
  expect(replayed.inbox.id).toBe(queued.inbox.id);
  expect(replayed.message).toBeNull();
  const fourth = store.postMessage(session.id, { body: "Write the notes" });
  expect(store.queueWork({ ...input, taskId: plans[3]!.id, messageId: fourth.id, body: fourth.body }).position).toBe(2);
});

test("a failed queue notice rolls back work and wake without publishing partial events", () => {
  const { store, bot, session, plans } = fixture();
  const line = store.postMessage(session.id, { body: "Write the book" });
  const events: string[] = [];
  store.onCommit((event) => events.push(event.event));
  store.db.run(`CREATE TEMP TRIGGER refuse_queue_notice BEFORE INSERT ON messages
    WHEN NEW.kind = 'system' BEGIN SELECT RAISE(ABORT, 'notice refused'); END`);
  expect(() => store.queueWork({ botId: bot.id, sessionId: session.id, taskId: plans[2]!.id, ticketId: null,
    messageId: line.id, author: "user", body: line.body })).toThrow("notice refused");
  expect(store.getMessage(line.id).delivery).toBeUndefined();
  expect(store.dispatchableWork()).toEqual([]);
  expect(events).toEqual([]);
});

test("cleared queued work waits for resume then recreates a private system trigger from its retained words", () => {
  const { store, bot, session, plans } = fixture();
  const line = store.postMessage(session.id, { body: "Write the book from these notes" });
  const queued = store.queueWork({ botId: bot.id, sessionId: session.id, taskId: plans[2]!.id, ticketId: null,
    messageId: line.id, author: "user", body: line.body });
  store.clearSessionMessages(session.id);
  expect(store.dispatchableWork()).toEqual([]);
  expect(store.prepareQueuedTrigger(queued.workItem.id)).toBeNull();
  store.resumePlan(plans[2]!.id);
  const trigger = store.prepareQueuedTrigger(queued.workItem.id);
  expect(trigger?.kind).toBe("system");
  expect(trigger?.author).toBe(bot.id);
  expect(trigger?.body).toBe("Write the book from these notes");
  expect(trigger?.task_id).toBe(plans[2]!.id);
  expect(store.prepareQueuedTrigger(queued.workItem.id)?.id).toBe(trigger?.id);
  expect(store.listMessages(session.id).items).toEqual([]);
  const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: trigger!.id,
    taskId: plans[2]!.id });
  store.markWorkRunning(queued.workItem.id);
  store.adoptWaitingInbox({ botId: bot.id, sessionId: session.id, turnId: turn.id });
  expect(store.queuedForTurn(turn.id)[0]?.body_snapshot).toBe("Write the book from these notes");
  expect(store.dispatchableWork()).toEqual([]);
});

test("dispatch picks waking work by priority, excludes held work and leaves closed items terminal", () => {
  const { store, bot, session, plans } = fixture();
  const queued = plans.slice(0, 3).map((plan, index) => {
    const line = store.postMessage(session.id, { body: `Work on ${plan.title}` });
    return store.queueWork({ botId: bot.id, sessionId: session.id, taskId: plan.id, ticketId: null,
      messageId: line.id, author: "user", body: line.body, priority: index === 1 ? 1 : 3, wakes: index !== 2 });
  });
  expect(store.dispatchableWork().map((item) => item.id)).toEqual([queued[1]!.workItem.id, queued[0]!.workItem.id]);
  store.createHold({ scope: "plan", scopeId: plans[1]!.id, source: "user_button" });
  expect(store.dispatchableWork().map((item) => item.id)).toEqual([queued[0]!.workItem.id]);
  store.markWorkRunning(queued[0]!.workItem.id);
  expect(store.findOrCreateWorkItem({ botId: bot.id, sessionId: session.id, taskId: plans[0]!.id, ticketId: null }).state).toBe("running");
  store.closeWorkItemIfIdle(queued[0]!.workItem.id);
  store.markWorkRunning(queued[0]!.workItem.id);
  expect(store.dispatchableWork()).toEqual([]);
});

test("dispatch uses the recipient's work thread and never wakes terminal plans or a Bot that left", () => {
  const { store, bot, session, plans } = fixture();
  const other = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
  const thread = store.createBotDirect(bot.id, other.bot.id, null);
  const line = store.postMessage(session.id, { body: "Review the report" });
  const queued = store.queueWork({ botId: bot.id, sessionId: session.id, taskId: plans[0]!.id, ticketId: null,
    messageId: line.id, author: "user", body: line.body });
  store.db.run("UPDATE work_items SET thread_session_id = ? WHERE id = ?", [thread.id, queued.workItem.id]);
  expect(store.dispatchableWork()[0]?.home_session_id).toBe(thread.id);
  for (const stage of ["accepted", "abandoned"]) {
    store.db.run("UPDATE tasks SET stage = ? WHERE id = ?", [stage, plans[0]!.id]);
    expect(store.dispatchableWork()).toEqual([]);
  }
  store.db.run("UPDATE tasks SET stage = 'active' WHERE id = ?", [plans[0]!.id]);
  store.db.run("UPDATE session_participants SET left_at = ? WHERE session_id = ? AND member = ?", ["2026-10-01T00:00:00.000Z", thread.id, bot.id]);
  expect(store.dispatchableWork()).toEqual([]);
});

test("the oldest delegation keeps its own pair thread when another delegator reuses that work item", () => {
  const { store, bot } = fixture();
  const b = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
  const c = store.createBot({ name: "Director", duties: "direct", boundaries: "none" });
  const session = store.createGroup({ name: "Studio", members: [bot.id, b.bot.id, c.bot.id] });
  const plan = store.openTask({ sessionId: session.id, title: "Movie" });
  const aLine = store.postMessage(session.id, { body: "Review version A" });
  const aTurn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: aLine.id, taskId: plan.id });
  const cLine = store.postMessage(session.id, { body: "Review version C" });
  const cTurn = store.createTurn({ sessionId: session.id, botId: c.bot.id, triggerMessageId: cLine.id, taskId: plan.id });
  const first = store.delegateWork({ fromTurnId: aTurn.id, toBotId: b.bot.id, ask: "Review version A", expects: "answer" });
  const next = store.delegateWork({ fromTurnId: cTurn.id, toBotId: b.bot.id, ask: "Review version C", expects: "answer" });
  expect(first.delegation.to_work_item_id).toBe(next.delegation.to_work_item_id);
  const target = store.dispatchableWork().find((item) => item.bot_id === b.bot.id)!;
  expect(target.home_session_id).toBe(first.delegation.thread_session_id);
});

test("only active or delivered non-dormant plans are runnable, and lifting a hold does not reopen an abandoned plan", () => {
  const { store, plans } = fixture();
  const plan = plans[0]!;
  expect(store.isPlanRunnable("missing-plan")).toBe(false);
  for (const stage of ["active", "delivered"]) {
    store.db.run("UPDATE tasks SET stage = ?, dormant_since = NULL WHERE id = ?", [stage, plan.id]);
    expect(store.isPlanRunnable(plan.id)).toBe(true);
  }
  store.db.run("UPDATE tasks SET dormant_since = ? WHERE id = ?", ["2026-10-01T00:00:00.000Z", plan.id]);
  expect(store.isPlanRunnable(plan.id)).toBe(false);
  store.resumePlan(plan.id);
  expect(store.isPlanRunnable(plan.id)).toBe(true);
  store.db.run("UPDATE tasks SET stage = 'accepted' WHERE id = ?", [plan.id]);
  expect(store.isPlanRunnable(plan.id)).toBe(false);
  store.db.run("UPDATE tasks SET stage = 'abandoned' WHERE id = ?", [plan.id]);
  const hold = store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
  store.liftHold(hold.id, { by: "user_button" });
  expect(store.isPlanRunnable(plan.id)).toBe(false);
});
