import { bytes, check, concat, field, id, origin, randomBytes, Reader, u16, u32, u64, hex } from './bytes.ts';

export const PROTOCOL_VERSION = 1;
export const MAX_PLAINTEXT = 32 * 1024;
export const TRANSPORT_HEADER = 25;
export const MAX_BODY = MAX_PLAINTEXT - TRANSPORT_HEADER;
export const FRAGMENT_HEADER = 25;
export const MAX_FRAGMENT_CHUNK = MAX_BODY - FRAGMENT_HEADER;
export const MAX_LOGICAL_MESSAGE = 1024 * 1024;
export const REASSEMBLY_TTL_MS = 30_000;
export const MAX_FILE_CHUNK = MAX_BODY - 13;
export type FrameType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type LogicalType = 1 | 2 | 3 | 8;
export interface SessionBinding {
  hostId: string;
  deviceId: string;
  trustEpoch: number;
  protocolVersion: number;
  relayOrigin: string;
}
export function encodePrologue(b: SessionBinding): Uint8Array {
  check(b.protocolVersion === PROTOCOL_VERSION, 'unsupported protocol version');
  return concat(field('RB-REMOTE-v1'), field(id(b.hostId)), field(id(b.deviceId)), u32(b.trustEpoch),
    u16(b.protocolVersion), field(origin(b.relayOrigin)));
}
export interface TransportFrame { sessionId: Uint8Array; seq: bigint; type: FrameType; body: Uint8Array }
function frameBody(type: number, body: Uint8Array): asserts type is FrameType {
  check(Number.isInteger(type) && type >= 1 && type <= 8, 'unknown frame type');
  check(body.length <= MAX_BODY, 'total plaintext exceeds 32 KiB');
  if (type === 4) decodeFragment(body);
  if (type === 5) decodeFileChunk(body);
  if (type === 6) check(body.length === 4, 'invalid stream cancellation');
  if (type === 7) check(body.length === 0, 'invalid close frame');
}
export function encodeFrame(frame: TransportFrame): Uint8Array {
  frameBody(frame.type, frame.body);
  return concat(bytes(frame.sessionId, 16), u64(frame.seq), Uint8Array.of(frame.type), frame.body);
}
export function decodeFrame(input: Uint8Array): TransportFrame {
  check(input.length <= MAX_PLAINTEXT && input.length >= TRANSPORT_HEADER, 'invalid plaintext length');
  const r = new Reader(input), sessionId = r.take(16), seq = r.u64(), type = r.u8(), body = r.take(r.remaining);
  frameBody(type, body);
  return { sessionId, seq, type, body };
}
export interface Fragment { originalType: LogicalType; messageId: Uint8Array; index: number; count: number; chunk: Uint8Array }
function validateFragment(f: Fragment): void {
  check([1, 2, 3, 8].includes(f.originalType), 'invalid original type');
  bytes(f.messageId, 16); u32(f.index); u32(f.count);
  check(f.count >= 1 && f.count <= Math.ceil(MAX_LOGICAL_MESSAGE / MAX_FRAGMENT_CHUNK) && f.index < f.count, 'invalid fragment index/count');
  check(f.chunk.length > 0 && f.chunk.length <= MAX_FRAGMENT_CHUNK, 'invalid fragment chunk');
  check(f.index === f.count - 1 || f.chunk.length === MAX_FRAGMENT_CHUNK, 'nonfinal short fragment');
  check((f.count - 1) * MAX_FRAGMENT_CHUNK + (f.index === f.count - 1 ? f.chunk.length : 1) <= MAX_LOGICAL_MESSAGE, 'logical message limit');
}
export function encodeFragment(f: Fragment): Uint8Array {
  validateFragment(f);
  return concat(Uint8Array.of(f.originalType), f.messageId, u32(f.index), u32(f.count), f.chunk);
}
export function decodeFragment(input: Uint8Array): Fragment {
  const r = new Reader(input);
  const f = { originalType: r.u8() as LogicalType, messageId: r.take(16), index: r.u32(), count: r.u32(), chunk: r.take(r.remaining) };
  validateFragment(f); return f;
}
export function fragmentMessage(type: LogicalType, body: Uint8Array): { type: FrameType; body: Uint8Array }[] {
  check([1, 2, 3, 8].includes(type) && body.length <= MAX_LOGICAL_MESSAGE, 'invalid logical message');
  if (body.length <= MAX_BODY) return [{ type, body: new Uint8Array(body) }];
  const messageId = randomBytes(16), count = Math.ceil(body.length / MAX_FRAGMENT_CHUNK);
  return Array.from({ length: count }, (_, index) => ({ type: 4,
    body: encodeFragment({ originalType: type, messageId, index, count, chunk: body.subarray(index * MAX_FRAGMENT_CHUNK, (index + 1) * MAX_FRAGMENT_CHUNK) }) }));
}

export class Reassembler {
  #pending?: { key: string; type: LogicalType; count: number; next: number; started: number; chunks: Uint8Array[] };
  accept(body: Uint8Array, nowMs: number): { type: LogicalType; body: Uint8Array } | undefined {
    try {
      check(Number.isFinite(nowMs) && nowMs >= 0, 'invalid clock');
      const f = decodeFragment(body), key = hex(f.messageId);
      if (!this.#pending) {
        check(f.index === 0, 'missing first fragment');
        this.#pending = { key, type: f.originalType, count: f.count, next: 0, started: nowMs, chunks: [] };
      }
      const p = this.#pending;
      check(nowMs >= p.started && nowMs - p.started < REASSEMBLY_TTL_MS, 'fragment timeout');
      check(p.key === key && p.type === f.originalType && p.count === f.count && p.next === f.index, 'fragment mismatch');
      p.chunks.push(f.chunk); p.next++;
      if (p.next !== p.count) return;
      const complete = concat(...p.chunks);
      this.clear();
      return { type: p.type, body: complete };
    } catch (error) { this.clear(); throw error; }
  }
  expire(nowMs: number): void {
    check(Number.isFinite(nowMs) && nowMs >= 0, 'invalid clock');
    if (this.#pending && (nowMs < this.#pending.started || nowMs - this.#pending.started >= REASSEMBLY_TTL_MS)) this.clear();
  }
  clear(): void {
    for (const chunk of this.#pending?.chunks ?? []) chunk.fill(0);
    this.#pending = undefined;
  }
}
export interface FileChunk { streamId: number; offset: bigint; eof: boolean; chunk: Uint8Array }
export function encodeFileChunk(f: FileChunk): Uint8Array {
  check(f.chunk.length <= MAX_FILE_CHUNK && typeof f.eof === 'boolean', 'invalid file chunk');
  return concat(u32(f.streamId), u64(f.offset), Uint8Array.of(f.eof ? 1 : 0), f.chunk);
}
export function decodeFileChunk(input: Uint8Array): FileChunk {
  check(input.length <= MAX_BODY, 'file frame limit');
  const r = new Reader(input), streamId = r.u32(), offset = r.u64(), flags = r.u8();
  check(flags === 0 || flags === 1, 'reserved file flags');
  return { streamId, offset, eof: flags === 1, chunk: r.take(r.remaining) };
}
