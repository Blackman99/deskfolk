/**
 * Where the floating usage widget is and whether it shows (ADR 0080), kept per device in
 * `localStorage`: docked to an edge (tucked away until pointed at) or floating free, with its
 * height as a share of the window's, so a resized window keeps it in view.
 */
export type UsageWidgetPlace =
  | { dock: "left" | "right"; top: number }
  | { dock: null; left: number; top: number };

const KEY = "real-bot-usage-widget";
/** Top right, under the window's top bar. */
export const USAGE_WIDGET_DEFAULT: UsageWidgetPlace = { dock: "right", top: 0.08 };
/** Dropped this close to an edge, the widget docks to it. */
export const USAGE_DOCK_PX = 24;

type Stored = { place: UsageWidgetPlace; hidden: boolean };

function share(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

export function readUsageWidget(): Stored {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as { place?: Record<string, unknown>; hidden?: unknown } | null;
    const place = raw?.place;
    const top = share(place?.top);
    let read: UsageWidgetPlace = USAGE_WIDGET_DEFAULT;
    if (place && top !== null && (place.dock === "left" || place.dock === "right")) read = { dock: place.dock, top };
    else if (place && top !== null && place.dock === null && share(place.left) !== null) read = { dock: null, left: share(place.left)!, top };
    return { place: read, hidden: raw?.hidden === true };
  } catch {
    return { place: USAGE_WIDGET_DEFAULT, hidden: false };
  }
}

function write(stored: Stored): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // A private window or blocked storage: the widget still works, only it forgets its place.
  }
}

/** The widget's state for this window: one, so the Tools menu and the menu bar can open its panel. */
class UsageWidgetState {
  place = $state<UsageWidgetPlace>(USAGE_WIDGET_DEFAULT);
  hidden = $state(false);
  open = $state(false);

  constructor() {
    const stored = typeof window === "undefined" ? null : readUsageWidget();
    if (stored) {
      this.place = stored.place;
      this.hidden = stored.hidden;
    }
  }

  move(place: UsageWidgetPlace): void {
    this.place = place;
    write({ place, hidden: this.hidden });
  }

  hide(): void {
    this.hidden = true;
    this.open = false;
    write({ place: this.place, hidden: true });
  }

  /** Shows the widget again if it was hidden, and opens its panel. */
  show(): void {
    if (this.hidden) {
      this.hidden = false;
      write({ place: this.place, hidden: false });
    }
    this.open = true;
  }
}

export const usageWidget = new UsageWidgetState();

/**
 * Where a widget dropped at `left`/`top` (its box `width` wide, in a `viewW`×`viewH` window) goes:
 * docked to an edge it was dropped within {@link USAGE_DOCK_PX} of, otherwise floating there.
 */
export function usageDrop(left: number, top: number, width: number, height: number, viewW: number, viewH: number): UsageWidgetPlace {
  const room = Math.max(1, viewH - height);
  const topShare = Math.min(1, Math.max(0, top / room));
  if (left <= USAGE_DOCK_PX) return { dock: "left", top: topShare };
  if (viewW - (left + width) <= USAGE_DOCK_PX) return { dock: "right", top: topShare };
  return { dock: null, left: Math.min(1, Math.max(0, left / Math.max(1, viewW - width))), top: topShare };
}
