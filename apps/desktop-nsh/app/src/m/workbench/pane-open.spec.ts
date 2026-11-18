import { expect, test } from "bun:test";
import type { WorkbenchLayout } from "./layout-types.ts";
import { assertInvariants, leafById, makeBranch, makeLeaf, tiledLeaves } from "./layout-tree.ts";
import { tabFor } from "./pane-content.ts";
import { computeGeometry, neighbourLeaf } from "./layout-geometry.ts";
import { paneMin } from "./pane-mins.ts";
import type { PlaceContext } from "./pane-open.ts";
import {
  activeSessionId,
  chatDragSource,
  closeChatSide,
  dropDuplicateBoundTabs,
  existingTarget,
  findContent,
  openContent,
  settingsSide,
  stampProjectPreviews,
  toggleChatSide,
} from "./pane-open.ts";

let seq = 0;
const ids = { id: () => `t${++seq}` };

function layoutOf(root: Parameters<typeof tiledLeaves>[0], focusId?: string): WorkbenchLayout {
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: focusId ?? tiledLeaves(root)[0]!.id } };
}

const chat = (sessionId: string) => ({ kind: "chat", sessionId }) as const;

/** A window measured as nothing in particular: no pane next door, every split fits. */
function noPlace(over: Partial<PlaceContext> = {}): PlaceContext {
  return {
    neighbour: () => null,
    fits: () => true,
    floatFrame: () => ({ x: 10, y: 20, width: 300, height: 200 }),
    holdsEdit: () => false,
    kindOf: (content) => (content.kind === "trace" ? `trace:${content.view ?? "trace"}` : content.kind),
    ...over,
  };
}

/** A 1200×800 workbench, so the pane next door is the one actually drawn there. */
function measured(over: Partial<PlaceContext> = {}): PlaceContext {
  const viewport = { x: 0, y: 0, width: 1200, height: 800 };
  return noPlace({
    neighbour: (layout, leafId, dir) => neighbourLeaf(computeGeometry(layout, viewport, paneMin), leafId, dir),
    ...over,
  });
}

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

const replace = { ...ids, placement: "replace" } as const;

test("a conversation gives way to another conversation in the same pane", () => {
  // Clicking a row in the roster means "go there", not "collect tabs".
  const layout = layoutOf(makeLeaf("a", [tabFor(chat("s1"), "t-a")]));
  const next = openContent(layout, chat("s2"), replace);
  const tabs = leafById(next, "a")!.tabs;
  expect(tabs).toHaveLength(1);
  expect(tabs[0]!.params.sessionId).toBe("s2");
  assertInvariants(next);
});

test("with the window split, a replace takes the conversation in front in the focused pane", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    makeLeaf("b", [tabFor(chat("s2"), "t-b")]),
  ]), "b");
  const next = openContent(layout, chat("s3"), replace);
  expect(tiledLeaves(next.root).map((leaf) => leaf.tabs.map((tab) => tab.params.sessionId))).toEqual([
    ["s1"],
    ["s3"],
  ]);
  expect(next.focus.leafId).toBe("b");
  assertInvariants(next);
});

test("from a pane showing no conversation, a replace takes the nearest one that does", () => {
  // The keyboard was in the file beside the conversation: the conversation is still what you were reading.
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    makeLeaf("b", [tabFor(preview("s1", "a.md"), "t-p")]),
  ]), "b");
  const next = openContent(layout, chat("s3"), replace);
  expect(tiledLeaves(next.root).map((leaf) => leaf.tabs.map((tab) => tab.kind + ":" + (tab.params.sessionId ?? "")))).toEqual([
    ["chat:s3"],
    ["preview:s1"],
  ]);
  expect(next.focus.leafId).toBe("a");
  assertInvariants(next);
});

test("a replace keeps the place of the tab it replaces, and the tabs beside it", () => {
  const layout = layoutOf({ ...makeLeaf("a", [
    tabFor({ kind: "terminal", terminalId: "x" }, "t-term"),
    tabFor(chat("s1"), "t-a"),
    tabFor(chat("s2"), "t-b"),
  ]), activeTabId: "t-a" });
  const next = openContent(layout, chat("s3"), replace);
  expect(leafById(next, "a")!.tabs.map((tab) => tab.kind + ":" + (tab.params.sessionId ?? ""))).toEqual([
    "terminal:",
    "chat:s3",
    "chat:s2",
  ]);
  assertInvariants(next);
});

test("a replace never throws away an edit not saved yet: the new one goes beside it", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor(preview("s1", "a.md"), "t-p")]));
  const next = openContent(layout, preview("s2", "b.md"), { ...replace, place: { ...noPlace(), holdsEdit: (id) => id === "t-p" } });
  expect(leafById(next, "a")!.tabs.map((tab) => tab.params.relpath)).toEqual(["a.md", "b.md"]);
});

test("a floating pane is reached last when the focused tiled pane has no conversation in front", () => {
  const tiled = makeLeaf("a", [tabFor({ kind: "terminal", terminalId: "x" }, "t-a")]);
  const layout: WorkbenchLayout = {
    version: 1,
    root: tiled,
    floating: [{ leaf: makeLeaf("f", [tabFor(chat("s2"), "t-f")]), frame: { x: 40, y: 40, width: 400, height: 300 } }],
    focus: { zone: "tiled", leafId: "a" },
  };
  const next = openContent(layout, chat("s3"), replace);
  expect(leafById(next, "a")!.tabs.map((tab) => tab.kind)).toEqual(["terminal"]);
  expect(leafById(next, "f")!.tabs.map((tab) => tab.params.sessionId)).toEqual(["s3"]);
  assertInvariants(next);
});

test("a conversation does not evict a terminal you put there on purpose", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor({ kind: "terminal", terminalId: "term-1" }, "t-a")]));
  const next = openContent(layout, chat("s1"), replace);
  const tabs = leafById(next, "a")!.tabs;
  expect(tabs).toHaveLength(2);
  expect(tabs.map((tab) => tab.kind)).toEqual(["terminal", "chat"]);
  assertInvariants(next);
});

test("without a placement a new tab sits beside what is there", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor(chat("s1"), "t-a")]));
  const next = openContent(layout, chat("s2"), ids);
  expect(leafById(next, "a")!.tabs).toHaveLength(2);
});

test("an empty pane takes the content rather than staying empty", () => {
  const layout = layoutOf(makeLeaf("a", []));
  const next = openContent(layout, chat("s1"), replace);
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

const settings = (botId: string | null = null) => ({ kind: "settings", botId }) as const;
const tabsOf = (layout: WorkbenchLayout) =>
  [...tiledLeaves(layout.root)].map((leaf) => leaf.tabs.map((tab) => [tab.kind, tab.params]));

test("settings open beside the conversation, in its own tab, not as a tab of their own", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    makeLeaf("b", [tabFor({ kind: "terminal", terminalId: "x" }, "t-b")]),
  ]), "b");
  const next = openContent(layout, { ...chat("s1"), side: settings() }, ids);
  expect(tabsOf(next)).toEqual([
    [["chat", { sessionId: "s1", side: "settings" }]],
    [["terminal", { terminalId: "x" }]],
  ]);
  // The conversation comes forward, since that is where they are.
  expect(next.focus.leafId).toBe("a");
  assertInvariants(next);
});

test("a conversation that is not open yet comes with its sidebar already open", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor({ kind: "terminal", terminalId: "x" }, "t-a")]));
  const next = openContent(layout, { ...chat("s1"), side: settings() }, ids);
  expect(tabsOf(next)).toEqual([[
    ["terminal", { terminalId: "x" }],
    ["chat", { sessionId: "s1", side: "settings" }],
  ]]);
});

test("going back to a conversation leaves its sidebar open", () => {
  // Clicking the row in the roster is "go there", not "close its settings".
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor({ ...chat("s1"), side: settings("bot-1") }, "t-a")]),
    makeLeaf("b", [tabFor(chat("s2"), "t-b")]),
  ]), "b");
  const next = openContent(layout, chat("s1"), ids);
  expect(leafById(next, "a")!.tabs[0]!.params).toEqual({ sessionId: "s1", side: "settings", botId: "bot-1" });
  expect(next.focus.leafId).toBe("a");
});

test("settings are beside one conversation at a time", () => {
  // The settings panels read one copy of the shell's unsaved draft and armed confirms, so a
  // second conversation showing them would be showing the first one's edits.
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor({ ...chat("s1"), side: settings() }, "t-a")]),
    makeLeaf("b", [tabFor(chat("s2"), "t-b")]),
  ]), "b");
  const next = openContent(layout, { ...chat("s2"), side: settings("bot-9") }, ids);
  expect(tabsOf(next)).toEqual([
    [["chat", { sessionId: "s1" }]],
    [["chat", { sessionId: "s2", side: "settings", botId: "bot-9" }]],
  ]);
  expect(settingsSide(next)).toEqual({ sessionId: "s2", botId: "bot-9" });
  assertInvariants(next);
});

test("the header button closes the sidebar it opened, and nothing else moves", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    makeLeaf("b", [tabFor(chat("s2"), "t-b")]),
  ]), "b");
  const opened = toggleChatSide(layout, "s2", settings(), ids);
  expect(leafById(opened, "b")!.tabs[0]!.params).toEqual({ sessionId: "s2", side: "settings" });
  // A member Bot's settings are not the group's: the group's button turns to the group first.
  const onProfile = openContent(opened, { ...chat("s2"), side: settings("bot-1") }, ids);
  const toGroup = toggleChatSide(onProfile, "s2", settings(), ids);
  expect(leafById(toGroup, "b")!.tabs[0]!.params).toEqual({ sessionId: "s2", side: "settings" });
  const closed = toggleChatSide(toGroup, "s2", settings(), ids);
  expect(leafById(closed, "b")!.tabs[0]!.params).toEqual({ sessionId: "s2" });
  expect(tiledLeaves(closed.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
  expect(closed.focus.leafId).toBe("b");
  assertInvariants(closed);
});

test("closing a sidebar that is not open is no change at all", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor(chat("s1"), "t-a")]));
  expect(closeChatSide(layout, "s1")).toBe(layout);
  expect(closeChatSide(layout, "gone")).toBe(layout);
  const open = layoutOf(makeLeaf("a", [tabFor({ ...chat("s1"), side: settings("bot-1") }, "t-a")]));
  expect(leafById(closeChatSide(open, "s1"), "a")!.tabs[0]!.params).toEqual({ sessionId: "s1" });
});

test("the spend ledger is single-instance too", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor({ kind: "spend" }, "t-a")]),
    makeLeaf("b", [tabFor(chat("s2"), "t-b")]),
  ]), "b");
  const again = openContent(layout, { kind: "spend" }, ids);
  expect(tiledLeaves(again.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
  expect(again.focus.leafId).toBe("a");
});

test("usage is single-instance too: asking again from Tools or the menu bar comes back to it", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor({ kind: "usage" }, "t-a")]),
    makeLeaf("b", [tabFor(chat("s2"), "t-b")]),
  ]), "b");
  const again = openContent(layout, { kind: "usage" }, ids);
  expect(tiledLeaves(again.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
  expect(again.focus.leafId).toBe("a");
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

const projectPreview = (sessionId: string, projectDir: string, relpath: string) =>
  ({ ...preview(sessionId, relpath), projectDir }) as const;

test("a project's sessions share one preview: a file from another of them turns it", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("p2"), "t-chat")]),
    makeLeaf("b", [tabFor(projectPreview("p1", "/work/app", "/work/app"), "t-prev")]),
  ]), "a");
  const next = openContent(layout, projectPreview("p2", "/work/app", "/work/app/src/a.ts"), ids);
  expect(tiledLeaves(next.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
  expect(leafById(next, "b")!.tabs[0]!.params).toEqual({ sessionId: "p2", relpath: "/work/app/src/a.ts", projectDir: "/work/app" });
  expect(next.focus.leafId).toBe("b");

  // Another project, and a Bot conversation, each keep their own.
  const other = openContent(next, projectPreview("p3", "/work/site", "/work/site"), ids);
  const bot = openContent(other, preview("p2", "notes.md"), ids);
  expect(tiledLeaves(bot.root).flatMap((leaf) => leaf.tabs.map((tab) => tab.params.projectDir ?? tab.params.sessionId))).toEqual([
    "p2",
    "/work/app",
    "/work/site",
    "p2",
  ]);
  assertInvariants(bot);
});

test("a preview saved per project session names its project, then the project's previews fold into one", () => {
  const dirs: Record<string, string> = { p1: "/work/app", p2: "/work/app" };
  const dirOf = (sessionId: string) => dirs[sessionId] ?? null;
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("p1"), "t-chat"), tabFor(preview("p1", "/work/app/a.ts"), "t-p1")]),
    makeLeaf("b", [tabFor(preview("p2", "/work/app/b.ts"), "t-p2"), tabFor(preview("s1", "x.md"), "t-bot")]),
  ]), "b");
  const stamped = stampProjectPreviews(layout, dirOf);
  expect(tiledLeaves(stamped.root).flatMap((leaf) => leaf.tabs.map((tab) => tab.params.projectDir ?? null))).toEqual([
    null,
    "/work/app",
    "/work/app",
    null,
  ]);
  const next = dropDuplicateBoundTabs(stamped, ids.id);
  expect(tiledLeaves(next.root).map((leaf) => leaf.tabs.map((tab) => tab.id))).toEqual([["t-chat"], ["t-p2", "t-bot"]]);
  assertInvariants(next);
  // Nothing left to name is the same layout, so the shell does not save one that did not change.
  expect(stampProjectPreviews(next, dirOf)).toBe(next);
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

test("a line's own flow and a job's are different boards: asking for one turns the tab to it", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-chat")]),
    makeLeaf("b", [tabFor(trace("s1", "job-1"), "t-trace")]),
  ]), "a");
  const toLine = openContent(layout, { ...trace("s1", null), line: "m-9" }, ids);
  expect(leafById(toLine, "b")!.tabs[0]!.params).toEqual({ sessionId: "s1", line: "m-9" });
  // The conversation's flow asked for with no job in mind goes back to its jobs.
  const back = openContent(toLine, trace("s1", null), ids);
  expect(leafById(back, "b")!.tabs[0]!.params).toEqual({ sessionId: "s1" });
  // The same line asked for again is only brought forward.
  expect(openContent(toLine, { ...trace("s1", null), line: "m-9" }, ids)).toEqual(toLine);
});

test("asking for a message's card turns the board and keeps the request", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-chat")]),
    makeLeaf("b", [tabFor(trace("s1", "job-1"), "t-trace")]),
  ]), "a");
  const next = openContent(layout, {
    kind: "trace",
    sessionId: "s1",
    taskId: "job-1",
    focus: { messageId: "m9", turnId: "turn-9" },
    focusNonce: 3,
  }, ids);
  expect(leafById(next, "b")!.tabs[0]!.params).toEqual({
    sessionId: "s1",
    taskId: "job-1",
    focusMessageId: "m9",
    focusTurnId: "turn-9",
    focusNonce: "3",
  });
  // The same job, asked for again from another message, is still a move.
  const again = openContent(next, {
    kind: "trace",
    sessionId: "s1",
    taskId: "job-1",
    focus: { messageId: "m9", turnId: "turn-9" },
    focusNonce: 4,
  }, ids);
  expect(leafById(again, "b")!.tabs[0]!.params.focusNonce).toBe("4");
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

test("a map asked for with no plan in mind stays on its plan; asked for another, it turns to that one", () => {
  const map = (taskId: string | null) => ({ kind: "map", sessionId: "s1", ...(taskId ? { taskId } : {}) }) as const;
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-chat")]),
    makeLeaf("b", [tabFor(map("job-1"), "t-map")]),
  ]), "a");
  const kept = openContent(layout, map(null), ids);
  expect(leafById(kept, "b")!.tabs[0]!.params).toEqual({ sessionId: "s1", taskId: "job-1" });
  expect(kept.focus.leafId).toBe("b");
  const turned = openContent(layout, map("job-2"), ids);
  expect(leafById(turned, "b")!.tabs.map((tab) => tab.params)).toEqual([{ sessionId: "s1", taskId: "job-2" }]);
});

test("another conversation's board is its own pane", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor(trace("s1", "job-1"), "t-trace")]));
  const next = openContent(layout, trace("s2", "job-9"), ids);
  expect(leafById(next, "a")!.tabs.map((tab) => tab.params.sessionId)).toEqual(["s1", "s2"]);
});

const view = (sessionId: string, taskId: string | null, which: "trace" | "board" | "spec") =>
  ({ kind: "trace", sessionId, taskId, view: which }) as const;

test("a conversation has one flow tab: asked for as a board or a plan, the flow tab comes forward", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-chat")]),
    makeLeaf("b", [tabFor(trace("s1", "job-1"), "t-trace")]),
  ]), "a");
  for (const which of ["board", "spec"] as const) {
    const next = openContent(layout, view("s1", "job-1", which), ids);
    expect(leafById(next, "b")!.tabs.map((tab) => tab.id)).toEqual(["t-trace"]);
    expect(next.focus.leafId).toBe("b");
    assertInvariants(next);
  }
});

test("a message's card turns the conversation's one flow tab, whatever an old tab of it was saved on", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(view("s1", "job-1", "board"), "t-board")]),
    makeLeaf("b", [tabFor(chat("s1"), "t-chat")]),
  ]), "b");
  const next = openContent(layout, {
    kind: "trace",
    sessionId: "s1",
    taskId: "job-2",
    focus: { messageId: "m9", turnId: "turn-9" },
    focusNonce: 3,
  }, ids);
  const params = leafById(next, "a")!.tabs[0]!.params;
  expect(params.taskId).toBe("job-2");
  expect(params.view).toBeUndefined();
  expect(params.focusMessageId).toBe("m9");
  expect(tiledLeaves(next.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
  expect(next.focus.leafId).toBe("a");
});

test("the flow asked for on the job it is on comes forward as it is; another job, or a ticket, turns it", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-chat")]),
    makeLeaf("b", [tabFor({ ...trace("s1", "job-1"), ticket: "tk-1", askNonce: 4 }, "t-trace")]),
  ]), "a");
  const shown = openContent(layout, trace("s1", "job-1"), ids);
  expect(leafById(shown, "b")!.tabs[0]!.params).toEqual({ sessionId: "s1", taskId: "job-1", askTicket: "tk-1", askNonce: "4" });
  expect(shown.focus.leafId).toBe("b");

  const turned = openContent(layout, trace("s1", "job-2"), ids);
  expect(leafById(turned, "b")!.tabs[0]!.params).toEqual({ sessionId: "s1", taskId: "job-2" });

  const asked = openContent(layout, { ...trace("s1", "job-1"), ticket: "tk-2", askNonce: 5 }, ids);
  expect(leafById(asked, "b")!.tabs[0]!.params.askTicket).toBe("tk-2");
  expect(tiledLeaves(asked.root).map((leaf) => leaf.tabs.length)).toEqual([1, 1]);
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

test("a layout saved with a trace, a board and a plan tab of one conversation keeps the one nearest the keyboard", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-chat"), tabFor(view("s1", "job-1", "board"), "t-board")]),
    makeLeaf("b", [tabFor(trace("s1", "job-1"), "t-trace"), tabFor(view("s1", "job-1", "spec"), "t-spec"), tabFor(trace("s2", "job-9"), "t-other")]),
  ]), "a");
  const next = dropDuplicateBoundTabs(layout, ids.id);
  expect(tiledLeaves(next.root).map((leaf) => leaf.tabs.map((tab) => tab.id))).toEqual([
    ["t-chat", "t-board"],
    ["t-other"],
  ]);
  assertInvariants(next);
});

// ------------------------------------------------------------------ placements

const placed = (placement: NonNullable<Parameters<typeof openContent>[2]["placement"]>, place = measured()) =>
  ({ ...ids, placement, place }) as const;

const shape = (layout: WorkbenchLayout): unknown => {
  const walk = (node: WorkbenchLayout["root"]): unknown =>
    node.type === "leaf"
      ? node.tabs.map((tab) => tab.kind)
      : { [node.axis]: node.children.map(walk) };
  return walk(layout.root);
};

test("a split divides the focused pane that way and the new pane takes the window", () => {
  const cases = [
    ["split-right", { row: [["chat"], ["preview"]] }],
    ["split-left", { row: [["preview"], ["chat"]] }],
    ["split-down", { column: [["chat"], ["preview"]] }],
    ["split-up", { column: [["preview"], ["chat"]] }],
  ] as const;
  for (const [placement, expected] of cases) {
    const layout = layoutOf(makeLeaf("a", [tabFor(chat("s1"), "t-a")]));
    const next = openContent(layout, preview("s1", "a.md"), placed(placement));
    expect(shape(next)).toEqual(expected);
    expect(leafById(next, next.focus.leafId)!.tabs.map((tab) => tab.kind)).toEqual(["preview"]);
    assertInvariants(next);
  }
});

test("a split with no room, or from a floating pane, is a new tab where the keyboard is", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor(chat("s1"), "t-a")]));
  const cramped = openContent(layout, preview("s1", "a.md"), placed("split-right", measured({ fits: () => false })));
  expect(shape(cramped)).toEqual(["chat", "preview"]);

  const floating: WorkbenchLayout = {
    version: 1,
    root: makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    floating: [{ leaf: makeLeaf("f", [tabFor(chat("s2"), "t-f")]), frame: { x: 40, y: 40, width: 400, height: 300 } }],
    focus: { zone: "floating", leafId: "f" },
  };
  const next = openContent(floating, preview("s2", "a.md"), placed("split-right"));
  expect(leafById(next, "f")!.tabs.map((tab) => tab.kind)).toEqual(["chat", "preview"]);
  expect(shape(next)).toEqual(["chat"]);
});

test("the pane on that side takes it; from that pane, it stays there; only a single pane is split", () => {
  // A file and two flows in a row from the conversation: one column beside it, not three.
  let layout = layoutOf(makeLeaf("a", [tabFor(chat("s1"), "t-a")]));
  layout = openContent(layout, preview("s1", "a.md"), placed("side-right"));
  expect(shape(layout)).toEqual({ row: [["chat"], ["preview"]] });
  const side = layout.focus.leafId;
  // Back in the conversation, the job's flow goes to the column already beside it.
  layout = openContent({ ...layout, focus: { zone: "tiled", leafId: "a" } }, { kind: "trace", sessionId: "s1", taskId: "j" }, placed("side-right"));
  expect(layout.focus.leafId).toBe(side);
  // From the column itself, another conversation's flow stays in it.
  layout = openContent(layout, { kind: "trace", sessionId: "s2", taskId: "k" }, placed("side-right"));
  expect(shape(layout)).toEqual({ row: [["chat"], ["preview", "trace", "trace"]] });
  assertInvariants(layout);
});

test("terminals go under the conversation, and the next one joins them there", () => {
  let layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    makeLeaf("b", [tabFor(preview("s1", "a.md"), "t-p")]),
  ]), "a");
  layout = openContent(layout, { kind: "terminal", terminalId: "x" }, placed("side-down"));
  expect(shape(layout)).toEqual({ row: [{ column: [["chat"], ["terminal"]] }, ["preview"]] });
  layout = openContent({ ...layout, focus: { zone: "tiled", leafId: "a" } }, { kind: "terminal", terminalId: "y" }, placed("side-down"));
  expect(shape(layout)).toEqual({ row: [{ column: [["chat"], ["terminal", "terminal"]] }, ["preview"]] });
  assertInvariants(layout);
});

test("a float is a pane of its own over the layout, where the shell says, with the keyboard in it", () => {
  const layout = layoutOf(makeLeaf("a", [tabFor(chat("s1"), "t-a")]));
  const next = openContent(layout, { kind: "routines" }, placed("float"));
  expect(shape(next)).toEqual(["chat"]);
  expect(next.floating).toHaveLength(1);
  expect(next.floating[0]!.frame).toEqual({ x: 10, y: 20, width: 300, height: 200 });
  expect(next.floating[0]!.leaf.tabs.map((tab) => tab.kind)).toEqual(["routines"]);
  expect(next.focus).toEqual({ zone: "floating", leafId: next.floating[0]!.leaf.id });
  assertInvariants(next);
});

test("a background tab waits behind the one in front, and the keyboard stays where it was", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    makeLeaf("b", [tabFor(chat("s2"), "t-b")]),
  ]), "a");
  const next = openContent(layout, { kind: "terminal", terminalId: "x" }, placed("tab-background"));
  expect(leafById(next, "a")!.tabs.map((tab) => tab.kind)).toEqual(["chat", "terminal"]);
  expect(leafById(next, "a")!.activeTabId).toBe("t-a");
  expect(next.focus.leafId).toBe("a");
  // An empty pane shows what it is given, background or not.
  const empty = openContent(layoutOf(makeLeaf("e", [])), { kind: "spend" }, placed("tab-background"));
  expect(leafById(empty, "e")!.activeTabId).toBe(leafById(empty, "e")!.tabs[0]!.id);
  assertInvariants(next);
});

test("what is already open is only brought forward, whatever its placement says", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [tabFor(chat("s1"), "t-a")]),
    makeLeaf("b", [tabFor(preview("s1", "a.md"), "t-p")]),
  ]), "a");
  for (const placement of ["split-down", "float", "side-left", "tab"] as const) {
    const next = openContent(layout, preview("s1", "b.md"), placed(placement));
    expect(shape(next)).toEqual({ row: [["chat"], ["preview"]] });
    expect(next.floating).toHaveLength(0);
    expect(leafById(next, "b")!.tabs[0]!.params.relpath).toBe("b.md");
    expect(next.focus.leafId).toBe("b");
  }
  // A conversation open elsewhere is the same: the roster's click goes to it, not a second copy.
  const chats = openContent(layout, chat("s1"), placed("split-right"));
  expect(shape(chats)).toEqual({ row: [["chat"], ["preview"]] });
});

test("a replace only takes the same kind of window: another conversation's flow takes the flow's place", () => {
  const trace = { kind: "trace", sessionId: "s1", taskId: "j" } as const;
  const layout = layoutOf(makeLeaf("a", [tabFor(trace, "t-trace")]));
  const next = openContent(layout, { ...trace, sessionId: "s2" }, { ...ids, placement: "replace" });
  expect(leafById(next, "a")!.tabs.map((tab) => [tab.kind, tab.params.sessionId])).toEqual([["trace", "s2"]]);
  // A conversation and a Bot↔Bot direct are two kinds when the shell can tell them apart.
  const directs = layoutOf(makeLeaf("a", [tabFor(chat("bb"), "t-bb")]));
  const kindOf = (content: Parameters<PlaceContext["kindOf"]>[0]) =>
    content.kind === "chat" && content.sessionId === "bb" ? "bot-bot" : content.kind;
  const kept = openContent(directs, chat("s1"), { ...ids, placement: "replace", place: noPlace({ kindOf }) });
  expect(leafById(kept, "a")!.tabs.map((tab) => tab.params.sessionId)).toEqual(["bb", "s1"]);
});

test("dragging a conversation in carries the tab it already has, wherever that is, else a new one", () => {
  const open = tabFor({ kind: "chat", sessionId: "s1", side: null }, "c1");
  const layout: WorkbenchLayout = {
    ...layoutOf(makeLeaf("a", [tabFor({ kind: "workspace", selected: null }, "w1")])),
    floating: [{ leaf: makeLeaf("f", [open]), frame: { x: 0, y: 0, width: 400, height: 300 } }],
  };
  expect(chatDragSource(layout, "s1", ids.id)).toEqual({ leafId: "f", tabId: "c1" });

  const fresh = chatDragSource(layout, "s2", () => "n1");
  expect(fresh).toEqual({ tab: tabFor({ kind: "chat", sessionId: "s2", side: null }, "n1") });
});
