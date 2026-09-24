import { expect, mock, test } from "bun:test";
import { flushSync } from "svelte";
import { SvelteMap } from "svelte/reactivity";

mock.module("monaco-editor-css", () => ({}));
mock.module("monaco-editor/esm/vs/platform/hover/browser/hover.css", () => ({}));
mock.module("monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css", () => ({}));
const { default: ArtifactPreview } = await import("./ArtifactPreview.svelte");
import { copyFor } from "../copy.ts";
import type { FileLoadOptions, FileProgressHandler } from "../file-progress.ts";
import { rememberBlobOriginalSize } from "../api.ts";
import { anAttachment } from "../test-fixtures.ts";
import { render } from "../test-render.ts";

const t = copyFor("zh");
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

function deferredBlob(): {
  promise: Promise<Blob>;
  resolve: (blob: Blob) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (blob: Blob) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Blob>((ok, err) => {
    resolve = ok;
    reject = err;
  });
  return { promise, resolve, reject };
}

function open(opts: {
  getWorkspaceFileBlob?: (path: string, onProgress?: FileProgressHandler, options?: FileLoadOptions) => Promise<Blob>;
  getAttachmentBlob?: (id: string, onProgress?: FileProgressHandler, options?: FileLoadOptions) => Promise<Blob>;
  relpath?: string;
  filename?: string;
  size?: number | null;
}) {
  const attachment = anAttachment({
    original_filename: opts.filename ?? "cover.png",
    workspace_relpath: opts.relpath ?? "shots/cover.png",
    mime: "image/png",
    size: opts.size === undefined ? 2048 : opts.size,
  });
  const view = render(ArtifactPreview, {
    attachment,
    relpath: opts.relpath ?? "shots/cover.png",
    siblings: [attachment],
    api: {
      kind: "remote",
      getWorkspaceFileBlob: opts.getWorkspaceFileBlob ?? (async () => new Blob()),
      getAttachmentBlob: opts.getAttachmentBlob ?? (async () => new Blob()),
    } as never,
    workspacePath: null,
    t,
    onClose: () => {},
    onSelect: () => {},
    mode: "cited",
  });
  return view;
}

test("opening a file shows a loading animation instead of a blank pane", async () => {
  const pending = deferredBlob();
  const { host, close } = open({
    getAttachmentBlob: () => pending.promise,
  });
  await Promise.resolve();
  flushSync();
  const status = host.querySelector(".artifact-loading");
  expect(status).not.toBeNull();
  expect(status?.getAttribute("aria-busy")).toBe("true");
  expect(host.textContent).toContain(t.stream.artifactLoading);
  expect(host.querySelector(".artifact-loading-ring")).not.toBeNull();
  expect(host.querySelector(".artifact-img")).toBeNull();
  pending.resolve(new Blob([PNG], { type: "image/png" }));
  await pending.promise;
  await Promise.resolve();
  flushSync();
  expect(host.querySelector(".artifact-loading")).toBeNull();
  expect(host.querySelector(".artifact-img")).not.toBeNull();
  close();
});

test("a known transfer size fills the bar and names the bytes", async () => {
  const pending = deferredBlob();
  let report: FileProgressHandler | undefined;
  const { host, close } = open({
    getAttachmentBlob: (_id, onProgress) => {
      report = onProgress;
      return pending.promise;
    },
  });
  await Promise.resolve();
  flushSync();
  report?.({ loaded: 2048, total: 4096 });
  flushSync();
  const bar = host.querySelector(".artifact-loading-bar");
  expect(bar?.getAttribute("aria-valuenow")).toBe("50");
  expect(host.querySelector<HTMLElement>(".artifact-loading-fill")?.style.width).toBe("50%");
  expect(host.textContent).toContain("2.0 KB / 4.0 KB");
  pending.resolve(new Blob([PNG], { type: "image/png" }));
  await pending.promise;
  close();
});

test("an attachment size fills the bar before the first chunk", async () => {
  const pending = deferredBlob();
  const { host, close } = open({
    size: 4096,
    filename: "clip.mp4",
    relpath: "shots/clip.mp4",
    getAttachmentBlob: () => pending.promise,
  });
  await Promise.resolve();
  flushSync();
  expect(host.querySelector(".artifact-loading-bar")?.getAttribute("aria-valuenow")).toBe("0");
  expect(host.textContent).toContain("0 B / 4.0 KB");
  pending.resolve(new Blob([PNG], { type: "image/png" }));
  await pending.promise;
  close();
});

test("without a total the bar sweeps instead of claiming a percent", async () => {
  const pending = deferredBlob();
  let report: FileProgressHandler | undefined;
  const { host, close } = open({
    size: null,
    getAttachmentBlob: (_id, onProgress) => {
      report = onProgress;
      return pending.promise;
    },
  });
  await Promise.resolve();
  flushSync();
  report?.({ loaded: 512, total: null });
  flushSync();
  expect(host.querySelector(".artifact-loading-bar")?.getAttribute("aria-valuenow")).toBeNull();
  expect(host.querySelector(".artifact-loading-fill")?.classList.contains("is-indeterminate")).toBe(true);
  expect(host.textContent).toContain("512 B");
  pending.resolve(new Blob([PNG], { type: "image/png" }));
  await pending.promise;
  close();
});

test("an image preview enlarges over the app from the bytes it already has", async () => {
  let fetches = 0;
  const { host, close } = open({
    getAttachmentBlob: async () => {
      fetches += 1;
      return new Blob([PNG], { type: "image/png" });
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
  const shown = host.querySelector<HTMLImageElement>(".artifact-img")!;
  const button = host.querySelector<HTMLButtonElement>("button.artifact-img-open")!;
  expect(button.contains(shown)).toBe(true);
  expect(button.getAttribute("aria-label")).toBe(`${t.stream.artifactEnlarge} cover.png`);

  button.click();
  flushSync();
  const full = document.querySelector<HTMLImageElement>(".msg-image-lightbox .msg-image-full");
  expect(full).not.toBeNull();
  expect(full!.getAttribute("src")).toBe(shown.getAttribute("src"));
  // Nothing downloaded twice: on a remote host that would be the whole picture again.
  expect(fetches).toBe(1);

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(document.querySelector(".msg-image-lightbox")).toBeNull();
  // The preview's own picture stays usable after the enlargement is gone.
  expect(host.querySelector(".artifact-img")?.getAttribute("src")).toBe(shown.getAttribute("src"));
  close();
});

test("the desktop preview has no toolbar, and the phone keeps a back bar", () => {
  const viewport = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM;
  const mount = () => {
    let closed = 0;
    const attachment = anAttachment({
      original_filename: "cover.png",
      workspace_relpath: "shots/cover.png",
      mime: "image/png",
    });
    const view = render(ArtifactPreview, {
      attachment,
      relpath: "shots/cover.png",
      siblings: [attachment],
      api: { kind: "remote", getAttachmentBlob: async () => new Blob([PNG], { type: "image/png" }) } as never,
      workspacePath: null,
      t,
      onClose: () => {
        closed += 1;
      },
      onSelect: () => {},
      mode: "cited",
    });
    return { ...view, closed: () => closed };
  };
  viewport.setViewport({ width: 1280, height: 800 });
  const wide = mount();
  const wideHead = wide.host.querySelector<HTMLElement>(".artifact-pane-head")!;
  expect(getComputedStyle(wideHead).display).toBe("none");
  expect(wide.host.querySelector(".artifact-tool-btn")).toBeNull();
  expect(wide.host.querySelector(".modal-close")).toBeNull();
  expect(wide.host.textContent).not.toContain(t.stream.artifactFind);
  expect(wide.host.textContent).not.toContain(t.stream.artifactOpenSystem);
  wide.close();

  viewport.setViewport({ width: 390, height: 844 });
  const phone = mount();
  const head = phone.host.querySelector<HTMLElement>(".artifact-pane-head")!;
  expect(getComputedStyle(head).display).toBe("flex");
  const title = head.querySelector("h2")!;
  expect(title.textContent).toBe("cover.png");
  // The name sits in the middle of the bar. A heading that starts at the top of a stretched row
  // draws through the back chevron, which is centered in that same row.
  expect(getComputedStyle(title).alignSelf).toBe("center");
  expect(getComputedStyle(title).whiteSpace).toBe("nowrap");
  const back = phone.host.querySelector<HTMLButtonElement>(".artifact-back")!;
  expect(back.getAttribute("aria-label")).toBe(t.common.back);
  expect(getComputedStyle(back).alignItems).toBe("center");
  back.click();
  flushSync();
  expect(phone.closed()).toBe(1);
  phone.close();
  viewport.setViewport({ width: 1280, height: 800 });
});

test("markdown source is a floating toggle, and a tree row opens Finder from its menu", async () => {
  const note = anAttachment({
    original_filename: "brief.md",
    workspace_relpath: "docs/brief.md",
    mime: "text/markdown",
  });
  const calls: { path: string; reveal: boolean }[] = [];
  const holder = globalThis as { __TAURI_INTERNALS__?: unknown };
  const previous = holder.__TAURI_INTERNALS__;
  holder.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: { path: string; reveal: boolean }) => {
      if (cmd === "open_workspace_path") calls.push({ path: args.path, reveal: args.reveal });
    },
  };
  const { host, close } = render(ArtifactPreview, {
    attachment: note,
    relpath: "docs/brief.md",
    siblings: [note],
    api: {
      kind: "local",
      getAttachmentBlob: async () => new Blob(["# 简报\n"], { type: "text/markdown" }),
    } as never,
    workspacePath: "/Users/you/work",
    t,
    onClose: () => {},
    onSelect: () => {},
    mode: "cited",
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    const toggle = host.querySelector<HTMLButtonElement>(".artifact-source-toggle");
    expect(toggle?.textContent?.trim()).toBe(t.stream.artifactSource);
    expect(toggle?.querySelector("svg")).not.toBeNull();
    expect(host.querySelector(".artifact-tool-btn")).toBeNull();
    toggle?.click();
    flushSync();
    expect(host.querySelector(".artifact-source-toggle")?.textContent?.trim()).toBe(t.stream.artifactRendered);
    expect(host.querySelector(".artifact-source-toggle")?.getAttribute("aria-pressed")).toBe("true");

    const row = [...host.querySelectorAll<HTMLButtonElement>(".artifact-tree-row")].find((button) =>
      button.textContent?.includes("brief.md"),
    )!;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    flushSync();
    const menu = document.querySelector("[data-testid='artifact-tree-menu']");
    expect(menu?.textContent).toContain("在 Finder 中打开");
    expect(menu?.textContent).toContain("用系统默认应用打开");
    (menu?.querySelector("[data-reveal]") as HTMLButtonElement).click();
    flushSync();
    await Promise.resolve();
    expect(calls).toEqual([{ path: "/Users/you/work/docs/brief.md", reveal: true }]);
    expect(document.querySelector("[data-testid='artifact-tree-menu']")).toBeNull();
  } finally {
    holder.__TAURI_INTERNALS__ = previous;
    close();
  }
});

/** A preview closed before its file lands stops the read, so the next file is not queued behind it. */
test("closing the preview stops the read still on the way", () => {
  const signals: Array<AbortSignal | undefined> = [];
  const { close } = open({
    getAttachmentBlob: (_id: string, _progress?: FileProgressHandler, options?: FileLoadOptions) => {
      signals.push(options?.signal);
      return new Promise<Blob>(() => {});
    },
  });
  flushSync();
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(false);
  close();
  expect(signals[0]?.aborted).toBe(true);
});

/**
 * The workbench stands a file with no attachment row in with a made-up `virtual-…` id. Asking the
 * attachment endpoint for that id is a 404, which read as "file is gone" for a file on disk.
 */
test("a stand-in for a file nothing attached is read from the workspace", async () => {
  const workspaceReads: string[] = [];
  const attachmentReads: string[] = [];
  const standIn = {
    id: "virtual-preview-shots/cover.png",
    message_id: "",
    workspace_relpath: "shots/cover.png",
    original_filename: "cover.png",
    created_at: "",
  };
  const { host, close } = render(ArtifactPreview, {
    attachment: standIn,
    relpath: "shots/cover.png",
    siblings: [standIn],
    api: {
      kind: "remote",
      getWorkspaceFileBlob: async (path: string) => {
        workspaceReads.push(path);
        return new Blob([PNG], { type: "image/png" });
      },
      getAttachmentBlob: async (id: string) => {
        attachmentReads.push(id);
        throw new Error("404");
      },
    } as never,
    workspacePath: null,
    t,
    onClose: () => {},
    onSelect: () => {},
    mode: "cited",
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flushSync();
  expect(workspaceReads).toEqual(["shots/cover.png"]);
  expect(attachmentReads).toEqual([]);
  expect(host.textContent).not.toContain(t.stream.artifactMissing);
  close();
});

/**
 * The kind follows the new file at once; its bytes come later. A `<video>` given the picture that
 * was on screen cannot play it, and its error left the video reading "file is gone" for good.
 */
test("going from a picture to a video never hands the picture's bytes to the video", async () => {
  const shown = new SvelteMap([["relpath", "shots/cover.png"]]);
  const video = deferredBlob();
  const { host, close } = render(ArtifactPreview, {
    attachment: null,
    get relpath() { return shown.get("relpath")!; },
    siblings: [],
    api: {
      kind: "remote",
      getWorkspaceFileBlob: (path: string) =>
        path.endsWith(".mp4") ? video.promise : Promise.resolve(new Blob([PNG], { type: "image/png" })),
      getAttachmentBlob: async () => new Blob(),
    } as never,
    workspacePath: null,
    t,
    onClose: () => {},
    onSelect: () => {},
    mode: "cited",
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    flushSync();
  };
  await settle();
  const picture = host.querySelector<HTMLImageElement>("img.artifact-img")?.src;
  expect(picture).toBeTruthy();

  shown.set("relpath", "shots/clip.mp4");
  flushSync();
  expect(host.querySelector("video")).toBeNull();
  expect(host.querySelector(".artifact-loading")).not.toBeNull();

  video.resolve(new Blob([new Uint8Array(8)], { type: "video/mp4" }));
  await settle();
  const player = host.querySelector<HTMLVideoElement>("video");
  expect(player?.src).toBeTruthy();
  expect(player?.src).not.toBe(picture);
  expect(host.textContent).not.toContain(t.stream.artifactMissing);
  close();
});

test("a file this entry handed over that the Mac knows is deleted is not in the job's tree", async () => {
  const kept = anAttachment({ id: "a-kept", workspace_relpath: "work/job/kept.png", original_filename: "kept.png" });
  const deleted = anAttachment({ id: "a-gone", workspace_relpath: "work/job/deleted.png", original_filename: "deleted.png", exists: false });
  const { host, close } = render(ArtifactPreview, {
    attachment: kept,
    relpath: kept.workspace_relpath,
    siblings: [kept, deleted],
    taskId: "job",
    api: {
      kind: "remote",
      getAttachmentBlob: async () => new Blob([PNG], { type: "image/png" }),
      getWorkspaceFileBlob: async () => new Blob([PNG], { type: "image/png" }),
      // The daemon already leaves the deleted one out; the entry's own list must not add it back.
      taskArtifacts: async () => ({
        id: "job", dir: "work/job", title: "", closed_at: null,
        items: [{ path: kept.workspace_relpath, last_cited_at: "2026-09-24T00:00:00.000Z", turn_id: null }],
      }),
    } as never,
    workspacePath: null,
    t,
    onClose: () => {},
    onSelect: () => {},
    mode: "cited",
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flushSync();
  const rows = [...host.querySelectorAll(".artifact-tree-row")].map((row) => row.textContent?.trim());
  expect(rows).toContain("kept.png");
  expect(rows).not.toContain("deleted.png");
  close();
});

/**
 * A keyframe is several MB of PNG. On a phone the pane shows the Mac's 1600 px copy first and
 * offers the original, which then replaces the copy in place.
 */
test("a remote picture opens as the Mac's copy and offers the original", async () => {
  const asked: Array<FileLoadOptions | undefined> = [];
  const original = deferredBlob();
  let report: FileProgressHandler | undefined;
  const copy = new Blob([PNG], { type: "image/jpeg" });
  rememberBlobOriginalSize(copy, 3_727_854);
  const { host, close } = open({
    size: 3_727_854,
    getAttachmentBlob: (_id, onProgress, options) => {
      asked.push(options);
      if (options?.size) return Promise.resolve(copy);
      report = onProgress;
      return original.promise;
    },
  });
  try {
    await Promise.resolve();
    flushSync();
    expect(asked[0]?.size).toBe("preview");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const offer = host.querySelector<HTMLButtonElement>(".artifact-original-toggle");
    expect(offer?.textContent).toContain("查看原图（3.6 MB）");
    const copyUrl = host.querySelector<HTMLImageElement>(".artifact-img")?.src;
    offer!.click();
    flushSync();
    expect(asked[1]?.size).toBeUndefined();
    report?.({ loaded: 1_048_576, total: 3_727_854 });
    flushSync();
    expect(host.querySelector(".artifact-original-toggle")?.textContent).toContain("正在载入原图 1.0 MB / 3.6 MB");
    // The copy stays up while the original arrives.
    expect(host.querySelector<HTMLImageElement>(".artifact-img")?.src).toBe(copyUrl);
    original.resolve(new Blob([PNG], { type: "image/png" }));
    await original.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(host.querySelector(".artifact-original-toggle")).toBeNull();
    expect(host.querySelector<HTMLImageElement>(".artifact-img")?.src).not.toBe(copyUrl);
  } finally {
    close();
  }
});

/** Until the Mac answers, nobody knows what the copy weighs; the original's size would be a lie. */
test("a remote picture's bar does not claim the original's size for its copy", async () => {
  const pending = deferredBlob();
  const { host, close } = open({ size: 4096, getAttachmentBlob: () => pending.promise });
  await Promise.resolve();
  flushSync();
  expect(host.querySelector(".artifact-loading-fill")?.classList.contains("is-indeterminate")).toBe(true);
  expect(host.textContent).not.toContain("4.0 KB");
  pending.resolve(new Blob([PNG], { type: "image/png" }));
  await pending.promise;
  close();
});

/** A picture already within the size comes back as itself, and there is nothing to offer. */
test("a remote picture that is its own original offers nothing", async () => {
  const { host, close } = open({ getAttachmentBlob: async () => new Blob([PNG], { type: "image/png" }) });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(host.querySelector(".artifact-img")).not.toBeNull();
    expect(host.querySelector(".artifact-original-toggle")).toBeNull();
  } finally {
    close();
  }
});
