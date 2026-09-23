importScripts("/media-stream.js");

const CACHE = "real-bot-immutable-v1";

// Cache-first entries are stamped with when they were last served, so unused ones can be pruned
// without ever evicting something the phone is actively relying on. The stamp lives in a response
// header rather than a second store: whatever puts a response is the only thing that needs to
// write it, and a cache-first read already has the response in hand to read it back from.
const USED_HEADER = "x-rb-used";
// A cached response gets a fresh stamp when its existing one is at least this old, so a file
// still being fetched daily is not rewritten on every single hit.
const RESTAMP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// Anything not served in this long is dead weight; the sweep below removes it.
const EVICT_UNUSED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// The sweep walks every cached entry, so it runs at most this often.
const PRUNE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Beyond either cap, the least-recently-used entries go first.
const MAX_ENTRIES = 500;
const MAX_BYTES = 120 * 1024 * 1024;
// A synthetic key in the same cache, holding only the last-swept timestamp. Its fake origin
// never matches `isImmutable()`, so the fetch handler never serves it and the sweep's own
// accounting below never counts it as a real entry.
const PRUNE_STAMP_KEY = "https://real-bot.invalid/sw-prune-stamp";

function isImmutable(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== self.location.origin) return false;
    return parsed.pathname.startsWith("/_app/immutable/");
  } catch {
    return false;
  }
}

/** A copy of `response` carrying a fresh `USED_HEADER`, for re-putting into the cache. */
async function stampedClone(response, usedAt) {
  const headers = new Headers(response.headers);
  headers.set(USED_HEADER, String(usedAt));
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function usedAtOf(response) {
  const raw = response.headers.get(USED_HEADER);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function byteSizeOf(response) {
  const raw = response.headers.get("content-length");
  const n = raw ? Number(raw) : NaN;
  // A coarse fallback so the byte cap still means something without Content-Length; better an
  // estimate than treating an unknown size as zero.
  return Number.isFinite(n) ? n : 50_000;
}

async function readPruneStamp(cache) {
  const marker = await cache.match(PRUNE_STAMP_KEY);
  if (!marker) return 0;
  const n = Number(await marker.text());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Evicts anything unused for `EVICT_UNUSED_AFTER_MS`, then trims the least-recently-used
 * remaining entries until the cache is back under the entry/byte caps. Throttled to
 * `PRUNE_MIN_INTERVAL_MS` via a timestamp kept in the same cache, so a burst of fetches only pays
 * for the full `keys()` walk once a day.
 */
async function pruneCache() {
  const cache = await caches.open(CACHE);
  const now = Date.now();
  const lastPrune = await readPruneStamp(cache);
  if (now - lastPrune < PRUNE_MIN_INTERVAL_MS) return;
  // Claim the slot before doing the work: a slow sweep must not let a second, concurrent fetch
  // start another one.
  await cache.put(PRUNE_STAMP_KEY, new Response(String(now)));

  const requests = (await cache.keys()).filter((request) => isImmutable(request.url));
  const entries = [];
  for (const request of requests) {
    const response = await cache.match(request);
    if (!response) continue;
    const usedAt = usedAtOf(response);
    if (usedAt === null) {
      // Cached by an older version of this file, before stamping existed. Start its clock now
      // rather than guessing, so it gets a full unused-window before it is ever a candidate.
      await cache.put(request, await stampedClone(response, now));
      entries.push({ request, usedAt: now, size: byteSizeOf(response) });
      continue;
    }
    if (now - usedAt > EVICT_UNUSED_AFTER_MS) {
      await cache.delete(request);
      continue;
    }
    entries.push({ request, usedAt, size: byteSizeOf(response) });
  }

  entries.sort((a, b) => a.usedAt - b.usedAt);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let count = entries.length;
  for (const entry of entries) {
    if (count <= MAX_ENTRIES && totalBytes <= MAX_BYTES) break;
    await cache.delete(entry.request);
    totalBytes -= entry.size;
    count -= 1;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()).then(() => pruneCache().catch(() => {})),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.mode === "navigate" || !isImmutable(request.url)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      // The page gets its response at once; stamping and storing happen behind it. Awaiting them
      // first held a 1.4 MB script back until every byte had been read into a second copy.
      const keep = (response) =>
        event.waitUntil(stampedClone(response.clone(), Date.now()).then((stamped) => cache.put(request, stamped)).catch(() => {}));
      if (cached) {
        const usedAt = usedAtOf(cached);
        if (usedAt === null || Date.now() - usedAt > RESTAMP_AFTER_MS) keep(cached);
        event.waitUntil(pruneCache().catch(() => {}));
        return cached;
      }
      const response = await fetch(request);
      if (response.ok && (response.type === "basic" || response.type === "default")) keep(response);
      event.waitUntil(pruneCache().catch(() => {}));
      return response;
    }),
  );
});

self.addEventListener("push", (event) => {
  let pending = false;
  try {
    const data = event.data ? event.data.json() : null;
    pending = !!data && typeof data === "object" && data.t === "pending" && Object.keys(data).join() === "t";
  } catch {
    pending = false;
  }
  if (!pending) return;
  if (self.navigator && "setAppBadge" in self.navigator) {
    self.navigator.setAppBadge().catch(() => {});
  }
  event.waitUntil(
    self.registration.showNotification("Real Bot 有待处理事项", {
      body: "Real Bot has pending items",
      icon: "/icon-192.png",
      badge: "/notification-badge.png",
      tag: "real-bot-pending",
      data: { t: "pending" },
      renotify: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const origin = self.location.origin;
      const scope = self.registration.scope;
      const inScope = clients.filter((c) => {
        try {
          const u = new URL(c.url);
          return u.origin === origin && c.url.startsWith(scope);
        } catch {
          return false;
        }
      });
      const target = inScope.find((c) => c.focused) || inScope[0];
      if (target) {
        await target.focus();
        target.postMessage({ type: "inbox" });
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow("/");
    }),
  );
});
