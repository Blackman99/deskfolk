import { describe, expect, test } from "bun:test";
import { latestDueAt, parseClockTime } from "./schedule";

describe("parseClockTime", () => {
  test("accepts HH:MM in 24h", () => {
    expect(parseClockTime("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(parseClockTime("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseClockTime("23:59")).toEqual({ hour: 23, minute: 59 });
  });

  test("rejects out of range and bad shape", () => {
    expect(parseClockTime("24:00")).toBeNull();
    expect(parseClockTime("09:60")).toBeNull();
    expect(parseClockTime("9:00")).toBeNull();
    expect(parseClockTime("09:0")).toBeNull();
  });
});

describe("latestDueAt", () => {
  test("daily: today at time when now is after", () => {
    const created = new Date(2026, 8, 10, 8, 0, 0);
    const now = new Date(2026, 8, 14, 10, 0, 0);
    const due = latestDueAt({ kind: "daily", time: "09:00" }, now, created);
    expect(due?.getTime()).toBe(new Date(2026, 8, 14, 9, 0, 0).getTime());
  });

  test("daily: yesterday when now is before today's time", () => {
    const created = new Date(2026, 8, 10, 8, 0, 0);
    const now = new Date(2026, 8, 14, 8, 59, 0);
    const due = latestDueAt({ kind: "daily", time: "09:00" }, now, created);
    expect(due?.getTime()).toBe(new Date(2026, 8, 13, 9, 0, 0).getTime());
  });

  test("daily: null when the latest civil due is before the row existed", () => {
    const created = new Date(2026, 8, 14, 10, 0, 0);
    const now = new Date(2026, 8, 14, 10, 0, 0);
    expect(latestDueAt({ kind: "daily", time: "09:00" }, now, created)).toBeNull();
  });

  test("daily: fires the create-minute when created exactly at due", () => {
    const created = new Date(2026, 8, 14, 9, 0, 0);
    const now = new Date(2026, 8, 14, 9, 0, 0);
    const due = latestDueAt({ kind: "daily", time: "09:00" }, now, created);
    expect(due?.getTime()).toBe(created.getTime());
  });

  test("weekly: only matching weekdays, catch-up is the latest one", () => {
    const created = new Date(2026, 8, 7, 8, 0, 0);
    // 2026-09-16 is Wednesday.
    const now = new Date(2026, 8, 16, 10, 0, 0);
    const due = latestDueAt(
      { kind: "weekly", time: "09:00", weekdays: ["mon", "wed", "fri"] },
      now,
      created,
    );
    expect(due?.getTime()).toBe(new Date(2026, 8, 16, 9, 0, 0).getTime());
  });

  test("weekly: walks back when today is not a weekday in the set", () => {
    const created = new Date(2026, 8, 7, 8, 0, 0);
    // Thursday 2026-09-17.
    const now = new Date(2026, 8, 17, 10, 0, 0);
    const due = latestDueAt(
      { kind: "weekly", time: "09:00", weekdays: ["mon", "wed", "fri"] },
      now,
      created,
    );
    expect(due?.getTime()).toBe(new Date(2026, 8, 16, 9, 0, 0).getTime());
  });
});
