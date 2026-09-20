import { sha256 } from '@noble/hashes/sha2.js';
import { check, hex, utf8, validString } from './bytes.ts';

export function canonicalize(value: unknown): string {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): string {
    check(depth <= 64, 'JSON nesting limit');
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(validString(v));
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') { check(Number.isFinite(v), 'nonfinite JSON number'); return JSON.stringify(v); }
    check(typeof v === 'object' && !seen.has(v), 'non-JSON or cyclic value');
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      check(Object.keys(v).length === v.length && Object.getOwnPropertySymbols(v).length === 0, 'sparse or decorated array');
      out = '[' + Array.from({ length: v.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(index));
        check(descriptor && 'value' in descriptor, 'sparse array or JSON accessor');
        return visit(descriptor.value, depth + 1);
      }).join(',') + ']';
    } else {
      check(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null, 'non-JSON object');
      check(Object.getOwnPropertySymbols(v).length === 0, 'symbol JSON key');
      out = '{' + Object.keys(v).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        check('value' in descriptor, 'JSON accessor');
        return JSON.stringify(validString(key)) + ':' + visit(descriptor.value, depth + 1);
      }).join(',') + '}';
    }
    seen.delete(v);
    return out;
  }
  return visit(value, 0);
}
export const canonicalBytes = (value: unknown): Uint8Array => utf8(canonicalize(value));
export const canonicalHash = (value: unknown): string => hex(sha256(canonicalBytes(value)));

export interface AttachmentDigest { filename: string; sha256: string }
export type ConditionalHeaders = Readonly<Record<string, string>>;

function canonicalConditionalHeaders(headers: ConditionalHeaders = {}): Record<string, string> {
  check(headers !== null && typeof headers === 'object' && !Array.isArray(headers) &&
    (Object.getPrototypeOf(headers) === Object.prototype || Object.getPrototypeOf(headers) === null) &&
    Object.getOwnPropertySymbols(headers).length === 0, 'invalid conditional headers');
  const result: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    const key = name.toLowerCase(), descriptor = Object.getOwnPropertyDescriptor(headers, name)!;
    check(['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'if-range'].includes(key), 'unsupported conditional header');
    check(!Object.hasOwn(result, key), 'duplicate conditional header');
    check('value' in descriptor && typeof descriptor.value === 'string' && descriptor.value.length > 0 &&
      !/[\x00-\x1f\x7f]/.test(descriptor.value), 'invalid conditional header value');
    result[key] = validString(descriptor.value);
  }
  return result;
}
export interface RequestDigestInput {
  method: string;
  path: string;
  body: unknown;
  encoding: 'json' | 'multipart';
  files?: readonly AttachmentDigest[];
  conditionalHeaders?: ConditionalHeaders;
}

export function requestDigestBytes(input: RequestDigestInput): Uint8Array {
  check(/^[A-Z]+$/.test(input.method), 'invalid method');
  check(input.path.startsWith('/') && !/[\x00-\x20\x7f]/.test(input.path), 'invalid request path');
  check(input.encoding === 'json' || input.encoding === 'multipart', 'invalid encoding');
  const files = [...(input.files ?? [])];
  check(input.encoding !== 'json' || files.length === 0, 'JSON cannot contain file digests');
  for (const file of files) {
    check(typeof file.filename === 'string' && file.filename.length > 0 && !/[\x00-\x1f\x7f]/.test(file.filename), 'invalid filename');
    validString(file.filename);
    check(typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256), 'invalid file digest');
  }
  files.sort((a, b) => {
    const x = utf8(a.filename), y = utf8(b.filename);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length || (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0);
  });
  // Encoding separates JSON from empty multipart requests, which otherwise collide.
  return utf8([input.method, input.path, canonicalize(input.body), input.encoding,
    files.map(f => f.filename + '\x1e' + f.sha256).join('\x1f'),
    canonicalize(canonicalConditionalHeaders(input.conditionalHeaders))].join('\x1f'));
}
export const requestDigest = (input: RequestDigestInput): string => hex(sha256(requestDigestBytes(input)));
