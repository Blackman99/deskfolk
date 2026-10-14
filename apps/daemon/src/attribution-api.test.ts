import { afterEach, expect, test } from "bun:test";
import type { ClientEvent } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });
function start() {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "filing-test", schedule: false });
  const events: ClientEvent[] = [];
  api.subscribeSync((frame) => { if (frame.type === "event") events.push(frame.payload); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { await api.engine.close(); store.close(); await server.stop(true); });
  const origin = `http://${server.hostname}:${server.port}`;
  const request = (messageId: string, body: unknown) => fetch(`${origin}/v1/messages/${messageId}/attribution`, {
    method: "PATCH", headers: { Authorization: "Bearer filing-test", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = bot.direct_session.id;
  const a = store.openTask({ sessionId: session, title: "First" });
  const b = store.openTask({ sessionId: session, title: "Second" });
  const ticket = store.createTicket({ taskId: b.id, title: "Draft", status: "doing", worker: bot.bot.id });
  const message = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "Both jobs should follow this" });
  return { store, request, session, a, b, ticket, message, events, api, origin };
}

// Where a line is filed is the app's own (2026-10-14): read by a model or chosen by the Bot at its
// desk, seen in the line's flow, and changed by no client.
test("no client can change where a line is filed, nor open a job from it", async () => {
  const h = start();
  const before = h.store.getMessage(h.message.id);
  for (const body of [{ filings: [{ plan_id: h.a.id }] }, { filings: [] }, { plan_id: h.b.id }, { new_plan: {} }]) {
    const response = await h.request(h.message.id, body);
    expect(response.status).toBe(404);
  }
  expect(h.store.getMessage(h.message.id)).toEqual(before);
  expect(h.store.listWorkEvents({ kind: "attribution.changed" })).toEqual([]);
  expect(h.events.filter((event) => event.event === "attribution.changed")).toEqual([]);
  expect(h.store.db.query<{ id: string }, []>("SELECT id FROM tasks").all().map((row) => row.id).sort()).toEqual([h.a.id, h.b.id].sort());
});

test("refiling a delivered line (a new-job card's merge) keeps its read audit and durably queues the correction under holds", () => {
  const h = start();
  h.store.raiseEngineLevel(null);
  h.store.refileMessage(h.message.id, { filings: [{ taskId: h.a.id }], userActionId: "setup" });
  const botId = h.store.presentBotIds(h.session)[0]!;
  const turn = h.store.createTurn({ sessionId: h.session, botId, triggerMessageId: h.message.id, taskId: h.a.id });
  const item = h.store.queueInboxItem({ botId, sessionId: h.session, turnId: turn.id, taskId: h.a.id, ticketId: null,
    messageId: h.message.id, author: "user", body: h.message.body, source: "user", kind: "change", priority: 1 });
  h.store.db.run("UPDATE inbox_items SET state = 'delivered', delivered_turn_id = ?, delivered_hop = 2 WHERE seq = ?", [turn.id, item.seq]);
  const hold = h.store.createHold({ scope: "plan", scopeId: h.b.id, source: "user_button" });
  h.store.refileMessage(h.message.id, { filings: [{ taskId: h.b.id, ticketId: h.ticket.id }], userActionId: "merge" });
  expect(h.store.getInboxItem(item.seq)).toMatchObject({ state: "delivered", task_id: h.a.id, delivered_turn_id: turn.id, delivered_hop: 2 });
  expect(h.store.db.query("SELECT task_id, ticket_id, state, body_snapshot FROM inbox_items WHERE message_id = ? AND source = 'system'").all(h.message.id)).toEqual([
    { task_id: h.b.id, ticket_id: h.ticket.id, state: "held", body_snapshot: `这句改归到 Second：${h.message.body}` },
    // The segment still running on First read the line: it hears not to act on it there.
    { task_id: h.a.id, ticket_id: null, state: "queued", body_snapshot: `（应用）用户把你这一段读过的这句话改归到了《Second》，那件事会在那里另开一段做；这一段别再按这句动手：${h.message.body}` },
  ]);
  expect(h.store.getHold(hold.id).lifted_at).toBeNull();
});

test("refiling a source requirement's line invalidates both the old and new plan boards", () => {
  const h = start();
  const source = h.store.postMessage(h.session, { body: "The background must stay consistent" });
  h.store.refileMessage(source.id, { filings: [{ taskId: h.a.id }], userActionId: "setup" });
  const quote = h.store.listQuotes({ messageId: source.id })[0]!;
  h.store.transaction(() => h.store.db.run(`INSERT INTO requirements (id, scope, scope_id, quote, source_kind, source_quote_id, status,
    last_raised_at, added_by, created_at, updated_at, origin_task_id)
    VALUES ('moving-req', 'plan', ?, 'The background must stay consistent', 'message', ?, 'open',
      '2026-01-01', 'capture', '2026-01-01', '2026-01-01', ?)`, [h.a.id, quote.id, h.a.id]));
  h.events.length = 0;
  h.store.refileMessage(source.id, { filings: [{ taskId: h.b.id }], userActionId: "merge" });
  expect(h.store.db.query("SELECT origin_task_id, scope_id FROM requirements WHERE id = 'moving-req'").get()).toEqual({ origin_task_id: h.b.id, scope_id: h.b.id });
  const boards = h.events.filter((event) => event.event === "task.upsert");
  expect(boards.map((event) => event.id).sort()).toEqual([h.a.id, h.b.id].sort());
  expect(boards.find((event) => event.id === h.a.id)?.requirements?.some((row) => row.id === "moving-req")).toBe(false);
  expect(boards.find((event) => event.id === h.b.id)?.requirements?.some((row) => row.id === "moving-req")).toBe(true);
});

test("the job list holds untouched or dormant plans from another conversation, and reading it wakes none", async () => {
  const h = start();
  const other = h.store.createBot({ name: "Other", duties: "work", boundaries: "stay" });
  const elsewhere = h.store.openTask({ sessionId: other.direct_session.id, title: "Not seen here" });
  h.store.db.run("UPDATE tasks SET dormant_since = ?, closed_at = ? WHERE id = ?", ["2026-01-01", "2026-01-01", elsewhere.id]);
  const response = await fetch(`${h.origin}/v1/messages/${h.message.id}/attribution`, { headers: { Authorization: "Bearer filing-test" } });
  expect(response.status).toBe(200);
  const choices = await response.json() as { items: Array<{ id: string; title: string; tickets: Array<{ id: string }> }> };
  expect(choices.items.find((choice) => choice.id === elsewhere.id)).toMatchObject({ title: "Not seen here", tickets: [] });
  expect(choices.items.find((choice) => choice.id === h.b.id)?.tickets).toMatchObject([{ id: h.ticket.id }]);
  expect(h.store.getTask(elsewhere.id).dormant_since).toBe("2026-01-01");
  expect(h.store.getMessage(h.message.id).task_id).toBeNull();
});

test("a dropped ticket is not offered, unless the line is filed there now", async () => {
  const h = start();
  const dropped = h.store.createTicket({ taskId: h.b.id, title: "Opening", status: "parked" });
  const choices = async () => {
    const response = await fetch(`${h.origin}/v1/messages/${h.message.id}/attribution`, { headers: { Authorization: "Bearer filing-test" } });
    return ((await response.json()) as { items: Array<{ id: string; tickets: Array<{ id: string }> }> }).items.find((choice) => choice.id === h.b.id)!.tickets.map((t) => t.id);
  };
  expect(await choices()).toEqual([h.ticket.id]);
  h.store.db.run("INSERT INTO message_filings (message_id, task_id, ticket_id, filed_by, strength, is_primary, created_at) VALUES (?, ?, ?, 'user', 'user', 1, ?)",
    [h.message.id, h.b.id, dropped.id, "2026-10-04T00:00:00.000Z"]);
  expect(await choices()).toEqual([h.ticket.id, dropped.id]);
});
