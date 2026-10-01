import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import { createWorkQuestion, answerWorkQuestion } from "./work-questions";
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

test("an answer retains a source conversation's hold when the work's public home is somewhere else", () => {
  const h = fixture();
  h.store.setTurnStatus(h.turn.id, "completed");
  h.store.db.run("UPDATE work_items SET home_session_id = ? WHERE id = ?", [h.group.id, h.turn.work_item_id!]);
  const source = h.store.insertMessage({ sessionId: h.thread.id, kind: "bot", author: h.peer.id, body: "Try again" });
  const from = h.store.createTurn({ sessionId: h.thread.id, botId: h.bot.bot.id, triggerMessageId: source.id, taskId: h.task.id });
  h.store.finishWork({ turnId: from.id, reason: "blocked", needsFromUser: "Choose" });
  h.store.setTurnStatus(from.id, "completed");
  const question = createWorkQuestion(h.ctx, { turnId: from.id, body: "Choose" });
  const hold = h.store.createHold({ scope: "session", scopeId: h.thread.id, source: "user_button" });
  const answered = answerWorkQuestion(h.ctx, question.id, { body: "Answer", userActionId: "answer" });
  expect(answered.inbox_state).toBe("held");
  h.store.refreshHeldInbox({ botId: h.bot.bot.id });
  expect(h.store.getInboxItem(answered.message.control?.kind === "work_question" ? answered.message.control.answer!.inbox_seq : 0)?.state).toBe("held");
  expect(h.store.getHold(hold.id).lifted_at).toBeNull();
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
