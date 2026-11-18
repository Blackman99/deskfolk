import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors";
import { ulid } from "./ids";
import { validateBusiness } from "./remote/routes";
import { auth, registerLocalApiCleanup, startLocalApi } from "./test-kit/local-api-harness";
import { importIntoWorkspace, type ImportCopier } from "./workspace-import";

registerLocalApiCleanup();

const made: string[] = [];
const dir = (prefix: string) => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(path);
  return path;
};
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Finder's side: a file, a folder with a file in it, and a file named like one already in the workspace. */
function desktop(): string {
  const from = dir("real-bot-import-from-");
  writeFileSync(join(from, "report.pdf"), "%PDF-1.7\n");
  mkdirSync(join(from, "photos"));
  writeFileSync(join(from, "photos", "a.jpg"), "jpg");
  writeFileSync(join(from, "notes.md"), "# from Finder\n");
  return from;
}

async function refusal(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  return 200;
}

describe("files dropped on the file tree", () => {
  test("files and folders are copied where they landed, a taken name gets the next free one, nothing is overwritten", async () => {
    const ws = dir("real-bot-import-ws-");
    mkdirSync(join(ws, "docs"));
    writeFileSync(join(ws, "notes.md"), "# mine\n");
    writeFileSync(join(ws, "docs", "report.pdf"), "old");
    const from = desktop();

    const root = await importIntoWorkspace(ws, [], { dir: "", sources: [join(from, "notes.md"), join(from, "photos")] });
    expect(root).toEqual({ imported: [{ source: join(from, "notes.md"), name: "notes-1.md" }, { source: join(from, "photos"), name: "photos" }], failed: [] });
    expect(readFileSync(join(ws, "notes.md"), "utf8")).toBe("# mine\n");
    expect(readFileSync(join(ws, "notes-1.md"), "utf8")).toBe("# from Finder\n");
    expect(readFileSync(join(ws, "photos", "a.jpg"), "utf8")).toBe("jpg");
    // The sources stay where they were: a copy, not a move.
    expect(existsSync(join(from, "photos", "a.jpg"))).toBe(true);

    const docs = await importIntoWorkspace(ws, [], { dir: "docs", sources: [join(from, "report.pdf"), join(from, "report.pdf"), join(from, "photos")] });
    expect(docs.imported.map((row) => row.name)).toEqual(["report-1.pdf", "report-2.pdf", "photos"]);
    expect(readFileSync(join(ws, "docs", "report.pdf"), "utf8")).toBe("old");
    // A folder dropped again gets a name of its own too.
    expect((await importIntoWorkspace(ws, [], { dir: ".", sources: [join(from, "photos")] })).imported).toEqual([{ source: join(from, "photos"), name: "photos-1" }]);
    // Written absolute, a folder inside the workspace is the same folder.
    expect((await importIntoWorkspace(ws, [], { dir: join(ws, "docs"), sources: [join(from, "notes.md")] })).imported[0]?.name).toBe("notes.md");
    expect(readdirSync(join(ws, "docs")).sort()).toEqual(["notes.md", "photos", "report-1.pdf", "report-2.pdf", "report.pdf"]);
  });

  test("a project session's folder takes drops too; anywhere else does not", async () => {
    const ws = dir("real-bot-import-ws-");
    const project = dir("real-bot-import-project-");
    mkdirSync(join(project, "src"));
    const elsewhere = dir("real-bot-import-elsewhere-");
    const from = desktop();

    const into = await importIntoWorkspace(ws, [project], { dir: join(project, "src"), sources: [join(from, "notes.md")] });
    expect(into).toEqual({ imported: [{ source: join(from, "notes.md"), name: "notes.md" }], failed: [] });
    expect(existsSync(join(project, "src", "notes.md"))).toBe(true);

    for (const target of [elsewhere, "../x", `${project}/../${elsewhere.split("/").pop()}`]) {
      expect(await refusal(() => importIntoWorkspace(ws, [project], { dir: target, sources: [join(from, "notes.md")] }))).toBe(422);
    }
    expect(readdirSync(elsewhere)).toEqual([]);
    // No workspace chosen: a relative folder has nowhere to be.
    expect(await refusal(() => importIntoWorkspace(null, [], { dir: "", sources: [join(from, "notes.md")] }))).toBe(422);
    expect(await refusal(() => importIntoWorkspace(ws, [], { dir: "missing", sources: [join(from, "notes.md")] }))).toBe(404);
    writeFileSync(join(ws, "file.txt"), "x");
    expect(await refusal(() => importIntoWorkspace(ws, [], { dir: "file.txt", sources: [join(from, "notes.md")] }))).toBe(422);
  });

  test("each source is answered on its own", async () => {
    const ws = dir("real-bot-import-ws-");
    mkdirSync(join(ws, "inbox"));
    writeFileSync(join(ws, "inbox", "here.txt"), "here");
    const from = desktop();
    const gone = join(from, "gone.txt");

    const result = await importIntoWorkspace(ws, [], {
      dir: "inbox",
      sources: [gone, ws, join(ws, "inbox"), "/", join(ws, "inbox", "here.txt"), join(from, "notes.md")],
    });
    expect(result.imported).toEqual([
      // Already in that folder: left as it is, not copied beside itself.
      { source: join(ws, "inbox", "here.txt"), name: "here.txt" },
      { source: join(from, "notes.md"), name: "notes.md" },
    ]);
    expect(result.failed.map((row) => [row.source, row.code])).toEqual([
      [gone, "missing"],
      [ws, "into_itself"],
      [join(ws, "inbox"), "into_itself"],
      ["/", "into_itself"],
    ]);
    expect(readdirSync(join(ws, "inbox")).sort()).toEqual(["here.txt", "notes.md"]);
  });

  test("a copy that fails partway is taken away again", async () => {
    const ws = dir("real-bot-import-ws-");
    const from = desktop();
    const halfway: ImportCopier = async (_source, dest) => {
      mkdirSync(dest);
      writeFileSync(join(dest, "half.jpg"), "");
      throw new Error("disk full");
    };
    const result = await importIntoWorkspace(ws, [], { dir: "", sources: [join(from, "photos")] }, halfway);
    expect(result).toEqual({ imported: [], failed: [{ source: join(from, "photos"), code: "copy_failed", message: "disk full" }] });
    expect(readdirSync(ws)).toEqual([]);
  });

  test("what is not a list of absolute paths is refused before anything is copied", async () => {
    const ws = dir("real-bot-import-ws-");
    const from = desktop();
    for (const input of [
      { dir: "", sources: [] },
      { dir: "", sources: "notes.md" },
      { dir: "", sources: ["notes.md"] },
      { dir: "", sources: [join(from, "notes.md"), 7] },
      { dir: 3, sources: [join(from, "notes.md")] },
      { sources: [join(from, "notes.md")] },
      { dir: "", sources: Array.from({ length: 1001 }, () => join(from, "notes.md")) },
    ]) {
      expect(await refusal(() => importIntoWorkspace(ws, [], input))).toBe(422);
    }
    expect(readdirSync(ws)).toEqual([]);
  });

  test("the route copies for this Mac's window, with no receipt; a paired device has no such route", async () => {
    const h = await startLocalApi();
    const ws = dir("real-bot-import-ws-");
    const from = desktop();
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });
    const receipts = () => h.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request_receipts").get()!.n;
    const before = receipts();
    const post = (body: unknown) => fetch(`${h.origin}/v1/workspace/import`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });

    const answer = await post({ dir: "", sources: [join(from, "report.pdf")] });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ imported: [{ source: join(from, "report.pdf"), name: "report.pdf" }], failed: [] });
    const tree = (await (await fetch(`${h.origin}/v1/workspace/tree`, { headers: auth(h) })).json()) as { items: Array<{ path: string }> };
    expect(tree.items.map((row) => row.path)).toEqual(["report.pdf"]);
    // Dropped twice, it is there twice: no receipt refuses the second as a replay.
    expect(((await (await post({ dir: "", sources: [join(from, "report.pdf")] })).json()) as { imported: Array<{ name: string }> }).imported[0]?.name).toBe("report-1.pdf");
    expect(receipts()).toBe(before);
    expect((await post({ dir: "", sources: ["report.pdf"] })).status).toBe(422);

    expect(() => validateBusiness({ v: 1, id: ulid(), method: "POST", path: "/v1/workspace/import", body: { dir: "", sources: [join(from, "report.pdf")] } })).toThrow();
  });
});
