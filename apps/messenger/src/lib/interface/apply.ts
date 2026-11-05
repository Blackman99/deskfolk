/**
 * Your interface profile on the page (ADR 0106): its tokens and stylesheet as one `<style>` placed
 * after every other sheet, and the root's `data-surface` and `data-motion` that a stylesheet of
 * yours and `base.css` key off. The text goes in as text, never markup. The last text applied is
 * kept on this machine so the next start paints it in its first frame, the way the theme is.
 */
import type { InterfaceProfile, InterfaceSurface } from "@real-bot/protocol";
import { HOSTED_MESSENGER } from "../remote/mode.ts";
import { forgetStored, readStored, writeStored } from "../storage.ts";
import { NARROW_QUERY } from "../workbench/surface.ts";

export const INTERFACE_STYLE_ID = "deskfolk-interface";
const CACHE_KEY = "real-bot-interface-css";

function declarations(tokens: Record<string, string>): string {
  return Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join("\n");
}

/**
 * Your own lines' bubble (`--you`) is written out in `tokens.css` rather than taken from the
 * accent: light it is the accent's own colour, dark a step deeper so white words read on it. A
 * profile that changes the accent in a look but not the bubble has the bubble follow, the same way:
 * light takes the accent and its text colour, dark the accent mixed 70% with black in oklab (the
 * default accent comes out as the default bubble, #276c78 for #1b6b7a). Set `--you` to keep it apart.
 */
const YOU_FROM_ACCENT: Record<"light" | "dark", Record<string, string>> = {
  light: { "--you": "var(--accent)", "--you-text": "var(--on-accent)" },
  dark: { "--you": "color-mix(in oklab, var(--accent) 70%, black)" },
};

export function followingAccent(tokens: Record<string, string>, look: "light" | "dark"): Record<string, string> {
  if (!("--accent" in tokens)) return tokens;
  const out = { ...tokens };
  for (const [name, value] of Object.entries(YOU_FROM_ACCENT[look])) {
    if (!(name in tokens)) out[name] = value;
  }
  return out;
}

/**
 * The profile's look as CSS. The light tokens sit on `:root`, which the dark defaults outrank on a
 * dark page, so a light-only change stays light; the dark ones match the dark defaults' selectors
 * and come later, so they win there.
 */
export function interfaceCss(profile: InterfaceProfile): string {
  if (!profile.enabled) return "";
  const parts: string[] = [];
  const light = declarations(followingAccent(profile.tokens.light, "light"));
  if (light) parts.push(`:root {\n${light}\n}`);
  const dark = declarations(followingAccent(profile.tokens.dark, "dark"));
  if (dark) parts.push(`:root[data-theme="dark"],\n[data-theme="dark"] {\n${dark}\n}`);
  if (profile.css.trim()) parts.push(profile.css);
  return parts.join("\n\n");
}

/** The style element the profile lives in, made last in `<head>` when missing. */
export function interfaceStyle(doc: Document = document): HTMLStyleElement {
  let style = doc.getElementById(INTERFACE_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = INTERFACE_STYLE_ID;
  }
  // Last, after the sheets a hot reload or a lazily loaded view added since.
  if (style.parentNode !== doc.head || doc.head.lastElementChild !== style) doc.head.appendChild(style);
  return style;
}

/** Puts the text in force (empty takes it away); `on` false keeps it but turns it off. */
export function applyInterfaceCss(css: string, on: boolean, doc: Document = document): HTMLStyleElement | null {
  if (!css) {
    doc.getElementById(INTERFACE_STYLE_ID)?.remove();
    return null;
  }
  const style = interfaceStyle(doc);
  if (style.textContent !== css) style.textContent = css;
  // `media` rather than `disabled`: it holds across WebKit's re-parse of a changed text.
  style.media = on ? "all" : "not all";
  return style;
}

export function cachedInterfaceCss(): string {
  return readStored(CACHE_KEY) ?? "";
}

export function cacheInterfaceCss(css: string): void {
  if (css) writeStored(CACHE_KEY, css);
  else forgetStored(CACHE_KEY);
}

/** Whether the page was opened asking for the app's own look (`?ui=default`): a way back no stylesheet can hide. */
export function defaultAskedInUrl(loc: { search: string } | undefined = typeof location === "undefined" ? undefined : location): boolean {
  if (!loc) return false;
  return new URLSearchParams(loc.search).get("ui") === "default";
}

/**
 * Before the first frame: the text the last start applied, unless the address asks for the app's
 * own look. The runtime replaces it with the daemon's once connected.
 */
export function applyCachedInterface(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc) return;
  const css = cachedInterfaceCss();
  if (css && !defaultAskedInUrl()) applyInterfaceCss(css, true, doc);
}

export function surfaceOf(narrow: boolean, hosted = HOSTED_MESSENGER): InterfaceSurface {
  if (narrow) return "phone";
  return hosted ? "tablet" : "desktop";
}

/** Keeps the root's `data-surface` current as the window is resized; returns the stop. */
export function trackSurface(doc: Document = document, onChange?: (surface: InterfaceSurface) => void): () => void {
  if (typeof matchMedia === "undefined") {
    doc.documentElement.dataset.surface = "desktop";
    return () => {};
  }
  const query = matchMedia(NARROW_QUERY);
  const update = () => {
    const surface = surfaceOf(query.matches);
    doc.documentElement.dataset.surface = surface;
    onChange?.(surface);
  };
  update();
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}

export function applyMotion(motion: "system" | "reduce" | undefined, doc: Document = document): void {
  if (motion === "reduce") doc.documentElement.dataset.motion = "reduce";
  else delete doc.documentElement.dataset.motion;
}
