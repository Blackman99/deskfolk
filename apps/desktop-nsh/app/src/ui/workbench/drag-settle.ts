/**
 * A pane's layout that switches at a width (wide or narrow, docked, how many columns) holds while a
 * divider, a crossing or a floating pane's edge is in hand, and takes its new shape once it is let
 * go. Each switch builds a part of the pane anew (a task map's whole scene, the message box's
 * editor), and a drag that wandered across the line did that on every crossing; the panes themselves
 * still take their new size with the pointer. The messenger's `dragGate` waits the same way for a
 * pane's measuring; this is the part that changes what is drawn.
 */
import { computed, signal } from "nsh";

const resizing = signal(0);

/** Calls around a pane resize by hand (nested drags count). */
export const paneResize = {
  begin(): void {
    resizing.set(resizing() + 1);
  },
  end(): void {
    resizing.set(Math.max(0, resizing() - 1));
  },
};

/** `read()`, kept at what it was while a pane is resized by hand, and followed again when it ends. */
export function settled<T>(read: () => T): () => T {
  return computed<T>((previous) => {
    const now = read();
    return resizing() > 0 && previous !== undefined ? previous : now;
  });
}
