/**
 * Popups that dismiss on an outside click share this predicate. Each keeps its own open flag and
 * its own element refs; the window handler stays one place so the order of those checks is visible.
 */
export function isOutside(target: Node | null, ...containers: (Node | null | undefined)[]): boolean {
  if (!target) return true;
  return containers.every((container) => !container?.contains(target));
}

/**
 * Outside-click dismissal for a full-screen backdrop.
 *
 * The `click` target alone is not enough: `click` fires on the nearest common ancestor of the press
 * and the release, so dragging a text selection from inside a sheet out onto the backdrop makes the
 * backdrop the click target even though the press never left the sheet. That used to close a drawer
 * the user was still reading. Wire `mousedown` to `press` and `click` to `isOutside`: a press that
 * began inside the sheet can never dismiss, however far the drag travels.
 *
 * `press` belongs on the capture phase (`onmousedowncapture`). A sheet that stops `mousedown` from
 * bubbling — a custom field, an editor, a scroll handle — would otherwise leave `press` uncalled,
 * and the next release on the backdrop would read as an outside click.
 */
export function backdropClick(): {
  press: (event: MouseEvent) => void;
  isOutside: (event: MouseEvent) => boolean;
} {
  let pressedInside = false;
  return {
    press(event) {
      // Only the press point decides. A release anywhere else is the tail of a drag, not a click.
      pressedInside = event.target !== event.currentTarget;
    },
    isOutside(event) {
      return !pressedInside && event.target === event.currentTarget;
    }
  };
}
