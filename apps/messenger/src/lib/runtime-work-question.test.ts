import { afterEach, expect, test } from "bun:test";
import type { WorkAnswerResult, WorkQuestionControl } from "@real-bot/protocol";
import { ApiError } from "./api.ts";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { fakeApi } from "./test-mocks.ts";
import { aDirect, aHold, aMessage, aTurn } from "./test-fixtures.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.destroy(); });

const question: WorkQuestionControl = { kind: "work_question", work_item_id: "work-1", task_id: "plan-1", ticket_id: "ticket-1", question: "请给出片长\n与画幅。", offer: [] };
const original = aMessage({ kind: "system", author: "bot-1", turn_id: "ended-turn", control: question, body: "工作需要你的回答" });
const body = "  使用 ９０ 秒 🎬\n画幅 竖屏 9:16\n ";
const answered = aMessage({ ...original, control: { ...question, answer: { body, at: "2026-10-01T02:00:00.000Z", user_action_id: "answer-1", inbox_seq: 12 } } });

function connected(api: object): MessengerRuntime {
  const runtime = new MessengerRuntime(); runtimes.push(runtime);
  Reflect.set(runtime, "api", fakeApi(api)); runtime.connection = "connected";
  return runtime;
}

test("work answer POST preserves exact free text and installs authoritative message, without waking an ended turn or lifting its hold", async () => {
  const calls: unknown[] = [];
  const receipt: WorkAnswerResult = { message: answered, work_item_id: "work-1", inbox_state: "held", answered: true };
  const runtime = connected({ post: async (path: string, input: unknown) => { calls.push([path, input]); return receipt; } });
  runtime.snapshot.messages = [original];
  runtime.snapshot.sessions = [aDirect({ last_message: original, unread_count: 3 })];
  runtime.snapshot.turns = [aTurn({ id: "ended-turn", status: "completed", pending_ask_id: null })];
  runtime.snapshot.holds = [aHold()];
  expect(await runtime.answerWorkQuestion(original.id, body)).toEqual(receipt);
  expect(calls).toEqual([["/v1/messages/msg-1/work-answer", { body }]]);
  expect(runtime.snapshot.messages).toEqual([answered]);
  expect(runtime.snapshot.sessions[0]?.last_message).toEqual(answered);
  expect(runtime.snapshot.sessions[0]?.unread_count).toBe(3);
  expect(runtime.snapshot.turns[0]?.status).toBe("completed");
  expect(runtime.snapshot.holds).toEqual([aHold()]);
});

for (const reason of ["bot_archived", "plan_deleted", "work_closed", "already_answered"]) {
  test(`work answer refusal (${reason}) does not overwrite the question`, async () => {
    const error = new ApiError(409, reason, "This work cannot receive an answer");
    const runtime = connected({ post: async () => { throw error; } });
    runtime.snapshot.messages = [original];
    expect(await runtime.answerWorkQuestion(original.id, body)).toBe(error);
    expect(runtime.snapshot.messages).toEqual([original]);
  });
}

test("system-only work questions load the real bound plan and ticket context without a legacy ask", async () => {
  const calls: string[] = [];
  const runtime = connected({ get: async (path: string) => { calls.push(path); return { items: [{ id: "plan-1", title: "预告片", tickets: [{ id: "ticket-1", title: "竖屏剪辑" }] }] }; } });
  runtime.snapshot.messages = [original];
  await runtime.loadAttributionPlans(original.session_id);
  expect(calls).toEqual(["/v1/messages/msg-1/attribution"]);
  expect(runtime.attributionPlans[original.session_id]?.[0]?.title).toBe("预告片");
});

test("work answer rejects blank/offline without a request and encodes the message id", async () => {
  const calls: unknown[] = [];
  const runtime = connected({ post: async (path: string, input: unknown) => { calls.push([path, input]); return { message: answered, work_item_id: "work-1", inbox_state: "queued", answered: true }; } });
  expect(await runtime.answerWorkQuestion("msg /🎬", " \n\t")).toBeInstanceOf(ApiError);
  runtime.connection = "disconnected";
  expect(await runtime.answerWorkQuestion("msg /🎬", body)).toBeInstanceOf(ApiError);
  expect(calls).toEqual([]);
  runtime.connection = "connected";
  await runtime.answerWorkQuestion("msg /🎬", body);
  expect(calls).toEqual([["/v1/messages/msg%20%2F%F0%9F%8E%AC/work-answer", { body }]]);
});
