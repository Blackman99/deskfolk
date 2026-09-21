/**
 * How much of the transcript the composer covers.
 *
 * The composer is absolutely positioned over the stream, so the stream reserves room for it. That
 * reserve used to be a constant tuned for a desktop composer; on a phone the bar is a different
 * height — attachment chips, a suggestion row, a wrapped placeholder, the home-indicator inset —
 * and anything taller than the constant hid the last messages behind it.
 */

/**
 * On iOS the layout viewport does not shrink when the keyboard opens: the visual viewport does.
 * Without this the composer sits behind the keyboard, at the bottom of a viewport nobody can see.
 */
export function keyboardInset(
  innerHeight: number,
  viewport?: { height: number; offsetTop: number } | null,
): number {
  if (!viewport || !Number.isFinite(viewport.height)) return 0;
  const hidden = innerHeight - (viewport.height + viewport.offsetTop);
  // Rounding noise and rubber-band scrolling both produce a pixel or two of nothing.
  return hidden > 8 ? Math.round(hidden) : 0;
}
