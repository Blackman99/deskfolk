/**
 * `ArtifactLoader.watchFile` against a stand-in client: the file on screen follows the disk, an
 * unsaved edit is never read over, and a file that will not show is tried twice per version rather
 * than every second.
 */
import { effect, signal } from "nsh";
import { expect, test } from "nsh/test";
import { rememberBlobEtag } from "../../m/api.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { ArtifactLoader, WATCH_LOCAL_MS } from "../../m/overlays/artifact-loader.svelte.ts";
import type { ArtifactKind } from "../../m/overlays/artifacts.ts";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const POLL = WATCH_LOCAL_MS + 400;

/** A local client whose file is `disk()` (null: the runtime says there is none). */
function client(disk: () => { text: string; etag: string } | null) {
  const calls = { stat: 0, read: 0 };
  const api = {
    kind: "local",
    endpoint: { origin: "http://127.0.0.1:9", token: "fixture" },
    async fileStat() {
      calls.stat += 1;
      const file = disk();
      if (!file) throw new Error("not_found");
      return { etag: file.etag, size: file.text.length, modified_at: "" };
    },
    async getWorkspaceFileBlob() {
      calls.read += 1;
      const file = disk();
      if (!file) throw new Error("not_found");
      const blob = new Blob([file.text]);
      rememberBlobEtag(blob, file.etag);
      return blob;
    },
  } as unknown as MessengerApi;
  return { api, calls };
}

function watched(api: MessengerApi, kind: ArtifactKind, opts: { dirty?: () => boolean; localFile?: (path: string) => string | null } = {}) {
  const loader = new ArtifactLoader({
    api: () => api,
    relpath: () => (kind === "video" ? "clip.mp4" : "notes.md"),
    attachment: () => null,
    kind: () => kind,
    byteSource: () => "workspace",
    localFile: opts.localFile,
    dirty: opts.dirty,
  });
  loader.watchLoad();
  loader.watchFile();
  return loader;
}

test("a text file follows the disk, and an unsaved edit is never read over", async () => {
  const disk = signal({ text: "one\n", etag: '"a"' });
  const dirty = signal(false);
  const { api } = client(() => disk());
  const loader = watched(api, "text", { dirty: () => dirty() });
  try {
    await wait(200);
    expect(loader.text).toBe("one\n");
    disk.set({ text: "two\n", etag: '"b"' });
    await wait(POLL);
    expect(loader.text).toBe("two\n");
    expect(loader.loadedEtag).toBe('"b"');
    // An edit not yet saved: the disk changes, the pane keeps the edit and the hash it was read with.
    dirty.set(true);
    disk.set({ text: "three\n", etag: '"c"' });
    await wait(POLL * 2);
    expect(loader.text).toBe("two\n");
    expect(loader.loadedEtag).toBe('"b"');
    // Let go of: the disk's text comes in.
    dirty.set(false);
    await wait(POLL);
    expect(loader.text).toBe("three\n");
  } finally {
    loader.destroy();
  }
}, 20_000);

test("a clip the player refuses is made again twice per version of the file, not every second", async () => {
  const disk = signal({ text: "not a clip", etag: '"x1"' });
  const { api, calls } = client(() => disk());
  const loader = watched(api, "video", { localFile: () => "/tmp/clip.mp4" });
  // The player fails on every clip it is given, as `MediaAnnotator`'s `onError` says.
  effect(() => {
    void loader.version;
    if (loader.blobPath) queueMicrotask(() => (loader.missing = true));
  });
  try {
    await wait(200);
    const first = loader.version;
    await wait(POLL * 4);
    expect(loader.version - first).toBe(2);
    // A new version of the file is tried again, twice.
    disk.set({ text: "still not a clip", etag: '"x2"' });
    await wait(POLL * 3);
    expect(loader.version - first).toBe(4);
    // The player reads the clip by its path: the watcher never read its bytes.
    expect(calls.read).toBe(0);
  } finally {
    loader.destroy();
  }
}, 30_000);
