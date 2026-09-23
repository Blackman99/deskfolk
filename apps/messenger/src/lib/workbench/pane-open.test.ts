import { expect, test } from "bun:test";
import type { WorkbenchLayout } from "./layout-types.ts";
import { assertInvariants, leafById, makeBranch, makeLeaf, tiledLeaves } from "./layout-tree.ts";
import { tabFor } from "./pane-content.ts";
import { activeSessionId, findContent, openContent } from "./pane-open.ts";

let seq = 0;
const ids = { id: () => `t${++seq}` };

function layoutOf(root: Parameters<typeof tiledLeaves>[0], focusId?: string): WorkbenchLayout {
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: focusId ?? tiledLeaves(root)[0]!.id } };
}

const chat = (sessionId: string) => ({ kind: "chat", sessionId }) as const;

test("opening something already on screen focuses it and moves nothing", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    makeLeaf("b", [tabFor(chat("s2"), "t-b")]),
  ]), "a");
  const next = openContent(layout, chat("s2"), ids);
  expect(next.focus.leafId).toBe("b");
  expect(tiledLeaves(next.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
  assertInvariants(next);
});

test("a conversation gives way to another conversation in the same pane", () => {
  // Clicking a row in the roster means "go there", not "collect tabs".
  const layout = layoutOf(makeLeaf("a", [tabFor(chat("s1"), "t-a")]));
  const next = openContent(layout, chat("s2"), { ...ids, replaceActive: true });
  const tabs = leafById(next, "a")!.tabs;
  expect(tabs).toHaveLength(1);
  expect(tabs[0]!.params.sessionId).toBe("s2");
  assertInvariants(next);
});

test("a conversation does not evict a terminal you put there on purpose", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor({ kind: "terminal", terminalId: "term-1" }, "t-a")]));
  const next = openContent(layout, chat("s1"), { ...ids, replaceActive: true });
  const tabs = leafById(next, "a")!.tabs;
  expect(tabs).toHaveLength(2);
  expect(tabs.map((tab) => tab.kind)).toEqual(["terminal", "chat"]);
  assertInvariants(next);
});

test("without replaceActive a new tab sits beside what is there", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor(chat("s1"), "t-a")]));
  const next = openContent(layout, chat("s2"), ids);
  expect(leafById(next, "a")!.tabs).toHaveLength(2);
});

test("an empty pane takes the content rather than staying empty", () => {
  const layout = layoutOf(makeLeaf("a", []));
  const next = openContent(layout, chat("s1"), { ...ids, replaceActive: true });
  expect(leafById(next, "a")!.tabs).toHaveLength(1);
  assertInvariants(next);
});

test("the focused pane wins when the same thing is open twice", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    makeLeaf("b", [tabFor(chat("s1"), "t-b")]),
  ]), "b");
  expect(findContent(layout, chat("s1"))!.leafId).toBe("b");
});

test("the focused pane says which conversation the app is pointed at", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    makeLeaf("b", [tabFor({ kind: "terminal", terminalId: "x" }, "t-b")]),
  ]), "a");
  expect(activeSessionId(layout)).toBe("s1");
  expect(activeSessionId({ ...layout, focus: { zone: "tiled", leafId: "b" } })).toBeNull();
  expect(activeSessionId(layoutOf(makeLeaf("a", [])))).toBeNull();
});
