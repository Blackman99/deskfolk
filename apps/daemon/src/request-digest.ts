import { createHash } from "node:crypto";
import { HttpError } from "./errors";

export type CanonicalEncoder = (value: unknown) => string;

/** RFC 8785 uses ECMAScript number serialization and UTF-16 property ordering. */
export const canonicalJson: CanonicalEncoder = (value) => {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new HttpError(422, "invalid_args", "JSON contains a lone surrogate");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new HttpError(422, "invalid_args", "value is not I-JSON");
};

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type DigestFile = { filename: string; bytes: Uint8Array };

export function requestDigest(input: {
  method: string;
  path: string;
  body: unknown;
  multipart?: boolean;
  files?: DigestFile[];
  ifMatch?: string | null;
}, encode: CanonicalEncoder = canonicalJson): string {
  const files = (input.files ?? []).map((file) => {
    if (/[\x1e\x1f]/.test(file.filename) || hasLoneSurrogate(file.filename)) {
      throw new HttpError(422, "invalid_args", "invalid attachment filename");
    }
    return { filename: file.filename, hash: sha256(file.bytes) };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.filename), Buffer.from(b.filename)) || a.hash.localeCompare(b.hash));
  // Domain separation also binds conditional headers; an empty multipart is not JSON.
  return sha256([
    input.method.toUpperCase(), input.path,
    input.multipart ? "multipart" : "json", encode(input.body),
    files.map((file) => `${file.filename}\x1e${file.hash}`).join("\x1f"),
    encode(input.ifMatch ?? null),
  ].join("\x1f"));
}

function hasLoneSurrogate(value: string): boolean {
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return true;
  }
  return false;
}
