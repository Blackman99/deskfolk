import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, commitFile, fileEtag, renameReplacing, stageFile, syncDirectory } from "./file-integrity";

function root(): string {
  return mkdtempSync(join(tmpdir(), "rb-file-integrity-"));
}

test("syncDirectory is a real fsync on POSIX and a no-op on win32", () => {
  const dir = root();
  try {
    // Would throw if it tried to open+fsync a nonexistent directory; win32 never gets that far.
    expect(() => syncDirectory(join(dir, "does-not-exist"), "win32")).not.toThrow();
    expect(() => syncDirectory(dir, "darwin")).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("renameReplacing is a single renameSync on POSIX, unchanged", () => {
  const dir = root();
  try {
    const tmp = join(dir, "a.tmp"), dest = join(dir, "a");
    writeFileSync(tmp, "hi");
    renameReplacing(tmp, dest, "darwin");
    expect(existsSync(tmp)).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe("hi");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("renameReplacing retries a transient win32 error and then succeeds", () => {
  let calls = 0;
  const rename = (_from: string, _to: string) => {
    calls += 1;
    if (calls < 3) {
      const error = new Error("busy") as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    }
  };
  renameReplacing("a.tmp", "a", "win32", rename);
  expect(calls).toBe(3);
});

test("renameReplacing gives up after its retry budget and rethrows", () => {
  let calls = 0;
  const rename = () => {
    calls += 1;
    const error = new Error("busy") as NodeJS.ErrnoException;
    error.code = "EBUSY";
    throw error;
  };
  expect(() => renameReplacing("a.tmp", "a", "win32", rename)).toThrow();
  expect(calls).toBeGreaterThan(1);
});

test("renameReplacing does not retry a non-transient error", () => {
  let calls = 0;
  const rename = () => {
    calls += 1;
    const error = new Error("nope") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  };
  expect(() => renameReplacing("a.tmp", "a", "win32", rename)).toThrow();
  expect(calls).toBe(1);
});

test("renameReplacing on POSIX calls rename exactly once, unchanged, even for a transient code", () => {
  let calls = 0;
  const rename = () => {
    calls += 1;
    const error = new Error("busy") as NodeJS.ErrnoException;
    error.code = "EBUSY";
    throw error;
  };
  expect(() => renameReplacing("a.tmp", "a", "darwin", rename)).toThrow();
  expect(calls).toBe(1);
});

test("stageFile on win32 always makes the temp writable, even over a read-only target", () => {
  const dir = root();
  try {
    const abs = join(dir, "target.txt");
    writeFileSync(abs, "old");
    chmodSync(abs, 0o400);
    try {
      const tmp = stageFile(abs, "new", undefined, "win32");
      expect(statSync(tmp).mode & 0o200).toBeGreaterThan(0); // owner-writable
      commitFile(tmp, abs, "win32");
      expect(readFileSync(abs, "utf8")).toBe("new");
    } finally {
      chmodSync(abs, 0o600);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stageFile closes the fd before unlinking the temp on a write failure", () => {
  const dir = root();
  try {
    const abs = join(dir, "target.txt");
    const bogus = { not: "a byte array" } as unknown as Uint8Array; // writeFileSync throws on this
    expect(() => stageFile(abs, bogus)).toThrow();
    // If close-before-unlink were reversed, the failed unlink would leave the temp behind
    // (Windows cannot unlink a file with an open handle; this reproduces the same ordering bug
    // on any OS, since unlinking a file whose fd is still open is the thing being tested).
    expect(readdirSync(dir).length).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("atomicWrite end-to-end still works with the win32-safe stageFile/commitFile", () => {
  const dir = root();
  try {
    const abs = join(dir, "doc.md");
    const etag = atomicWrite(abs, "hello");
    expect(etag).toBe(fileEtag(Buffer.from("hello")));
    expect(readFileSync(abs, "utf8")).toBe("hello");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
