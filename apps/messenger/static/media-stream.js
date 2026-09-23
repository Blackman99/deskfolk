// Media bytes live only in the response stream. The owning page supplies them over Noise.
const MEDIA_PATH = "/__remote_media/";
const MEDIA_CHUNK = 256 * 1024;

function mediaBounds(range, size) {
  if (!range) return size > 0 ? { start: 0, end: size - 1 } : null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end))) return null;
  if (start === null) return end > 0 ? { start: Math.max(0, size - end), end: size - 1 } : null;
  if (start >= size || (end !== null && end < start)) return null;
  return { start, end: Math.min(end ?? size - 1, size - 1) };
}

async function remoteMediaResponse(event) {
  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  if (!client) return new Response(null, { status: 410 });
  const id = new URL(event.request.url).pathname.slice(MEDIA_PATH.length);
  const channel = new MessageChannel();
  const port = channel.port1;
  let pending = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    port.postMessage({ type: "cancel" });
    port.close();
    pending?.reject(new Error("media closed"));
    pending = null;
    event.request.signal.removeEventListener("abort", close);
  };
  const read = (range) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("media closed"));
    const timer = setTimeout(() => { close(); reject(new Error("media timeout")); }, 35_000);
    pending = {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    };
    port.postMessage({ type: "read", range });
  });
  port.onmessage = (event) => {
    const next = pending;
    pending = null;
    next?.resolve(event.data);
  };
  client.postMessage({ type: "remote-media", id }, [channel.port2]);
  event.request.signal.addEventListener("abort", close, { once: true });
  if (event.request.signal.aborted) close();
  try {
    const meta = await read("bytes=0-0");
    if (meta.status !== 206) {
      close();
      return new Response(null, { status: meta.status >= 400 && meta.status <= 599 ? meta.status : 502 });
    }
    const match = /^bytes 0-0\/(\d+)$/.exec(meta.contentRange ?? "");
    const size = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("invalid media size");
    const range = event.request.headers.get("Range");
    const bounds = mediaBounds(range, size);
    if (!bounds) {
      close();
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Cache-Control": "no-store" } });
    }
    let offset = bounds.start;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const end = Math.min(bounds.end, offset + MEDIA_CHUNK - 1);
          const chunk = await read(`bytes=${offset}-${end}`);
          if (chunk.status !== 206 || chunk.contentRange !== `bytes ${offset}-${end}/${size}` ||
              !(chunk.bytes instanceof ArrayBuffer) || chunk.bytes.byteLength !== end - offset + 1) {
            throw new Error("invalid media chunk");
          }
          controller.enqueue(new Uint8Array(chunk.bytes));
          offset = end + 1;
          if (offset > bounds.end) { controller.close(); close(); }
        } catch (error) { controller.error(error); close(); }
      },
      cancel: close,
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": meta.contentType || "application/octet-stream",
        "Content-Length": String(bounds.end - bounds.start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        ...(range ? { "Content-Range": `bytes ${bounds.start}-${bounds.end}/${size}` } : {}),
      },
    });
  } catch {
    close();
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "remote-media-probe") event.ports[0]?.postMessage({ version: 1 });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(MEDIA_PATH)) return;
  if (event.request.method !== "GET") {
    event.respondWith(new Response(null, { status: 405 }));
    return;
  }
  event.respondWith(remoteMediaResponse(event));
});
