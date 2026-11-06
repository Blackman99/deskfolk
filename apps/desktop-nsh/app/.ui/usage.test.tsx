import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const open = async (options: Parameters<typeof openStory>[1] = {}) => {
  const app = await openStory("usage", options);
  await app.waitFor("id:usage-board", { timeout: 15_000 });
  return app;
};

test("the tab lays out a card per account, each window a bar, today-only agents as chips", async () => {
  const app = await open();
  // Claude: one account, three windows (the model's one on a line with its length).
  await app.waitFor("id:usage-account-");
  expect(app.texts()).toContain("已用38%");
  expect(app.texts()).toContain("已用19%");
  expect(app.texts()).toContain("已用45%");
  expect(app.texts()).toContain("Opus · 7 天");
  expect(app.count("id:usage-window-Opus")).toBe(1);
  expect(app.texts()).toContain("5 小时");
  // Codex: two accounts, each in a card of its own.
  expect(app.count("id:usage-account-/x/.codex-b")).toBe(1);
  expect(app.texts()).toContain("已用92%");
  expect(app.texts()).toContain("已用10%");
  expect(app.count("id:usage-account-plan")).toBe(3);
  // The bars, not dials; Grok has this app's records of today only.
  expect(app.shows("id:usage-gauges")).toBe(false);
  expect(app.shows("id:usage-today-only")).toBe(true);
  expect(app.shows("id:usage-chip-grok")).toBe(true);
  expect(app.texts()).toContain("今天 12 轮 · 340k token");
  expect(app.texts()).toContain("今天 31 轮 · 1.2M token");
  expect(app.shows("id:usage-checked")).toBe(true);
});

test("Refresh asks again and the bar brings a hidden ball back", async () => {
  const app = await open();
  await app.press("id:place-default");
  await app.press("id:usage-refresh");
  await app.waitFor("text:正在刷新…", { timeout: 2000 }).catch(() => {});
  await app.waitUntil(() => app.enabled("id:usage-refresh"));
  // Hide the ball from its context menu; the tab then offers to show it.
  expect(app.shows("id:usage-tab-widget")).toBe(false);
  await app.waitFor("id:usage-ball");
  await app.rightClick("id:usage-ball");
  await app.waitFor("id:usage-menu-hide");
  await app.press("id:usage-menu-hide");
  await app.waitFor("id:usage-ball", { state: "gone" });
  await app.waitFor("id:usage-tab-widget");
  expect(app.texts().some((t) => t.includes('"hidden":true'))).toBe(true);
  expect(app.storage()["real-bot-usage-widget"]).toContain('"hidden":true');
  await app.press("id:usage-tab-widget");
  await app.waitFor("id:usage-tab-widget", { state: "gone" });
  await app.waitFor("id:usage-ball");
});

test("pointed at, the ball opens a column of the agents, each ringed; an agent's card lists its accounts", async () => {
  const app = await open();
  await app.press("id:place-default");
  await app.waitFor("id:usage-ball");
  expect(app.shows("id:usage-column")).toBe(false);
  await app.hover("id:usage-ball");
  await app.waitFor("id:usage-column");
  expect(app.shows("id:usage-bubble-claude_code:")).toBe(true);
  expect(app.shows("id:usage-bubble-codex:")).toBe(true);
  expect(app.shows("id:usage-bubble-grok:")).toBe(true);
  // The nearly spent Codex window says so in the bubble's label, Grok has only its day.
  await app.waitFor("label:Codex 已用92%");
  await app.waitFor("label:Grok");
  await app.hover("id:usage-bubble-codex:");
  await app.waitFor("id:usage-card-codex:");
  expect(app.count("id:usage-card-codex: >> id:usage-account-plan")).toBe(2);
  expect(app.shows("id:usage-card-claude_code:")).toBe(false);
  await app.hover("id:usage-bubble-grok:");
  await app.waitFor("id:usage-card-grok:");
  await app.waitFor("id:usage-card-note");
  expect(app.shows("id:usage-card-codex:")).toBe(false);
});

test("a press pins the card open, Escape folds everything", async () => {
  const app = await open();
  await app.press("id:place-default");
  await app.press("id:usage-ball");
  await app.waitFor("id:usage-column");
  // Opened by a press: the first agent's card comes with it.
  await app.waitFor("id:usage-card-claude_code:");
  expect(app.texts().some((t) => t.includes('"open":true'))).toBe(true);
  await app.press("id:usage-bubble-codex:");
  await app.waitFor("id:usage-card-codex:");
  await app.press("id:usage-card-refresh");
  await app.keyboard.press("escape");
  await app.waitFor("id:usage-card-codex:", { state: "gone" });
  await app.waitFor("id:usage-column", { state: "gone" });
  expect(app.texts().some((t) => t.includes('"open":false'))).toBe(true);
});

test("dragged by a side it docks there, dragged inward it floats free, and the place is remembered", async () => {
  const app = await open();
  await app.press("id:place-default");
  await app.waitFor("id:usage-ball");
  await app.drag("id:usage-ball", { x: -400, y: 200 });
  await app.waitUntil(() => app.texts().some((t) => t.includes('"dock":null')));
  expect(app.texts().some((t) => t.includes('"hidden":false'))).toBe(true);
  expect(app.storage()["real-bot-usage-widget"]).toContain('"dock":null');
  await app.drag("id:usage-ball", { x: -2000, y: 0 });
  await app.waitUntil(() => app.texts().some((t) => t.includes('"dock":"left"')));
  expect(app.storage()["real-bot-usage-widget"]).toContain('"dock":"left"');
});

test("with no agents the widget has no ball and the board says so", async () => {
  const app = await open();
  await app.press("id:no-agents");
  await app.waitFor("id:usage-board-empty");
  await app.waitFor("id:usage-ball", { state: "gone" });
  await app.press("id:show-widget");
  await app.waitFor("id:usage-card-empty");
  expect(app.shows("id:usage-empty")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:usage-card-empty", { state: "gone" });
});

test("the phone's page is the board in one column of dials, with Back and Refresh", async () => {
  const app = await open({ width: 400, height: 800 });
  await app.waitFor("id:usage-page");
  await app.waitFor("id:usage-gauges");
  expect(app.shows("id:usage-tab")).toBe(false);
  // A dial says the number inside the ring and "used" under it.
  expect(app.texts()).toContain("38%");
  expect(app.texts()).toContain("已用");
  expect(app.texts()).toContain("5 小时");
  expect(app.shows("id:usage-today-only")).toBe(true);
  await app.press("id:usage-refresh");
  await app.press("id:usage-page-back");
  await app.waitFor("text:back:1");
});
