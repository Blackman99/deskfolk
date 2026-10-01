import { afterEach, expect, test } from "bun:test";
import type { GroupLeadState } from "@real-bot/protocol";
import type { RemoteRequest } from "@real-bot/remote";
import { LocalApi } from "./local-api.ts";
import { RemoteApi } from "./remote/api.ts";
import { enrollment } from "./remote/test-host.ts";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { aMessage } from "./test-fixtures.ts";

const originalFetch = globalThis.fetch;
const runtimes: MessengerRuntime[] = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const runtime of runtimes.splice(0)) runtime.destroy(); });

for (const mode of ["local", "phone"] as const) {
  test(`${mode} real API transport carries manual choices, canonical corrections and confirmed lead writes`, async () => {
    const calls: unknown[] = [];
    const message = aMessage({ filing_state: "filed", filings: [{ task_id: "plan-a", ticket_id: null, part_key: null }], task_id: "plan-a" });
    const lead: GroupLeadState = { session_id: "sess-1", confirmed_bot_id: null, suggestion: { bot_id: "bot-1", handoffs: 2, since: "2026-09-12T00:00:00Z" } };
    const answer = (method: string, path: string, body: unknown): unknown => {
      calls.push([method, path, body]);
      if (path === "/v1/messages/msg-1/attribution" && method === "GET") return { items: [{ id: "plan-a", title: "EP01", tickets: [] }] };
      if (path === "/v1/messages/msg-1/attribution" && method === "PATCH") return message;
      if (path === "/v1/sessions/sess-1/lead" && method === "GET") return lead;
      if (path === "/v1/sessions/sess-1/lead" && method === "PUT") return { ...lead, confirmed_bot_id: "bot-1" };
      throw new Error(`Unexpected fixture request: ${method} ${path}`);
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return Response.json(answer(request.method, new URL(request.url).pathname, init?.body ? JSON.parse(String(init.body)) : undefined));
    }) as typeof fetch;
    const api = mode === "local" ? new LocalApi({ origin: "http://fixture.local", token: "fixture" }) : new RemoteApi(enrollment, {
      rpc: async (request: RemoteRequest) => ({ v: 1, id: request.id, status: 200, body: answer(request.method, request.path, request.body) }),
    });
    const runtime = new MessengerRuntime(); runtimes.push(runtime);
    Reflect.set(runtime, "api", api); runtime.connection = "connected";
    await runtime.loadAttributionPlans("sess-1", "msg-1");
    expect(await runtime.patchMessageAttribution("msg-1", [{ plan_id: "plan-a" }])).toBeNull();
    await runtime.loadGroupLead("sess-1");
    expect(await runtime.confirmGroupLead("sess-1", "bot-1")).toBeNull();
    expect(calls).toEqual([
      ["GET", "/v1/messages/msg-1/attribution", undefined],
      ["PATCH", "/v1/messages/msg-1/attribution", { filings: [{ plan_id: "plan-a" }] }],
      ["GET", "/v1/sessions/sess-1/lead", undefined],
      ["PUT", "/v1/sessions/sess-1/lead", { bot_id: "bot-1", confirmed: true }],
    ]);
    expect(runtime.snapshot.messages[0]).toEqual(message);
    expect(runtime.groupLeads["sess-1"]?.confirmed_bot_id).toBe("bot-1");
  });
}
