import { afterAll, expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

const log = (app: App) => app.texts().find((text) => text.startsWith("log:")) ?? "";
const state = (app: App) => app.texts().find((text) => text.startsWith("state:")) ?? "";
const has = (app: App, text: string) => app.texts().includes(text);
const count = (app: App) => app.texts().find((text) => /^\d+\/\d+$/.test(text)) ?? "";

/** The story with a file made by `button` open in the viewer. */
async function opened(button: string): Promise<App> {
  const app = await openStory("files-pdf");
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press(`id:${button}`);
  await app.waitFor("id:pdf-page-total", { timeout: 20_000 });
  return app;
}

test("the find button opens the bar, typing counts the matches and boxes the current one", async () => {
  const app = await opened("story-make");
  expect(app.shows("id:pdf-find")).toBe(false);
  await app.press("id:pdf-find-toggle");
  await app.waitFor("id:pdf-find-input");
  await app.type("id:pdf-find-input", "page");
  await app.waitUntil(() => count(app) === "1/3", { timeout: 10_000 });
  // The first match is on the page in view, boxed as the current one.
  expect(app.shows("id:pdf-find-current")).toBe(true);
  await app.press("id:pdf-find-toggle");
  expect(app.shows("id:pdf-find")).toBe(false);
  expect(app.shows("id:pdf-find-current")).toBe(false);
});

test("⌘F opens the bar; Enter and Shift+Enter, and the arrows, step and wrap, scrolling to the page", async () => {
  const app = await opened("story-make");
  await app.keyboard.press("mod+f");
  await app.waitFor("id:pdf-find-input");
  await app.type("id:pdf-find-input", "of");
  await app.waitUntil(() => count(app) === "1/3", { timeout: 10_000 });
  await app.submit("id:pdf-find-input");
  await app.waitUntil(() => count(app) === "2/3");
  await app.waitUntil(() => app.value("id:pdf-page-input") === "2");
  await app.keyboard.press("shift+enter");
  await app.waitUntil(() => count(app) === "1/3");
  await app.press("id:pdf-find-prev");
  await app.waitUntil(() => count(app) === "3/3");
  await app.waitUntil(() => app.value("id:pdf-page-input") === "3");
  await app.press("id:pdf-find-next");
  await app.waitUntil(() => count(app) === "1/3");
});

test("find ignores case, matches across the space in the query, and says when there is nothing", async () => {
  const app = await opened("story-make");
  await app.press("id:story-find");
  await app.waitFor("id:pdf-find-input");
  await app.type("id:pdf-find-input", "PAGE 2");
  await app.waitUntil(() => count(app) === "1/1", { timeout: 10_000 });
  await app.waitUntil(() => app.value("id:pdf-page-input") === "2");
  await app.clear("id:pdf-find-input");
  await app.type("id:pdf-find-input", "zzzz");
  await app.waitUntil(() => has(app, "没有找到"), { timeout: 10_000 });
  expect(app.count("id:pdf-find-current")).toBe(0);
});

test("Escape closes the bar first, then goes on to the annotation; the handle answers true only for the bar", async () => {
  const app = await opened("story-make");
  await app.keyboard.press("mod+f");
  await app.waitFor("id:pdf-find-input");
  await app.press("id:story-escape");
  expect(log(app)).toContain("escape:true");
  expect(app.shows("id:pdf-find")).toBe(false);
  await app.press("id:story-escape");
  expect(log(app)).toContain("escape:true | escape:false");
  // From the keyboard, with the cursor in the bar.
  await app.keyboard.press("mod+f");
  await app.waitFor("id:pdf-find-input");
  await app.keyboard.press("escape");
  expect(app.shows("id:pdf-find")).toBe(false);
});

test("an encrypted file asks for its password, says when it is wrong, and opens with the right one", async () => {
  const app = await openStory("files-pdf");
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press("id:story-locked");
  await app.waitFor("id:pdf-password-input", { timeout: 20_000 });
  expect(has(app, "这个 PDF 设了密码，输入密码后打开。")).toBe(true);
  expect(app.shows("id:pdf-toolbar")).toBe(false);
  await app.type("id:pdf-password-input", "nope");
  await app.press("id:pdf-password-open");
  await app.waitUntil(() => has(app, "密码不对，再试一次。"), { timeout: 10_000 });
  expect(app.value("id:pdf-password-input")).toBe("");
  await app.type("id:pdf-password-input", "open sesame");
  await app.submit("id:pdf-password-input");
  await app.waitFor("id:pdf-page-total", { timeout: 10_000 });
  expect(app.shows("id:pdf-password-input")).toBe(false);
  // And the text of the opened file is searchable.
  await app.keyboard.press("mod+f");
  await app.waitFor("id:pdf-find-input");
  await app.type("id:pdf-find-input", "secret");
  await app.waitUntil(() => count(app) === "1/1", { timeout: 10_000 });
});

test("a link inside the file jumps to its page; a web link is a labelled target", async () => {
  const app = await opened("story-links");
  await app.waitUntil(() => app.count("id:pdf-link") >= 2, { timeout: 10_000 });
  expect(app.shows("label:https://example.com/linked")).toBe(true);
  expect(app.value("id:pdf-page-input")).toBe("1");
  await app.press("label:跳到链接指向的位置");
  await app.waitUntil(() => app.value("id:pdf-page-input") === "3");
});

test("links let a drag through while choosing a box", async () => {
  const app = await opened("story-links");
  await app.waitUntil(() => app.count("id:pdf-link") >= 2, { timeout: 10_000 });
  await app.press("id:story-annotate");
  await app.drag("label:https://example.com/linked", { x: 60, y: 40 });
  expect(log(app)).toContain("draft:");
  // The jump did not happen: still on the first page.
  expect(app.value("id:pdf-page-input")).toBe("1");
});

test("a box drawn over a line of text carries that text as the anchor's quote, and a crop", async () => {
  const app = await opened("story-make");
  await app.press("id:story-annotate");
  // From the middle of page 1 down and right, over the word just below and to the right of the middle.
  await app.drag("id:pdf-marks-1", { x: 300, y: 60 });
  const draft = /draft:(\{[^}]*\})/.exec(log(app));
  expect(draft).not.toBeNull();
  const anchor = JSON.parse(draft![1]!);
  expect(anchor.quote).toBe("Middle");
  await app.waitUntil(() => /crop:image\/png:\d+/.test(log(app)), { timeout: 10_000 });
});

test("a box over blank paper has no quote", async () => {
  const app = await opened("story-make");
  await app.press("id:story-annotate");
  await app.drag("id:pdf-marks-1", { x: 40, y: 200 });
  const draft = /draft:(\{[^}]*\})/.exec(log(app));
  expect(draft).not.toBeNull();
  expect(JSON.parse(draft![1]!).quote).toBeUndefined();
});

test("the dark theme dims the pages", async () => {
  const app = await opened("story-make");
  expect(app.shows("id:pdf-dim")).toBe(false);
  await app.press("id:story-dark");
  await app.waitFor("id:pdf-dim");
  await app.press("id:story-dark");
  await app.waitFor("id:pdf-dim", { state: "gone" });
});

afterAll(async () => {
  const app = await openStory("files-pdf");
  await app.waitFor("id:files-pdf", { timeout: 15_000 });
  await app.press("id:story-clean");
  await app.waitUntil(() => state(app).startsWith("state:clean:"), { timeout: 20_000 });
  expect(state(app)).toBe("state:clean:0");
});
