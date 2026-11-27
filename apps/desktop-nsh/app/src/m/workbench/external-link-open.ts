/**
 * How external web links (`http://`, `https://`) in conversation output open on the desktop:
 * in-app WebView by default, or the system default browser. Kept in this machine's storage (like
 * open placements) and synced with the interface profile when the daemon supports it.
 */
import { forgetStored, readStored, writeStored } from "../storage.ts";

export type ExternalLinkOpen = "webview" | "browser";

export const EXTERNAL_LINK_OPEN_MODES: readonly ExternalLinkOpen[] = ["webview", "browser"];

export const EXTERNAL_LINK_OPEN_DEFAULT: ExternalLinkOpen = "webview";

const STORAGE_KEY = "real-bot-external-link-open";

export function isExternalLinkOpen(value: unknown): value is ExternalLinkOpen {
  return value === "webview" || value === "browser";
}

export function loadExternalLinkOpen(): ExternalLinkOpen {
  const raw = readStored(STORAGE_KEY);
  return isExternalLinkOpen(raw) ? raw : EXTERNAL_LINK_OPEN_DEFAULT;
}

/** Only what differs from the default is kept, so a fresh install follows the default. */
export function saveExternalLinkOpen(mode: ExternalLinkOpen): void {
  if (mode === EXTERNAL_LINK_OPEN_DEFAULT) forgetStored(STORAGE_KEY);
  else writeStored(STORAGE_KEY, mode);
}

export function forgetExternalLinkOpen(): void {
  forgetStored(STORAGE_KEY);
}

/** Validates an http(s) URL for the in-app WebView and external opener; null for anything else. */
export function normalizeWebUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Turns what a person typed in the WebView address bar into an http(s) URL: accepts full http(s)
 * URLs as-is, and prepends `https://` to bare hosts like `example.com/docs`. Refuses non-http
 * schemes (`javascript:`, `file:`, `data:`).
 */
export function resolveWebAddressInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return normalizeWebUrl(trimmed);
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:\/|\?|#|$))/i.test(trimmed)) return null;
  if (!trimmed.includes(".") && !/^localhost(?::\d+)?(?:\/|\?|#|$)/i.test(trimmed)) return null;
  return normalizeWebUrl(`https://${trimmed}`);
}

/** Compact label for a web tab before the page reports its `<title>` (the host without `www.`). */
export function webUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host.replace(/^www\./i, "") || url;
  } catch {
    return url;
  }
}

/**
 * Standard desktop Safari UA for WebKit-backed web views (macOS WKWebView and Linux WebKitGTK).
 * Bare WKWebView omits `Version/... Safari/605.1.15`, causing sites like Google Search to serve
 * downgraded legacy HTML. Windows WebView2 already sends an up-to-date Chromium/Edge UA.
 */
export function webViewUserAgent(os: string): string | undefined {
  if (os === "macos") {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
  }
  if (os === "linux") {
    return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
  }
  return undefined;
}
