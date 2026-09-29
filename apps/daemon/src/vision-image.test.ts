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

/** Width and height read from a PNG's IHDR or a JPEG's start-of-frame, with no image tool. */
function size(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(1, 4).toString("latin1") === "PNG") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  let at = 2;
  while (at + 9 < bytes.byteLength) {
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  throw new Error("not a PNG or JPEG");
}

function longEdge(bytes: Buffer): number {
  const { width, height } = size(bytes);
  return Math.max(width, height);
}

const shrinks = process.platform === "darwin" || process.platform === "win32";

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

  test.skipIf(!shrinks)("an opaque keyframe becomes a smaller JPEG at the long edge", () => {
    const dir = scratch();
    const { abs, stat } = write(dir, "frame.png", noisePng(2000, 1000, false));
    const sent = visionImage(abs, "image/png", stat);
    expect(sent.mime).toBe("image/jpeg");
    expect(sent.bytes.byteLength).toBeLessThan(stat.size);
    expect(longEdge(sent.bytes)).toBe(VISION_LONG_EDGE);
    // The second read comes from the cache, byte for byte.
    expect(visionImage(abs, "image/png", stat).bytes.equals(sent.bytes)).toBe(true);
  });

  test.skipIf(!shrinks)("a transparent picture stays PNG so its cut-outs survive", () => {
    const dir = scratch();
    const { abs, stat } = write(dir, "mock.png", noisePng(2000, 1000, true));
    const sent = visionImage(abs, "image/png", stat);
    expect(sent.mime).toBe("image/png");
    expect(longEdge(sent.bytes)).toBe(VISION_LONG_EDGE);
  });

  // GDI+ writes no EXIF, so the orientation tag has to land in the pixels.
  test.skipIf(process.platform !== "win32")("a portrait photo tagged to turn is shrunk upright", () => {
    const dir = scratch();
    const landscape = join(dir, "landscape.png");
    writeFileSync(landscape, noisePng(2400, 1200, false));
    const photo = join(dir, "photo.jpg");
    // A landscape JPEG with EXIF orientation 6 (turn 90° clockwise to view): it is a portrait shot.
    const tag = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      Add-Type -AssemblyName System.Drawing
      $image = [System.Drawing.Image]::FromFile($env:IN)
      $item = [System.Runtime.Serialization.FormatterServices]::GetUninitializedObject([System.Drawing.Imaging.PropertyItem])
      $item.Id = 0x0112; $item.Type = 3; $item.Len = 2; $item.Value = [byte[]](6, 0)
      $image.SetPropertyItem($item)
      $jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $quality = New-Object System.Drawing.Imaging.EncoderParameters 1
      $quality.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]100)
      $image.Save($env:OUT, $jpeg, $quality)
      $image.Dispose()`], { env: { ...process.env, IN: landscape, OUT: photo } });
    expect(tag.status).toBe(0);
    const stat = statSync(photo);
    expect(stat.size).toBeGreaterThan(VISION_SHRINK_OVER_BYTES);
    const sent = visionImage(photo, "image/jpeg", stat);
    expect(sent.mime).toBe("image/jpeg");
    expect(size(sent.bytes)).toEqual({ width: VISION_LONG_EDGE / 2, height: VISION_LONG_EDGE });
  });
});
