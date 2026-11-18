/**
 * The file on screen follows the disk (`ArtifactLoader.watchFile`): a change written behind the
 * preview's back (`story-rewrite`, as a Bot's edit would be) shows within a few seconds, in the
 * rendered Markdown and in the code editor, and an edit not yet saved is never written over.
 */
import { afterAll, expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

const state = (app: App) => app.texts().find((text) => text.startsWith("state:")) ?? "";
const has = (app: App, text: string) => app.texts().includes(text);
const LOAD_MS = 20_000;
/** A poll a second, and the read after it. */
const FOLLOW_MS = 8_000;

async function opened(which: "md" | "ts", wait: string): Promise<App> {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press(`id:story-make-${which}`);
  await app.waitFor(wait, { timeout: LOAD_MS });
  return app;
}

async function rewrite(app: App): Promise<void> {
  await app.press("id:story-rewrite");
  await app.waitUntil(() => state(app) === "state:rewritten" || state(app).startsWith("state:rewrite-error"), { timeout: LOAD_MS });
  expect(state(app)).toBe("state:rewritten");
}

test("a rendered Markdown file shows a change made on disk", async () => {
  const app = await opened("md", "id:artifact-source-toggle");
  await app.waitUntil(() => has(app, "Notes"), { timeout: LOAD_MS });
  await rewrite(app);
  await app.waitUntil(() => has(app, "Rewritten"), { timeout: FOLLOW_MS });
  expect(has(app, "Notes")).toBe(false);
});

test("the code editor takes a change made on disk, and nothing reads as unsaved", async () => {
  const app = await opened("ts", "id:artifact-code-editor");
  await app.press("id:story-sheet");
  await app.waitFor("id:artifact-pane-head");
  await rewrite(app);
  await app.waitUntil(() => (app.value("id:artifact-editor") ?? "").includes("// changed on disk"), { timeout: FOLLOW_MS });
  expect(app.value("id:artifact-editor")).toContain("export function sum");
  expect(app.shows("id:artifact-dirty-dot")).toBe(false);
  // Saved from here, it saves over the new text, with no "changed since" answer.
  await app.type("id:artifact-editor", "// mine\n");
  await app.waitFor("id:artifact-dirty-dot");
  await app.keyboard.press("mod+s");
  await app.waitUntil(() => !app.shows("id:artifact-dirty-dot"), { timeout: LOAD_MS });
  expect(app.shows("id:artifact-save-error")).toBe(false);
});

test("an edit not yet saved stays when the file changes on disk, and saving it says the file changed", async () => {
  const app = await opened("ts", "id:artifact-code-editor");
  await app.press("id:story-sheet");
  await app.waitFor("id:artifact-pane-head");
  await app.type("id:artifact-editor", "// unsaved\n");
  await app.waitFor("id:artifact-dirty-dot");
  await rewrite(app);
  // Two polls' worth: the edit is still there and still unsaved.
  await app.wait(3_000);
  expect(app.value("id:artifact-editor")).toContain("// unsaved");
  expect(app.value("id:artifact-editor")).not.toContain("// changed on disk");
  expect(app.shows("id:artifact-dirty-dot")).toBe(true);
  await app.keyboard.press("mod+s");
  await app.waitFor("id:artifact-save-error", { timeout: LOAD_MS });
  expect(app.shows("id:artifact-dirty-dot")).toBe(true);
});

afterAll(async () => {
  const app = await openStory("artifacts");
  await app.waitFor("id:artifacts", { timeout: 15_000 });
  await app.press("id:story-clean");
  await app.waitUntil(() => state(app).startsWith("state:clean:"), { timeout: 20_000 });
  expect(state(app)).toBe("state:clean:0");
});
