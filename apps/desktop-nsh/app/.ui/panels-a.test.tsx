import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const open = async (options = {}) => {
  const app = await openStory("panels-a", options);
  await app.waitFor("id:skills-card", { timeout: 15_000 });
  return app;
};

test("the skills list shows each skill, its badges and its count", async () => {
  const app = await open();
  expect(app.texts()).toContain("3");
  for (const name of ["summarize", "translate", "outline"]) expect(app.texts()).toContain(name);
  expect(app.texts()).toContain("MCP");
  expect(app.texts()).toContain("已停用");
});

test("the enabled box turns a skill off and on", async () => {
  const app = await open();
  await app.press("id:skill-enabled-sk-2");
  await app.waitUntil(() => app.texts().filter((t) => t === "已停用").length === 0);
  await app.press("id:skill-enabled-sk-1");
  await app.waitUntil(() => app.texts().filter((t) => t === "已停用").length === 1);
});

test("adding a skill asks for what is missing, then saves", async () => {
  const app = await open();
  await app.press("id:skill-add");
  await app.waitFor("id:skill-editor");
  await app.press("id:skill-save");
  await app.waitFor("id:skill-name-error");
  await app.waitFor("id:skill-description-error");
  await app.waitFor("id:skill-body-error");
  await app.type("id:skill-name", "summarize");
  await app.type("id:skill-description", "when to use");
  await app.type("id:skill-body", "do it");
  await app.press("id:skill-save");
  await app.waitFor("id:skill-name-error"); // the name is taken
  await app.type("id:skill-name", "2");
  await app.press("id:skill-save");
  await app.waitFor("id:skill-editor", { state: "gone" });
  expect(app.texts()).toContain("summarize2");
  expect(app.texts().some((t) => t.includes("saved:summarize2"))).toBe(true);
});

test("editing opens the skill's own fields, and deleting asks the owner", async () => {
  const app = await open();
  await app.press("id:skill-open-sk-3");
  await app.waitFor("id:skill-editor");
  expect(app.value("id:skill-name")).toBe("outline");
  expect(app.texts()).toContain("Writer");
  await app.press("id:skill-delete");
  await app.waitFor("id:skill-editor", { state: "gone" });
  expect(app.texts().some((t) => t.includes("deleted:sk-3"))).toBe(true);
});

test("cancel closes the editor without saving", async () => {
  const app = await open();
  await app.press("id:skill-edit-sk-2");
  await app.waitFor("id:skill-editor");
  await app.type("id:skill-name", "renamed");
  await app.press("id:skill-cancel");
  await app.waitFor("id:skill-editor", { state: "gone" });
  expect(app.texts()).not.toContain("renamed");
});

test("on a phone the editor is a page whose delete sits in its body", async () => {
  const app = await open({ width: 390, height: 800 });
  await app.waitFor("id:skill-open-sk-1");
  await app.press("id:skill-open-sk-1");
  await app.waitFor("id:skill-editor");
  await app.waitFor("id:modal-back");
  await app.waitFor("id:skill-page-delete");
  expect(app.shows("id:skill-cancel")).toBe(false);
  await app.press("id:modal-back");
  await app.waitFor("id:skill-editor", { state: "gone" });
});

test("a shared skill asks before sharing, and an update shows what it would share", async () => {
  const app = await open();
  await app.waitFor("id:shared-skills-card");
  await app.press("id:share-sk-2");
  await app.waitFor("id:share-confirm-sk-2");
  await app.press("id:share-cancel-sk-2");
  await app.waitFor("id:share-sk-2");
  await app.press("id:share-sk-2");
  await app.press("id:share-confirm-sk-2");
  await app.waitFor("id:share-unshare-sk-2");
  await app.press("id:share-update-sk-1");
  await app.waitFor("id:share-review-sk-1");
  expect(app.texts()).toContain("# summarize\n\n步骤一。");
  await app.press("id:share-update-cancel-sk-1");
  await app.waitFor("id:share-review-sk-1", { state: "gone" });
  await app.press("id:share-unshare-sk-2");
  await app.waitFor("id:share-sk-2");
  // What other Bots share with this one lists below, and turns off.
  expect(app.texts()).toContain("proofread");
  await app.press("id:shared-toggle-sh-2");
  await app.waitUntil(() => app.texts().includes("打开") || app.texts().some((t) => t.includes("启用")));
});

test("the Bot's tabs report the section pressed and show counts and errors", async () => {
  const app = await open();
  await app.waitFor("id:bot-tabs");
  await app.press("id:bot-tab-memory");
  await app.waitUntil(() => app.texts().some((t) => t.includes("tab=memory")));
  await app.waitFor("id:bot-tab-error");
  await app.press("id:bot-tab-basics");
  await app.waitUntil(() => app.texts().some((t) => t.includes("tab=basics")));
  await app.waitFor("id:bot-tab-error", { state: "gone" });
});

test("the head of a nested Bot steps back and closes", async () => {
  const app = await open();
  await app.press("id:sheet-back");
  await app.waitUntil(() => app.texts().some((t) => t.includes("back=1")));
  await app.press("id:sheet-close >> nth=1");
  await app.waitUntil(() => app.texts().some((t) => t.includes("close=1")));
  expect(app.shows("id:settings-subject")).toBe(true);
});

test("a group's name is edited in its head and saved when Enter is pressed", async () => {
  const app = await open();
  await app.waitFor("id:group-identity", { timeout: 10_000 });
  expect(app.value("id:detail-group-name")).toBe("周报小组");
  expect(app.texts().some((t) => /^\d+ /.test(t))).toBe(true);
  await app.type("id:detail-group-name", "二");
  await app.submit("id:detail-group-name");
  await app.waitFor("text:saved=周报小组二", { timeout: 8000 });
  // Put the fixture's group back as other tests find it.
  await app.press("id:restore-name");
  await app.waitFor("text:saved=周报小组", { timeout: 8000 });
});

test("an empty group name says it is needed and is not saved", async () => {
  const app = await open();
  await app.waitFor("id:group-identity", { timeout: 10_000 });
  await app.press("id:blank-name");
  await app.submit("id:detail-group-name");
  await app.waitFor("id:group-name-error", { timeout: 5000 });
  expect(app.texts()).toContain("填写一个群名。");
  expect(app.texts()).toContain("saved=周报小组");
});

test("the mute row switches the conversation's notifications", async () => {
  const app = await open();
  await app.waitFor("id:session-mute-switch", { timeout: 10_000 });
  await app.press("id:session-mute-switch");
  await app.waitFor("text:muted=true", { timeout: 5000 });
  await app.press("id:session-mute-switch");
  await app.waitFor("text:muted=false", { timeout: 5000 });
});
