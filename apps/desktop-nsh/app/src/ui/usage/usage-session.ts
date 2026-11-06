/**
 * What the usage screens share on NSH. The messenger's `UsageFeed.watch` and `usage-widget` reach for
 * `document` and `window`, which a native window has none of, so the polling and the remembered
 * place of the widget are done here: the same cadence, the same `localStorage` key and shape.
 */
import { effect, untracked } from "nsh";
import { runtime } from "../../runtime";
import { localeTag } from "../../m/locale-tag.ts";
import { USAGE_POLL_MS } from "../../m/usage/usage.ts";
import { usageFeedOf, type UsageApi, type UsageFeed } from "../../m/usage/usage-feed.svelte.ts";
import { USAGE_WIDGET_DEFAULT, usageWidget, type UsageWidgetPlace } from "../../m/usage/usage-widget.svelte.ts";

const KEY = "real-bot-usage-widget";

/** Asks now, then every minute moves the clock on and, after the poll time, asks again. Returns the stop. */
export function watchUsage(feed: UsageFeed, api: UsageApi): () => void {
  let last = Date.now();
  untracked(() => void feed.load(api));
  const timer = setInterval(() => {
    feed.now = Date.now();
    if (feed.now - last < USAGE_POLL_MS) return;
    last = feed.now;
    void feed.load(api);
  }, 60_000);
  return () => clearInterval(timer);
}

/** The window's one feed, its client while connected, its language tag; asking starts with the caller. */
export function useUsageFeed() {
  const feed = usageFeedOf(runtime);
  const client = () => (runtime.connection === "connected" ? (runtime.client as unknown as UsageApi | null) : null);
  const locale = () => localeTag(runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  effect(() => {
    const api = client();
    if (!api) return;
    return watchUsage(feed, api);
  });
  return { feed, client, locale };
}

function share(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

/** What `localStorage` kept of the widget's place and whether it is hidden (the messenger's `readUsageWidget`). */
export function readStoredUsageWidget(): { place: UsageWidgetPlace; hidden: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { place?: Record<string, unknown>; hidden?: unknown } | null;
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

let restored = false;

/** Puts back where the widget was left (once), and keeps writing it as it moves or hides. */
export function persistUsageWidget(): void {
  if (!restored) {
    restored = true;
    const stored = readStoredUsageWidget();
    usageWidget.place = stored.place;
    usageWidget.hidden = stored.hidden;
  }
  effect(() => {
    const place = usageWidget.place;
    const hidden = usageWidget.hidden;
    const plain = place.dock === null ? { dock: null, left: place.left, top: place.top } : { dock: place.dock, top: place.top };
    try {
      localStorage.setItem(KEY, JSON.stringify({ place: plain, hidden }));
    } catch {
      // Blocked storage: the widget still works, only it forgets its place.
    }
  });
}
