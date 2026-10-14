import { afterEach, expect, test } from "bun:test";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { fakeApi } from "./test-mocks.ts";
import { aMessage } from "./test-fixtures.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.destroy(); });

function connected(api: object): MessengerRuntime {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  Reflect.set(runtime, "api", fakeApi(api));
  runtime.connection = "connected";
  return runtime;
}

test("the job list loads every job with its tickets, those of other conversations too", async () => {
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

test("a line arriving never loads the job list: where it is filed is not shown in the conversation (2026-10-14)", async () => {
  const calls: string[] = [];
  const runtime = connected({ get: async (path: string) => { calls.push(path); return { items: [] }; } });
  const ingest = (message: ReturnType<typeof aMessage>) => Reflect.get(runtime, "ingest").call(runtime, { ...message, event: "message.created", occurred_at: "now" });
  ingest(aMessage({ id: "m-1", session_id: "group-1", filing_state: "filed", filings: [{ task_id: "plan-a", ticket_id: null, part_key: null }] }));
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toEqual([]);
});
