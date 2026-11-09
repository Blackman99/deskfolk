import { afterAll, expect, test } from "nsh/test";
import { openStory, seeded } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

const log = (app: App) => app.texts().find((text) => text.startsWith("log:")) ?? "";
const state = (app: App) => app.texts().find((text) => text.startsWith("state:")) ?? "";
const current = (app: App) => app.texts().find((text) => text.startsWith("current:")) ?? "";
const has = (app: App, text: string) => app.texts().includes(text);
const LOAD_MS = 20_000;

/** The story with one sample uploaded and open in the preview. */
async function opened(which: "md" | "ts" | "bin", wait: string): Promise<App> {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press(`id:story-make-${which}`);
  await app.waitFor(wait, { timeout: LOAD_MS });
  return app;
}

test("a Markdown file is shown rendered, with a switch to its source", async () => {
  const app = await opened("md", "id:artifact-source-toggle");
  expect(state(app)).toBe("state:opened:notes.md");
  expect(app.shows("id:artifact-preview")).toBe(true);
  await app.waitUntil(() => has(app, "Notes"), { timeout: LOAD_MS });
  expect(app.shows("id:artifact-code-editor")).toBe(false);
  await app.press("id:artifact-source-toggle");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  await app.press("id:artifact-source-toggle");
  await app.waitUntil(() => !app.shows("id:artifact-code-editor"));
});

test("a text file opens in the code editor, an edit marks it unsaved and leaving asks first", async () => {
  const app = await opened("ts", "id:artifact-code-editor");
  await app.press("id:story-sheet");
  await app.waitFor("id:artifact-pane-head");
  expect(app.shows("id:artifact-dirty-dot")).toBe(false);
  await app.type("id:artifact-editor", "// edited\n");
  await app.waitFor("id:artifact-dirty-dot");
  // Back asks before it leaves.
  await app.press("id:artifact-back");
  await app.waitFor("id:artifact-dirty-dialog");
  expect(log(app)).not.toContain("close");
  // Cancel keeps the file open and the edit.
  await app.press("id:artifact-dirty-cancel");
  await app.waitUntil(() => !app.shows("id:artifact-dirty-dialog"));
  expect(app.shows("id:artifact-dirty-dot")).toBe(true);
  expect(log(app)).not.toContain("close");
  // Discard puts the disk's text back and closes.
  await app.press("id:artifact-back");
  await app.waitFor("id:artifact-dirty-dialog");
  await app.press("id:artifact-dirty-discard");
  await app.waitUntil(() => log(app).includes("close"));
  expect(app.shows("id:artifact-dirty-dot")).toBe(false);
});

test("saving writes the file back, clears the unsaved mark and lets the pane close", async () => {
  const app = await opened("ts", "id:artifact-code-editor");
  await app.press("id:story-sheet");
  await app.waitFor("id:artifact-pane-head");
  await app.type("id:artifact-editor", "// saved\n");
  await app.waitFor("id:artifact-dirty-dot");
  await app.keyboard.press("mod+s");
  await app.waitUntil(() => !app.shows("id:artifact-dirty-dot"), { timeout: LOAD_MS });
  expect(app.shows("id:artifact-save-error")).toBe(false);
  // The runtime has the new text.
  await app.press("id:story-read");
  await app.waitUntil(() => state(app).startsWith("state:read"), { timeout: LOAD_MS });
  expect(state(app)).toContain("// saved");
  // Nothing unsaved: back closes at once.
  await app.press("id:artifact-back");
  await app.waitUntil(() => log(app).includes("close"));
  expect(app.shows("id:artifact-dirty-dialog")).toBe(false);
});

test("a file with no preview is offered by name", async () => {
  const app = await opened("bin", "id:artifact-unsupported-name");
  expect(app.shows("id:artifact-code-editor")).toBe(false);
  expect(app.texts()).toContain("data.bin");
});

const path = (app: App) => (app.texts().find((text) => text.startsWith("path:")) ?? "").slice(5);

test("a second file lists both in the tree, and picking a row opens that file", async () => {
  const app = await opened("ts", "id:artifact-code-editor");
  // The attachment sits under inbox/, so even one file has its folder in a tree.
  await app.waitFor("id:artifact-tree-column");
  const first = path(app);
  await app.press("id:story-make-md");
  await app.waitUntil(() => current(app) === "current:notes.md", { timeout: LOAD_MS });
  expect(app.shows(`id:artifact-tree-row:${first}`)).toBe(true);
  expect(app.shows(`id:artifact-tree-row:${path(app)}`)).toBe(true);
  await app.press(`id:artifact-tree-row:${first}`);
  await app.waitUntil(() => current(app) === "current:sum.ts", { timeout: LOAD_MS });
  expect(log(app)).toContain("select:sum.ts");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  // A file opened over the whole app has no tree.
  await app.press("id:story-no-tree");
  await app.waitUntil(() => !app.shows("id:artifact-tree-column"));
});

test("switching between code files with no edit asks nothing, and undo stays in the file", async () => {
  const app = await opened("ts", "id:artifact-code-editor");
  // The sheet's bar carries the unsaved mark (the desktop's is on the workbench tab).
  await app.press("id:story-sheet");
  await app.waitFor("id:artifact-pane-head");
  await app.waitFor("id:artifact-tree-column");
  const ts = path(app);
  await app.press("id:story-make-py");
  await app.waitUntil(() => current(app) === "current:hello.py", { timeout: LOAD_MS });
  const py = path(app);
  await app.waitUntil(() => app.texts().some((text) => text.includes("def hello")), { timeout: LOAD_MS });
  await app.press(`id:artifact-tree-row:${ts}`);
  await app.waitUntil(() => current(app) === "current:sum.ts", { timeout: LOAD_MS });
  await app.waitUntil(() => app.texts().some((text) => text.includes("export function sum")), { timeout: LOAD_MS });
  expect(app.shows("id:artifact-dirty-dot")).toBe(false);
  // Undo takes back this file's edit, and has nothing of the last file to bring back.
  await app.type("id:artifact-editor", "x");
  await app.waitFor("id:artifact-dirty-dot");
  await app.keyboard.press("mod+z");
  await app.waitUntil(() => !app.shows("id:artifact-dirty-dot"));
  await app.keyboard.press("mod+z");
  await app.wait(100);
  expect(app.shows("id:artifact-dirty-dot")).toBe(false);
  expect(app.texts().some((text) => text.includes("def hello"))).toBe(false);
  // And going back is not held up by an edit nobody made.
  await app.press(`id:artifact-tree-row:${py}`);
  await app.waitUntil(() => current(app) === "current:hello.py", { timeout: LOAD_MS });
  expect(app.shows("id:artifact-dirty-dialog")).toBe(false);
});

test("a file with the same text as the last one starts a history of its own", async () => {
  const app = await opened("ts", "id:artifact-code-editor");
  await app.press("id:story-sheet");
  await app.waitFor("id:artifact-pane-head");
  await app.waitFor("id:artifact-tree-column");
  const ts = path(app);
  await app.press("id:story-make-same");
  await app.waitUntil(() => current(app) === "current:sum-copy.ts", { timeout: LOAD_MS });
  // An edit taken back leaves it to be done again, in this file only.
  await app.type("id:artifact-editor", "x");
  await app.waitFor("id:artifact-dirty-dot");
  await app.keyboard.press("mod+z");
  await app.waitUntil(() => !app.shows("id:artifact-dirty-dot"));
  await app.press(`id:artifact-tree-row:${ts}`);
  await app.waitUntil(() => current(app) === "current:sum.ts", { timeout: LOAD_MS });
  await app.type("id:artifact-editor", "");
  await app.keyboard.press("mod+shift+z");
  await app.wait(100);
  expect(app.shows("id:artifact-dirty-dot")).toBe(false);
});

test("a project session's file opens editable, outside the workspace, and is saved where it is", async () => {
  const app = await openStory("artifacts", {}, { projectDir: seeded.projectDir });
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press("id:story-make-project");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  await app.waitUntil(() => app.texts().some((text) => text.includes("def main")), { timeout: LOAD_MS });
  // The project's tree, with its file.
  await app.waitFor("id:artifact-tree-column");
  await app.type("id:artifact-editor", "# edited\n");
  await app.waitFor("id:artifact-dirty-dot");
  await app.keyboard.press("mod+s");
  await app.waitUntil(() => !app.shows("id:artifact-dirty-dot"), { timeout: LOAD_MS });
  expect(app.shows("id:artifact-save-error")).toBe(false);
  await app.press("id:story-read-project");
  await app.waitUntil(() => state(app).startsWith("state:read"), { timeout: LOAD_MS });
  expect(state(app)).toContain("# edited");
  expect(state(app)).toContain("def main");
});

test("the phone's list opens as a sheet and a picked file closes it", async () => {
  const app = await openStory("artifacts", { width: 420, height: 760 });
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press("id:story-make-ts");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  const first = path(app);
  await app.press("id:story-make-md");
  await app.waitFor("id:artifact-picker", { timeout: LOAD_MS });
  await app.waitUntil(() => current(app) === "current:notes.md");
  expect(app.shows("id:artifact-pane-head")).toBe(true);
  expect(app.shows("id:artifact-tree-column")).toBe(false);
  expect(app.shows(`id:artifact-tree-row:${first}`)).toBe(false);
  await app.press("id:artifact-picker");
  await app.waitFor(`id:artifact-tree-row:${first}`);
  await app.press(`id:artifact-tree-row:${first}`);
  await app.waitUntil(() => current(app) === "current:sum.ts", { timeout: LOAD_MS });
  await app.waitUntil(() => !app.shows(`id:artifact-tree-row:${first}`));
});

test("the workspace has its tree, no annotation bar, and asks for a file", async () => {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press("id:story-show-workspace");
  await app.waitFor("id:artifact-tree-column");
  expect(app.shows("id:artifact-annot-bar")).toBe(false);
  expect(has(app, "从左侧打开一个文件。")).toBe(true);
});

test("the tree's menu offers what applies to one row or to several", async () => {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press("id:story-show-parts");
  await app.press("id:story-menu-one");
  await app.waitFor("id:artifact-tree-menu");
  for (const id of ["open", "reveal", "open-terminal", "copy-path", "copy-abs-path", "trash"]) expect(app.shows(`id:artifact-tree-menu-${id}`)).toBe(true);
  await app.press("id:artifact-tree-menu-copy-path");
  await app.waitUntil(() => !app.shows("id:artifact-tree-menu"));
  expect(log(app)).toContain("menu-copy-path");
  await app.press("id:story-menu-many");
  await app.waitFor("id:artifact-tree-menu");
  expect(app.shows("id:artifact-tree-menu-open")).toBe(false);
  expect(app.shows("id:artifact-tree-menu-reveal")).toBe(false);
  expect(app.shows("id:artifact-tree-menu-open-terminal")).toBe(false);
  expect(app.texts()).toContain("将 3 项移到废纸篓");
  await app.press("id:artifact-tree-menu-trash");
  await app.waitUntil(() => log(app).includes("menu-trash:3"));
  await app.press("id:story-menu-one");
  await app.waitFor("id:artifact-tree-menu");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:artifact-tree-menu"));
});

test("the unsaved-changes dialog has three ways out", async () => {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press("id:story-show-parts");
  for (const [button, line] of [
    ["id:artifact-dirty-cancel", "dirty-cancel"],
    ["id:artifact-dirty-discard", "dirty-discard"],
    ["id:artifact-dirty-save", "dirty-save"],
  ] as const) {
    await app.press("id:story-dirty");
    await app.waitFor("id:artifact-dirty-dialog");
    expect(app.texts()).toContain("有未保存的更改");
    await app.press(button);
    await app.waitUntil(() => !app.shows("id:artifact-dirty-dialog"));
    expect(log(app)).toContain(line);
  }
});

afterAll(async () => {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press("id:story-clean");
  await app.waitUntil(() => state(app).startsWith("state:clean:"), { timeout: 20_000 });
  expect(state(app)).toBe("state:clean:0");
});
