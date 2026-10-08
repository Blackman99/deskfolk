/**
 * The listener plumbing a pointer drag shares: `move` on every pointermove, `end` once on the
 * release, then the listeners are gone. Pointer capture, the origin, the state writes and any
 * `dragGate` calls stay with the caller, which is where each drag differs.
 *
 * `target` is the handle (it holds pointer capture, so it keeps hearing the pointer) or `window`.
 * `cancel: false` leaves `pointercancel` unheard, for the drags that never listened for it.
 */
export function trackPointerDrag(
  target: EventTarget,
  handlers: { move: (event: PointerEvent) => void; end: (event: PointerEvent) => void; cancel?: boolean }
): void {
  const move = handlers.move as EventListener;
  const cancel = handlers.cancel ?? true;
  const finish = ((event: PointerEvent) => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", finish);
    if (cancel) target.removeEventListener("pointercancel", finish);
    handlers.end(event);
  }) as EventListener;
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", finish);
  if (cancel) target.addEventListener("pointercancel", finish);
}
