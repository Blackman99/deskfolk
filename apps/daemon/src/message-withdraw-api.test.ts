/**
 * `POST /v1/messages/:id/withdraw` and `POST /v1/messages/:id/insert` (ADR 0069): taking back a line
 * of yours no Bot has read, and having the working Bot read one now.
 */
import { afterEach, expect, test } from "bun:test";
import type { ClientEvent, InsertMessageResponse, Message, RuntimeSnapshot } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

function start() {
  const store = new Store({ endpointKey: memoryKeyStore() });
  store.raiseEngineLevel(null);
  const api = createLocalApi({ store, token: "withdraw-test", schedule: false });
  const events: ClientEvent[] = [];
  api.subscribeSync((frame) => { if (frame.type === "event") events.push(frame.payload); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { await api.engine.close(); store.close(); await server.stop(true); });
  const origin = `http://${server.hostname}:${server.port}`;
  const call = (method: string, path: string, body?: unknown) => fetch(`${origin}${path}`, {
    method,
    headers: { Authorization: "Bearer withdraw-test", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = bot.direct_session.id;
  /** A turn at work, not run by this process, and a line of yours waiting in its inbox. */
  const waiting = (body: string) => {
    const opener = store.postMessage(session, { body: "先写一版" });
    const turn = store.createTurn({ sessionId: session, botId: bot.bot.id, triggerMessageId: opener.id });
    const line = store.postMessage(session, { body });
    const item = store.queueInboxItem({ botId: bot.bot.id, sessionId: session, turnId: turn.id, taskId: null, ticketId: null,
      messageId: line.id, author: "user", body, source: "user", kind: "change", priority: 1 });
    return { turn, line, item };
  };
  return { store, call, session, bot: bot.bot, events, waiting };
}

async function code(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

test("the snapshot says a waiting line can be taken back or read now", async () => {
  const h = start();
  const snapshot = (await (await h.call("GET", "/v1/snapshot")).json()) as RuntimeSnapshot;
  expect(snapshot.queuedLineActions).toBe(true);
});

test("a line taken back comes back marked so, goes out to every client, and no Bot is left to read it", async () => {
  const h = start();
  const { line, turn } = h.waiting("换成竖版");
  const response = await h.call("POST", `/v1/messages/${line.id}/withdraw`, {});
  expect(response.status).toBe(200);
  const taken = (await response.json()) as Message;
  const at = taken.withdrawn_at;
  expect(taken).toMatchObject({ id: line.id, body: "换成竖版", withdrawn_at: expect.any(String), delivery: { state: "withdrawn" } });
  expect(h.events.filter((event) => event.event === "message.upsert" && event.id === line.id).at(-1)).toMatchObject({ withdrawn_at: at });
  expect(h.store.queuedForTurn(turn.id)).toHaveLength(0);
  // Taken back already: the same answer, nothing more.
  const again = await h.call("POST", `/v1/messages/${line.id}/withdraw`, {});
  expect(again.status).toBe(200);
  expect(((await again.json()) as Message).withdrawn_at).toBe(at!);
});

test("a line a Bot read, a Bot's line, and a line waiting for nobody are refused", async () => {
  const h = start();
  const { line, item, turn } = h.waiting("换成竖版");
  h.store.deliverInboxItems([item.seq], turn.id, 1);
  const read = await h.call("POST", `/v1/messages/${line.id}/withdraw`, {});
  expect(read.status).toBe(409);
  expect(await code(read)).toBe("already_read");

  const reply = h.store.insertMessage({ sessionId: h.session, kind: "bot", author: h.bot.id, body: "好" });
  const fromBot = await h.call("POST", `/v1/messages/${reply.id}/withdraw`, {});
  expect(fromBot.status).toBe(422);
  expect(await code(fromBot)).toBe("not_withdrawable");

  const idle = h.store.postMessage(h.session, { body: "随便说一句" });
  const nowhere = await h.call("POST", `/v1/messages/${idle.id}/withdraw`, {});
  expect(nowhere.status).toBe(409);
  expect(await code(nowhere)).toBe("not_queued");
});

test("reading a line now cuts nothing when no working turn of this process holds it, and refuses what it cannot read", async () => {
  const h = start();
  const { line } = h.waiting("换成竖版");
  // The turn is a row only: no process works it, so there is nothing to cut, and the line still waits.
  const response = await h.call("POST", `/v1/messages/${line.id}/insert`, {});
  if (response.status !== 200) console.log("DEBUG", await response.clone().text());
  expect(response.status).toBe(200);
  const body = (await response.json()) as InsertMessageResponse;
  expect(body.inserted).toBe(0);
  expect(body.message.delivery?.state).toBe("queued");

  const reply = h.store.insertMessage({ sessionId: h.session, kind: "bot", author: h.bot.id, body: "好" });
  expect((await h.call("POST", `/v1/messages/${reply.id}/insert`, {})).status).toBe(422);

  h.store.holdInboxItems([h.store.getMessage(line.id).delivery ? h.store.db.query<{ seq: number }, [string]>(`SELECT seq FROM inbox_items WHERE message_id = ?`).get(line.id)!.seq : 0]);
  const held = await h.call("POST", `/v1/messages/${line.id}/insert`, {});
  expect(held.status).toBe(409);
  expect(await code(held)).toBe("held");

  await h.call("POST", `/v1/messages/${line.id}/withdraw`, {});
  const gone = await h.call("POST", `/v1/messages/${line.id}/insert`, {});
  expect(gone.status).toBe(422);
  expect(await code(gone)).toBe("withdrawn");
});
