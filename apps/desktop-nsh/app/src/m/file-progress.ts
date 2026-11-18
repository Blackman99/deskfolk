/** Bytes seen so far, and the declared size when the transfer names one. */
export type FileProgress = { loaded: number; total: number | null };
export type FileProgressHandler = (progress: FileProgress) => void;
/**
 * How a file read is asked for. Remotely every request shares one link that answers one at a
 * time: `background` reads (a chat's pictures) step aside for everything else, and `signal` takes
 * a read nobody is waiting for any more out of line. `size` asks for a scaled copy of a picture,
 * locally too. Locally `background` means nothing.
 */
export type FileLoadOptions = { background?: boolean; signal?: AbortSignal; size?: ImageSize };
/**
 * A scaled copy of a picture instead of its bytes: `thumb` for a chip, `preview` for an
 * enlargement. Anything that is not a larger raster comes back as the original.
 */
export type ImageSize = "thumb" | "preview";

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function declaredLength(response: Response): number | null {
  const raw = response.headers.get("Content-Length");
  if (!raw) return null;
  const total = Number(raw);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/** Percent for a determinate bar; null means the bar should sweep instead of claiming a number. */
export function fileProgressPercent(progress: FileProgress): number | null {
  if (!progress.total || progress.total <= 0) return null;
  return Math.round((Math.min(progress.loaded, progress.total) / progress.total) * 100);
}

/** `2.0 KB / 10.0 KB`, or just the loaded size when the total is unknown. */
export function formatFileProgress(
  progress: FileProgress,
  formatBytes: (bytes: number) => string,
): string | null {
  if (progress.total && progress.total > 0) {
    return `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`;
  }
  if (progress.loaded > 0) return formatBytes(progress.loaded);
  return null;
}

/** Stream a GET into a blob and report each chunk. Without a listener this is `response.blob()`. */
export async function readResponseBlob(
  response: Response,
  onProgress?: FileProgressHandler,
): Promise<Blob> {
  const total = declaredLength(response);
  const type = response.headers.get("Content-Type") ?? "";
  if (!onProgress || !response.body) {
    const blob = await response.blob();
    onProgress?.({ loaded: blob.size, total: total ?? blob.size });
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress({ loaded: 0, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total });
  }
  return new Blob([Uint8Array.from(concat(chunks))], { type });
}
