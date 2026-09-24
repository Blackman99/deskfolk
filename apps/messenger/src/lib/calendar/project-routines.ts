/**
 * Project roster routines onto calendar blocks.
 *
 * A block is one occurrence of a daily or weekly rule inside the range the calendar
 * is showing. It is not a run, and it is not a row of its own: the snapshot stays
 * the only source. Times are civil labels (the execution Mac's local HH:MM written
 * into a local Date), never converted from the browser's zone.
 *
 * A source is a Bot that owns at least one routine. A Bot with none stays off
 * the chart. A routine that does not fall inside the visible range still keeps
 * its Bot; the blocks are what the range decides, not the roster.
 */
import type { Bot, Routine } from "@real-bot/protocol";
import type { CalendarEvent, CalendarSource } from "./calendar-entry.ts";
import { botAvatarColor } from "../avatar.ts";
import { WEEKDAYS } from "../panels/routine-form.ts";

/** JS getDay(): Sunday is 0. Matches the weekday keys the routine form already uses. */
const WEEKDAY_INDEX: Record<(typeof WEEKDAYS)[number], number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const VISUAL_MINUTES = 30;

export type RoutineProjection = {
  sources: CalendarSource[];
  events: CalendarEvent[];
};

/** The closed range `onRangeChange` hands back: the last instant is end-of-day, not the next midnight. */
export function projectRoutines(input: {
  bots: readonly Bot[];
  routines: readonly Routine[];
  rangeStart: Date;
  rangeEnd: Date;
  /** True only in the window on the execution Mac. Remote browsers must not compare Mac instants. */
  hostLocal: boolean;
  archivedLabel: string;
}): RoutineProjection {
  const bots = [...input.bots];
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const scheduled = new Set<string>();
  for (const routine of input.routines) {
    if (byId.has(routine.bot_id)) scheduled.add(routine.bot_id);
  }
  const sources: CalendarSource[] = bots.filter((bot) => scheduled.has(bot.id)).map((bot) => ({
    id: bot.id,
    name: bot.archived_at ? `${bot.name} · ${input.archivedLabel}` : bot.name,
    color: botAvatarColor(bot.id).text,
    visible: true,
    editable: false,
  }));

  const days = daysInRange(input.rangeStart, input.rangeEnd);
  const events: CalendarEvent[] = [];
  for (const routine of input.routines) {
    const bot = byId.get(routine.bot_id);
    if (!bot) continue;
    const clock = parseClock(routine.schedule.time);
    if (!clock) continue;
    const weekdays = routine.schedule.kind === "weekly"
      ? new Set(routine.schedule.weekdays.map((day) => WEEKDAY_INDEX[day as (typeof WEEKDAYS)[number]]).filter((day) => day !== undefined))
      : null;
    const createdAt = input.hostLocal ? Date.parse(routine.created_at) : Number.NaN;
    for (const day of days) {
      if (weekdays && !weekdays.has(day.getDay())) continue;
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), clock.hour, clock.minute, 0, 0);
      if (input.hostLocal && Number.isFinite(createdAt) && start.getTime() < createdAt) continue;
      events.push(block(routine, bot, start, input.hostLocal));
    }
  }
  return { sources, events };
}

function block(routine: Routine, bot: Bot, start: Date, hostLocal: boolean): CalendarEvent {
  return {
    id: `${routine.id}::${stamp(start)}`,
    title: routine.title,
    start,
    end: visualEnd(start),
    allDay: false,
    calendarId: bot.id,
    color: botAvatarColor(bot.id).text,
    editable: false,
    meta: {
      routineId: routine.id,
      botId: bot.id,
      revision: routine.updated_at,
      kind: routine.schedule.kind,
      enabled: routine.enabled,
      archived: Boolean(bot.archived_at),
      paused: !routine.enabled,
      lastFired: hostLocal && routine.last_fired_for_due_at === start.toISOString(),
    },
  };
}

/** Walk civil days from the start of `rangeStart` through the day `rangeEnd` falls on. */
function daysInRange(rangeStart: Date, rangeEnd: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
  const last = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate());
  while (cursor.getTime() <= last.getTime()) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function parseClock(time: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Thirty minutes of grid, cut at midnight so 23:45 does not spill into the next day. */
function visualEnd(start: Date): Date {
  const end = new Date(start.getTime() + VISUAL_MINUTES * 60_000);
  const midnight = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return end.getTime() > midnight.getTime() ? midnight : end;
}

function stamp(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
