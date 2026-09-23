import type { CredentialOperation } from "@real-bot/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

const blobEtags = new WeakMap<Blob, string>();

export function etagForBlob(blob: Blob): string | null {
  return blobEtags.get(blob) ?? null;
}

export function rememberBlobEtag(blob: Blob, etag: string | null | undefined): void {
  if (etag) blobEtags.set(blob, etag);
}

const blobOriginalSizes = new WeakMap<Blob, number>();

/**
 * The original's length when this blob is a scaled copy of a picture — what a file GET with
 * `size` answers with once the picture is larger than asked for. Null means these are the
 * original bytes.
 */
export function originalSizeForBlob(blob: Blob): number | null {
  return blobOriginalSizes.get(blob) ?? null;
}

export function rememberBlobOriginalSize(blob: Blob, size: number | string | null | undefined): void {
  const bytes = typeof size === "string" ? Number(size) : size;
  if (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0) blobOriginalSizes.set(blob, bytes);
}

export type { CredentialOperation };

export async function probeHealth(origin: string): Promise<{ status: number | null; body: unknown }> {
  try {
    const res = await fetch(`${origin}/v1/health`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return { status: null, body: null };
  }
}
