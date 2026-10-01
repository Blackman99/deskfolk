import { afterEach, expect, test } from "bun:test";
import type { ClientEvent } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

function start() {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "lead-test", schedule: false });
  const events: ClientEvent[] = [];
  api.subscribeSync((frame) => { if (frame.type === "event") events.push(frame.payload); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { await api.engine.close(); store.close(); await server.stop(true); });
  const request = (method: string, sessionId: string, body?: unknown) => fetch(`http://${server.hostname}:${server.port}/v1/sessions/${sessionId}/lead`, {
    method, headers: { Authorization: "Bearer lead-test", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { store, request, events };
}

test("a group's seven-day handoffs suggest a lead, but only the user's confirmation changes routing", async () => {
  const { store, request, events } = start();
  const director = store.createBot({ name: "Director", duties: "direct", boundaries: "stay" }).bot;
  const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" }).bot;
  const group = store.createGroup({ name: "Film", members: [director.id, reviewer.id] });
  const user = store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "Make the film" });
  const turn = store.createTurn({ sessionId: group.id, botId: director.id, triggerMessageId: user.id });
  store.insertMessage({ sessionId: group.id, turnId: turn.id, sourceTurnId: turn.id, kind: "bot", author: director.id, body: "@Reviewer review the master" });
  const popular = store.insertMessage({ sessionId: group.id, kind: "bot", author: reviewer.id, body: "I talked a lot" });
  const stale = store.insertMessage({ sessionId: group.id, turnId: turn.id, sourceTurnId: turn.id, kind: "bot", author: reviewer.id, body: "@Director old handoff" });
  store.db.run("UPDATE messages SET created_at = ? WHERE id = ?", [new Date(Date.now() - 8 * 86_400_000).toISOString(), stale.id]);
  const before = await request("GET", group.id);
  expect(before.status).toBe(200);
  expect(await before.json()).toMatchObject({ session_id: group.id, confirmed_bot_id: null, suggestion: { bot_id: director.id, handoffs: 1 } });
  expect(store.db.query("SELECT member FROM session_participants WHERE session_id = ? AND is_lead = 1").all(group.id)).toEqual([]);
  expect((await request("PUT", group.id, { bot_id: director.id })).status).toBe(422);
  expect((await request("PUT", group.id, { bot_id: director.id, confirmed: false })).status).toBe(422);
  const confirmed = await request("PUT", group.id, { bot_id: director.id, confirmed: true });
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toMatchObject({ confirmed_bot_id: director.id });
  expect(store.db.query("SELECT member FROM session_participants WHERE session_id = ? AND is_lead = 1").all(group.id)).toEqual([{ member: director.id }]);
  const cleared = await request("PUT", group.id, { bot_id: null, confirmed: true });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ confirmed_bot_id: null });
  expect(events.filter((event) => event.event === "group_lead.changed")).toMatchObject([
    { session_id: group.id, confirmed_bot_id: director.id },
    { session_id: group.id, confirmed_bot_id: null },
  ]);
  expect(store.getMessage(popular.id).body).toBe("I talked a lot");
});

test("a real private handoff from the group's work counts for its initiating Bot without double-counting thread replies", async () => {
  const { store, request } = start();
  const director = store.createBot({ name: "Director", duties: "direct", boundaries: "stay" }).bot;
  const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" }).bot;
  const group = store.createGroup({ name: "Film", members: [director.id, reviewer.id] });
  const trigger = store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "Make the film" });
  const turn = store.createTurn({ sessionId: group.id, botId: director.id, triggerMessageId: trigger.id });
  const thread = store.createBotDirect(director.id, reviewer.id, { sessionId: group.id, messageId: trigger.id });
  store.insertMessage({ sessionId: thread.id, turnId: turn.id, sourceTurnId: turn.id, kind: "bot", author: director.id, body: "Review Shot 01" });
  store.insertMessage({ sessionId: thread.id, turnId: turn.id, sourceTurnId: turn.id, kind: "bot", author: director.id, body: "Extra detail, not another delegation" });
  expect(await (await request("GET", group.id)).json()).toMatchObject({ confirmed_bot_id: null, suggestion: { bot_id: director.id, handoffs: 1 } });
});

test("a seven-day tie offers no arbitrary lead, and a departed confirmed member is not returned", async () => {
  const { store, request } = start();
  const a = store.createBot({ name: "A", duties: "work", boundaries: "stay" }).bot;
  const b = store.createBot({ name: "B", duties: "work", boundaries: "stay" }).bot;
  const c = store.createBot({ name: "C", duties: "work", boundaries: "stay" }).bot;
  const group = store.createGroup({ name: "Group", members: [a.id, b.id, c.id] });
  const trigger = store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "make it" });
  for (const [author, other] of [[a, b], [b, a]] as const) {
    const turn = store.createTurn({ sessionId: group.id, botId: author.id, triggerMessageId: trigger.id });
    store.insertMessage({ sessionId: group.id, turnId: turn.id, sourceTurnId: turn.id, kind: "bot", author: author.id, body: `@${other.name} your part` });
    store.setTurnStatus(turn.id, "completed");
  }
  expect(await (await request("GET", group.id)).json()).toMatchObject({ suggestion: null, confirmed_bot_id: null });
  expect((await request("PUT", group.id, { bot_id: a.id, confirmed: true })).status).toBe(200);
  store.removeMember(group.id, a.id);
  expect(await (await request("GET", group.id)).json()).toMatchObject({ confirmed_bot_id: null, suggestion: { bot_id: b.id } });
});

test("leaving, archiving or deleting a confirmed lead publishes the new eligible state to other clients", async () => {
  for (const action of ["leave", "archive", "delete"] as const) {
    const { store, request, events } = start();
    const a = store.createBot({ name: "A", duties: "work", boundaries: "stay" }).bot;
    const b = store.createBot({ name: "B", duties: "work", boundaries: "stay" }).bot;
    const c = store.createBot({ name: "C", duties: "work", boundaries: "stay" }).bot;
    const group = store.createGroup({ name: "Group", members: [a.id, b.id, c.id] });
    expect((await request("PUT", group.id, { bot_id: a.id, confirmed: true })).status).toBe(200);
    events.length = 0;
    if (action === "leave") store.removeMember(group.id, a.id);
    else if (action === "archive") store.archiveBot(a.id);
    else store.deleteBot(a.id);
    expect(await (await request("GET", group.id)).json()).toMatchObject({ confirmed_bot_id: null });
    expect(events.filter((event) => event.event === "group_lead.changed")).toMatchObject([
      { session_id: group.id, confirmed_bot_id: null },
    ]);
  }
});

test("a lead must be a present Bot in a group, never a stale member or a direct's Bot", async () => {
  const { store, request } = start();
  const a = store.createBot({ name: "A", duties: "work", boundaries: "stay" });
  const b = store.createBot({ name: "B", duties: "work", boundaries: "stay" });
  const outside = store.createBot({ name: "Outside", duties: "work", boundaries: "stay" });
  const c = store.createBot({ name: "C", duties: "work", boundaries: "stay" });
  const group = store.createGroup({ name: "Group", members: [a.bot.id, b.bot.id, c.bot.id] });
  store.removeMember(group.id, b.bot.id);
  for (const bot_id of [b.bot.id, outside.bot.id, "user", 1]) {
    expect((await request("PUT", group.id, { bot_id, confirmed: true })).status).toBe(422);
  }
  expect((await request("GET", a.direct_session.id)).status).toBe(422);
  expect((await request("PUT", a.direct_session.id, { bot_id: a.bot.id, confirmed: true })).status).toBe(422);
  expect((await request("PUT", group.id, { bot_id: a.bot.id, confirmed: true, surprise: "field" })).status).toBe(422);
  expect((await request("PUT", group.id, null)).status).toBe(422);
});
