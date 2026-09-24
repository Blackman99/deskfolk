/** What the spend view asks the daemon for. Range and dimension persist; drill filters do not. */
import type { SpendCategory, SpendFilter, SpendKind, SpendSummaryQuery } from "@real-bot/protocol";
import { SPEND_CATEGORY_OF } from "@real-bot/protocol";

export const SPEND_STORAGE_KEY = "deskfolk.spend.view";
export const SPEND_PAGE_SIZE = 50;
/** Quiet long enough that a burst of `spend.created` becomes one reload. */
export const SPEND_RELOAD_DEBOUNCE_MS = 400;

export type SpendRangePreset = "today" | "last7" | "last30" | "all" | "custom";
export type SpendDimension = "model" | "session" | "bot";
export type SpendMetric = "tokens" | "money";
export type SpendSortColumn =
  | "name"
  | "calls"
  | "input"
  | "output"
  | "total"
  | "reported"
  | "estimated";

export type SpendDrill = {
  /** A model group's opaque id. Null is the unrecorded-model group. */
  modelId?: string | null;
  model?: string | null;
  providerId?: string | null;
  /** Chip text captured when the row was drilled. */
  modelLabel?: string;
  sessionId?: string;
  sessionLabel?: string;
  /** Null is the unassigned-bot group, which is not the same as "any bot". */
  botId?: string | null;
  botLabel?: string;
  kind?: SpendKind[];
};

export type SpendViewState = {
  range: SpendRangePreset;
  /** `YYYY-MM-DD` in the view's zone. Only read when `range` is `custom`. */
  customFrom: string | null;
  customTo: string | null;
  dimension: SpendDimension;
  metric: SpendMetric;
  sort: SpendSortColumn;
  dir: "asc" | "desc";
};

export const DEFAULT_SPEND_VIEW: SpendViewState = {
  range: "last7",
  customFrom: null,
  customTo: null,
  dimension: "model",
  metric: "tokens",
  sort: "total",
  dir: "desc",
};

const RANGES = new Set<SpendRangePreset>(["today", "last7", "last30", "all", "custom"]);
const DIMENSIONS = new Set<SpendDimension>(["model", "session", "bot"]);
const METRICS = new Set<SpendMetric>(["tokens", "money"]);
const SORTS = new Set<SpendSortColumn>(["name", "calls", "input", "output", "total", "reported", "estimated"]);

/** Calendar date in `timeZone`, as `YYYY-MM-DD`. */
export function calendarDate(time: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(time);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function zoneOffsetMs(time: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(time);
  const pick = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour") % 24, pick("minute"), pick("second"));
  return asUtc - time.getTime();
}

/** The UTC instant at which `YYYY-MM-DD` begins in `timeZone`. */
export function zonedStart(date: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utcGuess = new Date(Date.UTC(year, month - 1, day));
  // Two passes: the offset at the guess and the offset at the corrected instant can differ
  // across a DST fold, and the second one is the wall clock that was asked for.
  const first = new Date(utcGuess.getTime() - zoneOffsetMs(utcGuess, timeZone));
  const start = new Date(utcGuess.getTime() - zoneOffsetMs(first, timeZone));
  if (calendarDate(start, timeZone) !== date) return null;
  return start;
}

/** Move a `YYYY-MM-DD` by whole calendar days. A 24h shift repeats the fall-back day. */
export function addDays(date: string, days: number, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || !Number.isInteger(days)) return null;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  const next = shifted.toISOString().slice(0, 10);
  if (!zonedStart(date, timeZone) || !zonedStart(next, timeZone)) return null;
  return next;
}

export type SpendWindow = { from?: string; to?: string };

/** Why a custom range cannot be asked for. Presets never land here. */
export type SpendRangeIssue = "blank" | "invalid" | "reversed";

export type SpendWindowResult =
  | { ok: true; window: SpendWindow }
  | { ok: false; issue: SpendRangeIssue };

/** A real calendar day in the zone, not merely `YYYY-MM-DD` text. */
export function isCalendarDay(date: string, timeZone: string): boolean {
  return zonedStart(date, timeZone) != null;
}

/**
 * The half-open window a preset asks for. `to` is exclusive. "All" names neither bound.
 * Custom dates are inclusive calendar days in the zone. A blank, impossible, or reversed
 * custom range is not "all time": the caller must not query until both days are valid
 * and in order.
 */
export function spendWindow(
  state: Pick<SpendViewState, "range" | "customFrom" | "customTo">,
  now: Date,
  timeZone: string,
): SpendWindowResult {
  if (state.range === "all") return { ok: true, window: {} };
  const today = calendarDate(now, timeZone);
  if (state.range === "today") {
    return { ok: true, window: boundedWindow(today, today, timeZone) };
  }
  if (state.range === "last7" || state.range === "last30") {
    const days = state.range === "last7" ? 7 : 30;
    const start = addDays(today, 1 - days, timeZone);
    return { ok: true, window: start ? boundedWindow(start, today, timeZone) : {} };
  }
  const fromDay = state.customFrom?.trim() ?? "";
  const toDay = state.customTo?.trim() ?? "";
  if (!fromDay || !toDay) return { ok: false, issue: "blank" };
  if (!isCalendarDay(fromDay, timeZone) || !isCalendarDay(toDay, timeZone)) return { ok: false, issue: "invalid" };
  if (fromDay > toDay) return { ok: false, issue: "reversed" };
  return { ok: true, window: boundedWindow(fromDay, toDay, timeZone) };
}

/** UTC instant of the next local midnight after `now`, so "today" can roll over. */
export function nextLocalMidnight(now: Date, timeZone: string): Date {
  const today = calendarDate(now, timeZone);
  const tomorrow = addDays(today, 1, timeZone) ?? today;
  const start = zonedStart(tomorrow, timeZone);
  if (start && start.getTime() > now.getTime()) return start;
  // A zone the calendar cannot name, or a clock sitting on the boundary itself.
  return new Date(now.getTime() + 60_000);
}

/** Inclusive calendar days, half-open instants. An invalid day yields no bound rather than a wrong one. */
function boundedWindow(startDay: string, endDay: string, timeZone: string): SpendWindow {
  const next = addDays(endDay, 1, timeZone);
  const from = zonedStart(startDay, timeZone);
  const to = next ? zonedStart(next, timeZone) : null;
  if (!from || !to) return {};
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Kinds a category chip stands for. A single kind already picked stays that kind. */
export function kindsOfCategory(category: SpendCategory): SpendKind[] {
  return (Object.keys(SPEND_CATEGORY_OF) as SpendKind[]).filter((kind) => SPEND_CATEGORY_OF[kind] === category);
}

export function spendFilterOf(window: SpendWindow, drill: SpendDrill): SpendFilter {
  const filter: SpendFilter = {};
  if (window.from) filter.from = window.from;
  if (window.to) filter.to = window.to;
  if (drill.kind && drill.kind.length > 0) filter.kind = drill.kind;
  if (drill.sessionId) filter.session_id = drill.sessionId;
  if ("botId" in drill) filter.bot_id = drill.botId ?? null;
  if ("modelId" in drill) {
    filter.model = drill.model ?? null;
    if (drill.providerId) filter.provider_id = drill.providerId;
  }
  return filter;
}

export function summaryQueryOf(
  window: SpendWindow,
  drill: SpendDrill,
  dimension: SpendDimension,
  timeZone: string,
): SpendSummaryQuery {
  return { ...spendFilterOf(window, drill), group_by: dimension, tz: timeZone };
}

export function dayQueryOf(window: SpendWindow, drill: SpendDrill, timeZone: string): SpendSummaryQuery {
  return { ...spendFilterOf(window, drill), group_by: "day", tz: timeZone };
}

/**
 * Query string for `GET /v1/spend/summary` and `GET /v1/spend`.
 *
 * Local repeats `kind`. A paired device cannot: its query is one string per key, and the remote
 * route reads a comma-separated list, so `joinKinds` writes that instead. A null `bot_id` or
 * `model` is an empty parameter: that is the unassigned / unrecorded group, not "any".
 */
export function spendSearchParams(
  filter: SpendFilter & { group_by?: string; tz?: string; limit?: number; cursor?: string },
  joinKinds = false,
): string {
  const params = new URLSearchParams();
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.kind && filter.kind.length > 0) {
    if (joinKinds) params.set("kind", filter.kind.join(","));
    else for (const kind of filter.kind) params.append("kind", kind);
  }
  if ("bot_id" in filter) params.set("bot_id", filter.bot_id ?? "");
  if (filter.session_id) params.set("session_id", filter.session_id);
  if ("model" in filter) params.set("model", filter.model ?? "");
  if (filter.provider_id) params.set("provider_id", filter.provider_id);
  if (filter.turn_id) params.set("turn_id", filter.turn_id);
  if (filter.group_by) params.set("group_by", filter.group_by);
  if (filter.tz) params.set("tz", filter.tz);
  if (filter.limit != null) params.set("limit", String(filter.limit));
  if (filter.cursor) params.set("cursor", filter.cursor);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/** Whatever was stored, or the defaults when it is missing or from another build. */
export function readSpendView(raw: string | null): SpendViewState {
  if (!raw) return { ...DEFAULT_SPEND_VIEW };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...DEFAULT_SPEND_VIEW };
    const range = RANGES.has(parsed.range as SpendRangePreset) ? (parsed.range as SpendRangePreset) : DEFAULT_SPEND_VIEW.range;
    const dimension = DIMENSIONS.has(parsed.dimension as SpendDimension)
      ? (parsed.dimension as SpendDimension)
      : DEFAULT_SPEND_VIEW.dimension;
    const metric = METRICS.has(parsed.metric as SpendMetric) ? (parsed.metric as SpendMetric) : DEFAULT_SPEND_VIEW.metric;
    const sort = SORTS.has(parsed.sort as SpendSortColumn) ? (parsed.sort as SpendSortColumn) : DEFAULT_SPEND_VIEW.sort;
    const dir = parsed.dir === "asc" || parsed.dir === "desc" ? parsed.dir : DEFAULT_SPEND_VIEW.dir;
    // Keep a well-shaped day even when it is not a real one. The view rejects it; dropping it
    // here would turn a bad stored range into an empty one and then query nothing useful.
    const day = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
    return {
      range,
      customFrom: day(parsed.customFrom),
      customTo: day(parsed.customTo),
      dimension,
      metric,
      sort,
      dir,
    };
  } catch {
    return { ...DEFAULT_SPEND_VIEW };
  }
}

export function loadSpendView(storage: Pick<Storage, "getItem"> | null): SpendViewState {
  if (!storage) return { ...DEFAULT_SPEND_VIEW };
  try {
    return readSpendView(storage.getItem(SPEND_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_SPEND_VIEW };
  }
}

export function saveSpendView(storage: Pick<Storage, "setItem"> | null, state: SpendViewState): void {
  if (!storage) return;
  try {
    storage.setItem(SPEND_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A private window that refuses storage still shows the view; it just will not remember it.
  }
}
