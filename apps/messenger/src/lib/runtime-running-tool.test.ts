import { afterEach, expect, test } from "bun:test";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { aTurn } from "./test-fixtures.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.destroy(); });

test("a turn whose tool start this window never saw shows the call the daemon says it is running", () => {
  // 2026-10-04: opened while a Bot's `qlmanage` hung, the window said 「思考中」 for ten minutes.
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  runtime.snapshot.turns = [aTurn({ id: "turn-1", running_tool: { id: "call-1", name: "shell", target: "qlmanage -t -s 1920 -o . poster.svg", started_at: "2026-10-04T00:01:00.000Z" } })];
  expect(runtime.stepOf("turn-1")).toEqual({ id: "call-1", name: "shell", target: "qlmanage -t -s 1920 -o . poster.svg", mcp: null, running: true,
    startedAt: Date.parse("2026-10-04T00:01:00.000Z"), exitCode: null, durationMs: null });
  runtime.snapshot.turns = [aTurn({ id: "turn-1" })];
  expect(runtime.stepOf("turn-1")).toBeNull();
});
