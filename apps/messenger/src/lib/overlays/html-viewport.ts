/**
 * The device an HTML file is previewed on. The page runs at that device's CSS viewport and the
 * device, bezel and all, is shrunk to fit the pane — never enlarged past its real size — so a
 * layout meant for a phone is seen at a phone's width however wide the pane is.
 *
 * On a phone or tablet the page is laid out the way a mobile browser lays it out: at the width its
 * `<meta name="viewport">` asks for, or at 980 pixels when it asks for none (a page made for a
 * desktop), then zoomed to the screen's width. A small script in front of the page tells the pane
 * how wide such a page's content really is, so a 1080-pixel poster shows whole the way a phone
 * shows it, and gives the page its scrollbar back when it locked scrolling on a page taller than
 * the screen.
 */
import { injectAtHeadStart, isChannel, nonceAttr } from "../annotations/html-picker.ts";

export type ViewportDevice = "desktop" | "tablet" | "phone";

export const VIEWPORT_DEVICES: readonly ViewportDevice[] = ["desktop", "tablet", "phone"];

/** CSS pixels of the page's viewport: a 13-inch laptop, an iPad Air held upright, an iPhone 14. */
export const VIEWPORT_SIZE: Readonly<Record<ViewportDevice, { width: number; height: number }>> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
};

type Chrome = {
  /** Bezel around the screen, each as a share of the screen's width. */
  side: number;
  top: number;
  bottom: number;
  /** Outer corner radius, as a share of the screen's width. */
  radius: number;
  /** A laptop's base: how far it reaches past the lid on each side, and how tall it is. */
  overhang: number;
  base: number;
};

/** Everything around the screen scales with it, so a small pane shows a small device, not a thick frame. */
const CHROME: Readonly<Record<ViewportDevice, Chrome>> = {
  desktop: { side: 0.016, top: 0.028, bottom: 0.016, radius: 0.018, overhang: 0.07, base: 0.022 },
  tablet: { side: 0.045, top: 0.045, bottom: 0.045, radius: 0.075, overhang: 0, base: 0 },
  phone: { side: 0.035, top: 0.035, bottom: 0.035, radius: 0.15, overhang: 0, base: 0 },
};

/** Below this the device is a speck; the pane is collapsed or not laid out yet. */
const MIN_SCALE = 0.1;

export type ViewportLayout = {
  device: ViewportDevice;
  /** The device's viewport, in CSS pixels. */
  width: number;
  height: number;
  /** On-screen pixels per CSS pixel of the device; at most 1 in a pane. */
  scale: number;
  /**
   * The page as laid out: its layout viewport in its own CSS pixels (wider than the device's when a
   * mobile browser zooms out on it) and the scale the iframe is drawn at to fill the screen.
   */
  page: { width: number; height: number; scale: number };
  /** Everything below is in on-screen pixels. */
  screen: { width: number; height: number };
  bezel: { side: number; top: number; bottom: number };
  radius: number;
  overhang: number;
  base: number;
  /** The whole device, chrome included. */
  frame: { width: number; height: number };
};

/** How far past its real size a device may be blown up once the preview fills the window. */
export const ENLARGED_MAX_SCALE = 4;

/**
 * The largest size, up to `maxScale` times the device's real one, at which the whole device fits
 * `avail`, with the page laid out `pageWidth` wide (the device's own width when left out) and
 * zoomed to its screen. In a pane a device is never drawn larger than it is; full screen may.
 */
export function fitViewport(
  device: ViewportDevice,
  avail: { width: number; height: number },
  pageWidth?: number,
  maxScale = 1,
): ViewportLayout {
  const { width, height } = VIEWPORT_SIZE[device];
  const chrome = CHROME[device];
  const across = width * (1 + 2 * chrome.side + 2 * chrome.overhang);
  const down = height + width * (chrome.top + chrome.bottom + chrome.base);
  const fit = Math.min(maxScale, Math.max(0, avail.width) / across, Math.max(0, avail.height) / down);
  const scale = Math.max(MIN_SCALE, fit);
  const screenWidth = width * scale;
  const px = (share: number) => share * screenWidth;
  const bezel = { side: px(chrome.side), top: px(chrome.top), bottom: px(chrome.bottom) };
  const laidOut = pageWidth && Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : width;
  const zoom = width / laidOut;
  return {
    device,
    width,
    height,
    scale,
    page: { width: laidOut, height: height / zoom, scale: scale * zoom },
    screen: { width: screenWidth, height: height * scale },
    bezel,
    radius: px(chrome.radius),
    overhang: px(chrome.overhang),
    base: px(chrome.base),
    frame: {
      width: screenWidth + 2 * bezel.side + 2 * px(chrome.overhang),
      height: height * scale + bezel.top + bezel.bottom + px(chrome.base),
    },
  };
}

/** What a phone or tablet browser lays out a page at when the page declares no viewport. */
export const LEGACY_LAYOUT_WIDTH = 980;
/** Browsers take a declared viewport width between these. */
const DECLARED_WIDTH_MIN = 200;
const DECLARED_WIDTH_MAX = 10000;
/** The widest a page's content may make the layout when the browser zooms out to show all of it. */
export const CONTENT_WIDTH_MAX = 4000;

export type ViewportMeta = {
  /** `device-width`, a number of CSS pixels, or not said. */
  width: "device-width" | number | null;
  initialScale: number | null;
};

/** The page's `<meta name="viewport">`, read the way a browser reads its content. Null when it has none. */
export function viewportMeta(source: string): ViewportMeta | null {
  const html = source.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']?viewport["'\s/>]/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const meta: ViewportMeta = { width: null, initialScale: null };
    for (const part of (content?.[1] ?? content?.[2] ?? content?.[3] ?? "").split(/[,;]/)) {
      const [key, value] = part.split("=").map((side) => side.trim().toLowerCase());
      if (!key || value === undefined) continue;
      const n = Number(value);
      if (key === "width") meta.width = value === "device-width" ? "device-width" : Number.isFinite(n) && n > 0 ? n : null;
      if (key === "initial-scale" && Number.isFinite(n) && n > 0) meta.initialScale = n;
    }
    return meta;
  }
  return null;
}

/**
 * How wide the page is laid out. A desktop browser ignores the viewport tag and uses its window; a
 * phone or tablet browser uses what the tag asks for, 980 pixels without one, and — for a page
 * without one — widens that to the page's content (`contentWidth`, once the page reported it), so
 * a page wider than 980 is zoomed out whole rather than cut off.
 */
export function pageLayoutWidth(device: ViewportDevice, meta: ViewportMeta | null, contentWidth: number | null = null): number {
  const own = VIEWPORT_SIZE[device].width;
  if (device === "desktop") return own;
  if (!meta) {
    const content = contentWidth && Number.isFinite(contentWidth) ? Math.ceil(contentWidth) : 0;
    return Math.min(CONTENT_WIDTH_MAX, Math.max(LEGACY_LAYOUT_WIDTH, content));
  }
  if (meta.width === "device-width") return own;
  if (typeof meta.width === "number") {
    return Math.min(DECLARED_WIDTH_MAX, Math.max(DECLARED_WIDTH_MIN, Math.round(meta.width)));
  }
  if (meta.initialScale) return Math.round(own / meta.initialScale);
  return LEGACY_LAYOUT_WIDTH;
}

/**
 * The script (and, on a phone or tablet, the style) put in front of the page. Once the page has
 * loaded it reports how wide its content is, and whenever scrolling is locked (`overflow: hidden`
 * on the root or body) on a page taller than the screen, it unlocks the vertical axis only, so a
 * page that hides sideways overflow keeps hiding it. Touch devices have no scrollbars taking room.
 * An Escape the page left alone is passed on, since keys pressed in the page never reach the pane
 * that is filling the window.
 *
 * Where no script of the page may run — the hosted remote build allows only the scripts it hashed,
 * and the blob page inherits that — the helper cannot unlock anything, so a rule in front of it
 * unlocks the vertical axis of every page. The helper takes that rule out first thing, so wherever
 * it runs, it alone decides.
 */
export function viewportHelperMarkup(opts: { channel: string; touch: boolean; nonce?: string | null }): string {
  if (!isChannel(opts.channel)) throw new Error("viewport channel must be 32 hex characters");
  const attr = nonceAttr(opts.nonce);
  const style = opts.touch
    ? `<style${attr}>*{scrollbar-width:none}::-webkit-scrollbar{width:0;height:0;background:transparent}</style>`
    : "";
  const fallback = `<style${attr} data-rb-scroll-fallback="${opts.channel}">html{overflow-y:auto!important}</style>`;
  // `__name` is a no-op stand-in for the helper some bundlers insert when they keep function names.
  const run = `(function(){"use strict";var __name=function(f){return f};(${viewportHelper.toString()})(${JSON.stringify(opts.channel)});})();`;
  return `${style}${fallback}<script${attr}>${run}</script>`;
}

/** Runs inside the page, by its own source: nothing outside it is in scope there. */
function viewportHelper(channel: string): void {
  const fallback = document.querySelector(`style[data-rb-scroll-fallback="${channel}"]`);
  if (fallback) fallback.remove();
  const root = document.documentElement;
  const locked = (value: string) => value === "hidden" || value === "clip";
  const unlock = () => {
    const body = document.body;
    if (!root || !body) return;
    const own = getComputedStyle(root);
    // The root's overflow is the viewport's unless it is visible, in which case the body's is.
    const from = own.overflowX !== "visible" || own.overflowY !== "visible" ? own : getComputedStyle(body);
    if (!locked(from.overflowY) || root.scrollHeight <= window.innerHeight + 1) return;
    root.style.setProperty("overflow-y", "auto", "important");
    root.style.setProperty("overflow-x", locked(from.overflowX) ? "hidden" : "auto", "important");
  };
  window.addEventListener("load", () => {
    unlock();
    try {
      window.parent.postMessage({ channel, type: "content", width: Math.ceil(root.scrollWidth) }, "*");
    } catch {
      // No parent to tell.
    }
  });
  window.addEventListener("resize", unlock);
  // Bubbling, on the window: the page's own handlers (a dialog of its own, the picker) go first.
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.defaultPrevented || ev.isComposing) return;
    try {
      window.parent.postMessage({ channel, type: "escape" }, "*");
    } catch {
      // No parent to tell.
    }
  });
}

export type ViewportMessage = { type: "content"; width: number } | { type: "escape" };

/**
 * What the helper said, or null. Only a message from `expectedSource` (the iframe's window)
 * carrying this build's channel, in exactly one of the helper's shapes, counts.
 */
export function viewportMessage(
  event: { source: unknown; data: unknown },
  expectedSource: unknown,
  channel: string | null,
): ViewportMessage | null {
  if (!isChannel(channel) || expectedSource == null || event.source !== expectedSource) return null;
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.channel !== channel) return null;
  const keys = Object.keys(record).length;
  if (record.type === "escape") return keys === 2 ? { type: "escape" } : null;
  if (record.type !== "content" || keys !== 3) return null;
  const width = record.width;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return null;
  return { type: "content", width: Math.min(width, CONTENT_WIDTH_MAX) };
}

/** A page's own markup, with the helper for `device` in front. */
export function withViewportHelper(html: string, opts: { channel: string; device: ViewportDevice; nonce?: string | null }): string {
  return injectAtHeadStart(html, viewportHelperMarkup({ channel: opts.channel, touch: opts.device !== "desktop", nonce: opts.nonce }));
}

const STORAGE_KEY = "real-bot-html-viewport";
const DEFAULT_DEVICE: ViewportDevice = "desktop";

function isDevice(value: unknown): value is ViewportDevice {
  return typeof value === "string" && (VIEWPORT_DEVICES as readonly string[]).includes(value);
}

/** The device this viewer last picked; a laptop until they pick one. */
export function loadViewportDevice(): ViewportDevice {
  if (typeof window === "undefined") return DEFAULT_DEVICE;
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    return isDevice(raw) ? raw : DEFAULT_DEVICE;
  } catch {
    return DEFAULT_DEVICE;
  }
}

export function saveViewportDevice(device: ViewportDevice): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(STORAGE_KEY, device);
  } catch {
    // Private windows and blocked storage just forget the choice.
  }
}
