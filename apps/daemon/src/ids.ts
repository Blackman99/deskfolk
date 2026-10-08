const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(time: number): string {
  let t = time;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = "";
  for (let i = 0; i < 16; i++) {
    const shift = BigInt((15 - i) * 5);
    out += CROCKFORD[Number((bits >> shift) & 31n)];
  }
  return out;
}

/** 26-char Crockford ULID. Time is milliseconds. */
export function ulid(now = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

let lastIsoTime = 0;

export function isoNow(): string {
  const now = Date.now();
  lastIsoTime = now > lastIsoTime ? now : lastIsoTime + 1;
  return new Date(lastIsoTime).toISOString();
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/** `iso` moved by `ms` milliseconds (negative for earlier), as an ISO string. */
export function isoPlus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
