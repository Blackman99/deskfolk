import { canonicalize, fromBase64url, PAIR_MAILBOX_CONTRACT } from '@real-bot/remote';

export const LIMITS = Object.freeze({
  frame: 65_536, text: 2_048, httpBody: 90_000, mailbox: PAIR_MAILBOX_CONTRACT.maximumEnvelopeBytes,
  mailboxChunk: 16_384, mailboxes: 4, mailboxTtlMs: PAIR_MAILBOX_CONTRACT.maximumLifetimeSeconds * 1_000,
  devices: 16, slots: 32, sockets: 65, pending: 32, httpRequests: 32,
  challengeMs: 10_000, ipEntries: 1_024, handshakesPerMinute: 10,
  bytesPerSecond: 2_500_000, burstBytes: 262_144, bufferBytes: 65_536,
});
export type RecordValue = Record<string, unknown>;
export function requireValue(value: unknown): asserts value {
  if (!value) throw new Error('invalid');
}
function record(value: unknown): RecordValue {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  return value as RecordValue;
}
export function fields(value: RecordValue, names: string[]): void {
  requireValue(Object.keys(value).sort().join(',') === names.sort().join(','));
}
export function parseWire(input: string): RecordValue {
  const value = record(JSON.parse(input));
  // Canonical JSON also rejects duplicate members and ambiguous number encodings.
  requireValue(canonicalize(value) === input);
  return value;
}
export function identifier(value: unknown): string {
  requireValue(typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value));
  return value;
}
export function opaqueId(value: unknown): string {
  requireValue(typeof value === 'string');
  fromBase64url(value, 16);
  return value;
}
export function key(value: unknown): string {
  requireValue(typeof value === 'string');
  const bytes = fromBase64url(value, 32);
  requireValue(bytes.some(byte => byte !== 0));
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max);
  return value;
}
export function envelope(value: unknown, maximum: number = LIMITS.mailbox): Uint8Array {
  requireValue(typeof value === 'string' && value.length <= Math.ceil(maximum * 4 / 3));
  const bytes = fromBase64url(value);
  requireValue(bytes.length > 0 && bytes.length <= maximum);
  return bytes;
}

export class Bucket {
  private tokens: number;
  private last: number;
  constructor(private capacity: number, private perSecond: number, now: number) {
    this.tokens = capacity; this.last = now;
  }
  take(amount: number, now: number): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.last) * this.perSecond / 1_000);
    this.last = Math.max(now, this.last);
    if (amount > this.tokens) return false;
    this.tokens -= amount;
    return true;
  }
}

export class IpLimiter {
  private entries = new Map<string, { count: number; expires: number }>();
  take(ip: string, now: number): boolean {
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    let entry = this.entries.get(ip);
    if (!entry) {
      if (this.entries.size >= LIMITS.ipEntries) return false;
      entry = { count: 0, expires: now + 60_000 }; this.entries.set(ip, entry);
    }
    if (entry.count >= LIMITS.handshakesPerMinute) return false;
    entry.count++;
    return true;
  }
}
