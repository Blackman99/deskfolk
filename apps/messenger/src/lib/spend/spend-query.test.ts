import { expect, test } from "bun:test";
import {
  addDays,
  calendarDate,
  dayQueryOf,
  kindsOfCategory,
  loadSpendView,
  nextLocalMidnight,
  saveSpendView,
  spendFilterOf,
  spendSearchParams,
  spendWindow,
  summaryQueryOf,
  zonedStart,
  type SpendDrill,
} from "./spend-query.ts";

const zone = "Asia/Shanghai";
const now = new Date("2026-09-24T03:00:00.000Z");

test("today, last 7 and last 30 are half-open windows in the view's zone", () => {
  expect(calendarDate(now, zone)).toBe("2026-09-24");
  const today = spendWindow({ range: "today", customFrom: null, customTo: null }, now, zone);
  expect(today.ok && today.window.from).toBe(zonedStart("2026-09-24", zone)!.toISOString());
  expect(today.ok && today.window.to).toBe(zonedStart("2026-09-25", zone)!.toISOString());
  const week = spendWindow({ range: "last7", customFrom: null, customTo: null }, now, zone);
  expect(week.ok && week.window.from).toBe(zonedStart("2026-09-18", zone)!.toISOString());
  expect(week.ok && week.window.to).toBe(today.ok && today.window.to);
  const month = spendWindow({ range: "last30", customFrom: null, customTo: null }, now, zone);
  expect(month.ok && month.window.from).toBe(zonedStart("2026-08-26", zone)!.toISOString());
  expect(spendWindow({ range: "all", customFrom: null, customTo: null }, now, zone)).toEqual({ ok: true, window: {} });
});

test("a custom range is inclusive of both calendar days and refuses reversed ends", () => {
  const window = spendWindow({ range: "custom", customFrom: "2026-09-18", customTo: "2026-09-20" }, now, zone);
  expect(window.ok && window.window.from).toBe(zonedStart("2026-09-18", zone)!.toISOString());
  expect(window.ok && window.window.to).toBe(zonedStart("2026-09-21", zone)!.toISOString());
  expect(spendWindow({ range: "custom", customFrom: "2026-09-20", customTo: "2026-09-18" }, now, zone)).toEqual({
    ok: false,
    issue: "reversed",
  });
});

test("a blank or impossible custom range is not all time", () => {
  expect(spendWindow({ range: "custom", customFrom: "", customTo: "2026-09-18" }, now, zone)).toEqual({ ok: false, issue: "blank" });
  expect(spendWindow({ range: "custom", customFrom: null, customTo: null }, now, zone)).toEqual({ ok: false, issue: "blank" });
  expect(spendWindow({ range: "custom", customFrom: "2026-02-31", customTo: "2026-03-01" }, now, zone)).toEqual({
    ok: false,
    issue: "invalid",
  });
  expect(spendWindow({ range: "custom", customFrom: "nope", customTo: "2026-03-01" }, now, zone)).toEqual({
    ok: false,
    issue: "invalid",
  });
});

test("the next local midnight follows the zone, including a DST fold", () => {
  const ny = "America/New_York";
  expect(nextLocalMidnight(now, zone).toISOString()).toBe(zonedStart("2026-09-25", zone)!.toISOString());
  // 01:30 EDT, still the 25-hour fall-back day. The next midnight is 05:00Z, not 04:00Z.
  const fall = new Date("2026-11-01T05:30:00.000Z");
  expect(nextLocalMidnight(fall, ny).toISOString()).toBe(zonedStart("2026-11-02", ny)!.toISOString());
  // 01:30 EST, the 23-hour spring-forward day. The next midnight is 04:00Z.
  const spring = new Date("2026-03-08T06:30:00.000Z");
  expect(nextLocalMidnight(spring, ny).toISOString()).toBe(zonedStart("2026-03-09", ny)!.toISOString());
  const onTheDot = zonedStart("2026-09-25", zone)!;
  expect(nextLocalMidnight(onTheDot, zone).getTime()).toBeGreaterThan(onTheDot.getTime());
});

test("adding a day is the next calendar date, including across a DST fall-back", () => {
  const ny = "America/New_York";
  expect(addDays("2026-11-01", 1, ny)).toBe("2026-11-02");
  expect(calendarDate(zonedStart("2026-11-01", ny)!, ny)).toBe("2026-11-01");
  expect(calendarDate(zonedStart("2026-11-02", ny)!, ny)).toBe("2026-11-02");
  const fall = spendWindow({ range: "today", customFrom: null, customTo: null }, new Date("2026-11-01T16:00:00.000Z"), ny);
  expect(fall.ok && fall.window.from).toBe(zonedStart("2026-11-01", ny)!.toISOString());
  expect(fall.ok && fall.window.to).toBe(zonedStart("2026-11-02", ny)!.toISOString());
  expect(fall.ok && fall.window.from).not.toBe(fall.ok && fall.window.to);
  const spring = spendWindow({ range: "today", customFrom: null, customTo: null }, new Date("2026-03-08T17:00:00.000Z"), ny);
  expect(spring.ok && spring.window.from).toBe(zonedStart("2026-03-08", ny)!.toISOString());
  expect(spring.ok && spring.window.to).toBe(zonedStart("2026-03-09", ny)!.toISOString());
  const inclusive = spendWindow({ range: "custom", customFrom: "2026-11-01", customTo: "2026-11-01" }, now, ny);
  expect(inclusive.ok && inclusive.window.from).toBe(zonedStart("2026-11-01", ny)!.toISOString());
  expect(inclusive.ok && inclusive.window.to).toBe(zonedStart("2026-11-02", ny)!.toISOString());
  expect(addDays("2026-02-31", 1, ny)).toBeNull();
  expect(addDays("nope", 1, ny)).toBeNull();
  expect(spendWindow({ range: "custom", customFrom: "2026-02-31", customTo: "2026-03-01" }, now, ny)).toEqual({
    ok: false,
    issue: "invalid",
  });
});

test("a null model and a null bot are empty query params, and kinds repeat", () => {
  const drill: SpendDrill = { modelId: null, model: null, providerId: null, botId: null, kind: ["route_review", "route_learn"] };
  const params = spendSearchParams(spendFilterOf({ from: "2026-09-18T00:00:00.000Z" }, drill));
  const search = new URLSearchParams(params);
  expect(search.getAll("kind")).toEqual(["route_review", "route_learn"]);
  expect(search.get("model")).toBe("");
  expect(search.get("bot_id")).toBe("");
  expect(search.has("provider_id")).toBe(false);
  expect(search.has("session_id")).toBe(false);
  const joined = new URLSearchParams(spendSearchParams(spendFilterOf({}, drill), true));
  expect(joined.getAll("kind")).toEqual(["route_review,route_learn"]);
});

test("a day query groups by day in the given zone, and a dimension query names that dimension", () => {
  const drill: SpendDrill = { sessionId: "sess-1" };
  const window = { from: "2026-09-18T00:00:00.000Z", to: "2026-09-25T00:00:00.000Z" };
  expect(dayQueryOf(window, drill, zone)).toMatchObject({ group_by: "day", tz: zone, session_id: "sess-1" });
  expect(summaryQueryOf(window, drill, "bot", zone).group_by).toBe("bot");
});

test("feedback expands to the review and the learning hop, and nothing else", () => {
  expect(kindsOfCategory("feedback").sort()).toEqual(["route_learn", "route_review"]);
  expect(kindsOfCategory("other")).toEqual(["composer_suggest"]);
});

test("the view remembers its range and dimension, and ignores a stored value it does not know", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
  };
  expect(loadSpendView(storage).range).toBe("last7");
  saveSpendView(storage, {
    range: "today",
    customFrom: null,
    customTo: null,
    dimension: "session",
    metric: "money",
    sort: "reported",
    dir: "asc",
  });
  expect(loadSpendView(storage)).toMatchObject({ range: "today", dimension: "session", metric: "money" });
  memory.set([...memory.keys()][0]!, JSON.stringify({ range: "forever", dimension: "nope" }));
  expect(loadSpendView(storage)).toMatchObject({ range: "last7", dimension: "model" });
});
