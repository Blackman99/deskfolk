import { cp, lstat, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type { WorkspaceMoveResult } from "@real-bot/protocol";
import { HttpError } from "./errors";
import { writableTarget } from "./workspace-browse";
import { classifyPath, expandHome } from "./workspace-paths";

/** One request's worth, as the Trash takes; a folder dragged counts once. */
export const WORKSPACE_MOVE_MAX = 1000;

/** Moves `from` to `to`, which does not exist yet. The daemon's seam; tests hand in their own. */
export type Mover = (from: string, to: string) => Promise<void>;

/**
 * A rename where both are on one volume. Across volumes (`EXDEV`: a project on an external disk)
 * it copies, links staying links, and takes the source away only once the copy is whole.
 */
const moveWithFs: Mover = async (from, to) => {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    try {
      await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    } catch (copyError) {
      await rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw copyError;
    }
    await rm(from, { recursive: true, force: true });
  }
};

/** One move at a time, so two drags of the same name do not both find it free. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * `POST /v1/workspace/move`: rows dragged inside a file tree, moved into another folder. `dir` and
 * each source are written as the tree writes them (as `PUT /v1/workspace/file` takes a path): a
 * workspace path, or one in a project session's directory written absolute; anywhere else is
 * refused. Nothing is overwritten: a name already in `dir` fails that source (`exists`). A source
 * already in `dir` is left as it is. Only a source's folder is resolved, so a link moves as a link
 * rather than the file it points at. Each source is answered on its own: gone (`missing`), outside
 * the workspace and every project (`outside`), a folder into itself (`into_itself`), taken
 * (`exists`), or the system refused (`move_failed`, its words in `message`).
 */
export function moveInWorkspace(
  workspace: string | null,
  projectDirs: readonly string[],
  input: { dir?: unknown; sources?: unknown },
  move: Mover = moveWithFs,
): Promise<WorkspaceMoveResult> {
  const { dir, sources } = input;
  if (typeof dir !== "string") throw new HttpError(422, "invalid_args", "dir must be a folder path");
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > WORKSPACE_MOVE_MAX || !sources.every((source) => typeof source === "string" && source.trim())) {
    throw new HttpError(422, "invalid_args", "sources must list paths in the workspace or a project");
  }
  const target = writableTarget(workspace, projectDirs, dir.trim() || ".");
  const folder = classifyPath(target.root, target.rel.trim() || ".");
  if (folder.zone !== "inside") throw new HttpError(422, "invalid_args", "dir is outside the workspace");
  const run = queue.then(() => moveInto(workspace, projectDirs, folder.abs, sources as string[], move));
  queue = run.catch(() => undefined);
  return run;
}

/** Where a source sits, its own name kept: only its folder is resolved. Null when it is outside, or a root. */
function locate(workspace: string | null, projectDirs: readonly string[], source: string): string | null {
  let target: { root: string; rel: string };
  try {
    target = writableTarget(workspace, projectDirs, source.trim());
  } catch {
    return null;
  }
  const rel = expandHome(target.rel.trim()).replace(/[\\/]+$/, "");
  const name = basename(rel);
  if (!name || name === "." || name === "..") return null;
  const parentRel = rel.slice(0, rel.length - name.length).replace(/[\\/]+$/, "") || (isAbsolute(rel) ? rel.slice(0, 1) : ".");
  try {
    const parent = classifyPath(target.root, parentRel);
    return parent.zone === "inside" ? join(parent.abs, name) : null;
  } catch {
    return null;
  }
}

async function moveInto(workspace: string | null, projectDirs: readonly string[], folderAbs: string, sources: string[], move: Mover): Promise<WorkspaceMoveResult> {
  let into: string;
  try {
    if (!(await stat(folderAbs)).isDirectory()) throw new HttpError(422, "invalid_args", "dir is not a folder");
    into = await realpath(folderAbs);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "not_found", "folder not found");
  }
  const moved: WorkspaceMoveResult["moved"] = [];
  const failed: WorkspaceMoveResult["failed"] = [];
  for (const source of sources) {
    const from = locate(workspace, projectDirs, source);
    if (!from) {
      failed.push({ source, code: "outside", message: "not in the workspace or a project" });
      continue;
    }
    let isDir: boolean;
    try {
      isDir = (await lstat(from)).isDirectory();
    } catch {
      failed.push({ source, code: "missing", message: "not found" });
      continue;
    }
    const name = basename(from);
    const parent = await realpath(join(from, "..")).catch(() => "");
    if (parent === into) {
      moved.push({ source, name });
      continue;
    }
    if (isDir) {
      const real = await realpath(from).catch(() => from);
      const down = relative(real, into);
      const beside = down === ".." || down.startsWith("../") || down.startsWith("..\\") || isAbsolute(down);
      if (!beside) {
        failed.push({ source, code: "into_itself", message: "a folder cannot be moved into itself" });
        continue;
      }
    }
    const to = join(into, name);
    if (await exists(to)) {
      failed.push({ source, code: "exists", message: "a file or folder of that name is already there" });
      continue;
    }
    try {
      await move(from, to);
      moved.push({ source, name });
    } catch (error) {
      failed.push({ source, code: "move_failed", message: error instanceof Error && error.message ? error.message : String(error) });
    }
  }
  return { moved, failed };
}

async function exists(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
}
