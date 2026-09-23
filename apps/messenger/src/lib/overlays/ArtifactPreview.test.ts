import { expect, mock, test } from "bun:test";
import { flushSync } from "svelte";

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
