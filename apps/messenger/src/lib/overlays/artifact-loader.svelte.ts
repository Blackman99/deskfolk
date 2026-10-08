import { untrack } from "svelte";
import type { Attachment } from "@real-bot/protocol";
import { etagForBlob, originalSizeForBlob } from "../api.ts";
import { contentShaFromEtag } from "../annotations/model.ts";
import type { MessengerApi } from "../messenger-api.ts";
import type { MediaSourceHandle } from "../remote/media-source.ts";
import { formatFileSize } from "../chat/attachments.ts";
import { fileProgressPercent, formatFileProgress, type FileProgress } from "../file-progress.ts";
import type { FileDownloadNote } from "./FileDownload.svelte";
import {
  artifactByteSource,
  isInAppPreviewKind,
  isOfficeKind,
  previewLoadKey,
  svgDisplayBlob,
  type ArtifactKind,
} from "./artifacts.ts";

/** What the pane hands the loader: each is read where it was read before, so the load effect tracks the same signals. */
export interface ArtifactLoaderHost {
  api: () => MessengerApi | null;
  relpath: () => string;
  attachment: () => Attachment | null;
  kind: () => ArtifactKind;
  byteSource: () => ReturnType<typeof artifactByteSource>;
}

/** The bytes of the file on screen: what is loading, what has arrived, and the object URLs and hash that go with them. */
export class ArtifactLoader {
  readonly #h: ArtifactLoaderHost;

  blobUrl = $state<string | null>(null);
  /**
   * Which file `blobUrl` holds. Picking another file changes `kind` at once while its bytes are
   * still on the way, so a `<video>` was handed the picture before it, failed to play it, and
   * left the video reading "file is gone".
   */
  blobPath = $state<string | null>(null);
  shownBlob = $derived.by(() => this.blobPath === this.#h.relpath() ? this.blobUrl : null);
  text = $state<string | null>(null);
  missing = $state(false);
  loading = $state(false);
  progress = $state<FileProgress | null>(null);
  loadPercent = $derived(this.progress ? fileProgressPercent(this.progress) : null);
  loadBytes = $derived(this.progress ? formatFileProgress(this.progress, formatFileSize) : null);
  /**
   * Remotely a picture opens as the Mac's 1600 px copy; this is the original's length while that
   * copy is on screen, and the pane offers the original.
   */
  reducedFrom = $state<number | null>(null);
  originalProgress = $state<FileProgress | null>(null);
  originalBytes = $derived(this.originalProgress ? formatFileProgress(this.originalProgress, formatFileSize) : null);
  openHint = $state(false);
  liveBlob: string | null = null;
  mediaSource: MediaSourceHandle | null = null;
  /** The clip on screen plays from pieces fetched as it goes (remote), so no whole-file hash exists. */
  streamed = $state(false);
  loadGen = 0;
  /** The read behind the file on screen. Another file, or closing, stops it rather than letting it finish ahead of the next. */
  loadAbort: AbortController | null = null;
  /** The key of the bytes on screen; a repeat of it must not swap the object URL. */
  loadedKey: string | null = null;
  loadedClient: MessengerApi | null = null;
  /** What is on disk for a text-backed file, as loaded or last saved; null for any other kind. */
  diskText = $state<string | null>(null);
  downloadNote = $state<FileDownloadNote>(null);
  /** The whole file as it was read for the preview, so a download does not fetch it again. */
  original = $state<{ path: string; blob: Blob } | null>(null);
  readyOriginal = $derived.by(() => this.original?.path === this.#h.relpath() ? this.original.blob : null);
  loadedEtag = $state<string | null>(null);
  /**
   * Whether `loadedEtag` is this file's: an annotation is stored against the file's hash, and the
   * one before it belongs to the file shown before. Save keeps using `loadedEtag` either way, so a
   * stale buffer meets the daemon's 409 rather than landing on another file.
   */
  hashFresh = $state(false);
  /** The PDF's bytes, for the pdf.js viewer. */
  pdfBlob = $state<Blob | null>(null);
  officeBlob = $state<Blob | null>(null);
  shownOffice = $derived.by(() => this.blobPath === this.#h.relpath() ? this.officeBlob : null);
  /** The PDF's bytes only while they are the file on screen's, like `shownBlob`. */
  shownPdf = $derived.by(() => this.blobPath === this.#h.relpath() ? this.pdfBlob : null);
  /** An SVG's source, kept so an image annotation can size a drawing that declares no size. */
  svgRaw = $state<string | null>(null);
  contentSha = $derived(this.hashFresh ? contentShaFromEtag(this.loadedEtag) : null);

  constructor(host: ArtifactLoaderHost) {
    this.#h = host;
  }

  /**
   * Starts loading whatever file is shown, and again whenever it changes. Called where the pane's
   * other effects begin, so it runs after the ones above it as it always has.
   */
  watchLoad(): void {
    $effect(() => {
      const path = this.#h.relpath();
      const previewKind = this.#h.kind();
      const source = this.#h.byteSource();
      const key = previewLoadKey({ path, kind: previewKind, source, attachmentId: this.#h.attachment()?.id });
      // Losing the citing message flips the source, not the file: reloading here would restart a
      // playing video every time you switch sessions or continue an interrupted turn.
      const client = this.#h.api();
      if (key !== null && key === this.loadedKey && client === this.loadedClient) return;
      this.loadedKey = key;
      this.loadedClient = client;
      const att = untrack(() => this.#h.attachment());
      void this.loadPreview(path, previewKind, source, att);
    });
  }

  /** The pane is going away: whatever is still in flight belongs to a file that is gone. */
  destroy(): void {
    this.loadGen += 1;
    this.revoke();
    this.loadAbort?.abort();
  }

  revoke(): void {
    this.mediaSource?.dispose();
    this.mediaSource = null;
    if (this.liveBlob) URL.revokeObjectURL(this.liveBlob);
    this.liveBlob = null;
    this.blobUrl = null;
    this.pdfBlob = null;
    this.officeBlob = null;
    this.blobPath = null;
  }

  async loadPreview(
    path: string,
    previewKind: ArtifactKind,
    source: ReturnType<typeof artifactByteSource>,
    att: Attachment | null,
  ): Promise<void> {
    const api = this.#h.api();
    const gen = ++this.loadGen;
    if (this.mediaSource) this.revoke();
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.missing = false;
    this.openHint = false;
    this.original = null;
    this.downloadNote = null;
    this.progress = null;
    // The last file's hash is not this one's. A clip streamed in pieces never gets one, and a
    // spot picked on it must not be saved against the file shown before it.
    this.hashFresh = false;
    this.streamed = false;
    this.reducedFrom = null;
    this.originalProgress = null;
    if (!source || !api || previewKind === "directory" || !isInAppPreviewKind(previewKind)) {
      if (gen !== this.loadGen) return;
      this.loading = false;
      this.revoke();
      this.text = null;
      this.diskText = null;
      return;
    }
    this.loading = true;
    const abort = new AbortController();
    this.loadAbort = abort;
    const size = previewKind === "image" && api.kind === "remote" ? ("preview" as const) : undefined;
    this.progress = {
      loaded: 0,
      // The attachment's size is the original's, which is not what a copy will weigh.
      total: !size && typeof att?.size === "number" && att.size > 0 ? att.size : null,
    };
    try {
      const onProgress = (next: FileProgress) => {
        if (gen !== this.loadGen) return;
        this.progress = {
          loaded: next.loaded,
          total: next.total ?? this.progress?.total ?? null,
        };
      };
      if ((previewKind === "audio" || previewKind === "video") && api.kind === "remote" && api.openMediaSource) {
        const stream = await api.openMediaSource({ path, ...(source === "attachment" && att ? { attachmentId: att.id } : {}) }, abort.signal, () => {
          if (gen !== this.loadGen) return;
          this.missing = true;
          abort.abort();
        });
        if (gen !== this.loadGen || abort.signal.aborted) { stream?.dispose(); return; }
        if (stream) {
          this.revoke();
          this.mediaSource = stream;
          this.streamed = true;
          this.blobUrl = stream.url;
          this.blobPath = path;
          this.text = null;
          this.diskText = null;
          return;
        }
      }
      const blob =
        source === "attachment" && att
          ? await this.#h.api()!.getAttachmentBlob(att.id, onProgress, { signal: abort.signal, size })
          : await this.#h.api()!.getWorkspaceFileBlob(path, onProgress, { signal: abort.signal, size });
      if (gen !== this.loadGen) return;
      this.loadedEtag = etagForBlob(blob);
      this.hashFresh = true;
      this.reducedFrom = size ? originalSizeForBlob(blob) : null;
      // A scaled copy stands in for a picture that is already small enough; that copy is the file.
      if (!size || this.reducedFrom === null) this.original = { path, blob };
      if (previewKind === "text" || previewKind === "markdown" || previewKind === "svg") {
        const raw = await blob.text();
        if (gen !== this.loadGen) return;
        if (previewKind === "svg") {
          this.svgRaw = raw;
          const next = URL.createObjectURL(await svgDisplayBlob(raw));
          if (gen !== this.loadGen) return;
          if (this.liveBlob) URL.revokeObjectURL(this.liveBlob);
          this.liveBlob = next;
          this.blobUrl = next;
          this.blobPath = path;
          this.text = null;
          this.diskText = null;
        } else {
          this.text = raw;
          this.diskText = raw;
        }
        return;
      }
      if (previewKind === "html") {
        const raw = await blob.text();
        if (gen !== this.loadGen) return;
        // The HTML view builds its own sandboxed blob from the text (and a picker, in annotate mode).
        this.text = raw;
        this.diskText = raw;
        return;
      }
      const next = URL.createObjectURL(blob);
      if (this.liveBlob) URL.revokeObjectURL(this.liveBlob);
      this.liveBlob = next;
      this.blobUrl = next;
      // pdf.js reads the bytes, not a URL.
      this.pdfBlob = previewKind === "pdf" ? blob : null;
      this.officeBlob = isOfficeKind(previewKind) ? blob : null;
      this.blobPath = path;
      this.text = null;
      this.diskText = null;
    } catch {
      if (gen !== this.loadGen) return;
      this.loadedKey = null;
      this.missing = true;
    } finally {
      if (gen === this.loadGen) this.loading = false;
    }
  }

  /** The picture itself, in place of the copy on screen. The copy stays up while it arrives. */
  async loadOriginal(): Promise<void> {
    const client = this.#h.api();
    const total = this.reducedFrom;
    const att = this.#h.attachment();
    const path = this.#h.relpath();
    const source = this.#h.byteSource();
    if (!client || total === null || this.originalProgress) return;
    const gen = this.loadGen;
    this.loadAbort?.abort();
    const abort = new AbortController();
    this.loadAbort = abort;
    this.originalProgress = { loaded: 0, total };
    try {
      const onProgress = (next: FileProgress) => {
        if (gen !== this.loadGen) return;
        this.originalProgress = { loaded: next.loaded, total: next.total ?? total };
      };
      const blob =
        source === "attachment" && att
          ? await client.getAttachmentBlob(att.id, onProgress, { signal: abort.signal })
          : await client.getWorkspaceFileBlob(path, onProgress, { signal: abort.signal });
      if (gen !== this.loadGen) return;
      const next = URL.createObjectURL(blob);
      if (this.liveBlob) URL.revokeObjectURL(this.liveBlob);
      this.liveBlob = next;
      this.blobUrl = next;
      // The copy's hash was the copy's; an annotation names the file's.
      this.loadedEtag = etagForBlob(blob);
      this.hashFresh = true;
      this.blobPath = path;
      this.reducedFrom = null;
      this.original = { path, blob };
    } catch {
      // The copy stays on screen, and so does the offer.
    } finally {
      if (gen === this.loadGen) this.originalProgress = null;
    }
  }

  /** The file on screen went to the Trash, so what the pane holds of it goes too, unsaved edits included. */
  showGone(): void {
    this.loadGen += 1;
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.revoke();
    this.text = null;
    this.diskText = null;
    this.original = null;
    this.progress = null;
    this.loading = false;
    this.loadedKey = null;
    this.missing = true;
  }
}
