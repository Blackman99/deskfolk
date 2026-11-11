/**
 * The date maths and wording of the routine calendar's grid. The Svelte one leaned on
 * `svelte5plus-calendar` (`date.js`, `i18n.js`, the view ranges of `Calendar.svelte`); NSH has no
 * such package, so what the routine calendar used of it is written here, pure and tested.
 * Weeks start on Monday (`firstDayOfWeek={1}`), the clock is 24-hour, the agenda spans 30 days.
 */
import type { RoutineProjection } from "../../m/calendar/project-routines.ts";

/** One routine's block on the grid, and a Bot with a routine (what the projection makes). */
export type CalEvent = RoutineProjection["events"][number];
export type CalSource = RoutineProjection["sources"][number] & { visible: boolean };

export type CalView = "week" | "day" | "month" | "agenda";
export const VIEWS: readonly CalView[] = ["week", "day", "month", "agenda"];

export const HOUR_HEIGHT = 96;
export const EVENT_MIN_HEIGHT = 48;
export const DAY_MAX_EVENTS = 4;
export const AGENDA_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Midnight of the next day. */
export const endOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());

/** Adds months, clamping the day of the month (Jan 31 + 1 month is Feb 28/29). */
export function addMonths(d: Date, n: number): Date {
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes());
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, last));
  return target;
}

export const startOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);
export const endOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth() + 1, 1);

/** Midnight of the first day of the week containing `d` (Monday by default). */
export function startOfWeek(d: Date, firstDayOfWeek = 1): Date {
  const day = startOfDay(d);
  return addDays(day, -((day.getDay() - firstDayOfWeek + 7) % 7));
}

/** The last instant of the week containing `d`. */
export function endOfWeek(d: Date, firstDayOfWeek = 1): Date {
  const end = addDays(startOfWeek(d, firstDayOfWeek), 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

export const isSameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function daysBetween(a: Date, b: Date): number {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / MS_PER_DAY);
}

export const minutesOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The weeks a month view shows: from the week of the 1st through the week of the last day (at most 6). */
export function monthGrid(d: Date, firstDayOfWeek = 1): Date[][] {
  const weeks: Date[][] = [];
  let cursor = startOfWeek(startOfMonth(d), firstDayOfWeek);
  const monthEnd = endOfMonth(d);
  while (cursor.getTime() < monthEnd.getTime()) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
    if (weeks.length >= 6) break;
  }
  return weeks;
}

/** The days a view shows, as `Calendar.svelte` computes them. */
export function visibleDays(view: CalView, date: Date): Date[] {
  switch (view) {
    case "month":
      return monthGrid(date).flat();
    case "week": {
      const first = startOfWeek(date);
      return Array.from({ length: 7 }, (_, i) => addDays(first, i));
    }
    case "day":
      return [startOfDay(date)];
    case "agenda": {
      const first = startOfDay(date);
      return Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(first, i));
    }
  }
}

/** The closed range a view reports (`onRangeChange`): the first midnight to the last midnight. */
export function viewRange(view: CalView, date: Date): { start: Date; end: Date } {
  const days = visibleDays(view, date);
  return { start: days[0]!, end: endOfDay(days[days.length - 1]!) };
}

/** What the previous and next buttons move by. */
export function navigate(view: CalView, date: Date, direction: 1 | -1): Date {
  switch (view) {
    case "month":
      return addMonths(date, direction);
    case "week":
      return addDays(date, direction * 7);
    case "day":
      return addDays(date, direction);
    case "agenda":
      return addDays(date, direction * AGENDA_DAYS);
  }
}

export type CalLocale = "en" | "zh-CN";

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: CalLocale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, f);
  }
  return f;
}

/** The title over the grid, as the package wrote it. */
export function viewTitle(view: CalView, date: Date, locale: CalLocale): string {
  const full: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
  if (view === "month") return fmt(locale, { year: "numeric", month: "long" }).format(date);
  if (view === "day") return fmt(locale, { year: "numeric", month: "long", day: "numeric" }).format(date);
  const { start, end } = viewRange(view, date);
  return `${fmt(locale, full).format(start)} – ${fmt(locale, full).format(addDays(end, -1))}`;
}

export const weekdayShort = (d: Date, locale: CalLocale): string => fmt(locale, { weekday: "short" }).format(d);
export const agendaDayLabel = (d: Date, locale: CalLocale): string => fmt(locale, { month: "short", day: "numeric", weekday: "short" }).format(d);
/** 24-hour "09:30". */
export const clock = (d: Date): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** The package's words (`i18n.js`): the toolbar's, not the messenger's copy. */
export const TOOLBAR = {
  en: { today: "Today", day: "Day", week: "Week", month: "Month", agenda: "Agenda", previous: "Previous", next: "Next", more: (n: number) => `+${n} more` },
  "zh-CN": { today: "今天", day: "日", week: "周", month: "月", agenda: "议程", previous: "上一页", next: "下一页", more: (n: number) => `还有 ${n} 项` },
} as const;

/** The agenda's days, each with the shown events from its midnight, in time order. */
export function agendaGroups(events: readonly CalEvent[]): { key: string; day: Date; items: CalEvent[] }[] {
  const groups = new Map<string, { key: string; day: Date; items: CalEvent[] }>();
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title));
  for (const event of sorted) {
    const day = startOfDay(event.start);
    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    const group = groups.get(key);
    if (group) group.items.push(event);
    else groups.set(key, { key, day, items: [event] });
  }
  return [...groups.values()];
}

export type Placement = { event: CalEvent; startMin: number; endMin: number; col: number; cols: number };

/**
 * Packs one day's timed events into columns (`layout.js`'s `layoutDay`): the leftmost column free
 * at the start; events that overlap form a cluster that shares its widest column count.
 * `minDuration` is the block's least height in minutes, which packing treats as its end.
 */
export function layoutDay(events: readonly CalEvent[], day: Date, minDuration = 0): Placement[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + MS_PER_DAY;
  const items = events
    .map((event) => {
      const s = Math.max(event.start.getTime(), dayStart);
      const e = Math.min(event.end.getTime(), dayEnd);
      const startMin = Math.floor((s - dayStart) / 60_000);
      const endMin = Math.max(startMin + 1, Math.ceil((e - dayStart) / 60_000));
      return { event, startMin, endMin, packEnd: Math.max(endMin, startMin + minDuration), col: 0, cols: 1 };
    })
    .sort((a, b) => a.startMin - b.startMin || b.packEnd - a.packEnd || b.endMin - a.endMin);
  const colEnds: number[] = [];
  let clusterStart = 0;
  let clusterMaxEnd = -1;
  let clusterCols = 0;
  const closeCluster = (to: number) => {
    for (let i = clusterStart; i < to; i++) items[i]!.cols = clusterCols;
  };
  items.forEach((item, idx) => {
    if (item.startMin >= clusterMaxEnd && idx > 0) {
      closeCluster(idx);
      clusterStart = idx;
      clusterCols = 0;
      colEnds.length = 0;
    }
    const free = colEnds.findIndex((end) => item.startMin >= end);
    if (free >= 0) {
      item.col = free;
      colEnds[free] = item.packEnd;
    } else {
      item.col = colEnds.length;
      colEnds.push(item.packEnd);
    }
    clusterCols = Math.max(clusterCols, colEnds.length);
    clusterMaxEnd = Math.max(clusterMaxEnd, item.packEnd);
  });
  closeCluster(items.length);
  return items.map(({ packEnd: _packEnd, ...placement }) => placement);
}

/** A month cell's events in the order the cell lists them (time, then title). */
export function dayEvents(events: readonly CalEvent[], day: Date): CalEvent[] {
  return events
    .filter((event) => isSameDay(event.start, day))
    .sort((a, b) => minutesOfDay(a.start) - minutesOfDay(b.start) || a.title.localeCompare(b.title));
}
