/**
 * The sidebar's fold as the views see it (`ui/shell/sidebar-fold.ts` has the numbers): one animated
 * value per shell, how open the column is, that the shell sets at each frame of a fold, and the
 * styles bound to it. Words take `text`, the open sidebar takes `sidebar`, each of the rail's icons
 * `railIcon(order)` (its lines `railFade`).
 *
 * The shell hands its own to the sidebar and the rail (`FoldMotionHere`), so a second window folds on
 * its own. Outside a fold the value is 1 where the sidebar shows (a phone's roster too) and 0 where
 * the rail does, and every style is then exactly what the view would have without it. Where no shell
 * hands one down (a story), `foldMotion()` is null and the views take no binding at all.
 */
import { context, createAnimatedValue, type AnimatedValue, type ViewStyle } from "nsh";
import { FOLD_SIDEBAR, FOLD_TEXT, foldRailIcon, RAIL_STAGGER_CAP } from "../shell/sidebar-fold";

export type FoldMotion = {
  /** How open the sidebar's column is: 0 at the rail, 1 at its width. */
  readonly openness: AnimatedValue;
  /** The words of the open sidebar: they fade and draw in towards the avatars as the column closes. */
  readonly text: ViewStyle;
  /** The open sidebar as a whole: its avatars and buttons hand over to the rail's near the end. */
  readonly sidebar: ViewStyle;
  /** The rail's icon at `order`, top first: it grows into place a step after the one above it. */
  railIcon(order: number): ViewStyle;
  /** The fade alone, for the rail's lines (a divider, the foot's rule) that come in with the icon at `order`. */
  railFade(order: number): ViewStyle;
  /** The growth alone, for an icon inside something that already fades with `railFade`. */
  railScale(order: number): ViewStyle;
};

/** A shell's fold: open to begin with. */
export function createFoldMotion(): FoldMotion {
  const openness = createAnimatedValue(1);
  type RailStyles = { whole: ViewStyle; fade: ViewStyle; scale: ViewStyle };
  const rail = new Map<number, RailStyles>();
  const railAt = (order: number): RailStyles => {
    const key = Math.min(Math.max(0, Math.round(order)), RAIL_STAGGER_CAP);
    let styles = rail.get(key);
    if (!styles) {
      const keys = foldRailIcon(key);
      const opacity = openness.interpolate(keys.opacity);
      const transform = [{ scale: openness.interpolate(keys.scale) }];
      styles = { whole: { opacity, transform }, fade: { opacity }, scale: { transform } };
      rail.set(key, styles);
    }
    return styles;
  };
  return {
    openness,
    text: {
      opacity: openness.interpolate(FOLD_TEXT.opacity),
      transform: [{ translateX: openness.interpolate(FOLD_TEXT.translateX) }],
    },
    sidebar: { opacity: openness.interpolate(FOLD_SIDEBAR.opacity) },
    railIcon: (order) => railAt(order).whole,
    railFade: (order) => railAt(order).fade,
    railScale: (order) => railAt(order).scale,
  };
}

/** The fold of the shell around: read it while the component renders. */
export const FoldMotionHere = context<FoldMotion | null>(null);
export const foldMotion = (): FoldMotion | null => FoldMotionHere();
