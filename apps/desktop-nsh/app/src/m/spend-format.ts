import type { Spend } from "@real-bot/protocol";

/** 10_000_000_000 ticks = 1 USD. From 花费数字从端点响应怎么来. */
export const TICKS_IN_USD = 10_000_000_000;

export function sumSpend(rows: readonly Spend[]): { tokens: number | null; ticks: number | null } {
  let tokens: number | null = null;
  let ticks: number | null = null;
  for (const row of rows) {
    if (row.total_tokens != null) tokens = (tokens ?? 0) + row.total_tokens;
    if (row.cost_usd_ticks != null) ticks = (ticks ?? 0) + row.cost_usd_ticks;
  }
  return { tokens, ticks };
}

export function sessionSpend(rows: readonly Spend[], sessionId: string): Spend[] {
  return rows.filter((row) => row.session_id === sessionId);
}

export function turnSpend(rows: readonly Spend[], turnId: string): Spend[] {
  return rows.filter((row) => row.turn_id === turnId);
}

export function judgementSpend(rows: readonly Spend[], sessionId: string): Spend[] {
  return rows.filter((row) => row.session_id === sessionId && row.judgement_id != null);
}

export function formatSpend(rows: readonly Spend[]): string {
  const { tokens, ticks } = sumSpend(rows);
  if (ticks != null) return formatUsd(ticks);
  if (tokens != null) return formatTokens(tokens);
  return "—";
}

export function formatUsd(ticks: number): string {
  const usd = ticks / TICKS_IN_USD;
  if (usd === 0) return "$0";
  if (Math.abs(usd) < 0.01) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimFloat(n / 1000)}k`;
  return `${trimFloat(n / 1_000_000)}M`;
}

function trimFloat(n: number): string {
  const text = n.toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}
