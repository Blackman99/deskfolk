import type { SpendCategory, SpendCategorySummary, SpendGroup, SpendTotals } from "@real-bot/protocol";

/** A year of days stays readable as at most this many bars. */
export const SPEND_TREND_MAX_BARS = 28;

/** Calendar days JS `Date` can name. Farther input is clamped so a bad year cannot loop forever. */
const MIN_DAY = "0001-01-01";
const MAX_DAY = "9999-12-31";

export type SpendTrendRange = { from?: string; to?: string };

export const SPEND_TREND_CATEGORIES: readonly SpendCategory[] = [
  "turn",
  "judgement",
  "decision",
  "feedback",
  "other",
];

const NULL_FIELDS = [
  "input_tokens",
  "cached_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_tokens",
  "reported_usd_ticks",
  "estimated_usd_ticks",
] as const satisfies readonly (keyof SpendTotals)[];

const COUNT_FIELDS = [
  "calls",
  "reported_calls",
  "estimated_calls",
  "missing_calls",
  "missing_usage_calls",
] as const satisfies readonly (keyof SpendTotals)[];

export type SpendTrendField = "total_tokens" | "reported_usd_ticks" | "estimated_usd_ticks";

/** One bar. A single day keeps its id; a wider range joins the first and last day. */
export type SpendTrendBucket = SpendGroup & {
  /** Inclusive first calendar day, `YYYY-MM-DD`, when the days parse. */
  from: string | null;
  /** Inclusive last calendar day. Equal to `from` when the bar is one day. */
  to: string | null;
  /** Calendar days this bar covers. The last bar may be shorter than the others. */
  dayCount: number;
};

function emptyTotals(): SpendTotals {
  return {
    calls: 0,
    input_tokens: null,
    cached_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    reported_usd_ticks: null,
    estimated_usd_ticks: null,
    reported_calls: 0,
    estimated_calls: 0,
    missing_calls: 0,
    missing_usage_calls: 0,
  };
}

/** A day the ledger did not return. Counts are zero; amounts are zero, not unknown. */
function inactiveTotals(): SpendTotals {
  return {
    calls: 0,
    input_tokens: 0,
    cached_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    reported_usd_ticks: 0,
    estimated_usd_ticks: 0,
    reported_calls: 0,
    estimated_calls: 0,
    missing_calls: 0,
    missing_usage_calls: 0,
  };
}

/** Null stays null until a real number arrives. Zero is a number and is kept. */
export function sumSpendNullable(values: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (value == null) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

function combineTotals(rows: readonly SpendTotals[]): SpendTotals {
  if (rows.length === 0) return emptyTotals();
  const totals = emptyTotals();
  const withCalls = rows.filter((row) => row.calls > 0);
  const measured = withCalls.length ? withCalls : rows;
  for (const field of COUNT_FIELDS) {
    totals[field] = rows.reduce((total, row) => total + row[field], 0);
  }
  for (const field of NULL_FIELDS) {
    totals[field] = sumSpendNullable(measured.map((row) => row[field]));
  }
  return totals;
}

function combineCategories(days: readonly SpendGroup[]): SpendCategorySummary[] {
  return SPEND_TREND_CATEGORIES.map((category) => {
    const rows = days.flatMap((day) => day.categories.filter((row) => row.category === category));
    if (rows.length === 0 && days.every((day) => day.calls === 0)) rows.push({ ...inactiveTotals(), category, kinds: [] });
    const kinds = new Map<SpendCategorySummary["kinds"][number]["kind"], SpendTotals[]>();
    for (const row of rows) {
      for (const kind of row.kinds) {
        const current = kinds.get(kind.kind) ?? [];
        current.push(kind);
        kinds.set(kind.kind, current);
      }
    }
    return {
      category,
      kinds: [...kinds.entries()].map(([kind, group]) => ({ kind, ...combineTotals(group) })),
      ...combineTotals(rows),
    };
  });
}

const DAY_ID = /^(\d{4})-(\d{2})-(\d{2})$/;

type CalendarDay = { year: number; month: number; day: number; id: string };

function parseDay(value: string | null | undefined): CalendarDay | null {
  if (!value) return null;
  const match = DAY_ID.exec(value.slice(0, 10));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day, id: `${match[1]}-${match[2]}-${match[3]}` };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayIndex(day: CalendarDay): number {
  return Math.floor(Date.UTC(day.year, day.month - 1, day.day) / 86_400_000);
}

function dayFromIndex(index: number): CalendarDay {
  const date = new Date(index * 86_400_000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const id = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, id };
}

function clampDay(day: CalendarDay): CalendarDay {
  if (day.id < MIN_DAY) return parseDay(MIN_DAY)!;
  if (day.id > MAX_DAY) return parseDay(MAX_DAY)!;
  return day;
}

/**
 * Inclusive calendar days inside a half-open window. `from` names the first day; `to` is the
 * first instant that is already outside, so its calendar day is not drawn.
 */
function calendarSpan(from: string | undefined, to: string | undefined, timeZone: string): { start: CalendarDay | null; end: CalendarDay | null } | null {
  const start = from ? parseDay(calendarDayOf(from, timeZone)) : null;
  // `to` is the first instant outside the window, so the last drawn day is the one before it.
  const end = to ? parseDay(calendarDayOf(to, timeZone, -1)) : null;
  if (from && !start) return null;
  if (to && !end) return null;
  if (!start && !end) return null;
  return { start, end };
}

/** Calendar date of an instant, with an optional millisecond adjustment for exclusive ends. */
function calendarDayOf(iso: string, timeZone: string, delta = 0): string | null {
  const instant = Date.parse(iso) + delta;
  if (!Number.isFinite(instant)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant));
    const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    const id = `${pick("year")}-${pick("month")}-${pick("day")}`;
    return DAY_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** One quiet calendar day. Several missing days still add as one zero, not one row each. */
function inactiveDay(id: string): SpendGroup {
  return {
    id,
    name: id,
    deleted: false,
    provider_id: null,
    provider_name: null,
    model: null,
    categories: [],
    ...inactiveTotals(),
  };
}

function bucketOf(slice: readonly SpendGroup[], from: string | null, to: string | null, dayCount: number): SpendTrendBucket {
  const single = slice.length === 1 && dayCount === 1 ? slice[0] : undefined;
  const label = from && to && from !== to ? `${from}/${to}` : from;
  return {
    ...(single ?? {
      id: label,
      name: label,
      deleted: false,
      provider_id: null,
      provider_name: null,
      model: null,
    }),
    ...combineTotals(slice),
    categories: combineCategories(slice),
    from,
    to,
    dayCount,
  };
}

/**
 * At most `maxBars` calendar intervals of equal length. The last interval may be shorter.
 * Days the ledger did not return are zero, not unknown. A call that returned null usage stays
 * null. `range.from` is inclusive and `range.to` is exclusive; both are UTC instants named as
 * calendar days in `timeZone`. Without a range the span is the first through the last dated row.
 */
export function bucketSpendDays(
  days: readonly SpendGroup[],
  maxBars = SPEND_TREND_MAX_BARS,
  range?: SpendTrendRange,
  timeZone = "UTC",
): SpendTrendBucket[] {
  const bars = Math.max(1, Math.min(SPEND_TREND_MAX_BARS, Math.floor(Number.isFinite(maxBars) ? maxBars : SPEND_TREND_MAX_BARS)));
  const dated = new Map<string, SpendGroup[]>();
  const loose: SpendGroup[] = [];
  for (const row of days) {
    const parsed = parseDay(row.id);
    if (!parsed) {
      loose.push(row);
      continue;
    }
    const current = dated.get(parsed.id) ?? [];
    current.push(row);
    dated.set(parsed.id, current);
  }

  const span = calendarSpan(range?.from, range?.to, timeZone);
  let start: CalendarDay | null = span?.start ?? null;
  let end: CalendarDay | null = span?.end ?? null;
  if (!range?.from || !range?.to) {
    for (const id of dated.keys()) {
      const day = parseDay(id);
      if (!day) continue;
      if (!range?.from && (!start || day.id < start.id)) start = day;
      if (!range?.to && (!end || day.id > end.id)) end = day;
    }
  }
  if (start && end && start.id > end.id) {
    const swap = start;
    start = end;
    end = swap;
  }
  if (start) start = clampDay(start);
  if (end) end = clampDay(end);

  const buckets: SpendTrendBucket[] = [];
  if (start && end) {
    const firstIndex = dayIndex(start);
    const spanDays = dayIndex(end) - firstIndex + 1;
    if (spanDays > 0) {
      const size = Math.max(1, Math.ceil(spanDays / bars));
      const slots = new Map<number, SpendGroup[]>();
      const placed: string[] = [];
      for (const [id, rows] of dated) {
        const index = dayIndex(parseDay(id)!);
        const slot = Math.floor((index - firstIndex) / size);
        if (slot < 0 || slot >= bars) continue;
        const current = slots.get(slot) ?? [];
        current.push(...rows);
        slots.set(slot, current);
        placed.push(id);
      }
      for (const id of placed) dated.delete(id);
      let cursor = firstIndex;
      const last = dayIndex(end);
      const count = Math.min(bars, Math.ceil(spanDays / size));
      for (let slot = 0; slot < count; slot += 1) {
        const length = Math.min(size, last - cursor + 1);
        const rows = slots.get(slot) ?? [];
        const from = dayFromIndex(cursor).id;
        const to = dayFromIndex(cursor + length - 1).id;
        // Missing calendar days are zero. One stand-in covers the whole gap.
        const slice = rows.length ? rows : [inactiveDay(from)];
        buckets.push(bucketOf(slice, from, to, length));
        cursor += length;
      }
    }
  }

  const leftover = [...dated.keys()].sort();
  for (const id of leftover) {
    const rows = dated.get(id) ?? [];
    buckets.push(bucketOf(rows, id, id, 1));
  }
  if (loose.length > 0) buckets.push(bucketOf(loose, null, null, loose.length));
  return buckets;
}

/** Largest finite value of a field. Missing stays out, so an all-null series scales to 0. */
export function spendTrendMax(buckets: readonly SpendTrendBucket[], field: SpendTrendField): number {
  let max = 0;
  for (const bucket of buckets) {
    const value = bucket[field];
    if (value != null && value > max) max = value;
  }
  return max;
}

export function spendTrendCategoryValue(
  bucket: SpendTrendBucket,
  category: SpendCategory,
  field: SpendTrendField,
): number | null {
  const row = bucket.categories.find((item) => item.category === category);
  return row ? row[field] : null;
}
