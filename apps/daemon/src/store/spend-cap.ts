/**
 * The day's spend cap (ADR 0088): the cap you set, what the calls made since local midnight have
 * cost, and whether the cap has already stopped the Bots today. The engine reads {@link spendCapDue}
 * on the scheduler's tick and makes the stop; this file only answers and records.
 */
import { HttpError } from "../errors";
import type { HoldEffect } from "@real-bot/protocol";
import { setSetting, type StoreContext } from "./shared";

const TICKS_IN_USD = 10_000_000_000;
const CAP_KEY = "spend_cap_usd";
const TRIP_KEY = "spend_cap_trip";

/** The day the cap last stopped every Bot, and at what cap: it stops them once a day per cap. */
type Trip = { day: string; cap_usd: number };

/** The cap you set, in USD; null when there is none. */
export function spendCapUsd(ctx: StoreContext): number | null {
  const raw = ctx.db.query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`).get(CAP_KEY)?.value ?? "";
  const value = Number(raw);
  return raw !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Sets the cap from `PATCH /v1/settings`: a positive number of USD, or null for none. */
export function setSpendCapUsd(ctx: StoreContext, value: unknown): void {
  if (value === null) {
    setSetting(ctx, CAP_KEY, "");
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(422, "invalid_args", "spend_cap_usd must be a positive number of USD, or null");
  }
  setSetting(ctx, CAP_KEY, String(Math.round(value * 100) / 100));
}

/** Local midnight of the day `now` falls in, on the computer that runs the daemon, as an ISO time. */
export function localDayStart(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What the calls made since `since` cost, in USD: reported where the endpoint said, estimated where it did not. */
export function spendSinceUsd(ctx: StoreContext, since: string): number {
  const ticks = ctx.db
    .query<{ ticks: number | null }, [string]>(`SELECT SUM(COALESCE(cost_usd_ticks, estimated_cost_usd_ticks, 0)) AS ticks FROM spend WHERE created_at >= ?`)
    .get(since)?.ticks ?? 0;
  return ticks / TICKS_IN_USD;
}

function lastTrip(ctx: StoreContext): Trip | null {
  const raw = ctx.db.query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`).get(TRIP_KEY)?.value;
  if (!raw) return null;
  try {
    const trip = JSON.parse(raw) as Partial<Trip>;
    return typeof trip.day === "string" && typeof trip.cap_usd === "number" ? { day: trip.day, cap_usd: trip.cap_usd } : null;
  } catch {
    return null;
  }
}

/**
 * The stop the cap calls for now, if any: a cap is set, today's calls have cost at least that much,
 * and the cap has not already stopped the Bots today at this amount. A stop you lifted is not made
 * again the same day unless you change the cap; tomorrow starts afresh.
 */
export function spendCapDue(ctx: StoreContext, now: Date = new Date()): { capUsd: number; spentUsd: number; day: string } | null {
  const capUsd = spendCapUsd(ctx);
  if (capUsd === null) return null;
  const spentUsd = spendSinceUsd(ctx, localDayStart(now));
  if (spentUsd < capUsd) return null;
  const day = localDay(now);
  const trip = lastTrip(ctx);
  if (trip && trip.day === day && trip.cap_usd === capUsd) return null;
  return { capUsd, spentUsd, day };
}

/** Records that the cap stopped the Bots today, and on the hold it made, what it stood at. */
export function noteSpendCapTrip(ctx: StoreContext, input: { day: string; capUsd: number; spentUsd: number; holdId: string | null }): void {
  setSetting(ctx, TRIP_KEY, JSON.stringify({ day: input.day, cap_usd: input.capUsd } satisfies Trip));
  if (!input.holdId) return;
  const note: NonNullable<HoldEffect["spend_cap"]> = { cap_usd: input.capUsd, spent_usd: Math.round(input.spentUsd * 100) / 100 };
  ctx.db.run(`UPDATE holds SET effect = json_set(effect, '$.spend_cap', json(?)) WHERE id = ?`, [JSON.stringify(note), input.holdId]);
}
