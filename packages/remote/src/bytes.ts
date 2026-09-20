export const EMPTY = new Uint8Array();
export const U64_MAX = (1n << 64n) - 1n;

export function check(condition: unknown, message = 'invalid remote protocol input'): asserts condition {
  if (!condition) throw new Error(message);
}

export function bytes(value: Uint8Array, length?: number): Uint8Array {
  check(value instanceof Uint8Array && (length === undefined || value.length === length), 'invalid byte length');
  return value;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function validString(value: string): string {
  check(typeof value === 'string', 'expected string');
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i);
      check(next >= 0xdc00 && next <= 0xdfff, 'lone surrogate');
    } else check(n < 0xdc00 || n > 0xdfff, 'lone surrogate');
  }
  return value;
}

export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(validString(value));
export const text = (value: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(value);
export const hex = (value: Uint8Array): string => Array.from(value, n => n.toString(16).padStart(2, '0')).join('');
export function unhex(value: string): Uint8Array {
  check(/^(?:[0-9a-f]{2})*$/i.test(value), 'invalid hex');
  return Uint8Array.from(value.match(/../g) ?? [], n => Number.parseInt(n, 16));
}
export function base64url(value: Uint8Array): string {
  let s = '';
  for (const n of value) s += String.fromCharCode(n);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64url(value: string, length?: number): Uint8Array {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]*$/.test(value) && value.length % 4 !== 1, 'invalid base64url');
  if (length !== undefined) check(value.length === Math.ceil(length * 8 / 6), 'invalid base64url length');
  const out = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  check(base64url(out) === value, 'noncanonical base64url');
  return bytes(out, length);
}
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
export function uint(value: number, max = Number.MAX_SAFE_INTEGER): number {
  check(Number.isSafeInteger(value) && value >= 0 && value <= max, 'invalid unsigned integer');
  return value;
}
export function u16(value: number): Uint8Array {
  const out = new Uint8Array(2); new DataView(out.buffer).setUint16(0, uint(value, 65535)); return out;
}
export function u32(value: number): Uint8Array {
  const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, uint(value, 0xffffffff)); return out;
}
export function u64(value: bigint | number): Uint8Array {
  const n = typeof value === 'number' ? BigInt(uint(value)) : value;
  check(typeof n === 'bigint' && n >= 0n && n <= U64_MAX, 'invalid u64');
  const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, n); return out;
}
export function field(value: string): Uint8Array {
  const b = utf8(value); check(b.length > 0 && !value.includes('\0'), 'empty or NUL field');
  return concat(u16(b.length), b);
}
export function origin(value: string): string {
  const url = new URL(value);
  check(url.protocol === 'https:' && url.origin === value && !url.username && !url.password, 'expected pinned HTTPS origin');
  return value;
}
export function id(value: string): string {
  check(typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value), 'expected ULID');
  return value;
}
export class Reader {
  #offset = 0;
  constructor(readonly data: Uint8Array) { bytes(data); }
  get remaining(): number { return this.data.length - this.#offset; }
  take(n: number): Uint8Array {
    uint(n); check(n <= this.remaining, 'truncated input');
    const out = this.data.slice(this.#offset, this.#offset + n); this.#offset += n; return out;
  }
  u8(): number { return this.take(1)[0]; }
  u16(): number { return new DataView(this.take(2).buffer).getUint16(0); }
  u32(): number { return new DataView(this.take(4).buffer).getUint32(0); }
  u64(): bigint { return new DataView(this.take(8).buffer).getBigUint64(0); }
  number64(): number { const n = this.u64(); check(n <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(n); }
  field(): string { const s = text(this.take(this.u16())); field(s); return s; }
  end(): void { check(this.remaining === 0, 'trailing bytes'); }
}
