/**
 * The preview's half of annotating, mounted in happy-dom: what survives a snapshot, what counts as
 * unsaved, what a draft is saved against, how many drafts one send carries, going to an annotation
 * that already has focus, and where Escape goes. Monaco cannot run here, so the source view gets a
 * stand-in editor through the preview's `loadMonaco` seam.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { flushSync } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { Annotation, CreateAnnotationRequest, HtmlElementAnchor } from "@real-bot/protocol";

mock.module("monaco-editor-css", () => ({}));
mock.module("monaco-editor/esm/vs/platform/hover/browser/hover.css", () => ({}));
mock.module("monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css", () => ({}));
const { default: ArtifactPreview } = await import("./ArtifactPreview.svelte");
import { rememberBlobEtag, rememberBlobOriginalSize } from "../api.ts";
import { copyFor } from "../copy.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, fill, press, render } from "../test-render.ts";

const t = copyFor("zh");
const TARGET = { messageId: "m1", sessionId: "s1", turnId: null, botId: "bot-1" };
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await wait();
    flushSync();
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function blobOf(body: BlobPart, type: string, sha = SHA_A): Blob {
  const blob = new Blob([body], { type });
  rememberBlobEtag(blob, `"${sha}"`);
  return blob;
}

function row(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    status: "open",
    relpath: "docs/weekly.md",
    anchor_kind: "text_range",
    anchor: { start_line: 3, start_col: 9, end_line: 3, end_col: 13, quote: "登录改版", prefix: "", suffix: "", view: "rendered" },
    content_sha256: SHA_A,
    target_message_id: "m1",
    target_session_id: "s1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "s1",
    message_id: "m2",
    body: "改版范围写清楚",
    crop_mime: null,
    resolved_by: null,
    resolved_note: null,
    resolved_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    stale: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// A stand-in for Monaco: enough of the editor for the pane to type, select, annotate and reveal.
// ---------------------------------------------------------------------------------------------

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
type FakeEditor = ReturnType<typeof fakeEditor>;

function fakeEditor(initial: string, fold: (text: string) => string = (text) => text) {
  let value = fold(initial);
  const mouse: Array<(ev: { target: { type: number; position: { lineNumber: number; column: number } | null } }) => void> = [];
  let selection: Range | null = null;
  const onContent: Array<() => void> = [];
  const onSelection: Array<() => void> = [];
  const widgets: Array<{ getDomNode: () => HTMLElement }> = [];
  const reveals: Range[] = [];
  const noop = { dispose() {} };
  return {
    reveals,
    widgets,
    disposed: false,
    /** What a person typing does: the buffer changes, and the editor says so. */
    type(next: string) {
      value = next;
      for (const cb of onContent) cb();
      flushSync();
    },
    /** A mouse press where Monaco would report `type` (a MouseTargetType) at that line and column. */
    press(type: number, lineNumber: number, column: number) {
      for (const cb of mouse) cb({ target: { type, position: { lineNumber, column } } });
      flushSync();
    },
    select(range: Range) {
      selection = range;
      for (const cb of onSelection) cb();
      flushSync();
    },
    getValue: () => value,
    setValue(next: string) {
      value = fold(next);
      for (const cb of onContent) cb();
    },
    getSelection: () => selection,
    onDidChangeModelContent(cb: () => void) {
      onContent.push(cb);
      return noop;
    },
    onDidChangeCursorSelection(cb: () => void) {
      onSelection.push(cb);
      return noop;
    },
    onMouseDown(cb: (typeof mouse)[number]) {
      mouse.push(cb);
      return noop;
    },
    /** Decoration collections, whose ranges a test can move the way Monaco moves them on an edit. */
    collections: [] as Array<{ items: Array<{ range: Range }> }>,
    createDecorationsCollection() {
      const collection = { items: [] as Array<{ range: Range }> };
      this.collections.push(collection);
      return {
        set(items: Array<{ range: Range }>) {
          collection.items = items.map((item) => ({ range: { ...item.range } }));
        },
        clear() {
          collection.items = [];
        },
        getRanges: () => collection.items.map((item) => item.range),
      };
    },
    addContentWidget(widget: { getDomNode: () => HTMLElement }) {
      widgets.push(widget);
    },
    removeContentWidget() {},
    layoutContentWidget() {},
    revealRangeInCenterIfOutsideViewport(range: Range) {
      reveals.push(range);
    },
    getModel: () => ({}),
    layout() {},
    updateOptions() {},
    focus() {},
    getAction: () => null,
    trigger() {},
    dispose() {
      this.disposed = true;
    },
  };
}

function fakeMonaco(opts: { foldLineEndings?: boolean } = {}) {
  const editors: FakeEditor[] = [];
  const monaco = {
    editor: {
      create(_el: HTMLElement, init: { value: string }) {
        // Monaco folds a buffer's mixed or lone-CR line endings when it builds or refills the model.
        const editor = fakeEditor(init.value, opts.foldLineEndings ? (text) => text.replace(/\r\n?/g, "\n") : undefined);
        editors.push(editor);
        return editor;
      },
      setTheme() {},
      setModelLanguage() {},
      createModel: (value: string) => ({
        getValue: () => (opts.foldLineEndings ? value.replace(/\r\n?/g, "\n") : value),
        dispose() {},
      }),
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2, GUTTER_LINE_NUMBERS: 3, CONTENT_TEXT: 6 },
    },
  };
  return { editors, loadMonaco: async () => monaco as never };
}

type Open = {
  relpath: string;
  body: BlobPart;
  type: string;
  annotations?: Annotation[];
  annotationFocusId?: () => string | null;
  putWorkspaceFile?: (path: string, value: string, etag: string | null) => Promise<string>;
  onCreateAnnotation?: (input: CreateAnnotationRequest) => Promise<null>;
  onSendAnnotations?: (sessionId: string, summary: string, ids: string[]) => Promise<null>;
  loadMonaco?: () => Promise<never>;
  onClose?: () => void;
};

function open(opts: Open) {
  const props = {
    attachment: null,
    relpath: opts.relpath,
    siblings: [],
    api: {
      kind: "local",
      getWorkspaceFileBlob: async () => blobOf(opts.body, opts.type),
      putWorkspaceFile: opts.putWorkspaceFile ?? (async () => `"${SHA_B}"`),
      taskArtifacts: async () => ({ id: "task-1", dir: "", title: "", closed_at: null, items: [] }),
    } as never,
    // A local workspace, the way the desktop app opens one.
    workspacePath: "/w",
    t,
    onClose: opts.onClose ?? (() => {}),
    onSelect: () => {},
    mode: "cited" as const,
    target: TARGET,
    annotations: opts.annotations ?? [],
    get annotationFocusId() {
      return opts.annotationFocusId?.() ?? null;
    },
    viewedSessionId: "s1",
    onLoadAnnotations: () => {},
    onCreateAnnotation: opts.onCreateAnnotation ?? (async () => null),
    onPatchAnnotation: async () => null,
    onDeleteAnnotation: async () => null,
    onSendAnnotations: opts.onSendAnnotations ?? (async () => null),
    loadMonaco: opts.loadMonaco,
  };
  const view = render(ArtifactPreview as never, props as never);
  cleanups.push(view.close);
  return view;
}

const modeToggle = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-annotation-mode]");
const hint = (host: HTMLElement) => host.querySelector("[data-annotation-hint]")?.getAttribute("data-annotation-hint") ?? null;

// ---------------------------------------------------------------------------------------------
// A snapshot is not a new file
// ---------------------------------------------------------------------------------------------

test("a snapshot that hands the same path over again keeps annotate mode; another file lets go of it", async () => {
  // The shell passes the path off an object it rebuilds on every snapshot: the getter re-reads it.
  const shell = new SvelteMap<string, string>([["path", "shots/cover.png"]]);
  const props = {
    attachment: null,
    get relpath() {
      shell.get("tick");
      return shell.get("path")!;
    },
    get target() {
      shell.get("tick");
      return TARGET;
    },
    siblings: [],
    api: { kind: "local", getWorkspaceFileBlob: async () => blobOf(PNG, "image/png"), taskArtifacts: async () => ({ dir: "", items: [] }) } as never,
    // A local workspace, the way the desktop app opens one.
    workspacePath: "/w",
    t,
    onClose() {},
    onSelect() {},
    annotations: [],
    viewedSessionId: "s1",
    onLoadAnnotations() {},
  };
  const view = render(ArtifactPreview as never, props as never);
  cleanups.push(view.close);
  await settle();
  click(modeToggle(view.host));
  expect(modeToggle(view.host)?.getAttribute("aria-pressed")).toBe("true");
  // Any event in any session: the object is new, the path is not.
  shell.set("tick", "1");
  flushSync();
  expect(modeToggle(view.host)?.getAttribute("aria-pressed")).toBe("true");
  shell.set("path", "shots/other.png");
  flushSync();
  await settle();
  expect(modeToggle(view.host)?.getAttribute("aria-pressed")).toBe("false");
});

test("while the next file loads, or after it failed to, Save writes nothing from the last file's buffer", async () => {
  const { loadMonaco } = fakeMonaco();
  const shell = new SvelteMap<string, string>([["path", "src/a.ts"]]);
  const puts: Array<[string, string, string | null]> = [];
  let release: (() => void) | null = null;
  let failNext = false;
  const props = {
    attachment: null,
    get relpath() {
      return shell.get("path")!;
    },
    target: TARGET,
    siblings: [],
    api: {
      kind: "local",
      getWorkspaceFileBlob: async (path: string) => {
        if (path === "src/a.ts") return blobOf("const a = 1;\n", "text/plain");
        if (failNext) throw new Error("gone");
        await new Promise<void>((resolve) => (release = resolve));
        return blobOf("const b = 2;\n", "text/plain", SHA_B);
      },
      putWorkspaceFile: async (path: string, value: string, etag: string | null) => {
        puts.push([path, value, etag]);
        return `"${SHA_B}"`;
      },
      taskArtifacts: async () => ({ dir: "", items: [] }),
    } as never,
    workspacePath: "/w",
    t,
    onClose() {},
    onSelect() {},
    annotations: [],
    viewedSessionId: "s1",
    onLoadAnnotations() {},
    loadMonaco,
  };
  const view = render(ArtifactPreview as never, props as never);
  cleanups.push(view.close);
  await settle();
  const pane = view.host.querySelector("aside")!;
  const save = () => {
    pane.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }));
    flushSync();
  };
  // The shortcut does save the file on screen.
  save();
  await settle();
  expect(puts.map(([path]) => path)).toEqual(["src/a.ts"]);
  puts.length = 0;
  // b.ts is on its way: nothing is written to it from a.ts's buffer.
  shell.set("path", "src/b.ts");
  flushSync();
  await settle();
  save();
  await settle();
  expect(puts).toEqual([]);
  release?.();
  await settle();
  // And a file that failed to load takes nothing either.
  failNext = true;
  shell.set("path", "src/c.ts");
  flushSync();
  await settle();
  save();
  await settle();
  expect(puts).toEqual([]);
});

test("annotate mode cannot be switched on while the image is still loading", async () => {
  let release: (() => void) | null = null;
  const props = {
    attachment: null,
    relpath: "shots/cover.png",
    target: TARGET,
    siblings: [],
    api: {
      kind: "local",
      getWorkspaceFileBlob: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return blobOf(PNG, "image/png");
      },
      taskArtifacts: async () => ({ dir: "", items: [] }),
    } as never,
    workspacePath: "/w",
    t,
    onClose() {},
    onSelect() {},
    annotations: [],
    viewedSessionId: "s1",
    onLoadAnnotations() {},
  };
  const view = render(ArtifactPreview as never, props as never);
  cleanups.push(view.close);
  await settle();
  expect(modeToggle(view.host)?.disabled).toBe(true);
  release?.();
  await settle();
  expect(modeToggle(view.host)?.disabled).toBe(false);
});

test("annotate mode cannot be switched on while the picture is still loading", async () => {
  let release: (() => void) | null = null;
  const props = {
    attachment: null,
    relpath: "shots/cover.png",
    target: TARGET,
    siblings: [],
    api: {
      kind: "local",
      getWorkspaceFileBlob: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return blobOf(PNG, "image/png");
      },
      taskArtifacts: async () => ({ dir: "", items: [] }),
    } as never,
    workspacePath: "/w",
    t,
    onClose() {},
    onSelect() {},
    annotations: [],
    viewedSessionId: "s1",
    onLoadAnnotations() {},
  };
  const view = render(ArtifactPreview as never, props as never);
  cleanups.push(view.close);
  await settle();
  expect(modeToggle(view.host)?.disabled).toBe(true);
  release?.();
  await settle();
  expect(modeToggle(view.host)?.disabled).toBe(false);
});

test("a clip that plays from pieces says why it takes no time points here", async () => {
  const props = {
    attachment: null,
    relpath: "media/clip.mp4",
    target: TARGET,
    siblings: [],
    api: {
      kind: "remote",
      openMediaSource: async () => ({ url: "blob:clip", dispose() {} }),
      getWorkspaceFileBlob: async () => {
        throw new Error("not used");
      },
      taskArtifacts: async () => ({ dir: "", items: [] }),
    } as never,
    workspacePath: null,
    t,
    onClose() {},
    onSelect() {},
    annotations: [],
    viewedSessionId: "s1",
    onLoadAnnotations() {},
  };
  const view = render(ArtifactPreview as never, props as never);
  cleanups.push(view.close);
  await settle();
  expect(hint(view.host)).toBe("streamed");
  expect(view.host.querySelector("[data-annotation-hint]")?.textContent?.trim()).toBe(t.stream.annotationStreamedHint);
});

// ---------------------------------------------------------------------------------------------
// Unsaved is measured against the disk
// ---------------------------------------------------------------------------------------------

test("an edit carried Source → Rendered → Source is still unsaved: no annotating, Save on, discard goes back to disk", async () => {
  const DISK = "# 计划\n\n第一段\n";
  const EDITED = "# 计划\n\n第一段，改过\n";
  const { editors, loadMonaco } = fakeMonaco();
  let closed = 0;
  const { host } = open({ relpath: "docs/plan.md", body: DISK, type: "text/markdown", loadMonaco, onClose: () => (closed += 1) });
  await settle();
  click(buttonByText(host, t.stream.artifactSource));
  await settle();
  expect(editors).toHaveLength(1);
  expect(hint(host)).toBe("");
  editors[0]!.type(EDITED);
  expect(hint(host)).toBe("dirty");

  click(buttonByText(host, t.stream.artifactRendered));
  await settle();
  // The rendered view shows the unsaved text, and takes no annotation on it.
  expect(host.querySelector(".md-annotator.is-choosing")).toBeNull();

  click(buttonByText(host, t.stream.artifactSource));
  await settle();
  expect(editors).toHaveLength(2);
  expect(editors[1]!.getValue()).toBe(EDITED);
  expect(hint(host)).toBe("dirty");
  // Unsaved, so ⌘S has something to write: the pane marks its name dirty (the toolbar's Save is gone).
  expect(host.querySelector(".artifact-pane-head h2.is-dirty")).not.toBeNull();

  // Closing asks; discarding goes back to what is on disk, not to the buffer carried over.
  click(host.querySelector(".artifact-back"));
  click(buttonByText(document.body, t.stream.artifactDiscard));
  expect(closed).toBe(1);
  expect(editors[1]!.getValue()).toBe(DISK);
});

test("closing from the rendered view with an edit carried over from Source saves that edit", async () => {
  const DISK = "# 计划\n\n第一段\n";
  const EDITED = "# 计划\n\n第一段，改过\n";
  const { editors, loadMonaco } = fakeMonaco();
  const puts: string[] = [];
  let closed = 0;
  const { host } = open({
    relpath: "docs/plan.md",
    body: DISK,
    type: "text/markdown",
    loadMonaco,
    onClose: () => (closed += 1),
    putWorkspaceFile: async (_path, value) => {
      puts.push(value);
      return `"${SHA_B}"`;
    },
  });
  await settle();
  click(buttonByText(host, t.stream.artifactSource));
  await settle();
  editors[0]!.type(EDITED);
  click(buttonByText(host, t.stream.artifactRendered));
  await settle();

  click(host.querySelector(".artifact-back"));
  click(document.body.querySelector(".artifact-dirty-save"));
  await settle();
  expect(puts).toEqual([EDITED]);
  expect(closed).toBe(1);
});

test("a file whose line endings Monaco folds is not unsaved after Source → Rendered with no edit", async () => {
  const { loadMonaco } = fakeMonaco({ foldLineEndings: true });
  let closed = 0;
  const { host } = open({ relpath: "docs/mixed.md", body: "# 计划\r\n\n第一段\r\n", type: "text/markdown", loadMonaco, onClose: () => (closed += 1) });
  await settle();
  click(buttonByText(host, t.stream.artifactSource));
  await settle();
  expect(hint(host)).toBe("");
  click(buttonByText(host, t.stream.artifactRendered));
  await settle();
  // Nothing to save: closing does not ask.
  click(host.querySelector(".artifact-back"));
  await settle();
  expect(document.body.querySelector(".artifact-dirty-save")).toBeNull();
  expect(closed).toBe(1);
});

test("in the code view only the mark in the margin opens an annotation; a click in its text is just a click", async () => {
  const { editors, loadMonaco } = fakeMonaco();
  const types = { GUTTER_GLYPH_MARGIN: 2, CONTENT_TEXT: 6 };
  const annotated = row({
    id: "code-1",
    relpath: "src/pick.ts",
    anchor: { start_line: 2, start_col: 1, end_line: 2, end_col: 9, quote: "line two", prefix: "line one\n", suffix: "\nline three" },
  });
  const { host } = open({ relpath: "src/pick.ts", body: "line one\nline two\nline three\n", type: "text/plain", loadMonaco, annotations: [annotated] });
  await settle();
  const editor = editors[0]!;
  const list = () => host.querySelector("[data-annotation-list]");
  const before = editor.reveals.length;
  editor.press(types.CONTENT_TEXT, 2, 4);
  await settle();
  expect(editor.reveals.length).toBe(before);
  expect(list()).toBeNull();
  // The mark opens the list on it and goes there once; pressing it again does not scroll again.
  editor.press(types.GUTTER_GLYPH_MARGIN, 2, 1);
  await settle();
  expect(list()).not.toBeNull();
  const once = editor.reveals.length;
  expect(once).toBe(before + 1);
  editor.press(types.GUTTER_GLYPH_MARGIN, 2, 1);
  await settle();
  expect(editor.reveals.length).toBe(once);
});

test("the margin mark of a range that starts mid-line opens it: Monaco reports margin hits at column 1", async () => {
  const { editors, loadMonaco } = fakeMonaco();
  const midLine = row({
    id: "code-mid",
    relpath: "src/pick.ts",
    anchor: { start_line: 3, start_col: 6, end_line: 3, end_col: 11, quote: "three", prefix: "line ", suffix: "\n" },
  });
  const { host } = open({ relpath: "src/pick.ts", body: "line one\nline two\nline three\n", type: "text/plain", loadMonaco, annotations: [midLine] });
  await settle();
  editors[0]!.press(2, 3, 1);
  await settle();
  expect(host.querySelector("[data-annotation-list]")).not.toBeNull();
  expect(host.querySelector('[data-annotation-list] [data-annotation-id="code-mid"]')).not.toBeNull();
});

test("an edit carried to Rendered and then undone by hand in Source is the disk again: nothing to save", async () => {
  const DISK = "# 计划\n\n第一段\n";
  const EDITED = "# 计划\n\n第一段，改过\n";
  const { editors, loadMonaco } = fakeMonaco();
  let closed = 0;
  const { host } = open({ relpath: "docs/plan.md", body: DISK, type: "text/markdown", loadMonaco, onClose: () => (closed += 1) });
  await settle();
  click(buttonByText(host, t.stream.artifactSource));
  await settle();
  editors[0]!.type(EDITED);
  click(buttonByText(host, t.stream.artifactRendered));
  await settle();
  click(buttonByText(host, t.stream.artifactSource));
  await settle();
  editors[1]!.type(DISK);
  expect(hint(host)).toBe("");
  click(buttonByText(host, t.stream.artifactRendered));
  await settle();
  click(host.querySelector(".artifact-back"));
  await settle();
  expect(document.body.querySelector(".artifact-dirty-save")).toBeNull();
  expect(closed).toBe(1);
});

test("after Discard the buffer is measured against what the model holds, line endings folded", async () => {
  const { editors, loadMonaco } = fakeMonaco({ foldLineEndings: true });
  const DISK = "# 计划\r\n\n第一段\r\n";
  const { host } = open({ relpath: "docs/mixed.md", body: DISK, type: "text/markdown", loadMonaco, onClose: () => {} });
  await settle();
  click(buttonByText(host, t.stream.artifactSource));
  await settle();
  const editor = editors[0]!;
  editor.type(`${editor.getValue()}多一行\n`);
  expect(hint(host)).toBe("dirty");
  click(host.querySelector(".artifact-back"));
  click(buttonByText(document.body, t.stream.artifactDiscard));
  await settle();
  // The pane stayed (the shell decides); a no-op edit on the reverted buffer is still clean.
  editor.type(editor.getValue());
  expect(hint(host)).toBe("");
});

test("after lines are added above an annotation, its margin mark still opens it on the line it moved to", async () => {
  const { editors, loadMonaco } = fakeMonaco();
  const annotated = row({
    id: "moves",
    relpath: "src/pick.ts",
    anchor: { start_line: 2, start_col: 1, end_line: 2, end_col: 9, quote: "line two", prefix: "line one\n", suffix: "\nline three" },
  });
  const { host } = open({ relpath: "src/pick.ts", body: "line one\nline two\nline three\n", type: "text/plain", loadMonaco, annotations: [annotated] });
  await settle();
  const editor = editors[0]!;
  // Two lines typed above: Monaco carries the marks down with the text.
  const marks = editor.collections[0]!;
  for (const item of marks.items) {
    item.range.startLineNumber += 2;
    item.range.endLineNumber += 2;
  }
  editor.press(2, 2, 1);
  await settle();
  expect(host.querySelector("[data-annotation-list]")).toBeNull();
  editor.press(2, 4, 1);
  await settle();
  expect(host.querySelector('[data-annotation-list] [data-annotation-id="moves"]')).not.toBeNull();
  // And it goes to the highlight where it is now, not back to where it was drawn.
  expect(editor.reveals.at(-1)?.startLineNumber).toBe(4);
});

test("a carried edit undone by hand is clean even when Monaco folds the file's line endings", async () => {
  const { editors, loadMonaco } = fakeMonaco({ foldLineEndings: true });
  const DISK = "# 计划\r\n\n第一段\r\n";
  const { host } = open({ relpath: "docs/mixed.md", body: DISK, type: "text/markdown", loadMonaco });
  await settle();
  click(buttonByText(host, t.stream.artifactSource));
  await settle();
  const folded = editors[0]!.getValue();
  editors[0]!.type(`${folded}多一行\n`);
  click(buttonByText(host, t.stream.artifactRendered));
  await settle();
  click(buttonByText(host, t.stream.artifactSource));
  await settle();
  expect(hint(host)).toBe("dirty");
  editors[1]!.type(folded);
  expect(hint(host)).toBe("");
});

// ---------------------------------------------------------------------------------------------
// A draft is saved against the file its spot was picked on
// ---------------------------------------------------------------------------------------------

const TEXT = "line one\nline two\nline three\n";

async function pickLineTwo(host: HTMLElement, editor: FakeEditor): Promise<void> {
  editor.select({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 9 });
  const button = editor.widgets.at(-1)!.getDomNode();
  button.click();
  flushSync();
  expect(host.querySelector("[data-annotation-composer]")).not.toBeNull();
}

function writeRemark(host: HTMLElement, body: string): void {
  fill(host.querySelector("[data-annotation-composer] textarea"), body);
  click(buttonByText(host.querySelector("[data-annotation-composer]") as HTMLElement, t.stream.annotationSaveDraft));
}

test("a draft is stored with the hash, path and message of the file its spot was picked on", async () => {
  const { editors, loadMonaco } = fakeMonaco();
  const created: CreateAnnotationRequest[] = [];
  const { host } = open({
    relpath: "notes/plan.txt",
    body: TEXT,
    type: "text/plain",
    loadMonaco,
    onCreateAnnotation: async (input) => {
      created.push(input);
      return null;
    },
  });
  await settle();
  await pickLineTwo(host, editors[0]!);
  writeRemark(host, "这一行删掉");
  await settle();
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ target_message_id: "m1", relpath: "notes/plan.txt", anchor_kind: "text_range", content_sha256: SHA_A, body: "这一行删掉" });
  expect(created[0]!.anchor).toMatchObject({ start_line: 2, end_line: 2, quote: "line two" });
  expect(host.querySelector("[data-annotation-composer]")).toBeNull();
});

test("a file saved after the spot was picked refuses the draft instead of storing old lines with the new hash", async () => {
  const { editors, loadMonaco } = fakeMonaco();
  const created: CreateAnnotationRequest[] = [];
  const puts: string[] = [];
  const { host } = open({
    relpath: "notes/plan.txt",
    body: TEXT,
    type: "text/plain",
    loadMonaco,
    putWorkspaceFile: async (_path, value) => {
      puts.push(value);
      return `"${SHA_B}"`;
    },
    onCreateAnnotation: async (input) => {
      created.push(input);
      return null;
    },
  });
  await settle();
  await pickLineTwo(host, editors[0]!);
  // Five lines go in above it and the file is saved with ⌘S while the composer is open.
  editors[0]!.type(`a\nb\nc\nd\ne\n${TEXT}`);
  press(host.querySelector(".artifact-pane"), "s", { metaKey: true });
  await settle();
  expect(puts).toHaveLength(1);
  writeRemark(host, "这一行删掉");
  await settle();
  expect(created).toEqual([]);
  expect(host.querySelector(".annot-composer-error")?.textContent).toBe(t.stream.annotationFileChanged);
  // What was typed stays for after the spot is picked again.
  expect((host.querySelector("[data-annotation-composer] textarea") as HTMLTextAreaElement).value).toBe("这一行删掉");
});

test("an unsaved edit made while the composer is open refuses the draft too", async () => {
  const { editors, loadMonaco } = fakeMonaco();
  const created: CreateAnnotationRequest[] = [];
  const { host } = open({
    relpath: "notes/plan.txt",
    body: TEXT,
    type: "text/plain",
    loadMonaco,
    onCreateAnnotation: async (input) => {
      created.push(input);
      return null;
    },
  });
  await settle();
  await pickLineTwo(host, editors[0]!);
  editors[0]!.type(`first\n${TEXT}`);
  writeRemark(host, "这一行删掉");
  await settle();
  expect(created).toEqual([]);
  expect(host.querySelector(".annot-composer-error")?.textContent).toBe(t.stream.annotationFileChanged);
});

// ---------------------------------------------------------------------------------------------
// One send carries at most the daemon's batch
// ---------------------------------------------------------------------------------------------

test("more drafts than one batch holds: the oldest 50 are sent, and the bar says so", async () => {
  const drafts = Array.from({ length: 51 }, (_, i) =>
    row({
      id: `d${String(i).padStart(2, "0")}`,
      status: "draft",
      message_id: null,
      relpath: i % 2 ? "shots/cover.png" : "docs/weekly.md",
      created_at: `2026-09-23T00:${String(i).padStart(2, "0")}:00.000Z`,
    }),
  ).reverse();
  const sent: Array<{ summary: string; ids: string[] }> = [];
  const { host } = open({
    relpath: "shots/cover.png",
    body: PNG,
    type: "image/png",
    annotations: drafts,
    onSendAnnotations: async (_sessionId, summary, ids) => {
      sent.push({ summary, ids });
      return null;
    },
  });
  await settle();
  expect(host.querySelector("[data-annotation-send-cap]")?.textContent).toBe("一次最多发 50 条，这次先发最早的 50 条");
  click(host.querySelector(".annot-send-btn"));
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.ids).toEqual(Array.from({ length: 50 }, (_, i) => `d${String(i).padStart(2, "0")}`));
});

test("a failed send keeps the summary that was typed", async () => {
  const { host } = open({
    relpath: "shots/cover.png",
    body: PNG,
    type: "image/png",
    annotations: [row({ id: "d1", status: "draft", message_id: null })],
    onSendAnnotations: async () => ({ status: 409 }) as never,
  });
  await settle();
  fill(host.querySelector(".annot-send-input"), "都改一下");
  click(host.querySelector(".annot-send-btn"));
  await settle();
  expect(host.querySelector(".annot-send-error")?.textContent).toBe(t.stream.annotationSendFailed);
  expect((host.querySelector(".annot-send-input") as HTMLInputElement).value).toBe("都改一下");
});

// ---------------------------------------------------------------------------------------------
// Going to the annotation that already has focus
// ---------------------------------------------------------------------------------------------

const WEEKLY = ["# 周报", "", "本周完成了 **登录改版**，见 [设计稿](https://example.com/d)。", "", "- 下周：接入支付", "- 风险：人手不足"].join("\n");

test("定位 on the row that already has focus, or a card asking for it again, scrolls the rendered view back to it", async () => {
  const scrolled: string[] = [];
  const proto = Element.prototype as { scrollIntoView?: (arg?: unknown) => void };
  const original = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element) {
    if (this.closest(".md-annot-body")) scrolled.push(this.textContent ?? "");
  };
  cleanups.push(() => {
    proto.scrollIntoView = original;
  });
  const focus = reactive({ id: "a1" as string | null });
  const { host } = open({
    relpath: "docs/weekly.md",
    body: WEEKLY,
    type: "text/markdown",
    annotations: [
      row({ id: "a1" }),
      row({ id: "a2", anchor: { start_line: 6, start_col: 3, end_line: 6, end_col: 5, quote: "风险", prefix: "", suffix: "" } }),
    ],
    annotationFocusId: () => focus.id,
  });
  for (let i = 0; i < 10; i++) await settle(1).then(() => wait(20));
  flushSync();
  expect(scrolled).toHaveLength(1);
  const goTo = (id: string) => host.querySelector(`.annot-item[data-annotation-id="${id}"] .annot-item-main`);
  click(goTo("a1"));
  await settle();
  expect(scrolled).toHaveLength(2);
  expect(scrolled[1]).toContain("登录改版");
  click(goTo("a2"));
  await settle();
  click(goTo("a2"));
  await settle();
  expect(scrolled).toHaveLength(4);
  // A transcript card for a1 while a1 is what the shell last asked for: the shell lets go, then asks.
  click(goTo("a1"));
  await settle();
  const before = scrolled.length;
  focus.id = null;
  flushSync();
  focus.id = "a1";
  flushSync();
  await settle();
  expect(scrolled).toHaveLength(before + 1);
});

test("in the source view each 定位 reveals once, the focused row included", async () => {
  const { editors, loadMonaco } = fakeMonaco();
  const { host } = open({
    relpath: "notes/plan.txt",
    body: TEXT,
    type: "text/plain",
    loadMonaco,
    annotations: [row({ id: "t1", relpath: "notes/plan.txt", anchor: { start_line: 2, start_col: 1, end_line: 2, end_col: 9, quote: "line two", prefix: "", suffix: "" } })],
    annotationFocusId: () => "t1",
  });
  await settle();
  const reveals = editors[0]!.reveals;
  expect(reveals).toHaveLength(1);
  const goTo = host.querySelector('.annot-item[data-annotation-id="t1"] .annot-item-main');
  click(goTo);
  await settle();
  click(goTo);
  await settle();
  expect(reveals).toHaveLength(3);
});

// ---------------------------------------------------------------------------------------------
// Escape: the pending spot, then annotate mode, then the pane
// ---------------------------------------------------------------------------------------------

function escape(target: EventTarget = document.body): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  flushSync();
  return ev;
}

function windowEscapes(): () => number {
  let heard = 0;
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && !ev.defaultPrevented) heard += 1;
  };
  window.addEventListener("keydown", onKey);
  cleanups.push(() => window.removeEventListener("keydown", onKey));
  return () => heard;
}

test("Escape in image annotate mode with nothing pending leaves the mode; the next one is the pane's", async () => {
  const heard = windowEscapes();
  const { host } = open({ relpath: "shots/cover.png", body: PNG, type: "image/png" });
  await settle();
  click(modeToggle(host));
  expect(modeToggle(host)?.getAttribute("aria-pressed")).toBe("true");
  expect(escape(modeToggle(host)!).defaultPrevented).toBe(true);
  expect(modeToggle(host)?.getAttribute("aria-pressed")).toBe("false");
  expect(modeToggle(host)?.textContent).toBe(t.stream.annotationMode);
  expect(heard()).toBe(0);
  expect(escape().defaultPrevented).toBe(false);
  expect(heard()).toBe(1);
});

test("a remote picture shown as the Mac's copy fetches the original before annotate mode: a box names the file", async () => {
  const asked: Array<{ size?: string } | undefined> = [];
  const copy = blobOf(PNG, "image/jpeg", SHA_B);
  rememberBlobOriginalSize(copy, 3_727_854);
  const original = blobOf(PNG, "image/png", SHA_A);
  const view = render(ArtifactPreview as never, {
    attachment: null,
    relpath: "shots/cover.png",
    siblings: [],
    api: {
      kind: "remote",
      getWorkspaceFileBlob: async (_path: string, _progress: unknown, options?: { size?: string }) => {
        asked.push(options);
        return options?.size ? copy : original;
      },
    } as never,
    workspacePath: null,
    t,
    onClose: () => {},
    onSelect: () => {},
    mode: "cited",
    target: TARGET,
    annotations: [],
    viewedSessionId: "s1",
    onLoadAnnotations: () => {},
  } as never);
  cleanups.push(view.close);
  await settle();
  expect(asked.map((options) => options?.size ?? null)).toEqual(["preview"]);
  expect(view.host.querySelector(".artifact-original-toggle")).not.toBeNull();
  click(modeToggle(view.host));
  await settle();
  // The copy's size and hash are not the file's: the original came first, and only then the mode.
  expect(asked.map((options) => options?.size ?? null)).toEqual(["preview", null]);
  expect(view.host.querySelector(".artifact-original-toggle")).toBeNull();
  expect(modeToggle(view.host)?.getAttribute("aria-pressed")).toBe("true");
});

// ---------------------------------------------------------------------------------------------
// The HTML view: Esc leaves, and a pending element can still be moved
// ---------------------------------------------------------------------------------------------

const HTML = "<!DOCTYPE html><html><head></head><body><main><h1>Title</h1><p>one</p><p>第二段</p></main></body></html>";
const blobs = new Map<string, Blob>();
let realCreate: typeof URL.createObjectURL;
let realRevoke: typeof URL.revokeObjectURL;
const happy = (globalThis as unknown as { happyDOM?: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM;
let childFrames = false;

beforeEach(() => {
  if (happy) {
    childFrames = happy.settings.navigation.disableChildFrameNavigation;
    happy.settings.navigation.disableChildFrameNavigation = true;
  }
  blobs.clear();
  realCreate = URL.createObjectURL;
  realRevoke = URL.revokeObjectURL;
  let n = 0;
  URL.createObjectURL = (blob: Blob) => {
    n += 1;
    const url = `blob:preview-test/${n}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
});

afterEach(() => {
  if (happy) happy.settings.navigation.disableChildFrameNavigation = childFrames;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

function htmlPage(host: HTMLElement) {
  const frame = () => host.querySelector("iframe") as HTMLIFrameElement;
  const source = async () => blobs.get(frame().getAttribute("src")!)!.text();
  const channelOf = async () => (await source()).match(/"channel":"([0-9a-f]{32})"/)?.[1] ?? null;
  const say = (data: unknown, ports: MessagePort[] = []) => {
    window.dispatchEvent(new MessageEvent("message", { data, source: frame().contentWindow as Window, ports }));
    flushSync();
  };
  return { frame, source, channelOf, say };
}

const anchorOf = (over: Partial<HtmlElementAnchor> = {}): HtmlElementAnchor => ({
  selector: "body > main > p:nth-of-type(2)",
  tag: "p",
  text: "第二段",
  outer_html: "<p>第二段</p>",
  rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 },
  ...over,
});

test("Esc in the HTML view leaves annotate mode, from the messenger or from the page, as the bar says", async () => {
  const heard = windowEscapes();
  const { host } = open({ relpath: "site/index.html", body: HTML, type: "text/html" });
  await settle();
  const page = htmlPage(host);
  click(modeToggle(host));
  expect(host.querySelector("[data-html-annot-bar]")).not.toBeNull();
  expect(host.querySelector(".html-annot-keys")?.textContent).toBe(t.stream.annotHtml.keysHint);
  expect(escape().defaultPrevented).toBe(true);
  expect(modeToggle(host)?.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector("[data-html-annot-bar]")).toBeNull();
  expect(await page.source()).not.toContain("rb-annot-layer");
  expect(heard()).toBe(0);

  // In the page the picker hears Esc, leaves, and says so: the page comes back without it.
  click(modeToggle(host));
  const channel = await page.channelOf();
  expect(channel).toMatch(/^[0-9a-f]{32}$/);
  page.say({ channel, type: "cancel" });
  expect(modeToggle(host)?.getAttribute("aria-pressed")).toBe("false");
  expect(await page.source()).not.toContain("rb-annot-layer");
});

test("a numbered chip in the HTML bar goes to its element every time it is clicked", async () => {
  const onPage = row({ id: "html-1", relpath: "site/index.html", anchor_kind: "html_element", anchor: anchorOf() });
  const { host } = open({ relpath: "site/index.html", body: HTML, type: "text/html", annotations: [onPage] });
  await settle();
  const page = htmlPage(host);
  click(modeToggle(host));
  const channel = (await page.channelOf())!;
  const { port1, port2 } = new MessageChannel();
  cleanups.push(() => port1.close());
  const got: Array<Record<string, unknown>> = [];
  port1.onmessage = (ev) => got.push(ev.data as Record<string, unknown>);
  page.say({ channel, type: "ready" }, [port2]);
  await settle();
  const chip = host.querySelector<HTMLButtonElement>('.html-annot-chip[data-annotation-id="html-1"]')!;
  click(chip);
  await settle();
  click(chip);
  await settle();
  expect(got.filter((m) => m.type === "focus")).toHaveLength(2);
});

test("the composer for a pending element sits under the picker's bar, not over 外层 / 内层", async () => {
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute("data-annotator-bar")) return { top: 100, bottom: 140, left: 0, right: 400, width: 400, height: 40, x: 0, y: 100, toJSON() {} } as DOMRect;
    if (this.classList.contains("artifact-pane-body")) return { top: 90, bottom: 600, left: 0, right: 400, width: 400, height: 510, x: 0, y: 90, toJSON() {} } as DOMRect;
    return realRect.call(this);
  };
  cleanups.push(() => (HTMLElement.prototype.getBoundingClientRect = realRect));
  const { host } = open({ relpath: "site/index.html", body: HTML, type: "text/html" });
  await settle();
  const page = htmlPage(host);
  click(modeToggle(host));
  const channel = (await page.channelOf())!;
  const { port1, port2 } = new MessageChannel();
  cleanups.push(() => port1.close());
  page.say({ channel, type: "ready" }, [port2]);
  await settle();
  page.say({ channel, type: "pick", anchor: anchorOf() });
  await settle();
  const composer = host.querySelector<HTMLElement>(".artifact-annot-composer")!;
  // The bar ends 50px into the scroller; the composer starts 8px below it.
  expect(composer.style.top).toBe("58px");
});

test("a chosen HTML element stays movable while its remark is written: 外层 / 内层, and another pick moves it", async () => {
  const created: CreateAnnotationRequest[] = [];
  const { host } = open({
    relpath: "site/index.html",
    body: HTML,
    type: "text/html",
    onCreateAnnotation: async (input) => {
      created.push(input);
      return null;
    },
  });
  await settle();
  const page = htmlPage(host);
  click(modeToggle(host));
  const channel = (await page.channelOf())!;
  const { port1, port2 } = new MessageChannel();
  cleanups.push(() => port1.close());
  const got: Array<Record<string, unknown>> = [];
  port1.onmessage = (ev) => got.push(ev.data as Record<string, unknown>);
  page.say({ channel, type: "ready" }, [port2]);
  await settle();
  page.say({ channel, type: "pick", anchor: anchorOf() });
  await settle();
  expect(host.querySelector("[data-annotation-composer]")).not.toBeNull();
  expect(host.querySelector(".html-annot-hint")?.textContent).toBe(t.stream.annotHtml.pendingHint);
  // The page is still choosing, with the pending element drawn apart.
  expect(got.filter((m) => m.type === "marks").at(-1)).toMatchObject({ picking: true, pending: anchorOf().selector });
  const nav = host.querySelectorAll<HTMLButtonElement>(".html-annot-nav");
  expect(nav).toHaveLength(2);
  click(nav[0]);
  await settle();
  expect(got.at(-1)).toEqual({ channel, type: "nav", dir: "up" });
  // The picker answers with the enclosing element: the pending anchor moves, no second draft.
  const outer = anchorOf({ selector: "body > main", tag: "main", text: "Title one 第二段", outer_html: "<main>…</main>" });
  page.say({ channel, type: "pick", anchor: outer });
  await settle();
  expect(got.filter((m) => m.type === "marks").at(-1)).toMatchObject({ picking: true, pending: "body > main" });
  writeRemark(host, "整块换个样式");
  await settle();
  expect(created).toHaveLength(1);
  expect(created[0]!.anchor).toMatchObject({ selector: "body > main", tag: "main" });
});
