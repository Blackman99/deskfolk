import { afterEach, expect, test } from "bun:test";
import type { GroupLeadState } from "@real-bot/protocol";
import { ApiError } from "./api.ts";
import { MessengerRuntime } from "./runtime.svelte.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.destroy(); });
const suggestion: GroupLeadState = { session_id: "group/a", confirmed_bot_id: null, suggestion: { bot_id: "bot-1", handoffs: 8, since: "2026-09-12T00:00:00Z" } };

test("lead GET proposes only; explicit confirmation and clear PUT update state after success", async () => {
  const calls: unknown[] = [];
  const runtime = new MessengerRuntime(); runtimes.push(runtime);
  Reflect.set(runtime, "api", {
    get: async (path: string) => { calls.push(["GET", path]); return suggestion; },
    put: async (path: string, body: { bot_id: string | null; confirmed: true }) => { calls.push(["PUT", path, body]); return { ...suggestion, confirmed_bot_id: body.bot_id }; },
  });
  runtime.connection = "connected";
  await runtime.loadGroupLead("group/a");
  expect(calls).toEqual([["GET", "/v1/sessions/group%2Fa/lead"]]);
  expect(runtime.groupLeads["group/a"]?.confirmed_bot_id).toBeNull();
  expect(await runtime.confirmGroupLead("group/a", "bot-1")).toBeNull();
  expect(runtime.groupLeads["group/a"]?.confirmed_bot_id).toBe("bot-1");
  expect(await runtime.confirmGroupLead("group/a", null)).toBeNull();
  expect(runtime.groupLeads["group/a"]?.confirmed_bot_id).toBeNull();
  expect(calls.slice(1)).toEqual([
    ["PUT", "/v1/sessions/group%2Fa/lead", { bot_id: "bot-1", confirmed: true }],
    ["PUT", "/v1/sessions/group%2Fa/lead", { bot_id: null, confirmed: true }],
  ]);
});

test("a GET started during confirmation cannot invalidate the acknowledged human write or overwrite it afterward", async () => {
  const runtime = new MessengerRuntime(); runtimes.push(runtime);
  const read = Promise.withResolvers<GroupLeadState>();
  const write = Promise.withResolvers<GroupLeadState>();
  Reflect.set(runtime, "api", { get: async () => read.promise, put: async () => write.promise });
  runtime.connection = "connected";
  const saving = runtime.confirmGroupLead("group/a", "bot-1");
  const loading = runtime.loadGroupLead("group/a");
  write.resolve({ ...suggestion, confirmed_bot_id: "bot-1" });
  expect(await saving).toBeNull();
  read.resolve(suggestion); await loading;
  expect(runtime.groupLeads["group/a"]?.confirmed_bot_id).toBe("bot-1");
});

test("an older daemon missing the lead route is marked unsupported without a persistent load error", async () => {
  const runtime = new MessengerRuntime(); runtimes.push(runtime);
  Reflect.set(runtime, "api", { get: async () => { throw new ApiError(404, "not_found", "Route unavailable"); } });
  runtime.connection = "connected";
  await runtime.loadGroupLead("group/a");
  expect(runtime.groupLeadUnsupported["group/a"]).toBe(true);
  expect(runtime.groupLeadLoadError["group/a"]).toBe(false);
});

test("a refused confirmation keeps the confirmed lead unchanged and offline writes report failure", async () => {
  const runtime = new MessengerRuntime(); runtimes.push(runtime);
  Reflect.set(runtime, "api", { put: async () => { throw new ApiError(422, "invalid", "Bot left"); } });
  runtime.connection = "connected";
  runtime.groupLeads = { [suggestion.session_id]: { ...suggestion, confirmed_bot_id: "bot-1" } };
  expect(await runtime.confirmGroupLead(suggestion.session_id, "departed")).toBeInstanceOf(ApiError);
  expect(runtime.groupLeads[suggestion.session_id]?.confirmed_bot_id).toBe("bot-1");
  runtime.connection = "disconnected";
  expect(await runtime.confirmGroupLead(suggestion.session_id, null)).toBeInstanceOf(ApiError);
});
