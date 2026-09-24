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

function pairAt(text: string, index: number): boolean {
  const high = text.charCodeAt(index);
  if (high < 0xd800 || high > 0xdbff) return false;
  const low = text.charCodeAt(index + 1);
  return low >= 0xdc00 && low <= 0xdfff;
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}
