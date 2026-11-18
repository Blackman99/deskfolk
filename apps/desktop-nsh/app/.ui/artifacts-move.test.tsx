/**
 * A file tree as a drop target, on the story's fixed rows (docs, docs/plan.md, assets shut,
 * readme.md): which folder rows dragged onto it, or files from Finder, would go to. The story's
 * buttons do what the end of a mouse's drag does at a row (the screen tests' drags are a finger,
 * which drags no row); the log says what the tree asked for (`move:` / `files:`).
 */
import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;
const log = (app: App) => app.texts().find((text) => text.startsWith("log:")) ?? "";

async function tree(): Promise<App> {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press("id:story-show-tree");
  await app.waitFor("id:artifact-tree-row:readme.md");
  return app;
}

test("rows let go on a folder's row move into it; on a file's row, into that file's folder", async () => {
  const app = await tree();
  await app.press("id:story-tree-readme-docs");
  await app.waitUntil(() => log(app).includes("move:docs:readme.md"));
  // Over readme.md, a file at the top: the whole tree says the top takes it, until the drag leaves.
  await app.press("id:story-tree-hover-plan-readme");
  await app.waitFor("id:workspace-tree-drop");
  await app.press("id:story-tree-leave");
  await app.waitFor("id:workspace-tree-drop", { state: "gone" });
  await app.press("id:story-tree-plan-readme");
  await app.waitUntil(() => log(app).includes("move:top:docs/plan.md"));
});

test("a drag resting on a shut folder opens it, so a drop can reach what is inside", async () => {
  const app = await tree();
  expect(app.shows("id:artifact-tree-row:assets/logo.txt")).toBe(false);
  await app.press("id:story-tree-hover-readme-assets");
  await app.waitFor("id:artifact-tree-row:assets/logo.txt", { timeout: 3_000 });
  await app.press("id:story-tree-readme-assets");
  await app.waitUntil(() => log(app).includes("move:assets:readme.md"));
});

test("a folder is not moved into itself, and rows let go where they already are stay", async () => {
  const app = await tree();
  await app.press("id:story-tree-docs-plan");
  await app.press("id:story-tree-plan-docs");
  await app.waitUntil(() => (log(app).match(/drop:tree/g) ?? []).length === 2);
  await app.wait(300);
  expect(log(app).includes("move:")).toBe(false);
});

test("files from Finder go into the folder of the row they land on", async () => {
  const app = await tree();
  await app.dropFiles("id:artifact-tree-row:docs/plan.md", ["file:///tmp/a.pdf"]);
  await app.waitUntil(() => log(app).includes("files:docs:1"));
  await app.dropFiles("id:artifact-tree-row:readme.md", ["file:///tmp/b.pdf"]);
  await app.waitUntil(() => log(app).includes("files:top:1"));
});
