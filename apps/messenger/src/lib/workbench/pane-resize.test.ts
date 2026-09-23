import { expect, test } from "bun:test";
import { deferWhileDragging, dragGate, onPaneResize } from "./pane-resize.svelte.ts";

test("a drag holds resize work and runs it once at the end", () => {
  let runs = 0;
  const deferred = deferWhileDragging(() => { runs += 1; });
  deferred.run();
  expect(runs).toBe(1);

  dragGate.begin();
  deferred.run();
  deferred.run();
  expect(runs).toBe(1);
  // Nested: the outer drag is still down, so the work stays held.
  dragGate.begin();
  dragGate.end();
  expect(runs).toBe(1);
  dragGate.end();
  expect(runs).toBe(2);
});

test("a watcher that goes away during a drag does not run afterwards", () => {
  let runs = 0;
  const host = document.createElement("div");
  const stop = onPaneResize(host, () => { runs += 1; });
  dragGate.begin();
  window.dispatchEvent(new Event("resize"));
  expect(runs).toBe(0);
  stop();
  dragGate.end();
  expect(runs).toBe(0);
});
