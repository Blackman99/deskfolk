import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const opened = async () => {
  const app = await openStory("plan");
  await app.waitFor("id:plan-overview", { timeout: 10_000 });
  return { app };
};

test("a check is a pill that opens to what it measures, its last run and its output", async () => {
  const { app } = await opened();
  // Pills read by outcome; nothing is open yet.
  expect(app.texts()).toContain("通过");
  expect(app.texts()).toContain("没过");
  expect(app.shows("id:check-c-fail >> id:check-detail")).toBe(false);
  await app.press("id:check-c-fail >> id:check-pill");
  await app.waitFor("id:check-c-fail >> id:check-detail");
  expect(app.texts()).toContain("运行 `make check`，期望退出码 0");
  expect(app.texts()).toContain("退出码 1");
  expect(app.texts()).toContain("line one\nline two");
  expect(app.texts()).toContain("你加的");
  await app.press("id:check-c-fail >> id:check-pill");
  await app.waitFor("id:check-c-fail >> id:check-detail", { state: "gone" });
});

test("rerun goes to the daemon and the plan that comes back replaces the pill", async () => {
  const { app } = await opened();
  await app.press("id:check-c-fail >> id:check-pill");
  await app.press("id:check-c-fail >> id:check-rerun");
  await app.waitUntil(() => app.texts().some((t) => t.includes("runChecks:c-fail")));
  await app.waitUntil(() => app.texts().includes("这次通过了"));
  expect(app.texts()).not.toContain("没过");
});

test("an offered check waits for you; confirming puts it in force", async () => {
  const { app } = await opened();
  await app.press("id:check-c-offer >> id:check-pill");
  expect(app.texts()).toContain("待确认");
  expect(app.texts()).toContain("你确认之后它才拦东西；交付了就先量给你看。");
  // From your words: nothing to edit.
  expect(app.shows("id:check-c-offer >> id:check-edit")).toBe(false);
  await app.press("id:check-c-offer >> id:check-confirm");
  await app.waitUntil(() => app.texts().some((t) => t.includes("confirmCheck:c-offer")));
  await app.waitFor("id:check-c-offer >> id:check-confirm", { state: "gone" });
});

test("removing a check asks first; cancelling keeps it, confirming deletes it", async () => {
  const { app } = await opened();
  await app.press("id:check-c-pass >> id:check-pill");
  await app.press("id:check-c-pass >> id:check-remove");
  await app.waitFor("id:danger-dialog");
  await app.press("id:danger-cancel");
  await app.waitFor("id:danger-dialog", { state: "gone" });
  expect(app.shows("id:check-c-pass")).toBe(true);
  await app.press("id:check-c-pass >> id:check-remove");
  await app.press("id:danger-confirm");
  await app.waitFor("id:check-c-pass", { state: "gone" });
  expect(app.texts().some((t) => t.includes("deleteCheck:c-pass"))).toBe(true);
});

test("the form flags what is missing, shows each kind's fields, and creates the check", async () => {
  const { app } = await opened();
  await app.press("id:add-check");
  await app.waitFor("id:check-form");
  // `exists` is first: a path, nothing else.
  expect(app.shows("id:check-form-path")).toBe(true);
  expect(app.shows("id:check-form-pattern")).toBe(false);
  await app.press("id:check-form-save");
  await app.waitFor("text:填文件路径");
  await app.press("id:check-kind-contains");
  await app.waitFor("id:check-form-pattern");
  expect(app.shows("text:填文件路径")).toBe(false);
  await app.press("id:check-kind-command");
  await app.waitFor("id:check-form-command");
  expect(app.shows("id:check-form-path")).toBe(false);
  await app.press("id:check-form-expect-toggle");
  await app.waitFor("id:check-form-expect-stdout");
  await app.press("id:check-kind-exists");
  await app.type("id:check-form-path", "out/summary.md");
  await app.press("id:check-form-save");
  await app.waitFor("id:check-form", { state: "gone" });
  expect(app.texts().some((t) => t.includes("createCheck:exists:有对比表"))).toBe(true);
  expect(app.texts()).toContain("1/4");
});

test("cancel closes the form without a request; a check of yours edits in place", async () => {
  const { app } = await opened();
  await app.press("id:add-check");
  await app.press("id:check-form-cancel");
  await app.waitFor("id:check-form", { state: "gone" });
  expect(app.texts().some((t) => t.startsWith("createCheck"))).toBe(false);
  await app.press("id:check-c-pass >> id:check-pill");
  await app.press("id:check-c-pass >> id:check-edit");
  await app.waitFor("id:check-c-pass >> id:check-form");
  await app.type("id:check-form-path", "x");
  await app.press("id:check-form-save");
  await app.waitFor("id:check-c-pass >> id:check-form", { state: "gone" });
  expect(app.texts().some((t) => t.includes("patchCheck:c-pass:exists"))).toBe(true);
});
