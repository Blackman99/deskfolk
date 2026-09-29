import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors";
import { WINDOWS_NO_RECYCLE_BIN, trashWorkspacePaths, windowsTrashArgv, windowsTrashBatches, type TrashMover } from "./workspace-trash";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-trash-")));
  dirs.push(root);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "brief.md"), "# brief\n");
  writeFileSync(join(root, "docs", "notes.md"), "notes\n");
  writeFileSync(join(root, "report.md"), "report\n");
  return root;
}

/** Stands in for the Trash: takes the path away and remembers what it was handed. */
function fakeTrash(): TrashMover & { asked: string[][] } {
  const asked: string[][] = [];
  const move = (async (abs: string[]) => {
    asked.push(abs);
    return abs.map((path) => {
      rmSync(path, { recursive: true });
      return "";
    });
  }) as TrashMover & { asked: string[][] };
  move.asked = asked;
  return move;
}

test("files and folders go to the Trash, and a row inside a picked folder is not asked for again", async () => {
  const root = workspace();
  const move = fakeTrash();
  const result = await trashWorkspacePaths(root, ["docs/brief.md", "docs", "report.md", "./report.md"], move);
  expect(result).toEqual({ trashed: ["docs", "report.md"], failed: [] });
  expect(move.asked).toEqual([[join(root, "docs"), join(root, "report.md")]]);
  expect(existsSync(join(root, "docs"))).toBe(false);
  expect(existsSync(join(root, "report.md"))).toBe(false);
});

/** A repeat of a request whose answer was lost finds the files gone; that is the answer it lost. */
test("a path already gone counts as trashed and is not handed to the Trash", async () => {
  const root = workspace();
  const move = fakeTrash();
  const result = await trashWorkspacePaths(root, ["gone.md", "report.md"], move);
  expect(result).toEqual({ trashed: ["gone.md", "report.md"], failed: [] });
  expect(move.asked).toEqual([[join(root, "report.md")]]);
  expect(await trashWorkspacePaths(root, ["gone.md"], move)).toEqual({ trashed: ["gone.md"], failed: [] });
  expect(move.asked).toHaveLength(1);
});

test("what the Mac refuses stays where it is, with its reason", async () => {
  const root = workspace();
  const move: TrashMover = async (abs) => abs.map((path) => {
    if (path.endsWith("notes.md")) return "permission denied";
    rmSync(path);
    return "";
  });
  const result = await trashWorkspacePaths(root, ["docs/brief.md", "docs/notes.md"], move);
  expect(result).toEqual({ trashed: ["docs/brief.md"], failed: [{ path: "docs/notes.md", message: "permission denied" }] });
  expect(existsSync(join(root, "docs", "notes.md"))).toBe(true);
});

/** `classifyPath` follows a final symlink; trashing one must take the link and leave its target. */
test("a symlink goes to the Trash itself, not what it points at", async () => {
  const root = workspace();
  symlinkSync(join(root, "docs"), join(root, "latest"));
  const move = fakeTrash();
  expect(await trashWorkspacePaths(root, ["latest"], move)).toEqual({ trashed: ["latest"], failed: [] });
  expect(move.asked).toEqual([[join(root, "latest")]]);
  expect(existsSync(join(root, "docs", "brief.md"))).toBe(true);
  expect(() => lstatSync(join(root, "latest"))).toThrow();
});

test("nothing outside the workspace, and never the workspace itself", async () => {
  const root = workspace();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-trash-outside-")));
  dirs.push(outside);
  writeFileSync(join(outside, "keep.md"), "keep\n");
  symlinkSync(outside, join(root, "elsewhere"));
  const move = fakeTrash();
  for (const paths of [[], ["."], [""], ["/etc/hosts"], ["~/notes.md"], ["../x"], ["docs/../../x"], ["elsewhere/keep.md"], [42], "report.md"]) {
    const refused = await trashWorkspacePaths(root, paths, move).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).status).toBe(422);
  }
  expect(move.asked).toHaveLength(0);
  expect(existsSync(join(outside, "keep.md"))).toBe(true);
});

test("on Windows a backslash is a separator too, and drives, shares and streams are refused", async () => {
  const root = workspace();
  const move = fakeTrash();
  for (const path of ["docs/..\\..\\x", "..\\x", "docs\\..\\..\\x", "C:x", "C:\\Windows\\win.ini", "\\\\server\\share\\x", "\\x", "report.md:hidden"]) {
    const refused = await trashWorkspacePaths(root, [path], move, "win32").then(() => null, (error: unknown) => error);
    expect({ path, refused: refused instanceof HttpError }).toEqual({ path, refused: true });
    expect((refused as HttpError).status).toBe(422);
  }
  expect(move.asked).toHaveLength(0);
  // A backslash path inside the workspace still names the file.
  const result = await trashWorkspacePaths(root, ["docs\\brief.md"], move, "win32");
  expect(result.failed).toEqual([]);
  expect(move.asked).toHaveLength(1);
});

describe("windowsTrashArgv (command construction only — never executed here)", () => {
  test("runs PowerShell non-interactively with a fixed script, no profile", () => {
    const argv = windowsTrashArgv("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(argv[0]).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(argv).toContain("-NoProfile");
    expect(argv).toContain("-NonInteractive");
    expect(argv).toContain("-Command");
  });

  test("the script recycles through IFileOperation and refuses an item Windows would destroy", () => {
    const script = windowsTrashArgv("pwsh.exe").at(-1)!;
    expect(script).toContain("IFileOperation");
    // FOFX_RECYCLEONDELETE with every prompt off, and the sink that turns "would nuke" into a refusal.
    expect(script).toContain("0x00080000");
    expect(script).toContain("TSF_DELETE_RECYCLE_IF_POSSIBLE = 0x80");
    expect(script).toContain("return E_ABORT;");
    expect(script).toContain("ApartmentState.STA");
    expect(script).toContain(WINDOWS_NO_RECYCLE_BIN);
    // The paths travel through the environment, never spliced into the script text.
    expect(script).toContain("$env:REAL_BOT_TRASH_PATHS");
    expect(script).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
  });

  test("the script text is identical no matter what the exe path is, and never embeds a path", () => {
    const evilPaths = [
      'C:\\Users\\me\\"; Remove-Item -Recurse -Force C:\\ #',
      "C:\\Users\\me\\$(calc.exe)",
      "C:\\Users\\me\\`; Invoke-Expression 'evil'",
    ];
    const scripts = evilPaths.map(() => windowsTrashArgv("pwsh.exe").at(-1)!);
    // Every generated script is byte-identical: `path` never reaches windowsTrashArgv at all, it
    // is only ever layered on as the REAL_BOT_TRASH_PATHS env var by the caller.
    expect(new Set(scripts).size).toBe(1);
    for (const evil of evilPaths) {
      expect(scripts[0]).not.toContain(evil);
    }
  });
});

describe("windowsTrashBatches", () => {
  test("keeps a normal pick in one batch, in order", () => {
    expect(windowsTrashBatches(["C:\\ws\\a.md", "C:\\ws\\b"])).toEqual([["C:\\ws\\a.md", "C:\\ws\\b"]]);
  });

  test("splits a large pick so every batch's JSON fits the limit, losing nothing", () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `C:\\Users\\me\\工作区\\folder-${i}\\notes-${i}.md`);
    const batches = windowsTrashBatches(paths, 16_000);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(JSON.stringify(batch).length).toBeLessThanOrEqual(16_000);
    expect(batches.flat()).toEqual(paths);
  });

  test("a single path longer than the limit still goes, alone", () => {
    const long = `C:\\${"x".repeat(200)}`;
    expect(windowsTrashBatches(["C:\\a", long, "C:\\b"], 100)).toEqual([["C:\\a"], [long], ["C:\\b"]]);
  });
});

// The one check of the real PowerShell call; only a Windows machine (CI's windows-latest) runs it.
test.skipIf(process.platform !== "win32")("moves a file and a folder with a non-ASCII name to the Recycle Bin", async () => {
  const root = workspace();
  mkdirSync(join(root, "草稿"));
  writeFileSync(join(root, "草稿", "a.md"), "a\n");
  const result = await trashWorkspacePaths(root, ["report.md", "草稿"]);
  expect(result.failed).toEqual([]);
  expect(result.trashed.sort()).toEqual(["report.md", "草稿"].sort());
  expect(existsSync(join(root, "report.md"))).toBe(false);
  expect(existsSync(join(root, "草稿"))).toBe(false);
}, 60_000);
