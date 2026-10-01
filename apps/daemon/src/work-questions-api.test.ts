import { afterEach, expect, spyOn, test } from "bun:test";
import type { ClientEvent } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { Store } from "./store";
import * as questions from "./store/work-questions";
import { KeyCache, type StoreContext } from "./store/shared";
import { Transactions } from "./store/transactions";
import { ENGINE_LEVELS } from "./store/schema-gate";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });
function start() {
  const store = new Store();
  const api = createLocalApi({ store, token: "work-question-test", schedule: false });
  // Public API seam: observe admission scheduling without making unconfigured model calls.
  const dispatch = spyOn(api.engine, "dispatchQueuedWork").mockImplementation(() => {});
  const events: ClientEvent[] = [];
  api.subscribeSync((frame) => { if (frame.type === "event") events.push(frame.payload); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { await api.engine.close(); store.close(); await server.stop(true); });
  const ctx: StoreContext = { db: store.db, keys: new KeyCache({ get: async () => null, set: async () => {}, delete: async () => {} }, store.db),
    commit: (work) => store.transaction(work), tx: new Transactions(store.db), inboxRoot: "", activeStages: new Set(), keyPlan: null, legacy: { copiedKey: false } };
  store.db.run("INSERT OR REPLACE INTO settings(key,value) VALUES ('engine_level', ?)", [String(ENGINE_LEVELS.supervision)]);
  const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const task = store.openTask({ sessionId: bot.direct_session.id, title: "Report" });
  const trigger = store.postMessage(bot.direct_session.id, { body: "Write the report" });
  const turn = store.createTurn({ sessionId: bot.direct_session.id, botId: bot.bot.id, triggerMessageId: trigger.id, taskId: task.id });
  store.finishWork({ turnId: turn.id, reason: "blocked", needsFromUser: "Which edition should I use?" });
  store.setTurnStatus(turn.id, "completed");
  const question = questions.createWorkQuestion(ctx, { turnId: turn.id, body: "Which edition should I use?" });
  const answer = (body: unknown, action = "01ARZ3NDEKTSV4RRFFQ69G5FAV") => fetch(`http://${server.hostname}:${server.port}/v1/messages/${question.id}/work-answer`, {
    method: "POST", headers: { Authorization: "Bearer work-question-test", "Content-Type": "application/json", "X-Request-Id": action }, body: JSON.stringify(body),
  });
  return { store, ctx, api, turn, bot, task, question, answer, events, dispatch, origin: `http://${server.hostname}:${server.port}` };
}

test("an ended blocked segment's question is answered durably once with the user's exact words", async () => {
  const h = start();
  const body = "Use edition 3.\n保留这一行。";
  const cursor = h.api.syncCursor();
  const response = await h.answer({ body });
  if (response.status !== 200) throw new Error(await response.text());
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ work_item_id: h.turn.work_item_id, inbox_state: "queued", answered: true,
    message: { id: h.question.id, kind: "system", author: h.bot.bot.id, control: { kind: "work_question", answer: { body } } } });
  expect(h.events.filter((event) => event.event === "message.upsert" && event.id === h.question.id).at(-1)).toMatchObject({ control: { kind: "work_question", answer: { body } } });
  const replay = await (await fetch(`${h.origin}/v1/events/catchup?event_instance_id=${cursor.event_instance_id}&after_seq=${cursor.watermark_seq}`, { headers: { Authorization: "Bearer work-question-test" } })).json();
  expect(replay.events.map((frame: { payload: ClientEvent }) => frame.payload).filter((event: ClientEvent) => event.event === "message.upsert" && event.id === h.question.id).at(-1)).toMatchObject({ control: { answer: { body } } });
  expect(h.store.getTurn(h.turn.id).status).toBe("completed");
  expect(h.store.db.query("SELECT state FROM work_items WHERE id = ?").get(h.turn.work_item_id!)).toEqual({ state: "queued" });
  expect(h.store.listQuotes({ messageId: h.question.id })).toMatchObject([{ via: "ask_answer", body, task_id: h.task.id }]);
  expect(h.store.db.query("SELECT body_snapshot, source_turn_id FROM inbox_items WHERE message_id = ?").all(h.question.id)).toEqual([{ body_snapshot: body, source_turn_id: h.turn.id }]);
  expect((await h.answer({ body })).status).toBe(200);
  expect(h.dispatch).toHaveBeenCalledTimes(1);
  expect(h.store.db.query("SELECT count(*) AS n FROM inbox_items WHERE message_id = ?").get(h.question.id)).toEqual({ n: 1 });
  expect((await h.answer({ body }, "01ARZ3NDEKTSV4RRFFQ69G5FAW")).status).toBe(409);
});

test("answering under a source-turn hold queues held mail without lifting it or starting a legacy ask turn", async () => {
  const h = start();
  const stop = h.store.createHold({ scope: "turn", scopeId: h.turn.id, source: "user_button" });
  const response = await h.answer({ body: "Edition 3" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ inbox_state: "held" });
  expect(h.store.getHold(stop.id).lifted_at).toBeNull();
  expect(h.store.db.query("SELECT state FROM inbox_items WHERE message_id = ?").get(h.question.id)).toEqual({ state: "held" });
  expect(h.store.db.query("SELECT id FROM turns WHERE status = 'waiting_ask'").all()).toEqual([]);
  expect(h.store.db.query("SELECT state FROM work_items WHERE id = ?").get(h.turn.work_item_id!)).toEqual({ state: "queued" });
  h.store.liftHold(stop.id, { by: "user_button" });
  expect(h.store.db.query("SELECT state FROM inbox_items WHERE message_id = ?").get(h.question.id)).toEqual({ state: "queued" });
});

test("a question in an archived conversation cannot queue work until the user restores that conversation", async () => {
  const h = start();
  h.store.archiveSession(h.question.session_id);
  expect((await h.answer({ body: "answer" })).status).toBe(409);
  expect(h.store.listQuotes({ messageId: h.question.id })).toEqual([]);
  expect(h.store.db.query("SELECT id FROM inbox_items WHERE message_id = ?").all(h.question.id)).toEqual([]);
});

test("malformed input or no longer eligible work cannot answer or forge target provenance", async () => {
  const h = start();
  let index = 0;
  for (const input of [null, [], {}, { body: " " }, { body: 4 }, { body: "answer", work_item_id: "other" }]) {
    expect((await h.answer(input, `invalid-${++index}`)).status).toBe(422);
  }
  h.store.archiveBot(h.bot.bot.id);
  expect((await h.answer({ body: "answer" })).status).toBe(409);
  expect(h.store.listQuotes({ messageId: h.question.id })).toEqual([]);
  expect(h.store.getMessage(h.question.id).control).not.toHaveProperty("answer");
});
