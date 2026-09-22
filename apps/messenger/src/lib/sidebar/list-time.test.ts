import { expect, test } from "bun:test";
import { formatListTime, listTimeSource } from "./list-time.ts";

// A fixed Wednesday afternoon to measure everything against.
const now = new Date(2026, 8, 23, 14, 30).getTime();
const at = (y: number, m: number, d: number, h = 9, min = 5) => new Date(y, m, d, h, min).toISOString();

test("today is a clock, yesterday is a word, this week is a weekday", () => {
  expect(formatListTime(at(2026, 8, 23, 9, 5), now, "zh")).toBe("09:05");
  expect(formatListTime(at(2026, 8, 23, 0, 0), now, "en")).toBe("00:00");
  expect(formatListTime(at(2026, 8, 22, 23, 59), now, "zh")).toBe("昨天");
  expect(formatListTime(at(2026, 8, 22, 23, 59), now, "en")).toBe("Yesterday");
  // Three days back is still inside the week, so the weekday is the fastest read.
  expect(formatListTime(at(2026, 8, 20), now, "en")).toBe("Sun");
  expect(formatListTime(at(2026, 8, 20), now, "zh")).toBe("周日");
});

test("older than a week is a date, and another year carries its year", () => {
  expect(formatListTime(at(2026, 8, 10), now, "en")).toBe("9/10");
  expect(formatListTime(at(2025, 11, 31), now, "en")).toBe("12/31/2025");
  expect(formatListTime(at(2025, 11, 31), now, "zh")).toBe("2025/12/31");
});

test("a row with nothing to date says nothing", () => {
  expect(formatListTime(null, now, "zh")).toBe("");
  expect(formatListTime("not a date", now, "zh")).toBe("");
});

test("the row is dated by its last message, or by the session when there is none", () => {
  const updated = at(2026, 8, 1);
  const spoken = at(2026, 8, 23);
  expect(listTimeSource({ updated_at: updated })).toBe(updated);
  expect(listTimeSource({ updated_at: updated, last_message: null })).toBe(updated);
  expect(listTimeSource({ updated_at: updated, last_message: { created_at: spoken } })).toBe(spoken);
});
