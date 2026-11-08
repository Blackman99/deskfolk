/** The workbench keeps a layout's objects while they say the same. */
import { expect, test } from "nsh/test";
import type { BranchNode, LeafNode, WorkbenchLayout } from "../../m/workbench/layout-types.ts";
import { createLayoutSharer } from "./layout-share";

const leaf = (id: string, sessionId: string): LeafNode => ({ id, type: "leaf", tabs: [{ id: `${id}-t`, kind: "chat", params: { sessionId } }], activeTabId: `${id}-t` });
const two = (weights: number[], right = "s2"): WorkbenchLayout => ({
  version: 1,
  root: { id: "root", type: "branch", axis: "row", weights, children: [leaf("a", "s1"), leaf("b", right)] },
  floating: [{ leaf: leaf("f", "s3"), frame: { x: 10, y: 10, width: 300, height: 200 } }],
  focus: { zone: "tiled", leafId: "a" },
});
const kids = (layout: WorkbenchLayout) => (layout.root as BranchNode).children as LeafNode[];

test("a fresh copy of the same layout is the layout handed out before", () => {
  const share = createLayoutSharer();
  const first = share(two([0.5, 0.5]));
  expect(share(JSON.parse(JSON.stringify(first)))).toBe(first);
});

test("a divider moved keeps every pane, tab and params object", () => {
  const share = createLayoutSharer();
  const first = share(two([0.5, 0.5]));
  const moved = share(two([0.6, 0.4]));
  expect(moved).not.toBe(first);
  expect(moved.root).not.toBe(first.root);
  expect(kids(moved)[0]).toBe(kids(first)[0]);
  expect(kids(moved)[1]).toBe(kids(first)[1]);
  expect(kids(moved)[1]!.tabs[0]!.params).toBe(kids(first)[1]!.tabs[0]!.params);
  expect(moved.floating[0]).toBe(first.floating[0]);
});

test("a tab that shows something else is new, and so is its pane, but not the other pane", () => {
  const share = createLayoutSharer();
  const first = share(two([0.5, 0.5]));
  const changed = share(two([0.5, 0.5], "s9"));
  expect(kids(changed)[0]).toBe(kids(first)[0]);
  expect(kids(changed)[1]).not.toBe(kids(first)[1]);
  expect(kids(changed)[1]!.tabs[0]!.params.sessionId).toBe("s9");
});

test("focus and a floating pane moved are seen", () => {
  const share = createLayoutSharer();
  const first = share(two([0.5, 0.5]));
  const focused = share({ ...two([0.5, 0.5]), focus: { zone: "tiled", leafId: "b" } });
  expect(focused).not.toBe(first);
  expect(focused.root).toBe(first.root);
  const moved = share({ ...two([0.5, 0.5]), floating: [{ leaf: leaf("f", "s3"), frame: { x: 40, y: 10, width: 300, height: 200 } }] });
  expect(moved.floating[0]).not.toBe(first.floating[0]);
  expect(moved.floating[0]!.leaf).toBe(first.floating[0]!.leaf);
});
