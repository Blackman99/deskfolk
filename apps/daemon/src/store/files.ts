import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { commitFile, stageFile, withFileLock } from "../file-integrity";
import { sha256 } from "../request-digest";
import { classifyPath } from "../workspace-paths";
import { HttpError } from "../errors";
import { ulid } from "../ids";
import type { StoreContext } from "./shared";

export type FileCommit = { id: string; root: string; temp_rel: string; final_rel: string; sha256: string };

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
