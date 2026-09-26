import type { Attachment } from "@real-bot/protocol";
import { rememberBlobEtag, rememberBlobOriginalSize } from "../api.ts";
import type { ImageSize } from "../file-progress.ts";
import { artifactKind, type ArtifactKind } from "../overlays/artifacts.ts";

/** Long edge of the Mac's `thumb` copy. One made here matches it. */
const THUMB_EDGE = 256;

/**
 * What a file this page sent is read back from here instead of the Mac: the heavy kinds, which
 * a Bot hardly ever rewrites in place. Text, Markdown, code and SVG are small and are edited in
 * place, so those still come from the Mac.
 */
const LOCAL_KINDS = new Set<ArtifactKind>(["image", "pdf", "audio", "video"]);

/** A picture's `thumb` copy, made on this device. Null when the picture does not decode here. */
export type PictureScaler = (source: Blob, edge: number) => Promise<Blob | null>;

type Sent = {
  file: Blob;
  kind: ArtifactKind;
  /** The `thumb` copy, made once. */
  thumb?: Promise<Blob | null>;
  /** This browser cannot draw it (a HEIC, say); the Mac's copies can. */
  undecodable?: boolean;
};

/**
 * Files this page uploaded, kept for as long as the page lives, so reading one back does not
 * pull over the relay the bytes that just went up it. Memory only: the remote page persists no
 * files, so after a reload they come from the Mac again.
 */
export class SentFiles {
  private readonly byAttachment = new Map<string, Sent>();
  private readonly byPath = new Map<string, Sent>();

  constructor(private readonly scale: PictureScaler = scalePicture) {}

  /**
   * The Mac's rows for a send, matched to what went up by size (from its `stat`) and name. The
   * file carries the Mac's ETag — the quoted SHA-256 — so an annotation or a save sees the same
   * hash it would from the Mac.
   */
  remember(sent: ReadonlyArray<{ file: File; sha256: string }>, attachments: readonly Attachment[] | undefined): void {
    if (!attachments?.length) return;
    const left = [...sent];
    for (const row of attachments) {
      const kind = artifactKind(row.original_filename || row.workspace_relpath, { isDir: row.is_dir });
      const sameSize = left.filter(({ file }) => row.size == null || file.size === row.size);
      const match = sameSize.find(({ file }) => (file.name || "attachment") === row.original_filename) ?? (row.size == null ? undefined : sameSize[0]);
      if (!match) continue;
      left.splice(left.indexOf(match), 1);
      if (!LOCAL_KINDS.has(kind)) continue;
      rememberBlobEtag(match.file, `"${match.sha256}"`);
      const entry: Sent = { file: match.file, kind };
      this.byAttachment.set(row.id, entry);
      if (row.workspace_relpath) this.byPath.set(row.workspace_relpath, entry);
    }
  }

  /**
   * The bytes from here, or null for the Mac. `thumb` is a copy made on this device; the
   * enlargement's `preview` is the file itself, as it is on the Mac, since reading it costs nothing.
   *
   * Null comes back at once, not as a promise: a read for the Mac must reach the queue in the
   * same turn it was asked, or it lands behind whatever was asked after it. A promise can still
   * settle to null (a thumbnail that would not draw) and that read then goes to the Mac.
   */
  read(key: { attachmentId?: string; path?: string }, size?: ImageSize): Promise<Blob | null> | null {
    const entry = this.entry(key);
    if (!entry) return null;
    if (entry.kind !== "image" || !size) return Promise.resolve(entry.file);
    if (entry.undecodable) return null;
    if (size === "preview") return Promise.resolve(entry.file);
    entry.thumb ??= this.scale(entry.file, THUMB_EDGE)
      .catch(() => null)
      .then((copy) => {
        if (!copy) entry.undecodable = true;
        // A copy says how large the original is, as the Mac's does; a picture already that small is the picture.
        else if (copy !== entry.file) rememberBlobOriginalSize(copy, entry.file.size);
        return copy;
      });
    return entry.thumb;
  }

  private entry(key: { attachmentId?: string; path?: string }): Sent | null {
    return (key.attachmentId ? this.byAttachment.get(key.attachmentId) : undefined)
      ?? (key.path ? this.byPath.get(key.path) : undefined)
      ?? null;
  }
}

/**
 * A copy of the picture with its long edge at most `edge`: JPEG for a photo, PNG where the source
 * may be transparent. A picture already within it comes back as it is.
 */
export async function scalePicture(source: Blob, edge: number): Promise<Blob | null> {
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image failed to decode"));
    });
    image.src = url;
    await loaded;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return null;
    if (Math.max(width, height) <= edge) return source;
    const ratio = edge / Math.max(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const type = /^image\/(png|gif|webp)/.test(source.type) ? "image/png" : "image/jpeg";
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
