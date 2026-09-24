import { expect, test } from "bun:test";
import {
  overlayApply,
  overlayFromFlags,
  overlayFromUrl,
  previewFromUrl,
  attachmentFromUrl,
  sanitizePreviewPath,
  selectionFromUrl,
  sessionFromUrl,
  sessionUrl,
  viewFromUrl,
  overlaysEqual,
  type UrlOverlay,
  type UrlView,
} from "./session-url.ts";

const at = (search: string) => new URL(`http://localhost:5173/${search}`);

function view(over: Partial<UrlView> = {}): UrlView {
  return {
    selectedId: null,
    previewRelpath: null,
    previewAttachmentId: null,
    overlay: { kind: "none" },
    ...over,
  };
}

test("reads the session out of the query", () => {
  expect(sessionFromUrl(at("?s=abc"))).toBe("abc");
  expect(sessionFromUrl(at(""))).toBeNull();
});

test("reads the preview path out of the query", () => {
  expect(previewFromUrl(at("?p=out/mock.html"))).toBe("out/mock.html");
  expect(previewFromUrl(at("?s=abc&p=inbox%2Fclip.mp4"))).toBe("inbox/clip.mp4");
  expect(previewFromUrl(at("?s=abc"))).toBeNull();
});

test("reads overlays out of the query", () => {
  expect(overlayFromUrl(at("?o=settings"))).toEqual({ kind: "settings" });
  expect(overlayFromUrl(at("?o=notifications"))).toEqual({ kind: "none" });
  expect(overlayFromUrl(at("?o=session"))).toEqual({ kind: "session" });
  expect(overlayFromUrl(at("?o=bot&b=bot-1"))).toEqual({ kind: "bot", botId: "bot-1" });
  expect(overlayFromUrl(at("?o=workspace"))).toEqual({ kind: "workspace", selected: null });
  expect(overlayFromUrl(at("?o=workspace&w=inbox/a.md"))).toEqual({
    kind: "workspace",
    selected: "inbox/a.md",
  });
  expect(overlayFromUrl(at("?o=bot"))).toEqual({ kind: "none" });
  expect(overlayFromUrl(at("?o=nope"))).toEqual({ kind: "none" });
  expect(overlayFromUrl(at(""))).toEqual({ kind: "none" });
});

test("returns null when the URL already says the right thing", () => {
  expect(sessionUrl(at("?s=abc"), view({ selectedId: "abc" }))).toBeNull();
  expect(sessionUrl(at(""), view())).toBeNull();
  expect(
    sessionUrl(at("?s=abc&p=out/a.html"), view({ selectedId: "abc", previewRelpath: "out/a.html" })),
  ).toBeNull();
  expect(sessionUrl(at("?o=settings"), view({ overlay: { kind: "settings" } }))).toBeNull();
});

test("adds, replaces and drops the session", () => {
  expect(sessionUrl(at(""), view({ selectedId: "abc" }))).toBe("/?s=abc");
  expect(sessionUrl(at("?s=abc"), view({ selectedId: "def" }))).toBe("/?s=def");
  expect(sessionUrl(at("?s=abc"), view())).toBe("/");
});

test("adds, replaces and drops the preview without touching the session", () => {
  expect(sessionUrl(at("?s=abc"), view({ selectedId: "abc", previewRelpath: "out/a.html" }))).toBe(
    "/?s=abc&p=out%2Fa.html",
  );
  expect(
    sessionUrl(
      at("?s=abc&p=out/a.html"),
      view({ selectedId: "abc", previewRelpath: "inbox/b.md" }),
    ),
  ).toBe("/?s=abc&p=inbox%2Fb.md");
  expect(sessionUrl(at("?s=abc&p=out/a.html"), view({ selectedId: "abc" }))).toBe("/?s=abc");
});

test("adds, replaces and drops overlays", () => {
  expect(sessionUrl(at("?s=abc"), view({ selectedId: "abc", overlay: { kind: "settings" } }))).toBe(
    "/?s=abc&o=settings",
  );
  expect(
    sessionUrl(at("?s=abc&o=settings"), view({ selectedId: "abc", overlay: { kind: "session" } })),
  ).toBe("/?s=abc&o=session");
  expect(
    sessionUrl(
      at("?s=abc"),
      view({ selectedId: "abc", overlay: { kind: "bot", botId: "bot-1" } }),
    ),
  ).toBe("/?s=abc&o=bot&b=bot-1");
  expect(
    sessionUrl(
      at("?s=abc"),
      view({
        selectedId: "abc",
        overlay: { kind: "workspace", selected: "inbox/a.md" },
      }),
    ),
  ).toBe("/?s=abc&o=workspace&w=inbox%2Fa.md");
  expect(sessionUrl(at("?s=abc&o=settings"), view({ selectedId: "abc" }))).toBe("/?s=abc");
});

test("closing an overlay drops its extra params", () => {
  expect(sessionUrl(at("?s=abc&o=bot&b=bot-1"), view({ selectedId: "abc" }))).toBe("/?s=abc");
  expect(sessionUrl(at("?s=abc&o=workspace&w=inbox/a.md"), view({ selectedId: "abc" }))).toBe(
    "/?s=abc",
  );
});

test("encoded and raw slashes in the preview query are the same location", () => {
  expect(
    sessionUrl(at("?s=abc&p=out/a.html"), view({ selectedId: "abc", previewRelpath: "out/a.html" })),
  ).toBeNull();
  expect(
    sessionUrl(
      at("?s=abc&p=out%2Fa.html"),
      view({ selectedId: "abc", previewRelpath: "out/a.html" }),
    ),
  ).toBeNull();
});

test("leaves other query parameters alone", () => {
  expect(sessionUrl(at("?debug=1"), view({ selectedId: "abc" }))).toBe("/?debug=1&s=abc");
  expect(sessionUrl(at("?debug=1&s=abc"), view())).toBe("/?debug=1");
  expect(
    sessionUrl(at("?debug=1&s=abc"), view({ selectedId: "abc", previewRelpath: "out/a.html" })),
  ).toBe("/?debug=1&s=abc&p=out%2Fa.html");
});

test("sanitizePreviewPath rejects escapes and empty values", () => {
  expect(sanitizePreviewPath("out/a.html")).toBe("out/a.html");
  expect(sanitizePreviewPath(" ./out/a.html ")).toBe("out/a.html");
  expect(sanitizePreviewPath("")).toBeNull();
  expect(sanitizePreviewPath("/etc/passwd")).toBeNull();
  expect(sanitizePreviewPath("https://example.com/a")).toBeNull();
  expect(sanitizePreviewPath("../secret")).toBeNull();
});

test("overlayFromFlags prefers settings, then the drawer, then workspace", () => {
  expect(
    overlayFromFlags({
      settingsOpen: true,
      sessionSettingsOpen: true,
      profileBotId: "bot-1",
      workspaceOpen: true,
      workspaceSelected: "a.md",
    }),
  ).toEqual({ kind: "settings" });
  expect(
    overlayFromFlags({
      settingsOpen: false,
      sessionSettingsOpen: true,
      profileBotId: "bot-1",
      workspaceOpen: true,
      workspaceSelected: "a.md",
    }),
  ).toEqual({ kind: "bot", botId: "bot-1" });
  expect(
    overlayFromFlags({
      settingsOpen: false,
      sessionSettingsOpen: true,
      profileBotId: null,
      workspaceOpen: false,
      workspaceSelected: null,
    }),
  ).toEqual({ kind: "session" });
  expect(
    overlayFromFlags({
      settingsOpen: false,
      sessionSettingsOpen: false,
      profileBotId: null,
      workspaceOpen: true,
      workspaceSelected: "inbox/a.md",
    }),
  ).toEqual({ kind: "workspace", selected: "inbox/a.md" });
});

const ready = {
  selectedId: "abc",
  knownSessionIds: ["abc"],
  knownBotIds: ["bot-1"],
  hasWorkspacePath: true,
  snapshotReady: true,
};

test("overlayApply is a no-op when the URL already matches", () => {
  expect(overlayApply({ kind: "settings" }, { kind: "settings" }, ready)).toEqual({
    action: "none",
  });
});

test("overlayApply waits until the snapshot can confirm a session or bot", () => {
  expect(
    overlayApply({ kind: "session" }, { kind: "none" }, { ...ready, knownSessionIds: [], snapshotReady: false }),
  ).toEqual({ action: "wait" });
  expect(
    overlayApply(
      { kind: "bot", botId: "bot-1" },
      { kind: "none" },
      { ...ready, knownBotIds: [], snapshotReady: false },
    ),
  ).toEqual({ action: "wait" });
  expect(
    overlayApply(
      { kind: "workspace", selected: null },
      { kind: "none" },
      { ...ready, snapshotReady: false },
    ),
  ).toEqual({ action: "wait" });
});

test("overlayApply drops a drawer the snapshot will never have", () => {
  expect(
    overlayApply({ kind: "session" }, { kind: "session" }, { ...ready, selectedId: null }),
  ).toEqual({ action: "set", overlay: { kind: "none" } });
  expect(
    overlayApply(
      { kind: "bot", botId: "gone" },
      { kind: "bot", botId: "gone" },
      ready,
    ),
  ).toEqual({ action: "set", overlay: { kind: "none" } });
  expect(
    overlayApply(
      { kind: "workspace", selected: null },
      { kind: "workspace", selected: null },
      { ...ready, hasWorkspacePath: false },
    ),
  ).toEqual({ action: "set", overlay: { kind: "none" } });
});



test("a trace overlay round-trips through the URL with its job", () => {
  const overlay: UrlOverlay = { kind: "trace", taskId: "task-1" };
  expect(sessionUrl(at("?s=abc"), view({ selectedId: "abc", overlay }))).toBe("/?s=abc&o=trace&k=task-1");
  expect(overlayFromUrl(at("?s=abc&o=trace&k=task-1"))).toEqual(overlay);
  expect(overlayFromUrl(at("?s=abc&o=trace"))).toEqual({ kind: "trace", taskId: null });
  expect(
    overlayFromFlags({
      settingsOpen: false,
      sessionSettingsOpen: false,
      profileBotId: null,
      workspaceOpen: false,
      workspaceSelected: null,
      traceOpen: true,
      traceTaskId: "task-1",
    }),
  ).toEqual(overlay);
  expect(overlaysEqual(overlay, { kind: "trace", taskId: "task-2" })).toBe(false);
});

test("the routine calendar outranks workspace and trace, and does not carry a preview", () => {
  const flags = {
    settingsOpen: false,
    sessionSettingsOpen: false,
    profileBotId: null,
    workspaceOpen: true,
    workspaceSelected: "inbox/a.md",
    traceOpen: true,
    traceTaskId: "task-1",
    routinesOpen: true,
  };
  expect(overlayFromFlags(flags)).toEqual({ kind: "routines" });
  expect(overlayFromFlags({ ...flags, settingsOpen: true })).toEqual({ kind: "settings" });
  expect(overlayFromFlags({ ...flags, settingsOpen: false })).toEqual({ kind: "routines" });
  expect(overlayFromFlags({ ...flags, settingsOpen: false, sessionSettingsOpen: true, profileBotId: "bot-1" })).toEqual({
    kind: "bot",
    botId: "bot-1",
  });
  expect(sessionUrl(at("?s=abc&p=notes/a.md"), view({ selectedId: "abc", previewRelpath: "notes/a.md", overlay: { kind: "routines" } }))).toBe(
    "/?s=abc&o=routines",
  );
  expect(overlayFromUrl(at("?o=routines"))).toEqual({ kind: "routines" });
  expect(overlayApply({ kind: "routines" }, { kind: "none" }, { ...ready, selectedId: null, snapshotReady: false })).toEqual({
    action: "set",
    overlay: { kind: "routines" },
  });
  expect(overlayFromUrl(at("?s=abc&o=trace&k=task-1")).kind).toBe("trace");
});

test("the phone terminal page outranks the calendar and does not carry a preview", () => {
  expect(sessionUrl(at("?s=abc&p=notes/a.md"), view({ selectedId: "abc", previewRelpath: "notes/a.md", overlay: { kind: "terminal" } }))).toBe(
    "/?s=abc&o=terminal",
  );
  expect(overlayFromUrl(at("?o=terminal"))).toEqual({ kind: "terminal" });
  expect(overlayFromFlags({
    settingsOpen: false,
    sessionSettingsOpen: false,
    profileBotId: null,
    workspaceOpen: false,
    workspaceSelected: null,
    routinesOpen: true,
    terminalOpen: true,
  })).toEqual({ kind: "terminal" });
  expect(overlayFromFlags({
    settingsOpen: false,
    sessionSettingsOpen: false,
    profileBotId: null,
    workspaceOpen: false,
    workspaceSelected: null,
    terminalOpen: true,
    spendOpen: true,
  })).toEqual({ kind: "spend" });
  expect(overlayApply({ kind: "terminal" }, { kind: "none" }, { ...ready, selectedId: null, snapshotReady: false })).toEqual({
    action: "set",
    overlay: { kind: "terminal" },
  });
});

test("the spend ledger outranks the calendar and does not carry a preview", () => {
  expect(sessionUrl(at("?s=abc&p=notes/a.md"), view({ selectedId: "abc", previewRelpath: "notes/a.md", overlay: { kind: "spend" } }))).toBe(
    "/?s=abc&o=spend",
  );
  expect(overlayFromUrl(at("?o=spend"))).toEqual({ kind: "spend" });
  expect(overlayFromFlags({
    settingsOpen: false,
    sessionSettingsOpen: false,
    profileBotId: null,
    workspaceOpen: false,
    workspaceSelected: null,
    routinesOpen: true,
    spendOpen: true,
  })).toEqual({ kind: "spend" });
  expect(overlayApply({ kind: "spend" }, { kind: "none" }, { ...ready, selectedId: null, snapshotReady: false })).toEqual({
    action: "set",
    overlay: { kind: "spend" },
  });
});

test("overlayApply opens the overlay the URL asked for", () => {
  const overlay: UrlOverlay = { kind: "workspace", selected: "inbox/a.md" };
  expect(overlayApply(overlay, { kind: "none" }, ready)).toEqual({ action: "set", overlay });
});

test("a URL that matches the selection asks for nothing", () => {
  expect(selectionFromUrl("abc", "abc", ["abc"])).toEqual({ action: "none" });
  expect(selectionFromUrl(null, null, [])).toEqual({ action: "none" });
});

test("an empty query clears the selection", () => {
  expect(selectionFromUrl(null, "abc", ["abc"])).toEqual({ action: "clear" });
});

test("a known session is selected", () => {
  expect(selectionFromUrl("def", "abc", ["abc", "def"])).toEqual({ action: "select", id: "def" });
});

test("an id the snapshot has never seen waits rather than fetching", () => {
  expect(selectionFromUrl("zzz", null, ["abc"])).toEqual({ action: "wait", id: "zzz" });
});

test("remote URLs keep session and overlay ids and drop file paths", () => {
  expect(
    sessionUrl(
      at("?s=abc&p=out/a.html&o=workspace&w=inbox/a.md"),
      view({ selectedId: "abc", previewAttachmentId: "att-1", overlay: { kind: "workspace", selected: "inbox/a.md" } }),
      true,
    ),
  ).toBe("/?s=abc&o=workspace&a=att-1");
  expect(viewFromUrl(at("?s=abc&p=secret.txt&w=inbox/a.md&a=att-1"), true)).toEqual({
    selectedId: "abc",
    previewRelpath: null,
    previewAttachmentId: "att-1",
    overlay: { kind: "none" },
  });
  expect(overlayFromUrl(at("?o=workspace&w=inbox/a.md"), true)).toEqual({
    kind: "workspace",
    selected: null,
  });
  expect(attachmentFromUrl(at("?s=abc&a=att-1"))).toBe("att-1");
  expect(attachmentFromUrl(at("?s=abc&p=secret.txt"))).toBeNull();
});
