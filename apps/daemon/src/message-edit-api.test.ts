/**
 * `PATCH /v1/messages/:id` and `GET /v1/messages/:id/versions` (ADR 0063): one receipted write that
 * changes a line of yours and tells whoever read it, and what the line said before.
 */
import { afterEach, expect, test } from "bun:test";
import type { ClientEvent, Message, MessageVersionsResponse, RuntimeSnapshot } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

function start() {
  const store = new Store({ endpointKey: memoryKeyStore() });
  store.raiseEngineLevel(null);
  const api = createLocalApi({ store, token: "edit-test", schedule: false });
  const events: ClientEvent[] = [];
  api.subscribeSync((frame) => { if (frame.type === "event") events.push(frame.payload); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { await api.engine.close(); store.close(); await server.stop(true); });
  const origin = `http://${server.hostname}:${server.port}`;
  const call = (method: string, path: string, body?: unknown, requestId?: string) => fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: "Bearer edit-test",
      "Content-Type": "application/json",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const session = bot.direct_session.id;
  return { store, call, session, bot: bot.bot, events };
}

async function code(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

test("a change to a line of yours comes back as the line now reads, goes out to every client, and replays by its request id", async () => {
  const h = start();
  const line = h.store.postMessage(h.session, { body: "片长 30 秒" });
  const response = await h.call("PATCH", `/v1/messages/${line.id}`, { body: "片长 45 秒" }, "01J0E0000000000000000000AA");
  expect(response.status).toBe(200);
  const changed = (await response.json()) as Message;
  expect(changed).toMatchObject({ id: line.id, body: "片长 45 秒", edited_at: expect.any(String) });
  expect(h.events.filter((event) => event.event === "message.upsert" && event.id === line.id).at(-1)).toMatchObject({ body: "片长 45 秒" });

  // The same request again is the same answer, not a second change.
  const again = await h.call("PATCH", `/v1/messages/${line.id}`, { body: "片长 45 秒" }, "01J0E0000000000000000000AA");
  expect(again.status).toBe(200);
  expect(h.store.messageVersions(line.id)).toHaveLength(1);
  // Other words under the same request id are refused.
  expect((await h.call("PATCH", `/v1/messages/${line.id}`, { body: "片长 60 秒" }, "01J0E0000000000000000000AA")).status).toBe(409);

  const versions = await h.call("GET", `/v1/messages/${line.id}/versions`);
  expect(versions.status).toBe(200);
  expect((await versions.json()) as MessageVersionsResponse).toEqual({ versions: [{ body: "片长 30 秒", created_at: line.created_at }] });
});

test("only the words of a line of yours can be changed", async () => {
  const h = start();
  const line = h.store.postMessage(h.session, { body: "片长 30 秒" });
  const reply = h.store.insertMessage({ sessionId: h.session, kind: "bot", author: h.bot.id, body: "好" });

  const fromBot = await h.call("PATCH", `/v1/messages/${reply.id}`, { body: "不好" });
  expect(fromBot.status).toBe(422);
  expect(await code(fromBot)).toBe("not_editable");

  const extra = await h.call("PATCH", `/v1/messages/${line.id}`, { body: "片长 45 秒", parent_id: null });
  expect(extra.status).toBe(422);
  expect(await code(extra)).toBe("invalid_args");

  const empty = await h.call("PATCH", `/v1/messages/${line.id}`, { body: "  " });
  expect(empty.status).toBe(422);
  expect(await code(empty)).toBe("invalid_args");

  expect((await h.call("PATCH", "/v1/messages/01J0NOTHING000000000000000", { body: "x" })).status).toBe(404);
  expect(h.store.getMessage(line.id).body).toBe("片长 30 秒");
});

test("the snapshot says lines are taken in order and can be changed", async () => {
  const h = start();
  const response = await h.call("GET", "/v1/snapshot");
  expect(response.status).toBe(200);
  expect((await response.json()) as RuntimeSnapshot).toMatchObject({ turnInbox: true, linesInOrder: true, messageEdits: true });
});
