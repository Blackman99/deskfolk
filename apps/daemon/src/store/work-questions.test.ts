import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import { createWorkQuestion, answerWorkQuestion } from "./work-questions";
import { migrateSchema } from "./migrate";
import { KeyCache, type StoreContext } from "./shared";
import { Transactions } from "./transactions";
import { ENGINE_LEVELS } from "./schema-gate";

const stores: Store[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });
function fixture() {
  const store = new Store(); stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings(key,value) VALUES ('engine_level', ?)", [String(ENGINE_LEVELS.supervision)]);
  const bot = store.createBot({ name: "Owner", duties: "work", boundaries: "stay" });
  const peer = store.createBot({ name: "Peer", duties: "work", boundaries: "stay" }).bot;
  const group = store.createGroup({ name: "Home", members: [bot.bot.id, peer.id] });
  const thread = store.createBotDirect(bot.bot.id, peer.id, null);
  const task = store.openTask({ sessionId: group.id, title: "Task" });
  const source = store.insertMessage({ sessionId: thread.id, kind: "bot", author: peer.id, body: "Do it" });
  const turn = store.createTurn({ sessionId: thread.id, botId: bot.bot.id, triggerMessageId: source.id, taskId: task.id });
  const ctx: StoreContext = { db: store.db, keys: new KeyCache({ get: async () => null, set: async () => {}, delete: async () => {} }, store.db),
    commit: (work) => store.transaction(work), tx: new Transactions(store.db), inboxRoot: "", activeStages: new Set(), keyPlan: null, legacy: { copiedKey: false } };
  return { store, ctx, bot, peer, group, thread, task, turn };
}

test("work question from a Bot-only thread is moved where the user can answer, keeps original segment provenance and creates no legacy ask", () => {
  const h = fixture();
  expect(() => createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Choose" })).toThrow("blocked");
  h.store.finishWork({ turnId: h.turn.id, reason: "blocked", needsFromUser: "Choose" });
  h.store.setTurnStatus(h.turn.id, "completed");
  const question = createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Choose" });
  expect(question).toMatchObject({ kind: "system", author: h.bot.bot.id, source_turn_id: h.turn.id,
    session_id: h.group.id, control: { kind: "work_question", task_id: h.task.id, work_item_id: h.turn.work_item_id } });
  expect(createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Choose" }).id).toBe(question.id);
  expect(() => createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Replace the question" })).toThrow("question changed");
  expect(h.store.db.query("SELECT id FROM messages WHERE kind = 'ask'").all()).toEqual([]);
  const answer = answerWorkQuestion(h.ctx, question.id, { body: "Version 3", userActionId: "answer-1" });
  expect(answer).toMatchObject({ answered: true, inbox_state: "queued" });
  expect(answerWorkQuestion(h.ctx, question.id, { body: "Version 3", userActionId: "answer-1" }).answered).toBe(false);
  expect(() => answerWorkQuestion(h.ctx, question.id, { body: "Version 4", userActionId: "answer-1" })).toThrow("already answered");
  expect(h.store.db.query("SELECT count(*) AS n FROM user_quotes WHERE message_id = ?").get(question.id)).toEqual({ n: 1 });
  h.store.db.run("UPDATE work_items SET state = 'closed', closed_at = ? WHERE id = ?", [new Date().toISOString(), h.turn.work_item_id!]);
  expect(answerWorkQuestion(h.ctx, question.id, { body: "Version 3", userActionId: "answer-1" }).answered).toBe(false);
  expect(h.store.db.query("SELECT state FROM work_items WHERE id = ?").get(h.turn.work_item_id!)).toEqual({ state: "closed" });
});

test("an older unanswered card cannot answer a later segment's different blocked question", () => {
  const h = fixture();
  h.store.finishWork({ turnId: h.turn.id, reason: "blocked", needsFromUser: "Old question" });
  h.store.setTurnStatus(h.turn.id, "completed");
  const old = createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Old question" });
  const nextTrigger = h.store.postMessage(h.group.id, { body: "Try a different approach" });
  const next = h.store.createTurn({ sessionId: h.group.id, botId: h.bot.bot.id, triggerMessageId: nextTrigger.id, taskId: h.task.id });
  h.store.finishWork({ turnId: next.id, reason: "blocked", needsFromUser: "New question" });
  h.store.setTurnStatus(next.id, "completed");
  const latest = createWorkQuestion(h.ctx, { turnId: next.id, body: "New question" });
  expect(() => answerWorkQuestion(h.ctx, old.id, { body: "Old answer", userActionId: "old-answer" })).toThrow("current question");
  expect(h.store.listQuotes({ messageId: old.id })).toEqual([]);
  expect(answerWorkQuestion(h.ctx, latest.id, { body: "New answer", userActionId: "new-answer" }).answered).toBe(true);
});

test("a card emitted while its source is finishing cannot answer until that segment has ended", () => {
  const h = fixture();
  h.store.finishWork({ turnId: h.turn.id, reason: "blocked", needsFromUser: "Choose" });
  const question = createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Choose" });
  expect(() => answerWorkQuestion(h.ctx, question.id, { body: "Answer", userActionId: "answer" })).toThrow("still ending");
  expect(h.store.listQuotes({ messageId: question.id })).toEqual([]);
  expect(h.store.db.query("SELECT id FROM inbox_items WHERE message_id = ?").all(question.id)).toEqual([]);
  h.store.setTurnStatus(h.turn.id, "completed");
  expect(answerWorkQuestion(h.ctx, question.id, { body: "Answer", userActionId: "answer" }).answered).toBe(true);
});

test("an answer goes on past your stop on the source conversation, though the work's public home is somewhere else", () => {
  const h = fixture();
  h.store.setTurnStatus(h.turn.id, "completed");
  h.store.db.run("UPDATE work_items SET home_session_id = ? WHERE id = ?", [h.group.id, h.turn.work_item_id!]);
  const source = h.store.insertMessage({ sessionId: h.thread.id, kind: "bot", author: h.peer.id, body: "Try again" });
  const from = h.store.createTurn({ sessionId: h.thread.id, botId: h.bot.bot.id, triggerMessageId: source.id, taskId: h.task.id });
  h.store.finishWork({ turnId: from.id, reason: "blocked", needsFromUser: "Choose" });
  h.store.setTurnStatus(from.id, "completed");
  const question = createWorkQuestion(h.ctx, { turnId: from.id, body: "Choose" });
  const hold = h.store.createHold({ scope: "session", scopeId: h.thread.id, source: "user_button" });
  // Your answer is your word to the Bot (ADR 0071): it ends a stop of yours over the conversation (ADR 0081).
  const answered = answerWorkQuestion(h.ctx, question.id, { body: "Answer", userActionId: "answer" });
  expect(answered.inbox_state).toBe("queued");
  h.store.refreshHeldInbox({ botId: h.bot.bot.id });
  expect(h.store.getInboxItem(answered.message.control?.kind === "work_question" ? answered.message.control.answer!.inbox_seq : 0)?.state).toBe("queued");
  expect(h.store.getHold(hold.id).lifted_at).not.toBeNull();
});

test("closed work and transcript-erased questions cannot resurrect or accept an answer", () => {
  const h = fixture();
  h.store.finishWork({ turnId: h.turn.id, reason: "blocked", needsFromUser: "Choose" });
  h.store.setTurnStatus(h.turn.id, "completed");
  const question = createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Choose" });
  h.store.db.run("UPDATE work_items SET state = 'closed', closed_at = ? WHERE id = ?", [new Date().toISOString(), h.turn.work_item_id!]);
  expect(() => answerWorkQuestion(h.ctx, question.id, { body: "Answer", userActionId: "answer" })).toThrow("no longer answerable");
  h.store.clearSessionMessages(question.session_id);
  expect(() => answerWorkQuestion(h.ctx, question.id, { body: "Answer", userActionId: "answer" })).toThrow();
  expect(h.store.db.query("SELECT id FROM inbox_items WHERE message_id = ?").all(question.id)).toEqual([]);
});

/** Your answer to the card in the group wakes the Bot in the job's own thread, on the card itself, as the queue dispatches it. */
function answerWakesThread(h: ReturnType<typeof fixture>) {
  h.store.finishWork({ turnId: h.turn.id, reason: "blocked", needsFromUser: "Choose" });
  h.store.setTurnStatus(h.turn.id, "completed");
  const question = createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Choose" });
  answerWorkQuestion(h.ctx, question.id, { body: "Version 3", userActionId: "answer" });
  const [work] = h.store.dispatchableWork();
  const trigger = h.store.prepareQueuedTrigger(work!.id)!;
  const woken = h.store.createTurn({ sessionId: work!.home_session_id, botId: work!.bot_id, triggerMessageId: trigger.id, taskId: work!.task_id });
  h.store.recordTurnRoute({ turnId: woken.id, decision: { model: "grk", thinkingLevel: "low", providerId: "", signature: "general" } });
  h.store.setTurnStatus(woken.id, "completed");
  expect({ turn: woken.session_id, trigger: trigger.session_id }).toEqual({ turn: h.thread.id, trigger: h.group.id });
  return { question, woken };
}

/** The line the woken turn points at afterwards, and the one its routing decision names. */
function wokenTrigger(h: ReturnType<typeof fixture>, turnId: string) {
  const line = h.store.getMessage(h.store.getTurn(turnId).trigger_message_id);
  const decision = h.store.db.query<{ trigger_message_id: string }, [string]>("SELECT trigger_message_id FROM turn_route_decisions WHERE turn_id = ?").get(turnId);
  return { line, decision: decision?.trigger_message_id, botOnly: h.store.db.query("SELECT bot_only FROM messages WHERE id = ?").get(line.id) };
}

test("clearing the group a card was answered in keeps the turn the answer woke in the job's thread", () => {
  const h = fixture();
  const { question, woken } = answerWakesThread(h);
  h.store.clearSessionMessages(h.group.id);
  const { line, decision, botOnly } = wokenTrigger(h, woken.id);
  expect(line).toMatchObject({ session_id: h.thread.id, kind: "system", author: h.bot.bot.id, created_at: question.created_at });
  expect(line.body).not.toContain("Choose");
  expect(botOnly).toEqual({ bot_only: 1 });
  expect(decision).toBe(line.id);
  expect(h.store.db.query("SELECT count(*) AS n FROM messages WHERE session_id = ?").get(h.group.id)).toEqual({ n: 0 });
});

test("deleting the group a card was answered in keeps the turn the answer woke in the job's thread", () => {
  const h = fixture();
  const { woken } = answerWakesThread(h);
  h.store.deleteSession(h.group.id);
  const { line, decision } = wokenTrigger(h, woken.id);
  expect(line).toMatchObject({ session_id: h.thread.id, kind: "system", author: h.bot.bot.id });
  expect(decision).toBe(line.id);
  expect(h.store.db.query("SELECT id FROM sessions WHERE id = ?").get(h.group.id)).toBeNull();
});

/** Where a card's `ask` notification stands, whether the card itself says it lapsed, and what the Dock badge counts. */
function asks(h: ReturnType<typeof fixture>, ...ids: string[]) {
  const state = (id: string) => {
    const ask = h.store.db.query<{ action_state: string; resolution_reason: string | null }, [string]>(
      "SELECT action_state, resolution_reason FROM notifications WHERE semantic_key = ?").get(`work_question:${id}`)!;
    const control = h.store.getMessage(id).control;
    return { ...ask, lapsed: control?.kind === "work_question" && typeof control.superseded_at === "string" };
  };
  return { cards: ids.map(state), badge: h.store.getNotificationSummary().attention_count };
}
const OPEN = { action_state: "open", resolution_reason: null, lapsed: false };
const LAPSED = { action_state: "voided", resolution_reason: "superseded", lapsed: true };

/** Another line wakes the Bot on the same job, and its segment ends as `reason` says. */
function nextSegment(h: ReturnType<typeof fixture>, end: { reason: "blocked"; needsFromUser: string } | { reason: "done" }) {
  const trigger = h.store.postMessage(h.group.id, { body: "Any news?" });
  const turn = h.store.createTurn({ sessionId: h.group.id, botId: h.bot.bot.id, triggerMessageId: trigger.id, taskId: h.task.id });
  h.store.finishWork({ turnId: turn.id, ...end });
  h.store.setTurnStatus(turn.id, "completed");
  // Seen, as in the conversation it was asked in: only a card still waiting on you holds the badge.
  h.store.db.run("UPDATE notifications SET read_at = COALESCE(read_at, ?)", [new Date().toISOString()]);
  return turn;
}

test("a card nobody answered stops holding the badge and says so once its job goes on without it", () => {
  const h = fixture();
  h.store.finishWork({ turnId: h.turn.id, reason: "blocked", needsFromUser: "Old question" });
  h.store.setTurnStatus(h.turn.id, "completed");
  const old = createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Old question" });
  h.store.db.run("UPDATE notifications SET read_at = COALESCE(read_at, ?)", [new Date().toISOString()]);
  expect(asks(h, old.id)).toEqual({ cards: [OPEN], badge: 1 });

  const blocked = nextSegment(h, { reason: "blocked", needsFromUser: "New question" });
  const latest = createWorkQuestion(h.ctx, { turnId: blocked.id, body: "New question" });
  expect(asks(h, old.id, latest.id)).toEqual({ cards: [LAPSED, OPEN], badge: 1 });
  expect(() => answerWorkQuestion(h.ctx, old.id, { body: "Old answer", userActionId: "old-answer" })).toThrow("current question");

  nextSegment(h, { reason: "done" });
  expect(h.store.db.query("SELECT state FROM work_items WHERE id = ?").get(h.turn.work_item_id!)).toEqual({ state: "idle" });
  expect(asks(h, latest.id)).toEqual({ cards: [LAPSED], badge: 0 });
});

test("an answered card stays answered when its job goes on", () => {
  const h = fixture();
  h.store.finishWork({ turnId: h.turn.id, reason: "blocked", needsFromUser: "Choose" });
  h.store.setTurnStatus(h.turn.id, "completed");
  const question = createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Choose" });
  answerWorkQuestion(h.ctx, question.id, { body: "Version 3", userActionId: "answer-1" });
  nextSegment(h, { reason: "done" });
  expect(asks(h, question.id)).toEqual({ cards: [{ action_state: "resolved", resolution_reason: "answered", lapsed: false }], badge: 0 });
});

test("cards an older build left waiting after their job went on lapse when the database opens", () => {
  const h = fixture();
  h.store.finishWork({ turnId: h.turn.id, reason: "blocked", needsFromUser: "Old question" });
  h.store.setTurnStatus(h.turn.id, "completed");
  const old = createWorkQuestion(h.ctx, { turnId: h.turn.id, body: "Old question" });
  h.store.db.run("DROP TRIGGER work_question_asks_follow_work");
  const blocked = nextSegment(h, { reason: "blocked", needsFromUser: "New question" });
  const latest = createWorkQuestion(h.ctx, { turnId: blocked.id, body: "New question" });
  h.store.db.run("UPDATE notifications SET read_at = COALESCE(read_at, ?)", [new Date().toISOString()]);
  expect(asks(h, old.id, latest.id)).toEqual({ cards: [{ ...OPEN }, OPEN], badge: 2 });
  migrateSchema(h.store.db);
  expect(asks(h, old.id, latest.id)).toEqual({ cards: [LAPSED, OPEN], badge: 1 });
  const lapsedAt = h.store.getMessage(old.id).control;
  migrateSchema(h.store.db);
  expect(h.store.getMessage(old.id).control).toEqual(lapsedAt);
  expect(answerWorkQuestion(h.ctx, latest.id, { body: "New answer", userActionId: "new-answer" }).answered).toBe(true);
});
