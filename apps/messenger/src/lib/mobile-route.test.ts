import { expect, test } from "bun:test";
import { planUrlNavigation, routeLayers, routeStep, stackAfter, topLayer, type LayerState } from "./mobile-route.ts";
import type { UrlView } from "./session-url.ts";

const roster: UrlView = { selectedId: null, previewRelpath: null, previewAttachmentId: null, overlay: { kind: "none" } };
const session: UrlView = { ...roster, selectedId: "s1" };
const drawer: UrlView = { ...session, overlay: { kind: "session" } };
const botDrawer: UrlView = { ...session, overlay: { kind: "bot", botId: "bot-1" } };
const preview: UrlView = { ...session, previewRelpath: "notes/a.md" };
const workspace: UrlView = { ...roster, overlay: { kind: "workspace", selected: null } };
const workspaceFile: UrlView = { ...roster, overlay: { kind: "workspace", selected: "notes/a.md" } };

test("a URL is a stack of screens, outermost first", () => {
  expect(routeLayers(roster)).toEqual([]);
  expect(routeLayers(session)).toEqual(["session:s1"]);
  expect(routeLayers(drawer)).toEqual(["session:s1", "session"]);
  expect(routeLayers(preview)).toEqual(["session:s1", "preview:notes/a.md"]);
  // The file open in the workspace is its own screen, so closing it keeps the workspace.
  expect(routeLayers(workspace)).toEqual(["workspace"]);
  expect(routeLayers(workspaceFile)).toEqual(["workspace", "workspace-file:notes/a.md"]);
});

test("the step is which way the stack moved", () => {
  expect(routeStep(roster, session)).toBe("deeper");
  expect(routeStep(session, drawer)).toBe("deeper");
  expect(routeStep(drawer, session)).toBe("shallower");
  expect(routeStep(session, roster)).toBe("shallower");
  expect(routeStep(workspaceFile, workspace)).toBe("shallower");
  // A Bot opened from the group drawer takes that settings page. Closing it goes to the
  // conversation, which is one screen less.
  expect(routeStep(drawer, botDrawer)).toBe("swap");
  expect(routeStep(botDrawer, session)).toBe("shallower");
  expect(routeStep(session, { ...roster, selectedId: "s2" })).toBe("lateral");
});

test("closing a screen never pushes: it walks back when that is where the URL came from", () => {
  const stack = ["", "?s=s1", "?s=s1&o=session"];
  expect(planUrlNavigation({ target: "?s=s1", stack, step: "shallower" })).toBe("back");
  // Opening a Bot from the group drawer rewrites that settings entry, so closing it walks
  // back to the conversation underneath.
  expect(planUrlNavigation({
    target: "?s=s1&o=bot&b=bot-1",
    stack: ["", "?s=s1", "?s=s1&o=session"],
    step: "swap",
  })).toBe("replace");
  expect(planUrlNavigation({
    target: "?s=s1",
    stack: ["", "?s=s1", "?s=s1&o=bot&b=bot-1"],
    step: "shallower",
  })).toBe("back");
  // Nothing of ours underneath — a deep link straight into the drawer — so rewrite the entry
  // rather than walking out of the app.
  expect(planUrlNavigation({ target: "?s=s1", stack: ["?s=s1&o=session"], step: "shallower" })).toBe("replace");
  // The entry underneath is a different screen, so going back would land on the wrong one.
  expect(planUrlNavigation({ target: "", stack: ["", "?o=workspace", "?o=settings"], step: "shallower" })).toBe("replace");
});

test("opening and switching screens push, so Back retraces them", () => {
  const stack = ["", "?s=s1"];
  expect(planUrlNavigation({ target: "?s=s1&o=session", stack, step: "deeper" })).toBe("push");
  expect(planUrlNavigation({ target: "?s=s2", stack, step: "lateral" })).toBe("push");
});

test("picking another file in a preview is not a new screen, so it rewrites the entry", () => {
  // Back from the preview goes to the page it was opened from, not through every file looked at.
  const other: UrlView = { ...preview, previewRelpath: "notes/b.md" };
  expect(routeStep(preview, other)).toBe("swap");
  expect(routeStep(
    { ...session, previewAttachmentId: "att-1" },
    { ...session, previewAttachmentId: "att-2" },
  )).toBe("swap");
  expect(routeStep(workspaceFile, { ...roster, overlay: { kind: "workspace", selected: "notes/b.md" } })).toBe("swap");
  expect(planUrlNavigation({
    target: "?s=s1&p=notes%2Fb.md",
    stack: ["", "?s=s1", "?s=s1&p=notes%2Fa.md"],
    step: "swap",
  })).toBe("replace");
  // Opening the first file is still a screen, and a file in another session is another place.
  // A Bot's settings opened from the conversation is a screen too.
  expect(routeStep(session, preview)).toBe("deeper");
  expect(routeStep(session, botDrawer)).toBe("deeper");
  expect(routeStep(preview, { ...preview, selectedId: "s2", previewRelpath: "notes/b.md" })).toBe("lateral");
});

test("the stack follows the URL: back pops, a replacement rewrites the top, anything else extends", () => {
  expect(stackAfter(["", "?s=s1"], "?s=s1", false)).toEqual(["", "?s=s1"]);
  expect(stackAfter(["", "?s=s1", "?s=s1&o=session"], "?s=s1", false)).toEqual(["", "?s=s1"]);
  expect(stackAfter(["", "?s=s1"], "?s=s1&o=session", false)).toEqual(["", "?s=s1", "?s=s1&o=session"]);
  expect(stackAfter(["", "?s=s1&o=session"], "?s=s1", true)).toEqual(["", "?s=s1"]);
});

function layers(over: Partial<LayerState> = {}): LayerState {
  return {
    createMenuOpen: false,
    dangerConfirm: false,
    bulkModelOpen: false,
    createBotOpen: false,
    createGroupOpen: false,
    providerEditor: false,
    confirmingIndependent: false,
    searchPageOpen: false,
    settingsOpen: false,
    sessionSettingsOpen: false,
    toolsMenuOpen: false,
    terminalOpen: false,
    traceOpen: false,
    routinesOpen: false,
    spendOpen: false,
    threadOpen: false,
    workspaceOpen: false,
    artifactPreview: false,
    ...over,
  };
}

test("the spend ledger is a screen of its own, beside the calendar", () => {
  const spend: UrlView = { ...roster, overlay: { kind: "spend" } };
  expect(routeLayers(spend)).toEqual(["spend"]);
  expect(routeStep(roster, spend)).toBe("deeper");
  expect(routeStep(spend, roster)).toBe("shallower");
  expect(topLayer(layers({ spendOpen: true, routinesOpen: true }))).toBe("routines");
  expect(topLayer(layers({ spendOpen: true, workspaceOpen: true }))).toBe("spend");
});

test("the routine calendar is a screen of its own, between the trace and the thread", () => {
  const routines: UrlView = { ...roster, overlay: { kind: "routines" } };
  expect(routeLayers(routines)).toEqual(["routines"]);
  expect(routeStep(roster, routines)).toBe("deeper");
  expect(routeStep(routines, roster)).toBe("shallower");
  expect(topLayer(layers({ routinesOpen: true, workspaceOpen: true }))).toBe("routines");
  expect(topLayer(layers({ routinesOpen: true, traceOpen: true }))).toBe("trace");
});

test("Back closes the innermost thing on top", () => {
  expect(topLayer(layers())).toBeNull();
  expect(topLayer(layers({ settingsOpen: true }))).toBe("settings");
  // A confirmation on top of settings goes first; so does a menu on top of everything.
  expect(topLayer(layers({ settingsOpen: true, dangerConfirm: true }))).toBe("danger");
  expect(topLayer(layers({ settingsOpen: true, dangerConfirm: true, toolsMenuOpen: true }))).toBe("tools-menu");
  expect(topLayer(layers({ sessionSettingsOpen: true, artifactPreview: true }))).toBe("session-settings");
  expect(topLayer(layers({ workspaceOpen: true, artifactPreview: true }))).toBe("workspace");
  expect(topLayer(layers({ threadOpen: true, artifactPreview: true }))).toBe("thread");
  // The phone's search page is a screen over the chat list: Back leaves search before it leaves
  // the list. Switching destination closes it, so it never has settings or the workspace on top
  // of it; a menu can still open over anything.
  expect(topLayer(layers({ searchPageOpen: true }))).toBe("search-page");
  expect(topLayer(layers({ searchPageOpen: true, threadOpen: true }))).toBe("search-page");
  expect(topLayer(layers({ searchPageOpen: true, toolsMenuOpen: true }))).toBe("tools-menu");
  expect(topLayer(layers({ createMenuOpen: true, settingsOpen: true }))).toBe("create-menu");
});

test("the bulk model dialog goes at Back before the session drawer it can sit on", () => {
  expect(topLayer(layers({ bulkModelOpen: true, sessionSettingsOpen: true }))).toBe("bulk-model");
  expect(topLayer(layers({ bulkModelOpen: true, dangerConfirm: true }))).toBe("danger");
});

test("the phone's tools menu is a menu: it goes before anything Back would navigate to", () => {
  // One Back closes the menu before leaving the current screen.
  expect(topLayer(layers({ toolsMenuOpen: true }))).toBe("tools-menu");
  expect(topLayer(layers({ toolsMenuOpen: true, settingsOpen: true, workspaceOpen: true }))).toBe("tools-menu");
  expect(topLayer(layers({ toolsMenuOpen: true, createMenuOpen: true }))).toBe("tools-menu");
});
