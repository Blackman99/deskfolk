import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors";
import { ulid } from "./ids";
import { validateBusiness } from "./remote/routes";
import { auth, registerLocalApiCleanup, startLocalApi } from "./test-kit/local-api-harness";
import { moveInWorkspace, type Mover } from "./workspace-move";

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

/** A workspace with a file at the top, a folder with a file and a folder in it, and an empty folder. */
function workspace(): string {
  const ws = dir("real-bot-move-ws-");
  mkdirSync(join(ws, "docs", "sub"), { recursive: true });
  mkdirSync(join(ws, "assets"));
  writeFileSync(join(ws, "readme.md"), "# readme\n");
  writeFileSync(join(ws, "docs", "plan.md"), "# plan\n");
  writeFileSync(join(ws, "docs", "sub", "deep.md"), "# deep\n");
  return ws;
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

describe("rows dragged inside a file tree", () => {
  test("files and folders move into the folder they were let go on, under their own names", async () => {
    const ws = workspace();
    const result = await moveInWorkspace(ws, [], { dir: "assets", sources: ["readme.md", "docs/sub"] });
    expect(result).toEqual({ moved: [{ source: "readme.md", name: "readme.md" }, { source: "docs/sub", name: "sub" }], failed: [] });
    expect(readFileSync(join(ws, "assets", "readme.md"), "utf8")).toBe("# readme\n");
    expect(readFileSync(join(ws, "assets", "sub", "deep.md"), "utf8")).toBe("# deep\n");
    expect(existsSync(join(ws, "readme.md"))).toBe(false);
    expect(readdirSync(join(ws, "docs"))).toEqual(["plan.md"]);
    // Back to the top, written as the tree writes it.
    expect((await moveInWorkspace(ws, [], { dir: "", sources: ["assets/readme.md"] })).moved).toEqual([{ source: "assets/readme.md", name: "readme.md" }]);
    expect(existsSync(join(ws, "readme.md"))).toBe(true);
    // Written absolute, a workspace folder is the same folder.
    expect((await moveInWorkspace(ws, [], { dir: join(ws, "docs"), sources: [join(ws, "readme.md")] })).moved[0]?.name).toBe("readme.md");
    expect(existsSync(join(ws, "docs", "readme.md"))).toBe(true);
  });

  test("nothing is overwritten, a folder does not go into itself, and each source is answered on its own", async () => {
    const ws = workspace();
    writeFileSync(join(ws, "assets", "plan.md"), "# theirs\n");
    const result = await moveInWorkspace(ws, [], {
      dir: "assets",
      sources: ["docs/plan.md", "gone.md", "docs/sub", "/etc/hosts", "../escape.md", "readme.md"],
    });
    expect(result.moved).toEqual([{ source: "docs/sub", name: "sub" }, { source: "readme.md", name: "readme.md" }]);
    expect(result.failed.map((row) => [row.source, row.code])).toEqual([
      ["docs/plan.md", "exists"],
      ["gone.md", "missing"],
      ["/etc/hosts", "outside"],
      ["../escape.md", "outside"],
    ]);
    expect(readFileSync(join(ws, "assets", "plan.md"), "utf8")).toBe("# theirs\n");
    expect(readFileSync(join(ws, "docs", "plan.md"), "utf8")).toBe("# plan\n");

    const into = await moveInWorkspace(ws, [], { dir: "assets/sub", sources: ["assets", "assets/sub", "assets/sub/deep.md"] });
    // A folder into itself, or into a folder inside it, stays; a file already there is left as it is.
    expect(into.failed.map((row) => [row.source, row.code])).toEqual([["assets", "into_itself"], ["assets/sub", "into_itself"]]);
    expect(into.moved).toEqual([{ source: "assets/sub/deep.md", name: "deep.md" }]);
    expect(existsSync(join(ws, "assets", "sub", "deep.md"))).toBe(true);
  });

  test("a link moves as a link, not the file it points at", async () => {
    const ws = workspace();
    const elsewhere = dir("real-bot-move-elsewhere-");
    writeFileSync(join(elsewhere, "target.md"), "# target\n");
    symlinkSync(join(elsewhere, "target.md"), join(ws, "link.md"));
    const result = await moveInWorkspace(ws, [], { dir: "docs", sources: ["link.md"] });
    expect(result.moved).toEqual([{ source: "link.md", name: "link.md" }]);
    expect(lstatSync(join(ws, "docs", "link.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(elsewhere, "target.md"), "utf8")).toBe("# target\n");
  });

  test("a project's folder takes moves too, and a refusal from the system fails only that source", async () => {
    const ws = workspace();
    const project = dir("real-bot-move-project-");
    mkdirSync(join(project, "src"));
    writeFileSync(join(project, "main.py"), "print(1)\n");
    const into = await moveInWorkspace(ws, [project], { dir: join(project, "src"), sources: [join(project, "main.py")] });
    expect(into).toEqual({ moved: [{ source: join(project, "main.py"), name: "main.py" }], failed: [] });
    expect(existsSync(join(project, "src", "main.py"))).toBe(true);

    const refusing: Mover = async () => {
      throw new Error("Operation not permitted");
    };
    const result = await moveInWorkspace(ws, [], { dir: "assets", sources: ["readme.md"] }, refusing);
    expect(result).toEqual({ moved: [], failed: [{ source: "readme.md", code: "move_failed", message: "Operation not permitted" }] });
    expect(existsSync(join(ws, "readme.md"))).toBe(true);
  });

  test("what is no folder or no list of paths is refused before anything moves", async () => {
    const ws = workspace();
    for (const input of [
      { dir: "", sources: [] },
      { dir: "", sources: "readme.md" },
      { dir: "", sources: [""] },
      { dir: 3, sources: ["readme.md"] },
      { dir: "../x", sources: ["readme.md"] },
      { dir: "/elsewhere", sources: ["readme.md"] },
    ]) {
      expect(await refusal(() => moveInWorkspace(ws, [], input))).toBe(422);
    }
    expect(await refusal(() => moveInWorkspace(ws, [], { dir: "missing", sources: ["readme.md"] }))).toBe(404);
    expect(await refusal(() => moveInWorkspace(ws, [], { dir: "readme.md", sources: ["docs/plan.md"] }))).toBe(422);
    expect(existsSync(join(ws, "readme.md"))).toBe(true);
  });

  test("the route moves for this Mac's window, with no receipt; a paired device has no such route", async () => {
    const h = await startLocalApi();
    const ws = workspace();
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });
    const receipts = () => h.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request_receipts").get()!.n;
    const before = receipts();
    const post = (body: unknown) => fetch(`${h.origin}/v1/workspace/move`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const answer = await post({ dir: "docs", sources: ["readme.md"] });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ moved: [{ source: "readme.md", name: "readme.md" }], failed: [] });
    // Asked again after a lost answer: the source is gone, and nothing moves twice.
    expect(((await (await post({ dir: "docs", sources: ["readme.md"] })).json()) as { failed: Array<{ code: string }> }).failed[0]?.code).toBe("missing");
    expect(receipts()).toBe(before);
    expect(() => validateBusiness({ v: 1, id: ulid(), method: "POST", path: "/v1/workspace/move", body: { dir: "", sources: ["docs/readme.md"] } })).toThrow();
  });
});
