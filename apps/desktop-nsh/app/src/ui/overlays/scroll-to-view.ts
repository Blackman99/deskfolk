/**
 * Scrolls a `Scroll` so a view inside it sits at its top (`element.scrollIntoView({ block: "start" })`).
 * `measure` reports page positions with the scroll offset applied, so the view's distance below the
 * scroll's top edge, added to the offset it is at now, is where to go.
 */
import type { ScrollRef, ViewRef } from "nsh";

export async function scrollViewToTop(scroller: ScrollRef | null, offsetY: number, target: ViewRef, gap = 8): Promise<number | null> {
  if (!scroller) return null;
  const [box, view] = await Promise.all([target.measure(), scroller.measure()]);
  if (!box || !view) return null;
  const y = Math.max(0, offsetY + box.pagePosition.y - view.pagePosition.y - gap);
  scroller.scrollTo({ y });
  return y;
}
