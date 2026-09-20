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
export type NormalizedFile<T> = { file: T; filename: string; hash: string };

export function normalizeFiles<T>(files: T[], describe: (file: T) => DigestFile): NormalizedFile<T>[] {
  return files.map((file) => {
    const { filename, bytes } = describe(file);
    if (!filename || /[\x00-\x1f\x7f]/.test(filename) || hasLoneSurrogate(filename)) {
      throw new HttpError(422, "invalid_args", "invalid attachment filename");
    }
    return { file, filename, filenameBytes: Buffer.from(filename), hash: sha256(bytes) };
  }).sort((a, b) => Buffer.compare(a.filenameBytes, b.filenameBytes) || a.hash.localeCompare(b.hash));
}

export function validateRequestPath(path: string): void {
  const pathname = path.split("?")[0]!;
  if (!path.startsWith("/") || /[\x00-\x20\x7f#\\]/.test(path) || /%00|%1[ef]|%2f|%5c/i.test(path) || pathname.includes("//") || pathname.endsWith("/") || /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname)) {
    throw new HttpError(422, "invalid_args", "request path must be canonical");
  }
  try { decodeURIComponent(path); } catch { throw new HttpError(422, "invalid_args", "invalid path encoding"); }
}

export function conditionalHeaders(ifMatch?: string | null): Record<string, string> {
  if (ifMatch == null) return {};
  if (!/^"[0-9a-f]{64}"$/.test(ifMatch)) throw new HttpError(422, "invalid_args", "If-Match must be a strong SHA-256 ETag");
  return { "if-match": ifMatch };
}

export function requestPreimage(input: {
  method: string; path: string; body: unknown; multipart?: boolean;
  files?: DigestFile[]; normalizedFiles?: NormalizedFile<unknown>[]; ifMatch?: string | null;
}, encode: CanonicalEncoder = canonicalJson): string {
  if (!/^[A-Z]+$/.test(input.method)) throw new HttpError(422, "invalid_args", "invalid request method");
  validateRequestPath(input.path);
  const files = input.normalizedFiles ?? normalizeFiles(input.files ?? [], (file) => file);
  if (!input.multipart && files.length) throw new HttpError(422, "invalid_args", "JSON request cannot contain files");
  return [input.method, input.path, encode(input.body), input.multipart ? "multipart" : "json",
    files.map((file) => `${file.filename}\x1e${file.hash}`).join("\x1f"),
    encode(conditionalHeaders(input.ifMatch)),
  ].join("\x1f");
}

export function requestDigest(input: Parameters<typeof requestPreimage>[0], encode: CanonicalEncoder = canonicalJson): string {
  return sha256(requestPreimage(input, encode));
}

function hasLoneSurrogate(value: string): boolean {
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return true;
  }
  return false;
}
