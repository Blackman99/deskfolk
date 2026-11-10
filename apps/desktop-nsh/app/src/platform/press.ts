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
 *
 * A press elsewhere also takes the keyboard from a text field, as a page's `mousedown` does (NSH
 * leaves it in the field, as AppKit apps do): the shell marks a primary press on the app's own
 * views while a field edits (`unfocus`), and unless the press lands where the focus stays, the
 * field is let go (`shell.blur`). Where it stays are the messenger's `preventDefault` places, each
 * kept by its component while it shows:
 *
 *   keepFocusIn(() => frameOf(area));
 */
import { cleanup, host, type ViewRef } from "nsh";

export type ShellPress = {
  /** Window points from its top left (`ViewRef.measure()`'s page coordinates). */
  x: number;
  y: number;
  /** 0 the primary button, 2 the secondary one (or a control-click), 1 any other. */
  button: number;
  /** The press's number when it may take the keyboard from the field that edits; else null. */
  unfocus?: number | null;
};

export type Box = { x: number; y: number; width: number; height: number };

type Listener = (event: ShellPress) => void;
const listeners = new Set<Listener>();
type Boxes = () => ReadonlyArray<Box | null | undefined> | Promise<ReadonlyArray<Box | null | undefined>> | Box | null | Promise<Box | null>;
const keepers = new Set<Boxes>();

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
    const number = event.unfocus;
    if (typeof number === "number") void unfocusUnlessKept(event, number);
  });
}

/** Asks the shell to take the keyboard from the field unless the press is in a box that keeps it. */
async function unfocusUnlessKept(event: ShellPress, number: number): Promise<void> {
  const boxes = (await Promise.all([...keepers].map((read) => Promise.resolve().then(read).catch(() => null)))).flat();
  if (!outsideAll(boxes, event.x, event.y)) return;
  await host.call("shell.blur", number).catch(() => undefined);
}

/**
 * A press in `boxes` leaves the keyboard where it is while the calling component lives (the
 * messenger's `onmousedown` `preventDefault`): lists that pick for the field they belong to (the
 * @ list and the / commands of the message box, a filter's rows under its search). Views that
 * type through a hidden field of their own (the message box, the code editor, the terminal) need
 * none: the shell keeps a press inside such a view in its field (`host/src/press.rs`).
 */
export function keepFocusIn(boxes: Boxes): void {
  keepers.add(boxes);
  cleanup(() => keepers.delete(boxes));
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
