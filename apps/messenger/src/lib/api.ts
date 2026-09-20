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
