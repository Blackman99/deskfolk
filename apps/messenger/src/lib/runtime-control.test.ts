import { afterEach, expect, test } from "bun:test";
import type { ControlActionResult } from "@real-bot/protocol";
import { ApiError } from "./api.ts";
import type { MessengerApi } from "./messenger-api.ts";
import { MessengerRuntime } from "./runtime.svelte.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
});

function connected(answer: () => Promise<ControlActionResult>): MessengerRuntime {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const api = { controlAction: answer } as unknown as MessengerApi;
  (runtime as unknown as { api: MessengerApi | null; connection: string }).api = api;
  (runtime as unknown as { connection: string }).connection = "connected";
  return runtime;
}

test("a button's press comes back as nothing, a refusal, or a restart's 继续 that a stop kept from some turns", async () => {
  expect(await connected(async () => ({ made: [], lifted: [] })).controlAction("notice", "resume")).toBeNull();
  expect(await connected(async () => ({ made: [], lifted: [], partial: { continued: 2, held: 1 } })).controlAction("notice", "resume")).toEqual({
    partial: { continued: 2, held: 1 },
  });
  const refused = await connected(async () => {
    throw new ApiError(409, "held", "a stop of yours covers this job");
  }).controlAction("notice", "resume");
  expect(refused).toBeInstanceOf(ApiError);
  expect((refused as ApiError).status).toBe(409);
});
