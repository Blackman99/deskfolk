import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

/** A PNG of noise, so no scaled copy of it can come out larger than the original. */
export function noisePng(width: number, height: number, alpha = false): Buffer<ArrayBuffer> {
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
