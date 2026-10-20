import type { AgentShellAction } from "@real-bot/protocol";
import type { DistrictMap } from "./districts.ts";
import type { MapData } from "./map-data.ts";

/**
 * The replay's clock, squeezed: a step takes STEP seconds plus a ninetieth of the real gap (capped at
 * GAP_CAP real seconds), and a gap of LONG_GAP or more becomes LONG_GAP_V seconds and is marked, so
 * a night's pause does not take the replay's whole length.
 */
export const STEP = 0.45;
export const GAP_CAP = 900;
export const LONG_GAP = 15 * 60;
export const LONG_GAP_V = 4;
/** A call worth a moment for its length alone. */
export const LONG_CALL_MS = 30_000;

export type Idle = { v0: number; v1: number; t0: number; t1: number };

/** What it was asked: what you said, and how you answered its questions. */
export type Quest =
  | { kind: "say"; at: number; v: number; text: string }
  | { kind: "answer"; at: number; v: number; askedAt: number; questions: string[]; answers: string[] };

/** Moments worth a look, described rather than judged; the copy words them. */
export type Moment =
  | { kind: "spawn"; who: number; v: number; v1: number; places: number[]; from: number; to: number; steps: number; model: string | null }
  | { kind: "ask"; who: 0; v: number; v1: number; places: number[]; askedAt: number; waitMs: number; answers: string[] }
  | { kind: "say"; who: 0; v: number; v1: number; places: number[]; at: number; text: string }
  | { kind: "idle"; who: -1; v: number; v1: number; places: number[]; t0: number; t1: number; waitingForYou: boolean }
  | { kind: "reject"; who: number; v: number; v1: number; places: number[]; at: number; source: string | null; reason: string | null; waitMs: number }
  | { kind: "approve"; who: number; v: number; v1: number; places: number[]; at: number }
  | { kind: "fail"; who: -1; v: number; v1: number; places: number[]; count: number; byWho: [number, number][] }
  | { kind: "long"; who: number; v: number; v1: number; places: number[]; tool: string; action: AgentShellAction | null; ms: number; file: string | null }
  | { kind: "loop"; who: 0; v: number; v1: number; places: [number, number]; from: number; to: number; trips: number };

export type Timeline = {
  t0: number;
  /** The replay's length on its squeezed clock, seconds. */
  total: number;
  /** Each call's moment on the squeezed clock, in `MapData.calls` order. */
  v: number[];
  /** Each call's district. */
  placeOf: number[];
  idles: Idle[];
  quests: Quest[];
  moments: Moment[];
  /** One density path per character in a `track`-wide strip, `laneH` high each; failures as dots. */
  lanes: string[];
  failD: string;
  laneH: number;
};

/** A call the app or you stopped: shown as a refusal, not counted among failures. */
function refused(decision: MapData["calls"][number]["decision"]): boolean {
  return decision?.decision === "reject";
}

/**
 * The map's timeline for a session. A call you let through on its card (`user_temporary`) is an
 * approval only when it is not a question: in a terminal session Claude Code records your answer to
 * AskUserQuestion the same way.
 */
export function buildTimeline(data: MapData, map: DistrictMap, track = 996, laneArea = 56): Timeline {
  const calls = data.calls;
  const placeOf = calls.map((c) => map.indexOf(c.place));
  const t0 = calls[0]?.at ?? 0;
  let clock = 0;
  const v: number[] = [];
  const idles: Idle[] = [];
  calls.forEach((c, i) => {
    if (i) {
      const gap = (c.at - calls[i - 1]!.at) / 1000;
      if (gap >= LONG_GAP) {
        idles.push({ v0: round(clock), v1: round(clock + LONG_GAP_V), t0: calls[i - 1]!.at, t1: c.at });
        clock += LONG_GAP_V;
      } else clock += STEP + Math.min(gap, GAP_CAP) / 90;
    }
    v.push(round(clock));
  });
  const total = round(clock + 3);
  const vOf = (t: number): number => {
    if (!calls.length) return 0;
    if (t < calls[0]!.at) return v[0]!;
    for (let i = 0; i < calls.length - 1; i++) {
      const a = calls[i]!.at, b = calls[i + 1]!.at;
      if (a <= t && t < b) return round(v[i]! + ((v[i + 1]! - v[i]!) * (t - a)) / Math.max(1, b - a));
    }
    return v[v.length - 1]!;
  };

  const quests: Quest[] = data.said.map((line): Quest => {
    const at = Date.parse(line.at);
    if (line.kind === "say") return { kind: "say", at, v: vOf(at), text: line.text };
    return { kind: "answer", at, v: vOf(at), askedAt: Date.parse(line.asked_at), questions: line.questions, answers: line.answers };
  }).filter((q) => Number.isFinite(q.at)).sort((a, b) => a.at - b.at);

  const root = map.indexOf({ zone: "none" });
  const moments: Moment[] = [];

  // Subagents: when each went out, how long and where it mostly worked.
  data.characters.forEach((ch, who) => {
    if (who === 0) return;
    const mine = calls.map((c, i) => [c, i] as const).filter(([c]) => c.who === who);
    if (!mine.length) return;
    const top = mode(mine.map(([, i]) => placeOf[i]!));
    const models = mode(mine.map(([c]) => c.model ?? ""));
    moments.push({ kind: "spawn", who, v: v[mine[0]![1]]!, v1: v[mine[mine.length - 1]![1]]!, places: [top], from: mine[0]![0].at, to: ch.lastAt ?? mine[mine.length - 1]![0].at, steps: mine.length, model: models || null });
  });

  // Its questions and how long they waited on you; what you said after the first line.
  for (const q of quests) {
    if (q.kind === "answer") moments.push({ kind: "ask", who: 0, v: vOf(q.askedAt), v1: q.v, places: [root], askedAt: q.askedAt, waitMs: Math.max(0, q.at - q.askedAt), answers: q.answers });
    else if (q !== quests[0]) moments.push({ kind: "say", who: 0, v: q.v, v1: q.v, places: [root], at: q.at, text: q.text });
  }

  // Long pauses, and whether what ended one was you.
  for (const g of idles) {
    const you = quests.some((q) => q.kind === "say" && q.at >= g.t0 && q.at <= g.t1 + 60_000);
    moments.push({ kind: "idle", who: -1, v: g.v0, v1: g.v1, places: [], t0: g.t0, t1: g.t1, waitingForYou: you });
  }

  // Refusals and approvals on its calls.
  calls.forEach((c, i) => {
    if (refused(c.decision)) moments.push({ kind: "reject", who: c.who, v: v[i]!, v1: v[i]!, places: [placeOf[i]!], at: c.at, source: c.decision!.source, reason: c.decision!.reason_type, waitMs: c.durationMs });
    else if (c.decision?.source === "user_temporary" && c.tool !== "AskUserQuestion") moments.push({ kind: "approve", who: c.who, v: v[i]!, v1: v[i]!, places: [placeOf[i]!], at: c.at });
  });

  const fails = calls.map((c, i) => [c, i] as const).filter(([c]) => !c.ok && !refused(c.decision) && !c.running);
  if (fails.length) {
    const byWho = new Map<number, number>();
    for (const [c] of fails) byWho.set(c.who, (byWho.get(c.who) ?? 0) + 1);
    moments.push({ kind: "fail", who: -1, v: v[fails[0]![1]]!, v1: v[fails[0]![1]]!, places: [], count: fails.length, byWho: [...byWho.entries()].sort((a, b) => b[1] - a[1]) });
  }

  // The two longest calls of half a minute or more (a question or a subagent is long by waiting, not by work).
  calls.map((c, i) => [c, i] as const)
    .filter(([c]) => c.tool !== "AskUserQuestion" && c.tool !== "Agent" && c.tool !== "Task" && c.durationMs >= LONG_CALL_MS)
    .sort((a, b) => b[0].durationMs - a[0].durationMs)
    .slice(0, 2)
    .forEach(([c, i]) => moments.push({ kind: "long", who: c.who, v: v[i]!, v1: v[i]!, places: [placeOf[i]!], tool: c.tool, action: c.action ?? null, ms: c.durationMs, file: c.file }));

  moments.push(...loopsOf(calls, placeOf, v));
  moments.sort((a, b) => a.v - b.v);

  const n = Math.max(1, data.characters.length);
  const laneH = laneArea / n;
  const bin = 4, bins = Math.floor(track / bin);
  const lanes = data.characters.map((_, who) => {
    const counts = new Array<number>(bins).fill(0);
    calls.forEach((c, i) => { if (c.who === who) counts[Math.min(bins - 1, Math.floor((v[i]! / total) * bins))]! += 1; });
    const top = Math.max(1, ...counts);
    const base = laneH * (who + 1) - 2;
    return counts.map((k, x) => (k ? `M${x * bin} ${base.toFixed(1)}v-${(1 + (k / top) * (laneH - 4)).toFixed(1)}h3v${(1 + (k / top) * (laneH - 4)).toFixed(1)}z` : "")).join("");
  });
  const failD = fails.map(([c, i]) => `M${((v[i]! / total) * track).toFixed(1)} ${(laneH * (c.who + 1) - 3).toFixed(1)}m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0`).join("");

  return { t0, total, v, placeOf, idles, quests, moments, lanes, failD, laneH };
}

/** The agent itself going back and forth between two places, five or more switches each within ten minutes. */
function loopsOf(calls: MapData["calls"], placeOf: number[], v: number[]): Moment[] {
  const hops: [number, number][] = [];
  calls.forEach((c, i) => {
    if (c.who === 0 && (!hops.length || hops[hops.length - 1]![1] !== placeOf[i])) hops.push([i, placeOf[i]!]);
  });
  const out: Moment[] = [];
  let i = 0;
  while (i < hops.length - 3) {
    const a = hops[i]![1], b = hops[i + 1]![1];
    let j = i + 1;
    while (j + 1 < hops.length && hops[j + 1]![1] === ((j + 1 - i) % 2 === 0 ? a : b) && calls[hops[j + 1]![0]]!.at - calls[hops[j]![0]]!.at < 600_000) j++;
    if (j - i >= 5) {
      out.push({ kind: "loop", who: 0, v: v[hops[i]![0]]!, v1: v[hops[j]![0]]!, places: [a, b], from: calls[hops[i]![0]]!.at, to: calls[hops[j]![0]]!.at, trips: Math.floor((j - i + 1) / 2) });
      i = j;
    } else i++;
  }
  return out;
}

function mode<T>(xs: readonly T[]): T {
  const count = new Map<T, number>();
  for (const x of xs) count.set(x, (count.get(x) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
