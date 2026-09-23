import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_VARIANT_EDGE, parseImageVariant, reduceImage } from "./image-variant";
import { noisePng } from "./test-images";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const onMac = process.platform === "darwin";
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "real-bot-variant-test-"));
  dirs.push(dir);
  return dir;
}

function longEdge(bytes: Buffer): number {
  const file = join(scratch(), "sent.bin");
  writeFileSync(file, bytes);
  const out = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" }).stdout;
  return Math.max(Number(/pixelWidth: (\d+)/.exec(out)?.[1]), Number(/pixelHeight: (\d+)/.exec(out)?.[1]));
}

function write(name: string, bytes: Buffer): string {
  const abs = join(scratch(), name);
  writeFileSync(abs, bytes);
  return abs;
}

describe("reduceImage", () => {
  test.skipIf(!onMac)("a keyframe becomes a small JPEG for a chip and a larger one for an enlargement", async () => {
    const original = noisePng(2000, 1000, false);
    const abs = write("frame.png", original);
    const cacheDir = scratch();
    const thumb = await reduceImage(abs, "image/png", "thumb", { cacheDir });
    expect(thumb?.mime).toBe("image/jpeg");
    expect(longEdge(thumb!.bytes)).toBe(IMAGE_VARIANT_EDGE.thumb);
    const preview = await reduceImage(abs, "image/png", "preview", { cacheDir });
    expect(longEdge(preview!.bytes)).toBe(IMAGE_VARIANT_EDGE.preview);
    expect(thumb!.bytes.byteLength).toBeLessThan(preview!.bytes.byteLength);
    expect(preview!.bytes.byteLength).toBeLessThan(original.byteLength);
    // Converted once: the second ask is the cached file, and no scratch file is left behind.
    const again = await reduceImage(abs, "image/png", "thumb", { cacheDir });
    expect(again!.bytes.equals(thumb!.bytes)).toBe(true);
    expect(readdirSync(cacheDir).sort()).toHaveLength(2);
    expect(readdirSync(cacheDir).every((name) => !name.includes(".tmp."))).toBe(true);
  });

  test.skipIf(!onMac)("a chat opening asks for the same picture twice at once and it is converted once", async () => {
    const abs = write("frame.png", noisePng(1200, 800, false));
    const cacheDir = scratch();
    const [a, b] = await Promise.all([
      reduceImage(abs, "image/png", "thumb", { cacheDir }),
      reduceImage(abs, "image/png", "thumb", { cacheDir }),
    ]);
    expect(a!.bytes.equals(b!.bytes)).toBe(true);
    expect(readdirSync(cacheDir)).toHaveLength(1);
  });

  test.skipIf(!onMac)("a transparent picture stays PNG so its cut-outs survive", async () => {
    const abs = write("mock.png", noisePng(1000, 600, true));
    const thumb = await reduceImage(abs, "image/png", "thumb", { cacheDir: scratch() });
    expect(thumb?.mime).toBe("image/png");
    expect(longEdge(thumb!.bytes)).toBe(IMAGE_VARIANT_EDGE.thumb);
  });

  test.skipIf(!onMac)("a picture already within the size, or not a picture at all, is sent as it is", async () => {
    const cacheDir = scratch();
    expect(await reduceImage(write("pixel.png", PNG_1X1), "image/png", "thumb", { cacheDir })).toBeNull();
    expect(await reduceImage(write("junk.png", randomBytes(4096)), "image/png", "thumb", { cacheDir })).toBeNull();
    expect(await reduceImage(join(scratch(), "gone.png"), "image/png", "thumb", { cacheDir })).toBeNull();
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  test("vectors, an animation's enlargement, and a Mac without sips are left alone", async () => {
    const abs = write("frame.png", PNG_1X1);
    const sips = join(scratch(), "missing-sips");
    expect(await reduceImage(abs, "image/svg+xml", "thumb", { sips })).toBeNull();
    expect(await reduceImage(abs, "image/gif", "preview", { sips })).toBeNull();
    expect(await reduceImage(abs, "text/markdown", "thumb", { sips })).toBeNull();
    expect(await reduceImage(abs, "image/png", "thumb", { platform: "linux" })).toBeNull();
    expect(await reduceImage(abs, "image/png", "thumb", { platform: "darwin", sips, cacheDir: scratch() })).toBeNull();
  });
});

test("size names one of two variants, and anything else is refused", () => {
  expect(parseImageVariant(null)).toBeNull();
  expect(parseImageVariant("thumb")).toBe("thumb");
  expect(parseImageVariant("preview")).toBe("preview");
  expect(() => parseImageVariant("full")).toThrow(expect.objectContaining({ status: 422, code: "invalid_args" }));
});
