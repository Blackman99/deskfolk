/**
 * Bytes as a `data:` URL, the way NSH's `Image` takes bytes the app fetched itself (an artifact's
 * thumbnail, a picture from the clipboard). The messenger made object URLs; NSH has none.
 */
/** Bytes per `String.fromCharCode` call: well under the engine's argument limit. */
const CHUNK = 0x8000;

/**
 * Base64 of `bytes`: the bytes as a binary string, a chunk per call, and the engine's own `btoa`.
 * A loop in the JS appending four characters at a time took seconds on a big picture (24 MB:
 * 4.8 s with the window held); this takes 174 ms.
 */
export function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  return btoa(parts.join(""));
}

export async function blobDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type || "application/octet-stream"};base64,${base64(bytes)}`;
}
