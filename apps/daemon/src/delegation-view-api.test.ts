import { afterEach, expect, test } from "bun:test";
import type { ClientEvent } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { Store } from "./store";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { while (close.length) await close.pop()!(); });
function start() {
  const store = new Store();
  const api = createLocalApi({ store, token: "delegation-view-test", schedule: false });
  const events: ClientEvent[] = [];
  api.subscribeSync((frame) => { if (frame.type === "event") events.push(frame.payload); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  close.push(async () => { await api.engine.close(); store.close(); await server.stop(true); });
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', '40')");
  const from = store.createBot({ name: "Director", duties: "direct", boundaries: "stay" }).bot;
  const to = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" }).bot;
  const group = store.createGroup({ name: "Film", members: [from.id, to.id] });
  const task = store.openTask({ sessionId: group.id, title: "EP01" });
  const ticket = store.createTicket({ taskId: task.id, title: "Review", status: "doing" });
  const source = store.postMessage(group.id, { body: "Review Shot 11" });
  const turn = store.createTurn({ sessionId: group.id, botId: from.id, triggerMessageId: source.id, taskId: task.id, ticketId: ticket.id });
  const origin = `http://${server.hostname}:${server.port}`;
  const get = (path: string) => fetch(`${origin}${path}`, { headers: { Authorization: "Bearer delegation-view-test" } });
  return { store, api, events, from, to, group, task, ticket, turn, get, origin };
}

test("plan and existing direct project a persisted delegation, a real wait and a single reply without guessing text", async () => {
  const h = start();
  const cursor = h.api.syncCursor();
  const result = h.store.delegateWork({ fromTurnId: h.turn.id, toBotId: h.to.id, ask: "审 Shot 11", expects: "review" });
  const response = await h.get(`/v1/tasks/${h.task.id}/delegations`);
  expect(response.status).toBe(200);
  const before = await response.json();
  expect(h.events.filter((event) => event.event === "delegation.changed")).toMatchObject([
    { id: result.delegation.id, status: "open", wait: { state: "waiting" } },
  ]);
  expect(before.items).toMatchObject([{ id: result.delegation.id, task_id: h.task.id, thread_session_id: result.delegation.thread_session_id,
    from_bot_id: h.from.id, to_bot_id: h.to.id, ask: "审 Shot 11", status: "open", reply: null, wait: { state: "waiting", due_at: null } }]);
  expect((await (await h.get(`/v1/sessions/${result.delegation.thread_session_id}/delegations`)).json()).items).toEqual(before.items);
  const trigger = h.store.insertMessage({ sessionId: result.delegation.thread_session_id, kind: "system", author: "app", body: "Actual request" });
  const recipient = h.store.createTurn({ sessionId: result.delegation.thread_session_id, botId: h.to.id, triggerMessageId: trigger.id, taskId: h.task.id, ticketId: h.ticket.id });
  h.events.length = 0;
  h.store.replyDelegation({ delegationId: result.delegation.id, fromTurnId: recipient.id, answer: "2 通过 1 不通过" });
  expect(h.events.filter((event) => event.event === "delegation.changed")).toMatchObject([
    { id: result.delegation.id, status: "replied", wait: null, reply: { body: "2 通过 1 不通过" } },
  ]);
  const after = await (await h.get(`/v1/tasks/${h.task.id}/delegations`)).json();
  expect(after.items).toMatchObject([{ id: result.delegation.id, status: "replied", reply: { body: "2 通过 1 不通过" }, wait: null }]);
  expect(h.store.getSession(result.delegation.thread_session_id).kind).toBe("direct");
  const catchup = await (await h.get(`/v1/events/catchup?event_instance_id=${cursor.event_instance_id}&after_seq=${cursor.watermark_seq}`)).json();
  expect(catchup.events.map((frame: { payload: ClientEvent }) => frame.payload).filter((event: ClientEvent) => event.event === "delegation.changed")).toMatchObject([
    { id: result.delegation.id, status: "open" }, { id: result.delegation.id, status: "replied" },
  ]);
  expect((await fetch(`${h.origin}/v1/tasks/${h.task.id}/delegations`)).status).toBe(401);
});

test("plain reply-shaped text never changes the handoff, and cancellation survives transcript clearing", async () => {
  const h = start();
  const opened = h.store.delegateWork({ fromTurnId: h.turn.id, toBotId: h.to.id, ask: "Review it", expects: "review" });
  h.store.insertMessage({ sessionId: opened.delegation.thread_session_id, kind: "bot", author: h.to.id, body: "交回：this is only prose, not a reply" });
  const stillOpen = await (await h.get(`/v1/sessions/${opened.delegation.thread_session_id}/delegations`)).json();
  expect(stillOpen.items[0]).toMatchObject({ status: "open", reply: null, wait: { state: "waiting" } });
  h.store.cancelDelegation({ delegationId: opened.delegation.id, fromTurnId: h.turn.id });
  h.store.clearSessionMessages(opened.delegation.thread_session_id);
  expect((await (await h.get(`/v1/sessions/${opened.delegation.thread_session_id}/delegations`)).json()).items[0]).toMatchObject({ id: opened.delegation.id, status: "cancelled", wait: null });
  expect((await (await h.get(`/v1/tasks/${h.task.id}/delegations`)).json()).items[0]).toMatchObject({ status: "cancelled", wait: null,
    reply: { body: "Delegation cancelled: Review it" } });
});

test("materializing and forgetting trigger links republishes the durable handoff without leaking Bot-only text", async () => {
  const h = start();
  const opened = h.store.delegateWork({ fromTurnId: h.turn.id, toBotId: h.to.id, ask: "Review it", expects: "review" });
  const trigger = h.store.insertMessage({ sessionId: opened.delegation.thread_session_id, kind: "system", author: "app", body: "internal wake" });
  h.events.length = 0;
  h.store.transaction(() => h.store.db.run("UPDATE inbox_items SET message_id = ? WHERE seq = ?", [trigger.id, opened.inbox.seq]));
  expect(h.events.filter((event) => event.event === "delegation.changed")).toMatchObject([{ id: opened.delegation.id, request_message_id: trigger.id }]);
  h.events.length = 0;
  h.store.transaction(() => h.store.db.run("UPDATE inbox_items SET message_id = NULL WHERE seq = ?", [opened.inbox.seq]));
  expect(h.events.filter((event) => event.event === "delegation.changed")).toMatchObject([{ id: opened.delegation.id, request_message_id: null }]);
});

test("continue:true invents no wait, and a held delegation projects the actual suspended wait", async () => {
  const h = start();
  const noWait = h.store.delegateWork({ fromTurnId: h.turn.id, toBotId: h.to.id, ask: "Check this", expects: "answer", continue: true });
  const wait = h.store.delegateWork({ fromTurnId: h.turn.id, toBotId: h.to.id, ask: "Review that", expects: "review" });
  h.events.length = 0;
  h.store.createHold({ scope: "bot", scopeId: h.from.id, source: "user_button", cascade: false });
  expect(h.events.filter((event) => event.event === "delegation.changed")).toMatchObject([{ id: wait.delegation.id, wait: { state: "held" } }]);
  const response = await h.get(`/v1/tasks/${h.task.id}/delegations`);
  expect(response.status).toBe(200);
  const view = await response.json();
  expect(view.items.find((row: { id: string }) => row.id === noWait.delegation.id).wait).toBeNull();
  expect(view.items.find((row: { id: string }) => row.id === wait.delegation.id).wait).toMatchObject({ state: "held" });
  expect((await h.get("/v1/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV/delegations")).status).toBe(404);
});
