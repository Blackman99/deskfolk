import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const open = async (options: Parameters<typeof openStory>[1] = {}) => {
  const app = await openStory("spend-a", options);
  await app.waitFor("id:spend-trend", { timeout: 15_000 });
  return app;
};

/** The story's one line of state, as an object. */
const state = (app: Awaited<ReturnType<typeof open>>) => JSON.parse(app.texts().find((t) => t.startsWith('{"section"')) ?? "{}") as Record<string, unknown>;

test("the overview shows the money as two figures, the counts, the token mix and the cap", async () => {
  const app = await open();
  expect(app.texts()).toContain("花费");
  expect(app.shows("id:spend-tab-overview")).toBe(true);
  expect(app.texts()).toContain("概览");
  expect(app.texts()).toContain("调用明细");
  // Reported and estimated stay beside each other, each with how many calls it covers.
  expect(app.texts()).toContain("$4.51");
  expect(app.texts()).toContain("$0.25");
  expect(app.texts()).toContain("40 次调用有记录");
  expect(app.texts()).toContain("21 次调用有记录");
  expect(app.texts()).toContain("68");
  expect(app.texts()).toContain("64%");
  expect(app.shows("id:spend-cap")).toBe(true);
  // Cached sits inside input, reasoning inside output; the bar splits each.
  expect(app.texts()).toContain("其中缓存 640k");
  expect(app.texts()).toContain("其中推理 52k");
  expect(app.count("id:spend-mix-cached")).toBe(1);
  expect(app.count("id:spend-mix-reasoning")).toBe(1);
  // Coverage is a quiet line that opens in place.
  expect(app.shows("id:spend-coverage-body")).toBe(false);
  await app.press("id:spend-coverage");
  await app.waitFor("id:spend-coverage-body");
  expect(app.texts().some((t) => t.includes("3 次调用"))).toBe(true);
  await app.press("id:spend-coverage");
  await app.waitFor("id:spend-coverage-body", { state: "gone" });
});

test("a row's money is one figure, two named figures, or a dash; a Bot's face is its letter, greyed once gone, or a blank", async () => {
  const app = await open();
  // Only reported: no tag. Only estimated: tagged. Both: each tagged.
  expect(app.count("id:amount-reported")).toBe(1);
  expect(app.count("id:amount-both")).toBe(1);
  expect(app.shows("id:amount-none")).toBe(true);
  expect(app.texts()).toContain("—");
  expect(app.texts()).toContain("W");
  expect(app.texts()).toContain("R");
  expect(app.shows("id:face-none")).toBe(true);
});

test("the cap saves on Return, clears, refuses a bad amount and says when the daemon refused", async () => {
  const app = await open();
  expect(app.texts()).toContain("今天花到这个数，就停下所有 Bot，等你在侧栏解除。");
  expect(app.shows("id:spend-cap-clear")).toBe(false);
  await app.type("id:spend-cap-input", "5");
  await app.submit("id:spend-cap-input");
  await app.waitFor("id:spend-cap-clear");
  expect(state(app).saved).toEqual(["5"]);
  expect(state(app).cap).toBe(5);
  expect(app.value("id:spend-cap-input")).toBe("5");
  // The same amount saves nothing; a bad one says so and saves nothing.
  await app.submit("id:spend-cap-input");
  expect(state(app).saved).toEqual(["5"]);
  await app.clear("id:spend-cap-input");
  await app.type("id:spend-cap-input", "-1");
  await app.submit("id:spend-cap-input");
  expect(app.texts()).toContain("填一个大于 0 的数，或者清空");
  expect(state(app).saved).toEqual(["5"]);
  // The clear button sets none.
  await app.press("id:spend-cap-clear");
  await app.waitFor("id:spend-cap-clear", { state: "gone" });
  expect(state(app).saved).toEqual(["5", "null"]);
  expect(state(app).cap).toBe(null);
  // A refusal is said, and the cap stays.
  await app.press("id:story-refuse");
  await app.type("id:spend-cap-input", "2");
  await app.submit("id:spend-cap-input");
  await app.waitUntil(() => app.texts().some((t) => t.includes("没存上")));
  expect(state(app).cap).toBe(null);
});

test("the period picker changes the range; a custom range with its ends reversed says so", async () => {
  const app = await open();
  expect(state(app).range).toBe("last7");
  await app.press("id:spend-period");
  await app.press("text:近 30 天");
  await app.waitUntil(() => state(app).range === "last30");
  expect(app.shows("id:spend-custom-dates")).toBe(false);
  await app.press("id:story-bad-range");
  await app.waitFor("id:spend-custom-dates");
  expect(app.shows("id:spend-from")).toBe(true);
  expect(app.shows("id:spend-to")).toBe(true);
  await app.waitFor("id:spend-range-error");
  expect(app.texts().some((t) => t.includes("开始日期"))).toBe(true);
});

test("pointing at or pressing a bar reads the day out; money has two plots on one scale", async () => {
  const app = await open();
  // Seven days, one bar each, nothing read out yet.
  for (let i = 0; i < 7; i++) expect(app.count(`id:spend-bar-tokens-${i}`)).toBe(1);
  expect(app.shows("id:spend-bar-tokens-7")).toBe(false);
  expect(app.shows("id:spend-readout")).toBe(false);
  expect(app.shows("id:spend-trend-legend")).toBe(true);
  await app.press("id:spend-bar-tokens-4");
  await app.waitFor("id:spend-readout");
  expect(app.texts()).toContain("10月8日");
  expect(app.texts()).toContain("375k");
  await app.hover("id:spend-bar-tokens-1");
  await app.waitUntil(() => app.texts().includes("10月5日"));
  // A day with nothing is a bar at zero; the read-out says the day's figures.
  await app.press("id:spend-bar-tokens-3");
  await app.waitUntil(() => app.texts().includes("10月7日"));
  // Money: reported and estimated, a plot each; switching drops the old selection.
  await app.press("id:spend-metric-money");
  await app.waitFor("id:spend-plot-reported");
  expect(app.shows("id:spend-plot-estimated")).toBe(true);
  expect(app.shows("id:spend-plot-tokens")).toBe(false);
  expect(app.shows("id:spend-readout")).toBe(false);
  expect(app.count("id:spend-bar-reported-6")).toBe(1);
  expect(app.count("id:spend-bar-estimated-6")).toBe(1);
  await app.press("id:spend-bar-estimated-5");
  await app.waitFor("id:spend-readout");
  expect(app.texts()).toContain("10月9日");
  await app.press("id:spend-metric-tokens");
  await app.waitFor("id:spend-plot-tokens");
  expect(app.shows("id:spend-readout")).toBe(false);
});

test("the categories show their share; a category with several lines opens, and a name or a line drills into it", async () => {
  const app = await open();
  expect(app.shows("id:spend-share-bar")).toBe(true);
  expect(app.shows("id:spend-category-turn")).toBe(true);
  expect(app.texts()).toContain("31 次调用 · 1M token");
  expect(app.texts()).toContain("80%");
  // Only a category with more than one line has a toggle.
  expect(app.shows("id:spend-category-toggle-turn")).toBe(false);
  expect(app.shows("id:spend-category-toggle-feedback")).toBe(true);
  expect(app.shows("id:spend-kinds-feedback")).toBe(false);
  await app.press("id:spend-category-toggle-feedback");
  await app.waitFor("id:spend-kinds-feedback");
  // The opened lines run past the page's fold, over the story's bar: scrolled up into view, as by hand.
  await app.scroll("id:spend-kind-route_learn", 240);
  await app.press("id:spend-kind-route_learn");
  await app.waitFor("id:spend-chip-kind");
  expect((state(app).drill as { kind: string[] }).kind).toEqual(["route_learn"]);
  // The chip clears it, and clear-all as well.
  await app.press("id:spend-chip-kind");
  await app.waitFor("id:spend-chip-kind", { state: "gone" });
  // The real ledger reloads on a drill; the names are off until it has.
  await app.waitUntil(() => app.enabled("id:spend-category-name-judgement"));
  await app.press("id:spend-category-name-judgement");
  await app.waitFor("id:spend-chip-kind");
  await app.press("id:spend-clear-all");
  await app.waitFor("id:spend-chip-kind", { state: "gone" });
  await app.waitUntil(() => app.enabled("id:spend-category-name-judgement"));
  expect(state(app).drill).toEqual({});
});

test("Refresh asks again; with no figures the overview has nothing to total", async () => {
  const app = await open();
  expect(app.shows("id:spend-summary")).toBe(true);
  await app.press("id:story-none");
  await app.press("id:spend-refresh");
  await app.waitFor("id:spend-no-figures", { timeout: 10_000 });
  expect(app.shows("id:spend-summary")).toBe(false);
});

test("the sections switch from the tabs", async () => {
  const app = await open();
  expect(state(app).section).toBe("overview");
  await app.press("id:spend-tab-details");
  await app.waitUntil(() => state(app).section === "details");
  await app.press("id:spend-tab-overview");
  await app.waitUntil(() => state(app).section === "overview");
});

test("with a tab focused, Left, Right, Home and End move between the sections", async () => {
  const app = await open();
  // Without a tab focused the keys are nobody's.
  await app.keyboard.press("right");
  expect(state(app).section).toBe("overview");
  await app.press("id:spend-tab-overview");
  await app.keyboard.press("right");
  await app.waitUntil(() => state(app).section === "details");
  await app.keyboard.press("left");
  await app.waitUntil(() => state(app).section === "overview");
  await app.keyboard.press("end");
  await app.waitUntil(() => state(app).section === "details");
  // The focus went with the section, so the keys keep working from there.
  await app.keyboard.press("home");
  await app.waitUntil(() => state(app).section === "overview");
  await app.keyboard.press("right");
  await app.waitUntil(() => state(app).section === "details");
});

test("on a phone the header is one bar with a back button, and the categories stack", async () => {
  const app = await open({ width: 400, height: 760 });
  expect(app.shows("id:spend-back")).toBe(true);
  expect(app.texts()).not.toContain("用量与调用成本");
  await app.press("id:spend-back");
  await app.waitUntil(() => state(app).closes === 1);
  expect(app.shows("id:spend-category-turn")).toBe(true);
});
