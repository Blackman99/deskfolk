/**
 * The mouse wheel, two-finger scrolling and the trackpad's pinch, for views that zoom or scroll
 * themselves: the trace board, a picture in the lightbox, the task map, the terminal's history.
 * NSH 0.4's views hear no wheel (its own `Scroll` and `List` do, natively), so the desktop shells
 * forward every one to the window's app as `shell.wheel` (`host/src/wheel.rs`), and this module
 * hands it to the innermost view that asked for it under the pointer.
 *
 * The event reads like the DOM's `WheelEvent`, so the messenger's handlers port unchanged: `dx`,
 * `dy` in points, positive down and right; a pinch is `ctrl` with `dy = -100·ln(scale)`, as
 * Chromium sends one. `x`, `y` are in the window (`ViewRef.measure()`'s page coordinates); the
 * handler also gets them inside the view.
 *
 *   onWheel(() => boardRef, (e, at) => { if (e.ctrl || e.meta) zoomAround(at, Math.exp(-e.dy / 100)); else pan(e.dx, e.dy); });
 *
 * Call it while a component renders: the view stops hearing when the component goes.
 */
import { cleanup, host, type ViewRef } from "nsh";

export type ShellWheel = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** A trackpad pinch (then `ctrl` is set and `dy` is its zoom step). */
  pinch: boolean;
  /** The gesture's phase on a trackpad (`began`, `changed`, `ended`…), null for a mouse wheel. */
  phase: string | null;
  /** The momentum phase after the fingers lift, null while they touch. */
  momentum: string | null;
};

export type WheelHandler = (event: ShellWheel, at: { x: number; y: number }) => void;

type Rect = { x: number; y: number; width: number; height: number };
type Region = { view: () => ViewRef | null | undefined; handler: WheelHandler; rect: Rect | null };

const regions = new Set<Region>();
let measuredAt = 0;
/** How long a measured frame is trusted: views move under scrolling and resizing. */
const FRESH_MS = 200;

async function measureAll(): Promise<void> {
  await Promise.all(
    [...regions].map(async (region) => {
      const m = await region.view()?.measure();
      region.rect = m ? { x: m.pagePosition.x, y: m.pagePosition.y, width: m.bounds.size.width, height: m.bounds.size.height } : null;
    }),
  );
}

/** The innermost region under `(x, y)`: the smallest that contains it. */
export function regionAt<T extends { rect: Rect | null }>(all: Iterable<T>, x: number, y: number): T | null {
  let best: T | null = null;
  let area = Infinity;
  for (const region of all) {
    const r = region.rect;
    if (!r || x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height) continue;
    const a = r.width * r.height;
    if (a <= area) {
      best = region;
      area = a;
    }
  }
  return best;
}

async function dispatch(event: ShellWheel): Promise<void> {
  if (regions.size === 0) return;
  const now = Date.now();
  if (now - measuredAt > FRESH_MS || event.phase === "began") {
    measuredAt = now;
    await measureAll();
  }
  const region = regionAt(regions, event.x, event.y);
  if (!region?.rect) return;
  region.handler(event, { x: event.x - region.rect.x, y: event.y - region.rect.y });
}

/** Listens for the shell's wheel events; once, outside any component, so no unmount stops it. */
export function installWheel(): void {
  if (!host.available()) return;
  host.on("shell.wheel", (data) => void dispatch(data as unknown as ShellWheel));
}

/** `view`'s wheel events go to `handler` while the calling component lives. */
export function onWheel(view: () => ViewRef | null | undefined, handler: WheelHandler): void {
  const region: Region = { view, handler, rect: null };
  regions.add(region);
  measuredAt = 0;
  cleanup(() => regions.delete(region));
}
