import { expect, test } from 'bun:test';
import { canonicalize, canonicalHash, fromBase64url, requestDigest, requestDigestBytes, text } from '../src/index.ts';
import * as canonical from '../src/canonical.ts';
import * as remote from '../src/index.ts';
import type { AttachmentDigest, CanonicalEncoder, RequestDigestInput } from '../src/index.ts';
import vectors from './fixtures/request-digest.json';

test('RFC8785 section 3.2.2 numbers/escapes and UTF-16 ordering', () => {
  const input = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\"/","literals":[null,true,false]}');
  expect(canonicalize(input)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\"/"}');
  expect(canonicalize({ '\ufb33': 1, '😀': 2, '€': 3, '\r': 4, '1': 5, '\u0080': 6, 'ö': 7 })).toBe('{"\\r":4,"1":5,"\u0080":6,"ö":7,"€":3,"😀":2,"דּ":1}');
  expect(canonicalize(-0)).toBe('0');
  expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
});

test('JCS rejects values that JSON.stringify silently changes', () => {
  const cycle: unknown[] = []; cycle.push(cycle);
  const accessor = Object.defineProperty([1], '0', { get: () => 1 });
  const decorated = Object.assign([1], { [Symbol('ignored')]: 2 });
  for (const value of [NaN, Infinity, undefined, 1n, new Date(), { a: undefined }, '\ud800', { '\udfff': 1 }, new Array(1), cycle, accessor, decorated, { get a() { return 1; } }]) {
    expect(() => canonicalize(value)).toThrow();
  }
  expect(() => fromBase64url('AB')).toThrow('noncanonical');
});

test('shared barrel and canonical subpath implement pinned receipt preimages and independent SHA256', () => {
  for (const v of vectors) {
    const input = v.input as RequestDigestInput;
    expect(text(requestDigestBytes(input))).toBe(v.preimage);
    expect(requestDigest(input)).toBe(v.sha256);
    expect(canonical.requestDigestBytes(input)).toEqual(requestDigestBytes(input));
    expect(canonical.requestDigest(input)).toBe(v.sha256);
  }
});

test('conditional headers are canonical, required in digest and never silently discarded', () => {
  const base = { method: 'PUT', path: '/v1/workspace/file', body: { content: 'hello' }, encoding: 'json' as const };
  expect(requestDigest(base)).toBe(requestDigest({ ...base, conditionalHeaders: {} }));
  expect(requestDigest(base)).not.toBe(requestDigest({ ...base, conditionalHeaders: { 'If-Match': '"rev-1"' } }));
  const one = { 'If-Match': '"rev-1"', 'IF-UNMODIFIED-SINCE': 'Wed, 21 Oct 2015 07:28:00 GMT' };
  const two = { 'if-unmodified-since': one['IF-UNMODIFIED-SINCE'], 'if-match': one['If-Match'] };
  expect(requestDigest({ ...base, conditionalHeaders: one })).toBe(requestDigest({ ...base, conditionalHeaders: two }));
  const invalidHeaders: Record<string, string>[] = [{ 'If-Match': 'a', 'if-match': 'b' }, { 'If-Match': '' },
    { 'If-Match': 'a\x1fb' }, { 'If-Match': 'a\x1eb' }, { 'If-Match': 'a\r\nb' }, { Authorization: 'secret' },
    { ' If-Match': 'a' }, { get 'If-Match'(): string { throw new Error('must not invoke accessor'); } }];
  for (const conditionalHeaders of invalidHeaders) {
    expect(() => requestDigest({ ...base, conditionalHeaders })).toThrow();
  }
});

test('duplicate filenames sort by filename bytes then digest, preserving multiplicity', () => {
  const files = [{ filename: 'same.png', sha256: 'b'.repeat(64) }, { filename: 'same.png', sha256: 'a'.repeat(64) }, { filename: 'same.png', sha256: 'a'.repeat(64) }];
  const input = { method: 'POST', path: '/v1/messages', body: {}, encoding: 'multipart' as const, files };
  const before = JSON.stringify(files);
  expect(requestDigest(input)).toBe(requestDigest({ ...input, files: [...files].reverse() }));
  expect(requestDigest(input)).not.toBe(requestDigest({ ...input, files: files.slice(0, 2) }));
  expect(JSON.stringify(files)).toBe(before);
  const preimage = text(requestDigestBytes(input));
  expect(preimage.indexOf('a'.repeat(64))).toBeLessThan(preimage.indexOf('b'.repeat(64)));
});

test('shared attachment normalization validates, preserves references and does not mutate upload order', () => {
  const files = [{ filename: '😀', sha256: 'a'.repeat(64), value: 1 }, { filename: 'דּ', sha256: 'b'.repeat(64), value: 2 }];
  const sorted = canonical.normalizeAttachmentDigests(files);
  expect(sorted).toEqual([files[1], files[0]]);
  expect(sorted[0]).toBe(files[1]);
  expect(files[0]!.value).toBe(1);
  for (const file of [{ filename: '\ud800', sha256: 'a'.repeat(64) }, { filename: 'ok', sha256: 'A'.repeat(64) }, { filename: '', sha256: 'a'.repeat(64) }, { filename: 'a\x1eb', sha256: 'a'.repeat(64) }]) {
    expect(() => canonical.normalizeAttachmentDigests([file])).toThrow();
  }
  expect(canonical.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(canonical.sha256Hex(new TextEncoder().encode('abc'))).toBe(canonical.sha256Hex('abc'));
});

test('attachment holes reject through root and canonical exports without changing dense multisets', () => {
  const file = { filename: 'same.txt', sha256: 'a'.repeat(64) };
  const holes = [new Array<AttachmentDigest>(1), new Array<AttachmentDigest>(3), [file, , file], [, file], [file, ,]] as AttachmentDigest[][];
  const inherited = new Array<AttachmentDigest>(1);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: file }));
  holes.push(inherited);
  const base = { method: 'POST', path: '/v1/messages', body: {}, encoding: 'multipart' as const };
  for (const api of [remote, canonical]) {
    for (const files of holes) {
      expect(() => api.normalizeAttachmentDigests(files)).toThrow('sparse attachment list');
      expect(() => api.requestDigestBytes({ ...base, files })).toThrow('sparse attachment list');
      expect(() => api.requestDigest({ ...base, files })).toThrow('sparse attachment list');
    }
    const dense = [file, file];
    const sorted = api.normalizeAttachmentDigests(dense);
    expect(sorted).not.toBe(dense);
    expect(sorted).toHaveLength(2);
    expect(sorted[0]).toBe(file); expect(sorted[1]).toBe(file);
    expect(api.requestDigest({ ...base, files: dense })).not.toBe(api.requestDigest({ ...base, files: [file] }));
    expect(dense).toEqual([file, file]);
  }
});

test('encoder results must be primitive strings, never coerced or awaited, with rejected Promises observed', async () => {
  let executed = 0;
  const coercible = { toString() { executed++; return '{}'; } };
  const thenable = { then() { executed++; throw new Error('must not execute thenable'); } };
  const factories: Array<() => unknown> = [
    () => undefined, () => null, () => 0, () => false, () => new String('{}'),
    () => new Uint8Array([123, 125]), () => Buffer.from('{}'), () => coercible, () => thenable,
    () => Promise.resolve('{}'), () => Promise.reject(new Error('encoder rejection')),
    () => (async () => '{}')(), () => (async () => { throw new Error('async encoder rejection'); })(),
    () => new Promise((_, reject) => setTimeout(() => reject(new Error('late encoder rejection')), 0)),
    () => new Promise(() => {}),
  ];
  const body = { changed: 1 };
  const input = { method: 'POST', path: '/v1/messages', body, encoding: 'json' as const };
  for (const api of [remote, canonical]) {
    for (const field of ['body', 'conditions']) {
      for (const factory of factories) {
        let calls = 0;
        const encode = ((value: unknown) => {
          calls++;
          return (field === 'body' || value !== body) ? factory() : canonicalize(value);
        }) as CanonicalEncoder;
        expect(() => api.requestDigestBytes(input, encode)).toThrow('synchronous primitive string');
        expect(calls).toBe(field === 'body' ? 1 : 2);
        expect(() => api.requestDigest(input, encode)).toThrow('synchronous primitive string');
      }
    }
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(executed).toBe(0);
});

test('receipt digest byte contract, filename UTF8 order and JSON/multipart distinction', () => {
  const input = { method: 'POST', path: '/v1/messages', body: { b: 2, a: 1 }, encoding: 'json' as const };
  expect(text(requestDigestBytes(input))).toBe('POST\x1f/v1/messages\x1f{"a":1,"b":2}\x1fjson\x1f\x1f{}');
  expect(requestDigest(input)).not.toBe(requestDigest({ ...input, encoding: 'multipart' }));
  const files = [{ filename: '😀', sha256: 'a'.repeat(64) }, { filename: '\ufb33', sha256: 'b'.repeat(64) }];
  const multipart = { ...input, encoding: 'multipart' as const, files };
  expect(requestDigest(multipart)).toBe(requestDigest({ ...multipart, files: [...files].reverse() }));
  expect(text(requestDigestBytes(multipart)).indexOf('\ufb33')).toBeLessThan(text(requestDigestBytes(multipart)).indexOf('😀'));
  for (const bad of [{ ...input, method: 'post' }, { ...input, path: '/x\x1f' }, { ...multipart, files: [{ ...files[0], filename: 'a\x1eb' }] }]) {
    expect(() => requestDigest(bad)).toThrow();
  }
});
