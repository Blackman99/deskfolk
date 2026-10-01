import { afterEach, expect, test } from "bun:test";
import type { WorkAnswerResult } from "@real-bot/protocol";
import type { RemoteRequest } from "@real-bot/remote";
import { ApiError } from "./api.ts";
import { LocalApi } from "./local-api.ts";
import { RemoteApi } from "./remote/api.ts";
import { enrollment } from "./remote/test-host.ts";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { aMessage } from "./test-fixtures.ts";

const originalFetch = globalThis.fetch;
const runtimes: MessengerRuntime[] = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const runtime of runtimes.splice(0)) runtime.destroy(); });
const body = "  第二版 🦊\n保留原样\n ";
const message = aMessage({ kind: "system", author: "bot-1", control: { kind: "work_question", work_item_id: "work-1", task_id: "plan-1", ticket_id: null, question: "哪一版？", offer: [], answer: { body, at: "2026-10-01T02:00:00.000Z", user_action_id: "action-1", inbox_seq: 3 } } });

for (const mode of ["local", "phone"] as const) {
  test(`${mode} generic POST sends exact work answer, explicitly retries the same canonical receipt id, and never sends a resume`, async () => {
    const calls: Array<{ method: string; path: string; body: unknown; id: string | null }> = [];
    const result: WorkAnswerResult = { message, work_item_id: "work-1", inbox_state: "held", answered: true };
    let lose = true;
    const respond = (method: string, path: string, input: unknown, id: string | null) => {
      calls.push({ method, path, body: input, id });
      if (lose) { lose = false; throw new Error("committed response lost"); }
      return result;
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return Response.json(respond(request.method, new URL(request.url).pathname, JSON.parse(String(init?.body)), request.headers.get("X-Request-Id")));
    }) as typeof fetch;
    const api = mode === "local" ? new LocalApi({ origin: "http://fixture.local", token: "fixture" }) : new RemoteApi(enrollment, {
      rpc: async (request: RemoteRequest) => ({ v: 1, id: request.id, status: 200, body: respond(request.method, request.path, request.body, request.id) }),
    });
    const runtime = new MessengerRuntime(); runtimes.push(runtime);
    Reflect.set(runtime, "api", api); runtime.connection = "connected";
    const failed = await runtime.answerWorkQuestion(message.id, body);
    expect(failed).toBeInstanceOf(ApiError);
    expect(failed instanceof ApiError && failed.code).toBe("request_unknown");
    expect(calls).toHaveLength(1);
    expect(runtime.snapshot.messages).toEqual([]);
    // No reconnect timer, automatic retry, or hold lift: the human explicitly tries again.
    expect(await runtime.answerWorkQuestion(message.id, body)).toEqual(result);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/messages/msg-1/work-answer", body: { body } });
    expect(calls[0]?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(runtime.snapshot.messages).toEqual([message]);
  });
}
