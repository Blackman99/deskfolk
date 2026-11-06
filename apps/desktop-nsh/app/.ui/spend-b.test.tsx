import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof open>>;

const open = async (options: Parameters<typeof openStory>[1] = {}) => {
  const app = await openStory("spend-b", options);
  await app.waitFor("id:spend-group-0", { timeout: 15_000 });
  return app;
};

/** The story's one line of state, as an object. */
const state = (app: App) => JSON.parse(app.texts().find((t) => t.startsWith('{"events"')) ?? "{}") as { events: string[]; asked: string[]; cap: number | null; overlay: boolean };

/** The model names down the distribution table, in order. */
const rows = (app: App, count = 8) => {
  const out: string[] = [];
  for (let i = 0; i < count; i++) if (app.shows(`id:spend-group-${i}`)) out.push(String(i));
  return out;
};

test("the distribution table lists the busiest six models, the rest behind a button, and its columns show what has figures", async () => {
  const app = await open();
  expect(app.texts()).toContain("用量分布");
  expect(rows(app)).toHaveLength(6);
  expect(app.texts()).toContain("Anthropic · opus");
  expect(app.texts()).not.toContain("Other · kimi");
  // Wide: input and output columns show; both amount columns have a figure somewhere.
  expect(app.shows("id:spend-sort-input")).toBe(true);
  expect(app.shows("id:spend-sort-reported")).toBe(true);
  expect(app.shows("id:spend-sort-estimated")).toBe(true);
  expect(app.texts()).toContain("总 token ↓");
  await app.press("id:spend-group-more");
  await app.waitFor("id:spend-group-6");
  expect(app.texts()).toContain("Other · kimi");
  expect(app.texts()).toContain("收起");
  await app.press("id:spend-group-more");
  await app.waitFor("id:spend-group-6", { state: "gone" });
});

test("pressing a column head sorts by it, again reverses, and a name sorts from A", async () => {
  const app = await open();
  const first = () => app.texts().find((t) => /^(Anthropic|Other) · /.test(t));
  expect(first()).toBe("Anthropic · opus");
  await app.press("id:spend-sort-calls");
  await app.waitUntil(() => app.texts().includes("调用 ↓"));
  await app.press("id:spend-sort-calls");
  await app.waitUntil(() => app.texts().includes("调用 ↑"));
  expect(first()).toBe("Other · kimi");
  await app.press("id:spend-sort-name");
  await app.waitUntil(() => app.texts().includes("模型 ↑"));
  expect(first()).toBe("Anthropic · haiku");
  // A column with no figure in a row sinks that row, whichever way it sorts.
  await app.press("id:spend-sort-reported");
  await app.waitUntil(() => app.texts().includes("实报 ↓"));
  expect(first()).toBe("Anthropic · opus");
});

test("the dimension switch regroups: a session can be opened unless deleted, a Bot shows its face, a name drills into a filter chip", async () => {
  const app = await open();
  await app.press("id:spend-dimension-session");
  await app.waitUntil(() => app.texts().includes("Weekly notes"));
  expect(state(app).asked).toContain("summary:session");
  expect(app.shows("id:spend-open-session-0")).toBe(true);
  expect(app.texts()).toContain("Old notes");
  expect(app.texts()).toContain("已删除");
  // Only the live session has the arrow.
  expect(app.count("id:spend-open-session-1")).toBe(0);
  await app.press("id:spend-open-session-0");
  expect(state(app).events).toContain("session:sess-1");
  // Bot: faces, the unassigned row.
  await app.press("id:spend-dimension-bot");
  await app.waitUntil(() => app.texts().includes("Writer") && app.texts().includes("未归属 Bot"));
  expect(app.texts()).toContain("W");
  expect(app.texts()).toContain("Retired");
  // A name narrows the whole ledger: a chip appears and the ledger asks again.
  await app.press("id:spend-group-name-0");
  await app.waitFor("id:spend-chip-bot");
  await app.waitUntil(() => state(app).asked.filter((q) => q === "page").length >= 2);
  await app.press("id:spend-clear-all");
  await app.waitFor("id:spend-chip-bot", { state: "gone" });
});

test("the details list calls under a heading per day, tags what is gone, opens the message that woke a call, and pages", async () => {
  const app = await open();
  await app.press("id:spend-tab-details");
  await app.waitFor("id:spend-details");
  expect(app.shows("id:spend-day-2026-10-10")).toBe(true);
  expect(app.shows("id:spend-day-2026-10-09")).toBe(true);
  expect(app.texts()).toContain("10月10日周六");
  expect(app.texts()).toContain("已载入 3 次调用");
  expect(app.texts()).toContain("轮次补全");
  expect(app.texts()).toContain("选路");
  expect(app.texts()).toContain("未记录模型");
  expect(app.texts()).toContain("未归属 Bot");
  expect(app.texts()).toContain("入 1.2k · 出 300");
  // A call with an estimate says so; the one whose session is deleted is tagged and cannot be opened.
  expect(app.texts()).toContain("已删除");
  expect(app.shows("id:spend-open-trigger-row-1")).toBe(true);
  expect(app.count("id:spend-open-trigger-row-2")).toBe(0);
  expect(app.count("id:spend-open-trigger-row-3")).toBe(0);
  await app.press("id:spend-open-trigger-row-1");
  expect(state(app).events).toContain("trigger:sess-1:msg-row-1");
  // More appends a page and the button goes with the last one.
  await app.press("id:spend-load-more");
  await app.waitFor("id:spend-detail-row-4");
  expect(app.texts()).toContain("已载入 4 次调用");
  expect(app.texts()).toContain("10月8日周四");
  expect(app.shows("id:spend-load-more")).toBe(false);
  // Back to the overview: the table is there again, the filters unchanged.
  await app.press("id:spend-tab-overview");
  await app.waitFor("id:spend-groups");
  expect(app.shows("id:spend-details")).toBe(false);
});

test("a failed load offers a retry, an empty range says so, and a new revision loads again", async () => {
  const app = await open();
  await app.press("id:story-fail");
  await app.press("id:story-revision");
  await app.waitFor("id:spend-error", { timeout: 10_000 });
  expect(app.texts()).toContain("花费没有读出来。");
  expect(app.shows("id:spend-groups")).toBe(false);
  await app.press("id:story-fail");
  await app.waitUntil(() => app.enabled("id:spend-retry"));
  await app.press("id:spend-retry");
  await app.waitFor("id:spend-groups", { timeout: 10_000 });
  await app.press("id:story-none");
  await app.press("id:story-revision");
  await app.waitFor("id:spend-empty", { timeout: 10_000 });
  expect(app.shows("id:spend-groups")).toBe(false);
  // The cap stands alone above an empty ledger.
  expect(app.shows("id:spend-cap")).toBe(true);
});

test("the cap saves from the overview", async () => {
  const app = await open();
  await app.type("id:spend-cap-input", "8");
  await app.submit("id:spend-cap-input");
  await app.waitUntil(() => state(app).cap === 8);
  expect(state(app).events).toContain("cap:8");
});

test("on a phone the table is rows of two lines, the sort is a picker, and a whole row picks it", async () => {
  const app = await open({ width: 420, height: 800 });
  expect(app.shows("id:spend-back")).toBe(true);
  expect(app.shows("id:spend-sort-select")).toBe(true);
  expect(app.shows("id:spend-group-head")).toBe(false);
  expect(app.shows("id:spend-sort-calls")).toBe(false);
  expect(app.texts()).toContain("20 次调用 · 480k token");
  await app.press("id:spend-sort-dir");
  await app.waitUntil(() => app.texts().includes("↑"));
  await app.press("id:spend-dimension-session");
  await app.waitUntil(() => app.texts().includes("Weekly notes"));
  await app.press("id:spend-group-0");
  await app.waitFor("id:spend-chip-session");
  await app.press("id:spend-back");
  expect(state(app).events).toContain("close");
  await app.press("id:spend-tab-details");
  await app.waitFor("id:spend-details");
  // Two lines per call; the whole row opens the message.
  expect(app.shows("id:spend-detail-head")).toBe(false);
  await app.press("id:spend-detail-row-1");
  expect(state(app).events).toContain("trigger:sess-1:msg-row-1");
});

test("the page form fills its host with the runtime's ledger, and the story's switch takes it away", async () => {
  const app = await open();
  expect(app.shows("id:spend-page")).toBe(false);
  await app.press("id:story-overlay");
  await app.waitFor("id:spend-page");
  expect(app.shows("id:spend-view")).toBe(true);
  expect(app.shows("id:spend-header")).toBe(true);
  await app.press("id:story-overlay");
  await app.waitFor("id:spend-page", { state: "gone" });
});
