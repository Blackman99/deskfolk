import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "./index";
import { memoryKeyStore } from "../secrets";
import { HttpError } from "../errors";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

async function store(): Promise<{ store: Store; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "rb-live-"));
  dirs.push(root);
  mkdirSync(join(root, "inbox"));
  const st = new Store({ filename: join(root, "state.sqlite"), endpointKey: memoryKeyStore() });
  await st.patchSettings({ workspace_path: root });
  return { store: st, root };
}

test("live file commits only after sequential EOF hash", async () => {
  const { store: st, root } = await store();
  const bytes = Buffer.from("hello");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const live = st.openLiveFile(root, join(root, "inbox", "a.txt"), hash, bytes.length);
  expect(() => st.writeLiveFile(live, 1, bytes.subarray(0, 1))).toThrow(HttpError);
  st.writeLiveFile(live, 0, bytes.subarray(0, 2));
  st.writeLiveFile(live, 2, bytes.subarray(2));
  const commit = st.finishLiveFile(live);
  st.transaction(() => st.commitPreparedFile(commit));
  expect(readFileSync(join(root, "inbox", "a.txt")).toString()).toBe("hello");
});

test("live file abort deletes tmp and does not commit", async () => {
  const { store: st, root } = await store();
  const bytes = Buffer.from("nope");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const live = st.openLiveFile(root, join(root, "inbox", "b.txt"), hash, bytes.length);
  st.writeLiveFile(live, 0, bytes);
  const tmp = join(root, live.temp_rel);
  expect(existsSync(tmp)).toBe(true);
  st.abortLiveFile(live);
  expect(existsSync(tmp)).toBe(false);
  expect(existsSync(join(root, "inbox", "b.txt"))).toBe(false);
});

test("hash mismatch and oversize fail closed", async () => {
  const { store: st, root } = await store();
  const bytes = Buffer.from("abcd");
  const live = st.openLiveFile(root, join(root, "inbox", "c.txt"), "a".repeat(64), bytes.length);
  st.writeLiveFile(live, 0, bytes);
  expect(() => st.finishLiveFile(live)).toThrow(HttpError);
  const live2 = st.openLiveFile(root, join(root, "inbox", "d.txt"), "b".repeat(64), 1);
  expect(() => st.writeLiveFile(live2, 0, bytes)).toThrow(HttpError);
  st.abortLiveFile(live2);
});

test("crash recovery discards uncommitted live tmp", async () => {
  const { store: st, root } = await store();
  const bytes = Buffer.from("recover");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const live = st.openLiveFile(root, join(root, "inbox", "e.txt"), hash, bytes.length);
  st.writeLiveFile(live, 0, bytes);
  const tmp = join(root, live.temp_rel);
  expect(existsSync(tmp)).toBe(true);
  if (live.fd >= 0) { const { closeSync } = await import("node:fs"); closeSync(live.fd); live.fd = -1; }
  st.close();
  const reopened = new Store({ filename: join(root, "state.sqlite"), endpointKey: memoryKeyStore() });
  expect(existsSync(tmp)).toBe(false);
  expect(existsSync(join(root, "inbox", "e.txt"))).toBe(false);
  reopened.close();
});
