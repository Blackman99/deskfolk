import { expect, test } from "bun:test";
import { LocalApi } from "./local-api.ts";

const api = new LocalApi({ origin: "http://127.0.0.1:17890", token: "test" });
const control = { kind: "work_question", work_item_id: "work", task_id: "task", ticket_id: null, question: "Which version?", offer: [] };
const parse = (next: object) => api.parseSyncFrame(JSON.stringify({ type: "event", event_instance_id: "a".repeat(32), seq: 1,
  payload: { event: "message.upsert", id: "question", session_id: "home", kind: "system", control: next } }));

test("durable work-question wire accepts actual unanswered and answered metadata, not fake routing or answer shapes", () => {
  expect(parse(control)).not.toBeNull();
  expect(parse({ ...control, answer: { body: "V3", at: "now", user_action_id: "request-1", inbox_seq: 1 } })).not.toBeNull();
  for (const patch of [{ work_item_id: null }, { task_id: 3 }, { ticket_id: [] }, { question: " " }, { offer: ["continue"] },
    { answer: { body: "V3", at: "now", user_action_id: "request-1", inbox_seq: -1 } },
    { answer: { body: 2, at: "now", user_action_id: "request-1", inbox_seq: 1 } }]) expect(parse({ ...control, ...patch })).toBeNull();
});
