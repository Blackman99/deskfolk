import { expect, mock, test } from "bun:test";
import type { MediaSourceHandle } from "../remote/media-source.ts";
import { copyFor } from "../copy.ts";
import { render } from "../test-render.ts";
import { anAttachment } from "../test-fixtures.ts";
import { mockMonacoCss } from "../test-mocks.ts";
import { settle } from "../test-async.ts";

mockMonacoCss();
const { default: ArtifactPreview } = await import("./ArtifactPreview.svelte");
const t = copyFor("zh");

for (const kind of ["video", "audio"] as const) {
  for (const mode of ["cited", "workspace"] as const) {
    test(`${mode} ${kind} preview publishes its streaming URL without downloading a Blob`, async () => {
      let disposed = 0;
      const calls: Array<{ path: string; attachmentId?: string }> = [];
      const name = kind === "video" ? "clip.mp4" : "sound.mp3";
      const attachment = anAttachment({ original_filename: name, workspace_relpath: name });
      const view = render(ArtifactPreview, {
        attachment, relpath: name, siblings: [attachment], mode, workspacePath: null, t,
        api: { kind: "remote", workspaceTree: async () => ({ items: [] }),
          openMediaSource: async (source: { path: string; attachmentId?: string }) => { calls.push(source); return { url: "/__remote_media/fixture", dispose: () => { disposed++; } }; },
          getAttachmentBlob: () => { throw new Error("whole download"); },
          getWorkspaceFileBlob: () => { throw new Error("whole download"); },
        } as never,
        onClose: () => {}, onSelect: () => {},
      });
      await settle();
      expect(view.host.querySelector(kind)?.getAttribute("src")).toBe("/__remote_media/fixture");
      expect(view.host.querySelector(kind)?.getAttribute("preload")).toBe("metadata");
      expect(view.host.querySelector(".artifact-loading")).toBeNull();
      expect(calls).toEqual([{ path: name, ...(mode === "cited" ? { attachmentId: attachment.id } : {}) }]);
      view.close();
      expect(disposed).toBe(1);
    });
  }
}

test("closing during media setup releases a late source", async () => {
  let finish!: (source: MediaSourceHandle) => void;
  let disposed = 0;
  const view = render(ArtifactPreview, { attachment: null, relpath: "clip.mp4", siblings: [], workspacePath: null, t,
    api: { kind: "remote", openMediaSource: () => new Promise<MediaSourceHandle>((resolve) => { finish = resolve; }) } as never,
    onClose: () => {}, onSelect: () => {},
  });
  view.close();
  finish({ url: "/__remote_media/late", dispose: () => { disposed++; } });
  await settle();
  expect(disposed).toBe(1);
});

test("hosts without range support keep the whole-file preview", async () => {
  let reads = 0;
  const view = render(ArtifactPreview, { attachment: null, relpath: "clip.mp4", siblings: [], workspacePath: null, t,
    api: { kind: "remote", openMediaSource: async () => null, getWorkspaceFileBlob: async () => { reads++; return new Blob(["video"]); } } as never,
    onClose: () => {}, onSelect: () => {},
  });
  await settle();
  expect(reads).toBe(1);
  expect(view.host.querySelector("video")?.getAttribute("src")).toStartWith("blob:");
  view.close();
});
