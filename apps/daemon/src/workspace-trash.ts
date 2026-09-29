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
export async function trashWorkspacePaths(
  root: string,
  input: unknown,
  move: TrashMover = defaultTrashMover,
  platform: NodeJS.Platform = process.platform,
): Promise<WorkspaceTrashResult> {
  if (!Array.isArray(input) || input.length === 0 || input.length > WORKSPACE_TRASH_MAX || !input.every((path) => typeof path === "string")) {
    throw new HttpError(422, "invalid_args", "paths must list workspace paths");
  }
  // Windows reads `\` as a separator too, so `docs/..\..\x` must not pass as one name, and a `:`
  // in a segment is a drive (`C:x`) or an alternate data stream (`a.md:x`), never a file name.
  const windows = platform === "win32";
  const picked = new Map<string, string>();
  for (const raw of input as string[]) {
    const trimmed = raw.trim();
    const parts = trimmed.split(windows ? /[\\/]/ : "/").filter((seg) => seg !== "" && seg !== ".");
    if (
      /^[/~]/.test(trimmed) ||
      (windows && (trimmed.startsWith("\\") || parts.some((seg) => seg.includes(":")))) ||
      parts.length === 0 ||
      parts.includes("..")
    ) {
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

/** The answer for a path Windows would have deleted for good instead of recycling. */
export const WINDOWS_NO_RECYCLE_BIN = "there is no Recycle Bin here to put it back from, so it was left where it is";

/**
 * The shell's own `IFileOperation`, through PowerShell (the only stock shell that reaches COM
 * without a helper binary), deleting with `FOFX_RECYCLEONDELETE` and no UI. With the prompts off,
 * Windows does not fail an item it cannot recycle — a network share, a USB stick, a `subst`
 * drive, a file bigger than the bin, a drive whose bin is switched off — it deletes it for good,
 * and a hidden PowerShell could not show the prompt anyway. So a progress sink watches each item:
 * `PreDeleteItem` without `TSF_DELETE_RECYCLE_IF_POSSIBLE` is exactly "this one is about to be
 * destroyed", and the sink refuses it. Each path is its own operation, so a refusal or a failure
 * answers for that path only, and the whole thing runs on an STA thread, as `IFileOperation`
 * requires whatever apartment the PowerShell host is in.
 *
 * The paths are never interpolated into the script text: the script is the same for every call,
 * and the paths travel as a JSON array in the `REAL_BOT_TRASH_PATHS` environment variable, so
 * nothing in a path can be read as PowerShell. It answers with a JSON array like the macOS
 * script: `""` for each path that went, else why not. Output is forced to UTF-8, or a Chinese
 * Windows would hand back its reasons in GBK.
 */
const WINDOWS_TRASH_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace RealBot {
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [ComImport, Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperationProgressSink {
    [PreserveSig] int StartOperations();
    [PreserveSig] int FinishOperations(int hrResult);
    [PreserveSig] int PreRenameItem(uint dwFlags, IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    [PreserveSig] int PostRenameItem(uint dwFlags, IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, int hrRename, IShellItem psiNewlyCreated);
    [PreserveSig] int PreMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    [PreserveSig] int PostMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, int hrMove, IShellItem psiNewlyCreated);
    [PreserveSig] int PreCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    [PreserveSig] int PostCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, int hrCopy, IShellItem psiNewlyCreated);
    [PreserveSig] int PreDeleteItem(uint dwFlags, IShellItem psiItem);
    [PreserveSig] int PostDeleteItem(uint dwFlags, IShellItem psiItem, int hrDelete, IShellItem psiNewlyCreated);
    [PreserveSig] int PreNewItem(uint dwFlags, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    [PreserveSig] int PostNewItem(uint dwFlags, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, [MarshalAs(UnmanagedType.LPWStr)] string pszTemplateName, uint dwFileAttributes, int hrNew, IShellItem psiNewItem);
    [PreserveSig] int UpdateProgress(uint iWorkTotal, uint iWorkSoFar);
    [PreserveSig] int ResetTimer();
    [PreserveSig] int PauseTimer();
    [PreserveSig] int ResumeTimer();
  }

  [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperation {
    uint Advise(IFileOperationProgressSink pfops);
    void Unadvise(uint dwCookie);
    void SetOperationFlags(uint dwOperationFlags);
    void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string pszMessage);
    void SetProgressDialog(IntPtr popd);
    void SetProperties(IntPtr pproparray);
    void SetOwnerWindow(IntPtr hwndOwner);
    void ApplyPropertiesToItem(IShellItem psiItem);
    void ApplyPropertiesToItems(IntPtr punkItems);
    void RenameItem(IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IFileOperationProgressSink pfopsItem);
    void RenameItems(IntPtr pUnkItems, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    void MoveItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IFileOperationProgressSink pfopsItem);
    void MoveItems(IntPtr punkItems, IShellItem psiDestinationFolder);
    void CopyItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszCopyName, IFileOperationProgressSink pfopsItem);
    void CopyItems(IntPtr punkItems, IShellItem psiDestinationFolder);
    void DeleteItem(IShellItem psiItem, IFileOperationProgressSink pfopsItem);
    void DeleteItems(IntPtr punkItems);
    uint NewItem(IShellItem psiDestinationFolder, uint dwFileAttributes, [MarshalAs(UnmanagedType.LPWStr)] string pszName, [MarshalAs(UnmanagedType.LPWStr)] string pszTemplateName, IFileOperationProgressSink pfopsItem);
    void PerformOperations();
    [return: MarshalAs(UnmanagedType.Bool)] bool GetAnyOperationsAborted();
  }

  public class RecycleSink : IFileOperationProgressSink {
    const uint TSF_DELETE_RECYCLE_IF_POSSIBLE = 0x80;
    const int E_ABORT = unchecked((int)0x80004004);
    public bool Refused;
    public int Deleted;
    public int StartOperations() { return 0; }
    public int FinishOperations(int hrResult) { return 0; }
    public int PreRenameItem(uint dwFlags, IShellItem psiItem, string pszNewName) { return 0; }
    public int PostRenameItem(uint dwFlags, IShellItem psiItem, string pszNewName, int hrRename, IShellItem psiNewlyCreated) { return 0; }
    public int PreMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, string pszNewName) { return 0; }
    public int PostMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, string pszNewName, int hrMove, IShellItem psiNewlyCreated) { return 0; }
    public int PreCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, string pszNewName) { return 0; }
    public int PostCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder, string pszNewName, int hrCopy, IShellItem psiNewlyCreated) { return 0; }
    public int PreDeleteItem(uint dwFlags, IShellItem psiItem) {
      if ((dwFlags & TSF_DELETE_RECYCLE_IF_POSSIBLE) != 0) return 0;
      Refused = true;
      return E_ABORT;
    }
    public int PostDeleteItem(uint dwFlags, IShellItem psiItem, int hrDelete, IShellItem psiNewlyCreated) { Deleted = hrDelete; return 0; }
    public int PreNewItem(uint dwFlags, IShellItem psiDestinationFolder, string pszNewName) { return 0; }
    public int PostNewItem(uint dwFlags, IShellItem psiDestinationFolder, string pszNewName, string pszTemplateName, uint dwFileAttributes, int hrNew, IShellItem psiNewItem) { return 0; }
    public int UpdateProgress(uint iWorkTotal, uint iWorkSoFar) { return 0; }
    public int ResetTimer() { return 0; }
    public int PauseTimer() { return 0; }
    public int ResumeTimer() { return 0; }
  }

  public static class Recycle {
    // FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR | FOF_NOERRORUI | FOFX_RECYCLEONDELETE
    const uint Flags = 0x0004 | 0x0010 | 0x0040 | 0x0200 | 0x0400 | 0x00080000;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);

    public static string[] All(string[] paths, string noRecycleBin) {
      string[] answers = new string[paths.Length];
      Thread thread = new Thread(delegate () {
        for (int i = 0; i < paths.Length; i++) answers[i] = One(paths[i], noRecycleBin);
      });
      thread.SetApartmentState(ApartmentState.STA);
      thread.Start();
      thread.Join();
      return answers;
    }

    static string One(string path, string noRecycleBin) {
      try {
        Guid iid = typeof(IShellItem).GUID;
        IShellItem item;
        SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
        IFileOperation op = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
        RecycleSink sink = new RecycleSink();
        op.SetOperationFlags(Flags);
        op.Advise(sink);
        op.DeleteItem(item, null);
        try {
          op.PerformOperations();
        } catch (COMException) {
          if (!sink.Refused) throw;
        }
        if (sink.Refused) return noRecycleBin;
        if (sink.Deleted < 0) return Marshal.GetExceptionForHR(sink.Deleted).Message;
        if (op.GetAnyOperationsAborted()) return "the Recycle Bin move was cancelled";
        return "";
      } catch (Exception e) {
        return e.Message;
      }
    }
  }
}
'@
# Assigned first: Windows PowerShell 5.1's ConvertFrom-Json emits an array as one object, which
# @(...) would wrap again; the [string[]] cast reads it the same way in both 5.1 and 7.
$paths = ConvertFrom-Json $env:REAL_BOT_TRASH_PATHS
$answers = [RealBot.Recycle]::All([string[]]$paths, '${WINDOWS_NO_RECYCLE_BIN}')
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
