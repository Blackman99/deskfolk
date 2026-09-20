import { expect, test } from 'bun:test';
import { canonicalize, canonicalHash, fromBase64url, requestDigest, requestDigestBytes, text } from '../src/index.ts';

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

test('receipt digest byte contract, filename UTF8 order and JSON/multipart distinction', () => {
  const input = { method: 'POST', path: '/v1/messages', body: { b: 2, a: 1 }, encoding: 'json' as const };
  expect(text(requestDigestBytes(input))).toBe('POST\x1f/v1/messages\x1f{"a":1,"b":2}\x1fjson\x1f');
  expect(requestDigest(input)).toBe('8acd54c455bc4a28ce1ec8aa9f0fa985df470a966fa211bb7cf44543659ab119');
  expect(requestDigest(input)).not.toBe(requestDigest({ ...input, encoding: 'multipart' }));
  const files = [{ filename: '😀', sha256: 'a'.repeat(64) }, { filename: '\ufb33', sha256: 'b'.repeat(64) }];
  const multipart = { ...input, encoding: 'multipart' as const, files };
  expect(requestDigest(multipart)).toBe(requestDigest({ ...multipart, files: [...files].reverse() }));
  expect(text(requestDigestBytes(multipart)).indexOf('\ufb33')).toBeLessThan(text(requestDigestBytes(multipart)).indexOf('😀'));
  for (const bad of [{ ...input, method: 'post' }, { ...input, path: '/x\x1f' }, { ...multipart, files: [files[0], files[0]] }, { ...multipart, files: [{ ...files[0], filename: 'a\x1eb' }] }]) {
    expect(() => requestDigest(bad)).toThrow();
  }
});
