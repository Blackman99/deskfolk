/**
 * How readable a floor's words are on its grounds (ADR 0108 decision 8): colours as `token()` gives
 * them (`#rrggbbaa`), each ground laid over the one under it with its alpha, the bottom over white
 * or black, then the words over the result; WCAG 2's contrast ratio between the two.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` as channels in 0–1; null for anything else. */
export function parseHex(value: unknown): Rgba | null {
  if (typeof value !== "string") return null;
  const m = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!m) return null;
  let hex = m[1]!;
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
  if (hex.length !== 6 && hex.length !== 8) return null;
  const at = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: at(0), g: at(2), b: at(4), a: hex.length === 8 ? at(6) : 1 };
}

/** `top` laid over `below` (source-over); opaque when `below` is. */
export function over(top: Rgba, below: Rgba): Rgba {
  const a = top.a + below.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * below.a * (1 - top.a)) / a;
  return { r: mix(top.r, below.r), g: mix(top.g, below.g), b: mix(top.b, below.b), a };
}

function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgba): number {
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

/** WCAG 2's contrast ratio of two opaque colours, 1 to 21. */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The contrast of `ink` on `grounds` (bottom first) in a look: the grounds over white (light) or
 * black (dark), the ink over them. A colour that cannot be read counts as transparent, so a token
 * gone missing reads as words that are not there.
 */
export function inkContrast(ink: unknown, grounds: readonly unknown[], dark: boolean): number {
  const clear: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  let ground: Rgba = dark ? { r: 0, g: 0, b: 0, a: 1 } : { r: 1, g: 1, b: 1, a: 1 };
  for (const layer of grounds) ground = over(parseHex(layer) ?? clear, ground);
  return contrast(over(parseHex(ink) ?? clear, ground), ground);
}

/** WCAG 2.x 1.4.11's minimum for the parts of an interface: a floor is a control first. */
export const FLOOR_MIN_CONTRAST = 3;
