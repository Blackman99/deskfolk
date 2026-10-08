import type { Locale } from "@real-bot/protocol";

/**
 * Walks UTF-16 units instead of spreading: `[...text]` builds one array slot per character, and
 * JavaScriptCore refuses past about 2^28 of them — a 300M-character shell dump threw
 * `RangeError: Out of memory` straight out of the turn.
 */
export function codePointCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += pairAt(text, i) ? 2 : 1) count++;
  return count;
}

export function takeCodePoints(text: string, limit: number): {
  text: string;
  original: number;
  truncated: boolean;
} {
  const original = codePointCount(text);
  if (original <= limit) {
    return { text, original, truncated: false };
  }
  let end = 0;
  for (let taken = 0; taken < limit; taken++) end += pairAt(text, end) ? 2 : 1;
  return {
    text: text.slice(0, end),
    original,
    truncated: true,
  };
}

/**
 * The end of `text`, at most `limit` code points: cut by UTF-16 units first, so a huge dump is never
 * walked, and without the low half of a pair the cut split.
 */
export function tailCodePoints(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const tail = text.slice(text.length - limit);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/** The last `limit` code points, ellipsis included in the count and marked when something was cut — a run's tail explains a failure, not its head. */
export function tailWithEllipsis(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `…${chars.slice(-(limit - 1)).join("")}` : text;
}

function pairAt(text: string, index: number): boolean {
  const high = text.charCodeAt(index);
  if (high < 0xd800 || high > 0xdbff) return false;
  const low = text.charCodeAt(index + 1);
  return low >= 0xdc00 && low <= 0xdfff;
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function bilingual(locale: Locale, zh: string, en: string): string {
  return locale === "en" ? en : zh;
}

/**
 * A run's one-line `detail` is shown on the flow board and quoted to the organizer and in call-back
 * notes, so it is written in the app's locale, like every other line the app says.
 */
export function sayIn(locale: Locale): (zh: string, en: string) => string {
  return (zh, en) => bilingual(locale, zh, en);
}
