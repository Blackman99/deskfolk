/**
 * The desktop OS the webview runs on: WKWebView on macOS, WebView2 (Chromium) on Windows, or a
 * plain browser tab elsewhere. Shortcut labels, terminal keys, font stacks and the scrollbar rule
 * in `base.css` all key off this rather than sniffing `navigator` themselves.
 */
export type DesktopPlatform = "mac" | "windows" | "linux" | "other";

type NavigatorLike = {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
};

function classify(value: string): DesktopPlatform {
  const v = value.toLowerCase();
  // happy-dom's test navigator fakes `process.platform` into the UA ("X11; Darwin arm64",
  // "X11; Win32 x64", "X11; Linux x64"), so `darwin` is a real signal here, not only in the wild.
  if (v.includes("mac") || v.includes("darwin") || v.includes("iphone") || v.includes("ipad")) return "mac";
  if (v.includes("win")) return "windows";
  if (v.includes("linux")) return "linux";
  return "other";
}

/**
 * `userAgentData.platform` is Windows/Chromium's own answer, tried first; WebKit has no
 * User-Agent Client Hints, so `navigator.platform` (then `userAgent`) is the fallback everywhere
 * else. `nav` defaults to the real `navigator` and is SSR/test safe; pass a fake one to exercise
 * a platform there is no machine here to run on.
 */
export function desktopPlatform(
  nav: NavigatorLike | undefined = typeof navigator === "undefined" ? undefined : navigator,
): DesktopPlatform {
  if (!nav) return "other";
  if (nav.userAgentData?.platform) return classify(nav.userAgentData.platform);
  if (nav.platform) return classify(nav.platform);
  if (nav.userAgent) return classify(nav.userAgent);
  return "other";
}

/**
 * `<html data-platform="…">`, set once at startup so `base.css` can key a rule off
 * `:root[data-platform="windows"]`. A no-op outside the browser (SSR, tests that never mount
 * the root layout).
 */
export function applyPlatformAttribute(platform: DesktopPlatform = desktopPlatform()): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.platform = platform;
}
