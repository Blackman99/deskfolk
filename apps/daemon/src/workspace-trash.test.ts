import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors";
import { trashWorkspacePaths, type TrashMover } from "./workspace-trash";

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
