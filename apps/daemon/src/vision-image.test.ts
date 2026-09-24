import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { VISION_LONG_EDGE, VISION_SHRINK_OVER_BYTES, visionImage } from "./vision-image";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "real-bot-vision-test-"));
  dirs.push(dir);
  return dir;
}

/** Noise, so the PNG stays big enough to be worth shrinking. */
function noisePng(width: number, height: number, alpha: boolean): Buffer {
  const channels = alpha ? 4 : 3;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.concat([Buffer.from([0]), randomBytes(width * channels)]));
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.byteLength);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(Bun.hash.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([head, Buffer.from(type), data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function longEdge(dir: string, bytes: Buffer): number {
  const file = join(dir, "sent.bin");
  writeFileSync(file, bytes);
  const out = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" }).stdout;
  return Math.max(Number(/pixelWidth: (\d+)/.exec(out)?.[1]), Number(/pixelHeight: (\d+)/.exec(out)?.[1]));
}

function write(dir: string, name: string, bytes: Buffer): { abs: string; stat: { size: number; mtimeMs: number } } {
  const abs = join(dir, name);
  writeFileSync(abs, bytes);
  return { abs, stat: statSync(abs) };
}

describe("visionImage", () => {
  test("a small picture goes as it is", () => {
    const { abs, stat } = write(scratch(), "pixel.png", PNG_1X1);
    expect(visionImage(abs, "image/png", stat)).toEqual({ mime: "image/png", bytes: PNG_1X1 });
  });

  test("a big file that is not a picture goes as it is", () => {
    const junk = Buffer.alloc(VISION_SHRINK_OVER_BYTES + 1, 7);
    const { abs, stat } = write(scratch(), "junk.png", junk);
    expect(visionImage(abs, "image/png", stat)).toEqual({ mime: "image/png", bytes: junk });
  });

  test.skipIf(process.platform !== "darwin")("an opaque keyframe becomes a smaller JPEG at the long edge", () => {
    const dir = scratch();
    const { abs, stat } = write(dir, "frame.png", noisePng(2000, 1000, false));
    const sent = visionImage(abs, "image/png", stat);
    expect(sent.mime).toBe("image/jpeg");
    expect(sent.bytes.byteLength).toBeLessThan(stat.size);
    expect(longEdge(dir, sent.bytes)).toBe(VISION_LONG_EDGE);
    // The second read comes from the cache, byte for byte.
    expect(visionImage(abs, "image/png", stat).bytes.equals(sent.bytes)).toBe(true);
  });

  test.skipIf(process.platform !== "darwin")("a transparent picture stays PNG so its cut-outs survive", () => {
    const dir = scratch();
    const { abs, stat } = write(dir, "mock.png", noisePng(2000, 1000, true));
    const sent = visionImage(abs, "image/png", stat);
    expect(sent.mime).toBe("image/png");
    expect(longEdge(dir, sent.bytes)).toBe(VISION_LONG_EDGE);
  });
});
