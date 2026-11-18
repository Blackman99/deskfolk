import type { MapData } from "./map-data.ts";
import type { Timeline } from "./timeline.ts";

/** One visit to a place: a character arriving, until it leaves. */
export type Trip = { first: number; last: number; who: number };

export type PlaceDetail = {
  /** Steps there up to the playhead, and in all. */
  upto: number;
  total: number;
  /** Visits there up to the playhead, and in all. */
  tripsNow: number;
  trips: number;
  /** Steps per character up to the playhead, the busiest first. */
  byWho: [number, number][];
  fails: number;
  /** The latest visits, newest first: when it began, who, its first call, and its steps so far. */
  recent: { at: number; who: number; call: number; steps: number; v: number }[];
  /** The visits just before and after the playhead, by their start on the squeezed clock. */
  prev: number | null;
  next: number | null;
  /** The timeline's ticks for every step there. */
  ticks: number[];
};

/** Every visit to each place, found once per timeline. */
export function tripsByPlace(data: MapData, tl: Timeline, places: number): Trip[][] {
  const out: Trip[][] = Array.from({ length: places }, () => []);
  const last = new Map<number, { tile: number; trip: Trip }>();
  data.calls.forEach((c, i) => {
    const tile = tl.placeOf[i]!;
    const seen = last.get(c.who);
    if (seen && seen.tile === tile) seen.trip.last = i;
    else {
      const trip = { first: i, last: i, who: c.who };
      out[tile]!.push(trip);
      last.set(c.who, { tile, trip });
    }
  });
  return out;
}

/** A place as its card shows it at the playhead (`idx` is the last call at or before it). */
export function placeDetail(data: MapData, tl: Timeline, trips: Trip[], tile: number, idx: number, v: number): PlaceDetail {
  const steps: number[] = [];
  tl.placeOf.forEach((p, i) => { if (p === tile) steps.push(i); });
  const upto = steps.filter((i) => i <= idx);
  const byWho = new Map<number, number>();
  let fails = 0;
  for (const i of upto) {
    const c = data.calls[i]!;
    byWho.set(c.who, (byWho.get(c.who) ?? 0) + 1);
    if (!c.ok) fails++;
  }
  const done = trips.filter((t) => t.first <= idx);
  const recent = done.slice(-4).reverse().map((t) => ({
    at: data.calls[t.first]!.at, who: t.who, call: t.first, v: tl.v[t.first]!,
    steps: data.calls.slice(t.first, Math.min(t.last, idx) + 1).filter((c, k) => c.who === t.who && tl.placeOf[t.first + k] === tile).length,
  }));
  let prev: number | null = null, next: number | null = null;
  for (const t of trips) {
    const tv = tl.v[t.first]!;
    if (tv < v - 0.05) prev = tv;
    else if (tv > v + 0.05) { next = tv; break; }
  }
  return {
    upto: upto.length, total: steps.length, tripsNow: done.length, trips: trips.length,
    byWho: [...byWho.entries()].sort((a, b) => b[1] - a[1]), fails, recent, prev, next,
    ticks: steps.map((i) => tl.v[i]!),
  };
}
