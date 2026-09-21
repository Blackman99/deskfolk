import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import { commitFile, stageFile, syncDirectory, withFileLock } from "../file-integrity";
import { sha256 } from "../request-digest";
import { classifyPath } from "../workspace-paths";
import { HttpError } from "../errors";
import { ulid } from "../ids";
import type { StoreContext } from "./shared";

export type FileCommit = { id: string; root: string; temp_rel: string; final_rel: string; sha256: string };
export type LiveFile = FileCommit & {
  expected: string;
  size: number;
  offset: number;
  fd: number;
  hasher: ReturnType<typeof createHash>;
};

export function prepareFile(ctx: StoreContext, root: string, abs: string, bytes: Uint8Array | string): FileCommit {
  if (ctx.db.inTransaction) throw new Error("files must be staged before the business transaction");
  root = realpathSync(root);
  const target = classifyPath(root, abs);
  if (target.zone !== "inside") throw new HttpError(422, "invalid_args", "file target is outside workspace");
  const id = ulid();
  const tmp = join(dirname(target.abs), `.real-bot-stage-${id}`);
  const row: FileCommit = { id, root, temp_rel: relative(root, tmp), final_rel: target.rel, sha256: sha256(typeof bytes === "string" ? Buffer.from(bytes) : bytes) };
  ctx.db.run("INSERT INTO file_stages(id, root, temp_rel, final_rel, sha256) VALUES (?, ?, ?, ?, ?)", [row.id, root, row.temp_rel, row.final_rel, row.sha256]);
  ctx.activeStages.add(id);
  try { stageFile(target.abs, bytes, tmp); }
  catch (error) { discardFile(ctx, row); throw error; }
  return row;
}

/** Open a same-directory tmp for sequential type-0x05 writes. Commit only after EOF hash. */
export function openLiveFile(ctx: StoreContext, root: string, abs: string, expected: string, size: number): LiveFile {
  if (ctx.db.inTransaction) throw new Error("files must be staged before the business transaction");
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new HttpError(422, "invalid_args", "file digest required");
  if (!Number.isInteger(size) || size < 0) throw new HttpError(422, "invalid_args", "file size required");
  root = realpathSync(root);
  const target = classifyPath(root, abs);
  if (target.zone !== "inside") throw new HttpError(422, "invalid_args", "file target is outside workspace");
  const id = ulid();
  const tmp = join(dirname(target.abs), `.real-bot-stage-${id}`);
  const row: LiveFile = {
    id, root, temp_rel: relative(root, tmp), final_rel: target.rel, sha256: expected,
    expected, size, offset: 0, fd: -1, hasher: createHash("sha256"),
  };
  ctx.db.run("INSERT INTO file_stages(id, root, temp_rel, final_rel, sha256) VALUES (?, ?, ?, ?, ?)", [row.id, root, row.temp_rel, row.final_rel, row.sha256]);
  ctx.activeStages.add(id);
  try {
    row.fd = openSync(tmp, "wx", 0o600);
  } catch (error) {
    discardFile(ctx, row);
    throw error;
  }
  return row;
}

export function writeLiveFile(live: LiveFile, offset: number, chunk: Uint8Array): void {
  if (live.fd < 0) throw new HttpError(409, "conflict", "upload is not open");
  if (offset !== live.offset) throw new HttpError(422, "invalid_args", "file offset is not sequential");
  if (live.offset + chunk.length > live.size) throw new HttpError(413, "file_limit", "file too large");
  writeSync(live.fd, chunk);
  live.hasher.update(chunk);
  live.offset += chunk.length;
}

export function finishLiveFile(ctx: StoreContext, live: LiveFile): FileCommit {
  if (live.fd < 0) throw new HttpError(409, "conflict", "upload is not open");
  if (live.offset !== live.size) throw new HttpError(422, "invalid_args", "file ended before declared size");
  const digest = live.hasher.digest("hex");
  try {
    if (digest !== live.expected) throw new HttpError(422, "invalid_args", "file hash mismatch");
    fsyncSync(live.fd);
  } finally {
    closeSync(live.fd);
    live.fd = -1;
  }
  syncDirectory(dirname(safePaths(live).tmp));
  return { id: live.id, root: live.root, temp_rel: live.temp_rel, final_rel: live.final_rel, sha256: digest };
}

export function abortLiveFile(ctx: StoreContext, live: LiveFile): void {
  if (live.fd >= 0) {
    try { closeSync(live.fd); } catch { /* tmp is discarded below */ }
    live.fd = -1;
  }
  discardFile(ctx, live);
}

export function commitPreparedFile(ctx: StoreContext, row: FileCommit): void {
  ctx.db.run("INSERT INTO file_commits SELECT * FROM file_stages WHERE id = ?", [row.id]);
  ctx.db.run("DELETE FROM file_stages WHERE id = ?", [row.id]);
  ctx.tx.afterRollback(() => discardFile(ctx, row));
  ctx.tx.afterCommit(() => {
    ctx.activeStages.delete(row.id);
    finish(ctx, row);
  });
}

export function discardFile(ctx: StoreContext, row: FileCommit): void {
  if (ctx.db.query("SELECT 1 FROM file_commits WHERE id = ?").get(row.id)) return;
  const tmp = safePaths(row).tmp;
  if (existsSync(tmp)) unlinkSync(tmp);
  ctx.db.run("DELETE FROM file_stages WHERE id = ?", [row.id]);
  ctx.activeStages.delete(row.id);
}

function safePaths(row: FileCommit): { tmp: string; target: string } {
  const tmp = classifyPath(row.root, row.temp_rel);
  const target = classifyPath(row.root, row.final_rel);
  if (tmp.zone !== "inside" || target.zone !== "inside" || basename(tmp.abs) !== `.real-bot-stage-${row.id}`) {
    throw new Error("unsafe pending file path");
  }
  return { tmp: tmp.abs, target: target.abs };
}

function finish(ctx: StoreContext, row: FileCommit): void {
  const { tmp, target } = safePaths(row);
  withFileLock(target, () => {
    if (existsSync(tmp)) {
      if (sha256(readFileSync(tmp)) !== row.sha256) throw new Error("staged file hash mismatch");
      commitFile(tmp, target);
    } else if (!existsSync(target) || sha256(readFileSync(target)) !== row.sha256) {
      throw new Error("committed file is missing or changed; recovery required");
    }
    ctx.db.run("DELETE FROM file_commits WHERE id = ?", [row.id]);
  });
}

export function recoverFiles(ctx: StoreContext): void {
  for (const row of ctx.db.query<FileCommit, []>("SELECT * FROM file_commits ORDER BY rowid").all()) finish(ctx, row);
  for (const row of ctx.db.query<FileCommit, []>("SELECT * FROM file_stages").all()) {
    if (!ctx.activeStages.has(row.id)) discardFile(ctx, row);
  }
}
