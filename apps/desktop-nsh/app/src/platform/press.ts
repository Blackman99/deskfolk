/**
 * A mouse button going down anywhere in the window, for menus that close on a press outside them
 * (the messenger's `pointerdown` listeners). NSH 0.4 on macOS tells an overlay about a press
 * outside it (`onPressOutside`, a `Popover` closing) only for presses its own views take: a press
 * in the message box (a hosted text view) or on the sidebar's empty space (a `windowDrag` region)
 * never reaches it, so a picker stayed open over such a click. The macOS shell forwards every
 * press to the window's app as `shell.press` (`host/src/press.rs`); the other shells send none
 * yet, and there the overlays' own `onPressOutside` is all there is.
 *
 *   onPressOutside(() => Promise.all([frameOf(panel), frameOf(trigger)]), () => close());
 *
 * Call it while a component renders: it stops when the component goes. `boxes` is read at the
 * press (the trigger may have moved since the menu opened); a press inside any of them is not
 * outside. Closing must be safe to repeat: where NSH does see the press, both close.
 */
import { cleanup, host, type ViewRef } from "nsh";

export type ShellPress = {
  /** Window points from its top left (`ViewRef.measure()`'s page coordinates). */
  x: number;
  y: number;
  /** 0 the primary button, 2 the secondary one (or a control-click), 1 any other. */
  button: number;
};

export type Box = { x: number; y: number; width: number; height: number };

type Listener = (event: ShellPress) => void;
const listeners = new Set<Listener>();

/** Where `view` is in the window now; null when it is not in the tree (or cannot be told). */
export async function frameOf(view: ViewRef | null | undefined): Promise<Box | null> {
  try {
    const at = await view?.measure();
    return at ? { x: at.pagePosition.x, y: at.pagePosition.y, width: at.bounds.size.width, height: at.bounds.size.height } : null;
  } catch {
    return null;
  }
}

/** Whether `(x, y)` is in none of `boxes` (a missing box contains nothing). */
export function outsideAll(boxes: ReadonlyArray<Box | null | undefined>, x: number, y: number): boolean {
  return !boxes.some((b) => b && x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height);
}

/** Listens for the shell's presses; once, outside any component, so no unmount stops it. */
export function installPress(): void {
  if (!host.available()) return;
  host.on("shell.press", (data) => {
    const event = data as unknown as ShellPress;
    for (const listener of [...listeners]) listener(event);
  });
}

/**
 * `onOutside` runs for a press that lands in none of `boxes` while the calling component lives.
 * `boxes` may measure (it is awaited); a box it cannot tell is left out.
 */
export function onPressOutside(boxes: () => ReadonlyArray<Box | null | undefined> | Promise<ReadonlyArray<Box | null | undefined>>, onOutside: (event: ShellPress) => void): void {
  const listener: Listener = (event) => {
    void Promise.resolve(boxes())
      .then((now) => {
        if (outsideAll(now, event.x, event.y)) onOutside(event);
      })
      .catch(() => {});
  };
  listeners.add(listener);
  cleanup(() => listeners.delete(listener));
}
