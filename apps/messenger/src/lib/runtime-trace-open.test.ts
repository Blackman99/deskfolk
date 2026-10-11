import { afterEach, expect, test } from "bun:test";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { emptySnapshot } from "./snapshot.ts";
import { aBot, aDirect, aGroup } from "./test-fixtures.ts";
import { forgetTraceView, loadTraceView, saveTraceView } from "./overlays/trace-view.ts";
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

test("on a wide window a job opens as its conversation's one flow tab, the line's ticket picked in it", () => {
  const runtime = aRuntime();
  const opened: PaneContent[] = [];
  runtime.paneOpener = (content) => opened.push(content);
  runtime.openTrace("task-1", { messageId: "m1", turnId: "turn-1" }, { ticket: "tk-2" });
  runtime.openTrace(null, null, { sessionId: "g1" });
  runtime.openTrace("task-1");
  expect(opened.map((content) => content.kind === "trace" && [content.sessionId, content.taskId, content.view ?? null, content.focus?.messageId ?? null, content.ticket ?? null, Boolean(content.askNonce)])).toEqual([
    // A message's card, and the ticket it was filed under picked (ADR 0086).
    ["direct-1", "task-1", null, "m1", "tk-2", true],
    // Another conversation's, from its row, without making it the one on screen.
    ["g1", null, null, null, null, false],
    ["direct-1", "task-1", null, null, null, false],
  ]);
  expect(runtime.selectedId).toBe("direct-1");
  expect(runtime.traceOpen).toBe(false);
});

test("on a phone the job is one page, and opening it leaves the part you were last on", () => {
  const runtime = aRuntime();
  saveTraceView("spec");
  runtime.openTrace("task-1");
  expect(runtime.traceOpen).toBe(true);
  expect(runtime.traceTaskId).toBe("task-1");
  expect(loadTraceView()).toBe("spec");
});

test("a line in no job opens its own flow: a tab on a wide window, the trace page on a phone (ADR 0083)", () => {
  const wide = aRuntime();
  const opened: PaneContent[] = [];
  wide.paneOpener = (content) => opened.push(content);
  wide.openTrace(null, null, { line: "m-9", ticket: "tk-2" });
  expect(opened).toMatchObject([{ kind: "trace", sessionId: "direct-1", taskId: null, line: "m-9", ticket: null }]);

  const phone = aRuntime();
  phone.openTrace(null, null, { line: "m-9" });
  expect([phone.traceOpen, phone.traceLine]).toEqual([true, "m-9"]);
  // A job asked for afterwards is that job's, not the line's.
  phone.closeTrace();
  expect(phone.traceLine).toBeNull();
});

test("Roles opens as a tab at the call asked for, or as a page where there is no workbench (ADR 0083)", () => {
  const wide = aRuntime();
  const opened: PaneContent[] = [];
  wide.paneOpener = (content) => opened.push(content);
  wide.openRoles("judgement");
  expect(opened).toEqual([{ kind: "roles" }]);
  expect(wide.rolesTarget).toEqual({ role: "judgement" });
  expect(wide.listPage).toBeNull();

  const phone = aRuntime();
  phone.openRoles();
  expect(phone.listPage).toBe("roles");
  expect(phone.rolesTarget).toEqual({ role: null });
});
