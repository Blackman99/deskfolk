import type { EndpointModelInput } from "@real-bot/protocol";

/**
 * Model-selection probes (P0's job before P5's escalation ladder reads either): streaming
 * throughput's 10th percentile (`stream_tps_p10`, sizes a hop's wall-clock cap — see
 * `hop-limits.ts`), and whether raising the thinking level actually buys more reasoning past a
 * tool loop's first two hops (`reasoning_effective`). The pure scoring and the catalog patch live
 * here so they're unit-tested without a network; `scripts/model-probe.ts` drives a real endpoint
 * (or a scripted client under `--dry-run`) through a fixed ≥5-hop tool loop and calls these.
 *
 * Why hop ≥3: a real model was found whose first two hops carried reasoning tokens at similar
 * rates on both thinking levels (83.1% high, 93.8% none) but dropped to 6.7% on `high` from hop 3
 * on — looking only at the first two hops would have judged it effective when it was not.
 */

/** `failed` marks a hop whose completion errored or came back with no tool call — the loop stops
 *  there, so this thinking level's reading is short of the hops that were asked for and must not be
 *  read as "not effective" (see `hopsReliable`). */
export type HopSample = { hop: number; reasoningTokens: number | null; failed?: boolean };

/**
 * The 10th percentile by linear interpolation between the two closest ranks. Empty input is null —
 * nothing measured, not a fake zero a hop-limit calculation would read as "unmeasurably slow".
 */
export function percentile10(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = 0.1 * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/**
 * Share of hops from the 3rd on (1-indexed) that carried a reasoning token. No hop that far in
 * reads as 0, not `NaN`: a loop too short to reach hop 3 has not demonstrated any late reasoning,
 * which is exactly what "not effective" should read as.
 */
export function reasoningShareFromHop3(samples: readonly HopSample[]): number {
  const fromHop3 = samples.filter((sample) => sample.hop >= 3);
  if (fromHop3.length === 0) return 0;
  return fromHop3.filter((sample) => (sample.reasoningTokens ?? 0) > 0).length / fromHop3.length;
}

/** The two thresholds `reasoningEffectiveVerdict` reads: the none/high gap from hop 3 on, and high's own floor there. */
export const EFFECTIVE_GAP = 0.1;
export const EFFECTIVE_FLOOR = 0.2;

/** Shares this close to a threshold count as clearing it: `--hops 12` makes every share a multiple
 *  of 1/10, so an exact 10-point gap (0.3 - 0.2) lands on 0.09999999999999998 in float, one tick
 *  under `EFFECTIVE_GAP` — without this the boundary test below would be wrong on its own claim. */
const EPSILON = 1e-9;

/** The rule: false when the high/none gap is under 10 points, or high's own share from hop 3 on is under 20%; true otherwise (both boundaries are "at least", not "more than"). */
export function reasoningEffectiveVerdict(shareNone: number, shareHigh: number): boolean {
  if (shareHigh - shareNone < EFFECTIVE_GAP - EPSILON) return false;
  if (shareHigh < EFFECTIVE_FLOOR - EPSILON) return false;
  return true;
}

/**
 * Whether a thinking level's loop produced a reading worth trusting: it ran the full `hopsAsked`
 * hops with no failed or tool-less hop cutting it short. A short-circuited loop's hop≥3 share reads
 * as 0 (see `reasoningShareFromHop3`), which looks exactly like "measured, and not effective" even
 * though nothing was actually measured past the failure — `catalogPatch` must not write that.
 */
export function hopsReliable(samples: readonly HopSample[], hopsAsked: number): boolean {
  return samples.length >= hopsAsked && samples.every((sample) => !sample.failed);
}

export type ModelProbeResult = {
  model: string;
  share_none: number;
  share_high: number;
  /** null when either thinking level's loop broke off early (see `hopsReliable`) — unmeasured this
   *  run, not a false reading of "not effective". */
  reasoning_effective: boolean | null;
  /** null when no streaming sample came back (a `--dry-run`, or every attempt failed). */
  stream_tps_p10: number | null;
};

export function scoreModel(
  model: string,
  noneSamples: readonly HopSample[],
  highSamples: readonly HopSample[],
  tpsSamples: readonly number[],
  hopsAsked?: number,
): ModelProbeResult {
  const shareNone = reasoningShareFromHop3(noneSamples);
  const shareHigh = reasoningShareFromHop3(highSamples);
  // Callers that don't say how many hops they asked for (every existing test, and any caller that
  // only wants the raw shares) get the old, always-write behavior; `scripts/model-probe.ts` passes
  // its real `--hops` so a run that broke off early writes nothing instead of a false verdict.
  const reliable = hopsAsked === undefined || (hopsReliable(noneSamples, hopsAsked) && hopsReliable(highSamples, hopsAsked));
  return {
    model,
    share_none: shareNone,
    share_high: shareHigh,
    reasoning_effective: reliable ? reasoningEffectiveVerdict(shareNone, shareHigh) : null,
    stream_tps_p10: percentile10(tpsSamples),
  };
}

/**
 * What `--write` sends as one catalog entry: only the two measured fields, so the store's
 * `keepMeasured` (models.ts) leaves everything else about the model — pricing, thinking levels,
 * strengths — exactly as it was. A null measurement is left out, not sent as `null`: this probe
 * failing to get a reading must never clear a value an earlier run wrote.
 */
export function catalogPatch(result: ModelProbeResult): Exclude<EndpointModelInput, string> {
  return {
    name: result.model,
    ...(result.reasoning_effective !== null ? { reasoning_effective: result.reasoning_effective } : {}),
    ...(result.stream_tps_p10 !== null ? { stream_tps_p10: result.stream_tps_p10 } : {}),
  };
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;

export function formatReport(results: readonly ModelProbeResult[]): string {
  const lines = ["# model-probe", "", "| model | reasoning_effective | share (none → high, hop ≥3) | stream_tps_p10 |", "|---|---|---|---|"];
  for (const row of results) {
    const verdict = row.reasoning_effective === null ? "—" : row.reasoning_effective ? "true" : "false";
    lines.push(`| ${row.model} | ${verdict} | ${pct(row.share_none)} → ${pct(row.share_high)} | ${row.stream_tps_p10 === null ? "—" : row.stream_tps_p10.toFixed(1)} |`);
  }
  return lines.join("\n");
}
