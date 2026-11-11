// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: a3be9dff5e9841b4
import { derived, effect, state } from "../../lib/reactive";
import { untrack } from "../../lib/reactive";
import { batch } from "nsh";
import type { Attachment } from "@real-bot/protocol";
import { etagForBlob, originalSizeForBlob } from "../api.ts";
import { contentShaFromEtag } from "../annotations/model.ts";
import type { LocalApi } from "../local-api.ts";
import type { MessengerApi } from "../messenger-api.ts";
import type { MediaSourceHandle } from "../remote/media-source.ts";
import { formatFileSize } from "../chat/attachments.ts";
import { fileProgressPercent, formatFileProgress, type FileProgress } from "../file-progress.ts";
/** `FileDownload.svelte`'s note: tap to save, or the save failed. */
type FileDownloadNote = "tap" | "failed" | null;
import {
  artifactByteSource,
  decodeFileText,
  isInAppPreviewKind,
  isOfficeKind,
  previewLoadKey,
  svgDisplayBlob,
  type ArtifactKind,
  type TextEncoding,
} from "./artifacts.ts";

/** What the pane hands the loader: each is read where it was read before, so the load effect tracks the same signals. */
export interface ArtifactLoaderHost {
  api: () => MessengerApi | null;
  relpath: () => string;
  attachment: () => Attachment | null;
  kind: () => ArtifactKind;
  byteSource: () => ReturnType<typeof artifactByteSource>;
  /**
   * NSH: the file on this computer a video, an audio file or a picture is shown from where it lies
   * (`mediaFilePath`), or null. For such a file the loader reads no bytes: the native player or
   * image view opens it, and the pane takes the path for its source.
   */
  localFile?: (path: string) => string | null;
  /**
   * NSH: whether the native viewer fetches this PDF or Office file from the runtime itself
   * (`pdfSourceOf`, `officeSourceOf`), so the loader reads no bytes for it.
   */
  viewerFetches?: (path: string, kind: ArtifactKind, source: ReturnType<typeof artifactByteSource>, att: Attachment | null) => boolean;
}

/**
 * Past this long, a file's hash is asked for after the viewer has asked for the file: the runtime
 * answers one file GET at a time, and the viewer's is the one the reader is waiting on.
 */
const HASH_AFTER_VIEWER_MS = 300;

/** The bytes of the file on screen: what is loading, what has arrived, and the object URLs and hash that go with them. */
export class ArtifactLoader {
  readonly #h: ArtifactLoaderHost;

  #blobUrl$s = state<string | null>(null);
	get blobUrl(): string | null { return this.#blobUrl$s.get(); }
	set blobUrl(value: string | null) { this.#blobUrl$s.set(value); }
  /**
   * Which file `blobUrl` holds. Picking another file changes `kind` at once while its bytes are
   * still on the way, so a `<video>` was handed the picture before it, failed to play it, and
   * left the video reading "file is gone".
   */
  #blobPath$s = state<string | null>(null);
	get blobPath(): string | null { return this.#blobPath$s.get(); }
	set blobPath(value: string | null) { this.#blobPath$s.set(value); }
  #shownBlob$s = derived(() => this.blobPath === this.#h.relpath() ? this.blobUrl : null);
	get shownBlob() { return this.#shownBlob$s.get(); }
  #text$s = state<string | null>(null);
	get text(): string | null { return this.#text$s.get(); }
	set text(value: string | null) { this.#text$s.set(value); }
  /**
   * Which file `text` holds (NSH). Picking another file changes `relpath` at once while its text is
   * still on the way; the editor follows this rather than `relpath`, so it keeps the file it shows
   * until the next one has arrived and then makes one view for it, not one for the old text under
   * the new name and another when the text lands. Written with `text` in one batch.
   */
  #textPath$s = state<string | null>(null);
	get textPath(): string | null { return this.#textPath$s.get(); }
	set textPath(value: string | null) { this.#textPath$s.set(value); }
  /**
   * A load that has taken long enough to say so (NSH): the loading veil waits this long, so a file
   * read in a few milliseconds swaps in place, as a native editor's does, without a flash of it.
   */
  #loadingLong$s = state(false);
	get loadingLong() { return this.#loadingLong$s.get(); }
	set loadingLong(value) { this.#loadingLong$s.set(value); }
  #slowTimer: ReturnType<typeof setTimeout> | null = null;
  #missing$s = state(false);
	get missing() { return this.#missing$s.get(); }
	set missing(value) { this.#missing$s.set(value); }
  #loading$s = state(false);
	get loading() { return this.#loading$s.get(); }
	set loading(value) { this.#loading$s.set(value); }
  #progress$s = state<FileProgress | null>(null);
	get progress(): FileProgress | null { return this.#progress$s.get(); }
	set progress(value: FileProgress | null) { this.#progress$s.set(value); }
  #loadPercent$s = derived(() => (this.progress ? fileProgressPercent(this.progress) : null));
	get loadPercent() { return this.#loadPercent$s.get(); }
  #loadBytes$s = derived(() => (this.progress ? formatFileProgress(this.progress, formatFileSize) : null));
	get loadBytes() { return this.#loadBytes$s.get(); }
  /**
   * Remotely a picture opens as the Mac's 1600 px copy; this is the original's length while that
   * copy is on screen, and the pane offers the original.
   */
  #reducedFrom$s = state<number | null>(null);
	get reducedFrom(): number | null { return this.#reducedFrom$s.get(); }
	set reducedFrom(value: number | null) { this.#reducedFrom$s.set(value); }
  #originalProgress$s = state<FileProgress | null>(null);
	get originalProgress(): FileProgress | null { return this.#originalProgress$s.get(); }
	set originalProgress(value: FileProgress | null) { this.#originalProgress$s.set(value); }
  #originalBytes$s = derived(() => (this.originalProgress ? formatFileProgress(this.originalProgress, formatFileSize) : null));
	get originalBytes() { return this.#originalBytes$s.get(); }
  #openHint$s = state(false);
	get openHint() { return this.#openHint$s.get(); }
	set openHint(value) { this.#openHint$s.set(value); }
  liveBlob: string | null = null;
  mediaSource: MediaSourceHandle | null = null;
  /** The clip on screen plays from pieces fetched as it goes (remote), so no whole-file hash exists. */
  #streamed$s = state(false);
	get streamed() { return this.#streamed$s.get(); }
	set streamed(value) { this.#streamed$s.set(value); }
  loadGen = 0;
  /** The read behind the file on screen. Another file, or closing, stops it rather than letting it finish ahead of the next. */
  loadAbort: AbortController | null = null;
  /** The key of the bytes on screen; a repeat of it must not swap the object URL. */
  loadedKey: string | null = null;
  loadedClient: MessengerApi | null = null;
  /** What is on disk for a text-backed file, as loaded or last saved; null for any other kind. */
  #diskText$s = state<string | null>(null);
	get diskText(): string | null { return this.#diskText$s.get(); }
	set diskText(value: string | null) { this.#diskText$s.set(value); }
  /** How `text` was read from the file's bytes. Anything but UTF-8 is shown, never saved. */
  #textEncoding$s = state<TextEncoding>("utf-8");
	get textEncoding(): TextEncoding { return this.#textEncoding$s.get(); }
	set textEncoding(value: TextEncoding) { this.#textEncoding$s.set(value); }
  #downloadNote$s = state<FileDownloadNote>(null);
	get downloadNote(): FileDownloadNote { return this.#downloadNote$s.get(); }
	set downloadNote(value: FileDownloadNote) { this.#downloadNote$s.set(value); }
  /** The whole file as it was read for the preview, so a download does not fetch it again. */
  #original$s = state<{ path: string; blob: Blob } | null>(null);
	get original(): { path: string; blob: Blob } | null { return this.#original$s.get(); }
	set original(value: { path: string; blob: Blob } | null) { this.#original$s.set(value); }
  #readyOriginal$s = derived(() => this.original?.path === this.#h.relpath() ? this.original.blob : null);
	get readyOriginal() { return this.#readyOriginal$s.get(); }
  #loadedEtag$s = state<string | null>(null);
	get loadedEtag(): string | null { return this.#loadedEtag$s.get(); }
	set loadedEtag(value: string | null) { this.#loadedEtag$s.set(value); }
  /**
   * Whether `loadedEtag` is this file's: an annotation is stored against the file's hash, and the
   * one before it belongs to the file shown before. Save keeps using `loadedEtag` either way, so a
   * stale buffer meets the daemon's 409 rather than landing on another file.
   */
  #hashFresh$s = state(false);
	get hashFresh() { return this.#hashFresh$s.get(); }
	set hashFresh(value) { this.#hashFresh$s.set(value); }
  /** The PDF's bytes, for the pdf.js viewer. */
  #pdfBlob$s = state<Blob | null>(null);
	get pdfBlob(): Blob | null { return this.#pdfBlob$s.get(); }
	set pdfBlob(value: Blob | null) { this.#pdfBlob$s.set(value); }
  #officeBlob$s = state<Blob | null>(null);
	get officeBlob(): Blob | null { return this.#officeBlob$s.get(); }
	set officeBlob(value: Blob | null) { this.#officeBlob$s.set(value); }
  #shownOffice$s = derived(() => this.blobPath === this.#h.relpath() ? this.officeBlob : null);
	get shownOffice() { return this.#shownOffice$s.get(); }
  /** NSH: the file on screen is fetched by its native viewer itself, its bytes never read here (`viewerFetches`). */
  #byViewer$s = state(false);
	get byViewer() { return this.#byViewer$s.get(); }
	set byViewer(value) { this.#byViewer$s.set(value); }
  /** NSH: whether the file on screen is fetched by its native viewer itself (a PDF, an Office file). */
  #shownByViewer$s = derived(() => this.blobPath === this.#h.relpath() && this.byViewer);
	get shownByViewer() { return this.#shownByViewer$s.get(); }
  /** Whether the PDF on screen can be shown: its bytes are here, or the viewer fetches them itself. */
  #shownPdf$s = derived(() => this.blobPath === this.#h.relpath() && (this.pdfBlob !== null || this.byViewer));
	get shownPdf() { return this.#shownPdf$s.get(); }
  /**
   * NSH: a picture whose path the image view could not open (outside the folders the app may read,
   * say), so it is shown from its bytes, as before; its path while it is the file on screen.
   */
  #bytesFor: string | null = null;
  /** An SVG's source, kept so an image annotation can size a drawing that declares no size. */
  #svgRaw$s = state<string | null>(null);
	get svgRaw(): string | null { return this.#svgRaw$s.get(); }
	set svgRaw(value: string | null) { this.#svgRaw$s.set(value); }
  #contentSha$s = derived(() => (this.hashFresh ? contentShaFromEtag(this.loadedEtag) : null));
	get contentSha() { return this.#contentSha$s.get(); }

  constructor(host: ArtifactLoaderHost) {
    this.#h = host;
  }

  /** A file's text, as read and as on disk, and which file it is: one change, so nothing sees half of it. */
  #setText(text: string | null, path: string | null): void {
    batch(() => {
      this.text = text;
      this.diskText = text;
      this.textPath = text === null ? null : path;
    });
  }

  /** How long a load may take before the pane says it is loading. */
  static readonly SLOW_MS = 250;

  #startSlow(gen: number): void {
    if (this.#slowTimer) clearTimeout(this.#slowTimer);
    this.#slowTimer = setTimeout(() => {
      this.#slowTimer = null;
      if (gen === this.loadGen && this.loading) this.loadingLong = true;
    }, ArtifactLoader.SLOW_MS);
  }

  #endSlow(): void {
    if (this.#slowTimer) clearTimeout(this.#slowTimer);
    this.#slowTimer = null;
    this.loadingLong = false;
  }

  /**
   * Starts loading whatever file is shown, and again whenever it changes. Called where the pane's
   * other effects begin, so it runs after the ones above it as it always has.
   */
  watchLoad(): void {
    effect(() => {
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
    this.#endSlow();
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
    this.byViewer = false;
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
      this.#endSlow();
      this.loading = false;
      this.revoke();
      this.#setText(null, null);
      return;
    }
    this.loading = true;
    this.#startSlow(gen);
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
          this.#setText(null, null);
          return;
        }
      }
      // NSH: a clip or a picture on this computer is shown from where it lies, and a PDF or an Office
      // file is fetched by its native viewer, so their bytes are not read here. Through the JS they
      // held the window: a 100 MB video or PDF behind "Opening file…", a 24 MB picture for seconds
      // while it was turned into a `data:` URL. The hash an annotation is saved against still comes,
      // after the file is up.
      const local = api.kind === "local" && this.#bytesFor !== path;
      const onDisk =
        local && (previewKind === "audio" || previewKind === "video" || previewKind === "image")
          ? untrack(() => this.#h.localFile?.(path) ?? null)
          : null;
      const byViewer = local && !onDisk && untrack(() => this.#h.viewerFetches?.(path, previewKind, source, att) ?? false);
      if ((onDisk || byViewer) && api.kind === "local") {
        this.revoke();
        batch(() => {
          this.blobUrl = onDisk;
          this.byViewer = byViewer;
          this.blobPath = path;
          this.progress = null;
          this.loading = false;
        });
        this.#endSlow();
        this.#setText(null, null);
        if (byViewer) await new Promise((done) => setTimeout(done, HASH_AFTER_VIEWER_MS));
        if (gen !== this.loadGen) return;
        const head = await localFileHead(api, source === "attachment" && att ? { attachmentId: att.id } : { path }, abort.signal);
        if (gen !== this.loadGen) return;
        if (head.gone) {
          this.loadedKey = null;
          this.missing = true;
          return;
        }
        if (head.etag === null) return;
        batch(() => {
          this.loadedEtag = head.etag;
          this.hashFresh = true;
        });
        return;
      }
      // NSH: on this computer the bytes come in one read (`response.blob()`): following each chunk
      // for the progress bar copied every byte through the JS twice more, three seconds and
      // gigabytes for a 100 MB file, for a load that takes a moment.
      const progress = api.kind === "local" ? undefined : onProgress;
      const blob =
        source === "attachment" && att
          ? await this.#h.api()!.getAttachmentBlob(att.id, progress, { signal: abort.signal, size })
          : await this.#h.api()!.getWorkspaceFileBlob(path, progress, { signal: abort.signal, size });
      if (gen !== this.loadGen) return;
      this.loadedEtag = etagForBlob(blob);
      this.hashFresh = true;
      this.reducedFrom = size ? originalSizeForBlob(blob) : null;
      // A scaled copy stands in for a picture that is already small enough; that copy is the file.
      if (!size || this.reducedFrom === null) this.original = { path, blob };
      if (previewKind === "text" || previewKind === "markdown" || previewKind === "svg") {
        const read = previewKind === "svg" ? { text: await blob.text(), encoding: "utf-8" as const } : decodeFileText(new Uint8Array(await blob.arrayBuffer()));
        const raw = read.text;
        if (gen !== this.loadGen) return;
        this.textEncoding = read.encoding;
        if (previewKind === "svg") {
          this.svgRaw = raw;
          const next = URL.createObjectURL(await svgDisplayBlob(raw));
          if (gen !== this.loadGen) return;
          if (this.liveBlob) URL.revokeObjectURL(this.liveBlob);
          this.liveBlob = next;
          this.blobUrl = next;
          this.blobPath = path;
          this.#setText(null, null);
        } else {
          this.#setText(raw, path);
        }
        return;
      }
      if (previewKind === "html") {
        const { text: raw, encoding } = decodeFileText(new Uint8Array(await blob.arrayBuffer()));
        if (gen !== this.loadGen) return;
        this.textEncoding = encoding;
        // The HTML view builds its own sandboxed blob from the text (and a picker, in annotate mode).
        this.#setText(raw, path);
        return;
      }
      const next = URL.createObjectURL(blob);
      if (this.liveBlob) URL.revokeObjectURL(this.liveBlob);
      this.liveBlob = next;
      this.blobUrl = next;
      // pdf.js reads the bytes, not a URL.
      this.pdfBlob = previewKind === "pdf" ? blob : null;
      this.byViewer = false;
      this.officeBlob = isOfficeKind(previewKind) ? blob : null;
      this.blobPath = path;
      this.#setText(null, null);
    } catch {
      if (gen !== this.loadGen) return;
      this.loadedKey = null;
      this.missing = true;
    } finally {
      if (gen === this.loadGen) {
        this.loading = false;
        this.#endSlow();
      }
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

  /**
   * NSH: the image view could not open the picture by its path (outside the folders the app may
   * read): show it from its bytes, as before.
   */
  bytesInstead(): void {
    const path = this.#h.relpath();
    if (this.#bytesFor === path || this.blobPath !== path) return;
    this.#bytesFor = path;
    const kind = untrack(() => this.#h.kind());
    const source = untrack(() => this.#h.byteSource());
    const att = untrack(() => this.#h.attachment());
    void this.loadPreview(path, kind, source, att);
  }

  /** The file on screen went to the Trash, so what the pane holds of it goes too, unsaved edits included. */
  showGone(): void {
    this.loadGen += 1;
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.revoke();
    this.#setText(null, null);
    this.original = null;
    this.progress = null;
    this.loading = false;
    this.#endSlow();
    this.loadedKey = null;
    this.missing = true;
  }
}

/**
 * NSH: a file's hash, the one an annotation is saved against, without its bytes. The runtime's
 * file GET names it in its `ETag` (the sha256 of the whole file; a range's would be the range's), so
 * the answer is read up to its headers and its body is let go. `gone` when the runtime says there
 * is no such file (the loader's own read said so before); the hash is null when it does not come.
 */
async function localFileHead(
  api: LocalApi,
  target: { path: string } | { attachmentId: string },
  signal: AbortSignal,
): Promise<{ etag: string | null; gone: boolean }> {
  const { origin, token } = api.endpoint;
  const url =
    "attachmentId" in target
      ? `${origin}/v1/attachments/${target.attachmentId}/content`
      : `${origin}/v1/workspace/file?path=${encodeURIComponent(target.path)}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
    const etag = res.ok ? res.headers.get("ETag") : null;
    void res.body?.cancel().catch(() => {});
    return { etag, gone: res.status === 404 };
  } catch {
    return { etag: null, gone: false };
  }
}
