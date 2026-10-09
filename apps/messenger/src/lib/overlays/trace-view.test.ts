import { afterEach, expect, test } from "bun:test";
import { forgetTraceView, loadTraceView, saveTraceView, TRACE_VIEW_DEFAULT } from "./trace-view.ts";

afterEach(() => forgetTraceView());

test("the pane opens on the trace until the viewer picks another view", () => {
  expect(TRACE_VIEW_DEFAULT).toBe("trace");
  expect(loadTraceView()).toBe("trace");
});

test("a picked view stays picked", () => {
  saveTraceView("board");
  expect(loadTraceView()).toBe("board");
  saveTraceView("spec");
  expect(loadTraceView()).toBe("spec");
  saveTraceView("trace");
  expect(loadTraceView()).toBe("trace");
});

test("anything else in storage falls back to the trace", () => {
  window.localStorage.setItem("real-bot-trace-view", "sideways");
  expect(loadTraceView()).toBe("trace");
});
