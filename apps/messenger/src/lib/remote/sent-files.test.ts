import { expect, test } from "bun:test";
import type { RemoteRequest } from "@real-bot/remote";
import { etagForBlob, originalSizeForBlob } from "../api.ts";
import { anAttachment } from "../test-fixtures.ts";
import { RemoteApi } from "./api.ts";
import { SentFiles, type PictureScaler } from "./sent-files.ts";
import { enrollment } from "./test-host.ts";

const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

const photo = () => new File([new Uint8Array(4096)], "IMG_0001.jpg", { type: "image/jpeg" });
const note = () => new File(["# plan"], "plan.md", { type: "text/markdown" });
const clip = () => new File([new Uint8Array(8192)], "clip.mp4", { type: "video/mp4" });

/** The Mac's rows for a send: the uploaded names, sizes from its stat, paths in the inbox. */
function rowsFor(files: File[]) {
  return files.map((file, i) => anAttachment({
    id: `att-${i}`,
    original_filename: file.name,
    workspace_relpath: `inbox/${file.name}`,
    size: file.size,
  }));
}

/** A phone's RemoteApi whose Mac answers the send with `rows`, and records every other request. */
function phone(rows: (files: File[]) => ReturnType<typeof rowsFor>, scaler?: PictureScaler) {
  const reads: RemoteRequest[] = [];
  let sending: File[] = [];
  const api = new RemoteApi(enrollment, {
    pictureScaler: scaler,
    rpc: async (request) => {
      if (request.method === "POST" && request.path.endsWith("/messages")) {
        return { v: 1, id: request.id, status: 201, body: { id: "msg", attachments: rows(sending) } };
      }
      reads.push(request);
      return { v: 1, id: request.id, status: 200, body: new Blob(["from the mac"]), headers: { etag: '"mac"' } };
    },
  });
  const send = async (files: File[]) => {
    sending = files;
    await api.postMessage(SESSION, "", { attachments: files });
  };
  return { api, reads, send };
}

const thumbOf: PictureScaler = async (source) => new Blob([new Uint8Array(64)], { type: source.type });

/** The regression: a phone enlarged its own photo by pulling it back over the relay. */
test("a picture this page sent is read back from here, under the Mac's ETag", async () => {
  const { api, reads, send } = phone(rowsFor, thumbOf);
  const file = photo();
  await send([file]);
  const original = await api.getAttachmentBlob("att-0");
  expect(original).toBe(file);
  expect(etagForBlob(original)).toMatch(/^"[0-9a-f]{64}"$/);
  // The enlargement's copy is the file itself: reading it costs nothing here.
  expect(await api.getAttachmentBlob("att-0", undefined, { size: "preview" })).toBe(file);
  // By its workspace path too, as a Bot's reply that cites it reads it.
  expect(await api.getWorkspaceFileBlob("inbox/IMG_0001.jpg")).toBe(file);
  expect(reads).toHaveLength(0);
});

/** A chip's thumbnail is made on the phone and says how large the original is, as the Mac's does. */
test("a sent picture's thumbnail is made here once", async () => {
  let made = 0;
  const { api, reads, send } = phone(rowsFor, async (source, edge) => {
    made += 1;
    expect(edge).toBe(256);
    return thumbOf(source, edge);
  });
  const file = photo();
  await send([file]);
  const thumb = await api.getAttachmentBlob("att-0", undefined, { size: "thumb", background: true });
  expect(thumb).not.toBe(file);
  expect(originalSizeForBlob(thumb)).toBe(file.size);
  expect(await api.getAttachmentBlob("att-0", undefined, { size: "thumb" })).toBe(thumb);
  expect(made).toBe(1);
  expect(reads).toHaveLength(0);
});

test("progress on a read from here says it is all there", async () => {
  const { api, send } = phone(rowsFor, thumbOf);
  const file = photo();
  await send([file]);
  const seen: Array<{ loaded: number; total: number | null }> = [];
  await api.getAttachmentBlob("att-0", (next) => seen.push({ ...next }));
  expect(seen).toEqual([{ loaded: file.size, total: file.size }]);
});

/** A picture this browser cannot draw (a HEIC, say) still gets the Mac's JPEG copies to look at. */
test("a sent picture that does not decode here is shown from the Mac's copies", async () => {
  const { api, reads, send } = phone(rowsFor, async () => null);
  const file = photo();
  await send([file]);
  await api.getAttachmentBlob("att-0", undefined, { size: "thumb" });
  await api.getAttachmentBlob("att-0", undefined, { size: "preview" });
  expect(reads.map((row) => row.query?.size)).toEqual(["thumb", "preview"]);
  // Saving the original still needs nothing from the Mac.
  expect(await api.getAttachmentBlob("att-0")).toBe(file);
  expect(reads).toHaveLength(2);
});

/** A Bot edits a note it was sent in place; the phone must see the edit, not what it sent. */
test("text this page sent is still read from the Mac", async () => {
  const { api, reads, send } = phone(rowsFor, thumbOf);
  await send([note()]);
  expect(await (await api.getAttachmentBlob("att-0")).text()).toBe("from the mac");
  expect(reads).toHaveLength(1);
});

test("a sent video plays from here", async () => {
  const { api, reads, send } = phone(rowsFor, thumbOf);
  await send([clip()]);
  const stream = await api.openMediaSource({ path: "inbox/clip.mp4", attachmentId: "att-0" });
  expect(stream?.url).toMatch(/^blob:/);
  stream?.dispose();
  expect(reads).toHaveLength(0);
});

test("a file nobody here sent comes from the Mac", async () => {
  const { api, reads, send } = phone(rowsFor, thumbOf);
  await send([photo()]);
  await api.getAttachmentBlob("att-other");
  await api.getWorkspaceFileBlob("inbox/other.jpg");
  expect(reads.map((row) => row.path)).toEqual(["/v1/attachments/att-other/content", "/v1/workspace/file"]);
});

/** Each row gets its own bytes: matched by the size the Mac read back, then by name. */
test("rows are matched to what went up by size and name", async () => {
  const sent = new SentFiles(thumbOf);
  const small = new File([new Uint8Array(10)], "a.png", { type: "image/png" });
  const large = new File([new Uint8Array(20)], "a.png", { type: "image/png" });
  const renamed = new File([new Uint8Array(30)], "b.png", { type: "image/png" });
  sent.remember(
    [small, large, renamed].map((file) => ({ file, sha256: "0".repeat(64) })),
    [
      anAttachment({ id: "r-large", original_filename: "a.png", workspace_relpath: "inbox/a-2.png", size: 20 }),
      anAttachment({ id: "r-small", original_filename: "a.png", workspace_relpath: "inbox/a.png", size: 10 }),
      // The Mac cleaned the name; the size still says which file it is.
      anAttachment({ id: "r-renamed", original_filename: "b_.png", workspace_relpath: "inbox/b_.png", size: 30 }),
      // Nothing that went up has this size.
      anAttachment({ id: "r-none", original_filename: "c.png", workspace_relpath: "inbox/c.png", size: 99 }),
    ],
  );
  expect(await sent.read({ attachmentId: "r-large" })).toBe(large);
  expect(await sent.read({ attachmentId: "r-small" })).toBe(small);
  expect(await sent.read({ attachmentId: "r-renamed" })).toBe(renamed);
  expect(sent.read({ attachmentId: "r-none" })).toBeNull();
});

/** A read for the Mac reaches the queue in the turn it was asked, behind nothing asked later. */
test("a file this page did not send is asked for at once", () => {
  const { api, reads } = phone(rowsFor, thumbOf);
  void api.getAttachmentBlob("att-other", undefined, { background: true });
  void api.getWorkspaceFileBlob("notes/a.md");
  expect(reads.map((row) => row.path)).toEqual(["/v1/attachments/att-other/content", "/v1/workspace/file"]);
});

/** A send whose answer never came (read back later as a receipt) has no rows to match. */
test("a send without rows remembers nothing", async () => {
  const { api, reads, send } = phone(() => [], thumbOf);
  await send([photo()]);
  await api.getAttachmentBlob("att-0");
  expect(reads).toHaveLength(1);
});
