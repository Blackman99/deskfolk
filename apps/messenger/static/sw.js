const CACHE = "real-bot-immutable-v1";

function isImmutable(url) {
  try {
    return new URL(url).pathname.startsWith("/_app/immutable/");
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
      if (response.ok) await cache.put(request, response.clone());
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
  event.waitUntil(
    self.registration.showNotification("Real Bot 有待处理事项", {
      body: "Real Bot has pending items",
      tag: "pending",
      data: { t: "pending" },
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        await client.focus();
        client.postMessage({ type: "inbox" });
        return;
      }
      await self.clients.openWindow("/");
    }),
  );
});
