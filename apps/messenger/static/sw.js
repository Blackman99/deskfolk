const CACHE = "real-bot-immutable-v1";

function isImmutable(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== self.location.origin) return false;
    return parsed.pathname.startsWith("/_app/immutable/");
  } catch {
    return false;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.mode === "navigate" || !isImmutable(request.url)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && (response.type === "basic" || response.type === "default")) {
        await cache.put(request, response.clone());
      }
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
