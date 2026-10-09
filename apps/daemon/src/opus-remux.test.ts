import { describe, expect, test } from "bun:test";
import { RemuxError, oggCrc, opusPacketSamples, webmOpusToOgg } from "./opus-remux";

type Page = { flags: number; granule: bigint; sequence: number; packets: Uint8Array[]; crcOk: boolean };

/** Reads an Ogg file back page by page; packets here never span pages. */
function readOgg(bytes: Uint8Array): Page[] {
  const pages: Page[] = [];
  let at = 0;
  while (at < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at);
    expect(new TextDecoder().decode(bytes.subarray(at, at + 4))).toBe("OggS");
    const count = view.getUint8(26);
    const lacing = [...bytes.subarray(at + 27, at + 27 + count)];
    const length = 27 + count + lacing.reduce((sum, n) => sum + n, 0);
    const page = bytes.slice(at, at + length);
    const crc = new DataView(page.buffer).getUint32(22, true);
    new DataView(page.buffer).setUint32(22, 0, true);
    const packets: Uint8Array[] = [];
    let body = at + 27 + count;
    let size = 0;
    for (const n of lacing) {
      size += n;
      if (n < 255) {
        packets.push(bytes.subarray(body, body + size));
        body += size;
        size = 0;
      }
    }
    pages.push({ flags: view.getUint8(5), granule: view.getBigUint64(6, true), sequence: view.getUint32(18, true), packets, crcOk: oggCrc(page) === crc });
    at += length;
  }
  return pages;
}

describe("webmOpusToOgg", () => {
  for (const engine of ["chromium", "webkit"]) {
    test(`a ${engine} MediaRecorder recording becomes a valid Ogg Opus stream`, async () => {
      const webm = new Uint8Array(await Bun.file(new URL(`./fixtures/recorder-${engine}.webm`, import.meta.url)).arrayBuffer());
      const pages = readOgg(webmOpusToOgg(webm));
      expect(pages.every((page) => page.crcOk)).toBe(true);
      expect(pages.map((page) => page.sequence)).toEqual(pages.map((_, index) => index));
      expect(new TextDecoder().decode(pages[0]!.packets[0]!.subarray(0, 8))).toBe("OpusHead");
      expect(pages[0]!.flags).toBe(0x02);
      expect(new TextDecoder().decode(pages[1]!.packets[0]!.subarray(0, 8))).toBe("OpusTags");
      expect(pages.at(-1)!.flags).toBe(0x04);
      const audio = pages.slice(2).flatMap((page) => page.packets);
      const samples = audio.reduce((sum, packet) => sum + opusPacketSamples(packet), 0);
      expect(BigInt(samples)).toBe(pages.at(-1)!.granule);
      // The recordings are about four and a half seconds of speech.
      expect(samples / 48_000).toBeGreaterThan(4);
      expect(samples / 48_000).toBeLessThan(5.5);
    });
  }

  test("what is not a WebM with Opus in it is refused", () => {
    expect(() => webmOpusToOgg(new Uint8Array([1, 2, 3, 4]))).toThrow(RemuxError);
    expect(() => webmOpusToOgg(new Uint8Array())).toThrow(RemuxError);
  });
});

test("an Opus packet's length comes from its TOC byte", () => {
  expect(opusPacketSamples(new Uint8Array([0xfc]))).toBe(960); // CELT 20 ms, one frame
  expect(opusPacketSamples(new Uint8Array([0xfd]))).toBe(1920); // two frames
  expect(opusPacketSamples(new Uint8Array([0x1b, 0x03]))).toBe(8640); // SILK 60 ms, code 3 with three frames
  expect(opusPacketSamples(new Uint8Array([0x80]))).toBe(120); // CELT 2.5 ms
});
