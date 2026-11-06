import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");

async function open() {
  const app = await openStory("chat-cards");
  await app.waitFor("id:show-approval", { timeout: 10_000 });
  await app.press("id:show-approval");
  await app.waitFor("id:card-approval-key");
  return app;
}

test("a request waiting on you says so, and offers allow once, allow from now and deny", async () => {
  const app = await open();
  expect(app.texts()).toContain(t.stream.waitingApproval);
  expect(app.texts()).toContain("写入 outline/ep-12.md");
  for (const id of ["approval-allow-once", "approval-allow-from-now", "approval-deny"]) {
    expect(app.shows(`id:card-approval-plain >> id:${id}`)).toBe(true);
  }
  // Allowing from now on says which mode this Bot moves to.
  expect(app.shows("id:card-approval-plain >> id:approval-allow-note")).toBe(true);
  expect(app.texts().some((text) => text.startsWith("Writer 改成「自动」"))).toBe(true);
});

test("a request that needs a key will not be allowed without one, and typing clears the complaint", async () => {
  const app = await open();
  expect(app.texts()).toContain(t.stream.endpointKey);
  expect(app.texts()).toContain(t.stream.endpointKeyHintAdd);
  expect(app.shows("id:card-approval-plain >> id:approval-key")).toBe(false);
  await app.press("id:card-approval-key >> id:approval-allow-once");
  await app.waitFor("id:approval-key-error");
  expect(app.texts()).toContain(t.stream.endpointKeyEmpty);
  expect(app.shows("id:approval-key-hint")).toBe(false);
  await app.type("id:card-approval-key >> id:approval-key", "sk-test");
  await app.waitFor("id:approval-key-hint");
  expect(app.shows("id:approval-key-error")).toBe(false);
  // The key you typed is kept (masked in the box) on the stage.
  expect(app.value("id:card-approval-key >> id:approval-key")).toBe("sk-test");
  // Denying needs no key.
  await app.press("id:card-approval-key >> id:approval-deny");
});

test("a prompt change shows its lines, folded past twelve until you ask for all", async () => {
  const app = await open();
  expect(app.texts()).toContain("改内置提示词：系统指令 · 中文");
  expect(app.texts()).toContain("影响：所有 Bot 的每一轮");
  expect(app.texts()).toContain("理由：交付没有附命令输出");
  expect(app.texts()).toContain("旧的第 8 行");
  expect(app.texts()).not.toContain("结尾新句");
  expect(app.texts()).toContain(t.prompts.card.expand);
  await app.press("id:card-approval-prompt >> id:prompt-expand");
  await app.waitFor("text:结尾新句");
  expect(app.texts()).toContain("新的第 8 行");
  expect(app.texts()).toContain(t.prompts.card.collapse);
  await app.press("id:card-approval-prompt >> id:prompt-expand");
  await app.waitFor("text:结尾新句", { state: "gone" });
  // Still waiting: no Undo or Settings link yet.
  expect(app.shows("id:card-approval-prompt >> id:prompt-open-settings")).toBe(false);
});

test("an allowed prompt change settles to its outcome and links to Settings", async () => {
  const app = await open();
  expect(app.shows("id:card-approval-prompt-done >> id:prompt-open-settings")).toBe(true);
  expect(app.shows("id:card-approval-prompt-done >> id:prompt-expand")).toBe(false);
  expect(app.shows("id:card-approval-prompt-done >> id:approval-allow-once")).toBe(false);
  expect(app.texts()).toContain(t.stream.allowed);
  expect(app.texts()).toContain(t.stream.approval);
  expect(app.texts()).toContain("附上你依据的命令输出。");
});

test("an interface change lists what it changes and can be tried in this window", async () => {
  const app = await open();
  expect(app.texts()).toContain(t.ui.card.head);
  expect(app.texts()).toContain("理由：太亮了");
  expect(app.texts()).toContain("专注模式 开");
  expect(app.texts()).toContain("侧栏更窄");
  expect(app.shows("id:card-approval-ui >> id:interface-try")).toBe(true);
  expect(app.shows("id:card-approval-ui >> id:interface-undo")).toBe(false);
  await app.press("id:card-approval-ui >> id:interface-try");
  // Either it is on trial here, with a way back, or it says it cannot be tried.
  await app.waitUntil(() => app.shows("id:interface-stop-trying") || app.shows("id:interface-cannot-try"));
  if (app.shows("id:interface-stop-trying")) {
    expect(app.texts()).toContain(t.ui.card.trying);
    await app.press("id:interface-stop-trying");
    await app.waitFor("id:interface-try");
  }
});

test("a denied request keeps its outcome and no buttons", async () => {
  const app = await open();
  expect(app.texts()).toContain(t.stream.denied);
  expect(app.texts()).toContain("删除 drafts/old.md");
  expect(app.shows("id:card-approval-denied >> id:approval-deny")).toBe(false);
  expect(app.shows("id:card-approval-denied >> id:approval-status")).toBe(true);
});
