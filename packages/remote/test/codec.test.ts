import { expect, test } from 'bun:test';
import { u64 } from '../src/bytes.ts';
import { MAX_BODY, MAX_FILE_CHUNK, MAX_FRAGMENT_CHUNK, MAX_LOGICAL_MESSAGE, Reassembler, decodeFileChunk, decodeFragment, decodeFrame, encodeFileChunk, encodeFragment, encodeFrame, fragmentMessage, randomBytes } from '../src/index.ts';

test('32KiB includes all transport/fragment/file headers', () => {
  const sessionId = randomBytes(16);
  const frame = encodeFrame({ sessionId, seq: 1n, type: 1, body: new Uint8Array(MAX_BODY) });
  expect(frame.length).toBe(32768); expect(decodeFrame(frame).seq).toBe(1n);
  expect(() => encodeFrame({ sessionId, seq: 0n, type: 1, body: new Uint8Array(MAX_BODY + 1) })).toThrow();
  const file = encodeFileChunk({ streamId: 42, offset: 5000000000n, eof: true, chunk: new Uint8Array(MAX_FILE_CHUNK) });
  expect(file.length + 25).toBe(32768); expect(decodeFileChunk(file).offset).toBe(5000000000n);
  expect(() => encodeFileChunk({ streamId: 0, offset: -1n, eof: false, chunk: new Uint8Array() })).toThrow();
  file[12] = 2; expect(() => decodeFileChunk(file)).toThrow('flags');
  for (const bad of [new Uint8Array(24), new Uint8Array(32769)]) expect(() => decodeFrame(bad)).toThrow();
  const invalid = frame.slice(); invalid[24] = 9; expect(() => decodeFrame(invalid)).toThrow();
  expect(() => u64(2n ** 64n)).toThrow();
});

test('1 MiB snapshot fragmentation, strict contiguous bounded reassembly', () => {
  const plain = new Uint8Array(MAX_LOGICAL_MESSAGE).fill(17), frames = fragmentMessage(8, plain), r = new Reassembler();
  expect(frames.length).toBe(33);
  for (const [index, frame] of frames.entries()) {
    expect(frame.body.length + 25).toBeLessThanOrEqual(32768);
    const result = r.accept(frame.body, index);
    if (index < frames.length - 1) expect(result).toBeUndefined();
    else expect(result).toEqual({ type: 8, body: plain });
  }
  expect(() => fragmentMessage(8, new Uint8Array(MAX_LOGICAL_MESSAGE + 1))).toThrow();
  for (const kind of ['gap', 'duplicate', 'timeout', 'backwards', 'different-id']) {
    const assembly = new Reassembler(); assembly.accept(frames[0].body, 100);
    const second = frames[1].body.slice();
    if (kind === 'different-id') second[1] ^= 1;
    expect(() => assembly.accept(kind === 'gap' ? frames[2].body : kind === 'duplicate' ? frames[0].body : second,
      kind === 'timeout' ? 30100 : kind === 'backwards' ? 99 : 101)).toThrow();
  }
  expect(() => new Reassembler().accept(frames[1].body, 0)).toThrow();
  const expiry = new Reassembler(); expiry.accept(frames[0].body, 0); expiry.expire(30000);
  expect(() => expiry.accept(frames[1].body, 30001)).toThrow('first fragment');
});

test('invalid fragments, close and cancel sizes are rejected', () => {
  const f = { originalType: 8 as const, messageId: randomBytes(16), index: 0, count: 2, chunk: new Uint8Array(MAX_FRAGMENT_CHUNK) };
  for (const delta of [{ originalType: 5 }, { count: 1000 }, { index: 2 }, { chunk: new Uint8Array(1) }]) {
    expect(() => encodeFragment({ ...f, ...delta } as typeof f)).toThrow();
  }
  expect(() => decodeFragment(new Uint8Array(24))).toThrow();
  for (const type of [6, 7] as const) expect(() => encodeFrame({ sessionId: randomBytes(16), seq: 0n, type, body: new Uint8Array(1) })).toThrow();
});
