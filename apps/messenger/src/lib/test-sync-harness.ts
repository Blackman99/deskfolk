import { expect } from "bun:test";
import type { SyncFrame } from "@real-bot/protocol";

type SyncCursor = { event_instance_id: string; watermark_seq: number };

/**
 * A WebSocket that opens at once and answers the runtime's hello with `ready` at `cursor`. The
 * class keeps the latest socket in `Socket.current`, so a test can push frames or close it.
 * `checkProtocol` also asserts that the hello names the sync-v1 protocol.
 */
export function fakeSyncSocket(cursor: SyncCursor, options: { checkProtocol?: boolean } = {}) {
  return class Socket extends EventTarget {
    static current: Socket;
    onopen = null; onmessage = null; onclose = null; onerror = null;
    constructor(_url: string) {
      super(); Socket.current = this;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(raw: string) {
      if (options.checkProtocol) expect(JSON.parse(raw).protocol).toBe("sync-v1");
      queueMicrotask(() => this.frame({ type: "ready", ...cursor }));
    }
    frame(frame: SyncFrame) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
    close() { this.dispatchEvent(new Event("close")); }
  };
}

/**
 * The daemon as the browser meets it: discovery at `/__local-api`, then health and the snapshot.
 * `handle` sees every other request first-come and returns a body, or undefined to fall through
 * to an empty page of items. `onRequest` sees every request before any of that.
 */
export function localApiFetch(options: {
  snapshot: () => unknown | Promise<unknown>;
  port?: number;
  token?: string;
  handle?: (path: string, init?: RequestInit) => unknown | Promise<unknown>;
  onRequest?: (path: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    options.onRequest?.(path, init);
    if (path.endsWith("/__local-api")) return Response.json({ port: options.port ?? 17891, token: options.token ?? "fixture" });
    if (path.endsWith("/v1/health")) return Response.json({ ok: true, name: "real-bot" });
    if (path.endsWith("/v1/snapshot")) return Response.json(await options.snapshot());
    const body = await options.handle?.(path, init);
    return Response.json(body === undefined ? { items: [] } : body);
  }) as typeof fetch;
}
