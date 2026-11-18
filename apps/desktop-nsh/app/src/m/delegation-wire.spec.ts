import { expect, test } from "bun:test";
import { LocalApi } from "./local-api.ts";

const api = new LocalApi({ origin: "http://127.0.0.1:17890", token: "test" });
const projection = { event: "delegation.changed", occurred_at: "now", id: "d", task_id: "plan", ticket_id: null,
  thread_session_id: "thread", from_bot_id: "director", to_bot_id: "reviewer", ask: "review", expects: "review",
  status: "open", part_keys: ["shot_11"], requirement_ids: [], created_at: "now", request_message_id: null,
  result_message_id: null, reply: null, wait: { state: "waiting", since: "now", due_at: "now" } };
const parse = (patch: object = {}) => api.parseSyncFrame(JSON.stringify({ type: "event", event_instance_id: "a".repeat(32), seq: 1, payload: { ...projection, ...patch } }));

test("persisted structured handoffs reject malformed contracts before either client renders them", () => {
  expect(parse()).not.toBeNull();
  expect(parse({ wait: { state: "waiting", since: "now", due_at: null } })).not.toBeNull();
  expect(parse({ status: "replied", reply: { body: "passed", created_at: "later", ref: "answer:t" }, wait: null })).not.toBeNull();
  for (const patch of [{ id: null }, { expects: ["review"] }, { status: "done" }, { part_keys: {} },
    { requirement_ids: [1] }, { reply: { body: 4, created_at: "later", ref: null } },
    { wait: { state: "guess", since: "now", due_at: "later" } },
    { wait: { state: "waiting", since: "now", due_at: 0 } }, { status: "replied" }]) {
    expect(parse(patch)).toBeNull();
  }
});
