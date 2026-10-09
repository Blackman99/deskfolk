import { afterEach, expect, test } from "bun:test";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { emptySnapshot } from "./snapshot.ts";
import { aBot, aDirect, aGroup } from "./test-fixtures.ts";
import { forgetTraceView, loadTraceView } from "./overlays/trace-view.ts";
import type { PaneContent } from "./workbench/pane-content.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
  forgetTraceView();
});

function aRuntime(): MessengerRuntime {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  runtime.snapshot = { ...emptySnapshot(), bots: [aBot()], sessions: [aDirect(), aGroup({ id: "g1" })] };
  runtime.selectedId = "direct-1";
  return runtime;
}

test("on a wide window each view of a job opens as its own tab, the board with the line's ticket picked", () => {
  const runtime = aRuntime();
  const opened: PaneContent[] = [];
  runtime.paneOpener = (content) => opened.push(content);
  runtime.openTrace("task-1", null, { view: "board", ticket: "tk-2" });
  runtime.openTrace("task-1", null, { view: "spec", ticket: "tk-2" });
  runtime.openTrace(null, null, { view: "trace", sessionId: "g1" });
  runtime.openTrace("task-1", { messageId: "m1", turnId: "turn-1" }, { view: "board" });
  expect(opened.map((content) => content.kind === "trace" && [content.sessionId, content.taskId, content.view, content.ticket ?? null, Boolean(content.askNonce)])).toEqual([
    ["direct-1", "task-1", "board", "tk-2", true],
    // Only the board picks a ticket.
    ["direct-1", "task-1", "spec", null, false],
    // Another conversation's, from its row, without making it the one on screen.
    ["g1", null, "trace", null, false],
    // A message's card is on the trace.
    ["direct-1", "task-1", "trace", null, false],
  ]);
  expect(runtime.selectedId).toBe("direct-1");
  expect(runtime.traceOpen).toBe(false);
});

test("on a phone the job is one page, opened on the view asked for", () => {
  const runtime = aRuntime();
  runtime.openTrace("task-1", null, { view: "spec" });
  expect(runtime.traceOpen).toBe(true);
  expect(runtime.traceTaskId).toBe("task-1");
  expect(loadTraceView()).toBe("spec");
  // A plain open leaves the view you were last on.
  runtime.closeTrace();
  runtime.openTrace("task-1");
  expect(loadTraceView()).toBe("spec");
});
