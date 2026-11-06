import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof open>>;

const open = async (options: Parameters<typeof openStory>[1] = {}) => {
  const app = await openStory("spend-b", options);
  await app.waitFor("id:quality-report", { timeout: 15_000 });
  return app;
};

const botIds = (app: App) => ["bot-writer", "bot-gone", "bot-extra-1", "bot-extra-2", "bot-extra-3", "bot-extra-4", "bot-extra-5"].filter((id) => app.shows(`id:quality-bot-${id}`));

test("the report totals the week, lists the busiest five Bots with their figures, and the rest wait behind a button", async () => {
  const app = await open();
  expect(app.texts()).toContain("质量（近 7 天）");
  // The week in five tiles; the Bots below are the busiest by hand-overs.
  expect(app.texts()).toContain("86%");
  expect(app.texts()).toContain("18 / 21");
  expect(app.shows("id:quality-kpi-per-approved")).toBe(true);
  expect(botIds(app)).toEqual(["bot-writer", "bot-extra-2", "bot-extra-3", "bot-extra-4", "bot-extra-5"]);
  expect(app.texts()).toContain("50%");
  expect(app.texts()).toContain("<$0.01");
  expect(app.shows("id:quality-bot-bot-gone")).toBe(false);
  await app.press("id:quality-more");
  await app.waitFor("id:quality-bot-bot-gone");
  expect(botIds(app)).toHaveLength(7);
  // The Bot gone from the roster has no name; its row says so.
  expect(app.texts()).toContain("已删除的 Bot");
  await app.press("id:quality-more");
  await app.waitFor("id:quality-bot-bot-gone", { state: "gone" });
});

test("a Bot opens to its model and plan lines, and closes again", async () => {
  const app = await open();
  expect(app.shows("id:quality-lines-bot-writer")).toBe(false);
  await app.press("id:quality-toggle-bot-writer");
  await app.waitFor("id:quality-lines-bot-writer");
  expect(app.texts()).toContain("opus");
  expect(app.texts()).toContain("sonnet");
  expect(app.texts()).toContain("report");
  expect(app.texts()).toContain("video");
  // Turned back is review, user and checks, in that order.
  expect(app.texts()).toContain("2 · 1 · 0");
  expect(app.texts()).toContain("$3.20");
  await app.press("id:quality-toggle-bot-writer");
  await app.waitFor("id:quality-lines-bot-writer", { state: "gone" });
});

test("on a phone the report stacks: each count is named and the meter has its own line", async () => {
  const app = await open({ width: 420, height: 800 });
  expect(app.shows("id:quality-rate-bot-writer")).toBe(true);
  expect(app.texts()).toContain("50%");
  await app.press("id:quality-toggle-bot-writer");
  await app.waitFor("id:quality-line-bot-writer-0");
  expect(app.texts()).toContain("2 · 1 · 0");
});
