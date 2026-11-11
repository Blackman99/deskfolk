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

/** The story's `draft:box left,top width×height`, in the picture's pixels. */
const drawnBox = (line: string) => {
  const m = /^draft:box (\d+),(\d+) (\d+)×(\d+)$/.exec(line);
  if (!m) throw new Error(`not a drawn box: ${line}`);
  const [x, y, w, h] = m.slice(1).map(Number);
  return { x, y, w, h };
};

// The release's own gesture state has no finger left (moveX/moveY read 0): a box finished from it
// ran from the picture's top left to where the finger went down.
test("a drawn box runs from where the drag began to where it was let go", async () => {
  const app = await show("image", "id:image-annotator-picture");
  await app.waitFor("id:image-annotator-layer");
  // The finger lands on the middle of the 400×250 picture.
  await app.drag("id:image-annotator-layer", { x: 90, y: 30 });
  await app.waitUntil(() => last(app).startsWith("draft:"));
  const box = drawnBox(last(app));
  expect(Math.abs(box.x - 200)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y - 125)).toBeLessThanOrEqual(2);
  // However the picture is scaled, the box keeps the drag's shape.
  expect(Math.abs(box.w / box.h - 3)).toBeLessThan(0.2);
});

test("a press in annotate mode makes a small box on the spot", async () => {
  const app = await show("image", "id:image-annotator-picture");
  await app.waitFor("id:image-annotator-layer");
  // The layer has no `onPress` for the driver's press: a finger that barely moves is the same click.
  await app.drag("id:image-annotator-layer", { x: 2, y: 1 });
  await app.waitUntil(() => last(app).startsWith("draft:"));
  // 4% of the short side, centred on the middle of the 400×250 picture.
  expect(drawnBox(last(app))).toEqual({ x: 195, y: 120, w: 10, h: 10 });
});

test("with annotating off nothing can be drawn on the picture, but its marks stay", async () => {
  const app = await show("image", "id:image-annotator-picture");
  await app.press("id:story-annotating");
  await app.waitFor("id:image-mark-i1");
  expect(app.shows("id:image-annotator-layer")).toBe(true);
  await app.drag("id:image-annotator-layer", { x: 100, y: 60 });
  expect(last(app)).toBe("—");
});

test("outside annotate mode a press on the picture enlarges it from where it sits; in annotate mode it does not", async () => {
  const app = await show("image", "id:image-annotator-picture");
  await app.waitFor("id:image-annotator-layer");
  await app.press("id:image-annotator-picture");
  expect(last(app)).toBe("—");
  await app.press("id:story-annotating");
  await app.press("id:image-annotator-picture");
  await app.waitUntil(() => last(app) === "open:from");
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
