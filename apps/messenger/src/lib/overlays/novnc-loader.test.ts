import { afterEach, expect, test } from "bun:test";
import { loadNoVnc } from "./novnc-loader.ts";

const scope = globalThis as Record<string, unknown>;
afterEach(() => { delete scope.VideoDecoder; });

test("the H.264 probe is skipped: VideoDecoder is hidden while the module loads, and back afterwards", async () => {
  class FakeDecoder {}
  Object.defineProperty(globalThis, "VideoDecoder", { value: FakeDecoder, configurable: true, writable: true, enumerable: false });
  let seen: boolean | null = null;
  const loaded = await loadNoVnc(async () => {
    seen = "VideoDecoder" in globalThis;
    return "module";
  });
  expect(loaded).toBe("module");
  expect(seen).toBe(false);
  expect(scope.VideoDecoder).toBe(FakeDecoder);
});

test("a load that never finishes fails after the timeout, and still puts VideoDecoder back", async () => {
  class FakeDecoder {}
  Object.defineProperty(globalThis, "VideoDecoder", { value: FakeDecoder, configurable: true, writable: true, enumerable: false });
  await expect(loadNoVnc(() => new Promise(() => {}), 10)).rejects.toThrow("novnc_load_timeout");
  expect(scope.VideoDecoder).toBe(FakeDecoder);
});

test("a browser without WebCodecs loads as it is", async () => {
  expect(await loadNoVnc(async () => 7)).toBe(7);
  expect("VideoDecoder" in globalThis).toBe(false);
});
