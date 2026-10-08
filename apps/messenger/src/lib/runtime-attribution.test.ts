import { afterEach, expect, test } from "bun:test";
import { ApiError } from "./api.ts";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { fakeApi } from "./test-mocks.ts";
import { aDirect, aMessage } from "./test-fixtures.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.destroy(); });

function connected(api: object): MessengerRuntime {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  Reflect.set(runtime, "api", fakeApi(api));
  runtime.connection = "connected";
  return runtime;
}

test("runtime PATCH uses canonical multi-filings and installs full response in transcript and sidebar", async () => {
  const original = aMessage();
  const updated = aMessage({ task_id: "plan-a", ticket_id: "ticket-a", filing_state: "filed", filings: [
    { task_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" },
    { task_id: "plan-b", ticket_id: null, part_key: null },
  ] });
  const requests: unknown[] = [];
  const runtime = connected({ patch: async (path: string, body: unknown) => { requests.push([path, body]); return updated; } });
  runtime.snapshot.messages = [original];
  runtime.snapshot.sessions = [aDirect({ id: original.session_id, last_message: original, unread_count: 3 })];
  const input = [{ plan_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 01" }, { plan_id: "plan-b" }];
  expect(await runtime.patchMessageAttribution(original.id, input)).toBeNull();
  expect(requests).toEqual([["/v1/messages/msg-1/attribution", { filings: input }]]);
  expect(runtime.snapshot.messages[0]).toEqual(updated);
  expect(runtime.snapshot.sessions[0]?.last_message).toEqual(updated);
  expect(runtime.snapshot.sessions[0]?.unread_count).toBe(3);
});

test("runtime refuses offline or failed corrections without mutating attribution, accepts explicit unfile", async () => {
  const original = aMessage({ filing_state: "filed", filings: [{ task_id: "old", ticket_id: null, part_key: null }] });
  const runtime = connected({ patch: async () => { throw new ApiError(422, "invalid", "Unknown plan"); } });
  runtime.snapshot.messages = [original];
  expect(await runtime.patchMessageAttribution(original.id, [{ plan_id: "missing" }])).toBeInstanceOf(ApiError);
  expect(runtime.snapshot.messages[0]).toEqual(original);
  runtime.connection = "disconnected";
  expect(await runtime.patchMessageAttribution(original.id, [])).toBeInstanceOf(ApiError);
  const unfiled = aMessage({ filing_state: "none", filings: [], task_id: null, ticket_id: null });
  Reflect.set(runtime, "api", fakeApi({ patch: async (_path: string, body: unknown) => { expect(body).toEqual({ filings: [] }); return unfiled; } }));
  runtime.connection = "connected";
  expect(await runtime.patchMessageAttribution(original.id, [])).toBeNull();
  expect(runtime.snapshot.messages[0]).toEqual(unfiled);
});

test("runtime loads all manual attribution choices including untouched plans from other sessions", async () => {
  const calls: string[] = [];
  const runtime = connected({
    get: async (path: string) => { calls.push(path); return { items: [
      { id: "plan-a", title: "EP01", tickets: [{ id: "ticket-a", title: "剪辑" }] },
      { id: "plan-b", title: "海报", tickets: [] },
    ] }; },
  });
  runtime.snapshot.messages = [aMessage({ filing_state: "undetermined", filings: [] })];
  await runtime.loadAttributionPlans("sess-1", "msg-1");
  expect(calls).toEqual(["/v1/messages/msg-1/attribution"]);
  expect(runtime.attributionPlans["sess-1"]).toEqual([
    { id: "plan-a", title: "EP01", tickets: [{ id: "ticket-a", title: "剪辑" }] },
    { id: "plan-b", title: "海报", tickets: [] },
  ]);
});

test("a line on a job the conversation's list lacks loads the list again, once per job", async () => {
  // 2026-10-03: the first line in a new group was filed under a job, and its tag read 「一件事」
  // until a reload: the list loads when a conversation opens, from one of its lines, and it had none.
  const calls: string[] = [];
  const runtime = connected({ get: async (path: string) => { calls.push(path); return { items: [{ id: "plan-a", title: "一拳超人", tickets: [] }] }; } });
  const ingest = (message: ReturnType<typeof aMessage>) => Reflect.get(runtime, "ingest").call(runtime, { ...message, event: "message.created", occurred_at: "now" });
  const on = (task_id: string) => ({ filing_state: "filed" as const, filings: [{ task_id, ticket_id: null, part_key: null }] });
  ingest(aMessage({ id: "m-1", session_id: "group-1", ...on("plan-a") }));
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toEqual(["/v1/messages/m-1/attribution"]);
  expect(runtime.attributionPlans["group-1"]?.map((plan) => plan.title)).toEqual(["一拳超人"]);
  // Listed now: no reload. A job it still lacks after a reload is not asked about again.
  ingest(aMessage({ id: "m-2", session_id: "group-1", kind: "bot", author: "bot-1", ...on("plan-a") }));
  ingest(aMessage({ id: "m-3", session_id: "group-1", ...on("plan-gone") }));
  await Promise.resolve(); await Promise.resolve();
  ingest(aMessage({ id: "m-4", session_id: "group-1", ...on("plan-gone") }));
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toEqual(["/v1/messages/m-1/attribution", "/v1/messages/m-3/attribution"]);
});
