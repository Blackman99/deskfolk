import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceTrashResult } from "@real-bot/protocol";
import { HttpError } from "./errors";
import { resolvePowerShell } from "./platform";
import { classifyPath } from "./workspace-paths";

/** One request's worth; the tree lists at most 500 rows a folder, and a picked folder counts once. */
export const WORKSPACE_TRASH_MAX = 1000;

/**
 * Moves absolute paths to the Trash and answers each in order: `""` when it went, the OS's reason
 * when it did not. The daemon's seam; tests hand in their own.
 */
export type TrashMover = (abs: string[]) => Promise<string[]>;

/**
 * Move workspace files and folders to the Trash, where Finder can put them back.
 *
 * Only the parent of each path is resolved. `classifyPath` follows a symlink in the last segment
 * too, and trashing a link must take the link, not whatever it points at.
 */
export async function trashWorkspacePaths(root: string, input: unknown, move: TrashMover = defaultTrashMover): Promise<WorkspaceTrashResult> {
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
    picked.set([...parts, name].join("/"), join(parent.abs, name));
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

/**
 * `Microsoft.VisualBasic.FileIO.FileSystem`'s delete methods are the only stock Windows API that
 * sends to the Recycle Bin instead of deleting for good, and PowerShell is the only stock shell
 * that can reach a .NET assembly without a helper binary. `OnlyErrorDialogs`/`SendToRecycleBin`
 * mirror what Explorer's own Delete does. The paths are never interpolated into the script text:
 * the script is the same for every call, and the paths travel as a JSON array in the
 * `REAL_BOT_TRASH_PATHS` environment variable, so nothing in a path can be read as PowerShell.
 * It answers with a JSON array like the macOS script: `""` for each path that went, else why not.
 * Output is forced to UTF-8, or a Chinese Windows would hand back its reasons in GBK.
 */
const WINDOWS_TRASH_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName Microsoft.VisualBasic
$answers = @()
# Assigned first: Windows PowerShell 5.1's ConvertFrom-Json emits an array as one object, which
# @(...) would wrap again; foreach over the variable walks it in both 5.1 and 7.
$paths = ConvertFrom-Json $env:REAL_BOT_TRASH_PATHS
foreach ($target in $paths) {
  try {
    if (Test-Path -LiteralPath $target -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
        $target,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    } elseif (Test-Path -LiteralPath $target) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $target,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    }
    $answers += ''
  } catch {
    $answers += [string]$_.Exception.Message
  }
}
ConvertTo-Json -InputObject @($answers) -Compress
`;

/**
 * The argv for one Recycle Bin call. Pure and exported so the construction can be checked without
 * a Windows machine to run it on: the script text never changes between calls (only the env var
 * the caller layers on top does), which is the property that rules out injection through a path.
 */
export function windowsTrashArgv(exe: string): string[] {
  return [exe, "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TRASH_SCRIPT];
}

/**
 * A Windows environment variable holds at most 32,767 characters, and a request can pick 1,000
 * rows, so the paths go in batches that each fit with room to spare — one PowerShell per batch,
 * one batch after another, rather than one process per path.
 */
export function windowsTrashBatches(abs: string[], limit = 16_000): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const path of abs) {
    if (current.length && JSON.stringify([...current, path]).length > limit) {
      batches.push(current);
      current = [];
    }
    current.push(path);
  }
  if (current.length) batches.push(current);
  return batches;
}

async function trashBatchOnWindows(exe: string, batch: string[]): Promise<string[]> {
  try {
    const child = Bun.spawn(windowsTrashArgv(exe), {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, REAL_BOT_TRASH_PATHS: JSON.stringify(batch) },
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    try {
      const answers = JSON.parse(out.trim()) as unknown;
      // ConvertTo-Json unwraps nothing here (-InputObject @(...)), but be lenient about a lone string.
      const list = Array.isArray(answers) ? answers : [answers];
      if (list.length === batch.length && list.every((answer) => typeof answer === "string")) return list as string[];
    } catch {
      // Read below as a failure of the whole call.
    }
    const reason = err.trim() || `powershell exited ${code}`;
    return batch.map(() => reason);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "could not move to the Recycle Bin";
    return batch.map(() => reason);
  }
}

async function trashOnWindows(abs: string[]): Promise<string[]> {
  const exe = resolvePowerShell();
  const answers: string[] = [];
  for (const batch of windowsTrashBatches(abs)) answers.push(...(await trashBatchOnWindows(exe, batch)));
  return answers;
}

async function defaultTrashMover(abs: string[]): Promise<string[]> {
  if (process.platform === "win32") return trashOnWindows(abs);
  if (process.platform === "darwin") return trashOnMac(abs);
  throw new HttpError(422, "unsupported", "moving to the Trash needs macOS or Windows");
}
