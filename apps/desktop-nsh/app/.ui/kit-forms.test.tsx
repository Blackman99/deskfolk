import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

test("choosing an option in a Select reports its value", async () => {
  const app = await openStory("kit-forms");
  await app.waitFor("id:model", { timeout: 10_000 });
  expect(app.texts()).toContain("选择模型");
  await app.press("id:model");
  await app.waitFor("text:Sonnet");
  await app.press("text:Sonnet");
  await app.waitUntil(() => app.texts().includes("model=sonnet"));
  expect(app.texts()).toContain("Sonnet");
});

test("a MultiSelect toggles options and keeps the list open", async () => {
  const app = await openStory("kit-forms");
  await app.waitFor("id:people-value", { timeout: 10_000 });
  await app.press("id:people-trigger");
  await app.waitFor("text:Writer");
  await app.press("text:Writer");
  await app.press("text:Coder");
  await app.waitUntil(() => app.texts().includes("people=Writer,coder"));
  await app.press("text:Writer");
  await app.waitUntil(() => app.texts().includes("people=coder"));
});

test("a bottom sheet opens and closes by its ✕ and its backdrop", async () => {
  const app = await openStory("kit-forms");
  await app.waitFor("id:open-sheet", { timeout: 10_000 });
  await app.press("id:open-sheet");
  await app.waitFor("text:选择动作");
  expect(app.shows("text:复制")).toBe(true);
  await app.press("id:bottom-sheet-close");
  await app.waitFor("text:选择动作", { state: "gone" });
  await app.press("id:open-sheet");
  await app.waitFor("text:选择动作");
  await app.press("text:复制");
  await app.waitFor("text:选择动作", { state: "gone" });
  expect(app.texts()).toContain("copy");
});

test("a toast shows, runs its action, and closes by its ✕", async () => {
  const app = await openStory("kit-forms");
  await app.waitFor("id:show-toast", { timeout: 10_000 });
  await app.press("id:show-toast");
  await app.waitFor("id:toast");
  expect(app.texts()).toContain("已复制");
  await app.press("id:toast-close");
  await app.waitFor("id:toast", { state: "gone" });
  await app.press("id:show-toast");
  await app.waitFor("id:toast");
  await app.press("id:toast-action");
  await app.waitFor("id:toast", { state: "gone" });
  expect(app.texts()).toContain("undone");
});

test("an empty state says what is missing and what to do", async () => {
  const app = await openStory("kit-forms");
  await app.waitFor("id:empty-state", { timeout: 10_000 });
  expect(app.texts()).toContain("还没有对话");
  expect(app.texts()).toContain("从左边选一个 Bot 开始");
});

test("the update notice offers a reload and can be waved off", async () => {
  const app = await openStory("kit-forms");
  await app.waitFor("id:build-update", { timeout: 10_000 });
  await app.press("id:build-update-dismiss");
  await app.waitFor("id:build-update", { state: "gone" });
});

test("the navigation bar reports the destination and the image menu closes", async () => {
  const app = await openStory("kit-forms");
  await app.waitFor("id:mobile-nav", { timeout: 10_000 });
  await app.press("id:nav-settings");
  await app.press("id:open-image");
  await app.waitFor("id:image-context-menu");
  expect(app.texts()).toContain("复制图片");
});
