import { lstatSync } from "node:fs";
import type { WorkspaceTrashResult } from "@real-bot/protocol";
import { HttpError } from "./errors";
import { classifyPath } from "./workspace-paths";

/** One request's worth; the tree lists at most 500 rows a folder, and a picked folder counts once. */
export const WORKSPACE_TRASH_MAX = 1000;

/**
 * Moves absolute paths to the Trash and answers each in order: `""` when it went, the Mac's reason
 * when it did not. The daemon's seam; tests hand in their own.
 */
export type TrashMover = (abs: string[]) => Promise<string[]>;

/**
 * Move workspace files and folders to the Trash, where Finder can put them back.
 *
 * Only the parent of each path is resolved. `classifyPath` follows a symlink in the last segment
 * too, and trashing a link must take the link, not whatever it points at.
 */
export async function trashWorkspacePaths(root: string, input: unknown, move: TrashMover = trashOnMac): Promise<WorkspaceTrashResult> {
  if (!Array.isArray(input) || input.length === 0 || input.length > WORKSPACE_TRASH_MAX || !input.every((path) => typeof path === "string")) {
    throw new HttpError(422, "invalid_args", "paths must list workspace paths");
  }
  const picked = new Map<string, string>();
  for (const raw of input as string[]) {
    const parts = raw.trim().split("/").filter((seg) => seg !== "" && seg !== ".");
    if (raw.trim().startsWith("/") || raw.trim().startsWith("~") || parts.length === 0 || parts.includes("..")) {
      throw new HttpError(422, "invalid_args", "path must be inside the workspace");
    }
    const name = parts.pop()!;
    const parent = classifyPath(root, parts.length ? parts.join("/") : ".");
    if (parent.zone !== "inside") throw new HttpError(422, "invalid_args", "path is outside the workspace");
    picked.set([...parts, name].join("/"), `${parent.abs}/${name}`);
  }
  // A folder takes what is in it, so a row picked inside a picked folder is not asked for again.
  const rels = [...picked.keys()].filter((rel) => ![...picked.keys()].some((other) => other !== rel && rel.startsWith(`${other}/`)));
  const trashed: string[] = [];
  const present: string[] = [];
  for (const rel of rels) {
    if (exists(picked.get(rel)!)) present.push(rel);
    else trashed.push(rel);
  }
  const failed: WorkspaceTrashResult["failed"] = [];
  if (present.length) {
    const answers = await move(present.map((rel) => picked.get(rel)!));
    present.forEach((rel, index) => {
      const answer = answers[index] ?? "no answer";
      if (answer === "" || !exists(picked.get(rel)!)) trashed.push(rel);
      else failed.push({ path: rel, message: answer });
    });
  }
  return { trashed, failed };
}

function exists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * `NSFileManager.trashItem` through JavaScript for Automation: the same Trash Finder uses, back to
 * macOS 13, and no Apple Event to Finder, so no Automation prompt. `/usr/bin/trash` only ships
 * from macOS 15. An error is read through `$()`: a `Ref()` crashes osascript once a path fails.
 */
const TRASH_SCRIPT = `ObjC.import("Foundation");
function run(argv) {
  const fm = $.NSFileManager.defaultManager;
  return JSON.stringify(argv.map((path) => {
    const error = $();
    const ok = fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), null, error);
    return ok ? "" : (ObjC.unwrap(error.localizedDescription) || "could not move to the Trash");
  }));
}`;

async function trashOnMac(abs: string[]): Promise<string[]> {
  if (process.platform !== "darwin") throw new HttpError(422, "unsupported", "moving to the Trash needs macOS");
  const child = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", TRASH_SCRIPT, ...abs], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  try {
    const answers = JSON.parse(out) as unknown;
    if (Array.isArray(answers) && answers.every((answer) => typeof answer === "string")) return answers;
  } catch {
    // Read below as a failure of the whole call.
  }
  const reason = err.trim() || `osascript exited ${code}`;
  return abs.map(() => reason);
}
