import "../../platform/install";
import { expect, test } from "nsh/test";
import { deferWhileDragging, dragGate } from "./pane-resize.svelte.ts";

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
