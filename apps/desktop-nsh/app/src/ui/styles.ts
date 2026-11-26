/**
 * What `tokens.css` holds that is not a theme value in NSH: shadows (by look), motion timings, and
 * the type scale (font sizes are literal in the messenger too, ADR 0106). Everything else is a
 * theme token, used as a class: `bg-pane`, `text-ink`, `border-line`, `rounded-(--radius-md)`;
 * `--accent` is `brand` and `--muted` is `ink-muted` (NSH's own `accent` / `muted` mean other things).
 */
import { colorScheme, platform, token, type ViewStyle } from "nsh";
import { SHADOWS } from "./shadows.generated";

export type ShadowName = keyof (typeof SHADOWS)["light"];

/** A shadow of the current look, for `style={{ boxShadow: shadow("menu") }}`. Reactive. */
export function shadow(name: ShadowName): string {
  return SHADOWS[colorScheme() === "dark" ? "dark" : "light"][name];
}

/**
 * The scrim of a dialog, a sheet or a drawer (`bg-modal-backdrop`) blurs what it covers a little:
 * its `backdropStyle`, or its `style` where the scrim is a view of our own. Only where it paints
 * that tint: a phone's whole-page dialog and a backdrop left transparent take none.
 *
 * On macOS NSH draws a `backdropFilter` blur as AppKit's material (`NSVisualEffectView`, popover),
 * whose radius and tint are AppKit's: a flat grey slab over the window, not a slight blur. A view
 * with a `maskImage` draws a plain blur at its own radius instead, so there the scrim carries a mask
 * that keeps all of it. There, too, a scrim that rests below full opacity (its own or a parent's)
 * draws no blur at all, only its tint; a fade that ends at full opacity blends it in. The web and
 * Windows draw the blur as asked; Linux draws none.
 */
export const SCRIM_BLUR: ViewStyle = {
  backdropFilter: "blur(4px)",
  ...(platform.os === "macos" ? { maskImage: "linear-gradient(#000, #000)" } : {}),
};

/**
 * A colour the mirrored modules give as CSS (`var(--av-3-bg)`, the avatar palettes) as the theme's
 * value now: NSH styles take colours, not `var()`. Reactive, like `token`.
 */
export function cssColor(value: string): string {
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(value.trim());
  if (!m) return value;
  const name = m[1] === "accent" ? "brand" : m[1] === "muted" ? "ink-muted" : m[1]!;
  return String(token(name as Parameters<typeof token>[0]) ?? value);
}

/** `--dur-fast` / `--dur-base` / `--dur-slow`, in milliseconds. */
export const DURATION = { fast: 120, base: 180, slow: 260 } as const;

/** The type scale (`--text-*`), in points: class `text-[13px]` is `small`. */
export const TEXT = { display: 28, title: 20, heading: 16, body: 14, small: 13, caption: 12, micro: 11 } as const;

/** Shared desktop popup menu container appearance (does not prescribe close or keyboard behaviour). */
export const MENU_SURFACE = "p-[5px] bg-pane border border-line rounded-(--radius-md)";

/** Shared desktop popup menu item layout, hover, focus and disabled appearance (callers keep `cursor-pointer select-none` inline for `press-cursor.test.ts`). */
export const MENU_ITEM =
  "flex-row items-center gap-2 w-full px-[10px] py-[6px] rounded-(--radius-sm) hover:bg-line-subtle focus:bg-line-subtle focus-visible:bg-line-subtle disabled:opacity-[0.45]";
