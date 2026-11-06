import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const opened = async () => {
  const app = await openStory("plan-panel");
  await app.waitFor("id:plan-spec-goal", { timeout: 10_000 });
  const logged = (line: string) => app.texts().some((t) => t.includes(line));
  const read = async () => {
    await app.press("id:story-read");
    return app.texts().find((t) => t.startsWith("read:")) ?? "";
  };
  return { app, logged, read };
};

test("the goal, what needs you, the contract, the progress and the job card all read", async () => {
  const { app } = await opened();
  expect(app.texts()).toContain("写出本周周报");
  // A failed check, blocked progress and a requirement waiting on you: one block names them.
  await app.waitFor("id:plan-spec-attention");
  expect(app.shows("id:plan-spec-attention-c-fail")).toBe(true);
  expect(app.texts()).toContain("等财务给口径");
  expect(app.shows("id:plan-spec-attention-waiting")).toBe(true);
  // The contract.
  expect(app.shows("id:plan-spec-list-acceptance")).toBe(true);
  expect(app.texts()).toContain("数字回读一遍");
  expect(app.shows("id:plan-spec-list-progress.blocked")).toBe(true);
  expect(app.shows("id:plan-overview")).toBe(true);
  expect(app.shows("id:plan-requirements")).toBe(true);
  expect(app.shows("id:plan-spec-about")).toBe(true);
});

test("done is folded while anything is open; its head opens it", async () => {
  const { app } = await opened();
  expect(app.texts()).not.toContain("收集数据");
  await app.press("id:plan-spec-fold-done");
  await app.waitUntil(() => app.texts().includes("收集数据"));
  await app.press("id:plan-spec-fold-done");
  await app.waitUntil(() => !app.texts().includes("收集数据"));
});

test("editing the goal saves the whole spec against the revision it read", async () => {
  const { app, logged, read } = await opened();
  await app.press("id:plan-spec-edit-goal");
  await app.clear("id:plan-spec-goal-input");
  await app.type("id:plan-spec-goal-input", "写出本周和上周的周报");
  await app.press("id:plan-spec-goal-save");
  await app.waitUntil(() => logged("patchSpec:rev3:goal=写出本周和上周的周报"));
  await app.waitFor("id:plan-spec-goal-input", { state: "gone" });
  expect(await read()).toContain("goal=写出本周和上周的周报;rev=4");
});

test("editing a list takes one line each; cancel leaves it", async () => {
  const { app, logged } = await opened();
  await app.press("id:plan-spec-edit-acceptance");
  await app.clear("id:plan-spec-lines-acceptance");
  await app.type("id:plan-spec-lines-acceptance", "有对比表\n有结论\n有附录");
  await app.press("id:plan-spec-acceptance-save");
  await app.waitUntil(() => logged("acc=有对比表|有结论|有附录"));
  await app.press("id:plan-spec-edit-rules");
  await app.press("id:plan-spec-rules-cancel");
  await app.waitFor("id:plan-spec-lines-rules", { state: "gone" });
});

test("a conflict says so and asks the parent to reload", async () => {
  const { app, logged } = await opened();
  await app.press("id:story-conflict");
  await app.press("id:plan-spec-edit-process");
  await app.type("id:plan-spec-lines-process", "先列提纲");
  await app.press("id:plan-spec-process-save");
  await app.waitUntil(() => logged("conflict"));
  await app.waitFor("id:plan-spec-error");
  // The box stays open with the draft.
  expect(app.shows("id:plan-spec-lines-process")).toBe(true);
});

test("renaming the job sends the name only and says the goal beside it", async () => {
  const { app, logged, read } = await opened();
  await app.press("id:plan-spec-edit-title");
  await app.clear("id:plan-spec-name-input");
  await app.type("id:plan-spec-name-input", "月报");
  await app.press("id:plan-spec-title-save");
  await app.waitUntil(() => logged("rename:月报"));
  expect(await read()).toContain("title=月报");
  await app.waitFor("id:plan-spec-edit-goal-link");
  await app.press("id:plan-spec-edit-goal-link");
  await app.waitFor("id:plan-spec-goal-input");
});

test("the job's scale is yours to set and to call off", async () => {
  const { app, logged, read } = await opened();
  // Nothing has read it either way: no line, no button.
  expect(app.shows("id:plan-spec-scale")).toBe(false);
  await app.press("id:story-scale-single");
  await app.waitFor("id:plan-spec-scale");
  expect(app.shows("id:plan-spec-scale-single")).toBe(false);
  await app.press("id:plan-spec-scale-large");
  await app.waitUntil(() => logged("scale:large"));
  await app.waitFor("id:plan-spec-scale-single");
  expect(await read()).toContain("scale=large");
  await app.press("id:plan-spec-scale-single");
  await app.waitUntil(() => logged("scale:single"));
  await app.waitFor("id:plan-spec-scale-large");
});

test("run all puts the new outcomes on the checks", async () => {
  const { app, logged } = await opened();
  await app.press("id:plan-spec-checks-run");
  await app.waitUntil(() => logged("runChecks"));
  await app.waitUntil(() => !app.shows("id:plan-spec-attention-c-fail"));
});

test("the history opens on the versions, who wrote each and a jump to the message", async () => {
  const { app, logged } = await opened();
  await app.press("id:plan-spec-history-toggle");
  await app.waitFor("id:plan-spec-revision-3");
  expect(app.texts()).toContain("写周报");
  await app.press("id:plan-spec-revision-jump-3");
  await app.waitUntil(() => logged("jump:group-1:m9"));
  await app.press("id:plan-spec-history-toggle");
  await app.waitFor("id:plan-spec-history", { state: "gone" });
});

test("a ticket picked on the board stands out; a press shows it, the cross puts it down", async () => {
  const { app, logged, read } = await opened();
  expect(app.shows("id:plan-spec-focus")).toBe(false);
  await app.press("id:story-select");
  await app.waitFor("id:plan-spec-focus");
  await app.press("id:plan-spec-focus-ticket");
  await app.waitUntil(() => logged("ticket:tk-2"));
  await app.press("id:plan-spec-focus-clear");
  await app.waitFor("id:plan-spec-focus", { state: "gone" });
  expect((await read()).endsWith("selected=")).toBe(true);
});

test("without a client the panel only reads; an unwritten plan shows the brief", async () => {
  const { app } = await opened();
  await app.press("id:story-no-api");
  await app.waitFor("id:plan-spec-edit-goal", { state: "gone" });
  expect(app.shows("id:plan-spec-history-toggle")).toBe(false);
  await app.press("id:story-empty");
  await app.waitFor("id:plan-spec-blank");
  expect(app.texts().some((t) => t.includes("每周写一份周报"))).toBe(true);
  expect(app.shows("id:plan-spec-goal")).toBe(false);
});

test("on a phone width the panel is one column with the same parts", async () => {
  const app = await openStory("plan-panel", { width: 600 });
  await app.waitFor("id:plan-spec-goal", { timeout: 10_000 });
  expect(app.shows("id:plan-overview")).toBe(true);
  expect(app.shows("id:plan-spec-list-acceptance")).toBe(true);
  expect(app.shows("id:plan-spec-about")).toBe(true);
});
