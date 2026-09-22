import { expect, test } from "bun:test";
import { formatFileSize } from "./chat/attachments.ts";
import {
  fileProgressPercent,
  formatFileProgress,
  readResponseBlob,
  type FileProgress,
} from "./file-progress.ts";

test("fileProgressPercent is null without a known total, so the bar runs indeterminate", () => {
  expect(fileProgressPercent({ loaded: 0, total: null })).toBeNull();
  expect(fileProgressPercent({ loaded: 40, total: 0 })).toBeNull();
  expect(fileProgressPercent({ loaded: 5, total: 10 })).toBe(50);
  expect(fileProgressPercent({ loaded: 10, total: 10 })).toBe(100);
  expect(fileProgressPercent({ loaded: 12, total: 10 })).toBe(100);
});

test("formatFileProgress shows loaded against total when the transfer names a size", () => {
  expect(formatFileProgress({ loaded: 2048, total: 10_240 }, formatFileSize)).toBe("2.0 KB / 10.0 KB");
  expect(formatFileProgress({ loaded: 512, total: null }, formatFileSize)).toBe("512 B");
  expect(formatFileProgress({ loaded: 0, total: null }, formatFileSize)).toBeNull();
});

test("readResponseBlob without Content-Length still reports loaded bytes", async () => {
  const seen: FileProgress[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([9, 8]));
      controller.close();
    },
  });
  await readResponseBlob(new Response(body), (progress) => seen.push({ ...progress }));
  expect(seen).toEqual([
    { loaded: 0, total: null },
    { loaded: 2, total: null },
  ]);
});

test("readResponseBlob reports each chunk against Content-Length", async () => {
  const seen: FileProgress[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.enqueue(new Uint8Array([5, 6]));
      controller.close();
    },
  });
  const blob = await readResponseBlob(
    new Response(body, { headers: { "Content-Length": "6", "Content-Type": "application/octet-stream" } }),
    (progress) => seen.push({ ...progress }),
  );
  expect(seen).toEqual([
    { loaded: 0, total: 6 },
    { loaded: 4, total: 6 },
    { loaded: 6, total: 6 },
  ]);
  expect(await blob.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]).buffer);
  expect(blob.type).toBe("application/octet-stream");
});
