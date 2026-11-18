import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import type { WorkspaceFileStat } from "@real-bot/protocol";
import { HttpError } from "./errors";

/** How many files' hashes are kept: one per preview someone has open, with room to spare. */
const KEPT = 256;
const CHUNK = 4 * 1024 * 1024;
/**
 * A file this large that changed this recently is still being written (an export, an encode, a
 * growing log): hashing it on every poll would read all of it each second on the runtime's thread.
 * It is answered "still changing" until it has been quiet this long, then hashed once.
 */
export const SETTLING_BYTES = 8 * 1024 * 1024;
export const SETTLING_MS = 2000;

/** A file's hash by where it is, with the stat it was read under. */
const hashes = new Map<string, { stamp: string; etag: string }>();

/**
 * `GET /v1/workspace/stat` and `GET /v1/attachments/:id/stat`: a file's hash, size and modification
 * time, without its bytes. An open preview polls it to see whether its file changed. The hash is
 * the one the file GET puts in its `ETag`, read again only when the file's size, times or inode
 * changed, so polling a file that stays the same reads none of it. A file that changes while it is
 * read is hashed again on the next poll: the stat it is kept under is the one from before the read.
 * A large file still being written is a 409 `file_changing` (`SETTLING_BYTES`), which the preview
 * reads as "no change yet".
 */
export function fileStat(abs: string, now: number = Date.now()): WorkspaceFileStat {
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch {
    throw new HttpError(404, "not_found", "path not found");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new HttpError(422, "invalid_args", "path is not a file");
    const stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
    const kept = hashes.get(abs);
    let etag: string;
    if (kept && kept.stamp === stamp) {
      etag = kept.etag;
      hashes.delete(abs);
    } else if (st.size > SETTLING_BYTES && now - st.mtimeMs < SETTLING_MS) {
      throw new HttpError(409, "file_changing", "file is still being written");
    } else {
      etag = hashOpen(fd);
    }
    hashes.set(abs, { stamp, etag });
    while (hashes.size > KEPT) hashes.delete(hashes.keys().next().value!);
    return { etag, size: st.size, modified_at: new Date(st.mtimeMs).toISOString() };
  } finally {
    closeSync(fd);
  }
}

/** The quoted SHA-256 of an open file, read a piece at a time (`fileEtag` of its whole bytes). */
function hashOpen(fd: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK);
  let position = 0;
  for (;;) {
    const read = readSync(fd, buffer, 0, CHUNK, position);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  return `"${hash.digest("hex")}"`;
}

/** Tests: forget every hash. */
export function forgetFileStats(): void {
  hashes.clear();
}
