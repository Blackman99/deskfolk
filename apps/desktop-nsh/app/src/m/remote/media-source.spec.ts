import { afterEach, expect, test } from "bun:test";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { createRemoteMediaSource, type MediaRangeReply } from "./media-source.ts";

const restores: Array<() => void> = [];
afterEach(() => { while (restores.length) restores.pop()!(); });
function replace(target: object, key: string, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  restores.push(() => old ? Object.defineProperty(target, key, old) : Reflect.deleteProperty(target, key));
}
function bridge() {
  const container = new EventTarget() as ServiceWorkerContainer;
  const worker = { postMessage: (_data: unknown, ports: MessagePort[]) => { ports[0]!.postMessage({ version: 1 }); ports[0]!.close(); } } as unknown as ServiceWorker;
  Object.defineProperty(container, "controller", { value: worker });
  Object.defineProperty(container, "register", { value: async () => ({ active: worker }) });
  replace(navigator, "serviceWorker", container);
  replace(globalThis, "isSecureContext", true);
  replace(globalThis, "MessageChannel", NodeMessageChannel);
  return { request: (id: string, source: unknown = worker) => {
    const channel = new NodeMessageChannel();
    container.dispatchEvent(new MessageEvent("message", { data: { type: "remote-media", id }, source: source as Window, ports: [channel.port2 as unknown as MessagePort] }));
    return channel.port1;
  } };
}
const meta = (): MediaRangeReply => ({ status: 206, contentType: "video/mp4", contentRange: "bytes 0-0/1000000", bytes: new Uint8Array([1]).buffer });

test("media source routes only its own URL, uses independent metadata bytes and cancels active reads", async () => {
  const b = bridge();
  const reads: string[] = [];
  let readingSignal: AbortSignal | undefined;
  const handle = await createRemoteMediaSource(async (range, signal) => {
    reads.push(range);
    if (range === "bytes=0-0") return meta();
    readingSignal = signal;
    return new Promise(() => {});
  });
  expect(handle).not.toBeNull();
  const id = handle!.url.split("/").pop()!;
  const port = b.request(id);
  const reply = () => new Promise<MediaRangeReply>(resolve => port.once("message", resolve));
  for (let i = 0; i < 2; i++) {
    const answer = reply();
    port.postMessage({ type: "read", range: "bytes=0-0" });
    expect((await answer).bytes?.byteLength).toBe(1);
  }
  expect(reads).toEqual(["bytes=0-0"]);
  port.postMessage({ type: "read", range: "bytes=500000-762143" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(readingSignal?.aborted).toBe(false);
  handle!.dispose();
  expect(readingSignal?.aborted).toBe(true);
  port.close();
});

test("media source returns to the existing loader for old hosts and rejects missing files", async () => {
  bridge();
  expect(await createRemoteMediaSource(async () => ({ status: 422 }))).toBeNull();
  expect(await createRemoteMediaSource(async () => ({ status: 200 }))).toBeNull();
  await expect(createRemoteMediaSource(async () => ({ status: 404 }))).rejects.toThrow("media unavailable");
});

test("media source cancellation during setup never publishes a URL", async () => {
  bridge();
  const abort = new AbortController();
  await expect(createRemoteMediaSource(async () => { abort.abort(); return meta(); }, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("a failed later media range notifies the preview immediately", async () => {
  const b = bridge();
  let errors = 0;
  const handle = await createRemoteMediaSource(async range => range === "bytes=0-0" ? meta() : { status: 503 }, undefined, () => { errors++; });
  const port = b.request(handle!.url.split("/").pop()!);
  const response = new Promise<MediaRangeReply>(resolve => port.once("message", resolve));
  port.postMessage({ type: "read", range: "bytes=500000-762143" });
  expect((await response).status).toBe(503);
  expect(errors).toBe(1);
  handle!.dispose(); port.close();
});
