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
  // Another Bot's profile from the group drawer, or another session: same depth, new screen.
  expect(routeStep(drawer, botDrawer)).toBe("lateral");
  expect(routeStep(session, { ...roster, selectedId: "s2" })).toBe("lateral");
});

test("closing a screen never pushes: it walks back when that is where the URL came from", () => {
  const stack = ["", "?s=s1", "?s=s1&o=session"];
  expect(planUrlNavigation({ target: "?s=s1", stack, step: "shallower" })).toBe("back");
  // Swapping a screen for the one underneath — a Bot's profile back to the group drawer — is a
  // step back too, even though the depth is the same.
  expect(planUrlNavigation({
    target: "?s=s1&o=session",
    stack: ["", "?s=s1&o=session", "?s=s1&o=bot&b=bot-1"],
    step: "lateral",
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

test("the stack follows the URL: back pops, a replacement rewrites the top, anything else extends", () => {
  expect(stackAfter(["", "?s=s1"], "?s=s1", false)).toEqual(["", "?s=s1"]);
  expect(stackAfter(["", "?s=s1", "?s=s1&o=session"], "?s=s1", false)).toEqual(["", "?s=s1"]);
  expect(stackAfter(["", "?s=s1"], "?s=s1&o=session", false)).toEqual(["", "?s=s1", "?s=s1&o=session"]);
  expect(stackAfter(["", "?s=s1&o=session"], "?s=s1", true)).toEqual(["", "?s=s1"]);
});

function layers(over: Partial<LayerState> = {}): LayerState {
  return {
    themeMenuOpen: false,
    createMenuOpen: false,
    dangerConfirm: false,
    createBotOpen: false,
    createGroupOpen: false,
    providerEditor: false,
    confirmingIndependent: false,
    searchPageOpen: false,
    settingsOpen: false,
    sessionSettingsOpen: false,
    routeLogOpen: false,
    threadOpen: false,
    workspaceOpen: false,
    artifactPreview: false,
    ...over,
  };
}

test("Back closes the innermost thing on top", () => {
  expect(topLayer(layers())).toBeNull();
  expect(topLayer(layers({ settingsOpen: true }))).toBe("settings");
  // A confirmation on top of settings goes first; so does a menu on top of everything.
  expect(topLayer(layers({ settingsOpen: true, dangerConfirm: true }))).toBe("danger");
  expect(topLayer(layers({ settingsOpen: true, dangerConfirm: true, themeMenuOpen: true }))).toBe("theme-menu");
  expect(topLayer(layers({ sessionSettingsOpen: true, artifactPreview: true }))).toBe("session-settings");
  expect(topLayer(layers({ workspaceOpen: true, artifactPreview: true }))).toBe("workspace");
  expect(topLayer(layers({ threadOpen: true, artifactPreview: true }))).toBe("thread");
  // The phone's search page is a screen over the chat list: Back leaves search before it leaves
  // the list. Switching destination closes it, so it never has settings or the workspace on top
  // of it; a menu can still open over anything.
  expect(topLayer(layers({ searchPageOpen: true }))).toBe("search-page");
  expect(topLayer(layers({ searchPageOpen: true, threadOpen: true }))).toBe("search-page");
  expect(topLayer(layers({ searchPageOpen: true, themeMenuOpen: true }))).toBe("theme-menu");
  expect(topLayer(layers({ createMenuOpen: true, settingsOpen: true }))).toBe("create-menu");
});
