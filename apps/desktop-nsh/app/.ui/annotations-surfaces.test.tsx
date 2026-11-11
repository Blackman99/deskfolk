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
const eventLine = (app: App) => {
  const texts = app.texts();
  return texts[texts.length - 1] ?? "";
};

test("the list counts the file's annotations and filters them by state", async () => {
  const app = await show("list", "id:annotation-list");
  expect(app.texts()).toContain("3 条批注");
  for (const id of ["d", "o", "r"]) expect(app.shows(`id:annotation-item-${id}`)).toBe(true);
  await app.press("id:annotation-filter-resolved");
  await app.waitFor("id:annotation-item-d", { state: "gone" });
  expect(app.shows("id:annotation-item-r")).toBe(true);
  expect(app.texts().some((t) => t.includes("Writer 已处理：改名为 picked"))).toBe(true);
  await app.press("id:annotation-filter-draft");
  await app.waitFor("id:annotation-item-d");
  expect(app.shows("id:annotation-item-r")).toBe(false);
});

test("a draft is edited in place and deleted; a sent one is resolved or reopened and cannot be deleted", async () => {
  const app = await show("list", "id:annotation-list");
  await app.press("id:annotation-item-d >> id:annotation-edit");
  await app.type("id:annotation-edit-input", "改成 picked");
  await app.press("id:annotation-edit-save");
  await app.waitUntil(() => eventLine(app).includes("edit:d:"));
  expect(eventLine(app)).toContain("改成 picked");
  expect(app.shows("id:annotation-item-o >> id:annotation-delete")).toBe(false);
  await app.press("id:annotation-item-o >> id:annotation-resolve");
  await app.waitUntil(() => eventLine(app).includes("status:o:resolved"));
  await app.press("id:annotation-item-r >> id:annotation-reopen");
  await app.waitUntil(() => eventLine(app).includes("status:r:open"));
  await app.press("id:annotation-item-d >> id:annotation-delete");
  await app.waitFor("id:annotation-item-d", { state: "gone" });
  await app.press("id:annotation-item-o >> id:annotation-reveal");
  await app.waitUntil(() => eventLine(app).includes("reveal:o"));
});

test("the cancel in the edit box leaves the draft as it was", async () => {
  const app = await show("list", "id:annotation-list");
  await app.press("id:annotation-item-d >> id:annotation-edit");
  await app.waitFor("id:annotation-edit-input");
  await app.press("id:annotation-edit-cancel");
  await app.waitFor("id:annotation-edit-input", { state: "gone" });
  expect(eventLine(app)).toBe("—");
});

test("cards name the file, the place, the remark and the state; the state toggles and the way back shows", async () => {
  const app = await show("cards", "id:annotation-cards");
  expect(app.texts()).toContain("docs/weekly.md");
  expect(app.texts().some((t) => t.includes("第 3–4 行"))).toBe(true);
  expect(app.texts()).toContain("这里换个名字");
  await app.waitFor("id:annotation-stale");
  await app.press("id:annotation-card-c1 >> id:annotation-toggle");
  await app.waitUntil(() => eventLine(app).includes("status:c1:resolved"));
  await app.press("id:annotation-card-c2 >> id:annotation-toggle");
  await app.waitUntil(() => eventLine(app).includes("status:c2:open"));
  await app.press("id:annotation-card-c1 >> id:annotation-card-open");
  await app.waitUntil(() => eventLine(app).includes("open:c1"));
  await app.press("id:annotation-source");
  await app.waitUntil(() => eventLine(app).includes("source"));
});

test("the composer saves a trimmed remark and is not offered an empty one", async () => {
  const app = await show("composer", "id:annotation-composer");
  expect(app.texts()).toContain("第 3 行");
  await expect(app.press("id:annotation-composer-save")).rejects.toThrow("disabled");
  expect(eventLine(app)).toBe("—");
  await app.type("id:annotation-composer-input", "  这里不对  ");
  await app.press("id:annotation-composer-save");
  await app.waitUntil(() => eventLine(app).includes("save:这里不对"));
  await app.press("id:annotation-composer-cancel");
  await app.waitUntil(() => eventLine(app).endsWith("cancel"));
});

test("the send bar sends the summary and clears only after a confirm", async () => {
  const app = await show("sendbar", "id:annotation-send-bar");
  expect(app.texts().some((t) => t.includes("3 条批注待发送"))).toBe(true);
  expect(app.texts()).toContain("将发到你和 Writer 的私聊");
  expect(app.shows("id:annotation-send-cap")).toBe(false);
  await app.type("id:annotation-send-summary", " 三处都改一下 ");
  await app.press("id:annotation-send");
  await app.waitUntil(() => eventLine(app).includes("send:三处都改一下"));
  await app.press("id:annotation-clear");
  await app.waitFor("id:annotation-clear-yes");
  await app.press("id:annotation-clear-no");
  await app.waitFor("id:annotation-clear-yes", { state: "gone" });
  expect(eventLine(app)).not.toContain("clear");
  await app.press("id:annotation-clear");
  await app.press("id:annotation-clear-yes");
  await app.waitUntil(() => eventLine(app).includes("clear"));
});
