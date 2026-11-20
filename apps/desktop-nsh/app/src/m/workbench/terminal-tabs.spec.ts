import { expect, test } from "bun:test";
import type { PaneMin, Rect, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { closeLeaf, closeTab, closeTabs, makeBranch, makeLeaf, replaceTabParams, tabsClosedBy, tiledLeaves, leafById } from "./layout-tree.ts";
import { applyDrop, beginLeafDrag, beginTabDrag, type DropContext } from "./tab-drag.ts";
import type { Terminal } from "@real-bot/protocol";
import { closedTerminals, endedTerminalsClosed, terminalIdsIn } from "./terminal-tabs.ts";

const term = (id: string, terminalId: string): WorkbenchTab => ({ id, kind: "terminal", params: { terminalId, cwd: "/ws" } });
const chat = (id: string): WorkbenchTab => ({ id, kind: "chat", params: { sessionId: `s-${id}` } });
const viewport: Rect = { x: 0, y: 0, width: 1000, height: 800 };
const floatMin: PaneMin = { width: 300, height: 280 };
let seq = 0;
const ctx = (): DropContext => ({ node: () => `n${++seq}`, viewport, floatMin, sourceRect: { x: 0, y: 0, width: 500, height: 400 } });

function layoutOf(root: Parameters<typeof tiledLeaves>[0]): WorkbenchLayout {
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: tiledLeaves(root)[0]!.id } };
}

/** A conversation and two shells on the left, one shell on the right. */
const twoPanes = () =>
  layoutOf(
    makeBranch("r", "row", [makeLeaf("a", [chat("c1"), term("t1", "pty-1"), term("t2", "pty-2")]), makeLeaf("b", [term("t3", "pty-3")])], [0.5, 0.5]),
  );

test("the layout names the sessions its terminal tabs show, a tab with none starting yet left out", () => {
  const layout = layoutOf(makeLeaf("a", [chat("c1"), term("t1", "pty-1"), { id: "t2", kind: "terminal", params: {} }]));
  expect([...terminalIdsIn(layout)]).toEqual(["pty-1"]);
});

test("a closed terminal tab takes its session off the screen, and only its own", () => {
  const before = twoPanes();
  expect(closedTerminals(before, closeTab(before, "a", "t1", "f1"))).toEqual(["pty-1"]);
  expect(closedTerminals(before, closeTab(before, "a", "c1", "f1"))).toEqual([]);
});

test("closing a pane, Close Others and Close All take away every shell they showed", () => {
  const before = twoPanes();
  expect(closedTerminals(before, closeLeaf(before, "b", "f1"))).toEqual(["pty-3"]);
  const leaf = leafById(before, "a")!;
  expect(closedTerminals(before, closeTabs(before, "a", tabsClosedBy(leaf, "c1", "others"), "f1"))).toEqual(["pty-1", "pty-2"]);
  expect(closedTerminals(before, closeTabs(before, "a", tabsClosedBy(leaf, "c1", "all"), "f1")).sort()).toEqual(["pty-1", "pty-2"]);
});

test("a tab moved to another pane, or a pane floated, takes nothing away", () => {
  const before = twoPanes();
  const moved = applyDrop(before, beginTabDrag("b", "t3", { x: 0, y: 0 }), { kind: "tabstrip", leafId: "a", index: -1 }, ctx());
  expect(moved).not.toBe(before);
  expect(closedTerminals(before, moved)).toEqual([]);
  const floated = applyDrop(before, beginLeafDrag("a", { x: 0, y: 0 }), { kind: "float", point: { x: 500, y: 400 } }, ctx());
  expect(floated.floating.length).toBe(1);
  expect(closedTerminals(before, floated)).toEqual([]);
});

test("a session another tab still shows is not taken away when one of the two closes", () => {
  const before = layoutOf(makeBranch("r", "row", [makeLeaf("a", [term("t1", "pty-1")]), makeLeaf("b", [term("t2", "pty-1")])], [0.5, 0.5]));
  expect(closedTerminals(before, closeLeaf(before, "a", "f1"))).toEqual([]);
});

test("a tab bound to another session lets the first one go", () => {
  const before = twoPanes();
  expect(closedTerminals(before, replaceTabParams(before, "a", "t1", { terminalId: "pty-9", cwd: "/ws" }))).toEqual(["pty-1"]);
  expect(closedTerminals(before, before)).toEqual([]);
});

/** The runtime's list: `pty-1` running, `pty-2` exited, `pty-3` running. */
const rows = (): Terminal[] =>
  (
    [
      ["pty-1", "live"],
      ["pty-2", "exited"],
      ["pty-3", "live"],
    ] as const
  ).map(([id, status]) => ({ id, status }) as Terminal);

test("closing ends no shell that runs: only one already ended is forgotten", () => {
  const before = twoPanes();
  const leaf = leafById(before, "a")!;
  const all = closeTabs(before, "a", tabsClosedBy(leaf, "c1", "all"), "f1");
  expect(endedTerminalsClosed(before, all, rows())).toEqual(["pty-2"]);
  expect(endedTerminalsClosed(before, closeTab(before, "a", "t1", "f1"), rows())).toEqual([]);
  expect(endedTerminalsClosed(before, closeLeaf(before, "b", "f1"), rows())).toEqual([]);
  // An ended one a tab still shows stays, with its last screen and how it ended.
  expect(endedTerminalsClosed(before, closeTab(before, "a", "c1", "f1"), rows())).toEqual([]);
});

test("before the list has been read, nothing is known to have ended, so nothing is forgotten", () => {
  const before = twoPanes();
  expect(endedTerminalsClosed(before, closeTab(before, "a", "t2", "f1"), null)).toEqual([]);
  expect(endedTerminalsClosed(before, closeTab(before, "a", "t2", "f1"), rows())).toEqual(["pty-2"]);
});
