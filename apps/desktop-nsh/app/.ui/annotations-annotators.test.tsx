import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;
async function show(kind: string, first: string): Promise<App> {
  const app = await openStory("annotations");
  await app.waitFor(`id:story-${kind}`, { timeout: 10_000 });
  await app.press(`id:story-${kind}`);
  await app.waitFor(first);
  return app;
}
const last = (app: App) => {
  const texts = app.texts();
  return texts[texts.length - 1] ?? "";
};

test("the picture draws its mark numbered, a press on it picks it, and a drag in annotate mode makes a pending box", async () => {
  const app = await show("image", "id:image-annotator-picture");
  await app.waitFor("id:image-mark-i1");
  await app.press("id:image-mark-i1");
  await app.waitUntil(() => last(app).includes("pick:i1"));
  await app.drag("id:image-annotator-layer", { x: 120, y: 80 });
  await app.waitUntil(() => last(app).includes("draft:"));
  await app.waitFor("id:image-pending-box");
  await app.waitFor("id:image-handle-se");
});

test("with annotating off nothing can be drawn on the picture, but its marks stay", async () => {
  const app = await show("image", "id:image-annotator-picture");
  await app.press("id:story-annotating");
  await app.waitFor("id:image-mark-i1");
  expect(app.shows("id:image-annotator-layer")).toBe(true);
  await app.drag("id:image-annotator-layer", { x: 100, y: 60 });
  expect(last(app)).toBe("—");
});

test("Markdown is drawn block by block; a block picked in annotate mode offers the button and hands over its source lines", async () => {
  const app = await show("markdown", "id:markdown-annotator");
  await app.waitFor("id:markdown-block-1");
  await app.waitFor("id:markdown-mark-m1");
  // A mark's number picks the mark.
  await app.press("id:markdown-mark-m1");
  await app.waitUntil(() => last(app).includes("pick:m1"));
  await app.press("id:markdown-block-5");
  await app.waitFor("id:markdown-annotate-button");
  await app.press("id:markdown-annotate-button");
  await app.waitUntil(() => last(app).includes("draft:5-6"));
});

test("outside annotate mode a block is not offered", async () => {
  const app = await show("markdown", "id:markdown-annotator");
  await app.press("id:story-annotating");
  await app.waitFor("id:markdown-mark-m1");
  expect(app.shows("id:markdown-annotate-button")).toBe(false);
  await app.keyboard.press("escape");
  expect(app.shows("id:markdown-annotate-button")).toBe(false);
});

test("the video marks its point at the playback position, then extends it to a span", async () => {
  const app = await show("media", "id:media-annotator");
  await app.waitFor("id:media-timeline");
  await app.waitFor("id:media-mark-v1");
  await app.press("id:media-mark-v1");
  await app.waitUntil(() => last(app).includes("pick:v1"));
  await app.press("id:media-mark-here");
  await app.waitUntil(() => last(app).includes("draft:"));
  await app.waitFor("id:media-pending-label");
  await app.waitFor("id:media-pending");
});
