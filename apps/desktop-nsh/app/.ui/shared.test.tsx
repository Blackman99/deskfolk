import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

test("a code block takes the messenger's code colours, GitHub's light and dark", async () => {
  const app = await openStory("shared");
  await app.waitFor("id:md", { timeout: 10_000 });
  await app.setColorScheme("light");
  await app.waitUntil(() => app.spanStyle("id:md >> text:const").color.toLowerCase() === "#d73a49ff");
  // The number, in GitHub's constant blue.
  expect(app.spanStyle("id:md >> text:1;").color.toLowerCase()).toBe("#005cc5ff");
  await app.setColorScheme("dark");
  await app.waitUntil(() => app.spanStyle("id:md >> text:const").color.toLowerCase() === "#f97583ff");
});

test("Markdown names a file, a picture and Bots as chips that open them", async () => {
  const app = await openStory("shared");
  await app.waitFor("id:md", { timeout: 10_000 });
  await app.waitFor("text:周报草稿");
  // A path the text wrote is a chip with the file's name; a Bot on the roster is a chip, one off it plain text.
  await app.waitFor("text:weekly.md");
  expect(app.texts()).toContain("@Editor");
  expect(app.texts()).toContain("@Nobody");
  await app.press("text:@Editor");
  await app.waitUntil(() => app.texts().includes("profile:bot-editor"));
  await app.press("id:md >> text:weekly.md");
  await app.waitUntil(() => app.texts().includes("artifact:notes/weekly.md"));
  // A picture is a card with its thumbnail once fetched, and opens in the app, handing over its
  // thumbnail: the enlargement grows out of it and starts from it, as the Svelte's does.
  await app.waitFor("id:md-artifact-image");
  await app.waitUntil(() => app.texts().includes("trend.png"));
  await app.press("id:md-artifact-image");
  await app.waitUntil(() => app.texts().some((line) => line.startsWith("image:charts/trend.png from:thumb:shown origin:72x54")));
  await app.waitFor("id:msg-image-full");
  await app.press("id:msg-image-full");
  await app.waitFor("id:msg-image-lightbox", { state: "gone" });
});

test("a right click on a file's chip opens its menu, which shows the file in Finder or opens it", async () => {
  const app = await openStory("shared");
  await app.waitFor("id:md", { timeout: 10_000 });
  await app.waitFor("text:weekly.md");
  await app.rightClick("id:md >> text:weekly.md");
  await app.waitFor("id:artifact-tree-menu");
  for (const id of ["open", "reveal", "copy-abs-path"]) expect(app.shows(`id:artifact-tree-menu-${id}`)).toBe(true);
  // Only what applies to a file a line names: no terminal, no workspace path, no Trash.
  for (const id of ["open-terminal", "copy-path", "trash"]) expect(app.shows(`id:artifact-tree-menu-${id}`)).toBe(false);
  await app.press("id:artifact-tree-menu-reveal");
  await app.waitUntil(() => app.texts().includes("reveal:/ws/notes/weekly.md"));
  expect(app.shows("id:artifact-tree-menu")).toBe(false);
  // The picture's card has the same menu.
  await app.waitUntil(() => app.texts().includes("trend.png"));
  await app.rightClick("id:md-artifact-image");
  await app.press("id:artifact-tree-menu-open");
  await app.waitUntil(() => app.texts().includes("open:/ws/charts/trend.png"));
  // Text that says nowhere on this computer leaves the right click to what is around it.
  await app.rightClick("id:md-inverted >> text:weekly.md");
  expect(app.shows("id:artifact-tree-menu")).toBe(false);
});

test("a modal closes by its ✕ and by its action", async () => {
  const app = await openStory("shared");
  await app.waitFor("id:open-modal", { timeout: 10_000 });
  await app.press("id:open-modal");
  await app.waitFor("text:新建 Bot");
  expect(app.shows("text:对话框的内容")).toBe(true);
  await app.press("id:modal-close");
  await app.waitFor("text:新建 Bot", { state: "gone" });
  await app.press("id:open-modal");
  await app.waitFor("id:modal-save");
  await app.press("id:modal-save");
  await app.waitFor("text:新建 Bot", { state: "gone" });
});

test("a confirmation keeps its box with the caller and holds while it runs", async () => {
  const app = await openStory("shared");
  await app.waitFor("id:open-danger", { timeout: 10_000 });
  await app.press("id:open-danger");
  await app.waitFor("text:删除这个小组？");
  await app.press("id:danger-option");
  await app.waitUntil(() => app.texts().includes("option:on"));
  await app.press("id:danger-confirm");
  await app.waitFor("text:正在删除…");
  await app.waitFor("text:删除这个小组？", { state: "gone" });
  await app.press("id:open-danger");
  await app.waitFor("id:danger-cancel");
  await app.press("id:danger-cancel");
  await app.waitFor("text:删除这个小组？", { state: "gone" });
});
