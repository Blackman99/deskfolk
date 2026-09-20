import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function stageFile(abs: string, bytes: Uint8Array | string, tmp = join(dirname(abs), `.real-bot-stage-${ulid()}`)): string {
  const mode = existsSync(abs) ? statSync(abs).mode & 0o777 : 0o600;
  const fd = openSync(tmp, "wx", mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  catch (error) { unlinkSync(tmp); throw error; }
  finally { closeSync(fd); }
  syncDirectory(dirname(tmp));
  return tmp;
}

export function commitFile(tmp: string, abs: string): void {
  renameSync(tmp, abs);
  syncDirectory(dirname(abs));
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
