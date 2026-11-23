/**
 * The size of the window the app is in, read in one place (`viewportSize`), and its width
 * breakpoints, cached. Nothing else in the app reads NSH's `windowSize()`
 * (`scripts/viewport-reads.test.ts`).
 *
 * `windowSize()` is the size of the surface NSH draws in. On the desktops that is the app's host,
 * which never shows (NSH's window model, longbridge/nsh#2307), not the window the app is in:
 *
 * - On macOS the shell keeps the host at the window's frame, live through a resize
 *   (`host/src/window.rs`), so `windowSize()` is the window's, every frame.
 * - On Windows and Linux NSH's host stays at the size it opened at; the window's own size is what
 *   the platform reports of it (`state().contentBounds`), once a move or a resize settles.
 * - On the phone's page and a tablet the surface is the window, and `state()` is null.
 *
 * The size changes on every frame of a live resize; a reader of `width <= 680` ran again on each of
 * them, and with a hundred-odd such readers (classes, layouts, `matchMedia` in the mirrored logic) a
 * resize re-ran the app's effects for every frame and NSH's layout fell seconds behind the window. A
 * breakpoint here is a `computed` boolean: its readers hear only when the window crosses it.
 *
 * The computeds are made when this module loads, outside any component, so no component's end can
 * dispose one another still reads. A width not listed falls back to reading the window directly
 * (and says so once): add it to `BREAKPOINTS` instead.
 */
import { computed, platform, signal, windowSize, type Accessor, type Size } from "nsh";
import { currentWindow, type WindowRef } from "nsh/desktop";

/** The window the app renders in (`keepAppWindow`), whose state says its size on Windows and Linux. */
const appWindow = signal<WindowRef | null>(null);

/**
 * Keeps the window the app's root renders in, on the desktops: called as the root renders, where
 * `currentWindow()` can be read. Elsewhere there is no window to keep (`currentWindow()` throws on the
 * web, the phones and the terminal).
 */
export function keepAppWindow(): void {
  if (platform.os !== "macos" && platform.os !== "windows" && platform.os !== "linux") return;
  appWindow.set(currentWindow());
}

/** The window's content size as the platform reports it, where that is the size to read. */
function reported(): Size | null {
  if (platform.os !== "windows" && platform.os !== "linux") return null;
  return appWindow()?.state()?.contentBounds.size ?? null;
}

// Numbers, so their readers hear a change of size and not a move of the window.
const width = computed(() => reported()?.width ?? windowSize().width);
const height = computed(() => reported()?.height ?? windowSize().height);

/** The window's size in points (reactive). */
export function viewportSize(): Size {
  return { width: width(), height: height() };
}

/** Every width the app asks about (`<=`), in points: the shared phone/settings/menus breakpoint (680) and form column widths. */
const BREAKPOINTS = [360, 520, 540, 600, 680, 720, 760] as const;

const atMost = new Map<number, Accessor<boolean>>(BREAKPOINTS.map((w) => [w, computed(() => width() <= w)]));
const warned = new Set<number>();

/** True while the window is at most `width` points wide; its readers update only when that flips. */
export function widthAtMost(at: number): boolean {
  const cached = atMost.get(at);
  if (cached) return cached();
  if (!warned.has(at)) {
    warned.add(at);
    console.warn(`viewport: ${at} is not a cached breakpoint; every resize frame re-runs its readers`);
  }
  return width() <= at;
}

/** The phone layout's breakpoint (`NARROW_MAX_WIDTH`, 680 points). */
export const narrowViewport = (): boolean => widthAtMost(680);
