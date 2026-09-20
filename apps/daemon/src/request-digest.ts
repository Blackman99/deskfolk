import {
  canonicalize, normalizeAttachmentDigests, requestDigest as sharedRequestDigest,
  requestDigestBytes, sha256Hex, type CanonicalEncoder, type RequestDigestInput,
} from "@real-bot/remote/canonical";
import { HttpError } from "./errors";

export type { CanonicalEncoder } from "@real-bot/remote/canonical";

function invalidArgs<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "invalid_args", error instanceof Error ? error.message : "invalid digest input");
  }
}

export const canonicalJson: CanonicalEncoder = (value) => invalidArgs(() => canonicalize(value));
export const sha256 = sha256Hex;

export type DigestFile = { filename: string; bytes: Uint8Array };
export type NormalizedFile<T> = { file: T; filename: string; hash: string };

export function normalizeFiles<T>(files: T[], describe: (file: T) => DigestFile): NormalizedFile<T>[] {
  return invalidArgs(() => normalizeAttachmentDigests(Array.from({ length: files.length }, (_, index) => {
    if (!Object.hasOwn(files, index)) throw new HttpError(422, "invalid_args", "sparse attachment list");
    const file = files[index]!;
    const { filename, bytes } = describe(file);
    return { file, filename, sha256: sha256Hex(bytes) };
  })).map(({ file, filename, sha256: hash }) => ({ file, filename, hash })));
}

export function validateRequestPath(path: string): void {
  const pathname = path.split("?")[0]!;
  if (!path.startsWith("/") || /[\x00-\x20\x7f#\\]/.test(path) || /%00|%1[ef]|%2f|%5c/i.test(pathname) || pathname.includes("//") || pathname.endsWith("/") || /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname)) {
    throw new HttpError(422, "invalid_args", "request path must be canonical");
  }
  try { decodeURIComponent(path); } catch { throw new HttpError(422, "invalid_args", "invalid path encoding"); }
}

export function conditionalHeaders(ifMatch?: string | null): Record<string, string> {
  if (ifMatch == null) return {};
  if (!/^"[0-9a-f]{64}"$/.test(ifMatch)) throw new HttpError(422, "invalid_args", "If-Match must be a strong SHA-256 ETag");
  return { "if-match": ifMatch };
}

type DigestInput = {
  method: string; path: string; body: unknown; multipart?: boolean;
  files?: DigestFile[]; normalizedFiles?: NormalizedFile<unknown>[]; ifMatch?: string | null;
};

function sharedInput(input: DigestInput): RequestDigestInput {
  validateRequestPath(input.path);
  const headers = conditionalHeaders(input.ifMatch);
  const files = input.normalizedFiles ?? normalizeFiles(input.files ?? [], (file) => file);
  return {
    method: input.method, path: input.path, body: input.body,
    encoding: input.multipart ? "multipart" : "json",
    files: Array.from({ length: files.length }, (_, index) => {
      if (!Object.hasOwn(files, index)) throw new HttpError(422, "invalid_args", "sparse attachment list");
      const file = files[index]!;
      return { filename: file.filename, sha256: file.hash };
    }),
    conditionalHeaders: headers,
  };
}

export function requestPreimage(input: DigestInput, encode: CanonicalEncoder = canonicalJson): string {
  return invalidArgs(() => new TextDecoder().decode(requestDigestBytes(sharedInput(input), encode)));
}

export function requestDigest(input: DigestInput, encode: CanonicalEncoder = canonicalJson): string {
  return invalidArgs(() => sharedRequestDigest(sharedInput(input), encode));
}
