import { expect, test } from "bun:test";
import { aBot, aRoutine } from "../test-fixtures.ts";
import { projectRoutines } from "./project-routines.ts";

/** A week the way the calendar reports it: Monday 00:00 through Sunday end-of-day. */
const weekStart = new Date(2026, 8, 21, 0, 0, 0, 0);
const weekEnd = new Date(2026, 8, 27, 23, 59, 59, 999);

function project(over: Partial<Parameters<typeof projectRoutines>[0]> = {}) {
  return projectRoutines({
    bots: [aBot()],
    routines: [aRoutine()],
    rangeStart: weekStart,
    rangeEnd: weekEnd,
    hostLocal: true,
    archivedLabel: "已归档",
    ...over,
  });
}

test("a daily routine is one block on every day of a closed week, at its civil clock", () => {
  const { events } = project();
  expect(events).toHaveLength(7);
  expect(events.map((event) => event.start.getDay())).toEqual([1, 2, 3, 4, 5, 6, 0]);
  expect(events[0]?.start.getHours()).toBe(9);
  expect(events[0]?.start.getMinutes()).toBe(0);
  expect(events[0]?.end.getHours()).toBe(9);
  expect(events[0]?.end.getMinutes()).toBe(30);
  expect(events.every((event) => event.allDay === false)).toBe(true);
});

test("the last day of a closed range is included", () => {
  const { events } = project({
    routines: [aRoutine({ schedule: { kind: "weekly", time: "17:30", weekdays: ["sun"] } })],
  });
  expect(events).toHaveLength(1);
  expect(events[0]?.start.getDate()).toBe(27);
  expect(events[0]?.start.getHours()).toBe(17);
  expect(events[0]?.start.getMinutes()).toBe(30);
});

test("23:45 stops at midnight instead of drawing into the next day", () => {
  const { events } = project({ routines: [aRoutine({ schedule: { kind: "daily", time: "23:45" } })] });
  const block = events[0]!;
  // End is exclusive midnight, so the block occupies 21 September and nothing of the 22nd.
  expect(block.start.getDate()).toBe(21);
  expect(block.end.getTime()).toBe(new Date(2026, 8, 22).getTime());
  expect(block.end.getTime() - block.start.getTime()).toBe(15 * 60_000);
});

test("a weekly routine lands only on its weekdays", () => {
  const { events } = project({
    routines: [aRoutine({ schedule: { kind: "weekly", time: "09:00", weekdays: ["mon", "fri"] } })],
  });
  expect(events.map((event) => event.start.getDay())).toEqual([1, 5]);
});

test("blocks before the routine existed are dropped only on the execution Mac", () => {
  const created = new Date(2026, 8, 24, 12, 0, 0, 0).toISOString();
  const routine = aRoutine({ created_at: created });
  const local = project({ routines: [routine] });
  expect(local.events[0]?.start.getDate()).toBe(25);
  expect(local.events[0]?.start.getHours()).toBe(9);
  // 09:00 on the 24th is before noon, so that day starts the next morning.
  expect(local.events.map((event) => event.start.getDate())).toEqual([25, 26, 27]);

  const remote = project({ routines: [routine], hostLocal: false });
  expect(remote.events).toHaveLength(7);
});

test("the latest due mark matches a Mac instant only on the execution Mac", () => {
  const due = new Date(2026, 8, 21, 9, 0, 0, 0).toISOString();
  const routine = aRoutine({ last_fired_for_due_at: due });
  const local = project({ routines: [routine] });
  expect(local.events[0]?.meta?.lastFired).toBe(true);
  expect(local.events[1]?.meta?.lastFired).toBe(false);

  const remote = project({ routines: [routine], hostLocal: false });
  expect(remote.events.every((event) => event.meta?.lastFired === false)).toBe(true);
});

test("a paused routine stays on the grid and an archived Bot is named but not editable", () => {
  const { sources, events } = project({
    bots: [aBot({ archived_at: "2026-09-20T00:00:00.000Z" })],
    routines: [aRoutine({ enabled: false })],
  });
  expect(sources[0]?.name).toBe("Researcher · 已归档");
  expect(sources[0]?.editable).toBe(false);
  expect(events[0]?.meta).toMatchObject({ paused: true, archived: true, enabled: false });
  expect(events[0]?.editable).toBe(false);
});

test("a routine whose Bot is gone does not become a block", () => {
  const { sources, events } = project({
    bots: [aBot()],
    routines: [aRoutine({ bot_id: "deleted-bot" })],
  });
  expect(sources).toHaveLength(1);
  expect(events).toEqual([]);
});

test("occurrence ids stay stable for one routine and one civil day", () => {
  const first = project();
  const again = project();
  expect(first.events.map((event) => event.id)).toEqual(again.events.map((event) => event.id));
  expect(new Set(first.events.map((event) => event.id)).size).toBe(7);
});
