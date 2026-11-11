/**
 * What the ledger's parts share. The messenger draws them with global classes under `.spend`
 * (`.surface`, `.section-head`, `.segmented`) and a few `color-mix` shades; here they are class
 * strings and two small helpers, so each section component draws the same card.
 */
import { token } from "nsh";
import type { SpendCategory } from "@real-bot/protocol";

/** `.surface`: the card every section sits in. */
export const SURFACE = "bg-pane border border-line rounded-(--radius-md) overflow-hidden min-w-0";

/** `.section-head`: a card's heading row. */
export const SECTION_HEAD = "flex-row items-center justify-between flex-wrap gap-x-3 gap-y-2 px-[18px] py-[14px]";

/** A share of a whole as the ledger names it: whole numbers from 10%, one decimal below, `<0.1%` under that. */
export function sharePercent(share: number): string {
  return share >= 10 || share === 0 ? `${Math.round(share)}%` : share >= 0.1 ? `${share.toFixed(1)}%` : "<0.1%";
}

/** A category's colour in the trend, the share bar and the dots: the accent, purple, ok, warn, then the faint grey. */
export function categoryColor(category: SpendCategory | string): string {
  switch (category) {
    case "judgement":
      return String(token("purple"));
    case "decision":
      return String(token("ok"));
    case "feedback":
      return String(token("warn"));
    case "other":
      return String(token("muted-light"));
    default:
      return String(token("brand"));
  }
}

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((d) => d + d).join("");
    if (digits.length !== 6 && digits.length !== 8) return null;
    const n = (i: number) => parseInt(digits.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), digits.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean).map((p) => Number.parseFloat(p));
    if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  }
  return null;
}

/**
 * `color-mix(in srgb, a <percent>%, b)`: `a` and `b` as theme colours, mixed. A colour it cannot
 * read (a name, a gradient) leaves `a` as it is.
 */
export function mixColors(a: string, b: string, percent: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return a;
  const w = percent / 100;
  const mix = (i: 0 | 1 | 2) => Math.round(ca[i] * w + cb[i] * (1 - w));
  const alpha = ca[3] * w + cb[3] * (1 - w);
  return `rgba(${mix(0)}, ${mix(1)}, ${mix(2)}, ${Math.round(alpha * 1000) / 1000})`;
}
