import { expect, test } from "bun:test";
import type { MinSizeLookup, NodeId, Rect, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { makeBranch, makeLeaf, leafById, splitLeaf, tiledLeaves } from "./layout-tree.ts";
import { computeGeometry } from "./layout-geometry.ts";
import {
  TYPING_TARGETS,
  WB_KEY_RESIZE_PX,
  applyCommand,
  isTypingTarget,
  matchWorkbenchKey,
  sashTowards,
  type CommandContext,
} from "./workbench-commands.ts";

const aTab = (id: string): WorkbenchTab => ({ id, kind: "chat", params: {} });
const flatMins: MinSizeLookup = () => ({ width: 100, height: 100 });
const viewport: Rect = { x: 0, y: 0, width: 1000, height: 800 };

let ids = 0;
const ctx = (): CommandContext => ({
  viewport,
  mins: flatMins,
  ids: () => `fresh${++ids}`,
  newPaneMin: { width: 100, height: 100 },
});

const split = (layout: WorkbenchLayout, leafId: NodeId, axis: "row" | "column", side: "before" | "after") =>
  splitLeaf(layout, leafId, axis, side, [aTab(`new${++ids}`)], { leaf: `l${ids}`, branch: `b${ids}` });

function layoutOf(root: Parameters<typeof tiledLeaves>[0], focusId?: string): WorkbenchLayout {
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: focusId ?? tiledLeaves(root)[0]!.id } };
}

/** A stand-in for a real keydown; only the fields the parser reads are needed. */
function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: null, ...init } as KeyboardEvent;
}

const cross = () => layoutOf(makeBranch("r", "row", [
  makeBranch("cl", "column", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])], [0.5, 0.5]),
  makeBranch("cr", "column", [makeLeaf("c", [aTab("t3")]), makeLeaf("d", [aTab("t4")])], [0.5, 0.5]),
], [0.5, 0.5]), "a");

// ------------------------------------------------------------------ parsing

test("the divide bindings are read off the keystroke", () => {
  expect(matchWorkbenchKey(key({ key: "\\", metaKey: true }))).toEqual({ kind: "split", axis: "row", side: "after" });
  expect(matchWorkbenchKey(key({ key: "|", code: "Backslash", metaKey: true, shiftKey: true } as never)))
    .toEqual({ kind: "split", axis: "column", side: "after" });
});

test("arrows move focus, and with shift they move the edge instead", () => {
  expect(matchWorkbenchKey(key({ key: "ArrowRight", metaKey: true, altKey: true })))
    .toEqual({ kind: "focus", dir: "right" });
  expect(matchWorkbenchKey(key({ key: "ArrowRight", metaKey: true, altKey: true, shiftKey: true })))
    .toEqual({ kind: "resize", dir: "right", px: WB_KEY_RESIZE_PX });
});

test("control-tab cycles the pane's own tabs", () => {
  expect(matchWorkbenchKey(key({ key: "Tab", ctrlKey: true }))).toEqual({ kind: "cycle-tab", dir: 1 });
  expect(matchWorkbenchKey(key({ key: "Tab", ctrlKey: true, shiftKey: true }))).toEqual({ kind: "cycle-tab", dir: -1 });
});

test("a keystroke aimed at something you are typing in is not ours", () => {
  const typing = { closest: (selector: string) => (selector === TYPING_TARGETS ? {} : null) };
  expect(matchWorkbenchKey(key({ key: "\\", metaKey: true, target: typing as never }))).toBeNull();
  expect(isTypingTarget(typing as never)).toBe(true);
  expect(isTypingTarget(null)).toBe(false);
});

test("ordinary typing is left alone", () => {
  expect(matchWorkbenchKey(key({ key: "a" }))).toBeNull();
  expect(matchWorkbenchKey(key({ key: "ArrowRight" }))).toBeNull();
  // No alt: this is text navigation, not pane navigation.
  expect(matchWorkbenchKey(key({ key: "ArrowRight", metaKey: true }))).toBeNull();
  // Closing the window is a native menu item, answered from the Rust side, not guessed at here.
  expect(matchWorkbenchKey(key({ key: "w", metaKey: true }))).toBeNull();
});

// ------------------------------------------------------------------ applying

test("focus walks to the pane in that direction and stops at the edge", () => {
  const layout = cross();
  const right = applyCommand(layout, { kind: "focus", dir: "right" }, ctx(), split);
  expect(right.focus.leafId).toBe("c");
  const down = applyCommand(right, { kind: "focus", dir: "down" }, ctx(), split);
  expect(down.focus.leafId).toBe("d");
  // Nowhere further to go: the layout comes back untouched rather than wrapping around.
  expect(applyCommand(layout, { kind: "focus", dir: "left" }, ctx(), split)).toBe(layout);
});

test("cycling tabs wraps within the pane and ignores a pane with one tab", () => {
  const layout = layoutOf(makeLeaf("a", [aTab("t1"), aTab("t2"), aTab("t3")]));
  const second = applyCommand(layout, { kind: "cycle-tab", dir: 1 }, ctx(), split);
  expect(leafById(second, "a")!.activeTabId).toBe("t2");
  const wrapped = applyCommand(layout, { kind: "cycle-tab", dir: -1 }, ctx(), split);
  expect(leafById(wrapped, "a")!.activeTabId).toBe("t3");

  const alone = layoutOf(makeLeaf("a", [aTab("t1")]));
  expect(applyCommand(alone, { kind: "cycle-tab", dir: 1 }, ctx(), split)).toBe(alone);
});

test("dividing puts a new pane beside the focused one", () => {
  const layout = layoutOf(makeLeaf("a", [aTab("t1")]));
  const next = applyCommand(layout, { kind: "split", axis: "row", side: "after" }, ctx(), split);
  expect(tiledLeaves(next.root)).toHaveLength(2);
});

test("a division that would not fit is refused rather than squeezing everything", () => {
  const layout = layoutOf(makeLeaf("a", [aTab("t1")]));
  const tight: CommandContext = { ...ctx(), viewport: { x: 0, y: 0, width: 300, height: 800 }, newPaneMin: { width: 600, height: 100 } };
  expect(applyCommand(layout, { kind: "split", axis: "row", side: "after" }, tight, split)).toBe(layout);
});

test("closing a tab leaves the pane when others remain, and takes it when none do", () => {
  const two = layoutOf(makeLeaf("a", [aTab("t1"), aTab("t2")]));
  const afterTab = applyCommand(two, { kind: "close-tab" }, ctx(), split);
  expect(leafById(afterTab, "a")!.tabs.map((tab) => tab.id)).toEqual(["t2"]);

  const root = makeBranch("r", "row", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])]);
  const afterLast = applyCommand(layoutOf(root, "a"), { kind: "close-tab" }, ctx(), split);
  expect(tiledLeaves(afterLast.root).map((leaf) => leaf.id)).toEqual(["b"]);
});

test("the keyboard moves the divider the focused pane sits against", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")]),
  ], [0.5, 0.5]), "a");
  const wider = applyCommand(layout, { kind: "resize", dir: "right", px: WB_KEY_RESIZE_PX }, ctx(), split);
  const geo = computeGeometry(wider, viewport, flatMins);
  expect(geo.leaves.get("a")!.width).toBe(512);

  // The outside edge of the layout has no divider to move.
  expect(applyCommand(layout, { kind: "resize", dir: "left", px: WB_KEY_RESIZE_PX }, ctx(), split)).toBe(layout);
});

test("sashTowards finds the divider on that side and which way to push it", () => {
  const geo = computeGeometry(cross(), viewport, flatMins);
  expect(sashTowards(geo, "a", "right")).toEqual({ sashId: "r#1", sign: 1 });
  expect(sashTowards(geo, "a", "down")).toEqual({ sashId: "cl#1", sign: 1 });
  expect(sashTowards(geo, "a", "up")).toBeNull();
  expect(sashTowards(geo, "missing", "right")).toBeNull();
});

test("equalise evens out the division the focused pane belongs to", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")]), makeLeaf("c", [aTab("t3")]),
  ], [0.7, 0.2, 0.1]), "a");
  const even = applyCommand(layout, { kind: "equalise" }, ctx(), split);
  const weights = (even.root as { weights: number[] }).weights.map((w) => Number(w.toFixed(3)));
  expect(weights).toEqual([0.333, 0.333, 0.333]);

  // One pane on its own belongs to no division.
  const alone = layoutOf(makeLeaf("a", [aTab("t1")]));
  expect(applyCommand(alone, { kind: "equalise" }, ctx(), split)).toBe(alone);
});
