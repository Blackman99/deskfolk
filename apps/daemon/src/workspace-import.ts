import { cp, lstat, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import type { WorkspaceImportResult } from "@real-bot/protocol";
import { HttpError } from "./errors";
import { writableTarget } from "./workspace-browse";
import { classifyPath, expandHome, isAbsoluteHostPath } from "./workspace-paths";

/** One request's worth, as the Trash takes; a dropped folder counts once. */
export const WORKSPACE_IMPORT_MAX = 1000;

/** Copies a file or a folder with what is in it to `dest`, which does not exist yet. The daemon's seam; tests hand in their own. */
export type ImportCopier = (source: string, dest: string) => Promise<void>;

/**
 * A copy, not a move, as when files go from Finder into an app. Links inside a folder stay links;
 * the folder is written in full or not at all (see below).
 */
const copyWithFs: ImportCopier = (source, dest) =>
  cp(source, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });

/** One import at a time, so two drops of the same name do not both pick the same free one. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * `POST /v1/workspace/import`: files and folders from elsewhere on this Mac (dropped on the file
 * tree from Finder), copied into a workspace folder or a folder in a project session's directory
 * (`dir`, as `PUT /v1/workspace/file` takes a path). A name already taken there gets `-1`, `-2`
 * before its extension, as files sent in chat do in `inbox/`; nothing is overwritten. A source
 * already in that folder is left as it is and answered with its own name. Each source is answered
 * on its own: a folder into itself, a source gone or unreadable fails alone, and a copy that
 * failed partway is taken away again.
 */
export function importIntoWorkspace(
  workspace: string | null,
  projectDirs: readonly string[],
  input: { dir?: unknown; sources?: unknown },
  copy: ImportCopier = copyWithFs,
): Promise<WorkspaceImportResult> {
  const { dir, sources } = input;
  if (typeof dir !== "string") throw new HttpError(422, "invalid_args", "dir must be a folder path");
  if (
    !Array.isArray(sources) || sources.length === 0 || sources.length > WORKSPACE_IMPORT_MAX ||
    !sources.every((source) => typeof source === "string" && isAbsoluteHostPath(expandHome(source.trim())))
  ) {
    throw new HttpError(422, "invalid_args", "sources must list absolute paths on this computer");
  }
  const target = writableTarget(workspace, projectDirs, dir.trim() || ".");
  const folder = classifyPath(target.root, target.rel.trim() || ".");
  if (folder.zone !== "inside") throw new HttpError(422, "invalid_args", "dir is outside the workspace");
  const run = queue.then(() => importInto(folder.abs, (sources as string[]).map((source) => expandHome(source.trim())), copy));
  queue = run.catch(() => undefined);
  return run;
}

async function importInto(folderAbs: string, sources: string[], copy: ImportCopier): Promise<WorkspaceImportResult> {
  let into: string;
  try {
    if (!(await stat(folderAbs)).isDirectory()) throw new HttpError(422, "invalid_args", "dir is not a folder");
    into = await realpath(folderAbs);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "not_found", "folder not found");
  }
  const imported: WorkspaceImportResult["imported"] = [];
  const failed: WorkspaceImportResult["failed"] = [];
  for (const source of sources) {
    let real: string;
    let isDir: boolean;
    try {
      isDir = (await lstat(source)).isDirectory();
      real = await realpath(source);
    } catch {
      failed.push({ source, code: "missing", message: "not found" });
      continue;
    }
    // `relative` rather than a prefix test, so a source that is a disk's root (`/`) holds everything too.
    const down = relative(real, into);
    const beside = down === ".." || down.startsWith("../") || down.startsWith("..\\") || isAbsolute(down);
    if (!beside || !basename(real)) {
      failed.push({ source, code: "into_itself", message: "a folder cannot be copied into itself" });
      continue;
    }
    if (dirname(real) === into) {
      imported.push({ source, name: basename(real) });
      continue;
    }
    const name = await freeName(into, basename(source), isDir);
    const dest = join(into, name);
    try {
      await copy(source, dest);
      imported.push({ source, name });
    } catch (error) {
      // The name was free when picked, so whatever is there now is this copy's.
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      failed.push({ source, code: "copy_failed", message: error instanceof Error && error.message ? error.message : String(error) });
    }
  }
  return { imported, failed };
}

async function freeName(into: string, raw: string, isDir: boolean): Promise<string> {
  const ext = isDir ? "" : extname(raw);
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  let name = raw;
  for (let counter = 1; await taken(join(into, name)); counter++) name = `${stem}-${counter}${ext}`;
  return name;
}

async function taken(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
}
