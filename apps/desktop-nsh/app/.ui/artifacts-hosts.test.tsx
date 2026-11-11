import { afterAll, expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

const log = (app: App) => app.texts().find((text) => text.startsWith("log:")) ?? "";
const state = (app: App) => app.texts().find((text) => text.startsWith("state:")) ?? "";
const LOAD_MS = 20_000;

async function story(): Promise<App> {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  return app;
}

test("the shell's preview column mounts the preview with its props and hands over its pane", async () => {
  const app = await story();
  await app.press("id:story-make-ts");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  await app.press("id:story-show-shell");
  await app.press("id:story-shell-open");
  await app.waitFor("id:artifact-preview", { timeout: LOAD_MS });
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  // A column on a wide window: no header of its own.
  expect(app.shows("id:artifact-pane-head")).toBe(false);
  await app.waitUntil(() => log(app).includes("shell-pane:up"));
  // Opened with no message behind it: the list says why nothing can be added.
  expect(app.shows("id:annotation-toggle")).toBe(true);
});

test("the shell's preview as a sheet gets the phone's bar, and its back closes it", async () => {
  const app = await story();
  await app.press("id:story-make-ts");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  await app.press("id:story-sheet");
  await app.press("id:story-show-shell");
  await app.press("id:story-shell-open");
  await app.waitFor("id:artifact-pane-head", { timeout: LOAD_MS });
  await app.press("id:artifact-back");
  await app.waitUntil(() => !app.shows("id:artifact-preview"));
});

test("the workspace host mounts the preview in workspace mode, with the tree and no annotation bar", async () => {
  const app = await story();
  await app.press("id:story-show-host");
  await app.waitFor("id:artifact-tree-column", { timeout: LOAD_MS });
  expect(app.shows("id:artifact-annot-bar")).toBe(false);
  expect(app.texts()).toContain("从左侧打开一个文件。");
});

afterAll(async () => {
  const app = await story();
  await app.press("id:story-clean");
  await app.waitUntil(() => state(app).startsWith("state:clean:"), { timeout: 20_000 });
  expect(state(app)).toBe("state:clean:0");
});
