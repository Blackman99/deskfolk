import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

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
  // A picture is a card with its thumbnail once fetched, and opens in the app.
  await app.waitFor("id:md-artifact-image");
  await app.press("id:md-artifact-image");
  await app.waitUntil(() => app.texts().includes("image:charts/trend.png"));
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
