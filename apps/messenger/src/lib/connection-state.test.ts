import { afterEach, expect, test } from "bun:test";
import { MessengerRuntime } from "./runtime.svelte.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
});

function fresh(): { runtime: MessengerRuntime; internals: { tick(): Promise<void>; connectFailures: number; stopped: boolean } } {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  return { runtime, internals: runtime as unknown as { tick(): Promise<void>; connectFailures: number; stopped: boolean } };
}

test("a page that has not connected yet is connecting, not unreachable", () => {
  const { runtime } = fresh();
  expect(runtime.connection).toBe("connecting");
});

test("a run of failed attempts is what makes a host unreachable", async () => {
  const { runtime, internals } = fresh();
  internals.stopped = false;
  // No daemon anywhere: every attempt fails.
  for (let i = 0; i < 2; i++) {
    await internals.tick();
    expect(runtime.connection).toBe("connecting");
  }
  await internals.tick();
  await internals.tick();
  expect(runtime.connection).toBe("disconnected");
});

test("retrying by hand says so immediately", async () => {
  const { runtime, internals } = fresh();
  internals.stopped = false;
  internals.connectFailures = 9;
  await internals.tick();
  expect(runtime.connection).toBe("disconnected");
  runtime.retryConnection();
  expect(runtime.connection).toBe("connecting");
});

test("a connected runtime ignores a retry", () => {
  const { runtime } = fresh();
  (runtime as unknown as { connection: string }).connection = "connected";
  runtime.retryConnection();
  expect(runtime.connection).toBe("connected");
});
