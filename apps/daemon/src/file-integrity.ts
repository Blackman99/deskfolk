import { chmodSync, closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HttpError } from "./errors";
import { ulid } from "./ids";
import { sha256 } from "./request-digest";

const held = new Set<string>();

/** All daemon writers use synchronous critical sections; no lock survives an await. */
export function withFileLock<T>(abs: string, work: () => T): T {
  if (held.has(abs)) throw new HttpError(409, "conflict", "file is being written");
  held.add(abs);
  try {
    const result = work();
    if (result instanceof Promise) throw new Error("file lock callback must be synchronous");
    return result;
  } finally { held.delete(abs); }
}

export function fileEtag(bytes: Uint8Array): string {
  return `"${sha256(bytes)}"`;
}

/**
 * `open` + `fsync` a directory to make sure a rename or unlink inside it survives a crash. Windows
 * has no such thing — opening a directory this way fails with EISDIR/EPERM — and NTFS journals
 * metadata changes itself, so this is a no-op there rather than an error every writer would have
 * to swallow.
 */
export function syncDirectory(path: string, platform: string = process.platform): void {
  if (platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** A handful of short, synchronous waits — at most ~200ms total — never a real sleep loop. */
const RENAME_RETRY_DELAYS_MS = [5, 10, 25, 50, 100];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/**
 * `renameSync` over a destination another process has open — antivirus, a search indexer, an
 * editor with the file mapped — throws EPERM/EBUSY/EACCES on Windows for a few milliseconds, not
 * because the rename is actually invalid. POSIX renames are atomic and never contend like this, so
 * there this is exactly today's single `renameSync` call.
 */
export function renameReplacing(
  tmp: string,
  dest: string,
  platform: string = process.platform,
  rename: (from: string, to: string) => void = renameSync,
): void {
  if (platform !== "win32") {
    rename(tmp, dest);
    return;
  }
  let liftedReadOnly = false;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, dest);
      // The replacement keeps the target read-only, as POSIX keeps the target's mode.
      if (liftedReadOnly) chmodSync(dest, 0o444);
      return;
    } catch (error) {
      // Windows will not replace a file that has the read-only attribute (POSIX only asks the
      // folder), so lift it once and try again.
      if (!liftedReadOnly && isTransientRenameError(error) && isReadOnly(dest)) {
        chmodSync(dest, 0o666);
        liftedReadOnly = true;
        continue;
      }
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isTransientRenameError(error)) throw error;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

function isReadOnly(path: string): boolean {
  try {
    return (statSync(path).mode & 0o200) === 0;
  } catch {
    return false;
  }
}

export function stageFile(
  abs: string,
  bytes: Uint8Array | string,
  tmp = join(dirname(abs), `.real-bot-stage-${ulid()}`),
  platform: string = process.platform,
): string {
  // A read-only target (Windows' read-only attribute, surfaced in `statSync().mode`) must never
  // make its staged replacement read-only too: that temp file is renamed over the target next, and
  // a read-only temp file cannot be renamed away on Windows. POSIX keeps copying the target's mode,
  // e.g. to preserve an executable bit across a rewrite.
  const mode = platform !== "win32" && existsSync(abs) ? statSync(abs).mode & 0o777 : 0o600;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    // Windows cannot unlink a file that still has an open handle; closing first is required there
    // and harmless on POSIX, where the fd would otherwise be closed by the `finally` below anyway.
    closeSync(fd);
    unlinkSync(tmp);
    throw error;
  }
  closeSync(fd);
  syncDirectory(dirname(tmp), platform);
  return tmp;
}

export function commitFile(tmp: string, abs: string, platform: string = process.platform): void {
  renameReplacing(tmp, abs, platform);
  syncDirectory(dirname(abs), platform);
}

export function atomicWrite(abs: string, content: string, ifMatch?: string | null): string {
  return withFileLock(abs, () => {
    if (ifMatch !== undefined && ifMatch !== null && (!existsSync(abs) || fileEtag(readFileSync(abs)) !== ifMatch)) {
      throw new HttpError(409, "conflict", "file changed; reload before saving");
    }
    const tmp = stageFile(abs, content);
    try { commitFile(tmp, abs); }
    finally { if (existsSync(tmp)) unlinkSync(tmp); }
    return fileEtag(Buffer.from(content));
  });
}
