import { afterEach, expect, mock, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { render } from "../test-render.ts";
import { anAttachment } from "../test-fixtures.ts";

mock.module("monaco-editor-css", () => ({}));
mock.module("monaco-editor/esm/vs/platform/hover/browser/hover.css", () => ({}));
mock.module("monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css", () => ({}));
const { default: ArtifactPreview } = await import("./ArtifactPreview.svelte");
const { default: TraceOutput } = await import("./TraceOutput.svelte");
const t = copyFor("zh");
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); flushSync(); }

const realClick = HTMLAnchorElement.prototype.click;
const win = window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
const realInternals = win.__TAURI_INTERNALS__;
const realShare = Object.getOwnPropertyDescriptor(navigator, "share");
const realCanShare = Object.getOwnPropertyDescriptor(navigator, "canShare");
const realMatchMedia = window.matchMedia;
afterEach(() => {
  HTMLAnchorElement.prototype.click = realClick;
  win.__TAURI_INTERNALS__ = realInternals;
  if (realShare) Object.defineProperty(navigator, "share", realShare);
  else delete (navigator as { share?: unknown }).share;
  if (realCanShare) Object.defineProperty(navigator, "canShare", realCanShare);
  else delete (navigator as { canShare?: unknown }).canShare;
  window.matchMedia = realMatchMedia;
});

/** Links clicked, instead of happy-dom navigating to them. */
function catchDownloads(): string[] {
  const names: string[] = [];
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { names.push(this.download); };
  return names;
}

function downloadButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === t.stream.artifactDownload);
}

test("a subtitle file on the phone says it cannot be previewed and downloads on a tap", async () => {
  const names = catchDownloads();
  const reads: string[] = [];
  const view = render(ArtifactPreview, { attachment: null, relpath: "BEACON_ZERO/EP01/subs.srt", siblings: [], mode: "workspace", workspacePath: null, t,
    api: { kind: "remote", workspaceTree: async () => ({ items: [] }),
      getWorkspaceFileBlob: async (path: string) => { reads.push(path); return new Blob(["1\n00:00:01,000 --> 00:00:02,000\n嗨\n"]); } } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  expect(view.host.textContent).toContain(t.stream.artifactUnsupported);
  // Nothing crosses the relay until it is asked for.
  expect(reads).toEqual([]);
  downloadButton(view.host)!.click();
  await settle(); await settle();
  expect(reads).toEqual(["BEACON_ZERO/EP01/subs.srt"]);
  expect(names).toEqual(["subs.srt"]);
  view.close();
});

test("a cited attachment downloads its own copy under its own name", async () => {
  const names = catchDownloads();
  const reads: string[] = [];
  const attachment = anAttachment({ original_filename: "S01_EP01_subtitles.ass", workspace_relpath: "inbox/S01_EP01_subtitles.ass" });
  const view = render(ArtifactPreview, { attachment, relpath: attachment.workspace_relpath, siblings: [attachment], workspacePath: null, t,
    api: { kind: "remote", workspaceTree: async () => ({ items: [] }),
      getAttachmentBlob: async (id: string) => { reads.push(id); return new Blob(["[Script Info]"]); },
      getWorkspaceFileBlob: () => { throw new Error("attachment bytes come from the attachment"); } } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  downloadButton(view.host)!.click();
  await settle(); await settle();
  expect(reads).toEqual([attachment.id]);
  expect(names).toEqual(["S01_EP01_subtitles.ass"]);
  view.close();
});

test("a download that fails says so and can be tried again", async () => {
  catchDownloads();
  let fail = true;
  const view = render(ArtifactPreview, { attachment: null, relpath: "archive.zip", siblings: [], workspacePath: null, t,
    api: { kind: "remote", getWorkspaceFileBlob: async () => { if (fail) throw new Error("link dropped"); return new Blob(["zip"]); } } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  downloadButton(view.host)!.click();
  await settle(); await settle();
  expect(view.host.textContent).toContain(t.stream.artifactDownloadFailed);
  fail = false;
  downloadButton(view.host)!.click();
  await settle(); await settle();
  expect(view.host.textContent).not.toContain(t.stream.artifactDownloadFailed);
  view.close();
});

test("in the desktop window the file opens with the system instead", async () => {
  const invoked: Array<Record<string, unknown> | undefined> = [];
  win.__TAURI_INTERNALS__ = { invoke: async (_cmd, args) => { invoked.push(args); return null; } };
  const view = render(ArtifactPreview, { attachment: null, relpath: "subs.srt", siblings: [], workspacePath: "/Users/me/ws", t,
    api: { kind: "local" } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  expect(view.host.textContent).toContain(t.stream.artifactUnsupported);
  expect(downloadButton(view.host)).toBeUndefined();
  const open = [...view.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === t.stream.artifactOpenSystem)!;
  open.click();
  await settle();
  expect(invoked).toEqual([{ path: "/Users/me/ws/subs.srt", reveal: false }]);
  view.close();
});

test("a flow output that cannot be shown downloads on the phone", async () => {
  const names = catchDownloads();
  const view = render(TraceOutput, { path: "BEACON_ZERO/EP01/subs.srt", handedBy: "", workspacePath: "/Users/me/ws", t, onOpenPath: () => {}, onClose: () => {},
    api: { kind: "remote", getWorkspaceFileBlob: async () => new Blob(["srt"]) } as never,
  });
  await settle();
  expect(view.host.textContent).toContain(t.trace.outputPlain);
  expect([...view.host.querySelectorAll("button")].some((button) => button.textContent?.trim() === t.trace.outputOpen)).toBe(false);
  expect(view.host.querySelector(".file-download.is-compact")).not.toBeNull();
  downloadButton(view.host)!.click();
  await settle(); await settle();
  expect(names).toEqual(["subs.srt"]);
  view.close();
});

test("a file that is gone says so and offers nothing to download", async () => {
  const attachment = anAttachment({ original_filename: "S01_EP01_master.srt", workspace_relpath: "S01_EP01_master.srt", exists: false });
  const view = render(ArtifactPreview, { attachment, relpath: attachment.workspace_relpath, siblings: [attachment], workspacePath: null, t,
    api: { kind: "remote" } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  expect(view.host.textContent).toContain(t.stream.artifactMissing);
  expect(downloadButton(view.host)).toBeUndefined();
  view.close();
});

test("when the share sheet wants a fresh tap, the next tap hands over the bytes already here", async () => {
  window.matchMedia = ((query: string) => ({ matches: query === "(pointer: coarse)" })) as never;
  let spent = true;
  const shared: string[] = [];
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  Object.defineProperty(navigator, "share", { configurable: true, value: async (data: ShareData) => {
    if (spent) { spent = false; throw new DOMException("tap spent", "NotAllowedError"); }
    shared.push(data.files![0]!.name);
  } });
  let reads = 0;
  const view = render(ArtifactPreview, { attachment: null, relpath: "subs.ass", siblings: [], workspacePath: null, t,
    api: { kind: "remote", getWorkspaceFileBlob: async () => { reads++; return new Blob(["[Script Info]"]); } } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  downloadButton(view.host)!.click();
  await settle(); await settle();
  expect(view.host.textContent).toContain(t.stream.artifactDownloadTapAgain);
  downloadButton(view.host)!.click();
  await settle(); await settle();
  expect(reads).toBe(1);
  expect(shared).toEqual(["subs.ass"]);
  expect(view.host.textContent).not.toContain(t.stream.artifactDownloadTapAgain);
  view.close();
});

function headDownload(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(`.artifact-pane-head button[aria-label="${t.stream.artifactDownload}"]`);
}
function barDownload(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>(".artifact-annot-bar button")].find((button) => button.textContent?.trim() === t.stream.artifactDownload);
}

test("every file opened remotely can be downloaded, from the phone's bar and the wide one", async () => {
  const names = catchDownloads();
  const reads: string[] = [];
  const view = render(ArtifactPreview, { attachment: null, relpath: "docs/EP01_QC_SUBTITLES_RELEASE_REPORT.md", siblings: [], workspacePath: null, t,
    api: { kind: "remote", getWorkspaceFileBlob: async (path: string) => { reads.push(path); return new Blob(["# 报告"]); } } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle(); await settle();
  expect(view.host.querySelector(".md-body, .markdown-body, article")).not.toBeNull();
  expect(reads).toHaveLength(1);
  // The file is already here: no second trip over the relay, and the share sheet can open in this tap.
  headDownload(view.host)!.click();
  await settle();
  expect(reads).toHaveLength(1);
  expect(names).toEqual(["EP01_QC_SUBTITLES_RELEASE_REPORT.md"]);
  barDownload(view.host)!.click();
  await settle();
  expect(reads).toHaveLength(1);
  expect(names).toEqual(["EP01_QC_SUBTITLES_RELEASE_REPORT.md", "EP01_QC_SUBTITLES_RELEASE_REPORT.md"]);
  view.close();
});

test("a streamed film downloads the whole file, not the pieces the player asked for", async () => {
  const names = catchDownloads();
  const reads: string[] = [];
  const view = render(ArtifactPreview, { attachment: null, relpath: "BEACON_ZERO/assets/videos/EP01/S01_EP01_release.mp4", siblings: [], workspacePath: null, t,
    api: { kind: "remote", openMediaSource: async () => ({ url: "/__remote_media/film", dispose: () => {} }),
      getWorkspaceFileBlob: async (path: string) => { reads.push(path); return new Blob(["film"], { type: "video/mp4" }); } } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  expect(view.host.querySelector("video")?.getAttribute("src")).toBe("/__remote_media/film");
  expect(reads).toEqual([]);
  headDownload(view.host)!.click();
  await settle(); await settle();
  expect(reads).toEqual(["BEACON_ZERO/assets/videos/EP01/S01_EP01_release.mp4"]);
  expect(names).toEqual(["S01_EP01_release.mp4"]);
  view.close();
});

test("a picture shown as the Mac's scaled copy downloads the original", async () => {
  const names = catchDownloads();
  const sizes: Array<string | undefined> = [];
  const view = render(ArtifactPreview, { attachment: null, relpath: "frames/C06_frame_end.png", siblings: [], workspacePath: null, t,
    api: { kind: "remote", getWorkspaceFileBlob: async (_path: string, _progress: unknown, options?: { size?: string }) => { sizes.push(options?.size); return new Blob(["png"], { type: "image/png" }); } } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle(); await settle();
  expect(sizes).toEqual(["preview"]);
  headDownload(view.host)!.click();
  await settle(); await settle();
  expect(sizes).toEqual(["preview", undefined]);
  expect(names).toEqual(["C06_frame_end.png"]);
  view.close();
});

test("a download that fails from the bar says so under it", async () => {
  catchDownloads();
  const view = render(ArtifactPreview, { attachment: null, relpath: "film.mp4", siblings: [], workspacePath: null, t,
    api: { kind: "remote", openMediaSource: async () => ({ url: "/__remote_media/film", dispose: () => {} }),
      getWorkspaceFileBlob: async () => { throw new Error("link dropped"); } } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  headDownload(view.host)!.click();
  await settle(); await settle();
  expect(view.host.textContent).toContain(t.stream.artifactDownloadFailed);
  view.close();
});

test("the local window and a folder offer no download", async () => {
  const local = render(ArtifactPreview, { attachment: null, relpath: "notes.md", siblings: [], workspacePath: "/Users/me/ws", t,
    api: { kind: "local", getWorkspaceFileBlob: async () => new Blob(["# x"]) } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  expect(headDownload(local.host)).toBeNull();
  expect(barDownload(local.host)).toBeUndefined();
  local.close();
  const workspace = render(ArtifactPreview, { attachment: null, relpath: "", siblings: [], mode: "workspace", workspacePath: null, t,
    api: { kind: "remote", workspaceTree: async () => ({ items: [] }) } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  expect(headDownload(workspace.host)).toBeNull();
  workspace.close();
});

test("a flow card downloads the file it shows", async () => {
  const names = catchDownloads();
  let reads = 0;
  const view = render(TraceOutput, { path: "BEACON_ZERO/docs/EP01_MASTER_ASSEMBLY_REPORT.md", handedBy: "", workspacePath: null, t, onOpenPath: () => {}, onClose: () => {},
    api: { kind: "remote", getWorkspaceFileBlob: async () => { reads++; return new Blob(["# 总装"]); } } as never,
  });
  await settle(); await settle();
  view.host.querySelector<HTMLButtonElement>(`.trace-output-head button[aria-label="${t.stream.artifactDownload}"]`)!.click();
  await settle();
  expect(reads).toBe(1);
  expect(names).toEqual(["EP01_MASTER_ASSEMBLY_REPORT.md"]);
  view.close();
});
