import { afterEach, expect, test } from "bun:test";
import { forgetTraceSide, loadTraceSide, saveTraceSide, TRACE_SIDE_DEFAULT } from "./trace-side.ts";

afterEach(() => forgetTraceSide());

test("the side panel opens on the tickets until the viewer picks otherwise", () => {
  expect(TRACE_SIDE_DEFAULT).toBe("tickets");
  expect(loadTraceSide()).toBe("tickets");
});

test("a closed panel stays closed, and a picked one stays picked", () => {
  saveTraceSide(null);
  expect(loadTraceSide()).toBeNull();
  saveTraceSide("spec");
  expect(loadTraceSide()).toBe("spec");
  saveTraceSide("tickets");
  expect(loadTraceSide()).toBe("tickets");
});

test("anything else in storage falls back to the default", () => {
  window.localStorage.setItem("real-bot-trace-side", "sideways");
  expect(loadTraceSide()).toBe("tickets");
});
