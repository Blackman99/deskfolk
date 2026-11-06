import { afterAll, expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

const log = (app: App) => app.texts().find((text) => text.startsWith("log:")) ?? "";
const state = (app: App) => app.texts().find((text) => text.startsWith("state:")) ?? "";
const current = (app: App) => app.texts().find((text) => text.startsWith("current:")) ?? "";
const path = (app: App) => (app.texts().find((text) => text.startsWith("path:")) ?? "").slice(5);
const LOAD_MS = 20_000;

async function story(): Promise<App> {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  return app;
}

test("a PDF opens in the viewer by the attachment's own URL", async () => {
  const app = await story();
  await app.press("id:story-make-pdf");
  await app.waitFor("id:pdf-page-total", { timeout: LOAD_MS });
  expect(app.shows("id:artifact-code-editor")).toBe(false);
});

test("a picture opens in the image annotator, not as a download", async () => {
  const app = await story();
  await app.press("id:story-make-png");
  await app.waitUntil(() => current(app) === "current:dot.png", { timeout: LOAD_MS });
  await app.waitUntil(() => !app.shows("id:artifact-loading"), { timeout: LOAD_MS });
  await app.waitFor("id:image-annotator-picture", { timeout: LOAD_MS });
  expect(app.shows("id:artifact-unsupported-name")).toBe(false);
  expect(app.shows("id:artifact-code-editor")).toBe(false);
});

test("dragging a tree row shows a chip with its name, and letting go on a drop target hands the path over", async () => {
  const app = await story();
  await app.press("id:story-make-ts");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  const file = path(app);
  await app.waitFor(`id:artifact-tree-row:${file}`);
  expect(app.shows("id:workspace-drag-ghost")).toBe(false);
  // The story's drop target is the whole preview: drag the row across into the file.
  await app.dragAndHold(`id:artifact-tree-row:${file}`, { x: 300, y: 40 });
  await app.waitFor("id:workspace-drag-ghost");
  await app.drop();
  await app.waitUntil(() => log(app).includes(`drop:${file}`), { timeout: LOAD_MS });
  await app.waitUntil(() => !app.shows("id:workspace-drag-ghost"));
});

test("a drag that never leaves the row is a press, not a drag", async () => {
  const app = await story();
  await app.press("id:story-make-ts");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  const file = path(app);
  await app.press(`id:artifact-tree-row:${file}`);
  expect(app.shows("id:workspace-drag-ghost")).toBe(false);
  expect(log(app)).not.toContain("drop:");
});

test("right-clicking a tree row opens its menu at the pointer, and Escape closes it", async () => {
  const app = await story();
  await app.press("id:story-make-ts");
  await app.waitFor("id:artifact-code-editor", { timeout: LOAD_MS });
  const file = path(app);
  await app.rightClick(`id:artifact-tree-row:${file}`);
  await app.waitFor("id:artifact-tree-menu");
  expect(app.shows("id:artifact-tree-menu-copy-path")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:artifact-tree-menu"));
});

afterAll(async () => {
  const app = await story();
  await app.press("id:story-clean");
  await app.waitUntil(() => state(app).startsWith("state:clean:"), { timeout: 20_000 });
  expect(state(app)).toBe("state:clean:0");
});
