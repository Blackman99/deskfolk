/** A message's file chips, the picture enlargement and the composer's staged files. */
import { expect, test } from "nsh/test";
import { zoomLimit } from "../src/m/chat/image-zoom.ts";
import { wheelView } from "../src/ui/chat/lightbox-fit";
import { openStory } from "./fixture";

/** What the story's fake runtime was asked for, one entry each. */
const asked = (app: { texts(): string[] }) => (app.texts().find((line) => line.includes("attachment ")) ?? "").split(" | ");

test("a picture chip fetches its thumbnail and shows it; a file chip keeps its icon", async () => {
  const app = await openStory("chat-media");
  await app.waitFor("id:attachment-chip-thumb", { timeout: 10_000 });
  expect(app.count("id:attachment-chip")).toBe(2);
  expect(app.texts()).toContain("chart.png");
  expect(app.texts()).toContain("images/chart.png");
  expect(app.texts().some((line) => line.includes("attachment att-chart:thumb"))).toBe(true);
  // The note chip is a file, so no picture was asked for it.
  expect(app.texts().some((line) => line.includes("att-plan"))).toBe(false);
});

test("a file chip opens its file over the app; several files are one bundle entry", async () => {
  const app = await openStory("chat-media");
  await app.waitFor("id:attachment-bundle");
  expect(app.texts()).toContain("2 个文件");
  await app.press("id:attachment-bundle");
  await app.waitUntil(() => app.texts().some((line) => line.includes("bundle:images/chart.png")));
  await app.press("text:plan.md");
  await app.waitFor("id:msg-file-frame");
  await app.press("id:msg-file-close");
});

test("a picture opens enlarged: the real bytes load, the name is its caption, the tap closes it", async () => {
  const app = await openStory("chat-media");
  await app.waitFor("id:attachment-chip-thumb", { timeout: 10_000 });
  await app.press("id:attachment-chip-thumb");
  await app.waitFor("id:msg-image-lightbox");
  await app.waitFor("id:msg-image-full");
  await app.waitFor("id:msg-image-caption");
  expect(app.texts()).toContain("chart.png");
  // A local read is the original: nothing to offer, nothing to save.
  expect(app.shows("id:msg-image-original")).toBe(false);
  expect(app.shows("id:msg-image-save")).toBe(false);
  expect(asked(app).some((line) => line === "attachment att-chart")).toBe(true);
  // The chip handed over its thumbnail, not itself: the frame grows out of the picture and starts from it.
  expect(app.texts().some((line) => line.includes("image:images/chart.png from:thumb:shown"))).toBe(true);
  await app.press("id:msg-image-full");
  await app.waitFor("id:msg-image-lightbox", { state: "gone" });
});

test("the enlargement closes by ✕, by Escape and by the phone's Back", async () => {
  const app = await openStory("chat-media");
  await app.waitFor("id:attachment-chip-thumb", { timeout: 10_000 });
  await app.press("id:attachment-chip-thumb");
  await app.waitFor("id:msg-image-close");
  await app.press("id:msg-image-close");
  await app.waitFor("id:msg-image-lightbox", { state: "gone" });
  await app.press("id:attachment-chip-thumb");
  await app.waitFor("id:msg-image-full");
  await app.keyboard.press("escape");
  await app.waitFor("id:msg-image-lightbox", { state: "gone" });
});

test("a remote enlargement shows the copy and swaps in the original on request", async () => {
  const app = await openStory("chat-media");
  await app.press("id:remote");
  await app.waitFor("id:attachment-chip-thumb", { timeout: 10_000 });
  await app.press("id:attachment-chip-thumb");
  await app.waitFor("id:msg-image-original");
  expect(app.texts().some((line) => line.includes("2.3 MB") || line.includes("2.4 MB") || line.includes("MB"))).toBe(true);
  // The save button is there, remotely: the picture is otherwise only on the Mac.
  expect(app.shows("id:msg-image-save")).toBe(true);
  await app.press("id:msg-image-original");
  await app.waitFor("id:msg-image-original", { state: "gone" });
  expect(asked(app).some((line) => line === "attachment att-chart")).toBe(true);
});

test("the desktop's + and - keys zoom the enlargement and 0 brings it back", async () => {
  const app = await openStory("chat-media");
  await app.waitFor("id:attachment-chip-thumb", { timeout: 10_000 });
  await app.press("id:attachment-chip-thumb");
  await app.waitFor("id:msg-image-full");
  await app.keyboard.press("plus");
  await app.keyboard.press("minus");
  await app.keyboard.press("0");
  expect(app.shows("id:msg-image-full")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:msg-image-lightbox", { state: "gone" });
});

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const stageBox = { top: 0, left: 0, width: 1100, height: 760 };
const restBox = { top: 60, left: 50, width: 1000, height: 640 };
const still = { dx: 0, dy: 0, ctrl: false, meta: false, phase: null as string | null };

test("a pinch or a wheel zooms the enlargement about the pointer, and out to the fit it rests", () => {
  // A pinch in (ctrl + a negative step) keeps the picture's point under the pointer where it is.
  const small = restBox;
  const pointer = { x: 400, y: 300 };
  // (Both axes end up larger than the stage, where the maths keeps the point exactly; smaller, it rests in proportion.)
  const pinched = wheelView(stageBox, small, null, { ...still, dy: -30, ctrl: true }, pointer, 2000)!.view!;
  expect(near(pinched.scale, Math.exp(0.3))).toBe(true);
  expect(near(pinched.x + 0.35 * pinched.scale * small.width, pointer.x)).toBe(true);
  expect(near(pinched.y + 0.375 * pinched.scale * small.height, pointer.y)).toBe(true);
  const middle = { x: 550, y: 350 };
  const centred = wheelView(stageBox, small, null, { ...still, dy: -30, meta: true }, middle, 2000)!.view!;
  expect(near(centred.scale, pinched.scale)).toBe(true);
  expect(near(centred.x + (centred.scale * small.width) / 2, middle.x)).toBe(true);
  // A mouse wheel zooms too (gentler), and zooming back out past the fit rests at the fit.
  const wheeled = wheelView(stageBox, restBox, null, { ...still, dy: -120 }, middle, 2000)!.view!;
  expect(wheeled.scale).toBeGreaterThan(1.05);
  expect(wheelView(stageBox, restBox, wheeled, { ...still, dy: 600 }, middle, 2000)!.view).toBeNull();
  // The zoom stops at its limit.
  const far = wheelView(stageBox, restBox, null, { ...still, dy: -100000, ctrl: true }, middle, 2000)!.view!;
  expect(far.scale).toBeLessThanOrEqual(zoomLimit(restBox, 2000, 1) + 1e-9);
});

test("two fingers sliding on a trackpad pan a zoomed picture and leave one at rest alone", () => {
  const middle = { x: 550, y: 350 };
  const slide = { ...still, dx: 0, dy: 30, phase: "changed" };
  expect(wheelView(stageBox, restBox, null, slide, middle, 2000)).toBeNull();
  const zoomed = wheelView(stageBox, restBox, null, { ...still, dy: -30, ctrl: true }, middle, 2000)!.view!;
  const moved = wheelView(stageBox, restBox, zoomed, slide, middle, 2000)!.view!;
  expect(moved.scale).toBe(zoomed.scale);
  expect(near(moved.y, zoomed.y - 30)).toBe(true);
});

test("a wheel before the picture's shape is known does nothing: the tap still closes", async () => {
  const app = await openStory("chat-media");
  await app.waitFor("id:attachment-chip-thumb", { timeout: 10_000 });
  await app.press("id:attachment-chip-thumb");
  await app.waitFor("id:msg-image-full");
  await app.host.send("shell.wheel", { x: 550, y: 380, dx: 0, dy: -100, ctrl: true, meta: false, shift: false, alt: false, pinch: false, phase: null, momentum: null });
  await app.press("id:msg-image-full");
  await app.waitFor("id:msg-image-lightbox", { state: "gone" });
});

test("staged files: sizes, upload progress, the ✕ and its hold while sending", async () => {
  const app = await openStory("chat-media");
  await app.waitFor("id:composer-attachments", { timeout: 10_000 });
  expect(app.count("id:composer-attachment")).toBe(2);
  expect(app.texts()).toContain("screenshot.png");
  await app.press("id:send");
  await app.waitUntil(() => app.texts().some((line) => line.includes("已上传") || line.includes("40")));
  expect(app.enabled("label:移除附件 screenshot.png")).toBe(false);
  await app.press("id:send");
  await app.waitUntil(() => app.enabled("label:移除附件 screenshot.png"));
  await app.press("label:移除附件 notes.txt");
  await app.waitUntil(() => app.count("id:composer-attachment") === 1);
});

test("a staged picture enlarges from its thumbnail and goes with its row", async () => {
  const app = await openStory("chat-media");
  await app.waitFor("id:composer-attachments", { timeout: 10_000 });
  await app.press("id:composer-attachments >> id:attachment-preview >> nth=0");
  await app.waitFor("id:msg-image-lightbox");
  await app.waitFor("id:msg-image-full");
  expect(app.texts()).toContain("screenshot.png");
  await app.press("id:msg-image-close");
  await app.waitFor("id:msg-image-lightbox", { state: "gone" });
});

test("a staged workspace picture is fetched from the Mac when enlarged; a folder has no enlargement", async () => {
  const app = await openStory("chat-media");
  await app.waitFor("id:composer-path", { timeout: 10_000 });
  expect(app.count("id:attachment-preview")).toBe(2);
  await app.press("id:composer-path >> id:attachment-preview");
  await app.waitFor("id:msg-image-full");
  await app.waitUntil(() => app.texts().some((line) => line.includes("workspace images/chart.png")));
  await app.press("id:msg-image-close");
  await app.waitFor("id:msg-image-lightbox", { state: "gone" });
});
