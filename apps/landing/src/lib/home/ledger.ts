/**
 * The sample ledger the spend scene prints, and the arithmetic over it. The app keeps reported cost
 * (what the provider says a call cost) and estimated cost (tokens times prices you set) as two
 * totals and never adds them into one; `totals` mirrors that.
 */

export type LedgerRow = {
  time: string;
  bot: 'producer' | 'reviewer';
  /** A neutral display name, not a model id. */
  model: string;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  kind: 'reported' | 'estimated';
  /** Which of the scene's chat messages set this call off (index into `copy.messages`). */
  message: number;
};

/** The daily cap the scene sets, in dollars. */
export const CAP = 3;

/**
 * Reported cost is what the provider itself says a call cost (`cost_in_usd_ticks`, which xAI's API
 * returns); everything else, Claude Code's own figures included, is estimated from prices.
 */
export const SAMPLE_ROWS: readonly LedgerRow[] = [
  { time: '09:12', bot: 'producer', model: 'Grok', tokensIn: 18200, tokensOut: 2100, usd: 0.84, kind: 'reported', message: 0 },
  { time: '09:13', bot: 'producer', model: 'Claude Haiku', tokensIn: 6400, tokensOut: 1100, usd: 0.07, kind: 'estimated', message: 0 },
  { time: '09:15', bot: 'producer', model: 'DeepSeek', tokensIn: 22000, tokensOut: 3800, usd: 0.19, kind: 'estimated', message: 0 },
  { time: '09:21', bot: 'producer', model: 'Grok', tokensIn: 31500, tokensOut: 4400, usd: 1.02, kind: 'reported', message: 1 },
  { time: '09:24', bot: 'reviewer', model: 'Qwen', tokensIn: 14800, tokensOut: 1900, usd: 0.11, kind: 'estimated', message: 2 },
  { time: '09:26', bot: 'reviewer', model: 'Claude Opus', tokensIn: 12400, tokensOut: 1200, usd: 0.46, kind: 'estimated', message: 2 },
  { time: '09:31', bot: 'producer', model: 'Grok', tokensIn: 20100, tokensOut: 3000, usd: 0.78, kind: 'reported', message: 3 }
];

const cents = (n: number) => Math.round(n * 100) / 100;

/** Reported and estimated cost, each on its own; there is deliberately no grand total. */
export function totals(rows: readonly LedgerRow[]): { reported: number; estimated: number } {
  let reported = 0;
  let estimated = 0;
  for (const r of rows) {
    if (r.kind === 'reported') reported += r.usd;
    else estimated += r.usd;
  }
  return { reported: cents(reported), estimated: cents(estimated) };
}

/** The index of the call that takes the day's running spend to the cap or past it, or -1. */
export function capCrossIndex(rows: readonly LedgerRow[], cap: number): number {
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i].usd;
    if (cents(sum) >= cap) return i;
  }
  return -1;
}

/** 12400 → "12.4k", 980 → "980", 2300000 → "2.3M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  const k = n / 1000;
  const one = k.toFixed(1);
  return k < 100 && one !== '100.0' ? `${one}k` : `${Math.round(k)}k`;
}
