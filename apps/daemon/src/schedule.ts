import type { RoutineSchedule } from "@real-bot/protocol";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const JS_TO_WEEKDAY: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function parseClockTime(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}

/** Most recent occurrence at or before `now` that is not earlier than `createdAt`. */
export function latestDueAt(schedule: RoutineSchedule, now: Date, createdAt: Date): Date | null {
  const hm = parseClockTime(schedule.time);
  if (!hm) return null;
  const allowed = allowedWeekdays(schedule);
  if (allowed.size === 0) return null;

  for (let back = 0; back <= 8; back++) {
    const day = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - back,
      hm.hour,
      hm.minute,
      0,
      0,
    );
    if (!allowed.has(JS_TO_WEEKDAY[day.getDay()]!)) continue;
    if (day.getTime() > now.getTime()) continue;
    if (day.getTime() < createdAt.getTime()) return null;
    return day;
  }
  return null;
}

function allowedWeekdays(schedule: RoutineSchedule): Set<Weekday> {
  if (schedule.kind === "daily") return new Set(WEEKDAYS);
  const next = new Set<Weekday>();
  for (const day of schedule.weekdays) {
    if (isWeekday(day)) next.add(day);
  }
  return next;
}

export function dueIso(due: Date): string {
  return due.toISOString();
}
