import { expect, test } from "bun:test";
import type { Axis, LayoutNode, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import {
  activateTab,
  addTab,
  assertInvariants,
  closeLeaf,
  closeTab,
  emptyLayout,
  findPath,
  floatLeaf,
  focusLeaf,
  isLeaf,
  leafById,
  makeBranch,
  makeLeaf,
  nodeAt,
  normalise,
  renormalise,
  reorderTab,
  splitLeaf,
  tiledLeaves,
} from "./layout-tree.ts";

let counter = 0;
const nextId = () => `n${++counter}`;
const aTab = (id: string, kind = "chat"): WorkbenchTab => ({ id, kind, params: {} });

function layoutOf(root: LayoutNode, focusId?: string): WorkbenchLayout {
  return {
    version: 1,
    root,
    floating: [],
    focus: { zone: "tiled", leafId: focusId ?? tiledLeaves(root)[0]!.id },
  };
}

test("an empty layout is one pane with nothing in it", () => {
  const layout = emptyLayout("root");
  expect(isLeaf(layout.root)).toBe(true);
  expect((layout.root as { tabs: unknown[] }).tabs).toEqual([]);
  expect(layout.focus).toEqual({ zone: "tiled", leafId: "root" });
  assertInvariants(layout);
});

test("weights are made to sum to one, and nonsense becomes an equal share", () => {
  expect(renormalise([1, 1])).toEqual([0.5, 0.5]);
  expect(renormalise([3, 1]).map((w) => Number(w.toFixed(3)))).toEqual([0.75, 0.25]);
  expect(renormalise([Number.NaN, 5])).toEqual([0.5, 0.5]);
  expect(renormalise([0, 0])).toEqual([0.5, 0.5]);
  expect(renormalise([-2, 2])).toEqual([0.5, 0.5]);
  expect(renormalise([])).toEqual([]);
});

test("splitting the root pane makes a branch of two", () => {
  const layout = layoutOf(makeLeaf("a", [aTab("t1")]));
  const next = splitLeaf(layout, "a", "row", "after", [aTab("t2")], { leaf: "b", branch: "br" });
  expect(next.root.type).toBe("branch");
  expect(tiledLeaves(next.root).map((leaf) => leaf.id)).toEqual(["a", "b"]);
  expect((next.root as { weights: number[] }).weights).toEqual([0.5, 0.5]);
  // The new pane is where you are now: you asked for it.
  expect(next.focus.leafId).toBe("b");
  assertInvariants(next);
});

test("splitting before puts the new pane on the near side", () => {
  const layout = layoutOf(makeLeaf("a", [aTab("t1")]));
  const next = splitLeaf(layout, "a", "row", "before", [aTab("t2")], { leaf: "b", branch: "br" });
  expect(tiledLeaves(next.root).map((leaf) => leaf.id)).toEqual(["b", "a"]);
  assertInvariants(next);
});

test("splitting the same way again joins the row instead of nesting", () => {
  // Nesting would make the A|B divider resize A against B+C, so dragging an edge would move a
  // pane it does not touch. Readers call that a bug.
  let layout = layoutOf(makeLeaf("a", [aTab("t1")]));
  layout = splitLeaf(layout, "a", "row", "after", [aTab("t2")], { leaf: "b", branch: "br1" });
  layout = splitLeaf(layout, "b", "row", "after", [aTab("t3")], { leaf: "c", branch: "br2" });

  expect(layout.root.type).toBe("branch");
  const root = layout.root as { children: LayoutNode[]; weights: number[] };
  expect(root.children.map((child) => child.id)).toEqual(["a", "b", "c"]);
  // B gave up half of its own share; A never moved.
  expect(root.weights.map((w) => Number(w.toFixed(3)))).toEqual([0.5, 0.25, 0.25]);
  assertInvariants(layout);
});

test("splitting the other way nests, and the axes alternate", () => {
  let layout = layoutOf(makeLeaf("a", [aTab("t1")]));
  layout = splitLeaf(layout, "a", "row", "after", [aTab("t2")], { leaf: "b", branch: "br1" });
  layout = splitLeaf(layout, "b", "column", "after", [aTab("t3")], { leaf: "c", branch: "br2" });

  const root = layout.root as { axis: Axis; children: LayoutNode[] };
  expect(root.axis).toBe("row");
  expect(root.children[1]!.type).toBe("branch");
  expect((root.children[1] as { axis: Axis }).axis).toBe("column");
  assertInvariants(layout);
});

test("normalise flattens a branch inside a branch of the same axis", () => {
  // This is the rule that produces four-way crosses; without it there are only T-junctions.
  const inner = makeBranch("inner", "row", [makeLeaf("b"), makeLeaf("c")], [0.5, 0.5]);
  const outer = makeBranch("outer", "row", [makeLeaf("a"), inner], [0.5, 0.5]);
  const flat = normalise(outer) as { children: LayoutNode[]; weights: number[] };
  expect(flat.children.map((child) => child.id)).toEqual(["a", "b", "c"]);
  expect(flat.weights.map((w) => Number(w.toFixed(3)))).toEqual([0.5, 0.25, 0.25]);
});

test("normalise dissolves a branch with one child and keeps its slot", () => {
  const inner = makeBranch("inner", "column", [makeLeaf("b")], [1]);
  const outer = makeBranch("outer", "row", [makeLeaf("a"), inner], [0.3, 0.7]);
  const flat = normalise(outer) as { children: LayoutNode[]; weights: number[] };
  expect(flat.children.map((child) => child.id)).toEqual(["a", "b"]);
  expect(flat.weights.map((w) => Number(w.toFixed(3)))).toEqual([0.3, 0.7]);
});

test("normalise is idempotent", () => {
  const messy = makeBranch("outer", "row", [
    makeLeaf("a"),
    makeBranch("m1", "row", [makeLeaf("b"), makeBranch("m2", "row", [makeLeaf("c"), makeLeaf("d")])]),
  ]);
  const once = normalise(messy)!;
  const twice = normalise(once)!;
  expect(twice).toEqual(once);
});

test("closing a pane hands its space back to its siblings in proportion", () => {
  const root = makeBranch("br", "row", [makeLeaf("a"), makeLeaf("b"), makeLeaf("c")], [0.2, 0.3, 0.5]);
  const next = closeLeaf(layoutOf(root, "a"), "b", "fresh");
  const branch = next.root as { children: LayoutNode[]; weights: number[] };
  expect(branch.children.map((child) => child.id)).toEqual(["a", "c"]);
  // 0.2 : 0.5 was the ratio before and is the ratio after.
  expect(branch.weights.map((w) => Number(w.toFixed(3)))).toEqual([0.286, 0.714]);
  assertInvariants(next);
});

test("closing the second-to-last pane dissolves the branch", () => {
  const root = makeBranch("br", "row", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])]);
  const next = closeLeaf(layoutOf(root, "b"), "b", "fresh");
  expect(next.root.id).toBe("a");
  expect(next.focus.leafId).toBe("a");
  assertInvariants(next);
});

test("closing the last pane leaves one empty pane rather than nothing", () => {
  const layout = layoutOf(makeLeaf("only", [aTab("t1")]));
  const next = closeLeaf(layout, "only", "fresh");
  expect(isLeaf(next.root)).toBe(true);
  expect(next.root.id).toBe("fresh");
  expect((next.root as { tabs: unknown[] }).tabs).toEqual([]);
  expect(next.focus.leafId).toBe("fresh");
  assertInvariants(next);
});

test("closing a tab picks the one to its right, then the last", () => {
  const leaf = makeLeaf("a", [aTab("t1"), aTab("t2"), aTab("t3")]);
  let layout = layoutOf(leaf);
  layout = activateTab(layout, "a", "t2");

  const afterMiddle = closeTab(layout, "a", "t2", "fresh");
  expect(leafById(afterMiddle, "a")!.activeTabId).toBe("t3");

  const onLast = activateTab(layout, "a", "t3");
  const afterLast = closeTab(onLast, "a", "t3", "fresh");
  expect(leafById(afterLast, "a")!.activeTabId).toBe("t2");
  assertInvariants(afterLast);
});

test("closing a tab nobody is looking at leaves the active one alone", () => {
  let layout = layoutOf(makeLeaf("a", [aTab("t1"), aTab("t2"), aTab("t3")]));
  layout = activateTab(layout, "a", "t3");
  const next = closeTab(layout, "a", "t1", "fresh");
  expect(leafById(next, "a")!.activeTabId).toBe("t3");
});

test("closing the only tab closes the pane", () => {
  const root = makeBranch("br", "row", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])]);
  const next = closeTab(layoutOf(root, "a"), "a", "t1", "fresh");
  expect(tiledLeaves(next.root).map((leaf) => leaf.id)).toEqual(["b"]);
  assertInvariants(next);
});

test("reordering moves a tab and clamps a target past the end", () => {
  const layout = layoutOf(makeLeaf("a", [aTab("t1"), aTab("t2"), aTab("t3")]));
  expect(leafById(reorderTab(layout, "a", "t1", 2), "a")!.tabs.map((tab) => tab.id)).toEqual(["t2", "t3", "t1"]);
  expect(leafById(reorderTab(layout, "a", "t3", 99), "a")!.tabs.map((tab) => tab.id)).toEqual(["t1", "t2", "t3"]);
  // Nothing moved, so nothing is rebuilt.
  expect(reorderTab(layout, "a", "t1", 0)).toBe(layout);
});

test("adding a tab that is already there changes nothing", () => {
  const layout = layoutOf(makeLeaf("a", [aTab("t1")]));
  expect(addTab(layout, "a", aTab("t1"))).toBe(layout);
});

test("focusing a floating pane raises it to the top", () => {
  const base = layoutOf(makeBranch("br", "row", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])]), "a");
  const floated = floatLeaf(base, "b", { x: 10, y: 10, width: 400, height: 300 }, "fresh");
  expect(floated.floating.map((pane) => pane.leaf.id)).toEqual(["b"]);
  expect(floated.focus).toEqual({ zone: "floating", leafId: "b" });
  expect(tiledLeaves(floated.root).map((leaf) => leaf.id)).toEqual(["a"]);
  assertInvariants(floated);

  const twoUp = floatLeaf(
    splitLeaf(floated, "a", "row", "after", [aTab("t3")], { leaf: "c", branch: "br2" }),
    "c",
    { x: 20, y: 20, width: 400, height: 300 },
    "fresh",
  );
  expect(twoUp.floating.map((pane) => pane.leaf.id)).toEqual(["b", "c"]);
  const raised = focusLeaf(twoUp, "b");
  expect(raised.floating.map((pane) => pane.leaf.id)).toEqual(["c", "b"]);
  expect(raised.focus).toEqual({ zone: "floating", leafId: "b" });
  assertInvariants(raised);
});

test("the last tiled pane cannot be floated away", () => {
  const layout = layoutOf(makeLeaf("only", [aTab("t1")]));
  expect(floatLeaf(layout, "only", { x: 0, y: 0, width: 300, height: 300 }, "fresh")).toBe(layout);
});

test("closing the focused pane moves focus to one that is still there", () => {
  const root = makeBranch("br", "row", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])]);
  const next = closeLeaf(layoutOf(root, "b"), "b", "fresh");
  expect(leafById(next, next.focus.leafId)).not.toBeNull();
  assertInvariants(next);
});

test("findPath and nodeAt agree on every node", () => {
  const root = makeBranch("br", "row", [
    makeLeaf("a"),
    makeBranch("inner", "column", [makeLeaf("b"), makeLeaf("c")]),
  ]);
  for (const id of ["br", "a", "inner", "b", "c"]) {
    const path = findPath(root, id)!;
    expect(path).not.toBeNull();
    expect(nodeAt(root, path)!.id).toBe(id);
  }
  expect(findPath(root, "missing")).toBeNull();
});

test("a long run of random operations never breaks an invariant", () => {
  // The guard that matters is not any single case: it is that split, close and float compose
  // without leaving a one-child branch, a repeated axis, or a focus pointing at nothing.
  let seed = 20260923;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

  counter = 0;
  let layout = emptyLayout(nextId());
  layout = addTab(layout, layout.root.id, aTab(`tab${counter}`));

  for (let step = 0; step < 500; step++) {
    const leaves = tiledLeaves(layout.root);
    const every = [...leaves, ...layout.floating.map((pane) => pane.leaf)];
    const target = pick(every);
    const roll = random();
    if (roll < 0.35) {
      layout = splitLeaf(layout, target.id, pick(["row", "column"] as const), pick(["before", "after"] as const),
        [aTab(`tab${++counter}`)], { leaf: nextId(), branch: nextId() });
    } else if (roll < 0.5) {
      layout = addTab(layout, target.id, aTab(`tab${++counter}`));
    } else if (roll < 0.65) {
      const tab = target.tabs.length ? pick(target.tabs) : null;
      if (tab) layout = closeTab(layout, target.id, tab.id, nextId());
    } else if (roll < 0.78) {
      layout = closeLeaf(layout, target.id, nextId());
    } else if (roll < 0.88) {
      layout = floatLeaf(layout, target.id, { x: 10, y: 10, width: 320, height: 240 }, nextId());
    } else {
      layout = focusLeaf(layout, target.id);
    }
    assertInvariants(layout);
  }
  // It actually exercised the tree rather than collapsing to one pane on step three.
  expect(tiledLeaves(layout.root).length + layout.floating.length).toBeGreaterThan(1);
});
