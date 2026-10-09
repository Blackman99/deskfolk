const DAY = 86_400;
const YEAR = 365 * DAY;

/** Largest first. A month is a twelfth of a year, so twelve of them are exactly one: never "12mo". */
const UNITS: readonly (readonly [unit: string, seconds: number])[] = [
  ["y", YEAR],
  ["mo", YEAR / 12],
  ["w", 7 * DAY],
  ["d", DAY],
  ["h", 3_600],
  ["m", 60],
  ["s", 1],
];

/**
 * A span of whole seconds in its two largest units: "1h 29m", "3d 4h", "2w 1d", "1mo 2w", "1y 3mo".
 * Both are cut down, never rounded up into a unit the span has not reached, and the second shows
 * even at zero ("1h 0m"), as "89m 0s" did. Under a minute it is only seconds; each caller says
 * those in its own way.
 */
export function formatSpan(seconds: number, separator = " "): string {
  const whole = Math.max(0, Math.floor(seconds));
  const at = UNITS.findIndex(([, size]) => whole >= size);
  if (at === -1 || at === UNITS.length - 1) return `${whole}s`;
  const [unit, size] = UNITS[at]!;
  const [next, nextSize] = UNITS[at + 1]!;
  const count = Math.floor(whole / size);
  return `${count}${unit}${separator}${Math.floor((whole - count * size) / nextSize)}${next}`;
}
