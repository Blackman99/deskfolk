/** Files dragged from Finder onto the workspace's file tree: copied into the workspace by the runtime. */
import { afterAll, expect, test } from "nsh/test";
import { openStory, seeded } from "./fixture";

const LOAD_MS = 20_000;
const current = (app: { texts(): string[] }) => app.texts().find((text) => text.startsWith("current:")) ?? "";
const state = (app: { texts(): string[] }) => app.texts().find((text) => text.startsWith("state:")) ?? "";
/** The workspace path of the file the story made: its copy in `inbox/`. */
const path = (app: { texts(): string[] }) => (app.texts().find((text) => text.startsWith("path:")) ?? "").slice(5);
const fileUri = (path: string) => `file://${path.split("/").map(encodeURIComponent).join("/")}`;
/**
 * The row a copy got: the name it had, or `-1`, `-2` before the extension when another test of the
 * same run copied the same file there first.
 */
async function copiedRow(app: Awaited<ReturnType<typeof openStory>>, path: (suffix: string) => string): Promise<string> {
  const candidates = ["", "-1", "-2", "-3", "-4", "-5"].map(path);
  let found = "";
  await app.waitUntil(() => {
    found = candidates.find((candidate) => app.shows(`id:artifact-tree-row:${candidate}`)) ?? "";
    return found !== "";
  }, { timeout: LOAD_MS });
  return found;
}

test("files dropped on the tree are copied where they land: around the rows into the top, on a folder into it, which opens", async () => {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  // An attachment's copy sits in `inbox/`, so the workspace has a folder to drop on.
  await app.press("id:story-make-md");
  await app.waitUntil(() => current(app) === "current:notes.md", { timeout: LOAD_MS });
  const made = path(app);
  expect(made.startsWith("inbox/")).toBe(true);
  await app.press("id:story-show-workspace");
  await app.waitFor("id:artifact-tree-row:inbox", { timeout: LOAD_MS });

  // The fixture's file from elsewhere on the Mac (`elsewhere/notes.md`), onto the space below the rows.
  await app.dropFiles("id:workspace-tree", [fileUri(seeded.elsewhere)]);
  await app.waitFor("id:artifact-tree-row:notes.md", { timeout: LOAD_MS });
  expect(app.shows("id:workspace-tree-drop")).toBe(false);

  // The project's `src/main.py`, onto the `inbox` row: it goes in, and the folder opens on it.
  await app.dropFiles("id:artifact-tree-row:inbox", [fileUri(`${seeded.projectDir}/src/main.py`)]);
  await app.waitFor("id:artifact-tree-row:inbox/main.py", { timeout: LOAD_MS });
  // The folder's other files are listed too: it was listed again, not replaced by the copy alone.
  await app.waitFor(`id:artifact-tree-row:${made}`, { timeout: LOAD_MS });
});

test("in a project session the tree is the project's folder: a folder dropped on a file's row goes beside that file", async () => {
  const app = await openStory("artifacts", {}, { projectDir: seeded.projectDir });
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press("id:story-make-project");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  const src = `${seeded.projectDir}/src`;
  await app.waitFor(`id:artifact-tree-row:${src}/main.py`, { timeout: LOAD_MS });
  // The fixture's folder from elsewhere on the Mac, with what is in it.
  const folder = seeded.elsewhere.slice(0, seeded.elsewhere.lastIndexOf("/"));
  await app.dropFiles(`id:artifact-tree-row:${src}/main.py`, [fileUri(folder)]);
  await app.waitFor(`id:artifact-tree-row:${src}/elsewhere`, { timeout: LOAD_MS });
  // The folder the file is in stays open, the file still in it.
  expect(app.shows(`id:artifact-tree-row:${src}/main.py`)).toBe(true);
});

test("the files a message names take drops too: a folder's row takes them, the space around the rows is the workspace, and a copied folder opens as one", async () => {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  // Two files the story's message hands over, both in `inbox/`: the tree shows them under it.
  await app.press("id:story-make-md");
  await app.waitUntil(() => current(app) === "current:notes.md", { timeout: LOAD_MS });
  await app.press("id:story-make-ts");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  await app.waitFor("id:artifact-tree-row:inbox", { timeout: LOAD_MS });

  // The fixture's folder from elsewhere on the Mac, onto the `inbox` row: it is a row of the tree
  // now, a folder, with what is in it under it.
  const folder = seeded.elsewhere.slice(0, seeded.elsewhere.lastIndexOf("/"));
  await app.dropFiles("id:artifact-tree-row:inbox", [fileUri(folder)]);
  const copied = await copiedRow(app, (n) => `inbox/elsewhere${n}`);
  await app.waitFor(`id:artifact-tree-row:${copied}/notes.md`, { timeout: LOAD_MS });

  // Around the rows: the top of the workspace.
  await app.dropFiles("id:workspace-tree", [fileUri(`${seeded.projectDir}/src/main.py`)]);
  await copiedRow(app, (n) => `main${n}.py`);
});

afterAll(async () => {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press("id:story-clean");
  await app.waitUntil(() => state(app).startsWith("state:clean:"), { timeout: 20_000 });
  expect(state(app)).toBe("state:clean:0");
});
