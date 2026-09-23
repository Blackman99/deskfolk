import { expect, test } from "bun:test";
import type { WorkbenchLayout } from "./layout-types.ts";
import { assertInvariants, leafById, makeBranch, makeLeaf, tiledLeaves } from "./layout-tree.ts";
import { tabFor } from "./pane-content.ts";
import { activeSessionId, dropDuplicateBoundTabs, existingTarget, findContent, openContent } from "./pane-open.ts";

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

test("kinds there can only be one of move rather than multiply", () => {
  // The settings panels read one copy of the shell's unsaved draft and armed confirms, so a
  // second pane would be showing the first one's edits.
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor({ kind: "session-settings", sessionId: "s1", botId: null }, "t-a")]),
    makeLeaf("b", [tabFor(chat("s2"), "t-b")]),
  ]), "b");

  const again = openContent(layout, { kind: "session-settings", sessionId: "s2", botId: "bot-9" }, ids);
  // The one that exists was pointed at the new conversation, in place.
  expect(tiledLeaves(again.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
  expect(leafById(again, "a")!.tabs[0]!.params).toEqual({ sessionId: "s2", botId: "bot-9" });
  expect(again.focus.leafId).toBe("a");
  assertInvariants(again);
});

test("the calendar is single-instance too", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor({ kind: "routines" }, "t-a")]),
    makeLeaf("b", [tabFor(chat("s2"), "t-b")]),
  ]), "b");
  const again = openContent(layout, { kind: "routines" }, ids);
  expect(tiledLeaves(again.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
  expect(again.focus.leafId).toBe("a");
});

const preview = (sessionId: string | null, relpath: string) =>
  ({ kind: "preview", sessionId, relpath, attachmentId: null }) as const;
const trace = (sessionId: string, taskId: string | null) => ({ kind: "trace", sessionId, taskId }) as const;

test("a conversation's preview turns to another file instead of opening a second one", () => {
  // The chat is focused and asks for a file: the preview it already has, over in the other
  // pane, is the one that changes.
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-chat")]),
    makeLeaf("b", [tabFor(preview("s1", "docs/a.md"), "t-prev")]),
  ]), "a");
  expect(existingTarget(layout, preview("s1", "docs/b.md"))).toEqual({ leafId: "b", tab: leafById(layout, "b")!.tabs[0]! });

  const next = openContent(layout, { ...preview("s1", "docs/b.md"), taskId: "job-1", forceTree: true }, ids);
  expect(tiledLeaves(next.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
  expect(leafById(next, "b")!.tabs[0]!.params).toEqual({
    sessionId: "s1",
    relpath: "docs/b.md",
    taskId: "job-1",
    forceTree: "true",
  });
  expect(next.focus.leafId).toBe("b");
  assertInvariants(next);
});

test("each conversation keeps a preview of its own", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor(chat("s2"), "t-chat"), tabFor(preview("s1", "a.md"), "t-prev")]));
  const next = openContent(layout, preview("s2", "b.md"), ids);
  const tabs = leafById(next, "a")!.tabs;
  expect(tabs.map((tab) => [tab.kind, tab.params.sessionId, tab.params.relpath])).toEqual([
    ["chat", "s2", undefined],
    ["preview", "s1", "a.md"],
    ["preview", "s2", "b.md"],
  ]);
});

test("a background preview tab is brought forward when it turns", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor(preview("s1", "a.md"), "t-prev"), tabFor(chat("s1"), "t-chat")]));
  const focusedChat = { ...layout, root: { ...layout.root, activeTabId: "t-chat" } } as WorkbenchLayout;
  const next = openContent(focusedChat, preview("s1", "b.md"), ids);
  expect(leafById(next, "a")!.activeTabId).toBe("t-prev");
  expect(leafById(next, "a")!.tabs[0]!.params.relpath).toBe("b.md");
});

test("the board turns to another job of the same conversation", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-chat")]),
    makeLeaf("b", [tabFor(trace("s1", "job-1"), "t-trace")]),
  ]), "a");
  const next = openContent(layout, trace("s1", "job-2"), ids);
  expect(tiledLeaves(next.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
  expect(leafById(next, "b")!.tabs[0]!.params).toEqual({ sessionId: "s1", taskId: "job-2" });
  expect(next.focus.leafId).toBe("b");
});

test("asking for the board with no job in mind shows it on the job it has", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-chat")]),
    makeLeaf("b", [tabFor(trace("s1", "job-1"), "t-trace")]),
  ]), "a");
  const next = openContent(layout, trace("s1", null), ids);
  expect(leafById(next, "b")!.tabs[0]!.params).toEqual({ sessionId: "s1", taskId: "job-1" });
  expect(next.focus.leafId).toBe("b");
});

test("another conversation's board is its own pane", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor(trace("s1", "job-1"), "t-trace")]));
  const next = openContent(layout, trace("s2", "job-9"), ids);
  expect(leafById(next, "a")!.tabs.map((tab) => tab.params.sessionId)).toEqual(["s1", "s2"]);
});

test("a layout saved with two previews of one conversation keeps the one nearest the keyboard", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-chat"), tabFor(preview("s1", "old.md"), "t-old")]),
    makeLeaf("b", [tabFor(preview("s1", "new.md"), "t-new"), tabFor(preview("s2", "x.md"), "t-other")]),
    makeLeaf("c", [tabFor(trace("s1", "job-1"), "t-trace-1")]),
    makeLeaf("d", [tabFor(trace("s1", "job-2"), "t-trace-2")]),
  ]), "b");
  const next = dropDuplicateBoundTabs(layout, ids.id);
  expect(tiledLeaves(next.root).map((leaf) => leaf.tabs.map((tab) => tab.id))).toEqual([
    ["t-chat"],
    ["t-new", "t-other"],
    ["t-trace-1"],
  ]);
  assertInvariants(next);
  // Nothing to drop is the same layout, so the shell does not save a layout that did not change.
  expect(dropDuplicateBoundTabs(next, ids.id)).toBe(next);
});
