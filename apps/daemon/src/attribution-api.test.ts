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

test("an authenticated correction replaces multiple filings and returns the full message for every client", async () => {
  const h = start();
  const before = h.api.syncCursor();
  const response = await h.request(h.message.id, { filings: [{ plan_id: h.a.id }, { plan_id: h.b.id, ticket_id: h.ticket.id }] });
  expect(response.status).toBe(200);
  const moved = await response.json();
  expect(moved).toMatchObject({ id: h.message.id, session_id: h.session, body: h.message.body, filing_state: "filed", task_id: h.a.id });
  expect(moved.filings).toMatchObject([
    { task_id: h.a.id, ticket_id: null, part_key: null },
    { task_id: h.b.id, ticket_id: h.ticket.id, part_key: null },
  ]);
  expect(h.events.filter((event) => event.event === "attribution.changed")).toMatchObject([
    { message_id: h.message.id, session_id: h.session, filing_state: "filed", filings: moved.filings },
  ]);
  expect(h.events.filter((event) => event.event === "message.upsert" && event.id === h.message.id).at(-1)).toMatchObject({ filings: moved.filings });
  const catchup = await fetch(`${h.origin}/v1/events/catchup?event_instance_id=${before.event_instance_id}&after_seq=${before.watermark_seq}`, { headers: { Authorization: "Bearer filing-test" } });
  expect(catchup.status).toBe(200);
  const replay = await catchup.json() as { events: Array<{ payload: ClientEvent }> };
  expect(replay.events.map((frame) => frame.payload).filter((event) => event.event === "attribution.changed")).toMatchObject([
    { message_id: h.message.id, filing_state: "filed", filings: moved.filings },
  ]);
  expect(h.store.listWorkEvents({ kind: "attribution.changed" })).toHaveLength(1);
  expect(h.store.listWorkEvents({ kind: "attribution.changed" })[0]!.payload).toMatchObject({ user_action_id: expect.any(String) });
  const cleared = await h.request(h.message.id, { filings: [] });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ id: h.message.id, task_id: null, ticket_id: null, filing_state: "none", filings: [] });
});

test("correcting a delivered line keeps its read audit and durably queues the correction under holds", async () => {
  const h = start();
  h.store.raiseEngineLevel(null);
  h.store.refileMessage(h.message.id, { filings: [{ taskId: h.a.id }], userActionId: "setup" });
  const botId = h.store.presentBotIds(h.session)[0]!;
  const turn = h.store.createTurn({ sessionId: h.session, botId, triggerMessageId: h.message.id, taskId: h.a.id });
  const item = h.store.queueInboxItem({ botId, sessionId: h.session, turnId: turn.id, taskId: h.a.id, ticketId: null,
    messageId: h.message.id, author: "user", body: h.message.body, source: "user", kind: "change", priority: 1 });
  h.store.db.run("UPDATE inbox_items SET state = 'delivered', delivered_turn_id = ?, delivered_hop = 2 WHERE seq = ?", [turn.id, item.seq]);
  const hold = h.store.createHold({ scope: "plan", scopeId: h.b.id, source: "user_button" });
  const response = await h.request(h.message.id, { filings: [{ plan_id: h.b.id, ticket_id: h.ticket.id }] });
  expect(response.status).toBe(200);
  expect(h.store.getInboxItem(item.seq)).toMatchObject({ state: "delivered", task_id: h.a.id, delivered_turn_id: turn.id, delivered_hop: 2 });
  expect(h.store.db.query("SELECT task_id, ticket_id, state, body_snapshot FROM inbox_items WHERE message_id = ? AND source = 'system'").all(h.message.id)).toEqual([
    { task_id: h.b.id, ticket_id: h.ticket.id, state: "held", body_snapshot: `这句改归到 Second：${h.message.body}` },
    // The segment still running on First read the line: it hears not to act on it there.
    { task_id: h.a.id, ticket_id: null, state: "queued", body_snapshot: `（应用）用户把你这一段读过的这句话改归到了《Second》，那件事会在那里另开一段做；这一段别再按这句动手：${h.message.body}` },
  ]);
  expect(h.store.getHold(hold.id).lifted_at).toBeNull();
});

test("moving a source requirement invalidates both the old and new plan boards", async () => {
  const h = start();
  const source = h.store.postMessage(h.session, { body: "The background must stay consistent" });
  h.store.refileMessage(source.id, { filings: [{ taskId: h.a.id }], userActionId: "setup" });
  const quote = h.store.listQuotes({ messageId: source.id })[0]!;
  h.store.transaction(() => h.store.db.run(`INSERT INTO requirements (id, scope, scope_id, quote, source_kind, source_quote_id, status,
    last_raised_at, added_by, created_at, updated_at, origin_task_id)
    VALUES ('moving-req', 'plan', ?, 'The background must stay consistent', 'message', ?, 'open',
      '2026-01-01', 'capture', '2026-01-01', '2026-01-01', ?)`, [h.a.id, quote.id, h.a.id]));
  h.events.length = 0;
  const moved = await h.request(source.id, { filings: [{ plan_id: h.b.id }] });
  expect(moved.status).toBe(200);
  expect(h.store.db.query("SELECT origin_task_id, scope_id FROM requirements WHERE id = 'moving-req'").get()).toEqual({ origin_task_id: h.b.id, scope_id: h.b.id });
  const boards = h.events.filter((event) => event.event === "task.upsert");
  expect(boards.map((event) => event.id).sort()).toEqual([h.a.id, h.b.id].sort());
  expect(boards.find((event) => event.id === h.a.id)?.requirements?.some((row) => row.id === "moving-req")).toBe(false);
  expect(boards.find((event) => event.id === h.b.id)?.requirements?.some((row) => row.id === "moving-req")).toBe(true);
});

test("manual correction can choose untouched or dormant plans from another conversation without waking them", async () => {
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

test("invalid corrections are refused atomically, including a ticket from another plan", async () => {
  const h = start();
  for (const body of [null, [], {}, { filings: "all" }, { filings: [], plan_id: h.a.id },
    { filings: [{ plan_id: 1 }] }, { filings: [{ plan_id: h.a.id, strength: "locked" }] },
    { filings: [{ plan_id: h.a.id, ticket_id: h.ticket.id }] },
    { filings: [{ plan_id: h.b.id, ticket_id: h.ticket.id, part_key: "not-a-part" }] },
    { filings: [{ plan_id: h.a.id }], user_action_id: "fake" },
  ]) {
    const response = await h.request(h.message.id, body);
    expect(response.status).toBe(422);
    expect(h.store.getMessage(h.message.id).task_id).toBeNull();
    expect(h.store.listWorkEvents({ kind: "attribution.changed" })).toEqual([]);
  }
  expect((await h.request(h.message.id, { plan_id: h.b.id, ticket_id: h.ticket.id })).status).toBe(200);
  expect((await h.request("01ARZ3NDEKTSV4RRFFQ69G5FAV", { filings: [] })).status).toBe(404);
});

test("a correction that files a line hands it to the scribe; one that unfiles it does not", async () => {
  const h = start();
  const noted: string[] = [];
  h.api.engine.noteFiled = (messageId) => { noted.push(messageId); };
  expect((await h.request(h.message.id, { filings: [] })).status).toBe(200);
  expect(noted).toEqual([]);
  expect((await h.request(h.message.id, { plan_id: h.a.id })).status).toBe(200);
  expect(noted).toEqual([h.message.id]);
});

test("「新开一件事」: your line opens a job of its own, named after it, with a ticket, and is filed there", async () => {
  const h = start();
  const response = await h.request(h.message.id, { new_plan: {} });
  expect(response.status).toBe(200);
  const moved = await response.json();
  const plan = h.store.getTask(moved.task_id);
  expect(plan).toMatchObject({ title: "Both jobs should follow this", session_id: h.session });
  expect(plan.id).not.toBe(h.a.id);
  const [ticket] = h.store.listTickets(plan.id);
  expect(ticket).toMatchObject({ title: "Both jobs should follow this", spec: "Both jobs should follow this", owner_bot_id: h.store.listBots()[0]!.id });
  expect(moved.filings).toMatchObject([{ task_id: plan.id, ticket_id: ticket!.id, part_key: null }]);
  expect(h.events.filter((event) => event.event === "attribution.changed").at(-1)).toMatchObject({ message_id: h.message.id, filings: moved.filings });
  // Named as you say, when you name it.
  const named = await h.request(h.message.id, { new_plan: { title: "海报" } });
  expect(h.store.getTask((await named.json()).task_id).title).toBe("海报");
});

test("「新开一件事」 takes only a line of yours, and nothing beside it", async () => {
  const h = start();
  const bots = h.store.listBots();
  const said = h.store.insertMessage({ sessionId: h.session, kind: "bot", author: bots[0]!.id, body: "I will do it" });
  expect((await h.request(said.id, { new_plan: {} })).status).toBe(422);
  expect((await h.request(h.message.id, { new_plan: {}, filings: [] })).status).toBe(422);
  expect((await h.request(h.message.id, { new_plan: { title: 3 } })).status).toBe(422);
  expect((await h.request(h.message.id, { new_plan: { why: "x" } })).status).toBe(422);
});
