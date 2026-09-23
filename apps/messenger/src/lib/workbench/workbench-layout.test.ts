import { expect, test } from "bun:test";
import type { PaneMin, Rect, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { assertInvariants, makeBranch, makeLeaf, tiledLeaves } from "./layout-tree.ts";
import {
  defaultLayout,
  healLayout,
  parseWorkbenchLayout,
  type LiveRefs,
} from "./workbench-layout.ts";

const viewport: Rect = { x: 0, y: 0, width: 1000, height: 800 };
const floatMin: PaneMin = { width: 300, height: 280 };

const chatTab = (id: string, sessionId: string): WorkbenchTab => ({ id, kind: "chat", params: { sessionId } });
const termTab = (id: string, terminalId: string): WorkbenchTab => ({ id, kind: "terminal", params: { terminalId } });

function live(overrides: Partial<LiveRefs> = {}): LiveRefs {
  return {
    sessionIds: overrides.sessionIds ?? new Set(["s1", "s2"]),
    terminalIds: "terminalIds" in overrides ? (overrides.terminalIds ?? null) : new Set(["term1"]),
    knownKinds: overrides.knownKinds ?? new Set(["chat", "terminal", "workspace", "routines"]),
  };
}

function layoutOf(root: Parameters<typeof tiledLeaves>[0], focusId?: string): WorkbenchLayout {
  return {
    version: 1,
    root,
    floating: [],
    focus: { zone: "tiled", leafId: focusId ?? tiledLeaves(root)[0]!.id },
  };
}

// ------------------------------------------------------------------ parsing

test("a layout survives a round trip through storage", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [chatTab("t1", "s1")]),
    makeLeaf("b", [termTab("t2", "term1")]),
  ], [0.4, 0.6]));
  const back = parseWorkbenchLayout(JSON.parse(JSON.stringify(layout)))!;
  expect(back).not.toBeNull();
  expect(back.root).toEqual(layout.root);
  expect(back.focus).toEqual(layout.focus);
  assertInvariants(back);
});

test("a floating pane round trips with its frame", () => {
  const layout: WorkbenchLayout = {
    ...layoutOf(makeLeaf("a", [chatTab("t1", "s1")])),
    floating: [{ leaf: makeLeaf("f", [termTab("t2", "term1")]), frame: { x: 20, y: 30, width: 400, height: 320 } }],
  };
  const back = parseWorkbenchLayout(JSON.parse(JSON.stringify(layout)))!;
  expect(back.floating).toHaveLength(1);
  expect(back.floating[0]!.frame).toEqual({ x: 20, y: 30, width: 400, height: 320 });
});

test("anything that is not this version is discarded whole", () => {
  const layout = layoutOf(makeLeaf("a", [chatTab("t1", "s1")]));
  expect(parseWorkbenchLayout({ ...layout, version: 2 })).toBeNull();
  expect(parseWorkbenchLayout({ ...layout, version: undefined })).toBeNull();
});

test("malformed stored data is discarded rather than half repaired", () => {
  const good = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [chatTab("t1", "s1")]), makeLeaf("b", [chatTab("t2", "s2")]),
  ]));
  const clone = () => JSON.parse(JSON.stringify(good));

  expect(parseWorkbenchLayout(null)).toBeNull();
  expect(parseWorkbenchLayout("nope")).toBeNull();
  expect(parseWorkbenchLayout({ ...clone(), root: { id: "x", type: "wat" } })).toBeNull();

  const nanWeight = clone();
  nanWeight.root.weights = [Number.NaN, 1];
  expect(parseWorkbenchLayout(nanWeight)).toBeNull();

  const negative = clone();
  negative.root.weights = [-1, 2];
  expect(parseWorkbenchLayout(negative)).toBeNull();

  const mismatched = clone();
  mismatched.root.weights = [1];
  expect(parseWorkbenchLayout(mismatched)).toBeNull();

  const duplicateIds = clone();
  duplicateIds.root.children[1].id = "a";
  expect(parseWorkbenchLayout(duplicateIds)).toBeNull();

  const duplicateTabs = clone();
  duplicateTabs.root.children[1].tabs = [chatTab("t1", "s2")];
  expect(parseWorkbenchLayout(duplicateTabs)).toBeNull();

  const danglingFocus = clone();
  danglingFocus.focus = { zone: "tiled", leafId: "nobody" };
  expect(parseWorkbenchLayout(danglingFocus)).toBeNull();
});

test("a layout deep enough to blow the stack is rejected", () => {
  let node: Record<string, unknown> = { id: "leaf", type: "leaf", tabs: [], activeTabId: null };
  for (let i = 0; i < 80; i++) {
    node = { id: `b${i}`, type: "branch", axis: "row", children: [node, { id: `l${i}`, type: "leaf", tabs: [], activeTabId: null }], weights: [0.5, 0.5] };
  }
  expect(parseWorkbenchLayout({ version: 1, root: node, floating: [], focus: { zone: "tiled", leafId: "leaf" } })).toBeNull();
});

test("an active tab that is not in the pane falls back to the first one", () => {
  const layout = layoutOf(makeLeaf("a", [chatTab("t1", "s1"), chatTab("t2", "s2")]));
  const stored = JSON.parse(JSON.stringify(layout));
  stored.root.activeTabId = "gone";
  expect(parseWorkbenchLayout(stored)!.root).toMatchObject({ activeTabId: "t1" });
});

// ------------------------------------------------------------------ healing

test("a layout with nothing stale comes back as the very same object", () => {
  // The effect that runs this fires on every snapshot; rebuilding each time would be wasteful.
  const layout = layoutOf(makeLeaf("a", [chatTab("t1", "s1")]));
  expect(healLayout(layout, live(), viewport, floatMin, "fresh")).toBe(layout);
});

test("terminal tabs are kept while the terminal list has not been read yet", () => {
  // Terminals are not in the snapshot. Judged against an empty list before the first read, every
  // terminal tab named a dead session and a restart dropped them all.
  const layout = layoutOf(makeLeaf("a", [termTab("t1", "term-anything"), chatTab("t2", "gone")]));
  const healed = healLayout(layout, live({ terminalIds: null }), viewport, floatMin, "fallback");
  expect(tiledLeaves(healed.root)[0]!.tabs.map((tab) => tab.id)).toEqual(["t1"]);
});

test("tabs for conversations and terminals that are gone are dropped", () => {
  const layout = layoutOf(makeLeaf("a", [chatTab("t1", "s1"), chatTab("t2", "deleted"), termTab("t3", "dead")]));
  const healed = healLayout(layout, live(), viewport, floatMin, "fresh");
  expect(tiledLeaves(healed.root)[0]!.tabs.map((tab) => tab.id)).toEqual(["t1"]);
  assertInvariants(healed);
});

test("a kind this build does not know is dropped rather than drawn blank", () => {
  const layout = layoutOf(makeLeaf("a", [chatTab("t1", "s1"), { id: "t2", kind: "from-the-future", params: {} }]));
  const healed = healLayout(layout, live(), viewport, floatMin, "fresh");
  expect(tiledLeaves(healed.root)[0]!.tabs.map((tab) => tab.id)).toEqual(["t1"]);
});

test("losing the active tab picks a neighbour rather than nothing", () => {
  const leaf = makeLeaf("a", [chatTab("t1", "s1"), chatTab("t2", "deleted"), chatTab("t3", "s2")]);
  const layout = layoutOf({ ...leaf, activeTabId: "t2" });
  const healed = healLayout(layout, live(), viewport, floatMin, "fresh");
  expect(tiledLeaves(healed.root)[0]!.activeTabId).toBe("t3");
});

test("a pane left with no tabs goes, and the tree closes up behind it", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [chatTab("t1", "s1")]),
    makeLeaf("b", [chatTab("t2", "deleted")]),
  ]), "b");
  const healed = healLayout(layout, live(), viewport, floatMin, "fresh");
  expect(healed.root.id).toBe("a");
  // Focus was on the pane that went, so it moved to one that is still there.
  expect(healed.focus.leafId).toBe("a");
  assertInvariants(healed);
});

test("everything going leaves one empty pane rather than nothing", () => {
  const layout = layoutOf(makeLeaf("a", [chatTab("t1", "deleted")]));
  const healed = healLayout(layout, live(), viewport, floatMin, "fresh");
  expect(healed.root.id).toBe("fresh");
  expect(tiledLeaves(healed.root)[0]!.tabs).toEqual([]);
  assertInvariants(healed);
});

test("a floating pane is pulled back inside a window that shrank", () => {
  const layout: WorkbenchLayout = {
    ...layoutOf(makeLeaf("a", [chatTab("t1", "s1")])),
    floating: [{ leaf: makeLeaf("f", [termTab("t2", "term1")]), frame: { x: 900, y: 700, width: 400, height: 320 } }],
  };
  const healed = healLayout(layout, live(), { x: 0, y: 0, width: 600, height: 500 }, floatMin, "fresh");
  const frame = healed.floating[0]!.frame;
  expect(frame.x + frame.width).toBeLessThanOrEqual(600);
  expect(frame.y + frame.height).toBeLessThanOrEqual(500);
});

test("a floating pane whose content is gone closes, and focus comes home", () => {
  const layout: WorkbenchLayout = {
    ...layoutOf(makeLeaf("a", [chatTab("t1", "s1")])),
    floating: [{ leaf: makeLeaf("f", [chatTab("t2", "deleted")]), frame: { x: 20, y: 20, width: 400, height: 320 } }],
    focus: { zone: "floating", leafId: "f" },
  };
  const healed = healLayout(layout, live(), viewport, floatMin, "fresh");
  expect(healed.floating).toEqual([]);
  expect(healed.focus).toEqual({ zone: "tiled", leafId: "a" });
  assertInvariants(healed);
});

test("the default layout is one pane holding what was already open", () => {
  const empty = defaultLayout("root");
  expect(tiledLeaves(empty.root)[0]!.tabs).toEqual([]);
  assertInvariants(empty);

  const seeded = defaultLayout("root", [chatTab("t1", "s1")]);
  expect(tiledLeaves(seeded.root)[0]!.tabs.map((tab) => tab.id)).toEqual(["t1"]);
  expect(seeded.focus.leafId).toBe("root");
  assertInvariants(seeded);
});
