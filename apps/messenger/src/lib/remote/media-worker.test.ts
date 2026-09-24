import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { MessageChannel } from "node:worker_threads";

function worker(options: { size?: number; status?: number; client?: boolean; owner?: boolean } = {}) {
  const size = options.size ?? 1_000_000;
  const asked: string[] = [];
  let cancels = 0;
  const context: Record<string, any> = {
    URL, Request, Response, Headers, ReadableStream, Uint8Array, ArrayBuffer, Number, MessageChannel, setTimeout, clearTimeout,
    self: {
      location: { origin: "https://media.test" },
      addEventListener: () => {},
      clients: { get: async () => options.client === false ? null : {
        postMessage: (_data: unknown, ports: MessagePort[]) => {
          const port = ports[0]!;
          port.onmessage = ({ data }) => {
            if (data.type === "cancel") { cancels++; port.close(); return; }
            asked.push(data.range);
            if (options.owner === false) { port.postMessage({ status: 410 }); return; }
            if (options.status) { port.postMessage({ status: options.status }); return; }
            const [a, b] = data.range.slice(6).split("-").map(Number);
            const end = Math.min(b, size - 1);
            const bytes = new Uint8Array(end - a + 1).fill(7).buffer;
            port.postMessage({ status: 206, contentType: "video/mp4", contentRange: `bytes ${a}-${end}/${size}`, bytes }, [bytes]);
          };
        },
      } },
    },
  };
  runInNewContext(readFileSync(new URL("../../../static/media-stream.js", import.meta.url), "utf8"), context);
  return {
    asked, cancels: () => cancels,
    request: (range?: string) => context.remoteMediaResponse({
      clientId: "owner", request: new Request("https://media.test/__remote_media/id", { headers: range ? { Range: range } : {} }),
    }) as Promise<Response>,
  };
}

test("media worker responds before the file arrives and pulls bounded ranges on demand", async () => {
  const w = worker();
  const response = await w.request("bytes=0-");
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe("bytes 0-999999/1000000");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(w.asked).toEqual(["bytes=0-0"]);
  const reader = response.body!.getReader();
  expect((await reader.read()).value?.length).toBe(262144);
  expect(w.asked).toEqual(["bytes=0-0", "bytes=0-262143"]);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(w.cancels()).toBe(1);
  expect(w.asked.length).toBe(2);
});

test("media worker seeks directly to an unbuffered range and supports suffix and full requests", async () => {
  for (const range of ["bytes=900000-900099", "bytes=-100", undefined]) {
    const w = worker();
    const response = await w.request(range);
    expect(response.status).toBe(range ? 206 : 200);
    const data = await response.arrayBuffer();
    expect(data.byteLength).toBe(range ? 100 : 1_000_000);
    expect(w.asked[1]).toBe(range?.startsWith("bytes=900") ? "bytes=900000-900099" : range ? "bytes=999900-999999" : "bytes=0-262143");
  }
});

test("media worker rejects malformed ranges, missing owners and failed hosts", async () => {
  for (const range of ["bytes=1000000-", "bytes=2-1", "bytes=0-1,8-9", "bytes=-"]) {
    const w = worker();
    const response = await w.request(range);
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */1000000");
    expect(w.asked).toEqual(["bytes=0-0"]);
  }
  expect((await worker({ client: false }).request()).status).toBe(410);
  expect((await worker({ owner: false }).request()).status).toBe(410);
  expect((await worker({ status: 503 }).request()).status).toBe(503);
});
