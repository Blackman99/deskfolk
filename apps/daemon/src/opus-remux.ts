/**
 * WebM/Opus → Ogg/Opus without decoding (ADR 0073): browsers record speech as Opus in a WebM
 * container, and some speech endpoints (Xiaomi MiMo) take Opus only in Ogg. The packets are
 * copied as they are; only the container around them changes.
 */

const ID = {
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  codecDelay: 0x56aa,
  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  cluster: 0x1f43b675,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
} as const;

/** Masters walked into; every other element is skipped whole. */
const DESCEND = new Set<number>([ID.segment, ID.tracks, ID.trackEntry, ID.audio, ID.cluster, ID.blockGroup]);

type Track = { number: number; codec: string; head: Uint8Array | null; channels: number; rate: number; delayNs: number };

export class RemuxError extends Error {}

function vint(bytes: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  const first = bytes[at];
  if (first === undefined || first === 0) throw new RemuxError("not a WebM file");
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) throw new RemuxError("the recording is cut short");
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function uint(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

function float(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes.length === 4 ? view.getFloat32(0) : bytes.length === 8 ? view.getFloat64(0) : 0;
}

/** The track entries and every block's track number and payload, in file order. */
function readWebm(bytes: Uint8Array): { tracks: Track[]; blocks: { track: number; frame: Uint8Array }[] } {
  const tracks: Track[] = [];
  const blocks: { track: number; frame: Uint8Array }[] = [];
  let entry: Track | null = null;
  let at = 0;
  while (at < bytes.length) {
    const id = vint(bytes, at, true);
    const size = vint(bytes, at + id.length, false);
    const start = at + id.length + size.length;
    // MediaRecorder writes the segment and its clusters with an unknown size: walking into masters
    // instead of measuring them reads those the same as any other.
    if (DESCEND.has(id.value)) {
      if (id.value === ID.trackEntry) {
        entry = { number: 0, codec: "", head: null, channels: 1, rate: 48_000, delayNs: 0 };
        tracks.push(entry);
      } else if (id.value === ID.cluster) {
        entry = null;
      }
      at = start;
      continue;
    }
    if (size.unknown) throw new RemuxError("a WebM element of unknown size that should have one");
    const end = Math.min(start + size.value, bytes.length);
    const data = bytes.subarray(start, end);
    if (entry) {
      if (id.value === ID.trackNumber) entry.number = uint(data);
      else if (id.value === ID.codecId) entry.codec = new TextDecoder().decode(data);
      else if (id.value === ID.codecPrivate) entry.head = data;
      else if (id.value === ID.codecDelay) entry.delayNs = uint(data);
      else if (id.value === ID.channels) entry.channels = uint(data);
      else if (id.value === ID.samplingFrequency) entry.rate = float(data);
    }
    if (id.value === ID.simpleBlock || id.value === ID.block) {
      const track = vint(data, 0, false);
      const flags = data[track.length + 2] ?? 0;
      // Recorders write one frame per block; laced blocks are not taken apart here.
      if ((flags >> 1) & 3) throw new RemuxError("laced WebM blocks are not supported");
      blocks.push({ track: track.value, frame: data.subarray(track.length + 3) });
    }
    at = end;
  }
  return { tracks, blocks };
}

/** An OpusHead for a track that came without one (RFC 7845 §5.1, channel mapping 0). */
function opusHead(track: Track): Uint8Array {
  if (track.channels > 2) throw new RemuxError("more than two channels without an OpusHead");
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"));
  const view = new DataView(head.buffer);
  view.setUint8(8, 1);
  view.setUint8(9, track.channels);
  view.setUint16(10, Math.round((track.delayNs * 48_000) / 1e9), true);
  view.setUint32(12, Math.round(track.rate), true);
  return head;
}

/** Samples at 48 kHz in one Opus packet, from its TOC byte (RFC 6716 §3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) return 0;
  const config = toc >> 3;
  const tenths = config < 12 ? [100, 200, 400, 600][config % 4]! : config < 16 ? [100, 200][config % 2]! : [25, 50, 100, 200][config % 4]!;
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
  return (frames * tenths * 48) / 10;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    table[i] = crc >>> 0;
  }
  return table;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

const SERIAL = 0x52424f54;

function oggPage(packets: Uint8Array[], granule: number, sequence: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const packet of packets) {
    for (let left = packet.length; ; left -= 255) {
      lacing.push(Math.min(left, 255));
      if (left < 255) break;
    }
  }
  const bodyLength = packets.reduce((sum, packet) => sum + packet.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set(new TextEncoder().encode("OggS"));
  view.setUint8(5, flags);
  view.setBigUint64(6, BigInt(granule), true);
  view.setUint32(14, SERIAL, true);
  view.setUint32(18, sequence, true);
  view.setUint8(26, lacing.length);
  page.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, at);
    at += packet.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

function segments(packet: Uint8Array): number {
  return Math.floor(packet.length / 255) + 1;
}

/** The Opus track of a WebM recording as an Ogg Opus file. Throws `RemuxError` when it has none. */
export function webmOpusToOgg(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const { tracks, blocks } = readWebm(bytes);
  const track = tracks.find((entry) => entry.codec === "A_OPUS");
  if (!track) throw new RemuxError("the recording has no Opus audio");
  const head = track.head && new TextDecoder().decode(track.head.subarray(0, 8)) === "OpusHead" ? track.head : opusHead(track);
  const packets = blocks.filter((block) => block.track === track.number && block.frame.length > 0).map((block) => block.frame);
  if (packets.length === 0) throw new RemuxError("the recording has no audio in it");

  const tags = new Uint8Array(8 + 4 + 8 + 4);
  tags.set(new TextEncoder().encode("OpusTags"));
  tags.set(new TextEncoder().encode("deskfolk"), 12);
  new DataView(tags.buffer).setUint32(8, 8, true);

  const pages: Uint8Array[] = [oggPage([head], 0, 0, 0x02), oggPage([tags], 0, 1, 0)];
  let granule = 0;
  let page: Uint8Array[] = [];
  let used = 0;
  for (const [index, packet] of packets.entries()) {
    if (segments(packet) > 255) throw new RemuxError("an Opus packet too large for one Ogg page");
    if (used + segments(packet) > 255) {
      pages.push(oggPage(page, granule, pages.length, 0));
      page = [];
      used = 0;
    }
    page.push(packet);
    used += segments(packet);
    granule += opusPacketSamples(packet);
    if (index === packets.length - 1) pages.push(oggPage(page, granule, pages.length, 0x04));
  }
  const out = new Uint8Array(pages.reduce((sum, item) => sum + item.length, 0));
  let at = 0;
  for (const item of pages) {
    out.set(item, at);
    at += item.length;
  }
  return out;
}
