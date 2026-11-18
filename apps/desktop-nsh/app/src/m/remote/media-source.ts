export type MediaSourceHandle = { url: string; dispose: () => void };
export type MediaRangeReply = {
  status: number;
  contentType?: string;
  contentRange?: string;
  bytes?: ArrayBuffer;
};
export type MediaRangeReader = (range: string, signal: AbortSignal) => Promise<MediaRangeReply>;

type Source = { read: MediaRangeReader; ports: Map<MessagePort, AbortController>; onError?: () => void };
const sources = new Map<string, Source>();

function onMediaRequest(event: MessageEvent): void {
  if (event.source !== navigator.serviceWorker.controller || event.data?.type !== "remote-media") return;
  const port = event.ports[0];
  if (!port) return;
  const source = sources.get(event.data.id);
  if (!source) {
    port.onmessage = () => { port.postMessage({ status: 410 }); port.close(); };
    return;
  }
  const abort = new AbortController();
  source.ports.set(port, abort);
  let reading = false;
  port.onmessage = async ({ data }) => {
    if (data?.type === "cancel") {
      abort.abort();
      source.ports.delete(port);
      port.close();
      return;
    }
    if (data?.type !== "read" || reading || typeof data.range !== "string") return;
    reading = true;
    try {
      const reply = await source.read(data.range, abort.signal);
      if (!abort.signal.aborted) {
        port.postMessage(reply, reply.bytes ? [reply.bytes] : []);
        if (reply.status !== 206) source.onError?.();
      }
    } catch {
      if (!abort.signal.aborted) {
        port.postMessage({ status: 503 });
        source.onError?.();
      }
    } finally {
      reading = false;
    }
  };
}

async function mediaWorker(signal?: AbortSignal): Promise<ServiceWorker | null> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker || !globalThis.isSecureContext) return null;
  const container = navigator.serviceWorker;
  // A fresh hosted visit must become controlled without reloading the conversation.
  return new Promise((resolve) => {
    let probed: ServiceWorker | null = null;
    let settled = false;
    let port: MessagePort | null = null;
    const finish = (worker: ServiceWorker | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      container.removeEventListener("controllerchange", probe);
      signal?.removeEventListener("abort", cancelled);
      port?.close();
      resolve(worker);
    };
    const cancelled = () => finish(null);
    const probe = () => {
      const worker = container.controller;
      if (!worker || worker === probed || settled) return;
      probed = worker;
      port?.close();
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = ({ data }) => finish(data?.version === 1 ? worker : null);
      worker.postMessage({ type: "remote-media-probe" }, [channel.port2]);
    };
    const timer = setTimeout(() => finish(null), 5000);
    container.addEventListener("controllerchange", probe);
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) { finish(null); return; }
    void container.register("/sw.js").then(probe, () => finish(null));
    probe();
  });
}

/** Same-origin media URL; only its owning page can resolve it to encrypted file reads. */
export async function createRemoteMediaSource(read: MediaRangeReader, signal?: AbortSignal, onError?: () => void): Promise<MediaSourceHandle | null> {
  if (!await mediaWorker(signal)) return null;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const meta = await read("bytes=0-0", signal ?? new AbortController().signal);
  // Older hosts reject the new query; they keep the existing whole-file preview.
  if (meta.status === 422 || meta.status === 200) return null;
  if (meta.status !== 206) throw new Error("media unavailable");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const id = crypto.randomUUID();
  const source: Source = {
    read: (range, signal) => range === "bytes=0-0" ? Promise.resolve({ ...meta, bytes: meta.bytes?.slice(0) }) : read(range, signal),
    ports: new Map(),
    onError,
  };
  if (!sources.size) navigator.serviceWorker.addEventListener("message", onMediaRequest);
  sources.set(id, source);
  const dispose = () => {
    sources.delete(id);
    for (const [port, abort] of source.ports) {
      abort.abort();
      port.postMessage({ status: 410 });
      port.close();
    }
    source.ports.clear();
    signal?.removeEventListener("abort", dispose);
    if (!sources.size) navigator.serviceWorker.removeEventListener("message", onMediaRequest);
  };
  signal?.addEventListener("abort", dispose, { once: true });
  return { url: `/__remote_media/${id}`, dispose };
}
