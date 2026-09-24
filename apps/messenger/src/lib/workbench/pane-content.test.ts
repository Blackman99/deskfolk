import { expect, test } from "bun:test";
import {
  PANE_KINDS,
  contentFromOverlay,
  contentOfTab,
  contentSessionId,
  contentToParams,
  contentsEqual,
  overlayFromContent,
  tabFor,
  type PaneContent,
} from "./pane-content.ts";
import { overlayFromFlags, overlaysEqual, type UrlOverlay } from "../session-url.ts";

const samples: PaneContent[] = [
  { kind: "chat", sessionId: "s1" },
  { kind: "chat", sessionId: "s1", side: { kind: "settings", botId: null } },
  { kind: "chat", sessionId: "s1", side: { kind: "settings", botId: "bot-1" } },
  { kind: "preview", sessionId: "s1", relpath: "work/a.md", attachmentId: null },
  { kind: "preview", sessionId: null, relpath: null, attachmentId: "att-1" },
  { kind: "trace", sessionId: "s1", taskId: null },
  { kind: "trace", sessionId: "s1", taskId: "task-1" },
  {
    kind: "trace",
    sessionId: "s1",
    taskId: "task-1",
    focus: { messageId: "m1", turnId: "turn-1" },
    focusNonce: 2,
  },
  { kind: "terminal", terminalId: "term-1", cwd: "/work/real-bot" },
  { kind: "terminal", terminalId: null },
  { kind: "workspace", selected: "work/a.md" },
  { kind: "workspace", selected: null },
  { kind: "routines" },
  { kind: "spend" },
];

test("every kind round trips through a tab", () => {
  for (const content of samples) {
    const back = contentOfTab(tabFor(content, "t1"));
    expect(back).not.toBeNull();
    expect(contentsEqual(back!, content)).toBe(true);
  }
});

test("parameters are strings only, so a layout survives storage", () => {
  for (const content of samples) {
    for (const value of Object.values(contentToParams(content))) {
      expect(typeof value).toBe("string");
    }
  }
});

test("a kind this build does not know reads as nothing rather than a blank pane", () => {
  expect(contentOfTab({ id: "t1", kind: "from-the-future", params: {} })).toBeNull();
  // And a known kind missing what it needs is equally not drawable.
  expect(contentOfTab({ id: "t1", kind: "chat", params: {} })).toBeNull();
  expect(contentOfTab({ id: "t1", kind: "trace", params: {} })).toBeNull();
});

test("settings are a conversation's sidebar and the model-choice log is no pane at all", () => {
  // A layout saved when they were tabs names kinds this build no longer draws; healing drops them.
  expect(contentOfTab({ id: "t1", kind: "session-settings", params: { sessionId: "s1" } })).toBeNull();
  expect(contentOfTab({ id: "t1", kind: "route-log", params: { sessionId: "s1" } })).toBeNull();
  expect(PANE_KINDS).not.toContain("session-settings" as never);
  expect(PANE_KINDS).not.toContain("route-log" as never);
  // A side this build does not know — the log's, say — is nothing open, not a broken sidebar.
  for (const side of ["route-log", "from-the-future"]) {
    expect(contentOfTab({ id: "t1", kind: "chat", params: { sessionId: "s1", side } })).toEqual({
      kind: "chat",
      sessionId: "s1",
      side: null,
    });
  }
});

test("the kind list covers every case the union has", () => {
  const kinds = new Set(samples.map((content) => content.kind));
  expect([...kinds].sort()).toEqual([...PANE_KINDS].sort());
});

test("a pane says which conversation it belongs to, so closing it can release the history", () => {
  expect(contentSessionId({ kind: "chat", sessionId: "s1" })).toBe("s1");
  expect(contentSessionId({ kind: "chat", sessionId: "s1", side: { kind: "settings", botId: null } })).toBe("s1");
  expect(contentSessionId({ kind: "terminal", terminalId: "t" })).toBeNull();
  expect(contentSessionId({ kind: "routines" })).toBeNull();
});

/**
 * The device that keeps the two surfaces from drifting: for every overlay a pane can show, what
 * the pane says and what the flags say have to agree. The phone's terminal page is not one of
 * those panes, so it stays out of this table.
 */
test("a pane and the old flags describe the same overlay", () => {
  const cases: Array<{ content: PaneContent; flags: Parameters<typeof overlayFromFlags>[0] }> = [
    {
      content: { kind: "chat", sessionId: "s1", side: { kind: "settings", botId: null } },
      flags: { settingsOpen: false, sessionSettingsOpen: true, profileBotId: null, workspaceOpen: false, workspaceSelected: null },
    },
    {
      content: { kind: "chat", sessionId: "s1", side: { kind: "settings", botId: "bot-1" } },
      flags: { settingsOpen: false, sessionSettingsOpen: true, profileBotId: "bot-1", workspaceOpen: false, workspaceSelected: null },
    },
    {
      content: { kind: "workspace", selected: "work/a.md" },
      flags: { settingsOpen: false, sessionSettingsOpen: false, profileBotId: null, workspaceOpen: true, workspaceSelected: "work/a.md" },
    },
    {
      content: { kind: "trace", sessionId: "s1", taskId: "task-1" },
      flags: { settingsOpen: false, sessionSettingsOpen: false, profileBotId: null, workspaceOpen: false, workspaceSelected: null, traceOpen: true, traceTaskId: "task-1" },
    },
    {
      content: { kind: "routines" },
      flags: { settingsOpen: false, sessionSettingsOpen: false, profileBotId: null, workspaceOpen: false, workspaceSelected: null, routinesOpen: true },
    },
    {
      content: { kind: "spend" },
      flags: { settingsOpen: false, sessionSettingsOpen: false, profileBotId: null, workspaceOpen: false, workspaceSelected: null, spendOpen: true },
    },
  ];
  for (const { content, flags } of cases) {
    expect(overlaysEqual(overlayFromContent(content), overlayFromFlags(flags))).toBe(true);
  }
});

test("what was never in the URL stays out of it", () => {
  expect(overlayFromContent({ kind: "chat", sessionId: "s1" })).toEqual({ kind: "none" });
  // A desktop tab is one shell. The phone's page is the only terminal the URL carries.
  expect(overlayFromContent({ kind: "terminal", terminalId: "t" })).toEqual({ kind: "none" });
  expect(overlayFromContent(null)).toEqual({ kind: "none" });
});

test("a deep link becomes the pane it asks for", () => {
  const cases: Array<[UrlOverlay, string | null, PaneContent | null]> = [
    [{ kind: "session" }, "s1", { kind: "chat", sessionId: "s1", side: { kind: "settings", botId: null } }],
    [{ kind: "bot", botId: "bot-1" }, "s1", { kind: "chat", sessionId: "s1", side: { kind: "settings", botId: "bot-1" } }],
    [
      { kind: "trace", taskId: "task-1" },
      "s1",
      { kind: "trace", sessionId: "s1", taskId: "task-1", focus: null, focusNonce: null },
    ],
    [{ kind: "workspace", selected: null }, null, { kind: "workspace", selected: null }],
    [{ kind: "routines" }, null, { kind: "routines" }],
    [{ kind: "spend" }, null, { kind: "spend" }],
    // The phone's terminal page is not a desktop tab, so a link to it names no pane.
    [{ kind: "terminal" }, null, null],
    // Settings stays a modal on the desktop, so it is not a pane at all.
    [{ kind: "settings" }, "s1", null],
    [{ kind: "none" }, "s1", null],
    // A link about a conversation with no conversation to hand names nothing.
    [{ kind: "session" }, null, null],
  ];
  for (const [overlay, sessionId, expected] of cases) {
    expect(contentFromOverlay(overlay, sessionId)).toEqual(expected);
  }
});

test("round tripping an overlay through a pane keeps what the URL carried", () => {
  const overlays: UrlOverlay[] = [
    { kind: "session" },
    { kind: "bot", botId: "bot-1" },
    { kind: "trace", taskId: "task-1" },
    { kind: "workspace", selected: "work/a.md" },
    { kind: "routines" },
    { kind: "spend" },
  ];
  for (const overlay of overlays) {
    const content = contentFromOverlay(overlay, "s1")!;
    expect(overlaysEqual(overlayFromContent(content), overlay)).toBe(true);
  }
});
