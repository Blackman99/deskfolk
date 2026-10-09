import { expect, test } from "bun:test";
import { formatSpan } from "./duration.ts";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;
const MONTH = YEAR / 12;

test("a span reads in its two largest units, from minutes up to years", () => {
  expect(formatSpan(65)).toBe("1m 5s");
  expect(formatSpan(59 * MINUTE + 59)).toBe("59m 59s");
  expect(formatSpan(85 * MINUTE + 50)).toBe("1h 25m");
  expect(formatSpan(HOUR)).toBe("1h 0m");
  expect(formatSpan(23 * HOUR + 59 * MINUTE)).toBe("23h 59m");
  expect(formatSpan(DAY + 4 * HOUR + 30 * MINUTE)).toBe("1d 4h");
  expect(formatSpan(6 * DAY + 23 * HOUR)).toBe("6d 23h");
  expect(formatSpan(2 * WEEK + DAY)).toBe("2w 1d");
  expect(formatSpan(30 * DAY)).toBe("4w 2d");
  expect(formatSpan(MONTH + 2 * WEEK)).toBe("1mo 2w");
  expect(formatSpan(1.25 * YEAR)).toBe("1y 3mo");
});

test("twelve months are a year, never 12mo", () => {
  expect(formatSpan(YEAR - 1)).toBe("11mo 4w");
  expect(formatSpan(YEAR)).toBe("1y 0mo");
});

test("a unit is never reached by rounding up, and under a minute it is seconds", () => {
  expect(formatSpan(HOUR - 1)).toBe("59m 59s");
  expect(formatSpan(DAY - 1)).toBe("23h 59m");
  expect(formatSpan(59.9)).toBe("59s");
  expect(formatSpan(0)).toBe("0s");
  expect(formatSpan(-5)).toBe("0s");
  expect(formatSpan(2 * HOUR + 5 * MINUTE, "")).toBe("2h5m");
});
