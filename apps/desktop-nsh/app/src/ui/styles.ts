/**
 * What `tokens.css` holds that is not a theme value in NSH: shadows (by look), motion timings, and
 * the type scale (font sizes are literal in the messenger too, ADR 0106). Everything else is a
 * theme token, used as a class: `bg-pane`, `text-ink`, `border-line`, `rounded-(--radius-md)`;
 * `--accent` is `brand` and `--muted` is `ink-muted` (NSH's own `accent` / `muted` mean other things).
 */
import { colorScheme } from "nsh";
import { SHADOWS } from "./shadows.generated";

export type ShadowName = keyof (typeof SHADOWS)["light"];

/** A shadow of the current look, for `style={{ boxShadow: shadow("menu") }}`. Reactive. */
export function shadow(name: ShadowName): string {
  return SHADOWS[colorScheme() === "dark" ? "dark" : "light"][name];
}

/** `--dur-fast` / `--dur-base` / `--dur-slow`, in milliseconds. */
export const DURATION = { fast: 120, base: 180, slow: 260 } as const;

/** The type scale (`--text-*`), in points: class `text-[13px]` is `small`. */
export const TEXT = { display: 28, title: 20, heading: 16, body: 14, small: 13, caption: 12, micro: 11 } as const;
