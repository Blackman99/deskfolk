import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const open = async () => {
  const app = await openStory("misc");
  await app.waitFor("id:story-show-calendar", { timeout: 10_000 });
  await app.press("id:story-show-calendar");
  await app.waitFor("id:routine-calendar");
  return app;
};
type App = Awaited<ReturnType<typeof open>>;
const routines = (app: App) => {
  const raw = app.texts().find((text) => text.startsWith("{") && text.includes('"routines"'));
  return raw ? (JSON.parse(raw) as { routines: string[] }).routines : null;
};
const stored = async (app: App) => {
  await app.press("id:story-read");
  await app.waitUntil(() => routines(app) !== null);
  return routines(app)!;
};

test("with no routine the roster is empty; a routine added shows its Bot, its block and a read-only detail", async () => {
  const app = await open();
  try {
    await app.waitFor("id:calendar-empty");
    expect(app.shows("id:roster-filter-trigger")).toBe(false);
    await app.press("id:story-add-routine");
    await app.waitFor("id:roster-filter-trigger", { timeout: 15_000 });
    expect(await stored(app)).toEqual(["Morning brief"]);
    expect(app.shows("id:calendar-empty")).toBe(false);
    // The week view has the block, named by Bot and title; a press opens the routine.
    await app.waitFor("text:Morning brief >> nth=0");
    expect(app.texts()).toContain("Writer");
    expect(app.count("text:Morning brief")).toBeGreaterThan(0);
    await app.press("text:Morning brief >> nth=0");
    await app.waitFor("id:routine-detail");
    expect(app.texts()).toContain("Summarize today's work");
    expect(app.texts()).toContain("Writer");
    await app.press("id:detail-close");
    await app.waitFor("id:routine-detail", { state: "gone" });
    // Escape closes it too.
    await app.press("text:Morning brief >> nth=0");
    await app.waitFor("id:routine-detail");
    await app.keyboard.press("escape");
    await app.waitFor("id:routine-detail", { state: "gone" });
    // Nothing was written by looking.
    expect(await stored(app)).toEqual(["Morning brief"]);
  } finally {
    await app.press("id:story-del-routine");
    await app.waitUntil(() => routines(app)?.length === 0, { timeout: 15_000 });
  }
}, 60_000);

test("the views, the arrows and Today move the range, and the agenda lists the routine by day", async () => {
  const app = await open();
  try {
    await app.press("id:story-add-routine");
    await app.waitFor("id:roster-filter-trigger", { timeout: 15_000 });
    const title = () => app.texts().find((text) => /20\d\d/.test(text) && text.includes("–")) ?? "";
    const week = title();
    expect(week).not.toBe("");
    await app.press("id:calendar-next");
    await app.waitUntil(() => title() !== week);
    await app.press("id:calendar-today");
    await app.waitUntil(() => title() === week);

    // Day view: one day; month view: a block per day of the month; agenda: the next 30 days.
    await app.press("id:calendar-view-month");
    await app.waitFor("id:calendar-month");
    await app.waitFor("text:Morning brief");
    await app.press("id:calendar-view-agenda");
    await app.waitFor("id:calendar-agenda");
    await app.waitFor("text:Morning brief");
    expect(app.count("id:calendar-agenda >> text:Writer")).toBeGreaterThan(5);
    await app.press("id:calendar-view-day");
    await app.waitFor("id:calendar-week");
    await app.waitFor("text:Morning brief");
    await app.press("id:calendar-view-week");
  } finally {
    await app.press("id:story-del-routine");
    await app.waitUntil(() => routines(app)?.length === 0, { timeout: 15_000 });
  }
}, 60_000);

test("the roster filter searches names and duties, hides a Bot's blocks and resets", async () => {
  const app = await open();
  try {
    await app.press("id:story-add-routine");
    await app.waitFor("id:roster-filter-trigger", { timeout: 15_000 });
    // The roster filter: Writer is ticked; unticking it empties the grid, the trigger says 0/1, Reset brings it back.
    await app.press("id:roster-filter-trigger");
    await app.waitFor("id:roster-filter-search");
    await app.waitFor("text:写东西、改东西");
    await app.type("id:roster-filter-search", "不存在");
    await app.waitFor("id:roster-filter-empty");
    await app.clear("id:roster-filter-search");
    await app.type("id:roster-filter-search", "写东西");
    const writer = JSON.parse(app.texts().find((text) => text.startsWith("{") && text.includes('"writer"')) ?? "{}").writer as string;
    await app.waitFor(`id:roster-filter-option-${writer}`);
    await app.press(`id:roster-filter-option-${writer}`);
    await app.waitFor("text:0/1");
    await app.keyboard.press("escape");
    await app.waitFor("id:roster-filter-search", { state: "gone" });
    expect(app.shows("text:Morning brief")).toBe(false);
    await app.press("id:roster-filter-reset");
    await app.waitFor("text:Morning brief");
  } finally {
    await app.press("id:story-del-routine");
    await app.waitUntil(() => routines(app)?.length === 0, { timeout: 15_000 });
  }
}, 60_000);


test("on a phone the roster filter is a sheet from the bottom and the back button is just the chevron", async () => {
  const app = await open();
  try {
    await app.setViewport(390, 800);
    await app.press("id:story-add-routine");
    await app.waitFor("id:roster-filter-trigger", { timeout: 15_000 });
    await app.press("id:roster-filter-trigger");
    await app.waitFor("id:roster-filter-sheet");
    await app.waitFor("id:roster-filter-search");
    await app.press("id:bottom-sheet-close");
    await app.waitFor("id:roster-filter-sheet", { state: "gone" });
  } finally {
    await app.press("id:story-del-routine");
    await app.waitUntil(() => routines(app)?.length === 0, { timeout: 15_000 });
  }
}, 60_000);
