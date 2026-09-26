import { afterEach, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseByteRange, fileRangeResponse } from "./file-range";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function file() {
  const dir = mkdtempSync(join(tmpdir(), "rb-range-"));
  dirs.push(dir);
  const path = join(dir, "clip.mp4");
  writeFileSync(path, "0123456789");
  return path;
}

test("single byte ranges include bounded, open and suffix forms", () => {
  for (const [range, bounds] of [
    ["bytes=0-0", { start: 0, end: 0 }], ["bytes=2-5", { start: 2, end: 5 }],
    ["bytes=7-", { start: 7, end: 9 }], ["bytes=-3", { start: 7, end: 9 }],
    ["bytes=7-99", { start: 7, end: 9 }], ["bytes=-99", { start: 0, end: 9 }],
  ] as const) expect(parseByteRange(range, 10)).toEqual(bounds);
  for (const range of ["bytes=", "bytes=-", "bytes=-0", "bytes=10-", "bytes=5-2", "bytes=0-1,5-6", "items=0-1", "bytes=9007199254740992-", "bytes=0-1.5"]) {
    expect(parseByteRange(range, 10)).toBeNull();
  }
  expect(parseByteRange("bytes=0-", 0)).toBeNull();
});

test("range response reads selected bytes and reports total and range length separately", async () => {
  const path = file();
  const response = fileRangeResponse(path, "video/mp4", "片段.mp4", "bytes=2-5");
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
  expect(response.headers.get("Content-Length")).toBe("4");
  expect(response.headers.get("Accept-Ranges")).toBe("bytes");
  expect(response.headers.get("Content-Type")).toBe("video/mp4");
  expect(await response.text()).toBe("2345");
  const invalid = fileRangeResponse(path, "video/mp4", "clip.mp4", "bytes=99-");
  expect(invalid.status).toBe(416);
  expect(invalid.headers.get("Content-Range")).toBe("bytes */10");
});

test("a film of any size can be read a piece at a time", async () => {
  const path = file();
  const fd = openSync(path, "r+");
  const size = 64 * 1024 * 1024;
  ftruncateSync(fd, size);
  closeSync(fd);
  const probe = fileRangeResponse(path, "video/mp4", "clip.mp4", "bytes=0-0");
  expect(probe.status).toBe(206);
  expect(probe.headers.get("Content-Range")).toBe(`bytes 0-0/${size}`);
  const tail = fileRangeResponse(path, "video/mp4", "clip.mp4", "bytes=-1");
  expect(tail.headers.get("Content-Length")).toBe("1");
  expect(new Uint8Array(await tail.arrayBuffer())).toEqual(new Uint8Array([0]));
});
